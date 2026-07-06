import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EngineEventBus } from '../shared/engine-event-bus.service';
import {
  CampaignIntelligenceCycle,
  CampaignIntelligenceCycleDocument,
} from './cycle.schema';
import {
  DEFAULT_FEATURE_FLAGS,
  DecisionContext,
  createDecisionContext,
} from './decision-context';

/**
 * The orchestrator's only job in PR-01 is to open a cycle and emit
 * intelligence.cycle.started. Engines subscribe to this event (or to a
 * previous engine's completion) and fire themselves.
 *
 * Future work (PR-04, PR-27+): tenant-scoped batching, BullMQ trigger,
 * replay support.
 */
@Injectable()
export class IntelligenceOrchestrator {
  private readonly logger = new Logger(IntelligenceOrchestrator.name);

  constructor(
    @InjectModel(CampaignIntelligenceCycle.name)
    private readonly cycleModel: Model<CampaignIntelligenceCycleDocument>,
    private readonly eventBus: EngineEventBus,
  ) {}

  /**
   * Open a new cycle: persist metadata, emit intelligence.cycle.started.
   * Returns the seed DecisionContext (typed identity + timings + flags).
   */
  async openCycle(input: {
    tenantId: string;
    campaignId: string;
    metaCampaignId?: string;
    featureFlags?: Partial<DecisionContext['featureFlags']>;
  }): Promise<DecisionContext> {
    const cycleId = randomUUID();
    const dc = createDecisionContext({
      cycleId,
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      metaCampaignId: input.metaCampaignId,
      featureFlags: input.featureFlags,
    });

    await this.cycleModel.create({
      tenantId: dc.tenantId,
      campaignId: dc.campaignId,
      cycleId: dc.cycleId,
      metaCampaignId: dc.metaCampaignId,
      featureFlags: dc.featureFlags,
      startedAt: dc.startedAt,
      status: 'pending',
      errorLog: [],
    });

    this.eventBus.emitCycleStarted({
      cycleId: dc.cycleId,
      tenantId: dc.tenantId,
      campaignId: dc.campaignId,
      at: dc.startedAt,
    });

    this.logger.log(
      `openCycle tenant=${dc.tenantId} campaign=${dc.campaignId} cycle=${dc.cycleId}`,
    );
    return dc;
  }

  /**
   * Mark cycle completed. Called when Learning Engine (or the last
   * engine wired in the current rollout phase) finishes.
   */
  async closeCycle(cycleId: string, status: 'completed' | 'failed' = 'completed'): Promise<void> {
    const doc = await this.cycleModel.findOne({ cycleId });
    if (!doc) {
      this.logger.warn(`closeCycle: cycle ${cycleId} not found`);
      return;
    }
    const completedAt = new Date();
    const durationMs = doc.startedAt ? completedAt.getTime() - doc.startedAt.getTime() : undefined;
    await this.cycleModel.updateOne(
      { cycleId },
      { $set: { completedAt, durationMs, status } },
    );
    this.eventBus.emitCycleCompleted({
      cycleId,
      tenantId: doc.tenantId,
      campaignId: doc.campaignId,
      durationMs: durationMs ?? 0,
      at: completedAt,
    });
  }

  defaultFeatureFlags(): DecisionContext['featureFlags'] {
    return { ...DEFAULT_FEATURE_FLAGS };
  }
}
