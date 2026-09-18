import { Global, Module } from '@nestjs/common';
import { ExecutionEngine } from './execution-engine.service';

@Global()
@Module({
  providers: [ExecutionEngine],
  exports: [ExecutionEngine],
})
export class ExecutionModule {}
