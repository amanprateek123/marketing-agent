import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { PmToolDef } from './pm-tool';

/**
 * Calendar tools: festivals, astro events and market events from the
 * hand-kept agent/calendar/calendar.json (IST dates, sourced, verified flag).
 * ponytail: no live panchang (tithi/nakshatra per day) — 91astro-api's MCP
 * `get_panchang` (POST /mcp, x-api-key) can be wired as a tool later.
 */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
const Kind = z.enum(['festival', 'astro_event', 'market_event']);
type Kind = z.infer<typeof Kind>;
const Row = z.object({
  id: z.string(),
  kind: Kind,
  name: z.string(),
  start: Day,
  end: Day,
  regions: z.array(z.string()),
  mood: z.enum(['auspicious', 'inauspicious_to_buy', 'devotional_peak', 'neutral', 'cpm_up']),
  note: z.string(),
  source: z.string(),
  verified: z.boolean(),
});
export type CalendarRow = z.infer<typeof Row>;
const CalendarFile = z.object({
  about: z.string(),
  updated: Day,
  rules: z.array(z.string()),
  rows: z.array(Row),
});

export type CalendarHit = CalendarRow & {
  /** 0 = ongoing on the reference date; <0 = ended that many days before; >0 = starts in. */
  daysFromDate: number;
  status: 'past' | 'ongoing' | 'upcoming';
};

