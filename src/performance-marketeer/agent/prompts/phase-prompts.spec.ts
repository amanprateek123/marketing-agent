import { PHASE_SCHEMAS } from '../pm-agent.types';
import { PM_SYSTEM_PROMPTS, pmUserMessage } from './phase-prompts';

describe('phase prompts', () => {
  it.each(Object.keys(PHASE_SCHEMAS) as (keyof typeof PHASE_SCHEMAS)[])(
    '%s mentions every top-level schema field',
    (phase) => {
      for (const field of Object.keys(PHASE_SCHEMAS[phase].shape)) expect(PM_SYSTEM_PROMPTS[phase]).toContain(field);
    },
  );

  it('names the key per-phase fields', () => {
    expect(PM_SYSTEM_PROMPTS.investigate).toContain('impactRupeesPerDay');
    expect(PM_SYSTEM_PROMPTS.investigate).toContain('disproofTried');
    expect(PM_SYSTEM_PROMPTS.verify).toContain('blindList');
    expect(PM_SYSTEM_PROMPTS.plan).toContain('stopCondition');
    expect(PM_SYSTEM_PROMPTS.plan_verify).toContain('actionVerdicts');
    for (const p of ['investigate', 'plan'] as const) expect(PM_SYSTEM_PROMPTS[p]).toContain('lessonIds');
    for (const p of ['verify', 'plan_verify'] as const) expect(PM_SYSTEM_PROMPTS[p]).toContain('misapplied lesson');
  });

  it('lists history first for investigate and the lessons file right after brief/journal', () => {
    const msg = pmUserMessage('investigate', {
      campaignId: '1', campaignName: 'C', date: '2026-01-02', round: 1, dir: '/r', dayDir: '/d',
      previousFiles: [], historyFile: '/r/history.md', lessonsFile: '/r/lessons.investigate.md',
    });
    expect(msg).toContain('1. /r/history.md\n2. /r/00-brief.md\n3. /r/00-journal.md\n4. /r/lessons.investigate.md');
  });

  it('revision message points at the latest verifier file and asks for every issue id', () => {
    const msg = pmUserMessage('investigate', {
      campaignId: '1',
      campaignName: 'C',
      date: '2026-01-02',
      round: 3,
      dir: '/r',
      dayDir: '/d',
      previousFiles: ['/r/01-investigate.v1.md', '/r/02-verify.v2.md', '/r/02-verify.v1.md', '/r/01-investigate.v2.md'],
    });
    expect(msg).toContain('latest verifier file: /r/02-verify.v2.md');
    expect(msg).toContain('EVERY issue id');
    expect(msg).toContain('reject_with_evidence');
  });

  it('verify message reads the investigation only after the blind list', () => {
    const msg = pmUserMessage('verify', {
      campaignId: '1', campaignName: 'C', date: '2026-01-02', round: 1, dir: '/r', dayDir: '/d',
      previousFiles: ['/r/01-investigate.v1.md'], lessonsFile: '/r/lessons.verify.md',
    });
    expect(msg.indexOf('blindList')).toBeLessThan(msg.indexOf('01-investigate.v1.md'));
    expect(msg.indexOf('blindList')).toBeLessThan(msg.indexOf('lessons.verify.md'));
  });
});
