import { verifierIssues } from './records.service';

describe('verifierIssues', () => {
  it('reads issue lines from verify .md files, JSON when copied', () => {
    const md = [
      '---',
      'phase: "verify"',
      '---',
      'text',
      '## Items',
      '### Issues',
      '- I1 · major · on C2 — CTR fell before the edit. Checked: x Required: y [ev-3]',
      '- I2 · minor — General point. Checked: a Required: b',
      '',
      '### Confirmed right',
      '- I9 · major — not an issue',
    ].join('\n');
    const json = JSON.stringify({ issues: [{ id: 'I1', severity: 'blocker', target: 'A1', claim: 'budget step > 20%' }] });
    const out = verifierIssues({
      '02-verify.v1.md': md,
      '04-plan-verify.v1.md': 'ignored, JSON wins',
      '04-plan-verify.v1.md.json': json,
      '01-investigate.v1.md': md,
    });
    expect(out).toEqual([
      { file: '02-verify.v1.md', id: 'I1', severity: 'major', target: 'C2', claim: 'CTR fell before the edit. Checked: x Required: y [ev-3]' },
      { file: '02-verify.v1.md', id: 'I2', severity: 'minor', target: '', claim: 'General point. Checked: a Required: b' },
      { file: '04-plan-verify.v1.md.json', id: 'I1', severity: 'blocker', target: 'A1', claim: 'budget step > 20%' },
    ]);
  });
});
