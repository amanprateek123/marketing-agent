/** Pure Launch Planner rules: money, sizes, plan checks, readiness (doc 11). */
import { basename } from 'path';
import { checkCopySafety } from '../../../common/safety/copy-safety-checker.util';
import { GST_RATE } from '../../pm.config';
import type {
  LaunchAdSet,
  LaunchChecklist,
  LaunchCreativeFile,
  LaunchEconomics,
  LaunchInput,
  LaunchPlanOutput,
  LaunchReadiness,
  LaunchReview,
  LaunchTracking,
} from './launch.types';
import { LAUNCH_CHECKLIST } from './launch.types';

const r2 = (n: number) => Math.round(n * 100) / 100;
export const LEARNING_BENCHMARK = 50;
const MIN_SIDE = 600;
const SCENARIO_STEPS = [0.5, 0.75, 1, 1.5, 2];
const RATIOS: [string, number][] = [
  ['1:1', 1],
  ['4:5', 4 / 5],
  ['9:16', 9 / 16],
  ['16:9', 16 / 9],
];

/** Which standard size an image is, within 1% (launch's own tolerance), else its plain WxH. */
export function ratioLabel(w: number, h: number) {
  const hit = RATIOS.find(([, r]) => Math.abs(w / h / r - 1) <= 0.01);
  return hit ? hit[0] : `${w}x${h}`;
}

/**
 * Meta ROAS uses the value sent to Meta (gross); first-party uses net of GST.
 * Never mix them: both limits are shown, one decides.
 */
export function economics(i: {
  price: number;
  desiredRoas: number;
  roasType: LaunchInput['roasType'];
  dailySpend: number;
  maxCpa?: number;
}): LaunchEconomics {
  const netPrice = i.price / (1 + GST_RATE);
  const allowedCpaMeta = i.price / i.desiredRoas;
  const allowedCpaFirstParty = netPrice / i.desiredRoas;
  const byRoas = i.roasType === 'meta' ? allowedCpaMeta : allowedCpaFirstParty;
  const allowedCpa = i.maxCpa ? Math.min(byRoas, i.maxCpa) : byRoas;
  const scenarios = SCENARIO_STEPS.map((step) => {
    const cost = allowedCpa * step;
    return {
      costPerOrder: r2(cost),
      ordersPerWeek: r2((i.dailySpend * 7) / cost),
      metaRoas: r2(i.price / cost),
      firstPartyRoas: r2(netPrice / cost),
      meetsTarget: cost <= allowedCpa + 0.001,
    };
  });
  return {
    scenarios,
    price: i.price,
    netPrice: r2(netPrice),
    roasType: i.roasType,
    desiredRoas: i.desiredRoas,
    allowedCpaMeta: r2(allowedCpaMeta),
    allowedCpaFirstParty: r2(allowedCpaFirstParty),
    allowedCpa: r2(allowedCpa),
    dailySpend: i.dailySpend,
    ordersPerWeekAtTarget: r2((i.dailySpend * 7) / allowedCpa),
    learningBenchmark: LEARNING_BENCHMARK,
  };
}

const lc = (s: string) => s.toLowerCase();

export interface KnownIds {
  regions: Set<string>;
  cities: Set<string>;
  interests: Set<string>;
  audiences: Set<string>;
}

/** The AI may write creatives/C1.jpg; everything else matches on C1.jpg. */
export function cleanReviewFiles(review: LaunchReview): LaunchReview {
  return {
    ...review,
    creatives: review.creatives.map((c) => ({ ...c, file: basename(c.file) })),
  };
}

/** Uploaded files the review doesn't cover. */
export function unreviewedFiles(
  review: LaunchReview,
  creatives: LaunchCreativeFile[],
) {
  const reviewed = new Set(review.creatives.map((c) => c.file));
  return creatives.map((c) => c.file).filter((f) => !reviewed.has(f));
}

