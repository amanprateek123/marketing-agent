import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Meta Ads data for the Performance Marketeer, copied read-only from the
 * Marketing API for the 91Astrology ad accounts. Separate from the rest of
 * marketing-agent's Meta sync on purpose: every campaign (paused too), dated
 * breakdowns, settings, and the change log, back to 2026-04-10.
 *
 * Dates are the ad account's calendar day (all three accounts are IST).
 * Metric names match the Marketing API; `meta*` = as reported by Meta, under
 * the account's unified attribution setting.
 */

export type PmProductTag = string; // a PmProduct id, or 'other'

/** Campaign / ad set / ad settings. One row per entity, refreshed on each sync. */
@Schema({ collection: 'pm_meta_entities', timestamps: true })
export class PmMetaEntity {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) accountId: string;
  @Prop({ required: true }) level: 'campaign' | 'adset' | 'ad';
  @Prop({ required: true }) entityId: string;
  @Prop({ default: '' }) name: string;
  @Prop({ default: '' }) campaignId: string;
  @Prop({ default: '' }) adsetId: string;
  @Prop({ default: '' }) status: string;
  @Prop({ default: '' }) effectiveStatus: string;
  @Prop({ type: Date, default: null }) createdTime: Date | null;
  /** Product this entity sells (from its ads' landing URLs, else traffic, else name). */
  @Prop({ default: 'other' }) product: PmProductTag;
  @Prop({ default: 'none' }) productSource:
    | 'url'
    | 'traffic'
    | 'name'
    | 'children'
    | 'none';

  // campaign + ad set
  @Prop({ type: Number, default: null }) dailyBudget: number | null; // rupees
  @Prop({ type: Number, default: null }) lifetimeBudget: number | null; // rupees
  @Prop({ default: '' }) bidStrategy: string;
  // campaign
  @Prop({ default: '' }) objective: string;
  /** Where the budget lives: 'campaign' (CBO / Advantage+) or 'adset' (ABO). */
  @Prop({ default: '' }) budgetLevel: '' | 'campaign' | 'adset';
  @Prop({ default: '' }) buyingType: string;
  // ad set
  @Prop({ default: '' }) optimizationGoal: string;
  @Prop({ default: '' }) billingEvent: string;
  @Prop({ type: Object, default: null }) promotedObject: Record<
    string,
    unknown
  > | null;
  @Prop({ type: Object, default: null }) targeting: Record<
    string,
    unknown
  > | null;
  /** Plain summary of targeting for display and analysis. */
  @Prop({ type: Object, default: null })
  targetingSummary: {
    ageMin?: number;
    ageMax?: number;
    genders?: number[];
    countries?: string[];
    regions?: string[];
    cities?: string[];
    customAudiences?: string[];
    excludedAudiences?: string[];
    interests?: string[];
    advantageAudience?: boolean;
    /** 'retargeting' if it includes custom audiences of past visitors/buyers, 'interest', 'broad', 'lookalike' */
    audienceType?: string;
  } | null;
  @Prop({ default: '' }) learningStage: string;
  /** learning_stage_info.last_sig_edit_ts: the last edit that reset learning. */
  @Prop({ type: Date, default: null }) lastSigEditTs: Date | null;
  /** learning_stage_info.conversions: conversions counted toward leaving learning. */
  @Prop({ type: Number, default: null }) learningConversions: number | null;
  // ad
  @Prop({ type: Object, default: null })
  creative: {
    id?: string;
    title?: string;
    body?: string;
    cta?: string;
    linkUrl?: string;
    imageUrl?: string;
    thumbnailUrl?: string;
    videoId?: string;
    objectType?: string;
  } | null;
}
export type PmMetaEntityDocument = HydratedDocument<PmMetaEntity>;
export const PmMetaEntitySchema = SchemaFactory.createForClass(PmMetaEntity);
PmMetaEntitySchema.index(
  { tenantId: 1, level: 1, entityId: 1 },
  { unique: true },
);
PmMetaEntitySchema.index({ tenantId: 1, product: 1, level: 1 });

/** Shared metric block for daily rows. */
class PmMetaMetrics {
  @Prop({ default: 0 }) spend: number;
  @Prop({ default: 0 }) impressions: number;
  /** Not additive across days or entities — never sum it. */
  @Prop({ default: 0 }) reach: number;
  @Prop({ default: 0 }) frequency: number;
  @Prop({ default: 0 }) clicks: number;
  @Prop({ default: 0 }) linkClicks: number;
  @Prop({ default: 0 }) landingPageViews: number;
  @Prop({ default: 0 }) metaAddToCart: number;
  @Prop({ default: 0 }) metaInitiateCheckout: number;
  @Prop({ default: 0 }) metaPurchases: number;
  @Prop({ default: 0 }) metaPurchaseValue: number;
}

/** One row per ad per account day. */
@Schema({ collection: 'pm_meta_daily', timestamps: true })
export class PmMetaDaily extends PmMetaMetrics {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) accountId: string;
  /** YYYY-MM-DD, account timezone (IST) */
  @Prop({ required: true }) date: string;
  @Prop({ required: true }) adId: string;
  @Prop({ default: '' }) adsetId: string;
  @Prop({ default: '' }) campaignId: string;
  @Prop({ default: 'other' }) product: PmProductTag;
  @Prop({ default: 0 }) videoPlays3s: number;
  @Prop({ default: 0 }) thruPlays: number;
  /** Every action type Meta returned: count and value. */
  @Prop({ type: Object, default: {} }) actions: Record<string, number>;
  @Prop({ type: Object, default: {} }) actionValues: Record<string, number>;
}
export type PmMetaDailyDocument = HydratedDocument<PmMetaDaily>;
export const PmMetaDailySchema = SchemaFactory.createForClass(PmMetaDaily);
PmMetaDailySchema.index({ tenantId: 1, adId: 1, date: 1 }, { unique: true });
PmMetaDailySchema.index({ tenantId: 1, product: 1, date: 1 });
PmMetaDailySchema.index({ tenantId: 1, campaignId: 1, date: 1 });
PmMetaDailySchema.index({ tenantId: 1, adsetId: 1, date: 1 });

