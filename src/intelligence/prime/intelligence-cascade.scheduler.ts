import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CompaniesService } from '../../companies/companies.service';
import { PrimeService } from './prime.service';

/**
 * IntelligenceCascadeScheduler
 *
 * Runs the 16-engine intelligence cascade automatically for every tenant with
 * a Meta connection. Fires every 30 minutes — matches the pace at which Meta
 * insight data meaningfully changes, without hammering the Graph API.
 *
 * Sync is skipped here because CampaignSyncService already runs every 10 min
 * (see SchedulerService). So the cascade always operates on data that is at
 * most 10 min stale.
 *
 * OVERRIDE: set INTELLIGENCE_CASCADE_CRON to disable ('') or change cadence.
 * Default cron: `* /30 * * * *` — top of every 30-min mark.
 */
@Injectable()
export class IntelligenceCascadeScheduler {
  private readonly log = new Logger(IntelligenceCascadeScheduler.name);
  private running = false;

  constructor(
    private readonly companies: CompaniesService,
    private readonly prime: PrimeService,
  ) {}

  @Cron(process.env.INTELLIGENCE_CASCADE_CRON || '*/30 * * * *')
  async runForAllTenants(): Promise<void> {
    if (this.running) {
      this.log.warn(
        'Previous cascade run still in progress — skipping this tick.',
      );
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const tenants = await this.companies.findAll();
      const eligible = tenants.filter(
        (t) => !!(t as { meta?: { accessToken?: string } }).meta?.accessToken,
      );
      this.log.log(
        `Auto-cascade tick — analyzing ${eligible.length} tenant(s)`,
      );

      for (const t of eligible) {
        try {
          const res = await this.prime.runFor(t.tenantId, {
            skipSync: true,
            maxCampaigns: 10,
          });
          this.log.log(
            `[${t.tenantId}] cascade complete — ${res.campaignsAnalyzed} campaigns, ${res.totalDecisions} decisions proposed`,
          );
        } catch (err) {
          this.log.error(
            `[${t.tenantId}] cascade failed: ${(err as Error).message}`,
          );
        }
      }
      const secs = Math.round((Date.now() - startedAt) / 1000);
      this.log.log(`Auto-cascade tick done in ${secs}s`);
    } finally {
      this.running = false;
    }
  }
}
