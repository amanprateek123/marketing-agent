import { Global, Module } from '@nestjs/common';
import { ConfidenceEngine } from './confidence-engine.service';

@Global()
@Module({
  providers: [ConfidenceEngine],
  exports: [ConfidenceEngine],
})
export class ConfidenceModule {}
