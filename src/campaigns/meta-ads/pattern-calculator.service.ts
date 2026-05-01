import { Injectable, Logger } from '@nestjs/common';
import { extractConversions } from './conversion-extractor.util';
import {
  inferHookStyleFromCopy,
  inferAudienceType as sharedInferAudienceType,
  inferFormatFromCreative as sharedInferFormatFromCreative,
  computeUnknownRatio,
} from '../../common/creative/hook-inference.util';
import { wilsonLowerBound, inverseNormalCdf } from '../../common/statistics/bayesian-estimator.util';

/**
 * PatternCalculator — pure TypeScript math, no Claude.
 *
 * Takes raw campaign/ad-set/ad data from Meta and calculates
 * statistical patterns per product. No hallucination risk.
 *
 * Output feeds into company.learnings for prompt injection.
 */

export interface ProductPatterns {
  product: string;
  totalCampaigns: number;
  totalConversions: number;
  totalSpend: number;
  avgCPA: number;
  avgROAS: number;

  // Hook performance — now includes Wilson LB on impressions-weighted CTR
  // (was: simple avgCTR sort that ranked 1-ad outliers above 50-ad workhorses)
  hookPerformance: {
    style: string;
    avgCTR: number;          // impressions-weighted (Σclicks/Σimpressions) — was unweighted before
    lowerCTR: number;        // Wilson 95% lower bound on the impressions-weighted CTR (Bonferroni-corrected z)
    avgCPA: number;
    adCount: number;
    totalImpressions: number;
    totalClicks: number;
    winRate: number;       // % of times this hook beat the ad-set average
  }[];
  bestHookStyle: string | null;
  worstHookStyle: string | null;

  // Format performance
  formatPerformance: {
    format: string;
    conversionShare: number;  // % of total conversions
    avgCTR: number;
    adCount: number;
  }[];
  bestFormat: string | null;

  // Audience performance
  audiencePerformance: {
    audienceType: string;
    avgROAS: number;
    avgCPA: number;
    totalConversions: number;
    adSetCount: number;
  }[];
  bestAudience: string | null;

  // Demographic insights
  topDemographic: {
    age: string;
    gender: string;
    conversionShare: number;
    avgCPA: number;
  } | null;

  // Seasonal patterns
  monthlyPerformance: {
    month: number;       // 0-11
    monthName: string;
    avgROAS: number;
    totalConversions: number;
    campaignCount: number;
  }[];
  seasonalPeaks: string[];

  // Budget insights
  optimalDailyBudget: number | null;
  budgetInsights: string[];

  // Confidence
  confidenceLevel: 'low' | 'medium' | 'high';
}

@Injectable()
export class PatternCalculatorService {
  private readonly logger = new Logger(PatternCalculatorService.name);

  /**
   * Calculate patterns from raw Meta campaign data.
   * Returns patterns grouped by product.
   */
  calculatePatterns(
    enrichedCampaigns: any[],
    products: { name: string; price: number }[],
    conversionTypes?: Set<string>,
  ): ProductPatterns[] {
    const results: ProductPatterns[] = [];

    for (const product of products) {
      // Prefer detectedProduct (from promoted_object), fall back to name matching
      const productCampaigns = enrichedCampaigns.filter(c => {
        if (c.detectedProduct && c.detectedProduct !== 'unknown') {
          return (
            c.detectedProduct === product.name ||
            c.detectedProduct.toLowerCase().includes(product.name.toLowerCase().split(' ')[0])
          );
        }
        return (
          c.name.toLowerCase().includes(product.name.toLowerCase()) ||
          c.name.toLowerCase().includes(product.name.split(' ')[0].toLowerCase())
        );
      });

      if (productCampaigns.length === 0) continue;

      const patterns = this.calculateForProduct(product, productCampaigns, conversionTypes);
      results.push(patterns);
    }

    // Handle campaigns that don't match any product
    const unmatchedCampaigns = enrichedCampaigns.filter(c =>
      !products.some(p =>
        c.name.toLowerCase().includes(p.name.toLowerCase()) ||
        c.name.toLowerCase().includes(p.name.split(' ')[0].toLowerCase()),
      ),
    );

    if (unmatchedCampaigns.length > 0) {
      const generalPatterns = this.calculateForProduct(
        { name: 'General', price: 0 },
        unmatchedCampaigns,
        conversionTypes,
      );
      results.push(generalPatterns);
    }

    return results;
  }

