import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ActionLog, ActionLogSchema } from './action-logger/action-log.schema';
import { ActionLoggerService } from './action-logger/action-logger.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ActionLog.name, schema: ActionLogSchema }]),
  ],
  providers: [ActionLoggerService],
  exports: [ActionLoggerService],
})
export class CommonModule {}
