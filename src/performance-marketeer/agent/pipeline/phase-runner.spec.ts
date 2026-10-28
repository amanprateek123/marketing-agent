import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EvidenceLog, pathAllowed, readEvidence } from './phase-runner';

describe('phase-runner', () => {
  it('limits file tools to this campaign up to the run date and day/<date>', () => {
    const scope = {
      campaignRoot: '/r/campaigns/1',
      date: '2026-10-27',
      dayDir: '/r/day/2026-10-27',
    };
    expect(pathAllowed('/r/campaigns/1/2026-10-27/00-brief.md', scope)).toBe(
      true,
    );
    expect(pathAllowed('/r/campaigns/1/2026-10-20/05-actions.md', scope)).toBe(
      true,
    );
    expect(pathAllowed('/r/campaigns/1', scope)).toBe(true);
    expect(pathAllowed('/r/day/2026-10-27/account.md', scope)).toBe(true);
    expect(pathAllowed('/r/campaigns/1/2026-10-28/05-actions.md', scope)).toBe(
      false,
    );
    expect(pathAllowed('/r/campaigns/2/2026-10-27/00-brief.md', scope)).toBe(
      false,
    );
    expect(pathAllowed('/r/campaigns/1/notes.md', scope)).toBe(false);
    expect(pathAllowed('/r/day/2026-10-26/account.md', scope)).toBe(false);
    expect(pathAllowed('/etc/passwd', scope)).toBe(false);
  });

  it('continues evidence numbering from the existing file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pm-ev-')), 'evidence.jsonl');
    writeFileSync(
      file,
      JSON.stringify({ id: 'ev-7', tool: 'calc' }) + '\n{broken\n',
    );
    const log = new EvidenceLog(file);
    expect(log.record('investigate', 1, 'impact_rupees', {}, 1)).toBe('ev-8');
    expect(new EvidenceLog(file).record('verify', 1, 'calc', {}, 2)).toBe(
      'ev-9',
    );
    expect(readEvidence(file).map((e) => e.id)).toEqual([
      'ev-7',
      'ev-8',
      'ev-9',
    ]);
  });
});
