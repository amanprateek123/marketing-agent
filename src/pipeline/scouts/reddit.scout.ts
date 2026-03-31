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

  protected buildResearchPrompt(company: CompanyDocument): string {
    return `
Scout Reddit right now for trending discussions relevant to ${company.name}.

Focus on Indian ${company.industry} audiences — real pain points, questions, and competitor sentiment.
Competitors to find complaints about: ${company.competitors.join(', ')}.

Use web_search with site:reddit.com queries to find live threads.
Return only the JSON output as specified in your instructions.
    `.trim();
  }
}
