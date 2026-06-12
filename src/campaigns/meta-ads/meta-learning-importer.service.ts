import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Model, Types } from 'mongoose';
import { Queue } from 'bullmq';
import axios from 'axios';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CampaignCaseStudy as CaseStudyModel, CampaignCaseStudyDocument } from '../schemas/campaign-case-study.schema';
import { MetaLearningImport, MetaLearningImportDocument } from '../schemas/meta-learning-import.schema';
import { EnrichedCampaign, EnrichedCampaignDocument } from '../schemas/enriched-campaign.schema';
import { PatternCalculatorService } from './pattern-calculator.service';
import { CampaignSyncService } from './campaign-sync.service';
import { extractConversions } from './conversion-extractor.util';
import { inferFormatFromCreative as sharedInferFormatFromCreative } from '../../common/creative/hook-inference.util';
import { CompaniesService } from '../../companies/companies.service';
import { QUEUES } from '../../scheduler/queue.constants';

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

const BATCH_SIZE = 50;
const LOOKBACK_DAYS = 365; // 1 year of historical data

export interface CampaignCaseStudy {
  campaignName: string;
  product: string;
  dateRange: string;
  durationDays: number;
  totalSpend: number;
  totalConversions: number;
  context: string;
  whatWorked: {
    hooks: string[];
    audiences: string[];
    formats: string[];
    bestCPA: number;
    bestROAS: number;
  };
  whatFailed: {
    hooks: string[];
    audiences: string[];
    reason: string;
  };
  lesson: string;
}

/**
 * Meta Learning Importer — pulls historical campaign data from Meta,
 * generates case studies per campaign, stores them for agent context.
 *
 * Queue-based flow:
 * 1. startImport() — fetches campaigns from Meta, filters, splits into batches, queues jobs
 * 2. processEnrichBatch() — enriches a batch of campaigns, saves to DB
 * 3. finalizeImport() — calculates patterns + generates case studies
 *
 * Each step is a separate BullMQ job so failures don't kill the whole import.
 */
@Injectable()
export class MetaLearningImporterService {
  private readonly logger = new Logger(MetaLearningImporterService.name);

