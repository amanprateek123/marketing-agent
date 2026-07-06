import { Global, Module } from '@nestjs/common';
import { CompaniesModule } from '../../companies/companies.module';
import { MemoryEngine } from './memory-engine.service';

@Global()
@Module({
  imports: [CompaniesModule],
  providers: [MemoryEngine],
  exports: [MemoryEngine],
})
export class MemoryModule {}
