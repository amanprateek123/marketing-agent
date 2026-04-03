import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaudeModule } from '../claude/claude.module';
import { CompaniesModule } from '../companies/companies.module';
import { UsageLog, UsageLogSchema } from '../claude/schemas/usage-log.schema';
import { TeamOrchestratorService } from './team-orchestrator.service';
import { TeamFallbackService } from './team-fallback.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UsageLog.name, schema: UsageLogSchema },
    ]),
    ClaudeModule,
    CompaniesModule,
  ],
  providers: [TeamOrchestratorService, TeamFallbackService],
  exports: [TeamOrchestratorService, TeamFallbackService],
})
export class TeamsModule {}
