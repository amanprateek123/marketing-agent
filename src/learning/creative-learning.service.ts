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

    await this.companiesService.updateLearnings(tenantId, {
      version: (currentLearnings?.version ?? 0) + 1,
      updatedAt: new Date(),
      topicScores: currentLearnings?.topicScores ?? {},
      creative: creativeLearnings,
      campaign: currentLearnings?.campaign ?? this.emptyCampaignLearnings(),
      causalInsights: currentLearnings?.causalInsights ?? [],
    });

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
    return Promise.all(
      packages.map(async (pkg) => {
        const campaign = await this.campaignModel
          .findOne({ tenantId, briefId: pkg.briefId })
          .lean()
          .exec();

        const selectedVariant = pkg.copyVariants?.[pkg.selectedCopyIndex];
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
        };
      }),
    );
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
