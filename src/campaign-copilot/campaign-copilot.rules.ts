import { CompanyDocument } from '../companies/schemas/company.schema';
import { MetaAudience, Product } from '../companies/schemas/company.types';
import {
  CANONICAL_LANGUAGES,
  normaliseLanguage,
} from '../common/creative/language-utils';
import {
  CampaignCopilotAudienceRecommendation,
  CampaignCopilotAudienceType,
  CampaignCopilotCreativeFormat,
  CampaignCopilotFunnelStage,
  CampaignCopilotObjective,
  CampaignCopilotPlan,
  CampaignCopilotReadiness,
  CampaignCopilotRecommendations,
} from './campaign-copilot.contracts';

export const COPILOT_OBJECTIVE_TO_META: Record<
  CampaignCopilotObjective,
  string
> = {
  sales_purchase: 'OUTCOME_SALES',
  leads: 'OUTCOME_LEADS',
  traffic: 'OUTCOME_TRAFFIC',
  engagement: 'OUTCOME_ENGAGEMENT',
  awareness: 'OUTCOME_AWARENESS',
  reach: 'OUTCOME_AWARENESS',
  app_promotion: 'OUTCOME_APP_PROMOTION',
};

export const COPILOT_OPTIMIZATION_GOAL: Record<
  CampaignCopilotObjective,
  string
> = {
  sales_purchase: 'OFFSITE_CONVERSIONS',
  leads: 'OFFSITE_CONVERSIONS',
  traffic: 'LANDING_PAGE_VIEWS',
  engagement: 'POST_ENGAGEMENT',
  awareness: 'AD_RECALL_LIFT',
  reach: 'REACH',
  app_promotion: 'APP_INSTALLS',
};

const OBJECTIVES = new Set<CampaignCopilotObjective>([
  'sales_purchase',
  'leads',
  'traffic',
  'engagement',
  'awareness',
  'reach',
  'app_promotion',
]);

const FUNNEL_STAGES = new Set<CampaignCopilotFunnelStage>([
  'cold',
  'warm',
  'hot',
]);

const AUDIENCE_TYPES = new Set<CampaignCopilotAudienceType>([
  'advantage_plus',
  'lookalike',
  'retarget',
  'custom',
]);

const CREATIVE_FORMATS = new Set<CampaignCopilotCreativeFormat>([
  'image',
  'video',
  'carousel',
  'meme',
]);

