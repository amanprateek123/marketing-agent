import { Global, Module } from '@nestjs/common';
import { LearningEngine } from './learning-engine.service';

@Global()
@Module({
  providers: [LearningEngine],
  exports: [LearningEngine],
})
export class LearningModule {}
