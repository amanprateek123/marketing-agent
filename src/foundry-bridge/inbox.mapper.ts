import type {
  BrainAlertSeverity,
  BrainCompetitor,
  BrainCompetitorCandidate,
  BrainCompetitorFinding,
  BrainGate,
  BrainInboxAlert,
  BrainInboxCounts,
  BrainInboxGate,
  BrainInboxQuestion,
  BrainProductOption,
  BrainReport,
  BrainReportFigure,
  BrainWaitingRun,
} from './brain.types';

/**
 * Brain rows → the plain model the "Waiting on you", Reports and Competitors pages draw.
 *
 * The rule every function here keeps: no enum value, table id, principal string or raw object
 * reaches the page. Ids travel as an opaque `ref` the page only sends back. A value this file has
 * no word for is humanised ("awaiting_clarification" → "Awaiting clarification"), never passed
 * through raw.
 */

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function obj(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function ref(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return str(value);
}

/** "awaiting_clarification" → "Awaiting clarification". */
export function humanise(value: string): string {
  const spaced = value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : '';
}

/** Rows out of `{rows}`, `{items}`, `{<key>}` or a bare array. */
export function rowsOf(payload: unknown, ...keys: string[]): Row[] {
  if (Array.isArray(payload)) return payload.map(obj).filter((r): r is Row => r !== null);
  const p = obj(payload);
  if (!p) return [];
  for (const key of [...keys, 'rows', 'items']) {
    if (Array.isArray(p[key])) {
      return (p[key] as unknown[]).map(obj).filter((r): r is Row => r !== null);
    }
  }
  return [];
}

/* ── Who asked ──────────────────────────────────────────────────────────── */

/**
 * `dash:brain:ujjwal` → "You" when it is the signed-in person, their name otherwise; agent and
 * system principals get the name of the thing that asked. A raw principal is never shown.
 */
export function askedByLabel(value: unknown, viewer?: string | null): string {
  const s = str(value);
  if (!s) return 'The Brain';
  const dash = /^dash:[a-z]+:(.+)$/i.exec(s);
  if (dash) {
    if (viewer && dash[1] === viewer) return 'You';
    return humanise(dash[1]);
  }
  const lower = s.toLowerCase();
  if (lower.includes('brain')) return 'The Brain';
  if (lower.includes('daemon') || lower.includes('worker') || lower === 'system') {
    return 'The system';
  }
  if (lower.includes('creative') || lower.includes('pipeline')) return 'The creative pipeline';
  if (lower.includes('monitor')) return 'The spend monitor';
  if (lower.includes('analyst')) return 'The performance analyst';
  if (lower.startsWith('agent:')) return humanise(s.slice(6));
  // A bare Slack id (U0123…) is an internal id; say who it is in words instead.
  if (/^U[A-Z0-9]{6,}$/.test(s)) return 'A teammate';
  return humanise(s);
}

/* ── Questions ──────────────────────────────────────────────────────────── */

const QUESTION_KIND: Record<string, string> = {
  stall: 'Stalled campaign',
  stalled: 'Stalled campaign',
  stalled_run: 'Stalled campaign',
  plan_missing: 'Missing plan',
  missing_plan: 'Missing plan',
  agent: 'Question from an agent',
  agent_question: 'Question from an agent',
  human: 'Your question',
  operator: 'Your question',
  clarification: 'Needs more detail',
};

const QUESTION_STATUS: Record<string, string> = {
  open: 'Waiting for an answer',
  pending: 'Waiting for an answer',
  asked: 'Waiting for an answer',
  answered: 'Answered',
  delivered: 'Answered',
  closed: 'Closed',
  expired: 'Expired without an answer',
  cancelled: 'Withdrawn',
};

export function mapQuestion(row: Row, viewer?: string | null): BrainInboxQuestion | null {
  const id = ref(row.id);
  const question = str(row.question) ?? str(row.text) ?? str(row.body);
  if (!id || !question) return null;
  const answer = str(row.answer) ?? str(row.answer_text);
  const status = (str(row.status) ?? (answer ? 'answered' : 'open')).toLowerCase();
  const open = !answer && !['answered', 'delivered', 'closed', 'expired', 'cancelled'].includes(status);
  const kind = str(row.kind);
  return {
    ref: id,
    question,
    askedBy: askedByLabel(row.asked_by_principal ?? row.asked_by, viewer),
    kindLabel: kind ? (QUESTION_KIND[kind.toLowerCase()] ?? humanise(kind)) : null,
    statusLabel: QUESTION_STATUS[status] ?? humanise(status),
    open,
    answer,
    askedAt: str(row.created_at) ?? str(row.asked_at),
    answeredAt: str(row.answered_at),
  };
}

/* ── Alerts ─────────────────────────────────────────────────────────────── */

const SEVERITY_LABEL: Record<BrainAlertSeverity, string> = {
  info: 'For your information',
  warn: 'Needs a look',
  critical: 'Urgent',
};

const SOURCE_LABEL: Record<string, string> = {
  creativebot: 'Creative pipeline',
  creative_pipeline: 'Creative pipeline',
  pipeline: 'Creative pipeline',
  credential_health: 'Account connections',
  credentials: 'Account connections',
  monitor: 'Spend monitor',
  brain: 'The Brain',
  worker: 'Background worker',
  daemon: 'Background worker',
  dashboard: 'Dashboard',
  marketing_agent: 'Dashboard',
  resize: 'Image resizing',
};

export function severityOf(value: unknown): BrainAlertSeverity {
  const s = (str(value) ?? '').toLowerCase();
  if (s === 'critical' || s === 'error' || s === 'high') return 'critical';
  if (s === 'warn' || s === 'warning' || s === 'medium') return 'warn';
  return 'info';
}

export function mapAlert(row: Row): BrainInboxAlert | null {
  const id = ref(row.id);
  const title = str(row.title);
  if (!id || !title) return null;
  const severity = severityOf(row.severity);
  const source = str(row.source);
  return {
    ref: id,
    severity,
    severityLabel: SEVERITY_LABEL[severity],
    title,
    body: str(row.body) ?? '',
    sourceLabel: source ? (SOURCE_LABEL[source.toLowerCase()] ?? humanise(source)) : null,
    raisedAt: str(row.created_at),
    acknowledged: Boolean(str(row.acknowledged_at)),
  };
}

/* ── Reports ────────────────────────────────────────────────────────────── */

const REPORT_KIND: Record<string, string> = {
  performance: 'Performance report',
  performance_report: 'Performance report',
  campaign_report: 'Campaign report',
  daily_brief: 'Daily brief',
  brief: 'Daily brief',
  monitor: 'Spend watch',
  incident: 'Incident',
  incidents: 'Incident',
  weekly: 'Weekly summary',
};

export function reportKindLabel(kind: string): string {
  return REPORT_KIND[kind.toLowerCase()] ?? humanise(kind);
}

const VERDICT: Record<string, { label: string; tone: BrainReport['verdictTone'] }> = {
  good: { label: 'Going well', tone: 'good' },
  ok: { label: 'On track', tone: 'good' },
  on_track: { label: 'On track', tone: 'good' },
  healthy: { label: 'On track', tone: 'good' },
  improving: { label: 'Improving', tone: 'good' },
  watch: { label: 'Keep an eye on it', tone: 'watch' },
  warn: { label: 'Keep an eye on it', tone: 'watch' },
  warning: { label: 'Keep an eye on it', tone: 'watch' },
  mixed: { label: 'Mixed results', tone: 'watch' },
  flat: { label: 'No real change', tone: 'neutral' },
  bad: { label: 'Needs attention', tone: 'bad' },
  off_track: { label: 'Needs attention', tone: 'bad' },
  critical: { label: 'Needs attention', tone: 'bad' },
  declining: { label: 'Getting worse', tone: 'bad' },
};

const MONEY_KEY = /(inr|spend|revenue|budget|cost|cpa|cpp|amount)/i;
const PCT_KEY = /(pct|percent|rate|ctr)/i;

const FIGURE_LABEL: Record<string, string> = {
  spend: 'Spend',
  spend_inr: 'Spend',
  revenue: 'Revenue',
  revenue_inr: 'Revenue',
  roas: 'Return on ad spend',
  ctr: 'Click rate',
  ctr_pct: 'Click rate',
  purchases: 'Sales',
  cost_per_purchase: 'Cost per sale',
  cpa: 'Cost per sale',
  impressions: 'Times shown',
  clicks: 'Clicks',
};

export function rupees(value: number): string {
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

function figureValue(key: string, value: unknown): string | null {
  const n = num(value);
  if (n === null) return str(value);
  if (MONEY_KEY.test(key)) return rupees(n);
  if (/roas/i.test(key)) return `${n.toFixed(2)}x`;
  if (PCT_KEY.test(key)) return `${n.toFixed(n < 10 ? 2 : 1)}%`;
  return Math.round(n) === n ? n.toLocaleString('en-IN') : n.toFixed(2);
}

/** `figures` as an ordered list of label/value pairs, whatever shape it arrived in. */
export function mapFigures(value: unknown): BrainReportFigure[] {
  const out: BrainReportFigure[] = [];
  if (Array.isArray(value)) {
    for (const raw of value) {
      const f = obj(raw);
      if (!f) continue;
      const key = str(f.key) ?? str(f.label) ?? str(f.name);
      if (!key) continue;
      const shown = figureValue(key, f.value);
      if (shown === null) continue;
      out.push({ label: str(f.label) ?? FIGURE_LABEL[key] ?? humanise(key), value: shown });
    }
    return out;
  }
  const o = obj(value);
  if (!o) return out;
  for (const [key, raw] of Object.entries(o)) {
    // Nested objects are detail, not a headline figure.
    if (raw && typeof raw === 'object') continue;
    const shown = figureValue(key, raw);
    if (shown === null) continue;
    out.push({ label: FIGURE_LABEL[key] ?? humanise(key), value: shown });
  }
  return out.slice(0, 8);
}

export function panelUrlOf(pageRef: unknown, baseUrl: string): string | null {
  const s = str(pageRef);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/${s.replace(/^\/+/, '')}`;
}

export function mapReport(row: Row, panelsBaseUrl = ''): BrainReport | null {
  const id = ref(row.id);
  if (!id) return null;
  const kind = str(row.kind) ?? 'report';
  const verdictKey = (str(row.verdict) ?? '').toLowerCase();
  const verdict = verdictKey ? (VERDICT[verdictKey] ?? { label: humanise(verdictKey), tone: 'neutral' as const }) : null;
  const headline = str(row.headline) ?? str(row.title) ?? reportKindLabel(kind);
  const date = str(row.report_date);
  return {
    ref: id,
    kind: kind.toLowerCase(),
    kindLabel: reportKindLabel(kind),
    reportDate: date ? date.slice(0, 10) : null,
    headline,
    verdictLabel: verdict?.label ?? null,
    verdictTone: verdict?.tone ?? 'neutral',
    body: str(row.body) ?? '',
    needsAttention: row.needs_attention === true,
    panelUrl: panelUrlOf(row.page_ref, panelsBaseUrl),
    figures: mapFigures(row.figures),
    deliveredAt: str(row.delivered_at),
    read: Boolean(str(row.read_at)),
  };
}

/* ── Gates and waiting runs ─────────────────────────────────────────────── */

const GATE_KIND_LABEL: Record<string, string> = {
  idea_selection: 'Pick ideas',
  creative_craft: 'Review creatives',
  campaign_launch: 'Approve spend',
  plan_approval: "Approve the day's plan",
  plan: "Approve the day's plan",
};

export function mapInboxGate(gate: BrainGate): BrainInboxGate {
  const kindLabel =
    gate.spendGate === 'plan'
      ? GATE_KIND_LABEL.plan
      : (GATE_KIND_LABEL[gate.kind] ?? humanise(gate.kind));
  return {
    ref: gate.gateId,
    title: gate.title,
    summary: gate.summary,
    kindLabel,
    product: gate.product,
    askedAt: gate.askedAt || null,
    expiresAt: gate.expiresAt,
  };
}

/**
 * A creative run parked on `awaiting_clarification`, from the creative pipeline's run list.
 * Tolerates the few shapes that list may take; a run with no question is skipped, because there is
 * nothing for a person to answer.
 */
export function mapWaitingRun(raw: unknown): BrainWaitingRun | null {
  const row = obj(raw);
  if (!row) return null;
  const runRef = ref(row.run_id) ?? ref(row.id);
  const status = str(row.status);
  if (!runRef || (status && status !== 'awaiting_clarification')) return null;
  const clar = obj(row.clarification);
  const question =
    str(row.question) ??
    str(row.clarification_question) ??
    str(clar?.question) ??
    (Array.isArray(row.questions) ? str((row.questions as unknown[])[0]) : null);
  if (!question) return null;
  return {
    runRef,
    product: str(row.offering_name) ?? str(row.product) ?? str(row.offering),
    question,
    since: str(row.updated_at) ?? str(row.created_at),
  };
}

/* ── Counts ─────────────────────────────────────────────────────────────── */

export function countsFrom(
  summary: Row | null,
  fallback: { gates: number; questions: number; reports: number; alerts: number; waiting: number },
): BrainInboxCounts {
  const pick = (key: string, fb: number) => {
    const n = summary ? num(summary[key]) : null;
    return n !== null && n >= 0 ? Math.round(n) : fb;
  };
  const gates = pick('gates_pending', fallback.gates);
  const questions = pick('questions_open', fallback.questions);
  const reports = pick('reports_unread', fallback.reports);
  const alerts = pick('alerts_open', fallback.alerts);
  const waiting = fallback.waiting;
  return {
    gates,
    questions,
    reports,
    alerts,
    waiting,
    total: gates + questions + reports + alerts + waiting,
    known: summary !== null,
  };
}

/* ── Competitors ────────────────────────────────────────────────────────── */

function productsOf(value: unknown, names: Map<string, string>): BrainProductOption[] {
  if (!Array.isArray(value)) return [];
  const out: BrainProductOption[] = [];
  for (const raw of value) {
    const slug = str(raw) ?? str(obj(raw)?.slug);
    if (!slug) continue;
    out.push({ key: slug, name: names.get(slug) ?? humanise(slug) });
  }
  return out;
}

export function mapCompetitor(raw: unknown, names: Map<string, string>): BrainCompetitor | null {
  const row = obj(raw);
  const name = str(row?.name);
  if (!row || !name) return null;
  return {
    name,
    website: str(row.website),
    facebookPage: str(row.facebook_page),
    products: productsOf(row.products, names),
  };
}

/** The config value `competitors` as the brain returns it: `{competitors:[…]}` or a bare list. */
export function competitorsOf(payload: unknown, names: Map<string, string>): BrainCompetitor[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(obj(payload)?.competitors)
      ? (obj(payload)!.competitors as unknown[])
      : Array.isArray(obj(obj(payload)?.value)?.competitors)
        ? (obj(obj(payload)!.value)!.competitors as unknown[])
        : [];
  return list.map((c) => mapCompetitor(c, names)).filter((c): c is BrainCompetitor => c !== null);
}

const ANGLE_WORDS: Record<string, string> = {
  pain_point: 'pain point',
  price_led: 'price-led',
  social_proof: 'social proof',
  fear_of_missing_out: 'fear of missing out',
  fomo: 'fear of missing out',
  question: 'a question',
  urgency: 'urgency',
  authority: 'expert authority',
  testimonial: 'a testimonial',
};

function phrase(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  // A code-shaped value (snake_case, no spaces) is vocabulary; a sentence is shown as written.
  if (/^[A-Za-z0-9_]+$/.test(s) && /[_a-z]/.test(s) && !/ /.test(s)) {
    const key = s.toLowerCase();
    return ANGLE_WORDS[key] ?? humanise(key).toLowerCase();
  }
  return s;
}

export function mapFinding(row: Row): BrainCompetitorFinding | null {
  const id = ref(row.id);
  const competitor = str(row.competitor);
  if (!id || !competitor) return null;
  const kind = (str(row.kind) ?? 'ad').toLowerCase();
  const media = str(row.media_url);
  const link = str(row.url);
  return {
    ref: id,
    competitor,
    kindLabel: kind === 'page' ? 'Web page' : 'Ad',
    headline: str(row.headline),
    hook: str(row.hook),
    angle: phrase(row.angle),
    offer: str(row.offer),
    cta: phrase(row.cta),
    imageUrl: media && /^https?:\/\//i.test(media) ? media : null,
    link: link && /^https?:\/\//i.test(link) ? link : null,
    firstSeen: str(row.first_seen),
    lastSeen: str(row.last_seen),
    longRunning: row.long_running === true,
  };
}

export function mapCandidate(row: Row, names: Map<string, string>): BrainCompetitorCandidate | null {
  const id = ref(row.id);
  const claim =
    str(row.statement) ?? str(row.claim) ?? str(row.learning) ?? str(row.text) ?? str(row.summary);
  if (!id || !claim) return null;
  const slug = str(row.offering_slug);
  const detail = obj(row.detail);
  const evidence = str(row.evidence_summary) ?? str(row.evidence) ?? str(detail?.evidence) ?? str(row.rationale);
  return {
    ref: id,
    claim,
    product: slug ? (names.get(slug) ?? humanise(slug)) : null,
    competitor: str(row.competitor) ?? str(detail?.competitor),
    evidence,
    proposedAt: str(row.created_at),
  };
}