/** ISO 3166-1 alpha-2 assignment list (including official exceptional XK). */
const ISO_COUNTRY_CODES = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW`.split(
    ' ',
  ),
);

export function normalizeName(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Recommendation flags come from an untrusted model response. Only honor one
 * when the operator's own message contains a clear, non-negated acceptance.
 * This deliberately does not treat a bare "go with" as acceptance: "go with
 * ₹1000" is a direct choice, not permission to substitute the recommendation.
 */
export function explicitlyAcceptsRecommendation(
  message: string,
  subject?:
    | 'product'
    | 'budget'
    | 'objective'
    | 'account'
    | 'audience'
    | 'format',
  allowUnscoped = true,
): boolean {
  const acceptancePattern =
    /\b(?:use\s+(?:that|it|(?:the|your)\s+recommendation|(?:the\s+)?recommended(?:\s+(?:product|budget|objective|account|audience|format|creative\s+format))?|(?:the\s+)?default)|go\s+with\s+(?:that|it|(?:the|your)\s+recommendation|your\s+choice|(?:the\s+)?recommended(?:\s+(?:product|budget|objective|account|audience|format|creative\s+format))?)|choose\s+for\s+me|pick\s+for\s+me|you\s+decide|your\s+choice|accept\s+(?:that|it|(?:the|your)\s+recommendation|(?:the\s+)?recommended(?:\s+(?:product|budget|objective|account|audience|format|creative\s+format))?))\b|\baccept\b(?=\s*(?:[.!?]|$))/gi;
  const negatedPrefix =
    /\b(?:do\s+not|don't|dont|never|not|won't|would\s+not|wouldn't|should\s+not|shouldn't|cannot|can't)\b(?:[\s,]+\w+){0,4}[\s,]*$/i;

  for (const match of message.matchAll(acceptancePattern)) {
    const prefix = message.slice(Math.max(0, match.index - 64), match.index);
    if (negatedPrefix.test(prefix)) continue;
    const namedSubject = match[0]
      .toLowerCase()
      .match(/\b(product|budget|objective|account|audience|format)\b/)?.[1];
    if (!subject || namedSubject === subject) return true;
    if (!namedSubject && allowUnscoped) return true;
  }
  return false;
}

export function normalizeAccountId(
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  return trimmed.startsWith('act_') ? trimmed : `act_${trimmed}`;
}

export function configuredAccountIds(company: CompanyDocument): string[] {
  const values = [company.meta?.accountId, ...(company.meta?.accountIds ?? [])]
    .map(normalizeAccountId)
    .filter((value): value is string => !!value);
  return [...new Set(values)];
}

export function findConfiguredProduct(
  company: CompanyDocument,
  requested: string | null | undefined,
): Product | null {
  const key = normalizeName(requested);
  if (!key) return null;
  const matches = (company.products ?? []).filter(
    (product) => normalizeName(product.name) === key,
  );
  return matches.length === 1 ? matches[0] : null;
}

export function findConfiguredAudience(
  product: Product | null,
  requestedId: string | null | undefined,
  requestedName: string | null | undefined,
): MetaAudience | null {
  const audiences = product?.metaAudiences ?? [];
  const id = (requestedId ?? '').trim();
  if (id) {
    const byId = audiences.filter((audience) => audience.id === id);
    if (byId.length === 1) return byId[0];
  }
  const key = normalizeName(requestedName);
  if (!key) return null;
  const byName = audiences.filter(
    (audience) => normalizeName(audience.name) === key,
  );
  return byName.length === 1 ? byName[0] : null;
}

export function computeMaxAllowedDailyBudget(input: {
  company: CompanyDocument;
  currentWeeklySpend: number;
}): number {
  const campaignCap = Math.max(
    0,
    Number(input.company.maxBudgetPerCampaign) || 0,
  );
  const weeklyRemaining = Math.max(
    0,
    (Number(input.company.weeklyBudgetCap) || 0) -
      Math.max(0, input.currentWeeklySpend),
  );
  return Math.max(0, Math.floor(Math.min(campaignCap, weeklyRemaining / 7)));
}

export function clampDailyBudget(
  requested: number,
  maxAllowed: number,
): number | null {
  if (!Number.isFinite(requested) || requested <= 0 || maxAllowed <= 0) {
    return null;
  }
  return Math.min(Math.round(requested), maxAllowed);
}

function roundToFifty(value: number): number {
  return Math.max(50, Math.round(value / 50) * 50);
}

function bestSegment(product: Product | null): string | null {
  const confidenceRank = { hypothesis: 0, low: 1, medium: 2, high: 3 };
  const segments = [...(product?.audienceSegments ?? [])];
  segments.sort((a, b) => {
    const confidenceDelta =
      confidenceRank[b.confidence] - confidenceRank[a.confidence];
    if (confidenceDelta) return confidenceDelta;
    const conversionsDelta = (b.conversions ?? 0) - (a.conversions ?? 0);
    if (conversionsDelta) return conversionsDelta;
    const aCpa = a.avgCPA ?? Number.POSITIVE_INFINITY;
    const bCpa = b.avgCPA ?? Number.POSITIVE_INFINITY;
    return aCpa - bCpa;
  });
  return segments[0]?.name ?? null;
}

function audienceRecommendation(
  product: Product | null,
  stage: CampaignCopilotFunnelStage,
  accountAudiences?: MetaAudience[] | null,
): CampaignCopilotAudienceRecommendation | null {
  // Account-scoped live inventory wins. A saved product audience may belong
  // to another ad account and must never be treated as proof of ownership.
  const audiences = accountAudiences ?? [];
  const segment = bestSegment(product);

  if (stage === 'cold') {
    const lookalikes = audiences
      .filter((audience) => audience.type === 'lookalike')
      .sort(
        (a, b) =>
          (a.lookalikePercent ?? Number.POSITIVE_INFINITY) -
          (b.lookalikePercent ?? Number.POSITIVE_INFINITY),
      );
    const selected = lookalikes[0];
    if (selected) {
      return {
        type: 'lookalike',
        name: selected.name,
        metaAudienceId: selected.id,
        targetSegment: selected.linkedSegment ?? segment,
        funnelStage: stage,
        rationale:
          'Uses a live lookalike from the selected account for prospecting. This is a starting hypothesis, not proof that the audience will outperform.',
      };
    }
    return {
      type: 'advantage_plus',
      name: null,
      metaAudienceId: null,
      targetSegment: segment,
      funnelStage: stage,
      rationale:
        'No configured lookalike is available, so Advantage+ prospecting is the safest ID-free starting point.',
    };
  }

  const pattern =
    stage === 'hot'
      ? /(cart|checkout|initiat|payment|hot)/i
      : /(visitor|engag|website|warm|viewcontent)/i;
  const custom = audiences.find(
    (audience) => audience.type === 'custom' && pattern.test(audience.name),
  );
  if (!custom) return null;
  return {
    type: stage === 'hot' ? 'retarget' : 'custom',
    name: custom.name,
    metaAudienceId: custom.id,
    targetSegment: custom.linkedSegment ?? segment,
    funnelStage: stage,
    rationale: `Uses the configured ${stage}-funnel Meta audience. The system will not fabricate a retargeting audience ID.`,
  };
}

function recommendedObjective(
  company: CompanyDocument,
): CampaignCopilotObjective {
  switch ((company.primaryObjective ?? '').toLowerCase()) {
    case 'leads':
      return 'leads';
    case 'traffic':
      return 'traffic';
    case 'awareness':
      return 'awareness';
    case 'conversions':
    default:
      return 'sales_purchase';
  }
}

function recommendedCreativeFormat(
  company: CompanyDocument,
): CampaignCopilotCreativeFormat {
  const configured = (company.preferredFormats ?? [])
    .map((value) => value.toLowerCase().trim())
    .find((value) =>
      CREATIVE_FORMATS.has(value as CampaignCopilotCreativeFormat),
    );
  return (configured as CampaignCopilotCreativeFormat | undefined) ?? 'image';
}

export function buildCopilotRecommendations(input: {
  company: CompanyDocument;
  plan: CampaignCopilotPlan;
  currentWeeklySpend: number;
  accountAudiences?: MetaAudience[] | null;
}): CampaignCopilotRecommendations {
  const product = findConfiguredProduct(input.company, input.plan.productName);
  const maxAllowed = computeMaxAllowedDailyBudget(input);
  const stage = input.plan.funnelStage ?? 'cold';

  let proposed = 500;
  let rationale =
    'Cold-start default for a controlled learning campaign; adjust after real delivery data is available.';
  const avgCpa = Number(product?.performance?.avgCPA ?? 0);
  if (avgCpa > 0) {
    proposed = avgCpa * 3;
    rationale = `Based on the product’s configured average CPA of ₹${Math.round(avgCpa)} and a controlled initial signal budget of roughly three average acquisitions per day. This is not a claim that Meta’s learning phase will complete at that spend.`;
  } else if (
    product &&
    (input.plan.objective === 'sales_purchase' || !input.plan.objective)
  ) {
    const value = Number(product.conversionValue || product.price || 0);
    if (value > 0) {
      proposed = Math.max(300, Math.min(1500, value));
      rationale =
        'No reliable CPA history exists, so the starting point uses the configured product value and stays inside the tenant caps.';
    }
  }
  const budget =
    maxAllowed > 0
      ? {
          dailyBudget: Math.min(roundToFifty(proposed), maxAllowed),
          maxAllowed,
          rationale,
        }
      : null;

  const accounts = configuredAccountIds(input.company);
  return {
    budget,
    audience: audienceRecommendation(product, stage, input.accountAudiences),
    accountId: accounts[0] ?? null,
    objective: recommendedObjective(input.company),
    creativeFormat: recommendedCreativeFormat(input.company),
  };
}

function validUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function addMissing(list: string[], field: string): void {
  if (!list.includes(field)) list.push(field);
}

export function evaluateCopilotReadiness(input: {
  company: CompanyDocument;
  plan: CampaignCopilotPlan;
  currentWeeklySpend: number;
  accountAudiences?: MetaAudience[] | null;
  accountAudiencesVerified?: boolean;
  promotablePageIds?: string[] | null;
  pagesVerified?: boolean;
}): CampaignCopilotReadiness {
  const { company, plan } = input;
  const missingFields: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const product = findConfiguredProduct(company, plan.productName);

  if (!plan.productMode) addMissing(missingFields, 'productMode');
  if (!plan.productName?.trim()) addMissing(missingFields, 'productName');

  if (plan.productMode === 'existing' && plan.productName) {
    if (!product) {
      blockers.push(
        `Product "${plan.productName}" is not an unambiguous configured product. Choose one of the listed products or explicitly create a new one.`,
      );
    } else if (product.active === false) {
      blockers.push(`Product "${product.name}" is inactive.`);
    }
  }

  if (plan.productMode === 'new') {
    if (product) {
      blockers.push(
        `Product "${product.name}" already exists. Use it as an existing product instead of creating a duplicate.`,
      );
    }
    const config = plan.newProduct;
    if (!config?.description?.trim())
      addMissing(missingFields, 'newProduct.description');
    if (!config?.price || config.price <= 0)
      addMissing(missingFields, 'newProduct.price');
    if (!config?.currency?.trim())
      addMissing(missingFields, 'newProduct.currency');
    if (plan.objective === 'sales_purchase' || plan.objective === 'leads') {
      if (!config?.conversionEvent?.trim())
        addMissing(missingFields, 'newProduct.conversionEvent');
      if (
        plan.objective === 'sales_purchase' &&
        (!config?.conversionValue || config.conversionValue <= 0)
      ) {
        addMissing(missingFields, 'newProduct.conversionValue');
      }
      if (
        !config?.customConversionId?.trim() &&
        !config?.pixelId?.trim() &&
        !company.meta?.pixelId
      ) {
        addMissing(missingFields, 'newProduct.pixelOrCustomConversion');
      }
    }
    if (plan.objective === 'app_promotion') {
      if (!config?.metaAppId?.trim())
        addMissing(missingFields, 'newProduct.metaAppId');
    }
  }

  const destination = plan.landingUrl || product?.landingUrl || null;
  if (!destination) addMissing(missingFields, 'landingUrl');
  else if (!validUrl(destination))
    blockers.push('Landing URL must be a valid http(s) URL.');
  else if (plan.productMode === 'new') {
    // A brand-new product pointing at another product's page is usually a
    // mistake: the ads would send this product's traffic to a page selling
    // something else. Surface it rather than accepting it silently — the
    // operator may still want it deliberately, so this warns, never blocks.
    const borrowedFrom = (company.products ?? []).find(
      (p) =>
        (p.landingUrl ?? '').trim().toLowerCase() ===
          destination.trim().toLowerCase() &&
        normalizeName(p.name ?? '') !== normalizeName(plan.productName ?? ''),
    );
    if (borrowedFrom) {
      warnings.push(
        `This landing page already belongs to "${borrowedFrom.name}". Visitors clicking an ad for "${plan.productName}" would land on a page selling something else — confirm this is intended, or give this product its own page.`,
      );
    }
  }

  if (!plan.objective) addMissing(missingFields, 'objective');
  else if (!OBJECTIVES.has(plan.objective))
    blockers.push('Campaign objective is not supported.');

  const maxAllowed = computeMaxAllowedDailyBudget(input);
  if (maxAllowed <= 0) {
    blockers.push(
      'No daily budget is currently available inside the tenant’s weekly and per-campaign caps.',
    );
  }
  if (!plan.dailyBudget || plan.dailyBudget <= 0)
    addMissing(missingFields, 'dailyBudget');
  else if (plan.dailyBudget > maxAllowed)
    blockers.push(
      `Daily budget ₹${plan.dailyBudget} exceeds the current safe maximum of ₹${maxAllowed}.`,
    );
  if (
    plan.requestedDailyBudget &&
    plan.dailyBudget &&
    plan.requestedDailyBudget !== plan.dailyBudget
  ) {
    warnings.push(
      `Requested budget ₹${plan.requestedDailyBudget} was clamped to ₹${plan.dailyBudget} by configured spend caps.`,
    );
  }

  const accounts = configuredAccountIds(company);
  if (!plan.accountId) addMissing(missingFields, 'accountId');
  else if (!accounts.includes(normalizeAccountId(plan.accountId)!))
    blockers.push('Selected account is not configured for this tenant.');
  if (!company.meta?.accessToken) {
    blockers.push('The tenant’s Meta connection is not configured.');
  }
  const effectivePageId =
    product?.pageId ?? plan.newProduct?.pageId ?? company.meta?.pageId;
  if (!effectivePageId) {
    addMissing(missingFields, 'product.pageId');
  } else if (
    input.pagesVerified &&
    !(input.promotablePageIds ?? []).includes(effectivePageId)
  ) {
    blockers.push(
      `Facebook Page ${effectivePageId} is not promotable from the selected ad account.`,
    );
  } else if (!input.pagesVerified && plan.newProduct?.pageId) {
    blockers.push(
      'The newly supplied Facebook Page ID could not be verified against the selected ad account.',
    );
  }

  if (!plan.funnelStage) addMissing(missingFields, 'funnelStage');
  else if (!FUNNEL_STAGES.has(plan.funnelStage))
    blockers.push('Funnel stage is not supported.');
  if (!plan.audienceType) addMissing(missingFields, 'audienceType');
  else if (!AUDIENCE_TYPES.has(plan.audienceType))
    blockers.push('Audience type is not supported.');

  if (plan.audienceType && plan.audienceType !== 'advantage_plus') {
    if (!plan.metaAudienceId) {
      addMissing(missingFields, 'metaAudienceId');
    } else {
      const configured = (input.accountAudiences ?? []).find(
        (audience) => audience.id === plan.metaAudienceId,
      );
      if (!configured) {
        blockers.push(
          input.accountAudiencesVerified
            ? 'Selected Meta audience ID does not exist in the selected ad account. The copilot will not accept a cross-account or invented ID.'
            : 'The selected audience could not be verified live against the selected ad account.',
        );
      }
    }
  }

  if (
    plan.funnelStage === 'cold' &&
    plan.audienceType &&
    !['advantage_plus', 'lookalike'].includes(plan.audienceType)
  ) {
    blockers.push(
      'Cold-funnel campaigns must use Advantage+ or a verified lookalike audience.',
    );
  }
  if (
    (plan.funnelStage === 'warm' || plan.funnelStage === 'hot') &&
    plan.audienceType &&
    !['custom', 'retarget'].includes(plan.audienceType)
  ) {
    blockers.push(
      'Warm/hot campaigns require a verified custom or retargeting audience.',
    );
  }

  if (!plan.geoLocations.length) addMissing(missingFields, 'geoLocations');
  else if (plan.geoLocations.some((country) => !ISO_COUNTRY_CODES.has(country)))
    blockers.push('Geo locations must be ISO 3166-1 alpha-2 country codes.');
  if (!plan.language) addMissing(missingFields, 'language');
  else if (!CANONICAL_LANGUAGES.includes(plan.language as any))
    blockers.push('Creative language is not supported.');
  if (!plan.creativeFormat) addMissing(missingFields, 'creativeFormat');
  else if (!CREATIVE_FORMATS.has(plan.creativeFormat))
    blockers.push('Creative format is not supported.');

  if (
    (plan.objective === 'sales_purchase' || plan.objective === 'leads') &&
    !(
      product?.customConversionId ||
      product?.pixelId ||
      plan.newProduct?.customConversionId ||
      plan.newProduct?.pixelId ||
      company.meta?.pixelId
    )
  ) {
    addMissing(missingFields, 'product.pixelOrCustomConversion');
  }

  if (plan.objective === 'app_promotion') {
    if (!plan.appPlatform) addMissing(missingFields, 'appPlatform');
    if (!product?.metaAppId && !plan.newProduct?.metaAppId) {
      addMissing(missingFields, 'product.metaAppId');
    }
    const matchingStoreUrl =
      plan.newProduct?.metaAppStoreUrl ||
      (plan.appPlatform === 'iOS'
        ? product?.metaAppStoreUrlIos
        : plan.appPlatform === 'Android'
          ? product?.metaAppStoreUrlAndroid
          : null) ||
      product?.metaAppStoreUrl;
    if (!matchingStoreUrl) {
      addMissing(
        missingFields,
        plan.productMode === 'new'
          ? 'newProduct.metaAppStoreUrl'
          : plan.appPlatform === 'iOS'
            ? 'product.metaAppStoreUrlIos'
            : plan.appPlatform === 'Android'
              ? 'product.metaAppStoreUrlAndroid'
              : 'product.metaAppStoreUrl',
      );
    }
  }

  if (plan.objective === 'sales_purchase') {
    const conversionEvent =
      product?.conversionEvent ??
      product?.customEventName ??
      plan.newProduct?.conversionEvent;
    const conversionValue =
      product?.conversionValue ?? plan.newProduct?.conversionValue;
    // A configured custom conversion IS the optimization target: the ad set is
    // built with promoted_object.custom_conversion_id and the event name is
    // never sent to Meta (see meta-ads.service — "takes priority over
    // conversionEvent"). Meta's own designation for that setup is the literal
    // string "CustomEvent", so name-matching it against purchase keywords
    // blocked a correctly-configured product on a field the build ignores.
    const customConversionId =
      product?.customConversionId ?? plan.newProduct?.customConversionId;
    if (customConversionId?.trim()) {
      // Purchase-compatibility is defined on the custom conversion itself,
      // inside Meta. Nothing here can or should second-guess it.
    } else if (!conversionEvent?.trim()) {
      addMissing(missingFields, 'product.conversionEvent');
    } else if (
      !/purchase|order.*complete|payment.*complete|sale/i.test(conversionEvent)
    ) {
      blockers.push(
        `Sales campaigns require a purchase-compatible conversion event; "${conversionEvent}" is not purchase-compatible.`,
      );
    }
    if (!conversionValue || conversionValue <= 0)
      addMissing(missingFields, 'product.conversionValue');
  }
  if (plan.objective === 'leads') {
    const conversionEvent = (
      product?.conversionEvent ??
      plan.newProduct?.conversionEvent ??
      ''
    ).toLowerCase();
    if (!conversionEvent) {
      addMissing(missingFields, 'product.conversionEvent');
    } else if (!/(lead|registration)/.test(conversionEvent)) {
      blockers.push(
        'Lead campaigns require a configured Lead or CompleteRegistration conversion event.',
      );
    }
  }

  return {
    ready: missingFields.length === 0 && blockers.length === 0,
    missingFields,
    blockers,
    warnings,
  };
}

export function sanitizeLanguage(value: unknown): string | null {
  return typeof value === 'string' ? normaliseLanguage(value) : null;
}

export function isObjective(value: unknown): value is CampaignCopilotObjective {
  return typeof value === 'string' && OBJECTIVES.has(value as any);
}

export function isFunnelStage(
  value: unknown,
): value is CampaignCopilotFunnelStage {
  return typeof value === 'string' && FUNNEL_STAGES.has(value as any);
}

export function isAudienceType(
  value: unknown,
): value is CampaignCopilotAudienceType {
  return typeof value === 'string' && AUDIENCE_TYPES.has(value as any);
}

export function isCreativeFormat(
  value: unknown,
): value is CampaignCopilotCreativeFormat {
  return typeof value === 'string' && CREATIVE_FORMATS.has(value as any);
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && validUrl(value);
}

export function sanitizeGeoLocations(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const aliases: Record<string, string> = {
    india: 'IN',
    'united states': 'US',
    usa: 'US',
    'united kingdom': 'GB',
    uk: 'GB',
    canada: 'CA',
    australia: 'AU',
  };
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => aliases[item.toLowerCase()] ?? item.toUpperCase());
  return [...new Set(normalized)];
}
