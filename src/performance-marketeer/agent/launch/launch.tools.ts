import { z } from 'zod';
import { PmMetaClient } from '../../clients/pm-meta.client';
import { PmToolDef } from '../tools/pm-tool';

/**
 * Read-only Meta lookups for planning a new campaign: real location keys,
 * interest ids and audience ids, so a plan can't invent them. No performance data.
 */
export function launchTools(
  meta: PmMetaClient,
  accountId: string,
): PmToolDef[] {
  const act = `act_${accountId.replace(/^act_/, '')}`;
  return [
    {
      name: 'meta_geo_search',
      description:
        'Find Meta location keys in India. Needed for any region or city in a plan.',
      shape: {
        q: z.string().min(2),
        type: z.enum(['region', 'city']),
      },
      run: async (a: { q: string; type: string }) => ({
        rows: (
          await meta.get<{ data: Record<string, unknown>[] }>('search', {
            type: 'adgeolocation',
            q: a.q,
            location_types: JSON.stringify([a.type]),
            country_code: 'IN',
            limit: 15,
          })
        ).data.map((x) => ({
          key: String(x.key),
          name: x.name,
          type: x.type,
          region: x.region,
        })),
      }),
    },
    {
      name: 'meta_interest_search',
      description:
        'Find Meta interest ids and audience sizes. Needed for any interest in a plan.',
      shape: { q: z.string().min(2) },
      run: async (a: { q: string }) => ({
        rows: (
          await meta.get<{ data: Record<string, unknown>[] }>('search', {
            type: 'adinterest',
            q: a.q,
            limit: 15,
          })
        ).data.map((x) => ({
          id: String(x.id),
          name: x.name,
          sizeLow: x.audience_size_lower_bound,
          sizeHigh: x.audience_size_upper_bound,
        })),
      }),
    },
    {
      name: 'ad_account_audiences',
      description:
        'Custom audiences in this ad account (ids, names, rough sizes), e.g. to exclude existing buyers. No performance data.',
      shape: {},
      run: async () => ({
        rows: (
          await meta.getAll<Record<string, unknown>>(`${act}/customaudiences`, {
            fields: 'id,name,subtype,approximate_count_lower_bound',
            limit: 200,
          })
        ).map((x) => ({
          id: String(x.id),
          name: x.name,
          subtype: x.subtype,
          sizeLow: x.approximate_count_lower_bound,
        })),
      }),
    },
    {
      name: 'audience_size',
      description:
        'Meta\'s estimate of how many people a targeting can reach. `targeting` is Meta\'s targeting_spec as a JSON string, e.g. {"geo_locations":{"countries":["IN"]},"age_min":25,"age_max":45}.',
      shape: { targeting: z.string() },
      run: async (a: { targeting: string }) => {
        JSON.parse(a.targeting);
        const r = await meta.get<{ data: Record<string, unknown>[] }>(
          `${act}/delivery_estimate`,
          {
            optimization_goal: 'OFFSITE_CONVERSIONS',
            targeting_spec: a.targeting,
          },
        );
        return {
          low: r.data[0]?.estimate_mau_lower_bound,
          high: r.data[0]?.estimate_mau_upper_bound,
        };
      },
    },
  ];
}
