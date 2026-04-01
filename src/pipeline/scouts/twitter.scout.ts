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
export class TwitterScout extends ScoutBaseService {
  readonly platform = 'twitter';
  readonly agentType = AgentType.TWITTER_SCOUT;

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
Scout Twitter/X right now for two types of signals for ${company.name}.

PART 1 — INDUSTRY SIGNALS
Find trending conversations in Indian ${company.industry} space.
Viral angles, trending hashtags, competitor mentions: ${company.competitors.join(', ')}.
Use web_search with site:twitter.com and site:x.com queries.

PART 2 — VIRAL TRENDS (trend-jacking opportunities)
Find what is trending on Twitter India right now — regardless of industry.
This includes: viral tweets, trending hashtags, memes, Bollywood/cricket/political moments going viral.
For each trend, suggest how ${company.name} could create content riding that trend.
Search: "trending Twitter India today", "viral tweet India this week", top India hashtags now.

${this.buildExclusionBlock(recentlyCovered)}

Return both in the JSON output as specified in your instructions.
    `.trim();
  }
}
