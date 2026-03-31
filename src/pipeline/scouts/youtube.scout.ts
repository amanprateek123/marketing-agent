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

  protected buildResearchPrompt(company: CompanyDocument): string {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    return `
Scout YouTube right now for high-performing video content relevant to ${company.name}.

Focus on Indian ${company.industry} content published in the last 7 days.
Use the YouTube Data API (key in your instructions) with publishedAfter=${sevenDaysAgo}.
Competitors to analyse: ${company.competitors.join(', ')}.

Run multiple API queries for different search terms. Fetch video statistics for promising videos.
Return only the JSON output as specified in your instructions.
    `.trim();
  }
}
