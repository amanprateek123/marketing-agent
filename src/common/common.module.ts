import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ActionLog, ActionLogSchema } from './action-logger/action-log.schema';
import { ActionLoggerService } from './action-logger/action-logger.service';
import { EventCalendarService } from './calendar/event-calendar.service';
import { TenantEconomicsService } from './economics/tenant-economics.service';
import { ImageResizerService } from './media/image-resizer.service';
import { S3Service } from './storage/s3.service';
import { Company, CompanySchema } from '../companies/schemas/company.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ActionLog.name, schema: ActionLogSchema },
      // Registered here (rather than only in CompaniesModule) so
      // TenantEconomicsService can resolve product margin without importing
      // CompaniesModule — which would create a cycle, since CompaniesModule
      // already depends on CommonModule for the action logger.
      { name: Company.name, schema: CompanySchema },
    ]),
  ],
  // S3Service is provided here (not only inside CreativeModule) because
  // ImageResizerService depends on it and is exported to CampaignsModule.
  providers: [
    ActionLoggerService,
    EventCalendarService,
    S3Service,
    ImageResizerService,
    TenantEconomicsService,
  ],
  exports: [
    ActionLoggerService,
    EventCalendarService,
    ImageResizerService,
    TenantEconomicsService,
  ],
})
export class CommonModule {}
