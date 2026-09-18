import { Module } from '@nestjs/common';
import { PipelineBridgeController } from './pipeline-bridge.controller';
import { PipelineBridgeService } from './pipeline-bridge.service';

/**
 * Bridge to the external creative pipeline.
 *
 * Registers no schemas and imports no feature modules — it holds no state and
 * touches no collection. Finished creatives re-enter this system through the
 * ordinary `POST /creative/:tenantId/packages/upload-bulk` door, pushed by the
 * pipeline itself, so nothing here needs access to CreativePackage or Gallery.
 */
@Module({
  controllers: [PipelineBridgeController],
  providers: [PipelineBridgeService],
  exports: [PipelineBridgeService],
})
export class PipelineBridgeModule {}
