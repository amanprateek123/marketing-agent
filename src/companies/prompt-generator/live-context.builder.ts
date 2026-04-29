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
      // hookStyles flagged saturated for the target audience. Without this, the
      // audit detects fatigue but the generator keeps producing the same hook.
      if (creative.audienceHookSaturation && Object.keys(creative.audienceHookSaturation).length > 0) {
        const satLines: string[] = [];
        for (const [audienceType, hooks] of Object.entries(creative.audienceHookSaturation as Record<string, Record<string, number>>)) {
          const saturated = Object.entries(hooks).filter(([, pct]) => (pct as number) >= 60);
          if (saturated.length === 0) continue;
          const formatted = saturated
            .sort((a, b) => (b[1] as number) - (a[1] as number))
            .map(([hook, pct]) => `${hook} (${pct}%)`)
            .join(', ');
          satLines.push(`  ${audienceType}: AVOID ${formatted}`);
        }
        if (satLines.length > 0) {
          lines.push(`- Hook saturation (≥60% — DO NOT generate these for the listed audience):\n${satLines.join('\n')}`);
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
