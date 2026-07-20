import { Logger } from '@nestjs/common';
import axios from 'axios';

// Meta error codes that mean "you're being rate-limited, back off and
// retry" rather than "this request is wrong": 4=app-level throttling,
// 17=user-level, 32=page-level, 613=custom rate limit, 80004=ad-account
// "too many calls" (the one actually seen in production — see
// campaign-sync/meta-deep-sync failures on 2026-07-20, where every one of
// these came back as an immediate silent give-up with 0 rows because this
// util had no retry at all).
const RATE_LIMIT_CODES = [4, 17, 32, 613, 80004];
const FETCH_MAX_RETRIES = 3;
// Meta's ad-account-level rate limit window is on the order of tens of
// seconds to minutes, not the few-second blips network retries target —
// short delays here would just re-hit the same limit immediately.
const FETCH_RETRY_DELAYS_MS = [3000, 10000, 25000];

function isRetryableMetaError(err: any): boolean {
  const code = err?.response?.data?.error?.code;
  if (typeof code === 'number' && RATE_LIMIT_CODES.includes(code)) return true;
  const hasNoResponse = !err?.response;
  return (
    hasNoResponse &&
    (err?.code === 'ECONNABORTED' ||
      err?.code === 'ETIMEDOUT' ||
      err?.code === 'ECONNRESET' ||
      err?.code === 'ECONNREFUSED' ||
      err?.code === 'ENOTFOUND' ||
      /timeout/i.test(err?.message ?? ''))
  );
}

/**
 * Paginated Meta Graph API fetch — follows paging.next until empty or the
 * page cap. Same contract as CampaignSyncService's private helper (which
 * predates this util); shared here so other Meta readers don't re-implement
 * cursor handling and silently truncate at limit=500 again.
 */
export async function fetchAllPages(
  initialUrl: string,
  initialParams: any,
  label: string,
  logger: Logger,
  maxPages = 40,
): Promise<any[]> {
  const rows: any[] = [];
  let url: string | null = initialUrl;
  let params: any = initialParams;
  for (let page = 0; page < maxPages && url; page++) {
    const pageUrl: string = url;
    const pageParams = params;
    let lastErr: any;
    let succeeded = false;
    for (let attempt = 1; attempt <= FETCH_MAX_RETRIES + 1; attempt++) {
      try {
        const res: any = await axios.get(pageUrl, { params: pageParams, timeout: 60000 });
        rows.push(...(res.data?.data ?? []));
        // paging.next is a fully-qualified URL with the cursor embedded.
        url = res.data?.paging?.next ?? null;
        params = undefined;
        succeeded = true;
        break;
      } catch (err: any) {
        lastErr = err;
        const isLastAttempt = attempt === FETCH_MAX_RETRIES + 1;
        if (isRetryableMetaError(err) && !isLastAttempt) {
          const delay = FETCH_RETRY_DELAYS_MS[attempt - 1] ?? 25000;
          logger.warn(
            `${label} fetch (page ${page}) rate-limited/transient error, retrying in ${delay}ms (attempt ${attempt}/${FETCH_MAX_RETRIES}): ${err.response?.data?.error?.message ?? err.message}`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }
    }
    if (!succeeded) {
      logger.warn(
        `${label} fetch failed (page ${page}): ${lastErr?.response?.data?.error?.message ?? lastErr?.message}`,
      );
      url = null;
    }
  }
  logger.log(`${label}: ${rows.length} rows`);
  return rows;
}

/**
 * Chunked variant for ID-list filters — Meta's filtering param overflows URL
 * length past ~50 IDs, returning empty data with no error.
 */
export async function fetchAllPagesChunked(
  initialUrl: string,
  baseParams: any,
  filterField: string,
  ids: string[],
  label: string,
  logger: Logger,
  chunkSize = 50,
): Promise<any[]> {
  const allRows: any[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const baseFiltering = baseParams.filtering ? JSON.parse(baseParams.filtering) : [];
    const otherFilters = baseFiltering.filter((f: any) => f.field !== filterField);
    const filtering = JSON.stringify([
      ...otherFilters,
      { field: filterField, operator: 'IN', value: chunk },
    ]);
    const rows = await fetchAllPages(
      initialUrl,
      { ...baseParams, filtering },
      `${label} chunk ${i / chunkSize + 1}/${Math.ceil(ids.length / chunkSize)}`,
      logger,
    );
    allRows.push(...rows);
  }
  return allRows;
}
