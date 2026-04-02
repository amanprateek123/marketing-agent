import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ActionLog, ActionLogDocument } from './action-log.schema';

export interface ActionLogEntry {
  tenantId: string;
  runId?: string;
  agent: string;
  action: string;
  reason: string;
  outcome: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class ActionLoggerService {
  constructor(
    @InjectModel(ActionLog.name)
    private readonly actionLogModel: Model<ActionLogDocument>,
  ) {}

  async log(entry: ActionLogEntry): Promise<void> {
    await this.actionLogModel.create(entry);
  }
}
