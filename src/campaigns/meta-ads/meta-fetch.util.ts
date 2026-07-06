import { Logger } from '@nestjs/common';
import axios from 'axios';

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
    try {
      const res: any = await axios.get(url, { params, timeout: 60000 });
      rows.push(...(res.data?.data ?? []));
      // paging.next is a fully-qualified URL with the cursor embedded.
      url = res.data?.paging?.next ?? null;
      params = undefined;
    } catch (err: any) {
      logger.warn(
        `${label} fetch failed (page ${page}): ${err.response?.data?.error?.message ?? err.message}`,
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
