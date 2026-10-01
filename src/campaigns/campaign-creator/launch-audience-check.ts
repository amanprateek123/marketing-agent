import axios from 'axios';

/**
 * Pre-launch audience check, one Meta lookup per audience ID.
 *
 * An audience is `valid` when Meta returns it and it is not in an error
 * state. Ownership is deliberately NOT checked: audiences are shared across
 * the tenant's ad accounts, so account_id (the owner) can legitimately differ
 * from the launch account. Meta can still reject an audience at ad set
 * creation (subcode 1359207) — MetaAdsService handles that.
 *
 * IDs whose lookup failed transiently (timeout, rate limit, 5xx) land in
 * `unchecked`, not in the invalid bucket — a network blip must not block a
 * launch for an audience that is actually fine.
 */
export interface LaunchAudienceCheck {
  valid: Set<string>;
  unchecked: Set<string>;
  /** Human-readable reason per ID that was definitively rejected. */
  invalid: Map<string, string>;
}

// Meta throttling / temporary-failure error codes.
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80003, 80004]);

export function isTransientMetaLookupError(err: any): boolean {
  const res = err?.response;
  if (!res) return true; // timeout / connection reset — no answer from Meta
  if (res.status === 429 || res.status >= 500) return true;
  const metaErr = res.data?.error;
  return (
    metaErr?.is_transient === true || TRANSIENT_META_CODES.has(metaErr?.code)
  );
}

export async function checkLaunchAudiences(
  audienceIds: Iterable<string>,
  accessToken: string,
): Promise<LaunchAudienceCheck> {
  const check: LaunchAudienceCheck = {
    valid: new Set(),
    unchecked: new Set(),
    invalid: new Map(),
  };

  await Promise.all(
    [...new Set(audienceIds)].map(async (id) => {
      try {
        const res = await axios.get(`https://graph.facebook.com/v21.0/${id}`, {
          params: {
            fields:
              'id,delivery_status,operation_status,approximate_count_lower_bound',
            access_token: accessToken,
          },
          timeout: 10000,
        });
        const data = res.data ?? {};
        // delivery_status.code 200 = ready; 300 = warning; 400 = error/below-min-size.
        // operation_status.code 200 = no issues; 300 = audience being computed; 400 = error.
        const deliveryCode = data.delivery_status?.code;
        const operationCode = data.operation_status?.code;
        if (data.id !== id) {
          check.invalid.set(id, 'not returned by Meta');
        } else if (deliveryCode >= 400 || operationCode >= 400) {
          check.invalid.set(
            id,
            `delivery_status=${JSON.stringify(data.delivery_status)} operation_status=${JSON.stringify(data.operation_status)}`,
          );
        } else {
          check.valid.add(id);
        }
      } catch (err: any) {
        if (isTransientMetaLookupError(err)) {
          check.unchecked.add(id);
        } else {
          check.invalid.set(
            id,
            err?.response?.data?.error?.message ??
              err?.message ??
              'lookup failed',
          );
        }
      }
    }),
  );

  return check;
}
