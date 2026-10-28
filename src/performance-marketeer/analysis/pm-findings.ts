/**
 * The plain daily report: rule-based findings over the analysis results, no
 * LLM. Rules follow requirements §7–§8 — nothing is flagged on one day or on
 * low-confidence samples (< 5 orders, see pm-stats confidenceFor), "hold /
 * collect more data" is a finding, first-party numbers are labelled lower
 * bounds, and tracking problems are surfaced before performance calls.
 */
import {
  PmAction,
  PmBudgetResponse,
  PmChangesResponse,
  PmDecomposeResponse,
  PmEntitiesResponse,
  PmFatigueResponse,
  PmFinding,
  PmGeoResponse,
  PmMetrics,
  PmQuery,
  PmReconcileResponse,
  PmReportResponse,
  PmSummaryResponse,
  PmTargetCheck,
} from './pm-analysis.types';
import {
  listDays,
  poissonRateZ,
  ratio,
  relChange,
  targetOf,
  withMissingMeta,
} from './pm-stats';

export interface ReportInput {
  date: string;
  window: { last7: PmQuery; prior7: PmQuery; last30: PmQuery };
  summary: PmSummaryResponse; // last7 (its `prior` is prior7)
  priorCoverage: PmSummaryResponse['attributionCoverage'];
  byProduct: {
    product: string;
    label: string;
    last7: PmMetrics;
    prior7: PmMetrics;
    /** Last-7 Meta days missing or partial (account-level check). */
    metaMissing?: string[];
  }[];
  /** Name of what the report covers, e.g. 'All covered products' or a product label. */
  scopeName: string;
  adsets: PmEntitiesResponse; // last7
  /** Ad sets in learning or edited in the window — not judged yet. */
  adsetsOnHold?: string[];
  /** Meta days missing or partial in last30 (gates fatigue, budget, geo). */
  missing30?: string[];
  /** last30 days whose region breakdown spend does not cover the account totals (gates geo). */
  breakdownMissing30?: string[];
  /** What product scoping leaves out (last7). */
  leaks?: {
    untaggedOrders: number;
    untaggedRevenue: number;
    otherSpend: number;
  };
  decompose: PmDecomposeResponse; // account, last7 vs prior7
  fatigue: PmFatigueResponse; // last30
  budget: PmBudgetResponse; // last30
  geo: PmGeoResponse; // last30
  reconcile: PmReconcileResponse; // last7
  changes: PmChangesResponse; // last7
  generatedAt: string;
}

/** Thresholds (all documented here so the report can be audited). */
export const RULES = {
  /**
   * CPA move that counts as a trend: ≥ +25% / ≤ −20%, ≥ 5 orders in both
   * weeks, and the change in orders per rupee passes a Poisson rate test at
   * ~95% (|z| ≥ 1.96).
   */
  cpaRise: 0.25,
  cpaFall: -0.2,
  cpaMinOrders: 5,
  zCritical: 1.96,
  /** Distinct missing days (any source) in the last 7 that make it critical. */
  criticalMissingDays: 2,
  /** Below this ROAS with high confidence a miss is critical. */
  criticalRoas: 0.7,
  maxPerKind: 5,
  /** Budget reductions shown: the worst 3 by spend × shortfall. */
  maxReduce: 3,
  /** Spend share in ad sets with too few orders that warrants a "hold" note. */
  undecidedSpendShare: 0.2,
  /** Tracking: share of confirmed web orders linked to a visit. */
  minVisitCoverage: 0.85,
  coverageDrop: 0.1,
  /** Meta purchases more than this × first-party, with ≥ 10 Meta purchases. */
  metaOverFirstParty: 2,
  minMetaPurchases: 10,
  /** Site visitors per link click falling this much (≥ 500 clicks both weeks). */
  landingDrop: -0.3,
  minClicksForLanding: 500,
  /** Geo: ≥ 5 orders, ≥ 5% of spend, ROAS < 0.5× or > 1.5× the overall. */
  geoMinSpendShare: 0.05,
  geoLow: 0.5,
  geoHigh: 1.5,
  /** Overall geo ROAS above this × account first-party ROAS = data error. */
  geoImplausible: 10,
};

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const x2 = (n: number | null) => (n == null ? 'n/a' : n.toFixed(2));
const pct = (n: number | null) =>
  n == null ? 'n/a' : `${n >= 0 ? '+' : ''}${Math.round(n * 100)}%`;
