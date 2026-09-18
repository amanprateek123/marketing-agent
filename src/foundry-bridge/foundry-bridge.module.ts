import { Module } from '@nestjs/common';
import { FoundryBridgeController } from './foundry-bridge.controller';
import { FoundryBridgeService } from './foundry-bridge.service';

/**
 * Bridge to Brain v2 and the marketing agents around it.
 *
 * Registers no schemas and imports no feature modules. It owns no state: every row this console
 * shows lives in the brain's own Postgres, and every run lives in Foundry. That is deliberate —
 * the dashboard and Slack are two windows onto the same rows, so a gate answered in one is answered
 * in the other without anything here having to synchronise them.
 */
@Module({
  controllers: [FoundryBridgeController],
  providers: [FoundryBridgeService],
  exports: [FoundryBridgeService],
})
export class FoundryBridgeModule {}
