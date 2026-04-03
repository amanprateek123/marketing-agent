import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { CompaniesService } from '../../companies/companies.service';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
import { CampaignDocument } from '../schemas/campaign.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { CampaignOptimizerService, CampaignMetrics } from './campaign-optimizer.service';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../../pipeline/schemas/intelligence-brief.schema';

export interface AuditResult {
  tenantId: string;
  campaignsAudited: number;
  paused: number;
  scaled: number;
  performanceWritten: number;
}

@Injectable()
export class CampaignAuditorService {
  private readonly logger = new Logger(CampaignAuditorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly companiesService: CompaniesService,
    private readonly campaignsService: CampaignsService,
    private readonly optimizer: CampaignOptimizerService,
    private readonly actionLogger: ActionLoggerService,
    @InjectModel(IntelligenceBrief.name)
    private readonly briefModel: Model<IntelligenceBriefDocument>,
  ) {}

  async audit(tenantId: string): Promise<AuditResult> {
    const company = await this.companiesService.findByTenantId(tenantId);
    const activeCampaigns = await this.campaignsService.findActive(tenantId);

    this.logger.log(
      `Auditing ${activeCampaigns.length} active campaign(s) for tenantId=${tenantId}`,
    );

    const result: AuditResult = {
      tenantId,
      campaignsAudited: activeCampaigns.length,
      paused: 0,
      scaled: 0,
      performanceWritten: 0,
    };

    for (const campaign of activeCampaigns) {
      try {
        // Fetch live metrics from Meta Ads via Claude MCP
        const metrics = await this.fetchMetrics(campaign, company);

        // Update metrics in MongoDB
        await this.campaignsService.updateMetrics(campaign._id.toString(), {
          spend: metrics.spend,
          impressions: metrics.impressions,
          clicks: metrics.clicks,
          conversions: metrics.conversions,
          roas: metrics.roas,
          ctr: metrics.ctr,
          cpc: metrics.cpc,
        });

        const ageMs = Date.now() - new Date(campaign.launchedAt).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        const ageDays = ageHours / 24;

        // ── Auto-pause checks (TypeScript — Claude cannot override) ──────────
        let paused = false;

        if (company.pauseIfCTRBelow && metrics.ctr < company.pauseIfCTRBelow && ageHours > 72) {
          await this.pauseCampaign(
            campaign,
            company,
            `CTR ${metrics.ctr.toFixed(2)}% below threshold ${company.pauseIfCTRBelow}% after 72h`,
          );
          paused = true;
        } else if (company.pauseIfFrequencyAbove && metrics.frequency > company.pauseIfFrequencyAbove) {
          await this.pauseCampaign(
            campaign,
            company,
            `Frequency ${metrics.frequency.toFixed(1)} exceeds ${company.pauseIfFrequencyAbove} — audience fatigued`,
          );
          paused = true;
        } else if (company.pauseIfROASBelow && metrics.roas < company.pauseIfROASBelow && ageDays > 5) {
          await this.pauseCampaign(
            campaign,
            company,
            `ROAS ${metrics.roas.toFixed(2)}x below ${company.pauseIfROASBelow}x after 5 days`,
          );
          paused = true;
        } else if (
          company.pauseAfterDaysInLearning &&
          ageDays > company.pauseAfterDaysInLearning &&
          metrics.conversions === 0
        ) {
          await this.pauseCampaign(
            campaign,
            company,
            `Stuck in learning phase for ${Math.round(ageDays)} days with 0 conversions`,
          );
          paused = true;
        }

        if (paused) {
          result.paused++;
          continue;
        }

        // ── Auto-scale check ─────────────────────────────────────────────────
        if (company.scaleIfROASAbove && metrics.roas > company.scaleIfROASAbove) {
          await this.optimizer.scaleBudget(campaign, company, metrics);
          result.scaled++;
        }

        // ── Performance writeback at day 7/14/30 ─────────────────────────────
        const written = await this.writePerformanceBack(campaign, metrics, ageDays);
        if (written) result.performanceWritten++;

      } catch (err: any) {
        this.logger.error(
          `Audit failed for campaign ${campaign.metaCampaignId}: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `Audit complete: tenantId=${tenantId} audited=${result.campaignsAudited} paused=${result.paused} scaled=${result.scaled} written=${result.performanceWritten}`,
    );

    return result;
  }

  private async fetchMetrics(
    campaign: CampaignDocument,
    company: CompanyDocument,
  ): Promise<CampaignMetrics> {
    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      agentType: AgentType.CAMPAIGN_AUDITOR,
      systemPrompt: `You are a Meta Ads analyst. Fetch campaign metrics using the Meta Ads MCP tools and return them as JSON.
Always return a JSON object with these exact fields:
{ "spend": number, "impressions": number, "clicks": number, "conversions": number, "roas": number, "ctr": number, "cpc": number, "frequency": number }`,
      liveContext: '',
      userMessage: `Fetch the current performance metrics for Meta campaign ID "${campaign.metaCampaignId}".
Return the metrics as a JSON object with fields: spend, impressions, clicks, conversions, roas, ctr, cpc, frequency.`,
      maxTurns: 5,
    });

    return this.parseMetrics(result.content);
  }

  private parseMetrics(content: string): CampaignMetrics {
    try {
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) ?? content.match(/\{[\s\S]*?\}/);
      const raw = jsonMatch ? JSON.parse(jsonMatch[1] ?? jsonMatch[0]) : {};
      return {
        spend: raw.spend ?? 0,
        impressions: raw.impressions ?? 0,
        clicks: raw.clicks ?? 0,
        conversions: raw.conversions ?? 0,
        roas: raw.roas ?? 0,
        ctr: raw.ctr ?? 0,
        cpc: raw.cpc ?? 0,
        frequency: raw.frequency ?? 0,
      };
    } catch {
      this.logger.warn('Failed to parse metrics JSON — using zeros');
      return { spend: 0, impressions: 0, clicks: 0, conversions: 0, roas: 0, ctr: 0, cpc: 0, frequency: 0 };
    }
  }

  private async pauseCampaign(
    campaign: CampaignDocument,
    company: CompanyDocument,
    reason: string,
  ): Promise<void> {
    await this.campaignsService.pause(company.tenantId, campaign._id.toString(), reason);

    await this.actionLogger.log({
      tenantId: company.tenantId,
      agent: AgentType.CAMPAIGN_AUDITOR,
      action: 'campaign_paused',
      reason,
      outcome: `Campaign ${campaign.metaCampaignId} paused`,
      metadata: { metaCampaignId: campaign.metaCampaignId, briefId: campaign.briefId },
    });

    this.logger.log(
      `Campaign paused: tenantId=${company.tenantId} metaCampaignId=${campaign.metaCampaignId} reason="${reason}"`,
    );
  }

  private async writePerformanceBack(
    campaign: CampaignDocument,
    metrics: CampaignMetrics,
    ageDays: number,
  ): Promise<boolean> {
    const perf = {
      roas: metrics.roas,
      ctr: metrics.ctr,
      cpc: metrics.cpc,
      conversions: metrics.conversions,
    };

    // Load the brief to check what's already been written
    const brief = await this.briefModel.findOne({ briefId: campaign.briefId }).lean().exec();
    if (!brief) return false;

    let written = false;

    if (ageDays >= 7 && !brief.performanceWritten?.day7) {
      await this.briefModel.updateOne(
        { briefId: campaign.briefId },
        { day7Performance: perf, 'performanceWritten.day7': true },
      );
      written = true;
      this.logger.log(`Day 7 performance written for briefId=${campaign.briefId}`);
    }

    if (ageDays >= 14 && !brief.performanceWritten?.day14) {
      await this.briefModel.updateOne(
        { briefId: campaign.briefId },
        { day14Performance: perf, 'performanceWritten.day14': true },
      );
      written = true;
      this.logger.log(`Day 14 performance written for briefId=${campaign.briefId}`);
    }

    if (ageDays >= 30 && !brief.performanceWritten?.day30) {
      await this.briefModel.updateOne(
        { briefId: campaign.briefId },
        { day30Performance: perf, 'performanceWritten.day30': true },
      );
      written = true;
      this.logger.log(`Day 30 performance written for briefId=${campaign.briefId}`);
    }

    return written;
  }
}