const share = (n: number | null) =>
  n == null ? 'n/a' : `${Math.round(n * 100)}%`;
const win = (q: PmQuery) => `${q.from} to ${q.to}`;
const FP = 'first-party, device-matched 7-day click — a lower bound';

const roasEvidence = (m: PmMetrics, t: PmTargetCheck, q: PmQuery) =>
  `First-party ROAS ${x2(m.firstPartyRoas)} vs target ${x2(t.targetRoas)}: ${inr(m.firstPartyRevenue)} net revenue from ${m.firstPartyOrders} orders on ${inr(m.spend)} Meta spend, ${win(q)}; Meta-reported ROAS ${x2(m.metaRoas)}. Verdict: ${t.note}. Source: Meta spend + ${FP}.`;

/** CPA rose: act on the factor that explains most of it; fell: hold. */
function cpaAction(d: PmDecomposeResponse): PmAction {
  if ((d.cpa.change ?? 0) <= 0) return 'hold';
  const top = [...d.factors].sort(
    (a, b) => (b.contribution ?? 0) - (a.contribution ?? 0),
  )[0];
  return top?.name === 'clickToOrderRate'
    ? 'fix_funnel'
    : top?.name === 'ctr'
      ? 'refresh_creative'
      : 'investigate';
}

const VERDICT_WORDS: Record<PmTargetCheck['verdict'], string> = {
  above_target: 'above target',
  near_target: 'near target',
  below_target: 'below target',
  not_enough_data: 'not enough data to judge',
};

