import { nearestVideoRatio, parseProbeDimensions } from './video-probe';

describe('video probe', () => {
  it.each([
    [1080, 1920, '9:16'],
    [1080, 1350, '4:5'],
    [1080, 1080, '1:1'],
    [1920, 1080, '16:9'],
    [720, 960, '4:5'], // 3:4 → closest is 4:5
    [1000, 500, '16:9'], // 2:1 → closest is 16:9
    [1080, 2340, '9:16'], // tall phone screen
  ])('%ix%i → %s', (w, h, ratio) =>
    expect(nearestVideoRatio(w, h)).toBe(ratio),
  );

  it('reads width/height', () =>
    expect(
      parseProbeDimensions('{"streams":[{"width":1080,"height":1920}]}'),
    ).toEqual({ width: 1080, height: 1920 }));

  it.each([
    [
      'side data',
      '{"streams":[{"width":1920,"height":1080,"side_data_list":[{"rotation":-90}]}]}',
    ],
    [
      'rotate tag',
      '{"streams":[{"width":1920,"height":1080,"tags":{"rotate":"90"}}]}',
    ],
  ])('swaps dimensions for a rotated phone video (%s)', (_label, json) =>
    expect(parseProbeDimensions(json)).toEqual({ width: 1080, height: 1920 }),
  );

  it('returns undefined when there is no video stream', () =>
    expect(parseProbeDimensions('{"streams":[]}')).toBeUndefined());
});
