import { Global, Module } from '@nestjs/common';
import { ObjectiveEngine } from './objective-engine.service';

@Global()
@Module({
  providers: [ObjectiveEngine],
  exports: [ObjectiveEngine],
})
export class ObjectiveModule {}
