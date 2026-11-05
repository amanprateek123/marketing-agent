/** Launch Planner shapes (docs/performance-marketeer/11-launch-planner.md). */
import { z } from 'zod';
import { IssueSchema } from '../pm-agent.types';

export const EvidenceLabel = z.enum([
  'fact',
  'assumption',
  'hypothesis',
  'unknown',
]);
export type EvidenceLabel = z.infer<typeof EvidenceLabel>;

const Finding = z.object({
  text: z.string(),
  label: EvidenceLabel,
  /** URL, tool result id (ev-N) or "facts". Empty only for an unknown. */
  source: z.string(),
});

export const LaunchReview = z.object({
  markdown: z.string(),
  creatives: z.array(
    z.object({
      /** File name from 00-facts.md, exactly. */
      file: z.string(),
      /** The same id for different sizes of one design: D1, D2… */
      designId: z.string().regex(/^D\d+$/),
      summary: z.string(),
      hook: z.string(),
      language: z.string(),
      angle: z.string(),
      /** A real person meeting this ad in their feed. */
      firstLook: z.object({
        viewer: z.string(),
        noticesFirst: z.string(),
        /** The thought in their own words. */
        thinks: z.string(),
        reaction: z.enum(['stops_and_taps', 'stops_only', 'scrolls_past']),
        why: z.string(),
      }),
      /** ready = run it; needs_fixes = worth fixing first; excluded = don't run. */
      finalStatus: z.enum(['ready', 'needs_fixes', 'excluded']),
      /** One or two sentences: the call and the reason. */
      verdict: z.string(),
      strengths: z.array(z.string()),
      /** Only what would change what viewers do. Empty is a good answer. */
      changes: z.array(
        z.object({
          where: z.string(),
          problem: z.string(),
          whatViewerDoes: z.string(),
          /** The exact new wording or placement. */
          fix: z.string(),
        }),
      ),
      /** Variations worth testing. These are not flaws. */
      tests: z.array(z.string()),
      /** Does the page keep the promise that earned the click? */
      promise: z.object({
        adPromises: z.string(),
        pageDelivers: z.enum(['yes', 'no', 'unclear']),
        note: z.string(),
      }),
      policyRisk: z.enum(['low', 'review', 'block']),
      resizeAdvice: z.array(z.string()),
      /** Only phrases Meta would reject or invented facts about the business. */
      claimsToVerify: z.array(z.string()),
    }),
  ),
  missingAngles: z.array(z.string()),
  landing: z.object({
    summary: z.string(),
    /** Where a visitor goes after the main button. */
    mainButton: z.string(),
    directPurchase: z.enum(['yes', 'no', 'unknown']),
    /** The visitor's path from ad to paid order, in order. */
    path: z.array(
      z.object({
        step: z.string(),
        status: z.enum(['ok', 'warning', 'problem', 'unknown']),
        note: z.string(),
      }),
    ),
    whatWorks: z.array(z.string()),
    issues: z.array(z.string()),
    /** Invented-sounding facts about the business on the page; never reused in ads. */
    claimsToVerify: z.array(z.string()),
  }),
});
export type LaunchReview = z.infer<typeof LaunchReview>;

export const LaunchResearch = z.object({
  markdown: z.string(),
  /** Who has this need: 2–5 distinct groups. */
  audience: z.array(
    z.object({
      name: z.string(),
      situation: z.string(),
      whyTheyBuy: z.string(),
      ageRange: z.string(),
      languages: z.string(),
      messageIdea: z.string(),
      label: EvidenceLabel,
      source: z.string(),
    }),
  ),
  /** Reach figures from audience_size. */
  reach: z.array(
    z.object({
      targeting: z.string(),
      low: z.number(),
      high: z.number(),
      source: z.string(),
    }),
  ),
  locations: z.array(
    z.object({
      place: z.string(),
      decision: z.enum(['include', 'exclude', 'test_later', 'no_preference']),
      reason: z.string(),
      label: EvidenceLabel,
      source: z.string(),
    }),
  ),
  dates: z.array(
    z.object({
      /** YYYY-MM-DD, or the start of a range. */
      date: z.string(),
      event: z.string(),
      effect: z.enum([
        'higher_demand',
        'lower_demand',
        'higher_costs',
        'neutral',
      ]),
      whatToDo: z.string(),
      label: EvidenceLabel,
      source: z.string(),
    }),
  ),
  competitors: z.array(
    z.object({
      brand: z.string(),
      angle: z.string(),
      offer: z.string(),
      format: z.string(),
      /** How long their ad has run, or "unknown". */
      runningFor: z.string(),
      takeaway: z.string(),
      label: EvidenceLabel,
      source: z.string(),
    }),
  ),
  /** Patterns across competitors. */
  patterns: z.array(Finding),
  /** What gets attention on Indian social feeds in this category, and how to use it. */
  socialPlaybook: z.array(
    z.object({
      pattern: z.string(),
      seenAt: z.string(),
      howToUse: z.string(),
      label: EvidenceLabel,
      source: z.string(),
    }),
  ),
  /** What could not be researched (e.g. competitor source down). */
  gaps: z.array(z.string()),
});
export type LaunchResearch = z.infer<typeof LaunchResearch>;

