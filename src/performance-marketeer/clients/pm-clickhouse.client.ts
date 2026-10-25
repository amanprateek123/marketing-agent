import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ClickHouseClient, createClient } from '@clickhouse/client';
import { pmEnv, PmEnv } from '../pm.config';

/** insights_reader's max_result_rows. */
export const CLICKHOUSE_ROW_CAP = 10_000;

/**
 * Read-only access to OpenPanel's ClickHouse as `insights_reader`. That user
 * is SELECT-only on openpanel.events/sessions/profiles with readonly=1,
 * max_threads=2, 1 GB memory, 20 s and 10k result rows enforced server-side,
 * so callers must keep queries small (one product-day, bounded device lists).
 */
@Injectable()
export class PmClickhouseClient implements OnModuleDestroy {
  private readonly logger = new Logger(PmClickhouseClient.name);
  private readonly client: ClickHouseClient | null;
  readonly project: string;

  constructor(@Inject(pmEnv.KEY) env: PmEnv) {
    this.project = env.clickhouse.project;
    this.client = env.clickhouse.url
      ? createClient({
          url: env.clickhouse.url,
          username: env.clickhouse.username,
          password: env.clickhouse.password,
          request_timeout: 60_000,
          application: 'marketing-agent-performance-marketeer',
        })
      : null;
  }

  get configured() {
    return this.client !== null;
  }

  async query<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
    if (!this.client)
      throw new Error('ClickHouse is not configured (CLICKHOUSE_URL)');
    const started = Date.now();
    const result = await this.client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    });
    const rows = await result.json<T>();
    // insights_reader caps results at 10k rows; a full result may be cut off,
    // and storing it would silently lose data. Callers must narrow the query.
    if (rows.length >= CLICKHOUSE_ROW_CAP)
      throw new Error(
        `ClickHouse returned ${rows.length} rows (cap ${CLICKHOUSE_ROW_CAP}); narrow the query`,
      );
    this.logger.debug(
      `ClickHouse ${rows.length} rows in ${Date.now() - started} ms`,
    );
    return rows;
  }

  async onModuleDestroy() {
    await this.client?.close();
  }
}