/** Hard problems in a plan; the planner gets them back, and any left block creation. */
export function checkPlan(i: {
  plan: LaunchPlanOutput;
  review: LaunchReview;
  creatives: LaunchCreativeFile[];
  economics: LaunchEconomics;
  /** Ids the Meta tools actually returned this run. */
  known: KnownIds;
  declaredSpecialAdCategories?: string[];
}): { problems: string[]; warnings: string[] } {
  const { plan, review, creatives, economics: e, known } = i;
  const problems: string[] = [];
  const warnings: string[] = [];
  const statusOf = designStatus(review);
  for (const f of unreviewedFiles(review, creatives))
    problems.push(`${f} was not reviewed`);

  const ratiosOf = designRatios(review, creatives);
  for (const [d, rs] of ratiosOf) {
    const dupes = rs.filter((r, x) => rs.indexOf(r) !== x);
    if (dupes.length)
      problems.push(
        `${d} has two images of size ${dupes[0]}: split them into separate designs`,
      );
  }

  const total = plan.adSets.reduce((s, a) => s + a.budgetPercent, 0);
  if (plan.adSets.length > 1 && Math.abs(total - 100) > 0.001)
    problems.push(`ad set budgets add up to ${total}%, not 100%`);
  if (plan.campaignType === 'advantage_plus' && plan.adSets.length > 1)
    problems.push('an Advantage+ campaign has exactly one ad set');
  for (const a of plan.adSets) {
    // Launch silently drops these, so the plan must not show them.
    if (
      plan.campaignType === 'advantage_plus' &&
      a.audienceType !== 'advantage_plus'
    )
      problems.push(
        `"${a.name}": an Advantage+ campaign only takes audienceType advantage_plus`,
      );
    if (
      a.audienceType === 'advantage_plus' &&
      (a.ageMin !== 18 || a.ageMax !== 65 || a.gender !== 'all')
    )
      problems.push(
        `"${a.name}": Advantage+ audience ignores age and gender, so use 18–65 and all, or another audience type`,
      );
  }

  const used = new Set<string>();
  for (const a of plan.adSets) {
    checkAdSet(a, known, problems);
    if (!a.designIds.length) problems.push(`"${a.name}" has no creatives`);
    const share = plan.adSets.length === 1 ? 100 : a.budgetPercent;
    const budget = (e.dailySpend * share) / 100;
    if (budget < e.allowedCpa)
      warnings.push(
        `"${a.name}" gets ₹${r2(budget)}/day, below one allowed order (₹${e.allowedCpa}). Purchases will be slow to show.`,
      );
    for (const d of a.designIds) {
      used.add(d);
      const status = statusOf.get(d);
      if (!status) problems.push(`"${a.name}" uses unknown design ${d}`);
      else if (status === 'excluded')
        problems.push(`"${a.name}" uses excluded design ${d}`);
      else if (status === 'needs_fixes')
        warnings.push(`${d} in "${a.name}" still needs fixes from the review.`);
      const rs = ratiosOf.get(d) ?? [];
      if (a.placementPreset === 'vertical' && !rs.includes('9:16'))
        problems.push(
          `"${a.name}" is vertical-only but ${d} has no 9:16 image`,
        );
      else if (a.placementPreset !== 'vertical' && !rs.includes('9:16'))
        warnings.push(
          `${d} has no 9:16 image. Launch will make one by extending the image with a blurred background. Upload a real one for a better result.`,
        );
    }
  }
  for (const [d, s] of statusOf)
    if (
      s !== 'excluded' &&
      !used.has(d) &&
      plan.analysis.creativeCalls.find((c) => c.designId === d)?.call !==
        'replace'
    )
      warnings.push(`${d} is usable but is not in any ad set.`);

  const calls = new Map(
    plan.analysis.creativeCalls.map((c) => [c.designId, c]),
  );
  for (const [d, status] of statusOf) {
    const c = calls.get(d);
    if (!c) problems.push(`${d} has no creative call`);
    else if (c.call === 'replace' && used.has(d))
      problems.push(`${d} is marked replace but is in an ad set`);
    else if (c.call === 'replace' && !c.replacements.length)
      problems.push(`${d} is marked replace with nothing to make instead`);
    else if (c.call !== 'replace' && status === 'excluded')
      problems.push(`${d} is excluded, so its call must be replace`);
  }

  const claims = [
    ...review.creatives.flatMap((c) => c.claimsToVerify),
    ...review.landing.claimsToVerify,
  ].filter((c) => c.trim().length > 2);
  const copyFor = new Set(plan.copy.map((c) => c.designId));
  for (const d of used)
    if (!copyFor.has(d)) problems.push(`${d} has no ad copy`);
  for (const c of plan.copy) {
    if (!c.primaryText.trim() || !c.headline.trim())
      problems.push(`${c.designId} copy is missing text or a headline`);
    const text = lc(`${c.primaryText} ${c.headline}`);
    const hit = claims.find((x) => text.includes(lc(x)));
    if (hit)
      problems.push(`${c.designId} copy repeats unverified claim "${hit}"`);
    const safety = checkCopySafety({
      primaryText: c.primaryText,
      headline: c.headline,
      cta: c.cta,
      declaredSpecialAdCategories: i.declaredSpecialAdCategories,
    });
    for (const x of [
      ...safety.forbiddenClaims,
      ...safety.specialAdCategoryTriggers,
    ])
      problems.push(
        `${c.designId} copy fails the safety check: "${x.phrase}" (${x.reason})`,
      );
  }
  return { problems, warnings };
}

