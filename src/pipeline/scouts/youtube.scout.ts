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
import { EventCalendarService } from '../../common/calendar/event-calendar.service';
import { YoutubeApiService } from './youtube-api.service';

@Injectable()
export class YoutubeScout extends ScoutBaseService {
  readonly platform = 'youtube';
  readonly agentType = AgentType.YOUTUBE_SCOUT;

  // YouTube engagement metric is typically `views`. 100k views = realistic
  // floor for "trending in India" — niche channels can hit this in days; below
  // that we're picking up niche-of-niche content the LLM mislabeled as viral.
  protected getEngagementFloor(): number {
    return 100_000;
  }

  constructor(
    claudeService: ClaudeService,
    liveContextBuilder: LiveContextBuilder,
    @InjectModel(ScoutOutput.name) scoutOutputModel: Model<ScoutOutputDocument>,
    @InjectModel(ScoutSignal.name) scoutSignalModel: Model<ScoutSignalDocument>,
    private readonly youtubeApi: YoutubeApiService,
    eventCalendar: EventCalendarService,
  ) {
    super(claudeService, liveContextBuilder, scoutOutputModel, scoutSignalModel, eventCalendar);
  }

  protected async prefetchApiData(company: CompanyDocument): Promise<string> {
    const industryQuery = `${company.industry} ${company.geography}`;
    const viralQuery = `trending ${company.geography} shorts`;
    const competitorQueries = company.competitors.slice(0, 2).map(c => `${c} ${company.geography}`);

    const data = await this.youtubeApi.fetchScoutData(industryQuery, viralQuery, competitorQueries);
    return this.youtubeApi.formatForPrompt(data);
  }

  protected buildResearchPrompt(
    company: CompanyDocument,
    recentlyCovered: { topic: string; angle: string; type: 'industry' | 'viral' }[],
  ): string {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    return `
Analyse the pre-fetched YouTube data above for two types of signals for ${company.name}.

PART 1 — INDUSTRY SIGNALS
From the INDUSTRY VIDEOS section: identify videos with high engagement (views + likes + comments) relevant to ${company.geography} ${company.industry} targeting ${company.targetAudience}.
Competitors to watch: ${company.competitors.join(', ')}.
If the pre-fetched data is missing something important, use web_search with publishedAfter=${sevenDaysAgo}.

PART 2 — VIRAL TRENDS (trend-jacking opportunities)
From the VIRAL / TRENDING VIDEOS section: identify what is massively trending on YouTube in ${company.geography} RIGHT NOW.
For each trend, suggest how ${company.name} could create content using that trend.
If you need more, search: "trending YouTube ${company.geography} this week", "viral shorts ${company.geography}".

${this.buildExclusionBlock(recentlyCovered)}

Return both in the JSON output as specified in your instructions.
    `.trim();
  }
}
