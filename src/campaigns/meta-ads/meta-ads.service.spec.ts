import axios from 'axios';
import { MetaAdsService, MetaAdSetConfig } from './meta-ads.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * Covers the application_id (App Promotion/Engagement) branch added
 * alongside the pixel-based promoted_object logic — same class of "silently
 * ships the wrong promoted_object" risk that hit production on 2026-07-16
 * and 2026-08-07 for the pixel/custom-conversion paths (see the comments in
 * createAdSet). Exercises the private createAdSet method directly since it's
 * where the actual Meta payload is assembled; MetaAdsService has no
 * constructor dependencies so it's instantiated bare.
 */
describe('MetaAdsService — createAdSet promoted_object', () => {
  let service: MetaAdsService;

  const baseConfig: MetaAdSetConfig = {
    name: 'Test Ad Set',
    budgetPercent: 100,
    audienceType: 'broad',
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    ads: [0],
  };

  beforeEach(() => {
    service = new MetaAdsService();
    jest.clearAllMocks();
    mockedAxios.post.mockResolvedValue({ data: { id: 'mock_adset_id' } });
  });

  async function callCreateAdSet(args: {
    conversionEvent: string;
    pixelId?: string;
    customEventName?: string;
    customConversionId?: string;
    applicationId?: string;
    objectStoreUrl?: string;
    objectStoreUrlIos?: string;
    objectStoreUrlAndroid?: string;
    config?: Partial<MetaAdSetConfig>;
  }) {
    await (service as any).createAdSet(
      'act_123',
      'token',
      'campaign_1',
      { ...baseConfig, ...args.config },
      1000,
      args.conversionEvent,
      args.pixelId,
      args.customEventName,
      args.customConversionId,
      args.applicationId,
      args.objectStoreUrl,
      args.objectStoreUrlIos,
      args.objectStoreUrlAndroid,
    );
    const [, payload] = mockedAxios.post.mock.calls[mockedAxios.post.mock.calls.length - 1];
    return payload as any;
  }

  it('targets application_id (not pixel_id) for an app custom event, and omits destination_type', async () => {
    const payload = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
    });

    expect(payload.promoted_object).toEqual({
      application_id: '935762695083961',
      custom_event_type: 'OTHER',
      custom_event_str: 'chat_success',
    });
    expect(payload.destination_type).toBeUndefined();
  });

  it('includes object_store_url only when supplied', async () => {
    const withUrl = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
      objectStoreUrl: 'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app',
    });
    expect(withUrl.promoted_object.object_store_url).toBe(
      'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app',
    );

    const withoutUrl = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
    });
    expect(withoutUrl.promoted_object.object_store_url).toBeUndefined();
  });

  it('omits custom_event_str for a standard Meta app event (custom_event_type !== OTHER)', async () => {
    const payload = await callCreateAdSet({
      conversionEvent: 'Purchase',
      applicationId: '935762695083961',
    });

    expect(payload.promoted_object).toEqual({
      application_id: '935762695083961',
      custom_event_type: 'PURCHASE',
    });
  });

  it('leaves the existing website-pixel branch unchanged when applicationId is unset', async () => {
    const payload = await callCreateAdSet({
      conversionEvent: 'Purchase',
      pixelId: 'pixel_1',
    });

    expect(payload.promoted_object).toEqual({
      pixel_id: 'pixel_1',
      custom_event_type: 'PURCHASE',
    });
    expect(payload.destination_type).toBe('WEBSITE');
  });

  it('prefers applicationId over customConversionId when both are somehow set', async () => {
    const payload = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
      customConversionId: '28675378708729288',
    });

    expect(payload.promoted_object.application_id).toBe('935762695083961');
    expect(payload.promoted_object.custom_conversion_id).toBeUndefined();
  });

  it('builds promoted_object for the APP_INSTALLS optimization goal (not just OFFSITE_CONVERSIONS)', async () => {
    const payload = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
      objectStoreUrl: 'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app',
      config: { optimizationGoal: 'APP_INSTALLS' },
    });

    expect(payload.promoted_object).toEqual({
      application_id: '935762695083961',
      custom_event_type: 'OTHER',
      object_store_url: 'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app',
      custom_event_str: 'chat_success',
    });
  });

  it('sends click-only attribution_spec (no VIEW_THROUGH) for an app campaign, regardless of optimization goal', async () => {
    // Real Meta rejection hit in production 2026-08-11: an app ad set
    // (application_id set) sent the website-pixel default of 7-day click +
    // 1-day view and got subcode 1885501 "View-through attribution window
    // is invalid" — Meta only accepts (CLICK_THROUGH 1, view 0) or
    // (CLICK_THROUGH 7, view 0) for app campaigns. This must hold even
    // though App Engagement reports optimizationGoal === 'OFFSITE_CONVERSIONS',
    // the exact goal whose website-pixel branch adds VIEW_THROUGH.
    const engagementPayload = await callCreateAdSet({
      conversionEvent: 'Purchase',
      applicationId: '935762695083961',
      config: { optimizationGoal: 'OFFSITE_CONVERSIONS' },
    });
    expect(engagementPayload.attribution_spec).toEqual([
      { event_type: 'CLICK_THROUGH', window_days: 7 },
    ]);

    const installsPayload = await callCreateAdSet({
      conversionEvent: 'Purchase',
      applicationId: '935762695083961',
      objectStoreUrl: 'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app',
      config: { optimizationGoal: 'APP_INSTALLS' },
    });
    expect(installsPayload.attribution_spec).toEqual([
      { event_type: 'CLICK_THROUGH', window_days: 7 },
    ]);
  });

  it('leaves the website-pixel OFFSITE_CONVERSIONS attribution_spec unchanged (7-day click + 1-day view)', async () => {
    const payload = await callCreateAdSet({
      conversionEvent: 'Purchase',
      pixelId: 'pixel_1',
      config: { optimizationGoal: 'OFFSITE_CONVERSIONS' },
    });
    expect(payload.attribution_spec).toEqual([
      { event_type: 'CLICK_THROUGH', window_days: 7 },
      { event_type: 'VIEW_THROUGH', window_days: 1 },
    ]);
  });

  it('sets targeting.user_os when an ad set targets a single platform', async () => {
    const payload = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
      config: { userOs: ['iOS'] },
    });
    expect(payload.targeting.user_os).toEqual(['iOS']);
  });

  it('omits targeting.user_os when unset', async () => {
    const payload = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
    });
    expect(payload.targeting.user_os).toBeUndefined();
  });

  it('picks the iOS store URL for an ad set targeting iOS only', async () => {
    const payload = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
      objectStoreUrl: 'https://default.example/app',
      objectStoreUrlIos: 'https://apps.apple.com/app/91astrology/id123',
      objectStoreUrlAndroid: 'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app',
      config: { userOs: ['iOS'] },
    });
    expect(payload.promoted_object.object_store_url).toBe(
      'https://apps.apple.com/app/91astrology/id123',
    );
  });

  it('picks the Android store URL for an ad set targeting Android only', async () => {
    const payload = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
      objectStoreUrl: 'https://default.example/app',
      objectStoreUrlIos: 'https://apps.apple.com/app/91astrology/id123',
      objectStoreUrlAndroid: 'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app',
      config: { userOs: ['Android'] },
    });
    expect(payload.promoted_object.object_store_url).toBe(
      'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app',
    );
  });

  it('falls back to the campaign-default store URL when userOs is unset or targets both platforms', async () => {
    const unsplit = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
      objectStoreUrl: 'https://default.example/app',
      objectStoreUrlIos: 'https://apps.apple.com/app/91astrology/id123',
      objectStoreUrlAndroid: 'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app',
    });
    expect(unsplit.promoted_object.object_store_url).toBe('https://default.example/app');

    const both = await callCreateAdSet({
      conversionEvent: 'chat_success',
      applicationId: '935762695083961',
      objectStoreUrl: 'https://default.example/app',
      objectStoreUrlIos: 'https://apps.apple.com/app/91astrology/id123',
      objectStoreUrlAndroid: 'https://play.google.com/store/apps/details?id=com.nintyoneastrology.app',
      config: { userOs: ['iOS', 'Android'] },
    });
    expect(both.promoted_object.object_store_url).toBe('https://default.example/app');
  });
});