function checkAdSet(a: LaunchAdSet, known: KnownIds, problems: string[]) {
  if (a.ageMin < 18 || a.ageMax > 65 || a.ageMin > a.ageMax)
    problems.push(`"${a.name}" has a bad age range ${a.ageMin}–${a.ageMax}`);
  if (a.locales.length)
    problems.push(`"${a.name}" uses a language filter: leave locales empty`);
  const hasPlaces = a.geoStates.length + a.geoCities.length > 0;
  if (!hasPlaces && a.geoLocations.join() !== 'IN')
    problems.push(
      `"${a.name}" must target India: geoLocations ["IN"], or regions and cities`,
    );
  if (hasPlaces && a.geoLocations.length)
    problems.push(
      `"${a.name}": leave geoLocations empty when using regions or cities`,
    );
  for (const k of a.geoStates)
    if (!known.regions.has(k))
      problems.push(
        `"${a.name}" uses region key ${k}, not a region from meta_geo_search`,
      );
  for (const k of a.geoCities)
    if (!known.cities.has(k))
      problems.push(
        `"${a.name}" uses city key ${k}, not a city from meta_geo_search`,
      );
  for (const x of a.interests)
    if (!known.interests.has(x.id))
      problems.push(
        `"${a.name}" uses interest ${x.id}, not from meta_interest_search`,
      );
  if (a.audienceType === 'interest' && !a.interests.length)
    problems.push(`"${a.name}" is interest-based with no interests`);
  const needsAudience = ['lookalike', 'retarget', 'custom'].includes(
    a.audienceType,
  );
  if (needsAudience && !a.metaAudienceId)
    problems.push(`"${a.name}" needs an audience id`);
  for (const id of [
    ...(a.metaAudienceId ? [a.metaAudienceId] : []),
    ...a.excludeAudienceIds,
  ])
    if (!known.audiences.has(id))
      problems.push(
        `"${a.name}" uses audience ${id}, not from ad_account_audiences`,
      );
}

/** A design's status from its usable files, worst first; excluded only if every file is. */
export function designStatus(review: LaunchReview) {
  const out = new Map<string, string>();
  for (const c of review.creatives) {
    const now = out.get(c.designId);
    if (c.finalStatus === 'excluded') {
      if (!now) out.set(c.designId, 'excluded');
    } else if (!now || now === 'excluded' || c.finalStatus === 'needs_fixes') {
      out.set(c.designId, c.finalStatus);
    }
  }
  return out;
}

/** Design id → the sizes it has. */
export function designRatios(
  review: LaunchReview,
  creatives: LaunchCreativeFile[],
) {
  const byFile = new Map(creatives.map((c) => [c.file, c]));
  const out = new Map<string, string[]>();
  for (const c of review.creatives) {
    if (c.finalStatus === 'excluded') continue;
    const f = byFile.get(c.file);
    if (f) out.set(c.designId, [...(out.get(c.designId) ?? []), f.ratio]);
  }
  return out;
}