  private calculateForProduct(
    product: { name: string; price: number },
    campaigns: any[],
    conversionTypes?: Set<string>,
  ): ProductPatterns {
    const allAds: any[] = [];
    const allAdSets: any[] = [];
    const allDemographics: any[] = [];
    let totalSpend = 0;
    let totalConversions = 0;

    for (const campaign of campaigns) {
      const insights = campaign.insights ?? {};
      const spend = parseFloat(insights.spend ?? '0');
      const campaignConvTypes = campaign.conversionTypes ?? conversionTypes;
      const conversions = this.extractConversions(insights.actions, campaignConvTypes);
      totalSpend += spend;
      totalConversions += conversions;

      for (const ad of (campaign.adInsights ?? [])) {
        // Join with creative data to get copy body for hook inference
        const creative = (campaign.ads ?? []).find((a: any) => a.name === ad.ad_name);
        const copyBody = creative?.creative?.body
          ?? creative?.creative?.object_story_spec?.link_data?.message
          ?? creative?.creative?.object_story_spec?.video_data?.message
          ?? '';
        const copyTitle = creative?.creative?.title
          ?? creative?.creative?.object_story_spec?.link_data?.name
          ?? '';
        allAds.push({
          ...ad,
          campaignName: campaign.name,
          startTime: campaign.start_time,
          conversionTypes: campaignConvTypes,
          copyBody,
          copyTitle,
        });
      }

      for (const adSet of (campaign.adSetInsights ?? [])) {
        // Attach ad creatives for this adset so format can be detected from creative type
        const adSetAds = (campaign.adInsights ?? []).map((ad: any) => {
          const creative = (campaign.ads ?? []).find((a: any) => a.name === ad.ad_name);
          return {
            ...ad,
            creative: creative?.creative ?? null,
            ctr: parseFloat(ad.ctr ?? '0'),
          };
        });
        allAdSets.push({
          ...adSet,
          campaignName: campaign.name,
          conversionTypes: campaignConvTypes,
          ads: adSetAds,
        });
      }

      allDemographics.push(...(campaign.demographics ?? []).map((d: any) => ({ ...d, conversionTypes: campaignConvTypes })));
    }

    const avgCPA = totalConversions > 0 ? totalSpend / totalConversions : 0;
    const avgROAS = totalSpend > 0 && product.price > 0
      ? (totalConversions * product.price) / totalSpend
      : 0;

    // Hook performance — infer hook style from ad name + copy body, then rank
    // by Wilson lower bound on impressions-weighted CTR (Bonferroni-corrected
    // for the cohort size). Was: raw avgCTR sort with no min-N floor → a 1-ad
    // outlier at 4% CTR could beat a 50-ad workhorse at 3.5%. Day-7 quick scan
    // got this same treatment in commit a916f64; mirroring it here so the seed
    // learnings use the same statistical guards as the ongoing learning loop.
    const hookPerformance = this.calculateHookPerformance(allAds);
    const HOOK_MIN_AD_COUNT = 5;
    const HOOK_MIN_IMPRESSIONS = 1500;
    const eligibleHooks = hookPerformance.filter(
      h => h.style !== 'unknown' && h.adCount >= HOOK_MIN_AD_COUNT && h.totalImpressions >= HOOK_MIN_IMPRESSIONS,
    );
    const sortedHooksByLB = [...eligibleHooks].sort((a, b) => b.lowerCTR - a.lowerCTR);
    const bestHook = sortedHooksByLB[0];
    const winningHookStyles = new Set(sortedHooksByLB.slice(0, 3).map(h => h.style));
    const worstHook = eligibleHooks
      .filter(h => !winningHookStyles.has(h.style))
      .sort((a, b) => a.lowerCTR - b.lowerCTR)[0] ?? null;

    // Format performance — creative type from Meta + adset-level conversions (accurate)
    const formatPerformance = this.calculateFormatPerformance(allAdSets, totalConversions);
    const sortedFormats = [...formatPerformance].sort((a, b) => b.conversionShare - a.conversionShare);
    const bestFormat = sortedFormats[0];
    const winningFormats = new Set(sortedFormats.slice(0, 2).map(f => f.format));

    // Audience performance — bestAudience now requires min ad-set count to
    // qualify. Was: a `lookalike` with 2 ad sets and 8 lucky conversions
    // ranked above `broad` with 40 ad sets and 200 conversions.
    const audiencePerformance = this.calculateAudiencePerformance(allAdSets, product.price);
    const AUDIENCE_MIN_ADSET_COUNT = 3;
    const eligibleAudiences = audiencePerformance.filter(
      a => a.audienceType !== 'other' && a.adSetCount >= AUDIENCE_MIN_ADSET_COUNT,
    );
    const bestAudience = eligibleAudiences.sort((a, b) => b.avgROAS - a.avgROAS)[0]
                       ?? audiencePerformance.sort((a, b) => b.avgROAS - a.avgROAS)[0];   // fallback when no audience meets floor

    // Demographics
    const topDemographic = this.calculateTopDemographic(allDemographics);

    // Seasonal patterns
    const monthlyPerformance = this.calculateMonthlyPerformance(campaigns, product.price);
    const seasonalPeaks = monthlyPerformance
      .filter(m => m.avgROAS > avgROAS * 1.3) // months with 30%+ above average
      .map(m => m.monthName);

    // Budget insights
    const { optimalBudget, insights: budgetInsights } = this.calculateBudgetInsights(allAdSets);

    // Confidence
    const confidenceLevel = totalConversions >= 100 ? 'high'
      : totalConversions >= 30 ? 'medium'
      : 'low';

    this.logger.log(
      `Patterns for ${product.name}: ${campaigns.length} campaigns, ${totalConversions} conversions, confidence: ${confidenceLevel}`,
    );

    return {
      product: product.name,
      totalCampaigns: campaigns.length,
      totalConversions,
      totalSpend,
      avgCPA,
      avgROAS,
      hookPerformance,
      bestHookStyle: bestHook?.style ?? null,
      worstHookStyle: worstHook?.style ?? null,
      formatPerformance,
      bestFormat: bestFormat?.format ?? null,
      audiencePerformance,
      bestAudience: bestAudience?.audienceType ?? null,
      topDemographic,
      monthlyPerformance,
      seasonalPeaks,
      optimalDailyBudget: optimalBudget,
      budgetInsights,
      confidenceLevel,
    };
  }

