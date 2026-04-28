import { Injectable } from '@nestjs/common';

/**
 * Event Calendar Service — knows about Indian holidays, festivals, sales windows,
 * and recurring CPM-impacting events. Used by LiveContextBuilder so every agent
 * (auditor included) knows it's pre-Diwali / IPL final / post-festival lull.
 *
 * Lunar/festival dates are observed dates per Drik Panchang. Update each year.
 */

export type EventType =
  | 'national_holiday'
  | 'festival'
  | 'shopping_event'
  | 'sports'
  | 'cultural';

export interface CalendarEvent {
  name: string;
  date: string;                  // ISO date (YYYY-MM-DD)
  type: EventType;
  geographies: string[];          // ['India', 'IN'] etc — match against company.geography
  cpmImpact: 'high_spike' | 'moderate_spike' | 'normal' | 'post_event_dip';
  buyingMode?: 'gifting' | 'self_purchase' | 'auspicious_purchase' | 'discount_hunt';
  notes?: string;
}

// 2026-2027 dates per Drik Panchang for festivals; civil dates for national holidays.
// IPL final and shopping-event dates are best-known approximations (treat as TBD until
// the operating org publishes the schedule). Append new years here.
const EVENTS: CalendarEvent[] = [
  // ── 2026 ───────────────────────────────────────────────────────────────────
  { name: 'New Year', date: '2026-01-01', type: 'cultural', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'self_purchase' },
  { name: 'Pongal / Makar Sankranti', date: '2026-01-14', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'auspicious_purchase', notes: 'Major in TN/AP/KA/Punjab' },
  { name: 'Republic Day Sale Window', date: '2026-01-22', type: 'shopping_event', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'discount_hunt', notes: 'Multi-day ecom sale window leading into Jan 26' },
  { name: 'Republic Day', date: '2026-01-26', type: 'national_holiday', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'discount_hunt' },
  { name: 'Valentine\'s Day', date: '2026-02-14', type: 'cultural', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'gifting' },
  { name: 'Mahashivratri', date: '2026-02-15', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Holi', date: '2026-03-04', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike' },
  { name: 'End of Financial Year (tax push)', date: '2026-03-31', type: 'shopping_event', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'self_purchase', notes: 'Last-minute 80C tax-saving spike for fintech/insurance' },
  { name: 'Eid al-Fitr', date: '2026-03-21', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'gifting' },
  { name: 'Akshaya Tritiya', date: '2026-04-19', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'auspicious_purchase', notes: 'Jewelry / gold buying peak' },
  { name: 'IPL Final (approx)', date: '2026-05-24', type: 'sports', geographies: ['India'], cpmImpact: 'high_spike', notes: 'BCCI publishes annually — verify. CPMs spike 30-60% during finals week' },
  { name: 'Eid al-Adha', date: '2026-05-28', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike' },
  { name: 'EOSS Summer (apparel)', date: '2026-06-15', type: 'shopping_event', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'discount_hunt', notes: 'End-of-season-sale window for fashion/apparel' },
  { name: 'Income Tax Filing Deadline', date: '2026-07-31', type: 'shopping_event', geographies: ['India'], cpmImpact: 'moderate_spike', notes: 'Fintech/CA tools spike' },
  { name: 'Independence Day Sale Window', date: '2026-08-13', type: 'shopping_event', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'discount_hunt', notes: 'Multi-day sale leading into Aug 15' },
  { name: 'Independence Day', date: '2026-08-15', type: 'national_holiday', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'discount_hunt' },
  { name: 'Janmashtami', date: '2026-09-04', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Onam', date: '2026-08-26', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'auspicious_purchase', notes: 'Kerala-equivalent of Diwali — major regional buying window' },
  { name: 'Raksha Bandhan', date: '2026-08-28', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'gifting' },
  { name: 'Ganesh Chaturthi', date: '2026-09-14', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Big Billion Days / Great Indian Festival', date: '2026-10-03', type: 'shopping_event', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'discount_hunt', notes: 'Flipkart/Amazon mega sale window — CPMs +50-80%' },
  { name: 'Navratri begins', date: '2026-10-11', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Dussehra', date: '2026-10-19', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike' },
  { name: 'Karwa Chauth', date: '2026-11-01', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'gifting' },
  { name: 'Dhanteras', date: '2026-11-06', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'auspicious_purchase', notes: 'Bigger gold/utensils buying day than Diwali itself' },
  { name: 'Diwali', date: '2026-11-08', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'auspicious_purchase', notes: 'Single biggest buying window of the year — CPMs +60-120%' },
  { name: 'Bhai Dooj', date: '2026-11-11', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'gifting' },
  { name: 'Post-Diwali CPM Dip', date: '2026-11-13', type: 'shopping_event', geographies: ['India'], cpmImpact: 'post_event_dip', notes: 'Cheap inventory window — good for prospecting' },
  { name: 'Children\'s Day', date: '2026-11-14', type: 'cultural', geographies: ['India'], cpmImpact: 'normal', buyingMode: 'gifting', notes: 'Edtech/toys/kids products spike' },
  { name: 'Christmas', date: '2026-12-25', type: 'cultural', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'gifting' },

  // ── 2027 ───────────────────────────────────────────────────────────────────
  { name: 'New Year', date: '2027-01-01', type: 'cultural', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'self_purchase' },
  { name: 'Pongal / Makar Sankranti', date: '2027-01-14', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Republic Day Sale Window', date: '2027-01-22', type: 'shopping_event', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'discount_hunt' },
  { name: 'Republic Day', date: '2027-01-26', type: 'national_holiday', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'discount_hunt' },
  { name: 'Valentine\'s Day', date: '2027-02-14', type: 'cultural', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'gifting' },
  { name: 'Mahashivratri', date: '2027-03-06', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Eid al-Fitr', date: '2027-03-10', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'gifting' },
  { name: 'Holi', date: '2027-03-22', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike' },
  { name: 'End of Financial Year', date: '2027-03-31', type: 'shopping_event', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'self_purchase' },
  { name: 'Akshaya Tritiya', date: '2027-04-28', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Independence Day Sale Window', date: '2027-08-13', type: 'shopping_event', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'discount_hunt' },
  { name: 'Independence Day', date: '2027-08-15', type: 'national_holiday', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'discount_hunt' },
  { name: 'Onam', date: '2027-09-13', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Raksha Bandhan', date: '2027-08-17', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'gifting' },
  { name: 'Janmashtami', date: '2027-08-25', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Ganesh Chaturthi', date: '2027-09-04', type: 'festival', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Big Billion Days / Great Indian Festival', date: '2027-09-23', type: 'shopping_event', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'discount_hunt' },
  { name: 'Navratri begins', date: '2027-09-30', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Dussehra', date: '2027-10-09', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike' },
  { name: 'Dhanteras', date: '2027-10-26', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Diwali', date: '2027-10-29', type: 'festival', geographies: ['India'], cpmImpact: 'high_spike', buyingMode: 'auspicious_purchase' },
  { name: 'Post-Diwali CPM Dip', date: '2027-11-03', type: 'shopping_event', geographies: ['India'], cpmImpact: 'post_event_dip' },
  { name: 'Christmas', date: '2027-12-25', type: 'cultural', geographies: ['India'], cpmImpact: 'moderate_spike', buyingMode: 'gifting' },
];

/**
 * Parse YYYY-MM-DD as local-midnight (not UTC). Default `new Date('2026-04-19')`
 * is interpreted as UTC midnight, which in IST (UTC+5:30) becomes 5:30am that day —
 * causing daysAway to be off-by-one near the boundary. Always parse via components.
 */
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

export interface UpcomingEvent extends CalendarEvent {
  daysAway: number;
}

@Injectable()
export class EventCalendarService {
  /**
   * Returns events within the lookahead window for the given geography.
   * Sorted by date ascending. Day-of-event events (daysAway === 0) are included.
   */
  getUpcomingEvents(geography: string, daysAhead = 21, now: Date = new Date()): UpcomingEvent[] {
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const cutoffMs = todayMidnight.getTime() + daysAhead * 24 * 60 * 60 * 1000;
    const geo = (geography || 'India').toLowerCase();

    return EVENTS
      .filter(e => e.geographies.some(g => g.toLowerCase() === geo))
      .map(e => {
        const eventDate = parseLocalDate(e.date);
        const daysAway = Math.round((eventDate.getTime() - todayMidnight.getTime()) / (24 * 60 * 60 * 1000));
        return { ...e, daysAway, _eventMs: eventDate.getTime() };
      })
      .filter(e => e.daysAway >= 0 && e._eventMs <= cutoffMs)
      .sort((a, b) => a.daysAway - b.daysAway)
      .map(({ _eventMs, ...rest }) => rest);
  }

  /**
   * Compact summary string suitable for prompt injection.
   */
  buildEventSummary(geography: string, daysAhead = 21, now: Date = new Date()): string {
    const events = this.getUpcomingEvents(geography, daysAhead, now);
    if (events.length === 0) return 'No major events in the next 3 weeks.';
    return events
      .map(e => {
        const cpm = e.cpmImpact === 'high_spike' ? 'CPM HIGH SPIKE'
          : e.cpmImpact === 'moderate_spike' ? 'CPM moderate spike'
          : e.cpmImpact === 'post_event_dip' ? 'post-event dip'
          : 'CPM normal';
        const buy = e.buyingMode ? `, buying mode: ${e.buyingMode}` : '';
        const notes = e.notes ? ` — ${e.notes}` : '';
        return `- ${e.name} in ${e.daysAway}d (${e.date}) — ${cpm}${buy}${notes}`;
      })
      .join('\n');
  }
}
