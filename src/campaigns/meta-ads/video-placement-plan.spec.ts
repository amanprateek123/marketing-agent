import { planVideoPlacements } from './video-placement-plan';

const v = (videoId: string, aspectRatio?: string) => ({ videoId, aspectRatio });

describe('planVideoPlacements', () => {
  it('returns undefined when no video was uploaded', () => {
    expect(planVideoPlacements([])).toBeUndefined();
    expect(planVideoPlacements([{ videoId: '' }])).toBeUndefined();
  });

  it('uses native sizes when all four exist', () => {
    const plan = planVideoPlacements([
      v('sq', '1:1'),
      v('p', '4:5'),
      v('vt', '9:16'),
      v('w', '16:9'),
    ])!;
    expect(plan.vertical.videoId).toBe('vt');
    expect(plan.feed.videoId).toBe('p');
    expect(plan.notes).toEqual([]);
  });

  it.each([
    [[v('vt', '9:16')], 'vt', 'vt', ['Feeds ← 9:16 (no 4:5/1:1 video)']],
    [[v('p', '4:5')], 'p', 'p', ['Stories/Reels ← 4:5 (no 9:16 video)']],
    [
      [v('w', '16:9')],
      'w',
      'w',
      [
        'Stories/Reels ← 16:9 (no 9:16 video)',
        'Feeds ← 16:9 (no 4:5/1:1 video)',
      ],
    ],
    [[v('vt', '9:16'), v('sq', '1:1')], 'vt', 'sq', []],
    [
      [v('w', '16:9'), v('sq', '1:1')],
      'sq',
      'sq',
      ['Stories/Reels ← 1:1 (no 9:16 video)'],
    ],
  ])(
    'picks the closest available size: %j',
    (videos, vertical, feed, notes) => {
      const plan = planVideoPlacements(videos)!;
      expect([plan.vertical.videoId, plan.feed.videoId]).toEqual([
        vertical,
        feed,
      ]);
      expect(plan.distinct).toHaveLength(vertical === feed ? 1 : 2);
      expect(plan.notes).toEqual(notes);
    },
  );

  it('serves every placement with the first video when no size is known', () => {
    const plan = planVideoPlacements([v('a'), v('b')])!;
    expect(plan.distinct.map((x) => x.videoId)).toEqual(['a']);
    expect(plan.notes[0]).toContain('size unknown');
  });

  it('prefers tagged videos over untagged ones', () => {
    const plan = planVideoPlacements([v('untagged'), v('vt', '9:16')])!;
    expect(plan.vertical.videoId).toBe('vt');
  });

  it('ignores duplicate uploads of the same video', () => {
    const plan = planVideoPlacements([v('same', '9:16'), v('same', '4:5')])!;
    expect(plan.distinct).toHaveLength(1);
  });
});