export function buildReport(i: ReportInput): PmReportResponse {
  const f: PmFinding[] = [];
  const { last7, prior7, last30 } = i.window;
  const cur = i.summary.current;
  const pri = i.summary.prior;
  const acct = {
    level: 'account' as const,
    ...(i.window.last7.product ? { id: i.window.last7.product } : {}),
    name: i.scopeName,
  };

  // 1. Data freshness — before anything else.
  const fresh = i.summary.dataFreshness;
  if (!fresh.metaThrough)
    f.push({
      severity: 'critical',
      area: 'tracking',
      entity: acct,
      title: 'No Meta data synced',
      evidence:
        'pm_meta_daily has no rows for these products, so spend, ROAS and CPA cannot be computed. Do not act on spend-based numbers until the Meta sync has run.',
      confidence: 'high',
      action: 'fix_tracking',
    });
  // Missing days in the last 7 (Meta only when some Meta data exists — the
  // critical above already covers none at all).
  const miss = fresh.missingDays ?? { meta: [], orders: [], visitors: [] };
  {
    const parts = (
      [
        ['Meta spend', fresh.metaThrough ? miss.meta : []],
        ['Orders', miss.orders],
        ['Website visitors', miss.visitors],
      ] as const
    ).filter(([, d]) => d.length);
    const distinct = new Set(parts.flatMap(([, d]) => d)).size;
    const older = fresh.metaThrough
      ? (i.missing30 ?? []).filter((d) => d < last7.from)
      : [];
    const bdMissing = fresh.metaThrough ? (i.breakdownMissing30 ?? []) : [];
    const lines = [
      ...(parts.length
        ? [
            `${parts.map(([n, d]) => `${n}: missing or partial on ${listDays(d)}`).join('; ')} (${win(last7)}). Totals for this window are understated; ROAS verdicts and spend-based findings are withheld while Meta days are missing.`,
          ]
        : []),
      ...(older.length
        ? [
            `Meta spend missing or partial on ${listDays(older)} (${win(last30)}): fatigue, budget and geo findings (30-day) are withheld.`,
          ]
        : []),
      ...(bdMissing.length
        ? [
            `Meta breakdowns missing for ${listDays(bdMissing)} (${win(last30)}): region spend is incomplete, geo findings are withheld.`,
          ]
        : []),
    ];
    if (lines.length)
      f.push({
        severity:
          distinct >= RULES.criticalMissingDays ? 'critical' : 'warning',
        area: 'tracking',
        entity: acct,
        title: 'Data missing for some days',
        evidence: `${lines.join('\n')}\nCheck the syncs before acting.`,
        confidence: 'high',
        action: 'fix_tracking',
      });
  }

  // 2. Tracking quality.
  const cov = i.summary.attributionCoverage;
  const web = i.summary.allOrders.webOrders;
  if (web >= 20 && cov.linkedToVisit != null) {
    if (cov.linkedToVisit < RULES.minVisitCoverage)
      f.push({
        severity: 'warning',
        area: 'tracking',
        entity: acct,
        title: 'Many web orders not linked to a website visit',
        evidence: `${share(cov.linkedToVisit)} of ${web} confirmed web orders were matched to an OpenPanel device, ${win(last7)} (expected ≥ ${share(RULES.minVisitCoverage)}). First-party attribution will undercount.`,
        confidence: 'high',
        action: 'fix_tracking',
      });
    for (const [k, label] of [
      ['linkedToVisit', 'linked to a visit'],
      ['linkedToMetaAd', 'linked to a Meta ad click'],
    ] as const) {
      const now = cov[k];
      const before = i.priorCoverage[k];
      if (now != null && before != null && before - now >= RULES.coverageDrop)
        f.push({
          severity: 'warning',
          area: 'tracking',
          entity: acct,
          title: `Share of orders ${label} dropped`,
          evidence: `${share(before)} (${win(prior7)}) → ${share(now)} (${win(last7)}) of confirmed web orders. Check tracking (UTMs, OpenPanel, payment events) before reading performance changes.`,
          confidence: 'medium',
          action: 'fix_tracking',
        });
    }
  }
  const rt = i.reconcile.totals;
  if (
    rt.metaPurchases >= RULES.minMetaPurchases &&
    rt.metaPurchases > RULES.metaOverFirstParty * rt.firstPartyOrders
  )
    f.push({
      severity: 'warning',
      area: 'tracking',
      entity: acct,
      title: 'Meta reports far more purchases than we can attribute',
      evidence: `Meta: ${rt.metaPurchases} purchases; first-party: ${rt.firstPartyOrders} Meta-attributed orders (${rt.allConfirmedOrders} confirmed orders in total), ${win(last7)}. Some gap is normal (view-through, modelled conversions, rotating device ids); a gap over ${RULES.metaOverFirstParty}× suggests lost UTMs or double-counted pixel events.`,
      confidence: 'medium',
      action: 'fix_tracking',
    });
  const land = relChange(
    ratio(cur.siteVisitors, cur.linkClicks),
    ratio(pri.siteVisitors, pri.linkClicks),
  );
  if (
    land != null &&
    land <= RULES.landingDrop &&
    Math.min(cur.linkClicks, pri.linkClicks) >= RULES.minClicksForLanding
  )
    f.push({
      severity: 'warning',
      area: 'tracking',
      entity: acct,
      title: 'Clicks are not arriving on the site',
      evidence: `Site visitors per Meta link click ${pct(land)}: ${cur.siteVisitors}/${cur.linkClicks} (${win(last7)}) vs ${pri.siteVisitors}/${pri.linkClicks} (${win(prior7)}). Investigate load speed, redirects, UTM loss or tracking.`,
      confidence: 'medium',
      action: 'investigate',
    });

  // 3. Account ROAS vs target. When the account itself is below target,
  // that is said once here (with the lagging products/ad sets as evidence)
  // instead of one warning per entity.
  const t = i.summary.target;
  const acctBelow = t.verdict === 'below_target';
  const onHold = new Set(i.adsetsOnHold ?? []);
  const belowList = [
    ...(i.window.last7.product ? [] : i.byProduct)
      .map((p) => ({
        name: p.label,
        m: p.last7,
        t: withMissingMeta(targetOf(p.last7), p.metaMissing),
      }))
      .filter((x) => x.t.verdict === 'below_target'),
    ...i.adsets.rows
      .filter(
        (r) =>
          !onHold.has(r.id) &&
          r.target.verdict === 'below_target' &&
          r.target.confidence !== 'low',
      )
      .slice(0, RULES.maxPerKind)
      .map((r) => ({
        name: `ad set ${r.name || r.id}`,
        m: r.metrics,
        t: r.target,
      })),
  ];
  if (acctBelow)
    f.push({
      severity:
        t.confidence === 'high' &&
        (cur.firstPartyRoas ?? 0) < RULES.criticalRoas
          ? 'critical'
          : 'warning',
      area: 'roas',
      entity: acct,
      title:
        'ROAS below target across the account (last 7 days) — investigate funnel, offer and creative',
      evidence: `${roasEvidence(cur, t, last7)}${
        belowList.length
          ? ` Also below target: ${belowList.map((x) => `${x.name} (first-party ${x2(x.m.firstPartyRoas)}, Meta ${x2(x.m.metaRoas)}, ${inr(x.m.spend)})`).join('; ')}.`
          : ''
      } An account-wide shortfall is not fixed by cutting single ad sets.`,
      confidence: t.confidence,
      action: 'investigate',
    });
  else
    f.push(
      t.verdict === 'not_enough_data'
        ? {
            severity: 'info',
            area: 'roas',
            entity: acct,
            title: 'Hold — not enough data to judge ROAS',
            evidence: `${t.note}. ${roasEvidence(cur, t, last7)}`,
            confidence: 'low',
            action: 'hold',
          }
        : {
            severity:
              t.verdict === 'below_target'
                ? t.confidence === 'high' &&
                  (cur.firstPartyRoas ?? 0) < RULES.criticalRoas
                  ? 'critical'
                  : 'warning'
                : t.verdict === 'above_target'
                  ? 'positive'
                  : 'info',
            area: 'roas',
            entity: acct,
            title: `ROAS ${VERDICT_WORDS[t.verdict]} (last 7 days)`,
            evidence: roasEvidence(cur, t, last7),
            confidence: t.confidence,
            action: t.verdict === 'below_target' ? 'investigate' : 'hold',
          },
    );

  // 4–9 compare spend; with Meta days missing they would mislead, so they
  // wait until the gap is filled (the tracking finding says so).
  const metaGap = !!(fresh.metaThrough && miss.meta.length);
  const gap30 = !!(fresh.metaThrough && i.missing30?.length);
  if (!metaGap) {
    // 4. CPA trend with its decomposition.
    const d = i.decompose;
    const z = poissonRateZ(
      cur.firstPartyOrders,
      cur.spend,
      pri.firstPartyOrders,
      pri.spend,
    );
    if (
      d.confidence !== 'low' &&
      d.cpa.change != null &&
      Math.min(cur.firstPartyOrders, pri.firstPartyOrders) >=
        RULES.cpaMinOrders &&
      z != null &&
      Math.abs(z) >= RULES.zCritical
    ) {
      if (d.cpa.change >= RULES.cpaRise || d.cpa.change <= RULES.cpaFall)
        f.push({
          severity: d.cpa.change > 0 ? 'warning' : 'positive',
          area: 'trend',
          entity: acct,
          title: `First-party CPA ${d.cpa.change > 0 ? 'up' : 'down'} ${pct(d.cpa.change)} week on week`,
          evidence: `CPA ${inr(d.cpa.prior!)} (${win(prior7)}) → ${inr(d.cpa.current!)} (${win(last7)}). ${d.read} Factors: ${d.factors.map((x) => `${x.name} ${pct(x.change)}`).join(', ')}. Source: Meta delivery + ${FP}.`,
          confidence: d.confidence,
          action: cpaAction(d),
        });
    }

    // 5. Products.
    // Per-product calls only when the report spans several (else it repeats §3).
    for (const p of i.window.last7.product ? [] : i.byProduct) {
      const pt = withMissingMeta(targetOf(p.last7), p.metaMissing);
      if (pt.confidence === 'low' || pt.verdict === 'near_target') continue;
      if (pt.verdict === 'not_enough_data') continue;
      if (acctBelow && pt.verdict === 'below_target') continue; // in §3
      f.push({
        severity: pt.verdict === 'below_target' ? 'warning' : 'positive',
        area: 'roas',
        entity: { level: 'account', id: p.product, name: p.label },
        title: `${p.label}: ROAS ${VERDICT_WORDS[pt.verdict]}`,
        evidence: roasEvidence(p.last7, pt, { ...last7, product: p.product }),
        confidence: pt.confidence,
        action: pt.verdict === 'below_target' ? 'investigate' : 'hold',
      });
    }

    // 6. Ad sets (last 7 days).
    const rows = i.adsets.rows.filter((r) => !onHold.has(r.id));
    const name = (r: (typeof rows)[number]) => r.name || r.id;
    const below = rows.filter(
      (r) =>
        r.target.verdict === 'below_target' && r.target.confidence !== 'low',
    );
    for (const r of acctBelow ? [] : below.slice(0, RULES.maxPerKind))
      f.push({
        severity: 'warning',
        area: 'roas',
        entity: { level: 'adset', id: r.id, name: name(r) },
        title: `Ad set below target: ${name(r)}`,
        evidence: `${roasEvidence(r.metrics, r.target, last7)} Check its funnel and recent edits before changing budget.`,
        confidence: r.target.confidence,
        action: 'investigate',
      });
    const strong = rows.filter(
      (r) =>
        r.target.verdict === 'above_target' && r.target.confidence === 'high',
    );
    for (const r of strong.slice(0, 3))
      f.push({
        severity: 'positive',
        area: 'roas',
        entity: { level: 'adset', id: r.id, name: name(r) },
        title: `Ad set above target: ${name(r)}`,
        evidence: roasEvidence(r.metrics, r.target, last7),
        confidence: 'high',
        action: 'test',
      });
    const undecided = rows.filter(
      (r) => r.target.verdict === 'not_enough_data',
    );
    const undecidedSpend = undecided.reduce((s, r) => s + r.metrics.spend, 0);
    if (
      undecided.length &&
      cur.spend > 0 &&
      undecidedSpend / cur.spend >= RULES.undecidedSpendShare
    )
      f.push({
        severity: 'info',
        area: 'roas',
        entity: acct,
        title: 'Hold — several ad sets have too few orders to judge',
        evidence: `${undecided.length} ad sets spent ${inr(undecidedSpend)} (${share(undecidedSpend / cur.spend)} of spend) with fewer than 5 first-party orders each, ${win(last7)}. Let them collect more data before scaling or cutting.`,
        confidence: 'low',
        action: 'hold',
      });
  }
  if (!gap30) {
    // 7. Creative fatigue (last 30 days).
    const fat = i.fatigue.rows;
    const adName = (r: (typeof fat)[number]) => r.adName || r.adId;
    for (const r of fat
      .filter((r) => r.status === 'fatigued')
      .slice(0, RULES.maxPerKind))
      f.push({
        severity: 'warning',
        area: 'fatigue',
        entity: { level: 'ad', id: r.adId, name: adName(r) },
        title: `Creative fatigue: ${adName(r)}`,
        evidence: `${r.reasons.join('; ')} — first 7 vs last 7 active days, ${win(last30)}, ${inr(r.spend)} spend. Source: Meta delivery${r.cpaLast7 != null ? ` + ${FP}` : ''}. Consider refreshing the creative.`,
        confidence: 'medium',
        action: 'refresh_creative',
      });
    for (const r of fat.filter((r) => r.status === 'watch').slice(0, 3))
      f.push({
        severity: 'info',
        area: 'fatigue',
        entity: { level: 'ad', id: r.adId, name: adName(r) },
        title: `Watch for fatigue: ${adName(r)}`,
        evidence: `${r.reasons.join('; ')} — first 7 vs last 7 active days, ${win(last30)}.`,
        confidence: 'low',
        action: 'hold',
      });

    // 8. Budget signals (last 30 days).
    const sev = {
      reduce: 'warning',
      room_to_scale: 'positive',
      saturating: 'info',
    } as const;
    const action = {
      reduce: 'reduce_budget',
      room_to_scale: 'test',
      saturating: 'hold',
    } as const;
    const title = {
      reduce: 'Consider reducing budget',
      room_to_scale: 'Candidate for a controlled budget test (+10–20%)',
      saturating: 'Signs of saturation',
    };
    // Reductions: only the worst few by spend × shortfall vs target.
    const shortfall = (r: (typeof i.budget.rows)[number]) =>
      r.spend * Math.max(0, 1 - (r.firstPartyRoas ?? 0));
    for (const s of ['reduce', 'room_to_scale', 'saturating'] as const)
      for (const r of i.budget.rows
        .filter((r) => r.signal === s)
        .sort((a, b) => (s === 'reduce' ? shortfall(b) - shortfall(a) : 0))
        .slice(0, s === 'reduce' ? RULES.maxReduce : RULES.maxPerKind))
        f.push({
          severity: sev[s],
          area: 'budget',
          entity: { level: r.level, id: r.id, name: r.name || r.id },
          title: `${title[s]}: ${r.name || r.id}`,
          evidence: `${r.reasons.join('; ')}. ${inr(r.spend)} spend, ${win(last30)}. Descriptive, not causal; needs approval.`,
          confidence: s === 'room_to_scale' ? 'medium' : 'low',
          action: action[s],
        });

    // 9. Geography (last 30 days) — investigate, never exclude on this alone.
    // Skipped when region spend has gaps, or when the overall estimate is
    // implausible (> 10× the account's first-party ROAS) — a data error.
    const geoSpend = i.geo.rows.reduce((s, r) => s + r.spend, 0);
    const geoRoas = ratio(
      i.geo.rows.reduce((s, r) => s + r.firstPartyRevenue, 0),
      geoSpend,
    );
    const acctRoas = cur.firstPartyRoas;
    const geoOk =
      !(i.breakdownMissing30 ?? []).length &&
      geoRoas != null &&
      acctRoas != null &&
      geoRoas <= RULES.geoImplausible * acctRoas;
    if (geoOk && geoRoas != null)
      for (const r of i.geo.rows) {
        if (
          r.confidence === 'low' ||
          r.roasEstimate == null ||
          r.spend < RULES.geoMinSpendShare * geoSpend
        )
          continue;
        const rel = r.roasEstimate / geoRoas;
        if (rel >= RULES.geoLow && rel <= RULES.geoHigh) continue;
        f.push({
          severity: rel < RULES.geoLow ? 'info' : 'positive',
          area: 'geo',
          entity: { level: 'account', name: r.state },
          title: `${r.state}: ROAS ${rel < 1 ? 'well below' : 'well above'} average`,
          evidence: `Estimated ROAS ${x2(r.roasEstimate)} vs ${x2(geoRoas)} overall (${r.firstPartyOrders} orders, ${inr(r.spend)} Meta spend, visit→order ${share(r.visitToOrderRate)}), ${win(last30)}. Meta region spend + ${FP}; geographies can disagree. Investigate funnel and payments here before any targeting change.`,
          confidence: r.confidence,
          action: rel < RULES.geoLow ? 'investigate' : 'test',
        });
      }
  }

  // Scope leaks — orders/spend the product scoping leaves out.
  const lk = i.leaks;
  if (lk && (lk.untaggedOrders || lk.otherSpend))
    f.push({
      severity: 'info',
      area: 'tracking',
      entity: acct,
      title: 'Some Meta orders or spend fall outside the covered products',
      evidence: `${lk.untaggedOrders} Meta-attributed orders (${inr(lk.untaggedRevenue)}) came from ads that are untagged or tagged outside the covered products, and ${inr(lk.otherSpend)} Meta spend went to such ads, ${win(last7)}. Neither is in the ROAS above (orders follow their ad's product tag, like spend). Tag those ads if they sell a covered product.`,
      confidence: 'high',
      action: 'fix_tracking',
    });

  // 10. Recent edits.
  const ch = i.changes.rows;
  if (ch.length) {
    const objects = [...new Set(ch.map((c) => c.objectName || c.objectId))];
    f.push({
      severity: 'info',
      area: 'change',
      entity: acct,
      title: `${ch.length} campaign edit${ch.length === 1 ? '' : 's'} in the last 7 days`,
      evidence: `Edited: ${objects.slice(0, 5).join(', ')}${objects.length > 5 ? ` and ${objects.length - 5} more` : ''} (${win(last7)}, Meta activity log). Results right after an edit may reflect learning, not the new setting.`,
      confidence: 'high',
      action: 'hold',
    });
  }

  const order = { critical: 0, warning: 1, positive: 2, info: 3 };
  f.sort((a, b) => order[a.severity] - order[b.severity]);

  const n = (s: PmFinding['severity']) =>
    f.filter((x) => x.severity === s).length;
  const all = i.summary.allOrders;
  const headline =
    `${win(last7)}: ${inr(cur.spend)} Meta spend, ${cur.firstPartyOrders} Meta-attributed orders (lower bound), ROAS ${x2(cur.firstPartyRoas)} — ${VERDICT_WORDS[t.verdict]} (${t.confidence} confidence). ` +
    `${all.orders} confirmed orders in total across all channels. ` +
    `${n('critical')} critical, ${n('warning')} warnings, ${n('positive')} positives.`;

  return {
    date: i.date,
    window: i.window,
    headline,
    kpis: { last7: cur, prior7: pri, target: t },
    byProduct: i.byProduct.map(({ metaMissing, ...p }) => ({
      ...p,
      target: withMissingMeta(targetOf(p.last7), metaMissing),
    })),
    findings: f,
    generatedAt: i.generatedAt,
  };
}
