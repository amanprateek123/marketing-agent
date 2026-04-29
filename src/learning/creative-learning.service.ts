import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { CompaniesService } from '../companies/companies.service';
import { ActionLoggerService } from '../common/action-logger/action-logger.service';
import { CreativePackage, CreativePackageDocument } from '../creative/schemas/creative-package.schema';
import { Campaign, CampaignDocument } from '../campaigns/schemas/campaign.schema';
import { LearningRun, LearningRunDocument } from './schemas/learning-run.schema';
import { CreativeLearnings } from '../companies/schemas/company.types';

const MIN_PACKAGES = 3;
const MIN_CONFIDENCE = 0.50;

const CREATIVE_LEARNING_PROMPT = `You are a creative performance analyst. Your job is to identify what creative patterns drive high CTR and what patterns underperform — based purely on data, not assumptions.

METHODOLOGY:
1. Look at hook style, copy tone, CTA text, and format for each creative
2. Compare CTR across creatives — CTR is the primary signal for creative quality (it fires before audience effects)
3. Identify patterns: what do the high-CTR creatives have in common? What do low-CTR ones share?
4. Assign confidence scores based on data volume:
   - 3 packages: max 0.60
   - 5 packages: max 0.85
   - 10+ packages: max 1.00
5. Only include a pattern if confidence >= 0.50
6. NEVER invent patterns not supported by the data

IMPORTANT — CTR vs ROAS:
- CTR = creative quality signal (did the hook/copy make people click?)
- ROAS = campaign system signal (did the audience/budget/objective convert?)
- Use CTR to judge creative, NOT ROAS (ROAS mixes creative + campaign variables)

OUTPUT — return only valid JSON:
{
  "winningHooks": ["string — hook styles with high CTR, e.g. 'challenge framing', 'time-saving angle'"],
  "losingHooks": ["string — hook styles with low CTR"],
  "winningFormats": ["string — formats with high engagement"],
  "losingFormats": ["string — formats to avoid"],
  "ctaInsights": ["string — which CTA patterns drove more clicks"],
  "copyToneInsights": ["string — tone observations, e.g. 'aspirational > fear-based for this audience'"],
  "visualInsights": ["string — image/video pattern observations"]
}`;

@Injectable()
export class CreativeLearningService {
  private readonly logger = new Logger(CreativeLearningService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly companiesService: CompaniesService,
    private readonly actionLogger: ActionLoggerService,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(LearningRun.name)
    private readonly learningRunModel: Model<LearningRunDocument>,
  ) {}

  async runQuickScan(tenantId: string): Promise<void> {
    const company = await this.companiesService.findByTenantId(tenantId);

    // Get completed creative packages from last 60 days
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const packages = await this.creativePackageModel
      .find({ tenantId, status: 'completed', createdAt: { $gte: sixtyDaysAgo } })
      .lean()
      .exec();

    if (packages.length < MIN_PACKAGES) {
      this.logger.log(
        `Creative quick scan skipped: tenantId=${tenantId} — only ${packages.length}/${MIN_PACKAGES} packages`,
      );
      return;
    }

    // Join with campaign CTR data
    const enriched = await this.enrichWithCTR(tenantId, packages);

    let result;
    try {
      result = await this.claudeService.runAgent({
        tenantId,
        agentType: AgentType.CREATIVE_LEARNING_AGENT,
        systemPrompt: CREATIVE_LEARNING_PROMPT,
        liveContext: '',
        userMessage: `Analyze these ${enriched.length} creative packages and extract patterns.

Company thresholds:
  targetROAS: ${company.targetROAS ?? 'not set'}
  primaryObjective: ${company.primaryObjective}
  tone: ${company.tone}

Creative performance data:
${JSON.stringify(enriched, null, 2)}

Current creative learnings (previous version):
${JSON.stringify(company.learnings?.creative ?? null, null, 2)}

Return ONLY the JSON object.`,
        model: 'claude-sonnet-4-6',
        maxTurns: 3,
      });
    } catch (err: any) {
      this.logger.error(`Creative learning agent failed: ${err.message}`);
      return;
    }

    const creativeLearnings = this.parseCreativeLearnings(result.content);
    const currentLearnings = company.learnings;

    // Extract verbatim winning exemplars deterministically from the enriched data —
    // NOT via LLM summarization. The LLM is prone to compressing winners into 4-word
    // labels and discarding the actual phrasing that worked. Pure rank-by-CTR keeps
    // the real lines available for downstream Creative Team to anchor on.
    const winningExemplars = this.extractWinningExemplars(enriched);

    // Race-safe: per-leaf dot-path slice instead of whole-tree replace. Was:
    // read learnings + splice + write whole tree → concurrent writers (Day 30
    // deep run + Meta importer) clobbered each other and version went backwards.
    // hookSaturation is owned by the audit loop and isn't touched here, so it
    // no longer needs explicit preservation — that was a band-aid for the old
    // race-prone path.
    await this.companiesService.setCreativeLearningSlice(tenantId, {
      ...creativeLearnings,
      winningExemplars,
    }, { incrementVersion: true });

    await this.actionLogger.log({
      tenantId,
      agent: AgentType.CREATIVE_LEARNING_AGENT,
      action: 'creative_learnings_updated',
      reason: `Analyzed ${enriched.length} creative packages`,
      outcome: `Creative patterns updated. Winning hooks: ${creativeLearnings.winningHooks.length}. Losing hooks: ${creativeLearnings.losingHooks.length}.`,
    });

    await this.learningRunModel.create({
      tenantId,
      status: 'completed',
      version: (currentLearnings?.version ?? 0) + 1,
      briefsAnalyzed: enriched.length,
      instinctsExtracted:
        creativeLearnings.winningHooks.length +
        creativeLearnings.losingHooks.length +
        creativeLearnings.winningFormats.length +
        creativeLearnings.ctaInsights.length,
      promptsRegenerated: false, // quick scan does NOT regen prompts
      runAt: new Date(),
      costUSD: result.costUSD,
    });

    this.logger.log(
      `Creative quick scan complete: tenantId=${tenantId} packages=${enriched.length}`,
    );
  }

