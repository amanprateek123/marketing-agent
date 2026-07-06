import { Global, Module } from '@nestjs/common';
import { ForecastEngine } from './forecast-engine.service';

@Global()
@Module({
  providers: [ForecastEngine],
  exports: [ForecastEngine],
})
export class ForecastModule {}