  constructor(
    private readonly claudeService: ClaudeService,
    private readonly patternCalculator: PatternCalculatorService,
    private readonly companiesService: CompaniesService,
    private readonly campaignSync: CampaignSyncService,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(CaseStudyModel.name)
    private readonly caseStudyModel: Model<CampaignCaseStudyDocument>,
    @InjectModel(MetaLearningImport.name)
    private readonly importModel: Model<MetaLearningImportDocument>,
    @InjectModel(EnrichedCampaign.name)
    private readonly enrichedCampaignModel: Model<EnrichedCampaignDocument>,
    @InjectQueue(QUEUES.META_LEARNING_IMPORT)
    private readonly importQueue: Queue,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Start a new learning import. Returns immediately after queuing batch jobs.
   * Call from controller or scheduler.
   */
  async startImport(
    company: CompanyDocument,
  ): Promise<{ importId: string; totalCampaigns: number; totalBatches: number }> {
    const tenantId = company.tenantId;

    if (!company.meta?.accessToken || !company.meta?.accountId) {
      throw new Error('Meta credentials not configured');
    }

    // Cancel any in-progress import for this tenant
    await this.importModel.updateMany(
      { tenantId, status: { $in: ['pending', 'enriching'] } },
      { status: 'failed', error: 'Cancelled — new import started' },
    );

    this.logger.log(`Starting Meta learning import for tenant: ${tenantId}`);
    const { accessToken } = company.meta!;

    // Support multiple ad accounts — fall back to single accountId if accountIds not set
    // Normalize: Meta API requires act_ prefix on account IDs
    const normalizeAccountId = (id: string) => id.startsWith('act_') ? id : `act_${id}`;
    const rawAccountIds = (company.meta!.accountIds?.length ?? 0) > 0
      ? company.meta!.accountIds!
      : [company.meta!.accountId];
    const accountIds = rawAccountIds.map(normalizeAccountId);

    this.logger.log(`Importing from ${accountIds.length} Meta account(s): ${accountIds.join(', ')}`);

    // Step 1: Fetch conversion types — only needed once (pixel is shared across accounts)
    const { conversionTypes, customConversions } = await this.fetchConversionData(accountIds[0], accessToken);
    this.logger.log(`Conversion types: ${[...conversionTypes].join(', ')}`);

    // Step 2: Pull campaigns from ALL accounts in parallel
    const rawCampaignArrays = await Promise.all(
      accountIds.map(id => this.pullAllCampaigns(id, accessToken)),
    );
    const rawCampaigns = rawCampaignArrays.flat();
    this.logger.log(`Pulled ${rawCampaigns.length} campaigns across ${accountIds.length} accounts`);

    if (rawCampaigns.length === 0) {
      return { importId: '', totalCampaigns: 0, totalBatches: 0 };
    }

    // Step 3: Bulk-fetch spends from ALL accounts in parallel, merge into one map
    const spendMaps = await Promise.all(
      accountIds.map(id => this.fetchCampaignSpends(id, accessToken)),
    );
    const spendMap = new Map<string, number>();
    for (const m of spendMaps) {
      for (const [k, v] of m) spendMap.set(k, v);
    }

    const campaignsWithSpend = rawCampaigns
      .filter(c => (spendMap.get(c.id) ?? 0) > 500)
      .sort((a, b) => (spendMap.get(b.id) ?? 0) - (spendMap.get(a.id) ?? 0));

    this.logger.log(`Filtered to ${campaignsWithSpend.length} campaigns with spend > ₹500`);

    if (campaignsWithSpend.length === 0) {
      return { importId: '', totalCampaigns: 0, totalBatches: 0 };
    }

    // Step 4: Create import record + queue batch jobs
    const totalBatches = Math.ceil(campaignsWithSpend.length / BATCH_SIZE);

    const importDoc = await this.importModel.create({
      tenantId,
      status: 'enriching',
      totalCampaigns: campaignsWithSpend.length,
      totalBatches,
      completedBatches: 0,
      enrichedCount: 0,
      caseStudyCount: 0,
      conversionTypes: [...conversionTypes],
      customConversions,
      rawCampaigns: campaignsWithSpend,
      startedAt: new Date(),
    });

    // Clean up previous enriched campaigns for this tenant
    await this.enrichedCampaignModel.deleteMany({ tenantId });

    // Queue batch jobs with staggered delays (10s apart)
    for (let i = 0; i < totalBatches; i++) {
      await this.importQueue.add(
        `enrich-batch-${tenantId}`,
        { tenantId, importId: importDoc._id.toString(), batchIndex: i },
        {
          delay: i * 10_000, // stagger batches 10s apart
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    }

    this.logger.log(`Queued ${totalBatches} enrich batches for import ${importDoc._id}`);

    return {
      importId: importDoc._id.toString(),
      totalCampaigns: campaignsWithSpend.length,
      totalBatches,
    };
  }

  /**
   * Process a single enrich batch. Called by the queue processor.
   */
  async processEnrichBatch(importId: string, batchIndex: number): Promise<void> {
    const importDoc = await this.importModel.findById(importId).exec();
    if (!importDoc) throw new Error(`Import ${importId} not found`);
    if (importDoc.status === 'failed') {
      this.logger.warn(`Import ${importId} already failed — skipping batch ${batchIndex}`);
      return;
    }

    const tenantId = importDoc.tenantId;
    const company = await this.companiesService.findByTenantId(tenantId);
    const { accessToken } = company.meta!;
    const conversionTypes = new Set(importDoc.conversionTypes);

    // Slice this batch's campaigns
    const start = batchIndex * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, importDoc.rawCampaigns.length);
    const batchCampaigns = importDoc.rawCampaigns.slice(start, end);

    this.logger.log(
      `Batch ${batchIndex + 1}/${importDoc.totalBatches}: enriching campaigns ${start + 1}-${end} for ${tenantId}`,
    );

    // Enrich campaigns — concurrent batches of 8
    const enrichedCampaigns: any[] = [];
    const CONCURRENCY = 8;
    for (let i = 0; i < batchCampaigns.length; i += CONCURRENCY) {
      const chunk = batchCampaigns.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(c => this.enrichCampaign(c, accessToken, conversionTypes)),
      );
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          enrichedCampaigns.push(result.value);
        }
      }
      if (i + CONCURRENCY < batchCampaigns.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Save enriched campaigns to DB (strip the Set — can't store in MongoDB)
    if (enrichedCampaigns.length > 0) {
      await this.enrichedCampaignModel.insertMany(
        enrichedCampaigns.map(c => ({
          tenantId,
          importId: new Types.ObjectId(importId),
          campaignId: c.id,
          data: { ...c, conversionTypes: [...(c.conversionTypes ?? [])] },
        })),
      );
    }

    // Atomically update progress
    const updated = await this.importModel.findOneAndUpdate(
      { _id: importId },
      {
        $inc: { completedBatches: 1, enrichedCount: enrichedCampaigns.length },
      },
      { new: true },
    ).exec();

    this.logger.log(
      `Batch ${batchIndex + 1} done: ${enrichedCampaigns.length} enriched. Progress: ${updated!.completedBatches}/${updated!.totalBatches}`,
    );

    // If this was the last batch, queue finalize
    if (updated!.completedBatches >= updated!.totalBatches) {
      await this.importQueue.add(
        `finalize-${tenantId}`,
        { tenantId, importId },
        { attempts: 2, backoff: { type: 'fixed', delay: 10000 } },
      );
      this.logger.log(`All batches complete — queued finalize for import ${importId}`);
    }
  }

  /**
   * Finalize: calculate patterns + generate case studies from all enriched data.
   */
  async finalizeImport(importId: string): Promise<void> {
    // Atomic claim — only proceed if status is NOT already finalizing or completed.
    // Prevents duplicate runs when BullMQ retries the finalize job. STALE-CLAIM
    // ESCAPE: a finalize that crashed mid-run leaves status='finalizing' forever
    // and every retry no-ops — so a 'finalizing' claim older than 45 min (no
    // updatedAt progress) is treated as dead and reclaimable. Without this, a
    // single crashed finalize made the import permanently unrecoverable.
    const STALE_FINALIZING_MS = 45 * 60 * 1000;
    const staleCutoff = new Date(Date.now() - STALE_FINALIZING_MS);
    const importDoc = await this.importModel.findOneAndUpdate(
      {
        _id: importId,
        $or: [
          { status: { $nin: ['finalizing', 'completed'] } },
          { status: 'finalizing', updatedAt: { $lt: staleCutoff } },
        ],
      },
      { $set: { status: 'finalizing' } },
      { new: true },
    ).exec();

    if (!importDoc) {
      this.logger.log(`Import ${importId} already finalizing/completed — skipping duplicate finalize`);
      return;
    }

    const tenantId = importDoc.tenantId;
    this.logger.log(`Finalizing import ${importId} for ${tenantId}`);

    const company = await this.companiesService.findByTenantId(tenantId);
    const conversionTypes = new Set(importDoc.conversionTypes);

    // Load all enriched campaigns from DB
    const enrichedDocs = await this.enrichedCampaignModel
      .find({ importId: new Types.ObjectId(importId) })
      .lean()
      .exec();

    const products = (company.products ?? []).filter(p => p.active).map(p => ({
      name: p.name,
      price: p.price,
    }));
    const customConversions: { id: string; name: string }[] = (importDoc as any).customConversions ?? [];

    // Restore conversionTypes + detect product for each campaign
    const enrichedCampaigns = enrichedDocs.map(d => {
      const campaign = { ...d.data, conversionTypes };
      campaign.detectedProduct = this.detectProduct(campaign, customConversions, products);
      return campaign;
    });

    this.logger.log(`Loaded ${enrichedCampaigns.length} enriched campaigns for pattern calculation`);
    this.logger.log(
      `Product breakdown: ${[...new Set(enrichedCampaigns.map(c => c.detectedProduct))].join(', ')}`,
    );

    // Calculate statistical patterns

    const productPatterns = this.patternCalculator.calculatePatterns(enrichedCampaigns, products, conversionTypes);

    // Save patterns to company.learnings (race-safe per-slice writes).
    // Hook ranking now uses Wilson lower bound (lowerCTR) + min-ad-count +
    // min-impression floor — same statistical guards as Day-7 quick scan.
    // Was: raw avgCTR sort which could crown 1-ad outliers. Format ranking
    // still uses conversionShare since formats have low cardinality (4-5).
    if (productPatterns.length > 0) {
      const bestPattern = productPatterns[0];
      const HOOK_MIN_ADS = 5;
      const HOOK_MIN_IMPS = 1500;
      const eligibleHooks = bestPattern.hookPerformance.filter(
        h => h.style !== 'unknown' && h.adCount >= HOOK_MIN_ADS && h.totalImpressions >= HOOK_MIN_IMPS,
      );
      const sortedByLB = [...eligibleHooks].sort((a, b) => b.lowerCTR - a.lowerCTR);
      const winningHooks = sortedByLB
        .slice(0, 3)
        .map(h => `${h.style} (LB ${h.lowerCTR.toFixed(2)}% / mean ${h.avgCTR.toFixed(2)}% CTR, ${h.adCount} ads, ${h.totalImpressions.toLocaleString()} imp)`);
      const winnerSet = new Set(sortedByLB.slice(0, 3).map(h => h.style));
      const losingHooks = eligibleHooks
        .filter(h => !winnerSet.has(h.style))
        .sort((a, b) => a.lowerCTR - b.lowerCTR)
        .slice(0, 2)
        .map(h => `${h.style} (LB ${h.lowerCTR.toFixed(2)}% CTR, ${h.adCount} ads)`);
      const winningFormats = bestPattern.formatPerformance
        .filter(f => f.format !== 'unknown')
        .sort((a, b) => b.conversionShare - a.conversionShare)
        .slice(0, 2)
        .map(f => `${f.format} (${f.conversionShare.toFixed(0)}% of conversions)`);
      const winFmtSet = new Set(
        bestPattern.formatPerformance
          .filter(f => f.format !== 'unknown')
          .sort((a, b) => b.conversionShare - a.conversionShare)
          .slice(0, 2)
          .map(f => f.format),
      );
      const losingFormats = bestPattern.formatPerformance
        .filter(f => f.adCount >= 3 && !winFmtSet.has(f.format) && f.format !== 'unknown')
        .sort((a, b) => a.conversionShare - b.conversionShare)
        .slice(0, 2)
        .map(f => `${f.format} (${f.conversionShare.toFixed(0)}% of conversions)`);

      // Race-safe: per-slice dot-path writes. Was: whole-tree updateLearnings
      // → clobbered concurrent Day-7 quick scan / Day-30 deep run / root-cause
      // analysis writes. Each slice is now an independent updateOne.
      await this.companiesService.setCreativeLearningSlice(tenantId, {
        winningHooks,
        losingHooks,
        winningFormats,
        losingFormats,
      }, { incrementVersion: true });
      const importedAt = new Date();
      // Per-product audience scores from ALL products' patterns — not just
      // productPatterns[0]. Two writes of the same map:
      //   - audienceScoresByProduct: immediately consumable by the audit
      //     DECISION PRIORS, the learned-bad-recipient guard, and LiveContext
      //     (which all prefer per-product over tenant-aggregate)
      //   - importedAudienceScoresByProduct: the STABLE baseline the Day-30
      //     deep run merges with — without it, the first deep run replaced
      //     this map with agent-campaign-only aggregates and a year of
      //     imported audience knowledge vanished (n=47 → n=5).
      const importedByProduct: Record<string, Record<string, { roas: number; n: number; updatedAt: Date }>> = {};
      for (const pattern of productPatterns) {
        if (!pattern.product) continue;
        importedByProduct[pattern.product] = Object.fromEntries(
          pattern.audiencePerformance
            .filter(a => a.audienceType && a.audienceType !== 'unknown' && a.adSetCount > 0)
            .map(a => [a.audienceType, { roas: a.avgROAS, n: a.adSetCount, updatedAt: importedAt }]),
        );
      }
      await this.companiesService.setCampaignLearningSlice(tenantId, {
        audienceScores: Object.fromEntries(
          bestPattern.audiencePerformance.map(a => [
            a.audienceType,
            { roas: a.avgROAS, n: a.adSetCount, updatedAt: importedAt },
          ]),
        ),
        audienceScoresByProduct: importedByProduct,
        importedAudienceScoresByProduct: importedByProduct,
        budgetInsights: bestPattern.budgetInsights,
        timingInsights: bestPattern.seasonalPeaks.length > 0
          ? [`Seasonal peaks: ${bestPattern.seasonalPeaks.join(', ')}`]
          : [],
      });

      this.logger.log(
        `Patterns saved: ${productPatterns.map(p => `${p.product} (${p.totalConversions} conv, ${p.confidenceLevel})`).join(', ')}`,
      );
    }

    // Sync all enriched campaigns to campaigns collection
    const syncResult = await this.campaignSync.syncFromEnrichedData(tenantId, enrichedCampaigns, conversionTypes);
    this.logger.log(`Campaign sync: ${syncResult.synced} updated, ${syncResult.created} new manual campaigns`);

    // Clear old case studies upfront so frontend sees fresh data as it streams in
    await this.caseStudyModel.deleteMany({ tenantId });

    // Only generate case studies for top 50 campaigns by spend — rest take too long and add little value
    const topCampaigns = [...enrichedCampaigns]
      .sort((a, b) => parseFloat(b.insights?.spend ?? '0') - parseFloat(a.insights?.spend ?? '0'))
      .slice(0, 50);

    this.logger.log(`Generating case studies for top ${topCampaigns.length} campaigns by spend`);

    // Generate case studies in batches of 5 — save each batch immediately so frontend sees them as they arrive
    let totalCaseStudies = 0;
    const csBatchSize = 5;

    for (let i = 0; i < topCampaigns.length; i += csBatchSize) {
      const batch = topCampaigns.slice(i, i + csBatchSize);
      // Non-fatal per batch: one Claude error (timeout/rate limit) used to
      // throw out of finalizeImport entirely — killing the cleanup +
      // status='completed' steps below, and the retry then hit the claim
      // guard and no-op'd, leaving the import stuck at 'finalizing' forever
      // (importId 6a2b65cf, 2026-06-12: died at 25/50 case studies).
      let caseStudies: Awaited<ReturnType<typeof this.generateCaseStudies>> = [];
      try {
        caseStudies = await this.generateCaseStudies(batch, company);
      } catch (err: any) {
        this.logger.warn(`Case-study batch ${i / csBatchSize + 1} failed (skipping, non-fatal): ${err.message}`);
      }

      if (caseStudies.length > 0) {
        await this.caseStudyModel.insertMany(
          caseStudies.map(cs => ({ ...cs, tenantId })),
        );
        totalCaseStudies += caseStudies.length;

        // Update count on import doc so frontend progress reflects reality
        await this.importModel.updateOne({ _id: importId }, { caseStudyCount: totalCaseStudies });
      }

      this.logger.log(
        `Case studies: ${Math.min(i + csBatchSize, topCampaigns.length)}/${topCampaigns.length} campaigns processed (${totalCaseStudies} saved)`,
      );

      if (i + csBatchSize < topCampaigns.length) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Analyze ad-level copy to fill ctaInsights, copyToneInsights, visualInsights
    try {
      const copyInsights = await this.analyzeCopyPatterns(enrichedCampaigns, company);
      if (copyInsights) {
        await this.companiesService.updateCreativeLearnings(tenantId, copyInsights);
        this.logger.log(`Copy pattern insights saved for ${tenantId}`);
      }
    } catch (err: any) {
      this.logger.warn(`Copy pattern analysis failed (non-fatal): ${err.message}`);
    }

    // Clean up enriched campaign temp data
    await this.enrichedCampaignModel.deleteMany({ importId: new Types.ObjectId(importId) });

    // Mark import as completed
    await this.importModel.updateOne(
      { _id: importId },
      {
        status: 'completed',
        caseStudyCount: totalCaseStudies,
        completedAt: new Date(),
        rawCampaigns: [], // free memory
      },
    );

    this.logger.log(
      `Import complete: ${enrichedCampaigns.length} campaigns, ${totalCaseStudies} case studies, ${productPatterns.length} product patterns`,
    );
  }

  /**
   * Get current import status for a tenant.
   */
  async getImportStatus(tenantId: string): Promise<any> {
    const latest = await this.importModel
      .findOne({ tenantId })
      .sort({ startedAt: -1 })
      .lean()
      .exec();

    if (!latest) return { status: 'none' };

    return {
      importId: (latest as any)._id.toString(),
      status: latest.status,
      totalCampaigns: latest.totalCampaigns,
      totalBatches: latest.totalBatches,
      completedBatches: latest.completedBatches,
      enrichedCount: latest.enrichedCount,
      caseStudyCount: latest.caseStudyCount,
      progress: latest.totalBatches > 0
        ? Math.round((latest.completedBatches / latest.totalBatches) * 100)
        : 0,
      error: latest.error,
      startedAt: latest.startedAt,
      completedAt: latest.completedAt,
    };
  }

  /**
   * Get relevant case studies for a given context (product, topic, audience).
   */
  async getRelevantCaseStudies(
    tenantId: string,
    filters: {
      product?: string;
      keywords?: string[];
      limit?: number;
    },
  ): Promise<CampaignCaseStudy[]> {
    const query: any = { tenantId };

    if (filters.product) {
      query.product = { $regex: filters.product, $options: 'i' };
    }

    // Was: sort by 'whatWorked.bestROAS' — but bestROAS was hallucinated
    // (revenue never fetched from Meta) and is no longer written by IM1.
    // Sort by real winner-volume signals instead: most conversions first,
    // tiebreak on lowest CPA (only meaningful if conversions > 0).
    const studies = await this.caseStudyModel
      .find(query)
      .sort({ totalConversions: -1, 'whatWorked.bestCPA': 1 })
      .limit(filters.limit ?? 5)
      .lean()
      .exec();

    if (filters.keywords && filters.keywords.length > 0) {
      const keywords = filters.keywords.map(k => k.toLowerCase());
      return studies.filter((s: any) => {
        const text = JSON.stringify(s).toLowerCase();
        return keywords.some(k => text.includes(k));
      }).slice(0, filters.limit ?? 5);
    }

    return studies;
  }

  /**
   * Run copy pattern analysis standalone — no full import needed.
   * Reads ad-level copy from the campaigns collection (already synced)
   * and updates ctaInsights, copyToneInsights, visualInsights.
   * Call this anytime without re-running the full import.
   */
  async runCopyPatternAnalysis(company: CompanyDocument): Promise<{ adsAnalyzed: number }> {
    const tenantId = company.tenantId;

    if (!company.meta?.accessToken || !company.meta?.accountId) {
      throw new Error('Meta credentials not configured');
    }

    const { accessToken } = company.meta;
    const normalizeId = (id: string) => id.startsWith('act_') ? id : `act_${id}`;
    const accountIds = ((company.meta.accountIds?.length ?? 0) > 0
      ? company.meta.accountIds!
      : [company.meta.accountId]
    ).map(normalizeId);

    this.logger.log(`Fetching ad copy from Meta for copy pattern analysis: tenantId=${tenantId}`);

    // Fetch ad copy + performance directly from Meta (lightweight — no enrichment)
    const adArrays = await Promise.all(accountIds.map(id => this.fetchAdCopyFromMeta(id, accessToken)));
    const allAds = adArrays.flat();

    this.logger.log(`Fetched ${allAds.length} ads with copy data`);

    // Build fake enrichedCampaigns structure that analyzeCopyPatterns expects
    const fakeEnrichedCampaigns = [{ ads: allAds }];

    const copyInsights = await this.analyzeCopyPatterns(fakeEnrichedCampaigns, company);
    if (!copyInsights) throw new Error('Insufficient ad copy data for analysis (need at least 5 ads)');

    await this.companiesService.updateCreativeLearnings(tenantId, copyInsights);

    this.logger.log(`Copy pattern analysis done: tenantId=${tenantId} adsAnalyzed=${allAds.length}`);
    return { adsAnalyzed: allAds.length };
  }

  private async fetchAdCopyFromMeta(accountId: string, accessToken: string): Promise<any[]> {
    const allAds: any[] = [];
    let nextUrl: string | null = null;

    const fields = [
      'id',
      'name',
      'creative{title,body,object_story_spec,call_to_action_type}',
      'insights.date_preset(last_year){impressions,ctr,spend,actions}',
    ].join(',');

    try {
      const response = await axios.get(`${META_API_BASE}/${accountId}/ads`, {
        params: { fields, limit: 200, access_token: accessToken },
        timeout: 30000,
      });
      allAds.push(...this.parseAdCopy(response.data?.data ?? []));
      nextUrl = response.data?.paging?.next ?? null;
    } catch (err: any) {
      this.logger.error(`Failed to fetch ad copy for ${accountId}: ${err.message}`);
      return [];
    }

    while (nextUrl) {
      try {
        const response = await axios.get(nextUrl, { timeout: 30000 });
        allAds.push(...this.parseAdCopy(response.data?.data ?? []));
        nextUrl = response.data?.paging?.next ?? null;
        await new Promise(r => setTimeout(r, 300));
      } catch { break; }
    }

    return allAds.filter(ad => (ad.impressions ?? 0) >= 500 && (ad.copyBody || ad.copyTitle));
  }

  private parseAdCopy(rawAds: any[]): any[] {
    return rawAds.map((ad: any) => {
      const insight = ad.insights?.data?.[0] ?? {};
      const creative = ad.creative ?? {};
      const storySpec = creative.object_story_spec ?? {};
      const linkData = storySpec.link_data ?? storySpec.video_data ?? {};
      const actions = insight.actions ?? [];
      const conversionAction = actions.find((a: any) =>
        ['offsite_conversion.fb_pixel_purchase', 'purchase', 'lead', 'offsite_conversion.fb_pixel_lead'].includes(a.action_type),
      );
      const conversions = parseInt(conversionAction?.value ?? '0', 10);
      const spend = parseFloat(insight.spend ?? '0');

      return {
        copyBody: (creative.body ?? linkData.message ?? '').slice(0, 300),
        copyTitle: (creative.title ?? linkData.name ?? '').slice(0, 100),
        ctr: parseFloat(insight.ctr ?? '0'),
        conversions,
        spend,
        impressions: parseInt(insight.impressions ?? '0', 10),
      };
    });
  }

  /**
   * Aggregate ad set performance by audience type from synced campaign data.
   * Used by Campaign Review Team to make data-driven audience decisions.
   */
  async getAudiencePerformanceSummary(tenantId: string): Promise<{
    byType: Record<string, { avgCPA: number; avgCTR: number; totalSpend: number; adSetCount: number; conversions: number }>;
  }> {
    const campaigns = await this.campaignModel
      .find({ tenantId, 'metaAdSets.0': { $exists: true } })
      .select('metaAdSets')
      .lean()
      .exec();

    const byType: Record<string, { totalSpend: number; totalCTR: number; conversions: number; count: number }> = {};

    for (const campaign of campaigns) {
      for (const adSet of (campaign as any).metaAdSets ?? []) {
        if ((adSet.spend ?? 0) < 100) continue; // skip negligible spend
        const type = adSet.audienceType || 'other';
        if (!byType[type]) byType[type] = { totalSpend: 0, totalCTR: 0, conversions: 0, count: 0 };
        byType[type].totalSpend += adSet.spend ?? 0;
        byType[type].totalCTR += adSet.ctr ?? 0;
        byType[type].conversions += adSet.conversions ?? 0;
        byType[type].count++;
      }
    }

    const result: Record<string, any> = {};
    for (const [type, data] of Object.entries(byType)) {
      if (data.count === 0) continue;
      result[type] = {
        avgCPA: data.conversions > 0 ? Math.round(data.totalSpend / data.conversions) : 0,
        avgCTR: Math.round((data.totalCTR / data.count) * 100) / 100,
        totalSpend: Math.round(data.totalSpend),
        adSetCount: data.count,
        conversions: data.conversions,
      };
    }

    return { byType: result };
  }

  // ─── Private: Meta API data pulling ─────────────────────────────────────────

  /**
   * Fetch all conversion data for an account.
   * Returns the full Set of valid action_types AND a map of custom conversion id → name
   * (used later for product detection via promoted_object).
   */
  private async fetchConversionData(
    accountId: string,
    accessToken: string,
  ): Promise<{ conversionTypes: Set<string>; customConversions: { id: string; name: string }[] }> {
    const STANDARD_EVENTS = new Set([
      'purchase',
      'offsite_conversion.fb_pixel_purchase',
      'lead',
      'offsite_conversion.fb_pixel_lead',
      'complete_registration',
      'submit_application',
      'subscribe',
      'start_trial',
    ]);

    try {
      const res = await axios.get(`${META_API_BASE}/${accountId}/customconversions`, {
        params: {
          fields: 'id,name,pixel_id,custom_event_type,event_source_type',
          limit: '200',
          access_token: accessToken,
        },
        timeout: 30000,
      });

      const rawCustomConversions: any[] = res.data?.data ?? [];

      if (rawCustomConversions.length === 0) {
        this.logger.log('No custom conversions found — using standard events only');
        return { conversionTypes: STANDARD_EVENTS, customConversions: [] };
      }

      const customConversions = rawCustomConversions.map(c => ({ id: String(c.id), name: String(c.name) }));
      const conversionTypes = new Set<string>();

      // Only count custom conversions that represent actual purchases/completions.
      // Add-to-cart, attempted, view-content etc. are funnel events — not conversions.
      const PURCHASE_KEYWORDS = ['purchase', 'completed', 'payment', 'paid', 'buy', 'order', 'sold'];
      const NON_PURCHASE_KEYWORDS = ['add_to_cart', 'addtocart', 'cart', 'attempted', 'view_content', 'viewcontent', 'initiated', 'started'];

      const isPurchaseConversion = (name: string): boolean => {
        const lower = name.toLowerCase();
        if (NON_PURCHASE_KEYWORDS.some(kw => lower.includes(kw))) return false;
        return PURCHASE_KEYWORDS.some(kw => lower.includes(kw));
      };

      const purchaseConversions = customConversions.filter(c => isPurchaseConversion(c.name));
      const skippedConversions = customConversions.filter(c => !isPurchaseConversion(c.name));

      for (const conversion of purchaseConversions) {
        conversionTypes.add(`offsite_conversion.custom.${conversion.id}`);
      }

      this.logger.log(
        `Found ${customConversions.length} custom conversions — counting ${purchaseConversions.length} purchase-type: [${purchaseConversions.map(c => c.name).join(', ')}] | skipping ${skippedConversions.length} non-purchase: [${skippedConversions.map(c => c.name).join(', ')}]`,
      );

      for (const event of STANDARD_EVENTS) conversionTypes.add(event);

      // Discover custom pixel events by sampling top campaigns' actions
      // Safer than account-level or pixel/stats endpoints — uses same API we already call
      try {
        const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const until = new Date().toISOString().split('T')[0];

        const insightsRes = await axios.get(`${META_API_BASE}/${accountId}/insights`, {
          params: {
            fields: 'campaign_id,actions',
            level: 'campaign',
            time_range: JSON.stringify({ since, until }),
            limit: '200',
            access_token: accessToken,
          },
          timeout: 30000,
        });

        const allActionTypes = new Set<string>();
        for (const row of insightsRes.data?.data ?? []) {
          for (const action of row.actions ?? []) {
            allActionTypes.add(action.action_type);
          }
        }

        const NON_CONVERSION = [
          'link_click', 'post_engagement', 'page_engagement', 'video_view',
          'photo_view', 'comment', 'like', 'post', 'checkin', 'rsvp',
          'mention', 'share', 'photo', 'video', 'landing_page_view',
          'omni_landing_page_view', 'post_interaction_gross', 'post_interaction_net',
          'post_reaction', 'post_uncomment', 'add_to_cart', 'omni_add_to_cart',
          'offsite_search_add_meta_leads', 'offsite_content_view_add_meta_leads',
          'offsite_complete_registration_add_meta_leads',
        ];

        const customEvents = [...allActionTypes].filter(type =>
          !type.startsWith('offsite_conversion.') &&
          !type.startsWith('app_') &&
          !type.startsWith('onsite_') &&
          !STANDARD_EVENTS.has(type) &&
          !NON_CONVERSION.includes(type),
        );

        for (const eventName of customEvents) {
          conversionTypes.add(eventName);
        }

        if (customEvents.length > 0) {
          this.logger.log(`Found custom pixel events: ${customEvents.join(', ')}`);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to discover custom pixel events: ${err.message}`);
      }

      return { conversionTypes, customConversions };
    } catch (err: any) {
      this.logger.warn(`Failed to fetch custom conversions: ${err.message} — using standard events`);
      return { conversionTypes: STANDARD_EVENTS, customConversions: [] };
    }
  }

  private async pullAllCampaigns(
    accountId: string,
    accessToken: string,
  ): Promise<any[]> {
    const allCampaigns: any[] = [];
    const filtering = JSON.stringify([
      { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'COMPLETED'] },
    ]);

    let cursor: string | null = null;
    do {
      const params: Record<string, string> = {
        fields: 'name,status,objective,start_time,stop_time,daily_budget,lifetime_budget',
        filtering,
        limit: '200',
        access_token: accessToken,
      };
      if (cursor) params.after = cursor;

      const response = await axios.get(`${META_API_BASE}/${accountId}/campaigns`, {
        params,
        timeout: 30000,
      });
      const data = response.data;
      allCampaigns.push(...(data.data ?? []));
      cursor = data.paging?.cursors?.after ?? null;
      if (!data.paging?.next) cursor = null;
    } while (cursor);

    // Filter to last 1 year
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return allCampaigns.filter(c => {
      const startTime = c.start_time ? new Date(c.start_time) : null;
      return !startTime || startTime >= cutoff;
    });
  }

  private async fetchCampaignSpends(
    accountId: string,
    accessToken: string,
  ): Promise<Map<string, number>> {
    const spendMap = new Map<string, number>();
    try {
      let cursor: string | null = null;
      do {
        const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const until = new Date().toISOString().split('T')[0];
        const params: Record<string, string> = {
          fields: 'campaign_id,spend',
          level: 'campaign',
          time_range: JSON.stringify({ since, until }),
          limit: '500',
          access_token: accessToken,
        };
        if (cursor) params.after = cursor;

        const res = await axios.get(`${META_API_BASE}/${accountId}/insights`, {
          params,
          timeout: 60000,
        });
        const data = res.data;
        for (const row of data.data ?? []) {
          spendMap.set(row.campaign_id, parseFloat(row.spend ?? '0'));
        }
        cursor = data.paging?.cursors?.after ?? null;
        if (!data.paging?.next) cursor = null;
      } while (cursor);
    } catch (err: any) {
      this.logger.warn(`Bulk spend fetch failed: ${err.message}`);
    }
    return spendMap;
  }

  /**
   * Detect which product a campaign was optimizing for.
   * Uses promoted_object on ad sets (Meta's own record) + fuzzy match against company products.
   * Falls back to campaign name match if promoted_object is absent.
   */
  private detectProduct(
    campaign: any,
    customConversions: { id: string; name: string }[],
    products: { name: string; price: number }[],
  ): string {
    // Build id → name map for custom conversions
    const ccMap = new Map(customConversions.map(c => [c.id, c.name]));

    // Gather all promoted_object entries from ad sets
    const adSets: any[] = campaign.adSets ?? [];
    for (const adSet of adSets) {
      const po = adSet.promoted_object;
      if (!po) continue;

      let eventName: string | undefined;

      // Custom conversion: offsite_conversion.custom.<id>
      if (po.custom_conversion_id) {
        eventName = ccMap.get(String(po.custom_conversion_id));
      }

      // Custom event type (e.g. NADI_REPORT_PURCHASE_COMPLETED)
      if (!eventName && po.custom_event_type) {
        eventName = String(po.custom_event_type);
      }

      if (eventName) {
        // Fuzzy match event name → product name
        const normalized = eventName.toLowerCase().replace(/[_\-\.]/g, ' ');
        for (const product of products) {
          const productWords = product.name.toLowerCase().split(/\s+/);
          if (productWords.some(word => word.length > 3 && normalized.includes(word))) {
            return product.name;
          }
        }
        // No product match — return the event name itself so it's still useful
        return eventName;
      }
    }

    // Fallback: match campaign name against product names
    const campaignName = (campaign.name ?? '').toLowerCase();
    for (const product of products) {
      const productWords = product.name.toLowerCase().split(/\s+/);
      if (productWords.some(word => word.length > 3 && campaignName.includes(word))) {
        return product.name;
      }
    }

    return 'unknown';
  }

  enrichCampaign(
    campaign: any,
    accessToken: string,
    conversionTypes: Set<string>,
  ): Promise<any | null> {
    return this._enrichCampaign(campaign, accessToken, conversionTypes);
  }

  private async _enrichCampaign(
    campaign: any,
    accessToken: string,
    conversionTypes: Set<string>,
  ): Promise<any | null> {
    const [insightsRes, adSetsRes, adSetInsightsRes, adInsightsRes, demoRes, adsRes] = await Promise.all([
      axios.get(
        `${META_API_BASE}/${campaign.id}/insights?fields=spend,impressions,clicks,ctr,cpc,actions,frequency&date_preset=maximum&access_token=${accessToken}`,
        { timeout: 30000 },
      ).catch(() => ({ data: { data: [] } })),
      axios.get(
        `${META_API_BASE}/${campaign.id}/adsets?fields=name,targeting,optimization_goal,daily_budget,lifetime_budget,promoted_object&limit=20&access_token=${accessToken}`,
        { timeout: 30000 },
      ).catch(() => ({ data: { data: [] } })),
      axios.get(
        `${META_API_BASE}/${campaign.id}/insights?fields=adset_name,adset_id,spend,impressions,clicks,ctr,cpc,actions,frequency&level=adset&date_preset=maximum&access_token=${accessToken}`,
        { timeout: 30000 },
      ).catch(() => ({ data: { data: [] } })),
      axios.get(
        `${META_API_BASE}/${campaign.id}/insights?fields=ad_name,ad_id,adset_id,spend,impressions,clicks,ctr,cpc,actions&level=ad&date_preset=maximum&access_token=${accessToken}`,
        { timeout: 30000 },
      ).catch(() => ({ data: { data: [] } })),
      axios.get(
        `${META_API_BASE}/${campaign.id}/insights?fields=spend,actions&breakdowns=age,gender&date_preset=maximum&access_token=${accessToken}`,
        { timeout: 30000 },
      ).catch(() => ({ data: { data: [] } })),
      axios.get(
        `${META_API_BASE}/${campaign.id}/ads?fields=name,creative{title,body,object_story_spec{link_data{message,name,call_to_action},video_data{message,call_to_action}}}&limit=10&access_token=${accessToken}`,
        { timeout: 30000 },
      ).catch(() => ({ data: { data: [] } })),
    ]);

    const insights = insightsRes.data?.data?.[0];
    if (!insights || parseFloat(insights.spend ?? '0') === 0) return null;

    return {
      ...campaign,
      insights,
      adSets: adSetsRes.data?.data ?? [],
      adSetInsights: adSetInsightsRes.data?.data ?? [],
      adInsights: adInsightsRes.data?.data ?? [],
      demographics: demoRes.data?.data ?? [],
      ads: adsRes.data?.data ?? [],
      conversionTypes,
    };
  }

  // ─── Private: Claude case study generation ──────────────────────────────────

  private async generateCaseStudies(
    campaigns: any[],
    company: CompanyDocument,
  ): Promise<CampaignCaseStudy[]> {
    const campaignSummaries = campaigns.map(c => this.summarizeCampaign(c));

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      agentType: AgentType.CASE_STUDY_GENERATOR,
      systemPrompt: `You are a senior performance marketing analyst. You analyze historical campaign data and extract actionable case studies.`,
      liveContext: '',
      userMessage: `Analyze these ${campaignSummaries.length} campaigns for ${company.name} (${company.industry}).

Products sold: ${(company.products ?? []).map(p => `${p.name} (₹${p.price})`).join(', ')}

CAMPAIGN DATA:
${JSON.stringify(campaignSummaries, null, 2)}

For EACH campaign, create a case study. Return ONLY valid JSON array:
[
  {
    "campaignName": "exact campaign name (must match input)",
    "product": "which product this campaign sold (best guess from name/context)",
    "context": "what was the market context — any seasonal event, trend, or competitor move that influenced this",
    "whatWorked": {
      "hooks": ["hookStyle labels that performed — use ONLY: pain_point, bold_claim, price_shock, social_proof, curiosity_gap, before_after, urgency"],
      "audiences": ["audience types that converted — lookalike, advantage_plus, retarget, broad, interest, custom"],
      "formats": ["ad formats — derive from ads[].format field in the input data, NEVER guess from ad names"]
    },
    "whatFailed": {
      "hooks": ["hookStyles that flopped (same allowlist as above)"],
      "audiences": ["audiences that wasted budget"],
      "reason": "ONE sentence on why it likely failed — must reference a specific metric (CTR, CPA, frequency, spend) from the input"
    },
    "lesson": "ONE sentence key takeaway. MUST cite a number or named entity from the input data — no folk wisdom."
  }
]

Rules:
- Numeric fields (totalSpend, totalConversions, bestCPA, durationDays, dateRange) are computed by the system — DO NOT include them in your output. Focus on narrative + categorical fields only.
- Format MUST come from each ad's "format" field in the input — image-only campaigns must NOT have "video" in formats.
- Hook labels MUST be from the canonical taxonomy above. "ugc" / "personal_story" / "question" are NOT valid — map them to social_proof / curiosity_gap.
- Be specific about WHY something worked or failed — cite a metric.
- Infer product from campaign name (e.g. "Nadi Report" → Nadi Report product).
- If you can't determine hook style from ad copy, omit that hook (don't guess).
- Keep each lesson to 1-2 sentences max.`,
      maxTurns: 3,
    });

    try {
      const fenceMatch = result.content.match(/```json\s*([\s\S]*?)```/i);
      const jsonStr = fenceMatch
        ? fenceMatch[1].trim()
        : result.content.slice(result.content.indexOf('['), result.content.lastIndexOf(']') + 1);
      const parsed = JSON.parse(jsonStr);

      // ── Server-side numeric writeback ────────────────────────────────────
      // The LLM no longer extracts totalSpend/totalConversions/bestCPA/dateRange
      // — those are computed deterministically from the source data and joined
      // back here. bestROAS is dropped entirely (revenue isn't fetched from
      // Meta, so any number the LLM produced was hallucinated). Was: LLM
      // re-extracted numbers from the same data it was about to summarize and
      // there was no comparison check, so it could "round" or invent.
      const summaryByName = new Map(campaigns.map(c => [c.name, this.summarizeCampaign(c)]));
      return parsed
        .map((cs: any) => {
          const src = summaryByName.get(cs.campaignName);
          if (!src) {
            this.logger.warn(`Case study refers to unknown campaign "${cs.campaignName}" — dropping`);
            return null;
          }
          const adCpas = (src.ads ?? [])
            .map((a: any) => a.conversions > 0 ? a.spend / a.conversions : null)
            .filter((x: number | null): x is number => x !== null && x > 0);
          const bestCPA = adCpas.length > 0 ? Math.min(...adCpas) : (src.cpa ?? 0);
          const start = src.startDate ? new Date(src.startDate) : null;
          const end = src.endDate ? new Date(src.endDate) : new Date();
          const durationDays = start
            ? Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)))
            : 0;
          const dateRange = start
            ? `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`
            : 'unknown';
          return {
            ...cs,
            // Trusted numeric fields — overwritten from deterministic computation
            durationDays,
            dateRange,
            totalSpend: src.spend ?? 0,
            totalConversions: src.conversions ?? 0,
            whatWorked: {
              ...cs.whatWorked,
              bestCPA,
              // bestROAS deliberately omitted — never fetched from Meta, was hallucinated
            },
          };
        })
        .filter(Boolean);
    } catch (err: any) {
      this.logger.warn(`Failed to parse case studies JSON: ${err.message}`);
      return [];
    }
  }

  private summarizeCampaign(campaign: any): any {
    const insights = campaign.insights ?? {};
    const spend = parseFloat(insights.spend ?? '0');
    const conversionTypes: Set<string> | undefined = campaign.conversionTypes instanceof Set
      ? campaign.conversionTypes
      : campaign.conversionTypes ? new Set(campaign.conversionTypes) : undefined;
    const conversions = this.extractConversions(insights.actions, conversionTypes);

    return {
      name: campaign.name,
      status: campaign.status,
      objective: campaign.objective,
      startDate: campaign.start_time,
      endDate: campaign.stop_time,
      spend,
      impressions: parseInt(insights.impressions ?? '0', 10),
      clicks: parseInt(insights.clicks ?? '0', 10),
      conversions,
      ctr: parseFloat(insights.ctr ?? '0'),
      frequency: parseFloat(insights.frequency ?? '0'),
      cpa: conversions > 0 ? spend / conversions : 0,
      adSets: (campaign.adSetInsights ?? []).map((as: any) => ({
        name: as.adset_name,
        spend: parseFloat(as.spend ?? '0'),
        clicks: parseInt(as.clicks ?? '0', 10),
        ctr: parseFloat(as.ctr ?? '0'),
        conversions: this.extractConversions(as.actions, conversionTypes),
        frequency: parseFloat(as.frequency ?? '0'),
      })),
      ads: (campaign.adInsights ?? []).map((ad: any) => {
        const creative = (campaign.ads ?? []).find((a: any) => a.name === ad.ad_name);
        const body = creative?.creative?.body
          ?? creative?.creative?.object_story_spec?.link_data?.message
          ?? creative?.creative?.object_story_spec?.video_data?.message
          ?? '';
        const title = creative?.creative?.title
          ?? creative?.creative?.object_story_spec?.link_data?.name
          ?? '';
        // Format must be EXTRACTED from the creative payload, not inferred by
        // the LLM from ad names. Was: ad-name regex guessed at format and the
        // LLM then "verified" it from those name guesses → image-only campaigns
        // got falsely tagged "video out-converted" in case studies.
        const format = sharedInferFormatFromCreative(creative?.creative, ad.ad_name ?? '');
        return {
          name: ad.ad_name,
          format,
          spend: parseFloat(ad.spend ?? '0'),
          clicks: parseInt(ad.clicks ?? '0', 10),
          impressions: parseInt(ad.impressions ?? '0', 10),
          ctr: parseFloat(ad.ctr ?? '0'),
          conversions: this.extractConversions(ad.actions, conversionTypes),
          copyBody: body.slice(0, 300),
          copyTitle: title.slice(0, 100),
        };
      }),
      topDemographics: (campaign.demographics ?? [])
        .filter((d: any) => this.extractConversions(d.actions, conversionTypes) > 0)
        .sort((a: any, b: any) => this.extractConversions(b.actions, conversionTypes) - this.extractConversions(a.actions, conversionTypes))
        .slice(0, 5)
        .map((d: any) => ({
          age: d.age,
          gender: d.gender,
          conversions: this.extractConversions(d.actions, conversionTypes),
          spend: parseFloat(d.spend ?? '0'),
        })),
    };
  }

  private async analyzeCopyPatterns(
    enrichedCampaigns: any[],
    company: CompanyDocument,
  ): Promise<{ ctaInsights: string[]; copyToneInsights: string[]; visualInsights: string[] } | null> {
    // Flatten all ads across all campaigns, attach campaign-level metrics for context
    const allAds: { copyBody: string; copyTitle: string; ctr: number; conversions: number; spend: number }[] = [];

    for (const campaign of enrichedCampaigns) {
      for (const ad of campaign.ads ?? []) {
        if (!ad.copyBody && !ad.copyTitle) continue;
        allAds.push({
          copyBody: ad.copyBody ?? '',
          copyTitle: ad.copyTitle ?? '',
          ctr: ad.ctr ?? 0,
          conversions: ad.conversions ?? 0,
          spend: ad.spend ?? 0,
        });
      }
    }

    if (allAds.length < 5) {
      this.logger.warn('Not enough ad-level copy data for pattern analysis');
      return null;
    }

    // Sort by conversions desc, fallback to CTR — take top and bottom 40 for contrast
    const sorted = [...allAds].sort((a, b) =>
      b.conversions !== a.conversions ? b.conversions - a.conversions : b.ctr - a.ctr,
    );
    const take = Math.min(40, Math.max(5, Math.floor(sorted.length * 0.3)));
    const topAds = sorted.slice(0, take);
    const bottomAds = sorted.slice(-take);

    const fmt = (ad: typeof allAds[0]) =>
      `Headline: "${ad.copyTitle}" | Copy: "${ad.copyBody.slice(0, 200)}" | CTR: ${ad.ctr.toFixed(2)}% | Conversions: ${ad.conversions} | Spend: ₹${ad.spend.toFixed(0)}`;

    const userMessage = `
Analyze these Meta ads for ${company.name} (audience: ${company.targetAudience}, geography: ${company.geography}).

TOP PERFORMING ADS (highest conversions):
${topAds.map(fmt).join('\n')}

BOTTOM PERFORMING ADS (lowest conversions):
${bottomAds.map(fmt).join('\n')}

Focus ONLY on:
1. CTA PATTERNS: What call-to-action text/style appears in top ads? What appears in bottom ads?
2. COPY TONE: What tone, language mix (Hinglish/English), emotional style do top ads use vs bottom?
3. COPY STRUCTURE: How is price framed? Short vs long copy? First-line hook style?

Return ONLY valid JSON:
\`\`\`json
{
  "ctaInsights": ["specific CTA pattern from data — e.g. 'Order Now outperforms Learn More 2x in conversions'", "max 3 items"],
  "copyToneInsights": ["specific tone pattern — e.g. 'Hinglish personal story hooks (Ek saheli ne...) drive 3x CTR vs English'", "max 4 items"],
  "visualInsights": ["copy structure pattern — e.g. 'Ads with price in first 2 lines drive higher CTR', 'Short 3-line copy outperforms long-form for this audience', 'Personal story opening outperforms feature-list opening'", "max 3 items"]
}
\`\`\`

Rules: SPECIFIC patterns from the actual data above. No generic advice. If no clear pattern, say "insufficient data".
    `.trim();

    const result = await this.claudeService.runAgent({
      tenantId: company.tenantId,
      runId: `copy-patterns-${Date.now()}`,
      agentType: AgentType.CREATIVE_LEARNING_AGENT,
      systemPrompt: '',
      liveContext: '',
      userMessage,
      maxTurns: 2,
    });

    const fenceMatch = result.content.match(/```json\s*([\s\S]*?)```/i);
    const raw = fenceMatch
      ? fenceMatch[1].trim()
      : result.content.slice(result.content.indexOf('{'), result.content.lastIndexOf('}') + 1);

    const parsed = JSON.parse(raw);
    return {
      ctaInsights: parsed.ctaInsights ?? [],
      copyToneInsights: parsed.copyToneInsights ?? [],
      visualInsights: parsed.visualInsights ?? [],
    };
  }

  private extractConversions(actions: any[] | undefined, conversionTypes?: Set<string>): number {
    return extractConversions(actions, conversionTypes);
  }
}