export type PmBreakdown = 'region' | 'age_gender' | 'placement' | 'device';

/** One row per ad set × account day × breakdown value (kept by date, never overwritten). */
@Schema({ collection: 'pm_meta_breakdowns', timestamps: true })
export class PmMetaBreakdown extends PmMetaMetrics {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) accountId: string;
  @Prop({ required: true }) date: string;
  @Prop({ required: true }) adsetId: string;
  @Prop({ default: '' }) campaignId: string;
  @Prop({ default: 'other' }) product: PmProductTag;
  @Prop({ required: true }) breakdown: PmBreakdown;
  /** e.g. 'Karnataka' | 'female|25-34' | 'instagram|instagram_reels' | 'mobile_app' */
  @Prop({ required: true }) key: string;
}
export type PmMetaBreakdownDocument = HydratedDocument<PmMetaBreakdown>;
export const PmMetaBreakdownSchema =
  SchemaFactory.createForClass(PmMetaBreakdown);
PmMetaBreakdownSchema.index(
  { tenantId: 1, adsetId: 1, date: 1, breakdown: 1, key: 1 },
  { unique: true },
);
PmMetaBreakdownSchema.index({ tenantId: 1, product: 1, breakdown: 1, date: 1 });

/** Meta's activity log: edits to budgets, status, targeting, creatives. */
@Schema({ collection: 'pm_meta_changes', timestamps: true })
export class PmMetaChange {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) accountId: string;
  @Prop({ required: true }) eventTime: Date;
  @Prop({ default: '' }) eventType: string;
  @Prop({ default: '' }) translatedEventType: string;
  @Prop({ default: '' }) objectType: string;
  @Prop({ default: '' }) objectId: string;
  @Prop({ default: '' }) objectName: string;
  @Prop({ default: '' }) actorName: string;
  @Prop({ default: '' }) actorId: string;
  /** Set when the edit came from an app (e.g. an automated rule), not Ads Manager. */
  @Prop({ default: '' }) applicationName: string;
  /** Meta's extra_data (old/new values), truncated. */
  @Prop({ default: '' }) extraData: string;
  /** Parsed from extra_data (meta.logic parseExtraData); budgets in rupees. */
  @Prop({ default: '' }) field: string;
  @Prop({ type: Object, default: null }) oldValue: string | number | null;
  @Prop({ type: Object, default: null }) newValue: string | number | null;
  /** The changed object's campaign / ad set ('' when not in pm_meta_entities yet). */
  @Prop({ default: '' }) campaignId: string;
  @Prop({ default: '' }) adsetId: string;
  /** Stable id for de-duplication. */
  @Prop({ required: true }) key: string;
}
export type PmMetaChangeDocument = HydratedDocument<PmMetaChange>;
export const PmMetaChangeSchema = SchemaFactory.createForClass(PmMetaChange);
PmMetaChangeSchema.index({ tenantId: 1, key: 1 }, { unique: true });
PmMetaChangeSchema.index({ tenantId: 1, eventTime: -1 });
PmMetaChangeSchema.index({ tenantId: 1, objectId: 1, eventTime: -1 });
PmMetaChangeSchema.index({ tenantId: 1, campaignId: 1, eventTime: -1 });

/**
 * Account-level daily totals straight from Meta (level=account). The check
 * that ad-level rows are complete: a day whose ad rows don't add up to this
 * total (e.g. one account's sync failed, or deleted ads were not returned) is
 * treated as missing data by the analysis, never as low spend.
 */
@Schema({ collection: 'pm_meta_account_daily', timestamps: true })
export class PmMetaAccountDaily {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) accountId: string;
  /** YYYY-MM-DD, account timezone (IST) */
  @Prop({ required: true }) date: string;
  @Prop({ default: 0 }) spend: number;
  @Prop({ default: 0 }) impressions: number;
  /** When this day was last fetched successfully. */
  @Prop({ required: true }) syncedAt: Date;
}
export type PmMetaAccountDailyDocument = HydratedDocument<PmMetaAccountDaily>;
export const PmMetaAccountDailySchema =
  SchemaFactory.createForClass(PmMetaAccountDaily);
PmMetaAccountDailySchema.index(
  { tenantId: 1, accountId: 1, date: 1 },
  { unique: true },
);

/**
 * Days a partial sync covered, where the data itself can't tell "synced, no
 * rows" from "never synced": `campaign:<id>` = that campaign's ad rows
 * (campaign-only insights, no account total), `changes:<accountId>` = the
 * account's change log.
 */
@Schema({ collection: 'pm_sync_coverage', timestamps: true })
export class PmSyncCoverage {
  @Prop({ required: true }) tenantId: string;
  @Prop({ required: true }) key: string;
  @Prop({ type: [String], default: [] }) days: string[];
}
export const PmSyncCoverageSchema =
  SchemaFactory.createForClass(PmSyncCoverage);
PmSyncCoverageSchema.index({ tenantId: 1, key: 1 }, { unique: true });
