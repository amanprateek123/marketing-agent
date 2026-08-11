import { appEventActionTypes, extractConversions, extractActionValue } from './conversion-extractor.util';

/**
 * Covers the app-events matching gap: campaign-sync.service.ts,
 * meta-deep-sync.service.ts, and meta-metrics.service.ts previously added a
 * product's bare conversionEvent name (e.g. "chat_success") to the
 * conversionTypes Set, but Meta reports app-event actions under prefixed
 * action_types (app_custom_event.other.<event>, mobile_app_install,
 * omni_app_install) — never the bare name. Same failure shape as the
 * missing-customConversionId bug from 2026-06-10 (5 real conversions
 * reported as 0), now for app products instead of custom-conversion
 * products.
 */
describe('appEventActionTypes', () => {
  it('returns install + custom-event action_types for an app product', () => {
    expect(
      appEventActionTypes({ metaAppId: '935762695083961', conversionEvent: 'chat_success' }),
    ).toEqual(['mobile_app_install', 'omni_app_install', 'app_custom_event.other.chat_success']);
  });

  it('prefers customEventName over conversionEvent when both are set', () => {
    const types = appEventActionTypes({
      metaAppId: '935762695083961',
      conversionEvent: 'chat_success',
      customEventName: 'CHAT_SUCCESS_V2',
    });
    expect(types).toContain('app_custom_event.other.CHAT_SUCCESS_V2');
    expect(types).not.toContain('app_custom_event.other.chat_success');
  });

  it('returns nothing for a website (pixel) product — no metaAppId', () => {
    expect(appEventActionTypes({ conversionEvent: 'Purchase' })).toEqual([]);
  });

  it('returns nothing when conversionEvent is unset', () => {
    expect(appEventActionTypes({ metaAppId: '935762695083961' })).toEqual([]);
  });

  it('returns the standard mobile-purchase action_types for conversionEvent=Purchase, not the OTHER shape', () => {
    const types = appEventActionTypes({ metaAppId: '935762695083961', conversionEvent: 'Purchase' });
    expect(types).toEqual(['mobile_app_install', 'omni_app_install', 'mobile_app_purchase', 'omni_purchase']);
    expect(types).not.toContain('app_custom_event.other.Purchase');
  });
});

describe('extractConversions / extractActionValue — app-event actions', () => {
  const conversionTypes = new Set(appEventActionTypes({
    metaAppId: '935762695083961',
    conversionEvent: 'chat_success',
  }));

  it('counts a custom app event reported under Meta\'s prefixed action_type', () => {
    const actions = [{ action_type: 'app_custom_event.other.chat_success', value: '7' }];
    expect(extractConversions(actions, conversionTypes)).toBe(7);
  });

  it('does NOT match the bare event name Meta never actually sends', () => {
    const actions = [{ action_type: 'chat_success', value: '7' }];
    expect(extractConversions(actions, conversionTypes)).toBe(0);
  });

  it('counts a mobile app install', () => {
    const actions = [{ action_type: 'mobile_app_install', value: '3' }];
    expect(extractConversions(actions, conversionTypes)).toBe(3);
  });

  it('sums the matching action_type value for revenue via extractActionValue', () => {
    const actionValues = [{ action_type: 'app_custom_event.other.chat_success', value: '499.5' }];
    expect(extractActionValue(actionValues, conversionTypes)).toBe(499.5);
  });
});

describe('extractActionValue — real wallet-recharge ROAS (conversionEvent=Purchase)', () => {
  const conversionTypes = new Set(appEventActionTypes({
    metaAppId: '935762695083961',
    conversionEvent: 'Purchase',
  }));

  it('extracts recharge value when only mobile_app_purchase is reported', () => {
    const actionValues = [{ action_type: 'mobile_app_purchase', value: '999' }];
    expect(extractActionValue(actionValues, conversionTypes)).toBe(999);
  });

  it('extracts recharge value when only omni_purchase is reported', () => {
    const actionValues = [{ action_type: 'omni_purchase', value: '499' }];
    expect(extractActionValue(actionValues, conversionTypes)).toBe(499);
  });

  it('does NOT double-count when Meta reports the same recharge under both action_types', () => {
    // mobile_app_purchase and omni_purchase are in STANDARD_EVENTS specifically
    // so this pair goes through the priority pick-one path (like the website
    // purchase/offsite_conversion.fb_pixel_purchase pair already does) instead
    // of the generic sum-all-matches path — otherwise a single recharge Meta
    // reports under both labels would double real revenue.
    const actionValues = [
      { action_type: 'mobile_app_purchase', value: '999' },
      { action_type: 'omni_purchase', value: '999' },
    ];
    expect(extractActionValue(actionValues, conversionTypes)).toBe(999);
  });

  it('prefers omni_purchase over mobile_app_purchase when both are present with different values', () => {
    const actionValues = [
      { action_type: 'mobile_app_purchase', value: '999' },
      { action_type: 'omni_purchase', value: '499' },
    ];
    expect(extractActionValue(actionValues, conversionTypes)).toBe(499);
  });
});
