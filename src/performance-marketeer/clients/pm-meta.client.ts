import { Inject, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { pmEnv, PmEnv } from '../pm.config';

/**
 * Read-only Meta Marketing API client for the Performance Marketeer.
 *
 * The app is on Meta's development access tier, so the call budget is small.
 * Every response's usage headers are read; above USAGE_PAUSE_AT percent we
 * wait before the next call, and rate-limit errors back off and retry.
 * Calls are sequential (never parallel).
 */
const USAGE_PAUSE_AT = 75;
const MAX_RETRIES = 6;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
// Meta error codes meaning "too many calls" (app, user, account, business use case).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80003, 80004, 80014]);
// "Please reduce the amount of data you're asking for" (code 1) — the caller
// splits the range instead of retrying. Code 2 (temporarily unavailable) is a
// plain transient error and is retried like any 5xx.
const TOO_MUCH_DATA_CODES = new Set([1]);
const TOO_MUCH_DATA_RE = /reduce the amount of data/i;

/** One rule for "ask for less", shared by the client (don't retry) and the sync (split). */
export function isTooMuchData(code: number | null, message: string) {
  return (
    (code !== null && TOO_MUCH_DATA_CODES.has(code)) ||
    TOO_MUCH_DATA_RE.test(message)
  );
}

export class PmMetaError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly subcode: number | null,
  ) {
    super(message);
  }
}

interface MetaPage<T> {
  data: T[];
  paging?: { next?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Highest usage percent across Meta's usage headers, and the advised wait. Exported for tests. */
export function usageFrom(headers: Record<string, unknown>): {
  maxPct: number;
  waitMs: number;
} {
  let maxPct = 0;
  let waitMs = 0;
  const parse = (h: unknown) => {
    if (typeof h !== 'string' || !h) return null;
    try {
      return JSON.parse(h);
    } catch {
      return null;
    }
  };
  const visit = (o: Record<string, unknown>) => {
    for (const k of [
      'call_count',
      'total_cputime',
      'total_time',
      'acc_id_util_pct',
    ]) {
      const v = Number(o[k]);
      if (Number.isFinite(v)) maxPct = Math.max(maxPct, v);
    }
    const mins = Number(o.estimated_time_to_regain_access);
    if (Number.isFinite(mins) && mins > 0)
      waitMs = Math.max(waitMs, Math.min(mins * 60_000, MAX_BACKOFF_MS));
  };
  const app = parse(headers['x-app-usage']);
  if (app) visit(app);
  const account = parse(headers['x-ad-account-usage']);
  if (account) visit(account);
  const buc = parse(headers['x-business-use-case-usage']);
  if (buc && typeof buc === 'object') {
    for (const entries of Object.values(buc as Record<string, unknown[]>)) {
      for (const e of entries ?? []) visit(e as Record<string, unknown>);
    }
  }
  return { maxPct, waitMs };
}

@Injectable()
export class PmMetaClient {
  private readonly logger = new Logger(PmMetaClient.name);
  private pauseUntil = 0;
  /** Called before every wait, so a caller holding a lease can extend it. */
  onWait: (() => Promise<void>) | null = null;

  constructor(@Inject(pmEnv.KEY) private readonly env: PmEnv) {}

  get configured() {
    return Boolean(
      this.env.meta.accessToken && this.env.meta.accountIds.length,
    );
  }

  get accountIds() {
    return this.env.meta.accountIds;
  }

  /** GET one object/edge page. */
  get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = `https://graph.facebook.com/${this.env.meta.apiVersion}/${path.replace(/^\//, '')}`;
    return this.request<T>(url, params);
  }

  /** GET an edge and follow `paging.next` to the end. */
  async getAll<T>(
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const rows: T[] = [];
    let page = await this.get<MetaPage<T>>(path, params);
    rows.push(...(page.data ?? []));
    while (page.paging?.next) {
      // `next` already carries every parameter, including the token.
      page = await this.request<MetaPage<T>>(page.paging.next, {});
      rows.push(...(page.data ?? []));
    }
    return rows;
  }

  private async request<T>(
    url: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!this.configured)
      throw new Error('Meta is not configured (META_ACCESS_TOKEN)');
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      query[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    if (!url.includes('access_token='))
      query.access_token = this.env.meta.accessToken;

    for (let attempt = 0; ; attempt++) {
      const wait = this.pauseUntil - Date.now();
      if (wait > 0) {
        await this.onWait?.();
        this.logger.warn(
          `Meta usage high — pausing ${Math.round(wait / 1000)} s`,
        );
        await sleep(wait);
      }
      let res: AxiosResponse<T>;
      try {
        res = await axios.get<T>(url, { params: query, timeout: 120_000 });
      } catch (e) {
        const err = e as AxiosError<{
          error?: { message?: string; code?: number; error_subcode?: number };
        }>;
        const meta = err.response?.data?.error;
        const code = meta?.code ?? null;
        if (err.response)
          this.notePause(err.response.headers as Record<string, unknown>);
        // "Too much data" arrives as HTTP 500 too: never retry it, the caller splits the range.
        const tooMuchData = isTooMuchData(code, meta?.message ?? '');
        const retriable =
          !tooMuchData &&
          ((code !== null && RATE_LIMIT_CODES.has(code)) ||
            !err.response ||
            (err.response.status ?? 0) >= 500);
        if (retriable && attempt < MAX_RETRIES) {
          const backoff = Math.min(
            MAX_BACKOFF_MS,
            BASE_BACKOFF_MS * 2 ** attempt,
          );
          const until = Math.max(this.pauseUntil, Date.now() + backoff);
          this.pauseUntil = until;
          this.logger.warn(
            `Meta ${code ?? err.response?.status ?? err.code}: ${meta?.message ?? err.message} — retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round((until - Date.now()) / 1000)} s`,
          );
          continue;
        }
        // Never echo the URL: it contains the access token.
        throw new PmMetaError(
          `Meta API error${code !== null ? ` ${code}` : ''}: ${meta?.message ?? err.message}`,
          code,
          meta?.error_subcode ?? null,
        );
      }
      this.notePause(res.headers as Record<string, unknown>);
      return res.data;
    }
  }

  private notePause(headers: Record<string, unknown>) {
    const { maxPct, waitMs } = usageFrom(headers);
    if (waitMs > 0 || maxPct >= USAGE_PAUSE_AT) {
      // Above the threshold, slow right down: Meta's own estimate, else a minute per 5% over.
      const pause =
        waitMs || Math.ceil((maxPct - USAGE_PAUSE_AT + 1) / 5) * 60_000;
      this.pauseUntil = Math.max(this.pauseUntil, Date.now() + pause);
    }
  }
}
