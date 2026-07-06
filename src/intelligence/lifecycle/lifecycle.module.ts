import { Global, Module } from '@nestjs/common';
import { LifecycleEngine } from './lifecycle-engine.service';

@Global()
@Module({
  providers: [LifecycleEngine],
  exports: [LifecycleEngine],
})
export class LifecycleModule {}
