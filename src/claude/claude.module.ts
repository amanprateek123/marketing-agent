import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClaudeService } from './claude.service';
import { UsageLog, UsageLogSchema } from './schemas/usage-log.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UsageLog.name, schema: UsageLogSchema },
    ]),
  ],
  providers: [ClaudeService],
  exports: [ClaudeService],
})
export class ClaudeModule {}
