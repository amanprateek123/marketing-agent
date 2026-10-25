import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { pmEnv, PmEnv } from '../pm.config';

/**
 * Reads 91astro's production Mongo through Metabase's API (native Mongo
 * aggregation), so nothing is created or changed on the production database.
 *
 * The Metabase key can read every collection (native access is per database),
 * so the guard rails live here:
 *  - only allow-listed collections, and no stage that reads another one;
 *  - no stages/operators that write, run JavaScript or reshape whole documents;
 *  - no reference to a personal field anywhere in the pipeline (so it can't be
 *    copied under another name), and no $$ROOT / $$CURRENT;
 *  - the last stage must be an inclusion-only $project.
 */
export const PM_ALLOWED_COLLECTIONS = ['orders', 'transactions'];

const FORBIDDEN_OPERATORS = [
  // write
  '$out',
  '$merge',
  // run JavaScript
  '$function',
  '$accumulator',
  '$where',
  // read other collections
  '$lookup',
  '$unionWith',
  '$graphLookup',
  '$facet',
  '$documents',
  // swap the whole document for a sub-document we can't reason about
  '$replaceRoot',
  '$replaceWith',
];

// Personal or irrelevant-but-sensitive fields that must never leave Mongo.
const PERSONAL_FIELDS = [
  'address',
  'kundliData',
  'clientIp',
  'userAgent',
  'currentLocation',
  'notes',
  'email',
  'phone',
  'name',
  'birthData',
  'dateOfBirth',
  'historyLog',
  'poojaProofMedia',
  'arziWishImageUrl',
  'reportUrl',
  'invoiceLink',
  'paymentInstrument',
  'description',
  'remark',
];

/** Metabase caps ad-hoc API results at 2,000 rows; pages must stay below it. */
export const METABASE_PAGE_SIZE = 1000;
const METABASE_ROW_CAP = 2000;

const walk = (
  v: unknown,
  visit: (key: string | null, value: unknown) => void,
) => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      visit(k, x);
      walk(x, visit);
    }
  } else visit(null, v);
};

/** Throws if a pipeline breaks the rules above. Exported for tests. */
export function assertSafePipeline(
  collection: string,
  pipeline: Record<string, unknown>[],
) {
  if (!PM_ALLOWED_COLLECTIONS.includes(collection))
    throw new Error(`Collection not allowed: ${collection}`);
  const personal = new Set<string>();
  const checkPath = (path: string) => {
    for (const seg of path.replace(/^\$+/, '').split('.')) {
      if (PERSONAL_FIELDS.includes(seg)) personal.add(seg);
    }
  };
  walk(pipeline, (key, value) => {
    if (key && FORBIDDEN_OPERATORS.includes(key))
      throw new Error(`Operator not allowed: ${key}`);
    if (key && !key.startsWith('$')) checkPath(key);
    if (typeof value === 'string' && value.startsWith('$')) {
      if (/^\$\$(ROOT|CURRENT)\b/.test(value))
        throw new Error(`Not allowed: ${value}`);
      if (!value.startsWith('$$')) checkPath(value);
    }
  });
  if (personal.size)
    throw new Error(`Personal fields not allowed: ${[...personal].join(', ')}`);
  const last = pipeline[pipeline.length - 1];
  if (!last || !('$project' in last))
    throw new Error('Pipeline must end with a $project');
  // Inclusion-only: an exclusion projection would return every other field.
  const excluded = Object.entries(last.$project as Record<string, unknown>)
    .filter(([k, v]) => k !== '_id' && (v === 0 || v === false))
    .map(([k]) => k);
  if (
    excluded.length ||
    Object.keys(last.$project as object).every((k) => k === '_id')
  )
    throw new Error('Final $project must list the fields to return');
}

interface DatasetResponse {
  error?: string;
  data?: { cols: { name: string }[]; rows: unknown[][] };
}

@Injectable()
export class PmMetabaseClient {
  private readonly logger = new Logger(PmMetabaseClient.name);

  constructor(@Inject(pmEnv.KEY) private readonly env: PmEnv) {}

  get configured() {
    return Boolean(this.env.metabase.url && this.env.metabase.apiKey);
  }

  async aggregate<T = Record<string, unknown>>(
    collection: string,
    pipeline: Record<string, unknown>[],
  ): Promise<T[]> {
    if (!this.configured)
      throw new Error(
        'Metabase is not configured (METABASE_URL, METABASE_API_KEY)',
      );
    assertSafePipeline(collection, pipeline);
    const started = Date.now();
    const { data } = await axios.post<DatasetResponse>(
      `${this.env.metabase.url.replace(/\/$/, '')}/api/dataset`,
      {
        database: this.env.metabase.databaseId,
        type: 'native',
        native: { collection, query: JSON.stringify(pipeline) },
      },
      { headers: { 'x-api-key': this.env.metabase.apiKey }, timeout: 90_000 },
    );
    if (data.error || !data.data)
      throw new Error(`Metabase query failed: ${data.error ?? 'no data'}`);
    const cols = data.data.cols.map((c) => c.name);
    const rows = data.data.rows.map(
      (r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])) as T,
    );
    // A full page means Metabase may have cut rows off — callers must page smaller.
    if (rows.length >= METABASE_ROW_CAP)
      throw new Error(
        `Metabase returned ${rows.length} rows (cap ${METABASE_ROW_CAP}); page the query`,
      );
    this.logger.debug(
      `Metabase ${collection}: ${rows.length} rows in ${Date.now() - started} ms`,
    );
    return rows;
  }
}
