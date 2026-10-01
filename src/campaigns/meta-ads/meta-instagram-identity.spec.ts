import axios from 'axios';
import { MetaAdsService } from './meta-ads.service';

jest.mock('axios');
const post = axios.post as jest.Mock;
const get = axios.get as jest.Mock;
const remove = axios.delete as jest.Mock;
const missingIdentity = { response: { data: { error: {
  code: 100, error_subcode: 1772103, message: 'Invalid parameter',
  error_user_msg: 'Select an Instagram account',
} } } };

describe('Instagram identity and launch rollback', () => {
  let service: any;
  beforeEach(() => { jest.resetAllMocks(); service = new MetaAdsService(); });
  const data = { access_token: 'token', object_story_spec: { page_id: 'page' },
    asset_feed_spec: { images: [{ hash: 'portrait' }, { hash: 'vertical' }] } };

  it.each(['instagram_business_account', 'connected_instagram_account'])(
    'creates with the Page identity from %s without changing placement assets', async field => {
      post.mockResolvedValueOnce({ data: { id: 'creative' } });
      get.mockResolvedValueOnce({ data: { [field]: { id: 'instagram' } } });
      await service.createAdCreative('act_1', data);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][1]).toEqual({ ...data,
        object_story_spec: { page_id: 'page', instagram_user_id: 'instagram' } });
    });
  it('never requests Page-token-only identity fields', async () => {
    get.mockResolvedValueOnce({ data: { instagram_business_account: { id: 'instagram' } } });
    await service.resolveInstagramIdentity('page', 'token');
    expect(get.mock.calls[0][1].params.fields).toBe('instagram_business_account,connected_instagram_account');
  });
  it('reports missing Page identity without retrying with an arbitrary account', async () => {
    post.mockRejectedValueOnce(missingIdentity);
    get.mockResolvedValueOnce({ data: {} });
    await expect(service.createAdCreative('act_1', data)).rejects.toThrow('Connect the intended Instagram account');
    expect(post).not.toHaveBeenCalled();
  });
  it('does not loop when the resolved identity is rejected', async () => {
    post.mockRejectedValue(missingIdentity);
    get.mockResolvedValueOnce({ data: { instagram_business_account: { id: 'instagram' } } });
    await expect(service.createAdCreative('act_1', data)).rejects.toThrow('Select an Instagram account');
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('attaches identity before ad creation, where Meta may validate it', async () => {
    get.mockResolvedValue({ data: { instagram_business_account: { id: 'instagram' } } });
    post.mockImplementation(async (url, payload) => {
      if (url.endsWith('/adcreatives')) {
        expect(payload.object_story_spec.instagram_user_id).toBe('instagram');
        return { data: { id: 'creative' } };
      }
      expect(url).toMatch(/\/ads$/);
      return { data: { id: 'ad' } };
    });
    await expect(service.createAd('act_1', 'token', 'adset', 'Test',
      { primaryText: 'Body', headline: 'Headline', cta: 'Shop Now' },
      [{ hash: 'vertical', aspectRatio: '9:16' }], 'page', 'https://example.com', true,
    )).resolves.toEqual({ creativeId: 'creative', adId: 'ad' });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('propagates ad-stage identity rejection without retrying or dropping Instagram', async () => {
    get.mockResolvedValue({ data: { instagram_business_account: { id: 'instagram' } } });
    post.mockResolvedValueOnce({ data: { id: 'creative' } }).mockRejectedValueOnce(missingIdentity);
    await expect(service.createAd('act_1', 'token', 'adset', 'Test',
      { primaryText: 'Body', headline: 'Headline', cta: 'Shop Now' },
      [{ hash: 'vertical', aspectRatio: '9:16' }], 'page', 'https://example.com', true,
    )).rejects.toThrow('Select an Instagram account');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1].object_story_spec.instagram_user_id).toBe('instagram');
  });

  it.each([1359207, 3858504])('preserves exclusions on audience error %s', async subcode => {
    post.mockRejectedValueOnce({ response: { data: { error: {
      code: 100, error_subcode: subcode, message: 'Audience unavailable',
    } } } });
    await expect(service.createAdSet('act_1', 'token', 'campaign', {
      name: 'Test', budgetPercent: 100, audienceType: 'advantage_plus',
      optimizationGoal: 'OFFSITE_CONVERSIONS', ads: [0], excludeAudienceIds: ['excluded'],
    }, 100, 'Purchase')).rejects.toThrow('Targeting was not changed');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].targeting.excluded_custom_audiences).toEqual([{ id: 'excluded' }]);
  });

  const audienceError = (subcode: number) => ({ response: { data: { error: {
    code: 100, error_subcode: subcode, message: 'Audience unavailable',
  } } } });
  const adSetConfig = (extra: any) => ({
    name: 'Test', budgetPercent: 100, audienceType: 'advantage_plus',
    optimizationGoal: 'OFFSITE_CONVERSIONS', ads: [0], ...extra,
  });

  it('drops only the auto-added exclusion and retries once (2026-10-01 launch)', async () => {
    post.mockRejectedValueOnce(audienceError(1359207)).mockResolvedValueOnce({ data: { id: 'adset' } });
    await expect(service.createAdSet('act_1', 'token', 'campaign', adSetConfig({
      excludeAudienceIds: ['chosen', 'purchasers'], autoExcludeAudienceIds: ['purchasers'],
    }), 100, 'Purchase')).resolves.toBe('adset');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].targeting.excluded_custom_audiences).toEqual([{ id: 'chosen' }]);
  });

  it('fails when the retry without auto-exclusions is still rejected', async () => {
    post.mockRejectedValue(audienceError(1359207));
    await expect(service.createAdSet('act_1', 'token', 'campaign', adSetConfig({
      metaAudienceId: 'chosen', excludeAudienceIds: ['purchasers'], autoExcludeAudienceIds: ['purchasers'],
    }), 100, 'Purchase')).rejects.toThrow('a chosen audience is unavailable');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].targeting.excluded_custom_audiences).toBeUndefined();
  });

  it('swaps Page with the new Page\'s Instagram identity, not the old one', async () => {
    get.mockResolvedValueOnce({ data: { account_id: '1', creative: { name: 'C', object_story_spec: {
      page_id: 'oldPage', instagram_user_id: 'oldInstagram', link_data: { link: 'https://example.com' },
    } } } }).mockResolvedValueOnce({ data: { instagram_business_account: { id: 'newInstagram' } } });
    post.mockResolvedValue({ data: { id: 'newCreative', success: true } });
    await expect(service.swapAdPage('ad', 'newPage', 'token')).resolves.toEqual({ newCreativeId: 'newCreative' });
    expect(get.mock.calls[1][0]).toMatch(/\/newPage$/);
    expect(post.mock.calls[0][1].object_story_spec).toEqual({
      page_id: 'newPage', instagram_user_id: 'newInstagram', link_data: { link: 'https://example.com' },
    });
  });

  it('fails identity preflight without creating Meta objects', async () => {
    get.mockResolvedValueOnce({ data: {} });
    await expect(service.resolveInstagramIdentity('page', 'token')).rejects.toThrow('Connect the intended Instagram account');
    expect(post).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])('only confirms rollback for success=true (%s)', async success => {
    remove.mockResolvedValue({ data: { success } });
    expect(await service.rollback({ campaignId: 'campaign', creativeIds: [] }, 'token')).toBe(success === true);
  });
  it('leaves an uncertain campaign deletion unconfirmed', async () => {
    remove.mockRejectedValue(new Error('timeout'));
    expect(await service.rollback({ campaignId: 'campaign', creativeIds: [] }, 'token')).toBe(false);
  });
});
