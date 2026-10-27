import { PmCalendarTools } from './calendar.tools';

describe('PmCalendarTools', () => {
  const cal = new PmCalendarTools();

  it('returns rows overlapping the range, with days from the reference date', () => {
    // Pitru Paksha 2026-09-27 → 2026-10-10 overlaps a range starting on its last day.
    const hits = cal.query('2026-10-10', '2026-10-12', ['festival']);
    const pitru = hits.find((h) => h.id === 'pitru-paksha-2026');
    expect(pitru).toMatchObject({ status: 'ongoing', daysFromDate: 0 });
    expect(hits.find((h) => h.id === 'sharad-navratri-2026')).toMatchObject({ status: 'upcoming', daysFromDate: 1 });
    expect(hits.some((h) => h.id === 'diwali-2026')).toBe(false);
    expect(hits.every((h) => h.kind === 'festival')).toBe(true);
  });

  it('filters by region but always keeps All-India rows', () => {
    const hits = cal.query('2026-07-10', '2026-07-31', ['festival'], ['uttarakhand']);
    expect(hits.map((h) => h.id)).toEqual(expect.arrayContaining(['harela-2026', 'chaturmas-2026', 'guru-purnima-2026']));
    expect(hits.every((h) => h.regions.includes('All India') || h.regions.includes('Uttarakhand'))).toBe(true);
  });

  it('rejects bad ranges', () => {
    expect(() => cal.query('2026-10-12', '2026-10-10', ['festival'])).toThrow(/after/);
    expect(() => cal.query('2026-1-1', '2026-10-10', ['festival'])).toThrow();
  });

  it('builds festivals.md for a day: grouped, signed offsets, unverified line', () => {
    const md = cal.dayMarkdown('2026-10-27');
    expect(md).toContain('# Calendar around 2026-10-27 (2026-10-13 → 2026-11-10, IST)');
    expect(md).toMatch(/## Festivals & observances[\s\S]*Karva Chauth/);
    expect(md).toContain('2026-10-20 (7d ago) **Dussehra / Vijayadashami**');
    expect(md).toContain('2026-10-29 (in 2d) **Karva Chauth**');
    expect(md).toMatch(/## Astro events[\s\S]*Mercury retrograde/);
    expect(md).toMatch(/## Market events[\s\S]*Big Billion Days/);
    expect(md).toMatch(/Unverified \(estimates[^\n]*flipkart-bbd-2026/);
  });

  it('calendar_around tool uses daysBefore/daysAfter', async () => {
    const tool = cal.defs().find((d) => d.name === 'calendar_around')!;
    const res = (await tool.run({ date: '2026-11-08', daysBefore: 0, daysAfter: 0 }, {} as any)) as any;
    expect(res.from).toBe('2026-11-08');
    expect(res.rows.map((r: any) => r.id)).toContain('diwali-2026');
  });
});
