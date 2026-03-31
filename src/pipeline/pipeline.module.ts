import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PipelineRun, PipelineRunSchema } from './schemas/pipeline-run.schema';
import { ScoutOutput, ScoutOutputSchema } from './schemas/scout-output.schema';
import { ScoutSignal, ScoutSignalSchema } from './schemas/scout-signal.schema';
import { IntelligenceBrief, IntelligenceBriefSchema } from './schemas/intelligence-brief.schema';
import { CreativeBrief, CreativeBriefSchema } from './schemas/creative-brief.schema';
import { CoordinatorOutput, CoordinatorOutputSchema } from './schemas/coordinator-output.schema';
import { ResearchOutput, ResearchOutputSchema } from './schemas/research-output.schema';
import { Digest, DigestSchema } from './schemas/digest.schema';
import { ClaudeModule } from '../claude/claude.module';
import { CompaniesModule } from '../companies/companies.module';
import { InstagramScout } from './scouts/instagram.scout';
import { RedditScout } from './scouts/reddit.scout';
import { TwitterScout } from './scouts/twitter.scout';
import { YoutubeScout } from './scouts/youtube.scout';
import { CoordinatorService } from './coordinator.service';
import { IdeaPoolService } from './idea-pool.service';
import { DigestWriterService } from './digest-writer.service';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { PipelineController } from './pipeline.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PipelineRun.name, schema: PipelineRunSchema },
      { name: ScoutOutput.name, schema: ScoutOutputSchema },
      { name: ScoutSignal.name, schema: ScoutSignalSchema },
      { name: IntelligenceBrief.name, schema: IntelligenceBriefSchema },
      { name: CreativeBrief.name, schema: CreativeBriefSchema },
      { name: CoordinatorOutput.name, schema: CoordinatorOutputSchema },
      { name: ResearchOutput.name, schema: ResearchOutputSchema },
      { name: Digest.name, schema: DigestSchema },
    ]),
    ClaudeModule,
    CompaniesModule,
  ],
  controllers: [PipelineController],
  providers: [
    InstagramScout,
    RedditScout,
    TwitterScout,
    YoutubeScout,
    CoordinatorService,
    IdeaPoolService,
    DigestWriterService,
    PipelineOrchestratorService,
  ],
  exports: [
    PipelineOrchestratorService,
  ],
})
export class PipelineModule {}
