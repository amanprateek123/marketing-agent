/**
 * Turning a pipeline run into something a marketer can read.
 *
 * The brain's own vocabulary is built for the agents that work the queue: `stage: 'curating'`,
 * `last_build_result: 'no_ads'`, `creative_contract.audience_plan[0].budget_kind`. All of it is
 * correct and none of it belongs on a page someone opens to decide whether to spend money.
 *
 * So this file is the whole translation layer, and it is deliberately the ONLY place that knows
 * both vocabularies. Two rules it does not break:
 *
 *   1. NOTHING INTERNAL CROSSES. No Foundry run id, no agent id, no `write_mcp_run_id`, no Meta
 *      object id, no attempt counter, no raw JSON blob. If a field's only audience is an engineer
 *      debugging the pipeline, it stops here.
 *
 *   2. A MISSING THING STAYS MISSING. An unjudged creative has no score, not a zero. A run with no
 *      brief has no brief, not an empty-looking one full of "0" and "none". Inventing a confident
 *      blank is how a page lies without anyone writing a false sentence.
 */

import type {
  BrainBriefField,
  BrainCampaignAudience,
  BrainCampaignCreative,
  BrainCampaignRun,
  BrainCampaignRunSummary,
  BrainCampaignStep,
  BrainRunTone,
  BrainStageKey,
  BrainStageState,
} from './brain.types';

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function obj(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * `golu_devta_arzi` → `Golu Devta Arzi`, and `LEARN_MORE` → `Learn More`.
 *
 * The lowercase first matters: Meta's call-to-action values arrive SHOUTING, and a button reading
 * "LEARN MORE" on an otherwise sentence-cased page looks like a bug rather than a brand choice.
 */
function titleize(slug: string): string {
  return slug
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "2026-09-18T00:00:00.000Z" → "2026-09-18". A campaign's start date has no time of day. */
function asDate(value: string | null): string {
  if (!value) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : value;
}

/** ₹2500 → "₹2,500 a day". Indian digit grouping, because the reader is in India. */
function rupeesPerDay(value: number): string {
  return `₹${value.toLocaleString('en-IN')} a day`;
}

/* ── The four steps ─────────────────────────────────────────────────────────── */

const STEPS: Array<{
  key: BrainStageKey;
  stage: string;
  label: string;
  what: string;
}> = [
  {
    key: 'producer',
    stage: 'producing',
    label: 'Making the ads',
    what: 'Writing and designing a batch of ads for this product.',
  },
  {
    key: 'curator',
    stage: 'curating',
    label: 'Picking the best',
    what: 'Scoring every ad and keeping only the ones good enough to run.',
  },
  {
    key: 'builder',
    stage: 'building',
    label: 'Setting up the campaign',
    what: 'Creating the campaign, audiences and ads in Meta — all paused.',
  },
  {
    key: 'launcher',
    stage: 'launching',
    label: 'Going live',
    what: 'Waiting for your approval, then switching everything on.',
  },
];

const STAGE_LABEL: Record<string, string> = {
  planned: 'Waiting to start',
  producing: 'Making the ads',
  curating: 'Picking the best',
  building: 'Setting up the campaign',
  launching: 'Waiting for your go-ahead',
  done: 'Finished',
};

const STATUS_LABEL: Record<string, string> = {
  open: 'In progress',
  done: 'Finished',
  short: 'Finished with fewer ads than planned',
  failed: 'Stopped — needs a look',
  abandoned: 'Cancelled',
};

const STATUS_TONE: Record<string, BrainRunTone> = {
  open: 'progress',
  done: 'good',
  short: 'waiting',
  failed: 'bad',
  abandoned: 'idle',
};

const CAMPAIGN_TYPE_LABEL: Record<string, string> = {
  launch: 'New launch',
  test: 'Test',
  evergreen: 'Always-on',
  seasonal: 'Seasonal',
  retargeting: 'Winning back visitors',
};

const CREATIVE_STATUS: Record<string, { label: string; tone: BrainRunTone }> = {
  generating: { label: 'Being made', tone: 'progress' },
  preview_ready: { label: 'Ready to review', tone: 'waiting' },
  approved: { label: 'Chosen', tone: 'good' },
  uploaded: { label: 'Sent to Meta', tone: 'good' },
  live: { label: 'Running', tone: 'good' },
  retired: { label: 'Not used', tone: 'idle' },
};

/** The creatives that count as "finalised" — what actually ships, or already has. */
const FINAL_STATUSES = new Set(['approved', 'uploaded', 'live']);

export function isFinalisedCreative(row: Row): boolean {
  const status = str(row.status);
  return status !== null && FINAL_STATUSES.has(status);
}

/* ── Rows → console shapes ──────────────────────────────────────────────────── */

export function mapCampaignRunSummary(
  row: Row,
  displayName?: string | null,
  chosen?: number | null,
): BrainCampaignRunSummary | null {
  const id = num(row.id);
  if (id === null) return null;

  const stage = str(row.stage) ?? 'planned';
  const status = str(row.status) ?? 'open';
  const slug = str(row.offering_slug);
  const contract = obj(row.creative_contract);

  return {
    runId: String(id),
    product: displayName ?? (slug ? titleize(slug) : 'Unknown product'),
    campaignType:
      CAMPAIGN_TYPE_LABEL[str(row.campaign_type) ?? ''] ?? 'Campaign',
    stageLabel: STAGE_LABEL[stage] ?? titleize(stage),
    statusLabel: STATUS_LABEL[status] ?? titleize(status),
    // HOW IT ENDED BEATS HOW FAR IT GOT.
    //
    // A run can reach stage 'done' and still carry status 'abandoned' — run 93 does. Reading the
    // stage first painted that green and called it finished, which is the exact opposite of what
    // happened to it. So a terminal-bad status wins, and only a genuinely clean finish is good.
    tone:
      status === 'abandoned' || status === 'failed' || status === 'short'
        ? (STATUS_TONE[status] ?? 'idle')
        : stage === 'done'
          ? 'good'
          : (STATUS_TONE[status] ?? 'idle'),
    // `plan_date` is a DATE in Postgres but arrives as a full midnight timestamp over JSON.
    // Printing that renders "2026-09-18T00:00:00.000Z" on a page about a marketing campaign.
    startedOn: asDate(str(row.plan_date) ?? str(row.created_at)),
    updatedAt: str(row.updated_at),
    creativesChosen: chosen ?? null,
    creativesPlanned:
      num(contract?.ads_wanted) ?? num(row.target_creative_count),
    isLive: stage === 'done' && status === 'done',
  };
}

function mapSteps(row: Row, gateByStage: Map<string, string>): BrainCampaignStep[] {
  const stage = str(row.stage) ?? 'planned';
  const status = str(row.status) ?? 'open';
  const stoppedBadly = status === 'abandoned' || status === 'failed';

  // A RUN CAN REACH THE LAST STAGE AND STILL NOT HAVE DONE IT.
  //
  // Run 86 sits at stage 'done' with status 'abandoned' — it was parked by the owner before
  // anything went live. Reading the stage alone ticked all four steps, so the page said
  // "Going live: Done" about a campaign that never launched. Where it got to and whether it
  // finished are two facts, and the second one decides how the last step reads.
  const reachedIndex =
    stage === 'done' ? STEPS.length - 1 : STEPS.findIndex((s) => s.stage === stage);

  return STEPS.map((step, index) => {
    let state: BrainStageState = 'idle';
    if (stage === 'done' && !stoppedBadly) state = 'done';
    else if (reachedIndex === -1)
      state = 'idle'; // still 'planned' — nothing has started
    else if (index < reachedIndex) state = 'done';
    else if (index === reachedIndex) {
      state =
        status === 'failed'
          ? 'failed'
          : status === 'abandoned'
            ? 'blocked'
            : status === 'short'
              ? 'waiting_for_human'
              : 'running';
    }
    // A gate on this step turns "running" into "waiting for you" — the honest state, and the
    // one that tells the reader the machine is not the thing holding it up.
    const gateId = gateByStage.get(step.stage) ?? null;
    if (gateId && state === 'running') state = 'waiting_for_human';

    return {
      key: step.key,
      label: step.label,
      what: step.what,
      state,
      gateId,
    };
  });
}

/** The brief, as labelled facts. This is "the fields going in", minus the JSON. */
function mapBrief(row: Row): BrainBriefField[] {
  const contract = obj(row.creative_contract);
  const monitor = obj(row.monitor_config);
  const fields: BrainBriefField[] = [];

  const push = (label: string, value: string | null, hint: string | null = null) => {
    if (value) fields.push({ label, value, hint });
  };

  const ads = num(contract?.ads_wanted) ?? num(row.target_creative_count);
  push(
    'Ads to run',
    ads === null ? null : String(ads),
    'How many finished ads this campaign should end up with.',
  );

  const adsets = num(contract?.adsets_wanted);
  push(
    'Audiences',
    adsets === null ? null : String(adsets),
    'How many separate audiences the budget is split across.',
  );

  const pool = num(contract?.candidate_pool);
  const survivors = num(contract?.final_survivors);
  if (pool !== null && survivors !== null) {
    push(
      'Shortlisting',
      `${pool} made, ${survivors} kept`,
      'More are produced than are needed, so the weakest can be dropped.',
    );
  }

  const language = obj(contract?.language_mix);
  if (language) {
    const primary = str(language.primary);
    const secondary = str(language.secondary);
    push(
      'Language',
      primary
        ? secondary
          ? `${primary}, some ${secondary}`
          : primary
        : str(language.rule),
    );
  }

  const tracks = arr(contract?.creative_tracks)
    .map((t) => str(t))
    .filter((t): t is string => t !== null);
  push(
    'Styles',
    tracks.length ? tracks.map(titleize).join(' and ') : null,
    'The visual treatments being tried against each other.',
  );

  push('Creative direction', str(contract?.creative_direction));
  push(
    'Occasion',
    str(row.occasion),
    'A date or festival this campaign is timed around.',
  );

  // Total daily spend, added up across the audiences rather than trusted from one field.
  const total = arr(contract?.audience_plan).reduce<number>((sum, entry) => {
    const budget = num(obj(entry)?.budget_value_inr);
    return budget === null ? sum : sum + budget;
  }, 0);
  push(
    'Daily budget',
    total > 0 ? rupeesPerDay(total) : null,
    'The rate this campaign spends per day once it is live.',
  );

  const judgeAfter = num(monitor?.min_spend_before_judging_inr);
  push(
    'Judge after',
    judgeAfter === null ? null : `₹${judgeAfter.toLocaleString('en-IN')} spent`,
    'An ad is not called a winner or a loser before it has had a fair run.',
  );

  const minDays = num(monitor?.min_days_before_acting);
  push(
    'Leave alone for',
    minDays === null ? null : `${minDays} day${minDays === 1 ? '' : 's'}`,
    'How long the campaign runs untouched before anything is changed.',
  );

  return fields;
}

function mapAudiences(row: Row): BrainCampaignAudience[] {
  const contract = obj(row.creative_contract);
  return arr(contract?.audience_plan)
    .map((entry) => obj(entry))
    .filter((entry): entry is Row => entry !== null)
    .map((entry) => {
      const kind = str(entry.kind);
      const budget = num(entry.budget_value_inr);
      const excluded = arr(entry.excluded_audience_ids).length;
      return {
        // The audience's own key is an internal handle ("nadi-lalook-180d-attachment"); say what
        // kind of audience it is instead, which is the part that means anything.
        name: kind
          ? kind === 'lookalike'
            ? 'People similar to past buyers'
            : kind === 'interest'
              ? 'People with matching interests'
              : kind === 'retargeting'
                ? 'People who already visited'
                : titleize(kind)
          : 'Audience',
        budget: budget === null ? null : rupeesPerDay(budget),
        adsPlanned: num(entry.ads_wanted),
        excludes: excluded
          ? `Skips ${excluded} group${excluded === 1 ? '' : 's'}, including recent buyers`
          : null,
        why: str(entry.rationale),
      };
    });
}

export function mapCampaignCreative(
  row: Row,
  imageUrl: string | null,
): BrainCampaignCreative | null {
  const key = str(row.creative_key);
  if (!key) return null;

  const status = str(row.status) ?? '';
  const meta = CREATIVE_STATUS[status] ?? {
    label: titleize(status || 'unknown'),
    tone: 'idle' as BrainRunTone,
  };

  // angle/hook/track are three internal taxonomies. One phrase is more use than three labels.
  const style = [str(row.angle), str(row.hook_type), str(row.track)]
    .filter((v): v is string => v !== null)
    .map(titleize)
    .join(' · ');

  return {
    id: key,
    imageUrl,
    headline: str(row.headline),
    caption: str(row.primary_text),
    description: str(row.link_description),
    callToAction: str(row.call_to_action)
      ? titleize(str(row.call_to_action) as string)
      : null,
    language: str(row.language),
    statusLabel: meta.label,
    tone: meta.tone,
    score: num(row.score),
    note: str(row.judged_notes),
    style: style || null,
  };
}

export function mapCampaignRun(
  row: Row,
  opts: {
    displayName?: string | null;
    chosen?: number | null;
    gateByStage?: Map<string, string>;
    blockedWhy?: string | null;
  } = {},
): BrainCampaignRun | null {
  const summary = mapCampaignRunSummary(row, opts.displayName, opts.chosen);
  if (!summary) return null;

  const gateByStage = opts.gateByStage ?? new Map<string, string>();
  const steps = mapSteps(row, gateByStage);
  const waiting = steps.find((s) => s.state === 'waiting_for_human');

  // What the reader should do about it, in one sentence. The blocked reason from the brain is
  // written for an operator, so it is used only when there is nothing better to say.
  let needsYou: string | null = null;
  if (waiting?.gateId) {
    needsYou = `This is waiting on your approval before it can go further.`;
  } else if (str(row.status) === 'failed') {
    needsYou = 'This stopped before it finished. Someone needs to look at it.';
  } else if (str(row.status) === 'abandoned') {
    needsYou = 'This was cancelled and will not go live.';
  } else if (opts.blockedWhy) {
    needsYou = 'This has been retried as often as it is allowed to be, and is waiting on a person.';
  }

  return {
    ...summary,
    // A cancelled run's headline says cancelled, not "finished". The stage is only the headline
    // while the run is still going somewhere.
    headline: `${summary.product} — ${(summary.tone === 'progress' || summary.tone === 'waiting'
      ? summary.stageLabel
      : summary.statusLabel
    ).toLowerCase()}`,
    steps,
    brief: mapBrief(row),
    audiences: mapAudiences(row),
    // `notes` is the Brain's own sentence about why this run exists. It is already prose meant
    // for a person, so it is the one internal field that passes through unchanged.
    whatHappened: str(row.notes),
    needsYou,
  };
}
