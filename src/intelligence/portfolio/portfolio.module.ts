import { Global, Module } from '@nestjs/common';
import { PortfolioEngine } from './portfolio-engine.service';

@Global()
@Module({
  providers: [PortfolioEngine],
  exports: [PortfolioEngine],
})
export class PortfolioModule {}
