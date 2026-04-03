import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClaudeService } from '../claude/claude.service';
import { AgentType } from '../claude/claude.types';
import { LiveContextBuilder } from '../companies/prompt-generator/live-context.builder';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { UsageLog } from '../claude/schemas/usage-log.schema';

export interface ScoutTeamOutput {
  runId: string;
  teamName: string;
  platforms: {
    instagram: any;
    reddit: any;
    twitter: any;
    youtube: any;
  };
  crossValidated: {
    topic: string;
    angle: string;
    platforms: string[];
    combinedScore: number;
    multi_platform_confirmed: boolean;
    recommendation: string;
  }[];
  topSignals: {
    rank: number;
    topic: string;
    angle: string;
    signalScore: number;
    platforms: string[];
    engagementProof: { metric: string; value: number; source: string };
    recency: string;
    recommendation: string;
  }[];
  viralTrends: any[];
  filteredOut: { topic: string; reason: string }[];
  summary: string;
}

@Injectable()
export class TeamOrchestratorService {
  private readonly logger = new Logger(TeamOrchestratorService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly liveContextBuilder: LiveContextBuilder,
    @InjectModel(UsageLog.name)
    private readonly usageLogModel: Model<UsageLog>,
  ) {}

  async runScoutTeam(
    company: CompanyDocument,
    runId: string,
  ): Promise<ScoutTeamOutput> {
    this.logger.log(`Scout Team starting | tenant: ${company.tenantId} | run: ${runId}`);

    const teamName = `scout-${runId}`;
    const prompt = this.buildScoutTeamPrompt(company, runId, teamName);

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      agentType: AgentType.SCOUT_TEAM_LEAD,
      systemPrompt: company.prompts?.intelligenceLead ?? '',
      liveContext: this.liveContextBuilder.build(company),
      userMessage: prompt,
      maxTurns: 40,
      runId,
    });

    return this.parseOutput(result.content, runId);
  }

  private buildScoutTeamPrompt(
    company: CompanyDocument,
    runId: string,
    teamName: string,
  ): string {
    return `
Run the Scout Team intelligence pipeline for ${company.name}.

TEAM NAME: ${teamName}
RUN ID: ${runId}

COMPANY CONTEXT:
- Industry: ${company.industry}
- Target Audience: ${company.targetAudience}
- Competitors: ${company.competitors.join(', ')}
- Weekly Signals (recent observations): ${company.signals?.weekly?.observations?.join(' | ') ?? 'none yet'}

YOUR TASKS:
1. Create team "${teamName}" via TeamCreate
2. Spawn reddit-scout, twitter-scout, youtube-scout via Agent tool (run_in_background: true)
   Pass each scout this full context block so they know what to search for
3. Scout Instagram yourself using WebSearch + WebFetch
4. Collect findings via SendMessage from each scout
5. Cross-validate, filter manufactured hype, synthesize
6. Return the final JSON report

SCOUT CONTEXT TO PASS TO EACH TEAMMATE:
Company: ${company.name}
Industry: ${company.industry}
Target Audience: ${company.targetAudience}
Competitors: ${company.competitors.join(', ')}
Team Name: ${teamName}
Send your findings to: intelligence-lead

Return ONLY valid JSON matching the ScoutTeamOutput schema. No explanation before or after.
    `.trim();
  }

  private parseOutput(content: string, runId: string): ScoutTeamOutput {
    try {
      const fenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
      return JSON.parse(jsonStr);
    } catch {
      this.logger.error(`Scout Team output parse failed for run ${runId}`);
      throw new Error(`Scout Team returned invalid JSON for run ${runId}`);
    }
  }
}
