import { Global, Module } from '@nestjs/common';
import { ExplainabilityEngine } from './explainability-engine.service';

@Global()
@Module({
  providers: [ExplainabilityEngine],
  exports: [ExplainabilityEngine],
})
export class ExplainabilityModule {}