export const LaunchAdSet = z.object({
  name: z.string(),
  budgetPercent: z.number().min(1).max(100),
  audienceType: z.enum([
    'advantage_plus',
    'interest',
    'lookalike',
    'retarget',
    'custom',
  ]),
  metaAudienceId: z.string().optional(),
  excludeAudienceIds: z.array(z.string()),
  ageMin: z.number().int(),
  ageMax: z.number().int(),
  gender: z.enum(['male', 'female', 'all']),
  /** ['IN'] for all India. Region and city keys from meta_geo_search go below and replace it. */
  geoLocations: z.array(z.string()),
  geoStates: z.array(z.string()),
  geoCities: z.array(z.string()),
  /** Must stay empty: no language filter until there is a locale lookup tool. */
  locales: z.array(z.number().int()),
  interests: z.array(z.object({ id: z.string(), name: z.string() })),
  placementPreset: z.enum(['vertical', 'vertical_feed', 'everywhere']),
  designIds: z.array(z.string()),
  reason: z.string(),
  label: EvidenceLabel,
});
export type LaunchAdSet = z.infer<typeof LaunchAdSet>;

export const LaunchPlanOutput = z.object({
  markdown: z.string(),
  targetVerdict: z.enum(['realistic', 'unrealistic', 'unknown']),
  targetNote: z.string(),
  campaignName: z.string().min(3),
  campaignType: z.enum(['advantage_plus', 'custom']),
  adSets: z.array(LaunchAdSet).min(1),
  copy: z.array(
    z.object({
      designId: z.string(),
      primaryText: z.string(),
      headline: z.string(),
      cta: z.enum(['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP']),
    }),
  ),
  /** The readable top of the result. It only repeats what the plan and research say. */
  analysis: z.object({
    headline: z.string(),
    summary: z.string(),
    whySetup: z.array(
      z.object({
        title: z.string(),
        detail: z.string(),
        label: EvidenceLabel,
        source: z.string(),
      }),
    ),
    creativeTakeaway: z.string(),
    competitorTakeaway: z.string(),
    /** One per design: what to do with it, after the research. */
    creativeCalls: z.array(
      z.object({
        designId: z.string(),
        call: z.enum(['run', 'fix', 'replace']),
        why: z.string(),
        /** Required for replace: different topics to make instead. */
        replacements: z.array(
          z.object({
            topic: z.string(),
            hook: z.string(),
            format: z.string(),
            forWho: z.string(),
            why: z.string(),
          }),
        ),
      }),
    ),
    todo: z.array(
      z.object({
        priority: z.enum(['must', 'should', 'nice']),
        action: z.string(),
        why: z.string(),
      }),
    ),
    risks: z.array(
      z.object({
        risk: z.string(),
        impact: z.enum(['high', 'medium', 'low']),
        response: z.string(),
      }),
    ),
    newCreativeIdeas: z.array(
      z.object({
        angle: z.string(),
        hook: z.string(),
        format: z.string(),
        why: z.string(),
      }),
    ),
  }),
  decisions: z.array(z.object({ topic: z.string() }).extend(Finding.shape)),
  unknowns: z.array(z.string()),
  reviewPlan: z.object({
    beforeLive: z.array(z.string()),
    day1: z.array(z.string()),
    day3: z.array(z.string()),
    day7: z.array(z.string()),
    rules: z.array(z.string()),
  }),
  sources: z.array(z.string()),
});
export type LaunchPlanOutput = z.infer<typeof LaunchPlanOutput>;

export const LaunchVerify = z.object({
  markdown: z.string(),
  issues: z.array(IssueSchema),
  confirmedRight: z.array(z.string()),
});
export type LaunchVerify = z.infer<typeof LaunchVerify>;

export type RoasType = 'meta' | 'first_party';

export interface LaunchInput {
  productName: string;
  creativeUrls: string[];
  dailySpend: number;
  desiredRoas: number;
  roasType: RoasType;
  launchDate: string;
  maxCpa?: number;
  note?: string;
}

export interface LaunchCreativeFile {
  url: string;
  /** File name in the run's creatives/ folder. */
  file: string;
  width: number;
  height: number;
  ratio: string;
}

export interface LaunchEconomics {
  price: number;
  netPrice: number;
  roasType: RoasType;
  desiredRoas: number;
  allowedCpaMeta: number;
  allowedCpaFirstParty: number;
  /** The limit used: from the ROAS type picked, lowered by the admin's maximum if given. */
  allowedCpa: number;
  dailySpend: number;
  /** Ceiling if the target is hit, not a forecast. */
  ordersPerWeekAtTarget: number;
  learningBenchmark: number;
  /** What each possible cost per order would mean. Arithmetic, not a forecast. */
  scenarios: {
    costPerOrder: number;
    ordersPerWeek: number;
    metaRoas: number;
    firstPartyRoas: number;
    meetsTarget: boolean;
  }[];
}

export interface LaunchTracking {
  conversionId: string;
  accountId: string;
  blocks: string[];
  warnings: string[];
  facts: string[];
}

export interface LaunchReadiness {
  ready: boolean;
  blocks: string[];
  warnings: string[];
}

/** The admin ticks these; code can't check them. */
export const LAUNCH_CHECKLIST = [
  'testPurchase',
  'deduplicated',
  'mobilePath',
  'claimsVerified',
] as const;
export type LaunchChecklist = Record<
  (typeof LAUNCH_CHECKLIST)[number],
  boolean
>;
