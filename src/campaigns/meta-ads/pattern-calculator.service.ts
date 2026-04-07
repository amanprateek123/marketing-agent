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

    // Hook performance — infer hook style from ad name + copy body
    const hookPerformance = this.calculateHookPerformance(allAds);
    const sortedHooksByCtr = [...hookPerformance].sort((a, b) => b.avgCTR - a.avgCTR);
    const bestHook = sortedHooksByCtr[0];
    const winningHookStyles = new Set(sortedHooksByCtr.slice(0, 3).map(h => h.style));
    const worstHook = [...hookPerformance]
      .filter(h => h.adCount >= 3 && !winningHookStyles.has(h.style))
      .sort((a, b) => a.avgCTR - b.avgCTR)[0] ?? null;

    // Format performance — creative type from Meta + adset-level conversions (accurate)
    const formatPerformance = this.calculateFormatPerformance(allAdSets, totalConversions);
    const sortedFormats = [...formatPerformance].sort((a, b) => b.conversionShare - a.conversionShare);
    const bestFormat = sortedFormats[0];
    const winningFormats = new Set(sortedFormats.slice(0, 2).map(f => f.format));

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
      const hookStyle = this.inferHookStyle(ad.ad_name ?? ad.name ?? '', ad.copyBody, ad.copyTitle);
      const ctr = parseFloat(ad.ctr ?? '0');
      const spend = parseFloat(ad.spend ?? '0');
      const conversions = this.extractConversions(ad.actions, ad.conversionTypes);
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
   */
  private inferFormatFromCreative(creative: any, adName: string): string {
    if (!creative) return this.inferFormat(adName, '');

    const spec = creative.object_story_spec;
    if (spec?.video_data) return 'video';
    if (spec?.link_data?.child_attachments?.length > 0) return 'carousel';
    if (spec?.link_data) return 'image';

    // creative.title/body present but no spec — likely a story or reel
    // Fall back to name inference
    return this.inferFormat(adName, '');
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

  // ─── Inference helpers ──────────────────────────────────────────────────────

  private inferHookStyle(adName: string, copyBody?: string, copyTitle?: string): string {
    const combined = `${adName} ${copyBody ?? ''} ${copyTitle ?? ''}`.toLowerCase();

    // UGC / testimonial — check first as most specific
    if (/ugc|testimonial|real customer|actual customer|meri kahani|mere saath hua|meri story/.test(combined)) return 'ugc';

    // Social proof — numbers, ratings, reviews
    if (/\d+[\s,]*(?:lakh|lac|k|thousand|crore)\+?\s*(?:customer|log|review|order)|(?:4\.\d|5\.0)\s*(?:star|rating)|top rated|best seller|#1/.test(combined)) return 'social_proof';

    // Question hook
    if (/\?|kya aap|kya aapka|kya ho|kyun|kaise|kitna|kaun sa|kab|kya pata|jaante hain|did you know|are you|do you|have you/.test(combined)) return 'question';

    // Fear / problem → relief
    if (/problem|pareshaan|tension|dard|struggle|pareshan|takleef|mushkil|worry|anxious|scared|dar|bhay|crisis|failed|fail|negative|dosha|dosh|pap|grahan|sade sati|dhaiya/.test(combined)) return 'fear_then_relief';

    // Curiosity / secret / reveal
    if (/secret|hidden|jaano|discover|pata karo|reveal|untold|exclusive|insider|raaz|chhupayi|ankhon|khulasa/.test(combined)) return 'curiosity';

    // Urgency / scarcity
    if (/sirf aaj|limited|abhi|last chance|offer ends|hurry|jaldi|kal se|today only|expir|deadline|closing/.test(combined)) return 'urgency';

    // Bold claim / fact
    if (/guaranteed|100%|proven|scientific|authentic|original|genuine|sabse|best|number 1|#1|padh|fact|research|study|data/.test(combined)) return 'bold_claim';

    // Personal story / emotional
    if (/meri|mera|mere|maine|hamari|hamare|ek din|ek baar|my story|i was|i am|when i|my life|personal|changed my/.test(combined)) return 'personal_story';

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

  private extractConversions(actions: any[] | undefined, conversionTypes?: Set<string>): number {
    if (!actions || actions.length === 0) return 0;

    if (conversionTypes && conversionTypes.size > 0) {
      // Custom conversions first (offsite_conversion.custom.*)
      const customActions = actions.filter(
        a => a.action_type.startsWith('offsite_conversion.custom.') && conversionTypes.has(a.action_type),
      );
      if (customActions.length > 0) {
        return customActions.reduce((sum, a) => sum + parseInt(a.value ?? '0', 10), 0);
      }

      // Step 2: Custom pixel event names (e.g. NADI_REPORT_PURCHASE_COMPLETED)
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

      // Step 3: Standard events fallback — priority order
      const PRIORITY = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'lead',
        'offsite_conversion.fb_pixel_lead', 'complete_registration', 'submit_application', 'subscribe', 'start_trial'];
      for (const type of PRIORITY) {
        if (!conversionTypes.has(type)) continue;
        const action = actions.find(a => a.action_type === type);
        if (action && parseInt(action.value ?? '0', 10) > 0) return parseInt(action.value, 10);
      }
    }

    return 0;
  }
}
