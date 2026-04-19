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
import { RedditApiService } from './reddit-api.service';

@Injectable()
export class RedditScout extends ScoutBaseService {
  readonly platform = 'reddit';
  readonly agentType = AgentType.REDDIT_SCOUT;

  constructor(
    claudeService: ClaudeService,
    liveContextBuilder: LiveContextBuilder,
    @InjectModel(ScoutOutput.name) scoutOutputModel: Model<ScoutOutputDocument>,
    @InjectModel(ScoutSignal.name) scoutSignalModel: Model<ScoutSignalDocument>,
    private readonly redditApi: RedditApiService,
  ) {
    super(claudeService, liveContextBuilder, scoutOutputModel, scoutSignalModel);
  }

  protected async prefetchApiData(company: CompanyDocument): Promise<string> {
    const data = await this.redditApi.fetchScoutData(
      `${company.industry} ${company.geography}`,
      company.geography,
      company.competitors,
    );
    return this.redditApi.formatForPrompt(data);
  }

  protected buildResearchPrompt(
    company: CompanyDocument,
    recentlyCovered: { topic: string; angle: string; type: 'industry' | 'viral' }[],
  ): string {
    return `
Analyse the pre-fetched Reddit data above for two types of signals for ${company.name}.

PART 1 — INDUSTRY SIGNALS
From the INDUSTRY POSTS section: identify high-score posts with real pain points, questions, and complaints relevant to ${company.geography} ${company.industry}.
Real pain points and competitor complaints from: ${company.competitors.join(', ')}.
If the pre-fetched data is missing something important, use web_search with site:reddit.com queries.

PART 2 — VIRAL TRENDS (trend-jacking opportunities)
From the TRENDING IN GEOGRAPHY section: identify what topics are massively viral in ${company.geography} right now.
For each trend, suggest how ${company.name} could create content using that trend.
If you need more, search: "site:reddit.com trending ${company.geography} today".

${this.buildExclusionBlock(recentlyCovered)}

Return both in the JSON output as specified in your instructions.
    `.trim();
  }
}
