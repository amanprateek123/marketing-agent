import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { LiveContextBuilder } from '../../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { ScoutOutput, ScoutOutputDocument } from '../schemas/scout-output.schema';
import { ScoutSignal, ScoutSignalDocument } from '../schemas/scout-signal.schema';
import { ScoutBaseService } from './scout-base.service';

@Injectable()
export class InstagramScout extends ScoutBaseService {
  readonly platform = 'instagram';
  readonly agentType = AgentType.INSTAGRAM_SCOUT;

  constructor(
    claudeService: ClaudeService,
    liveContextBuilder: LiveContextBuilder,
    @InjectModel(ScoutOutput.name) scoutOutputModel: Model<ScoutOutputDocument>,
    @InjectModel(ScoutSignal.name) scoutSignalModel: Model<ScoutSignalDocument>,
  ) {
    super(claudeService, liveContextBuilder, scoutOutputModel, scoutSignalModel);
  }

  protected buildResearchPrompt(
    company: CompanyDocument,
    recentlyCovered: { topic: string; angle: string; type: 'industry' | 'viral' }[],
  ): string {
    return `
Scout Instagram right now for two types of signals for ${company.name}.

PART 1 — INDUSTRY SIGNALS
Find trending content in ${company.geography} ${company.industry} space targeting ${company.targetAudience}.
Competitors to watch: ${company.competitors.join(', ')}.
Search for: trending reels, viral hooks, high-engagement formats in this niche.

PART 2 — VIRAL TRENDS (trend-jacking opportunities)
Find what is massively trending on Instagram in ${company.geography} RIGHT NOW — regardless of industry.
This includes: viral memes, pop culture moments, sports, viral challenges, news events.
For each trend, suggest how ${company.name} could create content using that trend.
Search: "trending Instagram ${company.geography} today", "viral reels ${company.geography} this week", current events trending.

${this.buildExclusionBlock(recentlyCovered)}

Return both in the JSON output as specified in your instructions.
    `.trim();
  }
}
