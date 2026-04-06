import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Model, Types } from 'mongoose';
import { Queue } from 'bullmq';
import axios from 'axios';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { CampaignCaseStudy as CaseStudyModel, CampaignCaseStudyDocument } from '../schemas/campaign-case-study.schema';
import { MetaLearningImport, MetaLearningImportDocument } from '../schemas/meta-learning-import.schema';
import { EnrichedCampaign, EnrichedCampaignDocument } from '../schemas/enriched-campaign.schema';
import { PatternCalculatorService } from './pattern-calculator.service';
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
    const { accountId, accessToken } = company.meta!;

    // Step 1: Fetch conversion types
    const conversionTypes = await this.fetchConversionTypes(accountId, accessToken, company.meta?.pixelId);
    this.logger.log(`Conversion types: ${[...conversionTypes].join(', ')}`);

    // Step 2: Pull all campaigns (non-deleted)
    const rawCampaigns = await this.pullAllCampaigns(accountId, accessToken);
    this.logger.log(`Pulled ${rawCampaigns.length} campaigns from Meta`);

    if (rawCampaigns.length === 0) {
      return { importId: '', totalCampaigns: 0, totalBatches: 0 };
    }

    // Step 3: Bulk-fetch spends — filter to campaigns with spend > ₹500
    const spendMap = await this.fetchCampaignSpends(accountId, accessToken);
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
    const { accountId, accessToken } = company.meta!;
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
        chunk.map(c => this.enrichCampaign(c, accountId, accessToken, conversionTypes)),
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
    const importDoc = await this.importModel.findById(importId).exec();
    if (!importDoc) throw new Error(`Import ${importId} not found`);

    const tenantId = importDoc.tenantId;
    await this.importModel.updateOne({ _id: importId }, { status: 'finalizing' });

    this.logger.log(`Finalizing import ${importId} for ${tenantId}`);

    const company = await this.companiesService.findByTenantId(tenantId);
    const conversionTypes = new Set(importDoc.conversionTypes);

    // Load all enriched campaigns from DB
    const enrichedDocs = await this.enrichedCampaignModel
      .find({ importId: new Types.ObjectId(importId) })
      .lean()
      .exec();

    // Restore conversionTypes as Set on each campaign
    const enrichedCampaigns = enrichedDocs.map(d => ({
      ...d.data,
      conversionTypes,
    }));

    this.logger.log(`Loaded ${enrichedCampaigns.length} enriched campaigns for pattern calculation`);

    // Calculate statistical patterns
    const products = (company.products ?? []).filter(p => p.active).map(p => ({
      name: p.name,
      price: p.price,
    }));

    const productPatterns = this.patternCalculator.calculatePatterns(enrichedCampaigns, products);

    // Save patterns to company.learnings
    if (productPatterns.length > 0) {
      const bestPattern = productPatterns[0];
      await this.companiesService.updateLearnings(tenantId, {
        version: 1,
        updatedAt: new Date(),
        topicScores: {},
        creative: {
          winningHooks: bestPattern.hookPerformance
            .filter(h => h.avgCTR > 0)
            .sort((a, b) => b.avgCTR - a.avgCTR)
            .slice(0, 3)
            .map(h => `${h.style} (${h.avgCTR.toFixed(2)}% CTR, ${h.adCount} ads)`),
          losingHooks: bestPattern.hookPerformance
            .filter(h => h.adCount >= 3)
            .sort((a, b) => a.avgCTR - b.avgCTR)
            .slice(0, 2)
            .map(h => `${h.style} (${h.avgCTR.toFixed(2)}% CTR, ${h.adCount} ads)`),
          winningFormats: bestPattern.formatPerformance
            .sort((a, b) => b.conversionShare - a.conversionShare)
            .slice(0, 2)
            .map(f => `${f.format} (${f.conversionShare.toFixed(0)}% of conversions)`),
          losingFormats: bestPattern.formatPerformance
            .filter(f => f.adCount >= 3)
            .sort((a, b) => a.conversionShare - b.conversionShare)
            .slice(0, 2)
            .map(f => `${f.format} (${f.conversionShare.toFixed(0)}% of conversions)`),
          ctaInsights: [],
          copyToneInsights: [],
          visualInsights: [],
        },
        campaign: {
          audienceScores: Object.fromEntries(
            bestPattern.audiencePerformance.map(a => [a.audienceType, a.avgROAS]),
          ),
          platformROAS: {},
          budgetInsights: bestPattern.budgetInsights,
          timingInsights: bestPattern.seasonalPeaks.length > 0
            ? [`Seasonal peaks: ${bestPattern.seasonalPeaks.join(', ')}`]
            : [],
          objectiveInsights: [],
        },
        causalInsights: [],
      });

      this.logger.log(
        `Patterns saved: ${productPatterns.map(p => `${p.product} (${p.totalConversions} conv, ${p.confidenceLevel})`).join(', ')}`,
      );
    }

    // Generate case studies in batches of 5
    const allCaseStudies: CampaignCaseStudy[] = [];
    const csBatchSize = 5;

    for (let i = 0; i < enrichedCampaigns.length; i += csBatchSize) {
      const batch = enrichedCampaigns.slice(i, i + csBatchSize);
      const caseStudies = await this.generateCaseStudies(batch, company);
      allCaseStudies.push(...caseStudies);
      this.logger.log(
        `Case studies: ${Math.min(i + csBatchSize, enrichedCampaigns.length)}/${enrichedCampaigns.length} campaigns processed`,
      );
      if (i + csBatchSize < enrichedCampaigns.length) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Save case studies (replace existing for this tenant)
    await this.caseStudyModel.deleteMany({ tenantId });
    if (allCaseStudies.length > 0) {
      await this.caseStudyModel.insertMany(
        allCaseStudies.map(cs => ({ ...cs, tenantId })),
      );
    }

    // Clean up enriched campaign temp data
    await this.enrichedCampaignModel.deleteMany({ importId: new Types.ObjectId(importId) });

    // Mark import as completed
    await this.importModel.updateOne(
      { _id: importId },
      {
        status: 'completed',
        caseStudyCount: allCaseStudies.length,
        completedAt: new Date(),
        rawCampaigns: [], // free memory
      },
    );

    this.logger.log(
      `Import complete: ${enrichedCampaigns.length} campaigns, ${allCaseStudies.length} case studies, ${productPatterns.length} product patterns`,
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

    const studies = await this.caseStudyModel
      .find(query)
      .sort({ 'whatWorked.bestROAS': -1 })
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

  // ─── Private: Meta API data pulling ─────────────────────────────────────────

  private async fetchConversionTypes(
    accountId: string,
    accessToken: string,
    pixelId?: string,
  ): Promise<Set<string>> {
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

      const customConversions: any[] = res.data?.data ?? [];

      if (customConversions.length === 0) {
        this.logger.log('No custom conversions found — using standard events only');
        return STANDARD_EVENTS;
      }

      const conversionTypes = new Set<string>();

      for (const conversion of customConversions) {
        conversionTypes.add(`offsite_conversion.custom.${conversion.id}`);
      }

      this.logger.log(
        `Found ${customConversions.length} custom conversions: ${customConversions.map(c => c.name).join(', ')}`,
      );

      for (const event of STANDARD_EVENTS) conversionTypes.add(event);

      if (pixelId) {
        try {
          const pixelRes = await axios.get(`${META_API_BASE}/${pixelId}/stats`, {
            params: {
              fields: 'data',
              access_token: accessToken,
            },
            timeout: 30000,
          });

          const buckets: any[] = pixelRes.data?.data ?? [];
          const allEventNames = new Set<string>();
          for (const bucket of buckets) {
            for (const entry of bucket.data ?? []) {
              if (entry.value) allEventNames.add(entry.value);
            }
          }

          const NON_CONVERSION = ['PageView', 'ViewContent', 'Search', 'AddToCart',
            'AddToWishlist', 'InitiateCheckout', 'AddPaymentInfo', 'CHAT',
            'ATTEMPTED', 'VIEW', 'SCROLL'];

          const conversionEvents = [...allEventNames].filter(name =>
            !NON_CONVERSION.some(skip => name.toUpperCase().includes(skip.toUpperCase())),
          );

          for (const eventName of conversionEvents) {
            conversionTypes.add(eventName);
          }

          if (conversionEvents.length > 0) {
            this.logger.log(`Found custom pixel conversion events: ${conversionEvents.join(', ')}`);
          }
        } catch (err: any) {
          this.logger.warn(`Failed to fetch pixel custom events: ${err.message}`);
        }
      }

      return conversionTypes;
    } catch (err: any) {
      this.logger.warn(`Failed to fetch custom conversions: ${err.message} — using standard events`);
      return STANDARD_EVENTS;
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

  enrichCampaign(
    campaign: any,
    accountId: string,
    accessToken: string,
    conversionTypes: Set<string>,
  ): Promise<any | null> {
    return this._enrichCampaign(campaign, accountId, accessToken, conversionTypes);
  }

  private async _enrichCampaign(
    campaign: any,
    accountId: string,
    accessToken: string,
    conversionTypes: Set<string>,
  ): Promise<any | null> {
    const [insightsRes, adSetsRes, adSetInsightsRes, adInsightsRes, demoRes, adsRes] = await Promise.all([
      axios.get(
        `${META_API_BASE}/${campaign.id}/insights?fields=spend,impressions,clicks,ctr,cpc,actions,frequency&date_preset=maximum&access_token=${accessToken}`,
        { timeout: 30000 },
      ).catch(() => ({ data: { data: [] } })),
      axios.get(
        `${META_API_BASE}/${campaign.id}/adsets?fields=name,targeting,optimization_goal,daily_budget&limit=20&access_token=${accessToken}`,
        { timeout: 30000 },
      ).catch(() => ({ data: { data: [] } })),
      axios.get(
        `${META_API_BASE}/${campaign.id}/insights?fields=adset_name,adset_id,spend,impressions,clicks,ctr,cpc,actions,frequency&level=adset&date_preset=maximum&access_token=${accessToken}`,
        { timeout: 30000 },
      ).catch(() => ({ data: { data: [] } })),
      axios.get(
        `${META_API_BASE}/${campaign.id}/insights?fields=ad_name,ad_id,spend,impressions,clicks,ctr,cpc,actions&level=ad&date_preset=maximum&access_token=${accessToken}`,
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
    "campaignName": "exact campaign name",
    "product": "which product this campaign sold (best guess from name/context)",
    "dateRange": "start - end date",
    "durationDays": number,
    "totalSpend": number in INR,
    "totalConversions": number,
    "context": "what was the market context — any seasonal event, trend, or competitor move that influenced this",
    "whatWorked": {
      "hooks": ["hook styles that performed (infer from ad names/copy)"],
      "audiences": ["audience types that converted"],
      "formats": ["ad formats that worked"],
      "bestCPA": lowest CPA number,
      "bestROAS": highest ROAS number
    },
    "whatFailed": {
      "hooks": ["hook styles that flopped"],
      "audiences": ["audiences that wasted budget"],
      "reason": "why it likely failed"
    },
    "lesson": "one sentence — the key takeaway for future campaigns"
  }
]

Rules:
- Only include campaigns with spend > ₹500
- Be specific about WHY something worked or failed — don't just say "it worked"
- Infer product from campaign name (e.g. "Nadi Report" → Nadi Report product)
- If you can't determine hook style from ad names, say "unknown"
- Keep each lesson to 1-2 sentences max`,
      maxTurns: 3,
    });

    try {
      const fenceMatch = result.content.match(/```json\s*([\s\S]*?)```/i);
      const jsonStr = fenceMatch
        ? fenceMatch[1].trim()
        : result.content.slice(result.content.indexOf('['), result.content.lastIndexOf(']') + 1);
      return JSON.parse(jsonStr);
    } catch {
      this.logger.warn('Failed to parse case studies JSON');
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
        return {
          name: ad.ad_name,
          spend: parseFloat(ad.spend ?? '0'),
          clicks: parseInt(ad.clicks ?? '0', 10),
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

  private extractConversions(actions: any[] | undefined, conversionTypes?: Set<string>): number {
    if (!actions || actions.length === 0) return 0;

    if (conversionTypes && conversionTypes.size > 0) {
      const customActions = actions.filter(
        a => a.action_type.startsWith('offsite_conversion.custom.') && conversionTypes.has(a.action_type),
      );
      if (customActions.length > 0) {
        return customActions.reduce((sum, a) => sum + parseInt(a.value ?? '0', 10), 0);
      }

      const STANDARD_EVENTS = new Set(['purchase', 'offsite_conversion.fb_pixel_purchase', 'lead',
        'offsite_conversion.fb_pixel_lead', 'complete_registration', 'submit_application', 'subscribe', 'start_trial']);

      const customEventActions = actions.filter(
        a => !a.action_type.startsWith('offsite_conversion.custom.')
          && !STANDARD_EVENTS.has(a.action_type)
          && conversionTypes.has(a.action_type),
      );
      if (customEventActions.length > 0) {
        return customEventActions.reduce((sum, a) => sum + parseInt(a.value ?? '0', 10), 0);
      }

      const PRIORITY = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'lead',
        'offsite_conversion.fb_pixel_lead', 'complete_registration', 'submit_application', 'subscribe', 'start_trial'];
      for (const type of PRIORITY) {
        if (!conversionTypes.has(type)) continue;
        const action = actions.find(a => a.action_type === type);
        if (action && parseInt(action.value ?? '0', 10) > 0) {
          return parseInt(action.value, 10);
        }
      }
    }

    return 0;
  }
}