const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`) / 864e5;
const addDays = (d: string, n: number) => new Date((dayNum(d) + n) * 864e5).toISOString().slice(0, 10);
const MAX_SPAN_DAYS = 400;

const SECTIONS: [Kind, string][] = [
  ['festival', 'Festivals & observances'],
  ['astro_event', 'Astro events'],
  ['market_event', 'Market events'],
];

@Injectable()
export class PmCalendarTools {
  private readonly cal = CalendarFile.parse(
    JSON.parse(readFileSync(join(__dirname, '..', 'calendar', 'calendar.json'), 'utf8')),
  );
  private readonly coverage = { from: '2026-04-01', to: '2027-12-31' };

  /** Rows overlapping [from, to] (inclusive), sorted by start, with days from `ref`. */
  query(from: string, to: string, kinds: Kind[], regions?: string[], ref = from): CalendarHit[] {
    Day.parse(from);
    Day.parse(to);
    if (from > to) throw new Error(`from (${from}) is after to (${to})`);
    if (dayNum(to) - dayNum(from) > MAX_SPAN_DAYS) throw new Error(`range is over ${MAX_SPAN_DAYS} days: narrow it`);
    const want = regions?.map((r) => r.toLowerCase());
    return this.cal.rows
      .filter((r) => kinds.includes(r.kind) && r.start <= to && r.end >= from)
      .filter((r) => !want?.length || r.regions.some((g) => g === 'All India' || want.some((w) => g.toLowerCase().includes(w))))
      .map((r) => {
        const s = dayNum(r.start) - dayNum(ref);
        const e = dayNum(r.end) - dayNum(ref);
        const status = e < 0 ? 'past' : s > 0 ? 'upcoming' : 'ongoing';
        return { ...r, daysFromDate: status === 'past' ? e : status === 'upcoming' ? s : 0, status };
      });
  }

  private warn(from: string, to: string) {
    return from < this.coverage.from || to > this.coverage.to
      ? `calendar covers ${this.coverage.from} → ${this.coverage.to} only; rows outside are missing`
      : undefined;
  }

  defs(): PmToolDef[] {
    const range = { from: Day.describe('YYYY-MM-DD (IST)'), to: Day.describe('YYYY-MM-DD (IST), inclusive') };
    const list = (from: string, to: string, kinds: Kind[], regions?: string[]) => ({
      rows: this.query(from, to, kinds, regions),
      warning: this.warn(from, to),
    });
    return [
      {
        name: 'festivals',
        description:
          'Hindu festivals and observances (Navratri, Diwali, Pitru Paksha, Kharmas, Uttarakhand festivals…) overlapping a date range, ' +
          'with buying mood (auspicious / inauspicious_to_buy / devotional_peak). Optional regions filter (e.g. ["Uttarakhand"]); All-India rows always match. ' +
          'verified=false rows are estimates.',
        shape: { ...range, regions: z.array(z.string()).optional() },
        run: async (a: { from: string; to: string; regions?: string[] }) => list(a.from, a.to, ['festival'], a.regions),
      },
      {
        name: 'astro_events',
        description:
          'Eclipses (with India visibility), retrogrades (Mercury, Venus, Mars, Jupiter, Saturn) and sidereal (Lahiri) sign changes of Jupiter, Saturn, Rahu-Ketu overlapping a date range.',
        shape: range,
        run: async (a: { from: string; to: string }) => list(a.from, a.to, ['astro_event']),
      },
      {
        name: 'market_events',
        description:
          'Indian market events that move CPMs or attention (IPL, cricket world cups, e-commerce festive sales, elections, Black Friday) overlapping a date range, plus standing rules (salary-day effect, festive CPMs).',
        shape: range,
        run: async (a: { from: string; to: string }) => ({ ...list(a.from, a.to, ['market_event']), rules: this.cal.rules }),
      },
      {
        name: 'calendar_around',
        description:
          'Everything in the calendar (festivals, astro, market) from daysBefore to daysAfter around a date, each with daysFromDate (negative = ended before). Use to explain a performance shift on a date.',
        shape: {
          date: Day,
          daysBefore: z.number().int().min(0).max(120).default(14),
          daysAfter: z.number().int().min(0).max(120).default(14),
        },
        run: async (a: { date: string; daysBefore?: number; daysAfter?: number }) => {
          const from = addDays(a.date, -(a.daysBefore ?? 14));
          const to = addDays(a.date, a.daysAfter ?? 14);
          return {
            from,
            to,
            rows: this.query(from, to, ['festival', 'astro_event', 'market_event'], undefined, a.date),
            rules: this.cal.rules,
            warning: this.warn(from, to),
          };
        },
      },
    ];
  }

  /** Body of day/<date>/festivals.md: last 14 + next 14 days, grouped by kind. */
  dayMarkdown(date: string): string {
    const from = addDays(date, -14);
    const to = addDays(date, 14);
    const hits = this.query(from, to, ['festival', 'astro_event', 'market_event'], undefined, date);
    const rel = (h: CalendarHit) => (h.status === 'ongoing' ? 'ongoing' : h.daysFromDate > 0 ? `in ${h.daysFromDate}d` : `${-h.daysFromDate}d ago`);
    const line = (h: CalendarHit) =>
      `- ${h.start === h.end ? h.start : `${h.start} → ${h.end}`} (${rel(h)}) **${h.name}** — ${h.mood.replace(/_/g, ' ')}: ${h.note}` +
      (h.regions.length && !h.regions.includes('All India') ? ` [${h.regions.join(', ')}]` : '') +
      (h.verified ? '' : ' _(unverified)_');
    const out = [`# Calendar around ${date} (${from} → ${to}, IST)`, ''];
    for (const [kind, title] of SECTIONS) {
      const rows = hits.filter((h) => h.kind === kind);
      out.push(`## ${title}`, ...(rows.length ? rows.map(line) : ['- none']), '');
    }
    out.push('## Standing rules', ...this.cal.rules.map((r) => `- ${r}`), '');
    const unverified = hits.filter((h) => !h.verified);
    out.push(
      unverified.length
        ? `Unverified (estimates — say so if you rely on them): ${unverified.map((h) => h.id).join(', ')}.`
        : 'All rows in this window are verified against a source.',
    );
    const w = this.warn(from, to);
    if (w) out.push('', `Warning: ${w}.`);
    return out.join('\n') + '\n';
  }
}
