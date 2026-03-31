import { Injectable } from '@nestjs/common';
import { CompanyDocument } from '../schemas/company.schema';

@Injectable()
export class LiveContextBuilder {
  build(company: CompanyDocument): string {
    const products = company.products.filter((p) => p.active);
    const promotions = company.activePromotions ?? [];

    return `
## CURRENT PRODUCTS & PRICING (LIVE DATA — always use these, never cached values)
${products.length
  ? products.map((p) => `- ${p.name}: ${p.currency}${p.price} — ${p.description}`).join('\n')
  : 'No active products currently listed.'}

## ACTIVE PROMOTIONS
${promotions.length
  ? promotions.map((p) => `- ${p.name}: ${p.details} (expires: ${p.expiresAt})`).join('\n')
  : 'None currently active.'}

## UPCOMING CALENDAR EVENTS
${company.calendarContext || 'No calendar context provided.'}

## CURRENT LEARNINGS (v${company.learnings?.version ?? 0})
${company.learnings
  ? JSON.stringify(company.learnings, null, 2)
  : 'No learnings yet — this is the first run.'}
    `.trim();
  }
}