  private async enrichWithCTR(
    tenantId: string,
    packages: CreativePackageDocument[],
  ): Promise<any[]> {
    const briefIds = packages.map(pkg => pkg.briefId).filter(Boolean);
    const campaigns = await this.campaignModel
      .find({ tenantId, briefId: { $in: briefIds } })
      .lean()
      .exec();
    const campaignMap = new Map(campaigns.map(c => [c.briefId, c]));

    return packages.map((pkg) => {
      const campaign = campaignMap.get(pkg.briefId);
      const selectedVariant = pkg.copyVariants?.[pkg.selectedCopyIndex];
      // Audience attribution for downstream exemplar filtering. Without this,
      // winningExemplars.audienceSegment is permanently undefined and warm/hot
      // briefs anchor on cold-prospect winners (and vice versa).
      // Heuristic: dominant active ad set's audienceType. If multiple ad sets
      // have different audienceTypes, take the highest-spend one.
      const audienceSegment = (() => {
        const activeAdSets = ((campaign as any)?.adSets ?? []).filter((as: any) => as.status !== 'paused');
        if (activeAdSets.length === 0) return undefined;
        const dominant = activeAdSets
          .slice()
          .sort((a: any, b: any) => (Number(b.spend) || 0) - (Number(a.spend) || 0))[0];
        return dominant?.audienceType ?? undefined;
      })();

      return {
        briefId: pkg.briefId,
        selectedCopy: selectedVariant
          ? {
              headline: selectedVariant.headline,
              primaryText: selectedVariant.primaryText,
              cta: selectedVariant.cta,
              hookStyle: selectedVariant.hookStyle,
            }
          : null,
        copySelectionReason: pkg.copySelectionReason,
        ctr: campaign?.ctr ?? null,
        clicks: campaign?.clicks ?? null,
        impressions: campaign?.impressions ?? null,
        spend: campaign?.spend ?? null,
        audienceSegment,
      };
    });
  }

  private parseCreativeLearnings(content: string): CreativeLearnings {
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const raw = fenceMatch
        ? JSON.parse(fenceMatch[1].trim())
        : JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));

      return {
        winningHooks: raw.winningHooks ?? [],
        losingHooks: raw.losingHooks ?? [],
        winningFormats: raw.winningFormats ?? [],
        losingFormats: raw.losingFormats ?? [],
        ctaInsights: raw.ctaInsights ?? [],
        copyToneInsights: raw.copyToneInsights ?? [],
        visualInsights: raw.visualInsights ?? [],
      };
    } catch (err: any) {
      this.logger.error(`Failed to parse creative learnings: ${err.message}`);
      throw new Error(`Creative Learning Agent returned invalid JSON: ${err.message}`);
    }
  }

  /**
   * Extract verbatim winning hook lines from enriched performance data.
   * Deterministic (no LLM) — sorts by CTR, filters by minimum sample size, takes
   * top N. The Creative Team gets these as concrete examples to anchor on, instead
   * of the LLM-summarized 4-word hookStyle labels.
   *
   * Filters:
   *   - impressions >= 1000 (avoid lucky early data)
   *   - ctr is set and > 0
   *   - selectedCopy.primaryText exists (we need a real line to extract)
   */
  private extractWinningExemplars(
    enriched: any[],
  ): NonNullable<CreativeLearnings['winningExemplars']> {
    const MIN_IMPRESSIONS = 1000;
    const MAX_EXEMPLARS = 10;

    const candidates = enriched
      .filter((e: any) =>
        e.selectedCopy?.primaryText &&
        typeof e.ctr === 'number' && e.ctr > 0 &&
        typeof e.impressions === 'number' && e.impressions >= MIN_IMPRESSIONS,
      )
      .sort((a: any, b: any) => (b.ctr as number) - (a.ctr as number))
      .slice(0, MAX_EXEMPLARS);

    const now = new Date();
    return candidates.map((e: any) => {
      // The "hook line" is the first line of primaryText (the scroll-stopper).
      // Falls back to the full headline if primaryText doesn't have line breaks.
      const firstLine = String(e.selectedCopy.primaryText)
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)[0] ?? e.selectedCopy.headline ?? '';
      return {
        hookLine: firstLine,
        hookStyle: e.selectedCopy.hookStyle ?? 'unknown',
        audienceSegment: e.audienceSegment ?? undefined,
        ctr: e.ctr,
        sampleSize: e.impressions,
        extractedAt: now,
      };
    });
  }

  private emptyCampaignLearnings() {
    return {
      audienceScores: {},
      platformROAS: {},
      budgetInsights: [],
      timingInsights: [],
      objectiveInsights: [],
    };
  }
}