  private calculateHookPerformance(ads: any[]): ProductPatterns['hookPerformance'] {
    // Now tracks Σimpressions + Σclicks per hook (was: sum of per-ad CTR
    // averages, which weighted a 100-impression outlier identically to a
    // 100k-impression workhorse). Wilson lower bound on the impressions-
    // weighted rate gives a defensible "is this hook actually winning"
    // signal at small N.
    type HookAgg = {
      totalClicks: number;
      totalImpressions: number;
      totalSpend: number;
      totalConversions: number;
      count: number;
    };
    const hookMap = new Map<string, HookAgg>();

    for (const ad of ads) {
      const hookStyle = this.inferHookStyle(ad.ad_name ?? ad.name ?? '', ad.copyBody, ad.copyTitle);
      const impressions = parseFloat(ad.impressions ?? '0');
      const clicks = parseFloat(ad.clicks ?? '0');
      const spend = parseFloat(ad.spend ?? '0');
      const conversions = this.extractConversions(ad.actions, ad.conversionTypes);

      if (!hookMap.has(hookStyle)) {
        hookMap.set(hookStyle, { totalClicks: 0, totalImpressions: 0, totalSpend: 0, totalConversions: 0, count: 0 });
      }
      const entry = hookMap.get(hookStyle)!;
      entry.totalClicks += clicks;
      entry.totalImpressions += impressions;
      entry.totalSpend += spend;
      entry.totalConversions += conversions;
      entry.count++;
    }

    // Bonferroni z — z scales with k = #hookStyles being compared so the
    // family-wise error stays at α=0.05. At k=7 (canonical DR taxonomy),
    // z ≈ 2.45; at k=10, z ≈ 2.56. inverseNormalCdf clamps gracefully.
    const k = Math.max(hookMap.size, 1);
    const zCorrected = inverseNormalCdf(1 - 0.05 / (2 * k));

    // Pooled-CTR baseline for winRate (impressions-weighted, not the broken
    // unweighted mean we used before).
    const totalImps = ads.reduce((s, a) => s + parseFloat(a.impressions ?? '0'), 0);
    const totalClk = ads.reduce((s, a) => s + parseFloat(a.clicks ?? '0'), 0);
    const overallCtr = totalImps > 0 ? (totalClk / totalImps) * 100 : 0;

    return Array.from(hookMap.entries()).map(([style, data]) => {
      const avgCTR = data.totalImpressions > 0 ? (data.totalClicks / data.totalImpressions) * 100 : 0;
      const avgCPA = data.totalConversions > 0 ? data.totalSpend / data.totalConversions : 0;
      const lowerCTR = wilsonLowerBound(data.totalClicks, data.totalImpressions, zCorrected) * 100;
      return {
        style,
        avgCTR,
        lowerCTR,
        avgCPA,
        adCount: data.count,
        totalImpressions: data.totalImpressions,
        totalClicks: data.totalClicks,
        winRate: avgCTR > overallCtr ? 100 : 0,
      };
    });
  }

