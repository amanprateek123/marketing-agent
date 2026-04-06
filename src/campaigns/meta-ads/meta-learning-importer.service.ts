import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import { ClaudeService } from '../../claude/claude.service';
import { AgentType } from '../../claude/claude.types';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { CampaignCaseStudy as CaseStudyModel, CampaignCaseStudyDocument } from '../schemas/campaign-case-study.schema';
import { PatternCalculatorService } from './pattern-calculator.service';
import { CompaniesService } from '../../companies/companies.service';

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

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
 * Flow:
 * 1. TypeScript pulls raw data from Meta API (all campaigns, ad sets, ads)
 * 2. TypeScript structures the data per campaign
 * 3. Claude generates case studies from the structured data
 * 4. Case studies stored in MongoDB (campaign_case_studies collection)
 * 5. Agents receive relevant case studies as context for decisions
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
  ) {}

  /**
   * Import all historical campaign data and generate case studies.
   * Call once on tenant registration, then monthly for refresh.
   */
  async importLearnings(
    company: CompanyDocument,
  ): Promise<{ campaignsProcessed: number; caseStudies: number }> {
    const tenantId = company.tenantId;

    if (!company.meta?.accessToken || !company.meta?.accountId) {
      throw new Error('Meta credentials not configured');
    }

    this.logger.log(`Starting Meta learning import for tenant: ${tenantId}`);

    // Step 1: Pull all campaign data from Meta
    const rawCampaigns = await this.pullAllCampaigns(
      company.meta.accountId,
      company.meta.accessToken,
    );

    this.logger.log(`Pulled ${rawCampaigns.length} campaigns from Meta`);

    if (rawCampaigns.length === 0) {
      return { campaignsProcessed: 0, caseStudies: 0 };
    }

    // Step 2: For each campaign, pull ad set + ad level data
    const enrichedCampaigns = [];
    for (const campaign of rawCampaigns) {
      try {
        const enriched = await this.enrichCampaign(
          campaign,
          company.meta.accountId,
          company.meta.accessToken,
        );
        if (enriched) enrichedCampaigns.push(enriched);
      } catch (err: any) {
        this.logger.warn(`Failed to enrich campaign ${campaign.id}: ${err.message}`);
      }
    }

    this.logger.log(`Enriched ${enrichedCampaigns.length} campaigns with ad-level data`);

    // Step 3: Calculate statistical patterns (TypeScript math, no Claude)
    const products = (company.products ?? []).filter(p => p.active).map(p => ({
      name: p.name,
      price: p.price,
    }));

    const productPatterns = this.patternCalculator.calculatePatterns(enrichedCampaigns, products);

    // Save patterns to company.learnings
    if (productPatterns.length > 0) {
      const bestPattern = productPatterns[0]; // primary product
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

    // Step 4: Claude generates case studies from structured data
    // Process in batches of 10 to avoid token limits
    const allCaseStudies: CampaignCaseStudy[] = [];
    const batchSize = 10;

    for (let i = 0; i < enrichedCampaigns.length; i += batchSize) {
      const batch = enrichedCampaigns.slice(i, i + batchSize);
      const caseStudies = await this.generateCaseStudies(batch, company);
      allCaseStudies.push(...caseStudies);
    }

    // Step 4: Save to MongoDB (replace existing for this tenant)
    await this.caseStudyModel.deleteMany({ tenantId });
    if (allCaseStudies.length > 0) {
      await this.caseStudyModel.insertMany(
        allCaseStudies.map(cs => ({ ...cs, tenantId })),
      );
    }

    this.logger.log(
      `Learning import complete: tenant=${tenantId} campaigns=${enrichedCampaigns.length} caseStudies=${allCaseStudies.length}`,
    );

    return {
      campaignsProcessed: enrichedCampaigns.length,
      caseStudies: allCaseStudies.length,
    };
  }

  /**
   * Get relevant case studies for a given context (product, topic, audience).
   * Used by agents to get historical context for decisions.
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

    // If keyword filter, do basic text matching
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

  private async pullAllCampaigns(
    accountId: string,
    accessToken: string,
  ): Promise<any[]> {
    const allCampaigns: any[] = [];
    let url = `${META_API_BASE}/${accountId}/campaigns?fields=name,status,objective,start_time,stop_time,daily_budget,lifetime_budget&limit=50&access_token=${accessToken}`;

    while (url) {
      const response = await axios.get(url, { timeout: 30000 });
      const data = response.data;
      allCampaigns.push(...(data.data ?? []));
      url = data.paging?.next ?? null;
    }

    return allCampaigns;
  }

  private async enrichCampaign(
    campaign: any,
    accountId: string,
    accessToken: string,
  ): Promise<any | null> {
    // Get campaign-level insights
    const insightsRes = await axios.get(
      `${META_API_BASE}/${campaign.id}/insights?fields=spend,impressions,clicks,ctr,cpc,actions,frequency&date_preset=maximum&access_token=${accessToken}`,
      { timeout: 30000 },
    ).catch(() => ({ data: { data: [] } }));

    const insights = insightsRes.data?.data?.[0];
    if (!insights || parseFloat(insights.spend ?? '0') === 0) return null;

    // Get ad set level data
    const adSetsRes = await axios.get(
      `${META_API_BASE}/${campaign.id}/adsets?fields=name,targeting,optimization_goal,daily_budget&limit=20&access_token=${accessToken}`,
      { timeout: 30000 },
    ).catch(() => ({ data: { data: [] } }));

    // Get ad set insights
    const adSetInsightsRes = await axios.get(
      `${META_API_BASE}/${campaign.id}/insights?fields=adset_name,adset_id,spend,impressions,clicks,ctr,cpc,actions,frequency&level=adset&date_preset=maximum&access_token=${accessToken}`,
      { timeout: 30000 },
    ).catch(() => ({ data: { data: [] } }));

    // Get ad level insights
    const adInsightsRes = await axios.get(
      `${META_API_BASE}/${campaign.id}/insights?fields=ad_name,ad_id,spend,impressions,clicks,ctr,cpc,actions&level=ad&date_preset=maximum&access_token=${accessToken}`,
      { timeout: 30000 },
    ).catch(() => ({ data: { data: [] } }));

    // Get demographic breakdown
    const demoRes = await axios.get(
      `${META_API_BASE}/${campaign.id}/insights?fields=spend,actions&breakdowns=age,gender&date_preset=maximum&access_token=${accessToken}`,
      { timeout: 30000 },
    ).catch(() => ({ data: { data: [] } }));

    return {
      ...campaign,
      insights,
      adSets: adSetsRes.data?.data ?? [],
      adSetInsights: adSetInsightsRes.data?.data ?? [],
      adInsights: adInsightsRes.data?.data ?? [],
      demographics: demoRes.data?.data ?? [],
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
      agentType: AgentType.MARKET_RESEARCH, // using Haiku for cost efficiency
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
    const conversions = this.extractConversions(insights.actions);

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
        conversions: this.extractConversions(as.actions),
        frequency: parseFloat(as.frequency ?? '0'),
      })),
      ads: (campaign.adInsights ?? []).map((ad: any) => ({
        name: ad.ad_name,
        spend: parseFloat(ad.spend ?? '0'),
        clicks: parseInt(ad.clicks ?? '0', 10),
        ctr: parseFloat(ad.ctr ?? '0'),
        conversions: this.extractConversions(ad.actions),
      })),
      topDemographics: (campaign.demographics ?? [])
        .filter((d: any) => this.extractConversions(d.actions) > 0)
        .sort((a: any, b: any) => this.extractConversions(b.actions) - this.extractConversions(a.actions))
        .slice(0, 5)
        .map((d: any) => ({
          age: d.age,
          gender: d.gender,
          conversions: this.extractConversions(d.actions),
          spend: parseFloat(d.spend ?? '0'),
        })),
    };
  }

  private extractConversions(actions: any[] | undefined): number {
    if (!actions) return 0;
    const purchase = actions.find(
      (a: any) => a.action_type === 'purchase' ||
        a.action_type === 'offsite_conversion.fb_pixel_purchase' ||
        a.action_type === 'offsite_conversion',
    );
    return parseInt(purchase?.value ?? '0', 10);
  }
}
