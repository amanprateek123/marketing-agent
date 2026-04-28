import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ActionLog, ActionLogSchema } from './action-logger/action-log.schema';
import { ActionLoggerService } from './action-logger/action-logger.service';
import { EventCalendarService } from './calendar/event-calendar.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ActionLog.name, schema: ActionLogSchema }]),
  ],
  providers: [ActionLoggerService, EventCalendarService],
  exports: [ActionLoggerService, EventCalendarService],
})
export class CommonModule {}