  private calculateFormatPerformance(
    adSets: any[],
    totalConversions: number,
  ): ProductPatterns['formatPerformance'] {
    const formatMap = new Map<string, { totalCTR: number; conversions: number; count: number }>();

    for (const adSet of adSets) {
      const adSetConversions = this.extractConversions(adSet.actions, adSet.conversionTypes);
      const ads: any[] = adSet.ads ?? [];

      if (ads.length === 0) {
        // No ads joined — fall back to adset name for format
        const format = this.inferFormat(adSet.adset_name ?? adSet.name ?? '', adSet.campaignName ?? '');
        const ctr = parseFloat(adSet.ctr ?? '0');
        if (!formatMap.has(format)) formatMap.set(format, { totalCTR: 0, conversions: 0, count: 0 });
        const entry = formatMap.get(format)!;
        entry.totalCTR += ctr;
        entry.conversions += adSetConversions;
        entry.count++;
        continue;
      }

      // Detect format from creative type (definitive — not name inference)
      // Then distribute adset conversions proportionally by CTR share within adset
      const totalCTRInAdSet = ads.reduce((sum, a) => sum + (a.ctr ?? 0), 0);

      for (const ad of ads) {
        const format = this.inferFormatFromCreative(ad.creative, ad.ad_name ?? '');
        const ctr = ad.ctr ?? 0;
        const ctrShare = totalCTRInAdSet > 0 ? ctr / totalCTRInAdSet : 1 / ads.length;
        const attributedConversions = adSetConversions * ctrShare;

        if (!formatMap.has(format)) formatMap.set(format, { totalCTR: 0, conversions: 0, count: 0 });
        const entry = formatMap.get(format)!;
        entry.totalCTR += ctr;
        entry.conversions += attributedConversions;
        entry.count++;
      }
    }

    return Array.from(formatMap.entries()).map(([format, data]) => ({
      format,
      conversionShare: totalConversions > 0 ? (data.conversions / totalConversions) * 100 : 0,
      avgCTR: data.count > 0 ? data.totalCTR / data.count : 0,
      adCount: data.count,
    }));
  }

