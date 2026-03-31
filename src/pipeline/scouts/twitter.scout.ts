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

  protected buildResearchPrompt(company: CompanyDocument): string {
    return `
Scout Twitter/X right now for trending conversations relevant to ${company.name}.

Focus on real-time Indian ${company.industry} discourse — viral angles, trending hashtags,
cultural moments, and competitor mentions.
Competitors to monitor: ${company.competitors.join(', ')}.

Use web_search with site:twitter.com and site:x.com queries to find live signals.
Return only the JSON output as specified in your instructions.
    `.trim();
  }
}
