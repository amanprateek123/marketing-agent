import { Module } from '@nestjs/common';
import { AlertsService } from './alerts.service';

/** Notifications: Brain alerts shown in the dashboard. No Slack. */
@Module({
  providers: [AlertsService],
  exports: [AlertsService],
})
export class DeliveryModule {}
