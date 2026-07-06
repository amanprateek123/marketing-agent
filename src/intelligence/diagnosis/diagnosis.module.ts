import { Global, Module } from '@nestjs/common';
import { DiagnosisEngine } from './diagnosis-engine.service';

@Global()
@Module({
  providers: [DiagnosisEngine],
  exports: [DiagnosisEngine],
})
export class DiagnosisModule {}
