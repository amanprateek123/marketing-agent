import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PmClickhouseClient } from './clients/pm-clickhouse.client';
import { PmMetabaseClient } from './clients/pm-metabase.client';
import { pmEnv, PmEnv } from './pm.config';
import { PmBusyError, PmSyncService } from './sync/pm-sync.service';

/**
 * Off unless PM_SYNC_ENABLED=true and both data sources are configured.
 * Nightly runs after astro_be's own 02:30 IST insights job, at low traffic.
 */
@Injectable()
export class PmScheduler {
  private readonly logger = new Logger(PmScheduler.name);

  constructor(
    private readonly sync: PmSyncService,
    private readonly clickhouse: PmClickhouseClient,
    private readonly metabase: PmMetabaseClient,
    @Inject(pmEnv.KEY) private readonly env: PmEnv,
  ) {}

  @Cron('0 20 * * * *', { name: 'pm-hourly', timeZone: 'Asia/Kolkata' })
  hourly() {
    return this.run('hourly', () => this.sync.hourly());
  }

  @Cron('0 15 3 * * *', { name: 'pm-nightly', timeZone: 'Asia/Kolkata' })
  nightly() {
    return this.run('nightly', () => this.sync.nightly());
  }

  private async run(name: string, job: () => Promise<void>) {
    if (
      !this.env.syncEnabled ||
      !this.clickhouse.configured ||
      !this.metabase.configured
    )
      return;
    try {
      await job();
    } catch (e) {
      if (e instanceof PmBusyError)
        this.logger.warn(`PM ${name} skipped: ${e.message}`);
      else this.logger.error(`PM ${name} failed: ${(e as Error).message}`);
    }
  }
}
