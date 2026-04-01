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
export class YoutubeScout extends ScoutBaseService {
  readonly platform = 'youtube';
  readonly agentType = AgentType.YOUTUBE_SCOUT;

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
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    return `
Scout YouTube right now for two types of signals for ${company.name}.

PART 1 — INDUSTRY SIGNALS
Find high-performing Indian ${company.industry} videos published in the last 7 days.
Use the YouTube Data API (key in your instructions) with publishedAfter=${sevenDaysAgo}.
Competitors to analyse: ${company.competitors.join(', ')}.
Run multiple API queries for different search terms. Fetch video statistics for promising videos.

PART 2 — VIRAL TRENDS (trend-jacking opportunities)
Find what is massively trending on YouTube India right now — regardless of industry.
Search YouTube API for: trending India videos, viral shorts India, top India content this week.
Use queries like: q=trending india, q=viral india shorts, q=india meme ${sevenDaysAgo}.
For each viral trend found, suggest how ${company.name} could create a video riding that trend.

${this.buildExclusionBlock(recentlyCovered)}

Return both in the JSON output as specified in your instructions.
    `.trim();
  }
}
