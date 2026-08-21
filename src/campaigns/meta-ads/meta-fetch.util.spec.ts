import axios from 'axios';
import { fetchAllPages, fetchAllPagesChunked } from './meta-fetch.util';

function logger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
  } as any;
}

describe('Meta fetch completeness', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports a successful paginated read as complete', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: { data: [{ id: 'one' }] },
    } as any);
    const completeness = { complete: false };

    const rows = await fetchAllPages(
      'https://graph.test/items',
      {},
      'items',
      logger(),
      40,
      completeness,
    );

    expect(rows).toEqual([{ id: 'one' }]);
    expect(completeness.complete).toBe(true);
  });

  it('retains partial rows but reports incomplete when a later page fails', async () => {
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({
        data: {
          data: [{ id: 'one' }],
          paging: { next: 'https://graph.test/items?after=cursor' },
        },
      } as any)
      .mockRejectedValueOnce(new Error('invalid response'));
    const completeness = { complete: true };

    const rows = await fetchAllPages(
      'https://graph.test/items',
      {},
      'items',
      logger(),
      40,
      completeness,
    );

    expect(rows).toEqual([{ id: 'one' }]);
    expect(completeness.complete).toBe(false);
  });

  it('reports incomplete when any ID chunk fails', async () => {
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: { data: [{ id: 'one' }] } } as any)
      .mockRejectedValueOnce(new Error('invalid response'));
    const completeness = { complete: true };

    const rows = await fetchAllPagesChunked(
      'https://graph.test/items',
      {},
      'campaign.id',
      ['one', 'two'],
      'items',
      logger(),
      1,
      completeness,
    );

    expect(rows).toEqual([{ id: 'one' }]);
    expect(completeness.complete).toBe(false);
  });

  it('reports incomplete when pagination reaches the safety cap', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        data: [{ id: 'one' }],
        paging: { next: 'https://graph.test/items?after=cursor' },
      },
    } as any);
    const completeness = { complete: true };

    await fetchAllPages(
      'https://graph.test/items',
      {},
      'items',
      logger(),
      1,
      completeness,
    );

    expect(completeness.complete).toBe(false);
  });
});
