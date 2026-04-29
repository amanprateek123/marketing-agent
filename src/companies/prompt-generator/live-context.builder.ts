import { Injectable } from '@nestjs/common';
import { CompanyDocument } from '../schemas/company.schema';
import { EventCalendarService } from '../../common/calendar/event-calendar.service';

@Injectable()
export class LiveContextBuilder {
  constructor(private readonly eventCalendar: EventCalendarService) {}

  build(company: CompanyDocument): string {
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
${company.learnings
  ? this.summarizeLearnings(company.learnings)
  : 'No learnings yet — this is the first run.'}
    `.trim();
  }

  private summarizeLearnings(learnings: any): string {
    const lines: string[] = [];

    const creative = learnings.creative;
    if (creative) {
      if (creative.winningHooks?.length) lines.push(`- Winning hooks: ${creative.winningHooks.join(', ')}`);
      if (creative.losingHooks?.length) lines.push(`- Losing hooks (avoid): ${creative.losingHooks.join(', ')}`);
      if (creative.winningFormats?.length) lines.push(`- Winning formats: ${creative.winningFormats.join(', ')}`);
      if (creative.losingFormats?.length) lines.push(`- Losing formats (avoid): ${creative.losingFormats.join(', ')}`);
      if (creative.ctaInsights?.length) lines.push(`- CTA insights: ${creative.ctaInsights.join('; ')}`);

      // Hook saturation per audience — Strategy Team and Creative Team must AVOID
      // hookStyles flagged saturated for the target audience. Decay filter: drop
      // entries older than 14 days so the generator isn't permanently locked out
      // of a hookStyle after one over-exposure event.
      if (creative.audienceHookSaturation && Object.keys(creative.audienceHookSaturation).length > 0) {
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
      if (campaign.audienceScores && Object.keys(campaign.audienceScores).length > 0) {
        const top = Object.entries(campaign.audienceScores)
          .sort(([, a]: any, [, b]: any) => b - a)
          .slice(0, 5)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        lines.push(`- Top audiences: ${top}`);
      }
      if (campaign.budgetInsights?.length) lines.push(`- Budget insights: ${campaign.budgetInsights.join('; ')}`);
      if (campaign.timingInsights?.length) lines.push(`- Timing insights: ${campaign.timingInsights.join('; ')}`);
    }

    const causal = learnings.causalInsights;
    if (causal?.length) {
      const top3 = causal.slice(-3).map((c: any) => c.finding).join('; ');
      lines.push(`- Recent causal insights: ${top3}`);
    }

    return lines.length > 0 ? lines.join('\n') : 'Learnings exist but no actionable patterns extracted yet.';
  }
}
