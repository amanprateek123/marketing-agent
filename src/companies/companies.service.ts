import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { Company, CompanyDocument } from './schemas/company.schema';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { CompanyPrompts, CompanyLearnings, CreativeLearnings, CampaignLearnings, CausalInsight, OfferAudienceFitIssue, HotWinner } from './schemas/company.types';

// Fields that require prompt regeneration when changed
const PROMPT_RELEVANT_FIELDS: (keyof UpdateCompanyDto)[] = [
  'tone',
  'targetAudience',
  'audiencePersonas',
  'competitors',
  'brandGuidelines',
  'products',
  'services',
  'uniqueValue',
  'industry',
  'geography',
];

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(
    @InjectModel(Company.name)
    private readonly companyModel: Model<CompanyDocument>,
  ) {}

  async create(dto: CreateCompanyDto): Promise<CompanyDocument> {
    const existing = await this.companyModel.findOne({ tenantId: dto.tenantId });
    if (existing) {
      throw new ConflictException(`Company with tenantId "${dto.tenantId}" already exists`);
    }

    const company = await this.companyModel.create({
      ...(dto as any),
      apiKey: uuidv4(),
      prompts: null,
      learnings: null,
    });

    this.logger.log(`Created company: ${company.tenantId}`);
    return company;
  }

  async findAll(): Promise<CompanyDocument[]> {
    // Exclude prompts and learnings from list view
    return this.companyModel
      .find()
      .select('-prompts -learnings')
      .lean()
      .exec() as unknown as CompanyDocument[];
  }

  async findByTenantId(tenantId: string): Promise<CompanyDocument> {
    const company = await this.companyModel.findOne({ tenantId }).exec();
    if (!company) {
      throw new NotFoundException(`Company "${tenantId}" not found`);
    }
    return company;
  }

  async update(
    tenantId: string,
    dto: UpdateCompanyDto,
  ): Promise<{ company: CompanyDocument; needsPromptRegen: boolean }> {
    const company = await this.findByTenantId(tenantId);

    const needsPromptRegen = PROMPT_RELEVANT_FIELDS.some(
      (field) => field in dto,
    );

    const { meta, pipelineConfig, ...rest } = dto as any;
    Object.assign(company, rest);

    // Merge meta fields instead of replacing — prevents wiping accessToken when only updating pixelId
    if (meta) {
      company.meta = { ...(company.meta ?? {}), ...meta } as any;
    }

    // Merge pipelineConfig — prevents wiping unrelated pipeline settings
    if (pipelineConfig) {
      company.pipelineConfig = { ...(company.pipelineConfig ?? {}), ...pipelineConfig } as any;
    }

    // Mongoose doesn't auto-detect changes to Mixed/[Object] fields — mark them explicitly
    if ('products' in dto) company.markModified('products');
    if ('services' in dto) company.markModified('services');
    if ('activePromotions' in dto) company.markModified('activePromotions');
    if ('meta' in dto) company.markModified('meta');
    if ('pipelineConfig' in dto) company.markModified('pipelineConfig');

    await company.save();

    this.logger.log(
      `Updated company: ${tenantId} | promptRegen: ${needsPromptRegen}`,
    );

    return { company, needsPromptRegen };
  }

  async updatePrompts(tenantId: string, prompts: CompanyPrompts): Promise<void> {
    // Use dot-notation to merge individual keys — avoids wiping optional fields
    // (e.g. intelligenceLead) that aren't part of the current generation batch
    const dotSet: Record<string, string> = {};
    for (const [key, value] of Object.entries(prompts)) {
      dotSet[`prompts.${key}`] = value;
    }
    await this.companyModel.updateOne({ tenantId }, { $set: dotSet });
    this.logger.log(`Prompts updated for: ${tenantId}`);
  }

  /**
   * Whole-tree replacement of learnings. Kept for backward compat but DEPRECATED
   * for concurrent-writer paths — every audit + Day-7 quick scan + Day-30 deep
   * run + Meta importer used to read learnings, splice in their slice, and
   * write the whole tree back. Concurrent writers clobbered each other and
   * `version` could even go backwards. New code MUST use the granular setters
   * below: setCreativeLearningSlice, setCampaignLearningSlice, appendCausalInsight,
   * setTopicScores. This method now serves only first-write seeding.
   */
  async updateLearnings(tenantId: string, learnings: CompanyLearnings): Promise<void> {
    await this.companyModel.updateOne({ tenantId }, { $set: { learnings } });
    this.logger.log(`Learnings updated for: ${tenantId} (v${learnings.version})`);
  }

  /**
   * Patch a subset of learnings.creative via per-leaf-field dot-paths. Two
   * concurrent writers updating different fields no longer clobber each other.
   * Caller passes only the fields it owns; absent fields are left untouched.
   * Increments learnings.version atomically via $inc when incrementVersion=true.
   */
  async setCreativeLearningSlice(
    tenantId: string,
    slice: Partial<CreativeLearnings>,
    options: { incrementVersion?: boolean } = {},
  ): Promise<void> {
    const dotSet: Record<string, unknown> = {
      'learnings.updatedAt': new Date(),
    };
    for (const [key, value] of Object.entries(slice)) {
      if (value === undefined) continue;
      dotSet[`learnings.creative.${key}`] = value;
    }
    const update: any = { $set: dotSet };
    if (options.incrementVersion) {
      update.$inc = { 'learnings.version': 1 };
    }
    await this.companyModel.updateOne({ tenantId }, update);
    this.logger.log(`Creative learnings sliced for: ${tenantId} (${Object.keys(slice).join(',')})`);
  }

  /**
   * Patch a subset of learnings.campaign via per-leaf-field dot-paths.
   * Same race-safety guarantees as setCreativeLearningSlice.
   */
  async setCampaignLearningSlice(
    tenantId: string,
    slice: Partial<CampaignLearnings>,
    options: { incrementVersion?: boolean } = {},
  ): Promise<void> {
    const dotSet: Record<string, unknown> = {
      'learnings.updatedAt': new Date(),
    };
    for (const [key, value] of Object.entries(slice)) {
      if (value === undefined) continue;
      dotSet[`learnings.campaign.${key}`] = value;
    }
    const update: any = { $set: dotSet };
    if (options.incrementVersion) {
      update.$inc = { 'learnings.version': 1 };
    }
    await this.companyModel.updateOne({ tenantId }, update);
    this.logger.log(`Campaign learnings sliced for: ${tenantId} (${Object.keys(slice).join(',')})`);
  }

  /**
   * Append a causal insight with $push + $slice cap. Race-safe — two concurrent
   * appenders both succeed; oldest is dropped past the cap. Was: read the array,
   * concat, write — concurrent appenders lost each other's insights.
   *
   * Prefer appendOrConsolidateCausalInsight() — it dedupes near-identical
   * findings into one growing-confidence entry instead of accumulating
   * 6 N=1 lookalikes that say the same thing.
   */
  async appendCausalInsight(
    tenantId: string,
    insight: CausalInsight,
    cap: number = 25,
  ): Promise<void> {
    await this.companyModel.updateOne(
      { tenantId },
      {
        $push: {
          'learnings.causalInsights': { $each: [insight], $slice: -cap },
        },
        $set: { 'learnings.updatedAt': new Date() },
        $inc: { 'learnings.version': 1 },
      },
    );
    this.logger.log(`Causal insight appended for: ${tenantId} (${insight.rootCause}, conf=${insight.confidence})`);
  }

  /**
   * Append OR consolidate a causal insight into an existing cluster.
   *
   * Why this exists: runRootCauseAnalysis produces one N=1 insight per paused
   * campaign. For brands running 5+ campaigns/week on the same product, the
   * causalInsights array filled up with 6+ near-identical findings (rootCause=
   * audience_mismatch, isolatedVariable=post_click_conversion_rate, product=
   * Nadi Report, confidence=0.45 each). The agent reading these as inputs
   * couldn't distinguish "one shaky observation" from "six convergent ones."
   *
   * Cluster key: (rootCause × normalized(isolatedVariable) × productName).
   * Recency window: 90 days. If an existing entry in the same cluster is
   * found, this method REPLACES it with a merged entry that:
   *   - sums dataPoints
   *   - boosts confidence as min(0.85, 0.5 + 0.05 * N)
   *   - keeps the newest `finding` text (most recent observation wins narration)
   *   - tracks firstSeenAt / lastSeenAt
   * Otherwise it appends a fresh entry (read-replace pattern; we accept the
   * small race window because dedup is more valuable than strict append-only
   * race-safety for this writer — concurrent root-cause runs on the SAME
   * tenant are rare and re-merging is idempotent).
   */
  async appendOrConsolidateCausalInsight(
    tenantId: string,
    insight: CausalInsight,
    cap: number = 25,
  ): Promise<void> {
    const company = await this.companyModel.findOne({ tenantId }, { 'learnings.causalInsights': 1 }).lean().exec();
    const existing: CausalInsight[] = (company?.learnings?.causalInsights ?? []) as any;
    const RECENCY_DAYS = 90;
    const cutoff = Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000;

    const normVar = (s: string | undefined) =>
      (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const incomingKey = `${insight.rootCause}|${normVar(insight.isolatedVariable)}|${insight.productName ?? ''}`;

    const now = new Date();
    let merged: CausalInsight[] = [];
    let consolidated = false;

    for (const e of existing) {
      const eKey = `${e.rootCause}|${normVar(e.isolatedVariable)}|${e.productName ?? ''}`;
      const eTime = e.lastSeenAt ? new Date(e.lastSeenAt).getTime() : (e.firstSeenAt ? new Date(e.firstSeenAt).getTime() : Date.now());
      const inWindow = eTime >= cutoff;
      if (eKey === incomingKey && inWindow && !consolidated) {
        const totalN = (e.dataPoints ?? 1) + (insight.dataPoints ?? 1);
        const confidenceFromN = Math.min(0.85, 0.5 + 0.05 * totalN);
        merged.push({
          ...insight,
          dataPoints: totalN,
          confidence: Math.max(insight.confidence ?? 0, confidenceFromN),
          firstSeenAt: e.firstSeenAt ?? now,
          lastSeenAt: now,
        });
        consolidated = true;
      } else {
        merged.push(e);
      }
    }

    if (!consolidated) {
      merged.push({ ...insight, firstSeenAt: now, lastSeenAt: now });
    }

    // Cap newest-N (oldest dropped first). Mongo's $slice -N is positional —
    // we're rewriting wholesale so do it here.
    if (merged.length > cap) merged = merged.slice(merged.length - cap);

    await this.companyModel.updateOne(
      { tenantId },
      {
        $set: {
          'learnings.causalInsights': merged,
          'learnings.updatedAt': now,
        },
        $inc: { 'learnings.version': 1 },
      },
    );
    this.logger.log(
      `Causal insight ${consolidated ? 'consolidated' : 'appended'} for: ${tenantId} (${insight.rootCause}/${normVar(insight.isolatedVariable)}, total=${merged.length})`,
    );
  }

  /**
   * Upsert a HotWinner keyed by metaAdId. Caps the array at MAX_HOT_WINNERS
   * (evicting the entry with the highest CPA — i.e. the weakest winner).
   * Decay (60d) is enforced at READ time by LiveContextBuilder so we never
   * have to scan/rewrite the array just to age out an entry.
   *
   * Why metaAdId is the cluster key: each ad is the unit of winning. An ad
   * set can contain a winner + 3 losers (see Kundli Clarity), and we want
   * to keep the winner without flagging the whole ad set.
   */
  async upsertHotWinner(tenantId: string, winner: HotWinner): Promise<void> {
    const MAX_HOT_WINNERS = 10;
    const company = await this.companyModel.findOne(
      { tenantId },
      { 'learnings.hotWinners': 1 },
    ).lean().exec();
    const existing: HotWinner[] = ((company?.learnings as any)?.hotWinners ?? []) as HotWinner[];

    let merged = false;
    let next: HotWinner[] = existing.map((e) => {
      if (e.metaAdId === winner.metaAdId) {
        merged = true;
        // Replace with the latest snapshot — same ad, fresher metrics.
        return { ...e, ...winner };
      }
      return e;
    });
    if (!merged) next.push(winner);

    // Cap by evicting the highest-CPA entry (weakest winner first).
    if (next.length > MAX_HOT_WINNERS) {
      next = next
        .slice()
        .sort((a, b) => a.cpa - b.cpa)
        .slice(0, MAX_HOT_WINNERS);
    }

    await this.companyModel.updateOne(
      { tenantId },
      {
        $set: {
          'learnings.hotWinners': next,
          'learnings.updatedAt': new Date(),
        },
      },
    );
    this.logger.log(
      `HotWinner ${merged ? 'updated' : 'added'} for: ${tenantId} (adId=${winner.metaAdId} hook=${winner.hookStyle}/${winner.audienceType} CPA=₹${Math.round(winner.cpa)} ROAS=${winner.roas.toFixed(2)})`,
    );
  }

  /**
   * Upsert an OfferAudienceFitIssue keyed by (audienceType × productName).
   * Used by the campaign learning loop when a causal insight points to
   * post-click friction rather than a true audience-quality problem. Keeps
   * the audienceScores table clean from offer-fit contamination.
   */
  async upsertOfferAudienceFitIssue(
    tenantId: string,
    entry: OfferAudienceFitIssue,
  ): Promise<void> {
    const company = await this.companyModel.findOne(
      { tenantId },
      { 'learnings.campaign.offerAudienceFitIssues': 1 },
    ).lean().exec();
    const existing: OfferAudienceFitIssue[] = ((company?.learnings as any)?.campaign?.offerAudienceFitIssues ?? []);
    let merged = false;
    const next = existing.map((e) => {
      if (e.audienceType === entry.audienceType && e.productName === entry.productName) {
        merged = true;
        return {
          ...e,
          issue: entry.issue,                         // latest narration wins
          dataPoints: (e.dataPoints ?? 0) + (entry.dataPoints ?? 1),
          lastUpdated: entry.lastUpdated,
        };
      }
      return e;
    });
    if (!merged) next.push(entry);

    await this.companyModel.updateOne(
      { tenantId },
      {
        $set: {
          'learnings.campaign.offerAudienceFitIssues': next,
          'learnings.updatedAt': new Date(),
        },
      },
    );
    this.logger.log(
      `OfferAudienceFitIssue ${merged ? 'updated' : 'added'} for: ${tenantId} (${entry.audienceType}/${entry.productName})`,
    );
  }

  /**
   * Replace topicScores map atomically. Single-leaf write — race-safe.
   */
  async setTopicScores(tenantId: string, topicScores: Record<string, number>): Promise<void> {
    await this.companyModel.updateOne(
      { tenantId },
      {
        $set: {
          'learnings.topicScores': topicScores,
          'learnings.updatedAt': new Date(),
        },
      },
    );
  }

  /**
   * Replace causalInsights wholesale (deep-run path rebuilds the full list).
   * For incremental appends use appendCausalInsight. Bumps version.
   */
  async replaceCausalInsights(tenantId: string, insights: CausalInsight[]): Promise<void> {
    await this.companyModel.updateOne(
      { tenantId },
      {
        $set: {
          'learnings.causalInsights': insights,
          'learnings.updatedAt': new Date(),
        },
        $inc: { 'learnings.version': 1 },
      },
    );
  }

  async updateProductAudiences(tenantId: string, productName: string, audiences: any[]): Promise<void> {
    await this.companyModel.updateOne(
      { tenantId, 'products.name': productName },
      { $set: { 'products.$.metaAudiences': audiences } },
    );
  }

  async updateCreativeLearnings(tenantId: string, creative: {
    ctaInsights: string[];
    copyToneInsights: string[];
    visualInsights: string[];
  }): Promise<void> {
    await this.companyModel.updateOne(
      { tenantId },
      {
        $set: {
          'learnings.creative.ctaInsights': creative.ctaInsights,
          'learnings.creative.copyToneInsights': creative.copyToneInsights,
          'learnings.creative.visualInsights': creative.visualInsights,
        },
      },
    );
    this.logger.log(`Creative copy insights updated for: ${tenantId}`);
  }

  /**
   * Persist hook-saturation map (audienceType → hookStyle → {pct, updatedAt}).
   * Updated by audit loop after every signal-detector pass; consumed by
   * Strategy Team + Creative Team to avoid generating saturated hookStyles
   * for the target audience. Per-entry timestamps enable downstream decay
   * filtering — readers drop entries older than ~14 days.
   */
  async updateHookSaturation(
    tenantId: string,
    audienceHookSaturation: Record<string, Record<string, { pct: number; updatedAt: Date }>>,
  ): Promise<void> {
    await this.companyModel.updateOne(
      { tenantId },
      {
        $set: {
          'learnings.creative.audienceHookSaturation': audienceHookSaturation,
          'learnings.creative.audienceHookSaturationUpdatedAt': new Date(),
        },
      },
    );
  }

  async findByApiKey(apiKey: string): Promise<CompanyDocument | null> {
    return this.companyModel.findOne({ apiKey }).exec();
  }

  /**
   * Bump promptsVersion + append a snapshot to promptsHistory (capped at 5).
   * Called by prompt-generator after a successful regen. The snapshot lets us
   * roll back without re-running the generator if a new version underperforms.
   */
  async bumpPromptsVersionAndPushHistory(tenantId: string, prompts: CompanyPrompts): Promise<number> {
    const company = await this.companyModel.findOne({ tenantId }).select('promptsVersion').lean().exec();
    const currentVersion = (company as any)?.promptsVersion ?? 1;
    const newVersion = currentVersion + 1;
    await this.companyModel.updateOne(
      { tenantId },
      {
        $set: { promptsVersion: newVersion },
        $push: {
          promptsHistory: {
            $each: [{
              version: newVersion,
              prompts,
              generatedAt: new Date(),
              learningVersion: 0,  // populated downstream from learnings.version
            }],
            $slice: -5,
          },
        },
      },
    );
    this.logger.log(`Prompts versioned: ${tenantId} → v${newVersion}`);
    return newVersion;
  }

  /**
   * Roll back to a prior promptsHistory entry. Restores the snapshotted prompts
   * to company.prompts but does NOT decrement promptsVersion — instead it
   * creates a new version cloned from the target. Audit-friendly: every change
   * to live prompts is a forward step.
   */
  async rollbackPromptsToVersion(tenantId: string, targetVersion: number): Promise<number> {
    const company = await this.companyModel.findOne({ tenantId }).select('promptsHistory promptsVersion').lean().exec();
    if (!company) throw new NotFoundException(`Company ${tenantId} not found`);
    const history = (company as any).promptsHistory ?? [];
    const target = history.find((h: any) => h.version === targetVersion);
    if (!target) throw new NotFoundException(`Prompts version ${targetVersion} not in history (have: ${history.map((h: any) => h.version).join(',')})`);
    return this.bumpPromptsVersionAndPushHistory(tenantId, target.prompts);
  }
}
