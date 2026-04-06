import { Injectable, Logger } from '@nestjs/common';

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

  // Hook performance
  hookPerformance: {
    style: string;
    avgCTR: number;
    avgCPA: number;
    adCount: number;
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
  ): ProductPatterns[] {
    const results: ProductPatterns[] = [];

    for (const product of products) {
      // Find campaigns that match this product (by name)
      const productCampaigns = enrichedCampaigns.filter(c =>
        c.name.toLowerCase().includes(product.name.toLowerCase()) ||
        c.name.toLowerCase().includes(product.name.split(' ')[0].toLowerCase()),
      );

      if (productCampaigns.length === 0) continue;

      const patterns = this.calculateForProduct(product, productCampaigns);
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
      );
      results.push(generalPatterns);
    }

    return results;
  }

  private calculateForProduct(
    product: { name: string; price: number },
    campaigns: any[],
  ): ProductPatterns {
    const allAds: any[] = [];
    const allAdSets: any[] = [];
    const allDemographics: any[] = [];
    let totalSpend = 0;
    let totalConversions = 0;

    for (const campaign of campaigns) {
      const insights = campaign.insights ?? {};
      const spend = parseFloat(insights.spend ?? '0');
      const conversions = this.extractConversions(insights.actions);
      totalSpend += spend;
      totalConversions += conversions;

      for (const ad of (campaign.adInsights ?? [])) {
        allAds.push({
          ...ad,
          campaignName: campaign.name,
          startTime: campaign.start_time,
        });
      }

      for (const adSet of (campaign.adSetInsights ?? [])) {
        allAdSets.push({
          ...adSet,
          campaignName: campaign.name,
        });
      }

      allDemographics.push(...(campaign.demographics ?? []));
    }

    const avgCPA = totalConversions > 0 ? totalSpend / totalConversions : 0;
    const avgROAS = totalSpend > 0 && product.price > 0
      ? (totalConversions * product.price) / totalSpend
      : 0;

    // Hook performance — infer hook style from ad name
    const hookPerformance = this.calculateHookPerformance(allAds);
    const bestHook = hookPerformance.sort((a, b) => b.avgCTR - a.avgCTR)[0];
    const worstHook = hookPerformance.sort((a, b) => a.avgCTR - b.avgCTR)[0];

    // Format performance — infer from ad/campaign names
    const formatPerformance = this.calculateFormatPerformance(allAds, totalConversions);
    const bestFormat = formatPerformance.sort((a, b) => b.conversionShare - a.conversionShare)[0];

    // Audience performance
    const audiencePerformance = this.calculateAudiencePerformance(allAdSets, product.price);
    const bestAudience = audiencePerformance.sort((a, b) => b.avgROAS - a.avgROAS)[0];

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
    const hookMap = new Map<string, { totalCTR: number; totalCPA: number; count: number; wins: number }>();

    for (const ad of ads) {
      const hookStyle = this.inferHookStyle(ad.ad_name ?? ad.name ?? '');
      const ctr = parseFloat(ad.ctr ?? '0');
      const spend = parseFloat(ad.spend ?? '0');
      const conversions = this.extractConversions(ad.actions);
      const cpa = conversions > 0 ? spend / conversions : 0;

      if (!hookMap.has(hookStyle)) {
        hookMap.set(hookStyle, { totalCTR: 0, totalCPA: 0, count: 0, wins: 0 });
      }
      const entry = hookMap.get(hookStyle)!;
      entry.totalCTR += ctr;
      entry.totalCPA += cpa;
      entry.count++;
    }

    // Calculate win rate (hooks with above-average CTR)
    const overallAvgCTR = ads.reduce((sum, a) => sum + parseFloat(a.ctr ?? '0'), 0) / (ads.length || 1);

    return Array.from(hookMap.entries()).map(([style, data]) => ({
      style,
      avgCTR: data.count > 0 ? data.totalCTR / data.count : 0,
      avgCPA: data.count > 0 ? data.totalCPA / data.count : 0,
      adCount: data.count,
      winRate: data.count > 0 ? (data.totalCTR / data.count > overallAvgCTR ? 1 : 0) * 100 : 0,
    }));
  }

  private calculateFormatPerformance(
    ads: any[],
    totalConversions: number,
  ): ProductPatterns['formatPerformance'] {
    const formatMap = new Map<string, { totalCTR: number; conversions: number; count: number }>();

    for (const ad of ads) {
      const format = this.inferFormat(ad.ad_name ?? ad.name ?? '', ad.campaignName ?? '');
      const ctr = parseFloat(ad.ctr ?? '0');
      const conversions = this.extractConversions(ad.actions);

      if (!formatMap.has(format)) {
        formatMap.set(format, { totalCTR: 0, conversions: 0, count: 0 });
      }
      const entry = formatMap.get(format)!;
      entry.totalCTR += ctr;
      entry.conversions += conversions;
      entry.count++;
    }

    return Array.from(formatMap.entries()).map(([format, data]) => ({
      format,
      conversionShare: totalConversions > 0 ? (data.conversions / totalConversions) * 100 : 0,
      avgCTR: data.count > 0 ? data.totalCTR / data.count : 0,
      adCount: data.count,
    }));
  }

  private calculateAudiencePerformance(
    adSets: any[],
    productPrice: number,
  ): ProductPatterns['audiencePerformance'] {
    const audienceMap = new Map<string, { totalSpend: number; totalConversions: number; count: number }>();

    for (const adSet of adSets) {
      const audienceType = this.inferAudienceType(adSet.adset_name ?? adSet.name ?? '');
      const spend = parseFloat(adSet.spend ?? '0');
      const conversions = this.extractConversions(adSet.actions);

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
      const conversions = this.extractConversions(d.actions);
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
      const conversions = this.extractConversions(c.insights?.actions);

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
      const dailyBudget = parseFloat(adSet.daily_budget ?? '0') / 100; // paise to rupees
      const spend = parseFloat(adSet.spend ?? '0');
      const conversions = this.extractConversions(adSet.actions);
      if (dailyBudget > 0 && conversions > 0) {
        budgetPerformance.push({ budget: dailyBudget, cpa: spend / conversions });
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

  // ─── Inference helpers ──────────────────────────────────────────────────────

  private inferHookStyle(adName: string): string {
    const lower = adName.toLowerCase();
    if (lower.includes('question') || lower.includes('kya') || lower.includes('?')) return 'question';
    if (lower.includes('bold') || lower.includes('claim') || lower.includes('fact')) return 'bold_claim';
    if (lower.includes('fear') || lower.includes('worry') || lower.includes('tension')) return 'fear_then_relief';
    if (lower.includes('story') || lower.includes('emotional') || lower.includes('personal')) return 'personal_story';
    if (lower.includes('social') || lower.includes('proof') || lower.includes('review')) return 'social_proof';
    if (lower.includes('ugc') || lower.includes('testimonial')) return 'ugc';
    return 'unknown';
  }

  private inferFormat(adName: string, campaignName: string): string {
    const combined = `${adName} ${campaignName}`.toLowerCase();
    if (combined.includes('reel')) return 'reel';
    if (combined.includes('carousel')) return 'carousel';
    if (combined.includes('story') || combined.includes('stories')) return 'story';
    if (combined.includes('video') || combined.includes('short')) return 'video';
    if (combined.includes('feed') || combined.includes('image')) return 'feed_image';
    return 'unknown';
  }

  private inferAudienceType(adSetName: string): string {
    const lower = adSetName.toLowerCase();
    if (lower.includes('lookalike') || lower.includes('lal')) return 'lookalike';
    if (lower.includes('advantage') || lower.includes('a+')) return 'advantage_plus';
    if (lower.includes('retarget') || lower.includes('remarket')) return 'retarget';
    if (lower.includes('interest') || lower.includes('inmarket')) return 'interest';
    if (lower.includes('broad')) return 'broad';
    if (lower.includes('performing')) return 'performing_export';
    if (lower.includes('custom')) return 'custom';
    return 'other';
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
