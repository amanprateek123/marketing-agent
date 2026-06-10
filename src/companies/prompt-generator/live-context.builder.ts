import { Injectable } from '@nestjs/common';
import { CompanyDocument } from '../schemas/company.schema';
import { EventCalendarService } from '../../common/calendar/event-calendar.service';

@Injectable()
export class LiveContextBuilder {
  constructor(private readonly eventCalendar: EventCalendarService) {}

  /**
   * Build the LiveContext block injected into every agent's prompt.
   *
   * @param briefProduct  Optional. When set, learnings are rendered scoped to this
   *   product (per-product audienceScores; fresh-product framing when the product
   *   has no own-data). When omitted, learnings render tenant-aggregate — used by
   *   cross-product agents (Scouts, Coordinator) that legitimately need the wider
   *   view. Per-brief agents (Strategy, Creative, Campaign Review, Audit) should
   *   always pass this.
   */
  build(company: CompanyDocument, briefProduct?: string): string {
    const products = company.products.filter((p) => p.active);
    const now = new Date();
    const promotions = (company.activePromotions ?? []).filter(
      (p) => new Date(p.expiresAt) > now,
    );
    const upcomingEvents = this.eventCalendar.buildEventSummary(
      company.geography || 'India',
      21,
      now,
    );
    const tenantCalendar = (company.calendarContext || '').trim();
    // Resolve the brief's product entry — needed to decide cold-start framing
    // (hypothesis-stage products get explicit "these are hypotheses, not patterns" guidance).
    const briefProductEntry = briefProduct
      ? (company.products ?? []).find((p) => p.name === briefProduct)
      : undefined;

    return `
## CURRENT PRODUCTS & PRICING (LIVE DATA — always use these, never cached values)
${products.length
  ? products.map((p) => `- ${p.name}: ${p.currency}${p.price} — ${p.description}`).join('\n')
  : 'No active products currently listed.'}

## ACTIVE PROMOTIONS
${promotions.length
  ? promotions.map((p) => `- ${p.name}: ${p.details} (expires: ${p.expiresAt})`).join('\n')
  : 'None currently active.'}

## UPCOMING EVENTS (next 21 days, ${company.geography || 'India'})
${upcomingEvents}
${tenantCalendar ? `\n## TENANT-SPECIFIC CALENDAR\n${tenantCalendar}` : ''}

## CURRENT LEARNINGS (v${company.learnings?.version ?? 0})
${this.buildLearningsScopeInstruction(briefProduct, briefProductEntry)}
${company.learnings
  ? this.summarizeLearnings(company.learnings, briefProduct, briefProductEntry)
  : 'No learnings yet — this is the first run.'}
    `.trim();
  }

  /**
   * Instruction block teaching the LLM how to weight learnings by scope.
   * Critical for fresh products: prior cross-product data is HYPOTHESES not
   * validated patterns. Without this, the agent treats tenant-aggregate
   * audienceScores as if they applied to the new product (see the Nadi Leaf
   * 2026-06-03 lookalike-drop incident: analyst cited Nadi Report's ad-set
   * counts as if they applied to a different price tier).
   */
  private buildLearningsScopeInstruction(briefProduct?: string, briefProductEntry?: any): string {
    if (!briefProduct) {
      return '> Tenant-wide learnings rendered (no specific brief product set). Treat as aggregate signal across all products.';
    }
    const isFreshProduct = !briefProductEntry?.performance
      || briefProductEntry.performance.confidenceLevel === 'hypothesis'
      || (briefProductEntry.performance.totalConversions ?? 0) === 0;
    if (isFreshProduct) {
      return `> SCOPE — applying learnings to "${briefProduct}" (FRESH PRODUCT, hypothesis-stage, zero own-campaign data):
> • TENANT-WIDE wisdom (brand tone, visual aesthetic, format winners, timing patterns) → applies to this product, use directly.
> • PRODUCT-SPECIFIC atomic facts (audience ROAS, CPA numbers, audienceType winners from other products) → these are HYPOTHESES not validated patterns. Different price tiers / product classes attract different buyers; cross-product CPA and ROAS do NOT transfer. Treat them as starting priors only.
> • DO NOT cite other-product numbers as if they applied here. Prefer exploration over exploiting another product's winners. This is a measurement run — pick targeting/creative that surfaces who actually buys this product.`;
    }
    return `> SCOPE — applying learnings to "${briefProduct}" (has own-campaign data):
> • Prefer product-specific entries below (marked "[for ${briefProduct}]") over tenant-aggregate.
> • Tenant-aggregate entries (marked "[tenant-wide]") apply when brand-level (tone, format, timing). Treat them as soft priors for product-specific economics (audience ROAS, CPA), not hard truths.`;
  }

  private summarizeLearnings(learnings: any, briefProduct?: string, briefProductEntry?: any): string {
    const lines: string[] = [];
    // Hypothesis-stage product = zero own-product data. Historical
    // cross-product learnings should be SUPPRESSED (not just warned about) for
    // these products — the LLM has been observed weighting Nadi Report's
    // historical saturation pct as authoritative for Nadi Leaf's audit, even
    // with scope warnings. Cleaner to hide the data entirely.
    const isHypothesisStage = briefProduct && (
      !briefProductEntry?.performance
      || briefProductEntry.performance.confidenceLevel === 'hypothesis'
      || briefProductEntry.performance.confidenceLevel === 'none'
      || (briefProductEntry.performance.totalConversions ?? 0) === 0
    );

    const creative = learnings.creative;
    if (creative) {
      // Hook patterns are tenant-aggregate today (no per-product attribution
      // at the writer layer — see project_learnings_scope.md Tier 2 deferred).
      //
      // Hypothesis-stage products: SUPPRESS hook patterns + winningFormats
      // + losingFormats + ctaInsights entirely. These are all aggregated
      // from past campaigns which (for any tenant with one dominant existing
      // product) means the data is overwhelmingly from that other product.
      // Empirical: Nadi Leaf's audit kept citing Nadi Report's 103-ad
      // curiosity_gap pool as basis for action even with a scope warning.
      // Hiding the data is more reliable than warning about it.
      //
      // Non-hypothesis-stage products: render with scope warning (was the
      // approach before today's hypothesis-stage suppression). For tenants
      // where multiple products have own data, this preserves brand-level
      // hook intuition while flagging the price-tier sensitivity.
      if (isHypothesisStage) {
        lines.push(`- ⚠ Hook patterns / formats / CTAs from learnings SUPPRESSED for "${briefProduct}" (hypothesis-stage, zero own-product data). Tenant-wide aggregates come from other products and don't transfer to new SKUs reliably. Reason from THIS campaign's intra-campaign hookSaturation + audience signals only. Treat hookStyle choice as exploration.`);
      } else {
        const hooksScopeWarning = briefProduct
          ? `⚠ TENANT-WIDE HOOK PATTERNS (sourced from across all products — the ad-count and impression totals below are NOT specific to "${briefProduct}"). Hook performance is PRICE-TIER AND INTENT SENSITIVE: what wins for impulse mass-market products often does not transfer to premium considered-purchase products, and vice versa. Treat as STARTING HYPOTHESES not validated patterns. Justify hookStyle choice from THIS campaign's saturation + audience profile, not another product's evidence base.\n`
          : '';
        if (creative.winningHooks?.length) {
          lines.push(`${hooksScopeWarning}- Winning hooks: ${creative.winningHooks.join(', ')}`);
        }
        if (creative.losingHooks?.length) lines.push(`- Losing hooks (avoid): ${creative.losingHooks.join(', ')}`);
        if (creative.winningFormats?.length) lines.push(`- Winning formats: ${creative.winningFormats.join(', ')}`);
        if (creative.losingFormats?.length) lines.push(`- Losing formats (avoid): ${creative.losingFormats.join(', ')}`);
        if (creative.ctaInsights?.length) lines.push(`- CTA insights: ${creative.ctaInsights.join('; ')}`);
      }

      // Hook saturation per audience — Strategy Team and Creative Team must AVOID
      // hookStyles flagged saturated for the target audience. Decay filter: drop
      // entries older than 14 days so the generator isn't permanently locked out
      // of a hookStyle after one over-exposure event.
      //
      // For hypothesis-stage products: SUPPRESS this block entirely. The
      // saturation percentages are accumulated from past campaigns across all
      // products and don't apply to a fresh product. The audit prompt already
      // includes intra-campaign hookSaturation from signals.hookSaturation
      // (correct, real Nadi-Leaf data) — that's the only saturation signal
      // a fresh product should reason from.
      if (!isHypothesisStage && creative.audienceHookSaturation && Object.keys(creative.audienceHookSaturation).length > 0) {
        const SATURATION_FRESHNESS_DAYS = 14;
        const SATURATION_THRESHOLD_PCT = 60;
        const cutoff = Date.now() - SATURATION_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
        const satLines: string[] = [];
        const map = creative.audienceHookSaturation as Record<string, Record<string, { pct: number; updatedAt: Date | string }>>;
        for (const [audienceType, hooks] of Object.entries(map)) {
          const saturated: Array<[string, number]> = [];
          for (const [hookStyle, entry] of Object.entries(hooks)) {
            // Backwards-compat: old data may have stored a flat number; treat as fresh.
            const pct = typeof entry === 'number' ? (entry as number) : (entry?.pct ?? 0);
            const updatedAt = typeof entry === 'number'
              ? new Date()
              : new Date(entry?.updatedAt ?? Date.now());
            if (pct < SATURATION_THRESHOLD_PCT) continue;
            if (updatedAt.getTime() < cutoff) continue;
            saturated.push([hookStyle, pct]);
          }
          if (saturated.length === 0) continue;
          const formatted = saturated
            .sort((a, b) => b[1] - a[1])
            .map(([hook, pct]) => `${hook} (${pct}%)`)
            .join(', ');
          satLines.push(`  ${audienceType}: AVOID ${formatted}`);
        }
        if (satLines.length > 0) {
          lines.push(`- Hook saturation (≥${SATURATION_THRESHOLD_PCT}% in last ${SATURATION_FRESHNESS_DAYS}d — DO NOT generate for the listed audience):\n${satLines.join('\n')}`);
        }
      }
    }

    const campaign = learnings.campaign;
    if (campaign) {
      // Prefer per-product audienceScores when the brief specifies a product AND
      // the writer has populated this product's entry. Falls back to tenant-
      // aggregate (legacy `audienceScores`) with explicit scope tagging so the
      // LLM knows the numbers come from MULTIPLE products and may not apply.
      const LOW_N_THRESHOLD = 5;
      const renderAudienceMap = (
        map: Record<string, any>,
        scopeLabel: string,
      ): string | null => {
        if (!map || Object.keys(map).length === 0) return null;
        const normalized = Object.entries(map).map(([k, v]: [string, any]) => {
          if (typeof v === 'number') return { audience: k, roas: v, n: 0 as number, low: true };
          const roas = Number(v?.roas) || 0;
          const n = Number(v?.n) || 0;
          return { audience: k, roas, n, low: n < LOW_N_THRESHOLD };
        });
        const top = normalized
          .sort((a, b) => b.roas - a.roas)
          .slice(0, 5)
          .map((e) => {
            const nLabel = e.n > 0 ? `N=${e.n}` : 'N=?';
            const confLabel = e.low ? ' low_confidence' : '';
            return `${e.audience}: ${e.roas.toFixed(2)} (${nLabel}${confLabel})`;
          })
          .join(', ');
        return `- Top audiences ${scopeLabel}: ${top}`;
      };

      const byProduct = campaign.audienceScoresByProduct as
        | Record<string, Record<string, any>>
        | undefined;
      const productSpecificMap = briefProduct && byProduct?.[briefProduct];
      let audienceLineRendered = false;

      if (briefProduct && productSpecificMap && Object.keys(productSpecificMap).length > 0) {
        // We have per-product data for this brief's product — use it as the
        // authoritative source. This is the path that yesterday's failure mode
        // didn't have access to.
        const line = renderAudienceMap(productSpecificMap, `[for ${briefProduct}]`);
        if (line) {
          lines.push(line);
          audienceLineRendered = true;
        }
      }

      if (!audienceLineRendered && campaign.audienceScores && Object.keys(campaign.audienceScores).length > 0) {
        // Either no brief product set, or per-product data not yet populated.
        // Render tenant-aggregate WITH explicit scope tagging so the LLM doesn't
        // treat these numbers as validated for the brief's product.
        const scopeLabel = briefProduct
          ? `[⚠ TENANT-AGGREGATE — across MULTIPLE products, may NOT transfer to "${briefProduct}", especially if price tiers differ; treat as soft hypothesis]`
          : `[tenant-aggregate]`;
        const line = renderAudienceMap(campaign.audienceScores, scopeLabel);
        if (line) lines.push(line);
      }

      if (audienceLineRendered || (campaign.audienceScores && Object.keys(campaign.audienceScores).length > 0)) {
        lines.push(
          `  NOTE: Entries marked low_confidence have N<${LOW_N_THRESHOLD} campaigns. Campaign Review must not override the strategist's audience choice citing a low_confidence entry alone — pair with at least one other signal (offerAudienceFitIssues, recent causal insight, or hookSaturation). When tenant-aggregate is shown for a fresh product, treat ALL entries as hypothesis-grade regardless of N.`,
        );
      }
      if (campaign.budgetInsights?.length) lines.push(`- Budget insights: ${campaign.budgetInsights.join('; ')}`);
      if (campaign.timingInsights?.length) lines.push(`- Timing insights: ${campaign.timingInsights.join('; ')}`);

      // Offer × audience fit issues — surfaced separately from audienceScores
      // so a post-click friction problem on retargeting doesn't read as
      // "the audience is bad." The fix is offer/lander/price, not exiling
      // the audience. See OfferAudienceFitIssue.
      if (campaign.offerAudienceFitIssues?.length) {
        const FIT_FRESHNESS_DAYS = 60;
        const cutoff = Date.now() - FIT_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
        const fresh = (campaign.offerAudienceFitIssues as any[]).filter((f) => {
          const t = f?.lastUpdated ? new Date(f.lastUpdated).getTime() : 0;
          return t >= cutoff;
        });
        if (fresh.length > 0) {
          const formatted = fresh
            .sort((a, b) => (b.dataPoints ?? 0) - (a.dataPoints ?? 0))
            .slice(0, 6)
            .map((f) => `  ${f.audienceType} × ${f.productName} (N=${f.dataPoints ?? 1}): ${f.issue}`)
            .join('\n');
          lines.push(
            `- Offer × audience fit issues (post-click friction, NOT audience-quality problems — solve at offer/lander, do not exile the audience):\n${formatted}`,
          );
        }
      }
    }

    // Recent live within-campaign hook arbitration that contradicted historical
    // winningHooks. Recency-weighted flag; does not move the winning/losing lists.
    const COUNTER_SIGNAL_FRESHNESS_DAYS = 21;
    const liveCounter = (creative as any)?.liveCounterSignals as any[] | undefined;
    if (liveCounter?.length) {
      const cutoff = Date.now() - COUNTER_SIGNAL_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
      const fresh = liveCounter.filter((c) => {
        const t = c?.observedAt ? new Date(c.observedAt).getTime() : 0;
        return t >= cutoff;
      });
      if (fresh.length > 0) {
        const formatted = fresh
          .sort((a, b) => (b.deltaCPA ?? 0) - (a.deltaCPA ?? 0))
          .slice(0, 5)
          .map((c) => {
            const aud = c.audienceType ? ` on ${c.audienceType}` : '';
            const prod = c.productName ? ` (${c.productName})` : '';
            return `  ${c.winningHookStyle} beat ${c.losingHookStyle}${aud}${prod}: CPA ₹${Math.round(c.winnerCPA)} vs ₹${Math.round(c.loserCPA)} (Δ₹${Math.round(c.deltaCPA)})`;
          })
          .join('\n');
        lines.push(
          `- RECENT LIVE COUNTER-SIGNAL (last ${COUNTER_SIGNAL_FRESHNESS_DAYS}d — head-to-head variant results that contradict historical winningHooks; weight these ≥ historical aggregates when picking hooks):\n${formatted}`,
        );
      }
    }

    // Hot winners — fresh winning ads from the last 60 days that the
    // Strategy Team's exploit-winner arm clones. Surfaced here so the Creative
    // Team can also anchor on the winning hookLine pattern (NOT copy verbatim),
    // and the Campaign Review Team sees that a brief tagged winnerCloneOf
    // should NOT get the 60% cold-start budget cut.
    const HOT_WINNER_FRESHNESS_DAYS = 60;
    const hotWinners = (learnings.hotWinners ?? []) as any[];
    if (hotWinners.length > 0) {
      const cutoff = Date.now() - HOT_WINNER_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
      const fresh = hotWinners.filter((w) => {
        const t = w?.observedAt ? new Date(w.observedAt).getTime() : 0;
        return t >= cutoff;
      });
      if (fresh.length > 0) {
        const formatted = fresh
          .slice()
          .sort((a, b) => (a.cpa ?? Infinity) - (b.cpa ?? Infinity))
          .slice(0, 5)
          .map((w) => {
            const topic = w.topic ? ` [topic: ${w.topic}]` : '';
            const fmt = w.format ? `/${w.format}` : '';
            return `  ${w.hookStyle}/${w.audienceType}${fmt} @ ₹${w.budgetTier ?? '?'}/day → CPA ₹${Math.round(w.cpa)} ROAS ${(w.roas ?? 0).toFixed(2)}x (${w.conversions} conv)${topic}`;
          })
          .join('\n');
        lines.push(
          `- HOT WINNERS (last ${HOT_WINNER_FRESHNESS_DAYS}d — recent ads that crossed ROAS ≥ 2× breakeven AND ≥10 conv; the exploit-winner arm clones #1 each run):\n${formatted}`,
        );
      }
    }

    const causal = learnings.causalInsights;
    if (causal?.length) {
      // Prefer high-dataPoints insights — the consolidator merges N=1 dupes,
      // so an entry with dataPoints=5 is a real pattern. Show top 3 by dataPoints,
      // then fill with most-recent if there's room.
      const ranked = (causal as any[])
        .slice()
        .sort((a, b) => {
          const dpA = a.dataPoints ?? 1;
          const dpB = b.dataPoints ?? 1;
          if (dpB !== dpA) return dpB - dpA;
          const tA = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
          const tB = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
          return tB - tA;
        })
        .slice(0, 3);
      const top3 = ranked
        .map((c: any) => `[N=${c.dataPoints ?? 1}, conf=${(c.confidence ?? 0).toFixed(2)}] ${c.finding}`)
        .join('; ');
      lines.push(`- Recent causal insights: ${top3}`);
    }

    return lines.length > 0 ? lines.join('\n') : 'Learnings exist but no actionable patterns extracted yet.';
  }
}
