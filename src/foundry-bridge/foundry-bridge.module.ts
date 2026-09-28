import { Module } from '@nestjs/common';
import { FoundryBridgeController } from './foundry-bridge.controller';
import { FoundryBridgeService } from './foundry-bridge.service';
import { CreativeImageService } from './creative-image.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { PipelineBridgeModule } from '../pipeline-bridge/pipeline-bridge.module';

/**
 * Bridge to Brain v2 and the marketing agents around it.
 *
 * Registers no schemas and imports no feature modules. It owns no state: every row this console
 * shows lives in the brain's own Postgres, and every run lives in Foundry. That is deliberate —
 * the dashboard and Slack are two windows onto the same rows, so a gate answered in one is answered
 * in the other without anything here having to synchronise them.
 */
@Module({
  // PipelineBridgeModule: the inbox lists creative runs waiting on an answer.
  imports: [PipelineBridgeModule],
  controllers: [FoundryBridgeController, InboxController],
  providers: [FoundryBridgeService, CreativeImageService, InboxService],
  exports: [FoundryBridgeService, InboxService],
})
export class FoundryBridgeModule {}