/** The request for ManualCampaignService.create: one copy variant per design used. */
export function toManualDto(i: {
  plan: LaunchPlanOutput;
  review: LaunchReview;
  creatives: LaunchCreativeFile[];
  input: Pick<LaunchInput, 'productName' | 'dailySpend'>;
  accountId: string;
}) {
  const { plan, review, creatives, input, accountId } = i;
  const designs = [...new Set(plan.adSets.flatMap((a) => a.designIds))];
  const index = new Map(designs.map((d, x) => [d, x]));
  // An excluded file never ships, even when other sizes of its design do.
  const fileOf = new Map(
    review.creatives
      .filter((c) => c.finalStatus !== 'excluded')
      .map((c) => [c.file, c.designId]),
  );
  const copy = (d: string) => {
    const c = plan.copy.find((x) => x.designId === d)!;
    return { primaryText: c.primaryText, headline: c.headline, cta: c.cta };
  };
  const sizes = new Map<string, number>();
  for (const c of creatives) {
    const d = fileOf.get(c.file) ?? '';
    sizes.set(d, (sizes.get(d) ?? 0) + 1);
  }
  return {
    name: plan.campaignName,
    productName: input.productName,
    accountId,
    campaignType: plan.campaignType,
    budget: input.dailySpend,
    objective: 'OUTCOME_SALES',
    adSets: plan.adSets.map((a) => ({
      name: a.name,
      budgetPercent: a.budgetPercent,
      audienceType: a.audienceType,
      metaAudienceId: a.metaAudienceId,
      excludeAudienceIds: a.excludeAudienceIds,
      ageMin: a.ageMin,
      ageMax: a.ageMax,
      gender: a.gender,
      geoLocations: a.geoLocations,
      geoStates: a.geoStates,
      geoCities: a.geoCities,
      locales: a.locales,
      interests: a.interests,
      placementPreset: a.placementPreset,
      creativeFormat: 'image' as const,
      ads: a.designIds.map((d) => index.get(d)!),
    })),
    creative: {
      copyVariants: designs.map(copy),
      images: creatives.flatMap((c) => {
        const d = fileOf.get(c.file);
        const variantIndex = d === undefined ? undefined : index.get(d);
        if (variantIndex === undefined) return [];
        return [
          {
            variantIndex,
            imageUrl: c.url,
            ...(sizes.get(d!)! > 1 && !c.ratio.includes('x')
              ? { aspectRatio: c.ratio }
              : {}),
          },
        ];
      }),
    },
  };
}

/** Everything that blocks or warns before a paused campaign may be created. */
export function readiness(i: {
  tracking: LaunchTracking;
  creatives: LaunchCreativeFile[];
  review: LaunchReview;
  planProblems: string[];
  planWarnings: string[];
  openIssues: string[];
  /** Reviewer issues of blocker severity still open after the last round. */
  reviewerBlocks: string[];
  economics: LaunchEconomics;
  landingOk: boolean;
  tokenBlock?: string;
  budgetBlock?: string;
}): LaunchReadiness {
  const blocks = [...i.tracking.blocks, ...i.planProblems, ...i.reviewerBlocks];
  if (i.budgetBlock) blocks.push(i.budgetBlock);
  const warnings = [...i.tracking.warnings, ...i.planWarnings, ...i.openIssues];
  if (i.tokenBlock) blocks.push(i.tokenBlock);
  if (!i.landingOk) blocks.push('The landing page does not load.');
  const excluded = new Set(
    i.review.creatives
      .filter((c) => c.finalStatus === 'excluded')
      .map((c) => c.file),
  );
  for (const c of i.creatives)
    if (!excluded.has(c.file) && Math.min(c.width, c.height) < MIN_SIDE)
      blocks.push(`${c.file} is too small (${c.width}×${c.height}).`);
  for (const c of i.review.creatives)
    if (c.policyRisk === 'block' && c.finalStatus !== 'excluded')
      blocks.push(`${c.file} has a blocking policy issue and is not excluded.`);
    else if (c.policyRisk === 'review' && c.finalStatus !== 'excluded')
      warnings.push(`${c.file} needs a policy review before going live.`);
  const e = i.economics;
  if (e.ordersPerWeekAtTarget < e.learningBenchmark)
    warnings.push(
      `Even at the target this budget buys at most ${Math.floor(e.ordersPerWeekAtTarget)} orders a week, below Meta's benchmark of about ${e.learningBenchmark}. Learning may stay limited.`,
    );
  return { ready: !blocks.length, blocks, warnings };
}

/** Why a create request must be refused, or null. */
export function checklistMissing(c: Partial<LaunchChecklist> | undefined) {
  const missing = LAUNCH_CHECKLIST.filter((k) => c?.[k] !== true);
  return missing.length ? missing : null;
}

/** The rule names this product, by page slug or product name. */
export function ruleMatchesProduct(
  rule: unknown,
  product: { name: string; landingUrl?: string },
) {
  const text = lc(String(rule ?? ''));
  let slug = '';
  try {
    slug =
      new URL(product.landingUrl ?? '').pathname
        .split('/')
        .filter(Boolean)
        .pop() ?? '';
  } catch {
    // no usable page: the name alone decides
  }
  return (!!slug && text.includes(lc(slug))) || text.includes(lc(product.name));
}

/** Custom conversion rule targets a Purchase event. */
export function ruleIsPurchase(rule: unknown) {
  return /"event"\s*:\s*\{\s*"eq"\s*:\s*"Purchase"/.test(String(rule ?? ''));
}
