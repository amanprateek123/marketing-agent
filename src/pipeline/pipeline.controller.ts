import {
  Controller,
  Post,
  Get,
  Param,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { CompaniesService } from '../companies/companies.service';
import { StrategyTeamService } from '../teams/strategy-team.service';
import { CoordinatorService } from './coordinator.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CoordinatorOutput } from './schemas/coordinator-output.schema';
import { ResearchOutput } from './schemas/research-output.schema';

@Controller('pipeline')
export class PipelineController {
  constructor(
    private readonly orchestrator: PipelineOrchestratorService,
    private readonly companiesService: CompaniesService,
    private readonly strategyTeam: StrategyTeamService,
    @InjectModel(CoordinatorOutput.name)
    private readonly coordinatorOutputModel: Model<CoordinatorOutput>,
    @InjectModel(ResearchOutput.name)
    private readonly researchOutputModel: Model<ResearchOutput>,
  ) {}

  /**
   * POST /api/v1/pipeline/:tenantId/trigger
   * Starts a pipeline run for a tenant. Returns immediately with runId.
   */
  @Post(':tenantId/trigger')
  async trigger(@Param('tenantId') tenantId: string) {
    try {
      return await this.orchestrator.trigger(tenantId);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * GET /api/v1/pipeline/runs/:runId
   * Poll for pipeline status.
   */
  @Get('runs/:runId')
  async getStatus(@Param('runId') runId: string) {
    const run = await this.orchestrator.getStatus(runId);
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    return run;
  }

  /**
   * POST /api/v1/pipeline/:tenantId/runs/:runId/strategy-team-test
   * Runs ONLY the Strategy Team debate using existing scout/research data from a past run.
   * Reuses coordinator output + competitor/market research already in MongoDB.
   */
  @Post(':tenantId/runs/:runId/strategy-team-test')
  async strategyTeamTest(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
  ) {
    try {
      const company = await this.companiesService.findByTenantId(tenantId);

      // Load existing coordinator output
      const coordOutput = await this.coordinatorOutputModel
        .findOne({ tenantId, runId })
        .lean()
        .exec();
      if (!coordOutput) {
        throw new Error(`No coordinator output found for runId=${runId}`);
      }

      // Load existing research
      const research = await this.researchOutputModel
        .find({ tenantId, runId })
        .lean()
        .exec();
      const competitorResearch = research.find((r) => r.type === 'competitor')?.content ?? '';
      const marketResearch = research.find((r) => r.type === 'market')?.content ?? '';

      const testRunId = `strategy-test-${Date.now()}`;

      const result = await this.strategyTeam.run(
        company,
        testRunId,
        {
          coordinatorOutputId: (coordOutput as any)._id.toString(),
          content: coordOutput.content,
          topSignals: coordOutput.topSignals,
        },
        competitorResearch,
        marketResearch,
      );

      return { success: true, runId: testRunId, result };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/pipeline/:tenantId/runs/:runId/regenerate-digest
   * Regenerate and re-deliver the digest for an existing run using stored data.
   */
  @Post(':tenantId/runs/:runId/regenerate-digest')
  async regenerateDigest(
    @Param('tenantId') tenantId: string,
    @Param('runId') runId: string,
  ) {
    try {
      await this.orchestrator.regenerateDigest(tenantId, runId);
      return { success: true, message: 'Digest regenerated and delivered' };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }
}