  /**
   * Detect format from creative object type — definitive, not inferred from name.
   * Delegated to shared util so the same logic runs in pattern-calculator,
   * campaign-sync, and case-study summarization.
   */
  private inferFormatFromCreative(creative: any, adName: string): string {
    return sharedInferFormatFromCreative(creative, adName);
  }

  private calculateAudiencePerformance(
    adSets: any[],
    productPrice: number,
  ): ProductPatterns['audiencePerformance'] {
    const audienceMap = new Map<string, { totalSpend: number; totalConversions: number; count: number }>();

    for (const adSet of adSets) {
      const audienceType = this.inferAudienceType(adSet.adset_name ?? adSet.name ?? '');
      const spend = parseFloat(adSet.spend ?? '0');
      const conversions = this.extractConversions(adSet.actions, adSet.conversionTypes);

      if (!audienceMap.has(audienceType)) {
        audienceMap.set(audienceType, { totalSpend: 0, totalConversions: 0, count: 0 });
      }
      const entry = audienceMap.get(audienceType)!;
      entry.totalSpend += spend;
      entry.totalConversions += conversions;
      entry.count++;
    }

    return Array.from(audienceMap.entries()).map(([audienceType, data]) => ({
      audienceType,
      avgROAS: data.totalSpend > 0 && productPrice > 0
        ? (data.totalConversions * productPrice) / data.totalSpend
        : 0,
      avgCPA: data.totalConversions > 0 ? data.totalSpend / data.totalConversions : 0,
      totalConversions: data.totalConversions,
      adSetCount: data.count,
    }));
  }

  private calculateTopDemographic(demographics: any[]): ProductPatterns['topDemographic'] {
    if (demographics.length === 0) return null;

    const demoMap = new Map<string, { conversions: number; spend: number }>();

    for (const d of demographics) {
      const key = `${d.gender}_${d.age}`;
      const conversions = this.extractConversions(d.actions, d.conversionTypes);
      const spend = parseFloat(d.spend ?? '0');

      if (!demoMap.has(key)) {
        demoMap.set(key, { conversions: 0, spend: 0 });
      }
      const entry = demoMap.get(key)!;
      entry.conversions += conversions;
      entry.spend += spend;
    }

    const totalConversions = Array.from(demoMap.values()).reduce((s, d) => s + d.conversions, 0);
    if (totalConversions === 0) return null;

    let bestKey = '';
    let bestConversions = 0;
    for (const [key, data] of demoMap.entries()) {
      if (data.conversions > bestConversions) {
        bestConversions = data.conversions;
        bestKey = key;
      }
    }

    if (!bestKey) return null;
    const [gender, age] = bestKey.split('_');
    const bestData = demoMap.get(bestKey)!;

    return {
      age,
      gender,
      conversionShare: (bestConversions / totalConversions) * 100,
      avgCPA: bestConversions > 0 ? bestData.spend / bestConversions : 0,
    };
  }

  private calculateMonthlyPerformance(
    campaigns: any[],
    productPrice: number,
  ): ProductPatterns['monthlyPerformance'] {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthMap = new Map<number, { totalSpend: number; totalConversions: number; count: number }>();

    for (const c of campaigns) {
      if (!c.start_time) continue;
      const month = new Date(c.start_time).getMonth();
      const spend = parseFloat(c.insights?.spend ?? '0');
      const conversions = this.extractConversions(c.insights?.actions, c.conversionTypes);

      if (!monthMap.has(month)) {
        monthMap.set(month, { totalSpend: 0, totalConversions: 0, count: 0 });
      }
      const entry = monthMap.get(month)!;
      entry.totalSpend += spend;
      entry.totalConversions += conversions;
      entry.count++;
    }

    return Array.from(monthMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([month, data]) => ({
        month,
        monthName: monthNames[month],
        avgROAS: data.totalSpend > 0 && productPrice > 0
          ? (data.totalConversions * productPrice) / data.totalSpend
          : 0,
        totalConversions: data.totalConversions,
        campaignCount: data.count,
      }));
  }

