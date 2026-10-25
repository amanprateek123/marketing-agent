/**
 * Run Performance Marketeer syncs from the command line, without starting the
 * HTTP server or any other module's jobs (no ScheduleModule, so no crons).
 *
 *   npx ts-node -r tsconfig-paths/register src/performance-marketeer/cli.ts <job> <from> <to> [product]
 *   node dist/performance-marketeer/cli.js <job> <from> <to> [product]     (in the container)
 *
 * job: all | visitor-days | orders | attribution | runs
 */
import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import configuration from '../config/configuration';
import { PerformanceMarketeerModule } from './performance-marketeer.module';
import { PmSyncRequest, PmSyncService } from './sync/pm-sync.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('mongo.uri'),
      }),
    }),
    PerformanceMarketeerModule,
  ],
})
class PmCliModule {}

async function main() {
  const [job, from, to, product] = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(PmCliModule, {
    logger: ['log', 'warn', 'error'],
  });
  const sync = app.get(PmSyncService);
  const req: PmSyncRequest = { from, to, product, trigger: 'cli' };
  try {
    switch (job) {
      case 'all':
        await sync.all(req);
        break;
      case 'visitor-days':
        await sync.syncVisitorDays(req);
        break;
      case 'orders':
        await sync.syncOrders(req);
        break;
      case 'attribution':
        await sync.syncAttribution(req);
        break;
      case 'runs':
        console.log(JSON.stringify(await sync.recentRuns(), null, 2));
        break;
      default:
        throw new Error(
          'usage: cli.ts <all|visitor-days|orders|attribution|runs> <from YYYY-MM-DD> <to YYYY-MM-DD> [product]',
        );
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  new Logger('pm-cli').error((e as Error).message);
  process.exit(1);
});
