import {
  inferAudienceType,
  inferAudienceTypeFromTargeting,
} from './hook-inference.util';

describe('audience type inference', () => {
  it('retains explicit audience labels from the ad-set name', () => {
    expect(inferAudienceType('India 1% Lookalike')).toBe('lookalike');
    expect(
      inferAudienceTypeFromTargeting('India 1% Lookalike', {
        custom_audiences: [{ id: 'aud-1' }],
      }),
    ).toBe('lookalike');
  });

  it('classifies an opaque Meta ad set with a custom audience as warm/custom', () => {
    expect(inferAudienceType('ATC Audience 30 Days')).toBe('other');
    expect(
      inferAudienceTypeFromTargeting('ATC Audience 30 Days', {
        custom_audiences: [{ id: 'aud-1', name: 'ATC 30D' }],
      }),
    ).toBe('custom');
  });

  it('uses the explicit Advantage audience flag over name heuristics', () => {
    expect(
      inferAudienceTypeFromTargeting('Retargeting pool', {
        custom_audiences: [{ id: 'aud-1' }],
        targeting_automation: { advantage_audience: 1 },
      }),
    ).toBe('advantage_plus');
  });
});