  private calculateBudgetInsights(
    adSets: any[],
  ): { optimalBudget: number | null; insights: string[] } {
    const insights: string[] = [];
    const budgetPerformance: { budget: number; cpa: number }[] = [];

    for (const adSet of adSets) {
      // daily_budget and lifetime_budget come in paise — divide by 100 for rupees
      // Prefer daily_budget; fall back to lifetime_budget / 30 (daily equivalent)
      const dailyBudgetRaw = parseFloat(adSet.daily_budget ?? '0');
      const lifetimeBudgetRaw = parseFloat(adSet.lifetime_budget ?? '0');
      const budget = dailyBudgetRaw > 0
        ? dailyBudgetRaw / 100
        : lifetimeBudgetRaw > 0
          ? lifetimeBudgetRaw / 100 / 30
          : 0;

      const spend = parseFloat(adSet.spend ?? '0');
      const conversions = this.extractConversions(adSet.actions, adSet.conversionTypes);
      if (budget > 0 && conversions > 0) {
        budgetPerformance.push({ budget, cpa: spend / conversions });
      } else if (conversions > 0 && spend > 0) {
        // No budget set on ad set (campaign-level budget) — use spend as proxy
        budgetPerformance.push({ budget: spend, cpa: spend / conversions });
      }
    }

    if (budgetPerformance.length === 0) {
      return { optimalBudget: null, insights: ['Not enough data for budget insights'] };
    }

    // Find budget range with lowest CPA
    budgetPerformance.sort((a, b) => a.cpa - b.cpa);
    const bestBudget = budgetPerformance[0];

    // Group into budget ranges
    const lowBudget = budgetPerformance.filter(b => b.budget < 3000);
    const midBudget = budgetPerformance.filter(b => b.budget >= 3000 && b.budget < 10000);
    const highBudget = budgetPerformance.filter(b => b.budget >= 10000);

    const avgCPA = (arr: typeof budgetPerformance) =>
      arr.length > 0 ? arr.reduce((s, b) => s + b.cpa, 0) / arr.length : 0;

    if (lowBudget.length > 0 && midBudget.length > 0) {
      const lowAvg = avgCPA(lowBudget);
      const midAvg = avgCPA(midBudget);
      if (lowAvg < midAvg * 0.8) {
        insights.push(`Low budgets (< ₹3K/day) have ${Math.round((1 - lowAvg / midAvg) * 100)}% lower CPA than mid-range`);
      } else if (midAvg < lowAvg * 0.8) {
        insights.push(`Mid-range budgets (₹3K-10K/day) have ${Math.round((1 - midAvg / lowAvg) * 100)}% lower CPA than low budgets`);
      }
    }

    if (highBudget.length > 0) {
      const highAvg = avgCPA(highBudget);
      const overallAvg = avgCPA(budgetPerformance);
      if (highAvg > overallAvg * 1.5) {
        insights.push(`High budgets (> ₹10K/day) have ${Math.round((highAvg / overallAvg - 1) * 100)}% higher CPA — start smaller`);
      }
    }

    return {
      optimalBudget: bestBudget?.budget ?? null,
      insights,
    };
  }

  // ─── Inference helpers (delegated to shared util — single source of truth) ─

  private inferHookStyle(adName: string, copyBody?: string, copyTitle?: string): string {
    return inferHookStyleFromCopy(adName, copyBody, copyTitle);
  }

  private inferFormat(adName: string, campaignName: string): string {
    return sharedInferFormatFromCreative(null, `${adName} ${campaignName}`);
  }

  private inferAudienceType(adSetName: string): string {
    return sharedInferAudienceType(adSetName);
  }

  private extractConversions(actions: any[] | undefined, conversionTypes?: Set<string>): number {
    return extractConversions(actions, conversionTypes);
  }
}
