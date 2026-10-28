import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PmAnalysisService } from '../../analysis/pm-analysis.service';
import { addDays } from '../../analysis/pm-stats';
import { pmEnv, PmEnv } from '../../pm.config';
import { istDay } from '../../pm.logic';
import { PmMetaEntitySnapshot } from '../../schemas/pm-entity-snapshot.schema';
import { PmMetaEntity } from '../../schemas/pm-meta.schema';
import { PmJournalService } from '../journal/journal.service';
import { PmCalendarTools } from '../tools/calendar.tools';
import type { PmSituation } from './lessons.types';
import { buildSituation, SEASON_LOOKAHEAD_DAYS } from './situation.logic';

type Level = 'campaign' | 'adset' | 'ad';
/** How far back to look for the last edit. */
const EDIT_LOOKBACK_DAYS = 60;

/**
 * The PmSituation of a campaign / ad set / ad on a date (data to the day
 * before, IST). Used for decision context snapshots and lesson picking.
 * Learning stage and targeting come from the day-before settings snapshot
 * when there is one (as-of), else from the current entity.
 */
@Injectable()
export class PmSituationService {
  constructor(
    @InjectModel(PmMetaEntity.name)
    private readonly entities: Model<PmMetaEntity>,
    @InjectModel(PmMetaEntitySnapshot.name)
    private readonly snapshots: Model<PmMetaEntitySnapshot>,
    private readonly analysis: PmAnalysisService,
    private readonly journal: PmJournalService,
    private readonly calendar: PmCalendarTools,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  forCampaign(campaignId: string, date: string): Promise<PmSituation> {
    return this.forEntity('campaign', campaignId, date);
  }

  async forEntity(level: Level, entityId: string, date: string): Promise<PmSituation> {
    const tenantId = this.env.tenantId;
    const entity = await this.entities.findOne({ tenantId, level, entityId }).lean();
    const campaignId = level === 'campaign' ? entityId : entity?.campaignId ?? '';
    const campaign =
      level === 'campaign' ? entity : await this.entities.findOne({ tenantId, level: 'campaign', entityId: campaignId }).lean();
    const adsetFilter =
      level === 'campaign' ? { campaignId } : { entityId: level === 'adset' ? entityId : entity?.adsetId ?? '' };
    const adsets = await this.entities
      .find({ tenantId, level: 'adset', ...adsetFilter }, { entityId: 1, status: 1, learningStage: 1, targetingSummary: 1 })
      .lean();
    const yesterday = addDays(date, -1);
    const snaps = await this.snapshots
      .find(
        { tenantId, entityId: { $in: adsets.map((a) => a.entityId) }, date: yesterday },
        { entityId: 1, status: 1, learningStage: 1, targetingSummary: 1 },
      )
      .lean();
    const snap = new Map(snaps.map((s) => [s.entityId, s]));
    const asOf = adsets.map((a) => ({ ...a, ...(snap.get(a.entityId) ?? {}) }));
    const active = asOf.filter((a) => a.status === 'ACTIVE');

    const w7 = { from: addDays(date, -7), to: yesterday };
    const p7 = { from: addDays(date, -14), to: addDays(date, -8) };
    const [m7, mp7, a7, ap7, missing, changes] = await Promise.all([
      this.analysis.scopeMetrics(w7, level, entityId),
      this.analysis.scopeMetrics(p7, level, entityId),
      this.analysis.scopeMetrics(w7),
      this.analysis.scopeMetrics(p7),
      this.analysis.metaMissingDays(w7.from, w7.to),
      campaignId ? this.journal.changeRows(campaignId, addDays(date, -EDIT_LOOKBACK_DAYS), yesterday) : Promise.resolve([]),
    ]);
    // Edits on this entity, its parents or its children.
    const touching = changes.filter(
      (c) =>
        level === 'campaign' ||
        c.objectId === entityId ||
        c.adsetId === entityId ||
        c.objectId === campaignId ||
        (level === 'ad' && c.objectId === entity?.adsetId),
    );
    const lastEdit = touching.length ? istDay(touching[touching.length - 1].at) : null;

    return buildSituation({
      date,
      product: entity?.product ?? campaign?.product ?? 'other',
      objective: campaign?.objective ?? '',
      campaignName: campaign?.name ?? '',
      budgetLevel: campaign?.budgetLevel ?? '',
      adsets: (active.length ? active : asOf).map((a) => ({
        audienceType: a.targetingSummary?.audienceType,
        learningStage: a.learningStage,
      })),
      launchedOn: entity?.createdTime ? istDay(entity.createdTime) : null,
      lastEditOn: lastEdit,
      m7,
      p7: mp7,
      accountCpm7: a7.cpm,
      accountCpmPrior7: ap7.cpm,
      missingDays: missing.length,
      calendar: this.calendar.query(
        date,
        addDays(date, SEASON_LOOKAHEAD_DAYS),
        ['festival', 'astro_event', 'market_event'],
        undefined,
        date,
      ),
      level,
      entityId,
    });
  }
}
