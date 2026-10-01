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

  it.each(['instagram_business_account', 'connected_instagram_account', 'connected_page_backed_instagram_account'])(
    'retries using the Page identity from %s without changing placement assets', async field => {
      post.mockRejectedValueOnce(missingIdentity).mockResolvedValueOnce({ data: { id: 'creative' } });
      get.mockResolvedValueOnce({ data: { [field]: { id: 'instagram' } } });
      await service.createAdCreative('act_1', data);
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls[1][1]).toEqual({ ...data,
        object_story_spec: { page_id: 'page', instagram_user_id: 'instagram' } });
    });
  it('reports missing Page identity without retrying with an arbitrary account', async () => {
    post.mockRejectedValueOnce(missingIdentity);
    get.mockResolvedValueOnce({ data: {} });
    await expect(service.createAdCreative('act_1', data)).rejects.toThrow('Connect the intended Instagram account');
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('does not loop when the resolved identity is rejected', async () => {
    post.mockRejectedValue(missingIdentity);
    get.mockResolvedValueOnce({ data: { instagram_business_account: { id: 'instagram' } } });
    await expect(service.createAdCreative('act_1', data)).rejects.toThrow('Select an Instagram account');
    expect(post).toHaveBeenCalledTimes(2);
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
