import axios from 'axios';
import { checkLaunchAudiences } from './launch-audience-check';

jest.mock('axios');
const get = axios.get as jest.Mock;

const audience = (id: string, extra: any = {}) => ({
  data: {
    id,
    account_id: '111',
    delivery_status: { code: 200 },
    operation_status: { code: 200 },
    ...extra,
  },
});
const metaError = (status: number, error: any) => ({
  response: { status, data: { error } },
});

describe('checkLaunchAudiences', () => {
  beforeEach(() => jest.resetAllMocks());

  it('accepts a ready audience, including one shared from another ad account', async () => {
    get.mockResolvedValue(audience('shared', { account_id: '222' }));
    const check = await checkLaunchAudiences(['shared'], 'token');
    expect([...check.valid]).toEqual(['shared']);
  });

  it('rejects an audience in an error state', async () => {
    get.mockResolvedValue(audience('a', { delivery_status: { code: 400 } }));
    const check = await checkLaunchAudiences(['a'], 'token');
    expect(check.invalid.has('a')).toBe(true);
  });

  it('rejects an audience Meta says does not exist', async () => {
    get.mockRejectedValue(
      metaError(400, {
        code: 100,
        error_subcode: 33,
        message: 'Object does not exist',
      }),
    );
    const check = await checkLaunchAudiences(['gone'], 'token');
    expect(check.invalid.get('gone')).toBe('Object does not exist');
    expect(check.unchecked.size).toBe(0);
  });

  it.each([
    ['timeout', new Error('timeout of 10000ms exceeded')],
    [
      'rate limit',
      metaError(400, { code: 17, message: 'User request limit reached' }),
    ],
    ['5xx', metaError(503, { message: 'Service unavailable' })],
    [
      'is_transient',
      metaError(400, { code: 100, is_transient: true, message: 'Try again' }),
    ],
  ])('marks a %s as unchecked, not invalid', async (_label, err) => {
    get.mockRejectedValue(err);
    const check = await checkLaunchAudiences(['a'], 'token');
    expect([...check.unchecked]).toEqual(['a']);
    expect(check.invalid.size).toBe(0);
    expect(check.valid.size).toBe(0);
  });
});
