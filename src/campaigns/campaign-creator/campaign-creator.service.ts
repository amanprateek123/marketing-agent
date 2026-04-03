import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { ActionLoggerService } from '../../common/action-logger/action-logger.service';
import { CampaignsService } from '../campaigns.service';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CreativeBriefDocument } from '../../pipeline/schemas/creative-brief.schema';
import { CreativePackageDocument } from '../../creative/schemas/creative-package.schema';
import { SafetyChecks } from './safety-checks';

const CAMPAIGN_CREATOR_FALLBACK_PROMPT = `You are a Meta Ads campaign specialist.
Your job is to create and launch Meta Ads campaigns using the Meta Ads MCP tools.
Always use 70/30 audience split: 70% proven/lookalike audience, 30% broad test audience.
Follow exact naming conventions provided. Never exceed the specified budget.`;

@Injectable()
export class CampaignCreatorService {
  private readonly logger = new Logger(CampaignCreatorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly campaignsService: CampaignsService,
    private readonly liveContextBuilder: LiveContextBuilder,
    private readonly actionLogger: ActionLoggerService,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
  ) {}

  async create(
    brief: CreativeBriefDocument,
    creativePackage: CreativePackageDocument,
    company: CompanyDocument,
    runId: string,
  ): Promise<CampaignDocument> {
    // ── ALL SAFETY CHECKS — TypeScript level, Claude cannot override ──────────
    SafetyChecks.checkForbiddenTopics(brief, company);
    SafetyChecks.checkCampaignBudget(brief.suggestedBudget, company);
    await SafetyChecks.checkWeeklyBudget(company.tenantId, brief.suggestedBudget, company, this.campaignsService);
    await SafetyChecks.checkCampaignsPerRun(company.tenantId, runId, company, this.campaignsService);

    this.logger.log(
      `Safety checks passed — launching campaign: tenantId=${company.tenantId} briefId=${brief.briefId} budget=$${brief.suggestedBudget}`,
    );

    const campaignName = `META_${company.primaryObjective.toUpperCase()}_${brief.audience}_${brief.topic}_${new Date().toISOString().split('T')[0]}`;

    const systemPrompt = company.prompts?.campaignCreator ?? CAMPAIGN_CREATOR_FALLBACK_PROMPT;

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      agentType: AgentType.CAMPAIGN_CREATOR,
      systemPrompt,
      liveContext: this.liveContextBuilder.build(company),
      userMessage: `Create and launch a Meta Ads campaign with the following details:

Campaign Name: ${campaignName}
Brief Topic: ${brief.topic}
Angle: ${brief.angle}
Platform: ${brief.platform}
Format: ${brief.format}
Audience: ${brief.audience}
Hook: ${brief.hook}
Key Message: ${brief.keyMessage}
Conversion Bridge: ${brief.conversionBridge}
Budget: $${brief.suggestedBudget}
Objective: ${company.primaryObjective}
Geography: ${company.geography}

Selected Creative:
${JSON.stringify(creativePackage, null, 2)}

Use 70/30 split: 70% proven/lookalike audience, 30% broad test audience.
After creating the campaign, return the Meta campaign ID in this format:
META_CAMPAIGN_ID: <id>`,
      maxTurns: 15,
      runId,
    });

    const metaCampaignId = this.extractMetaCampaignId(result.content) ?? `mock_${Date.now()}`;

    const campaign = await this.campaignModel.create({
      tenantId: company.tenantId,
      runId,
      briefId: brief.briefId,
      creativePackageId: creativePackage._id.toString(),
      metaCampaignId,
      status: 'active',
      budget: brief.suggestedBudget,
      objective: company.primaryObjective,
      launchedAt: new Date(),
    });

    await this.actionLogger.log({
      tenantId: company.tenantId,
      runId,
      agent: AgentType.CAMPAIGN_CREATOR,
      action: 'campaign_launched',
      reason: `Auto-launched campaign for brief "${brief.topic}" with budget $${brief.suggestedBudget}`,
      outcome: `Meta campaign ID: ${metaCampaignId}`,
      metadata: { briefId: brief.briefId, campaignName },
    });

    this.logger.log(
      `Campaign launched: tenantId=${company.tenantId} metaCampaignId=${metaCampaignId}`,
    );

    return campaign;
  }

  private extractMetaCampaignId(content: string): string | null {
    const match = content.match(/META_CAMPAIGN_ID:\s*([^\s\n]+)/);
    return match ? match[1] : null;
  }
}
