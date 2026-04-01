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
export class RedditScout extends ScoutBaseService {
  readonly platform = 'reddit';
  readonly agentType = AgentType.REDDIT_SCOUT;

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
Scout Reddit right now for two types of signals for ${company.name}.

PART 1 — INDUSTRY SIGNALS
Find trending discussions in Indian ${company.industry} space.
Real pain points, questions, competitor complaints from: ${company.competitors.join(', ')}.
Use web_search with site:reddit.com queries.

PART 2 — VIRAL TRENDS (trend-jacking opportunities)
Find what topics are massively viral on Reddit India right now — regardless of industry.
This includes: trending memes, viral posts on r/india r/bollywood r/cricket, pop culture moments.
For each trend, suggest how ${company.name} could create content using that trend.
Search: "site:reddit.com trending india today", "site:reddit.com viral india this week".

${this.buildExclusionBlock(recentlyCovered)}

Return both in the JSON output as specified in your instructions.
    `.trim();
  }
}
