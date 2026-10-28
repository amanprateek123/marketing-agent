/**
 * Step 3 campaign pipeline from the command line (docs/performance-marketeer/09),
 * without the HTTP server or crons.
 *
 *   npx ts-node -r tsconfig-paths/register src/performance-marketeer/agent/pipeline/pm-agent.cli.ts <prep|queue|run|all|lessons-daily|curate> <date> [campaignId,…] [--limit N] [--dry]
 *   … pm-agent.cli.ts bootstrap <from> <to>
 *
 * prep           day files only (account, festivals, competitors)
 * queue          print the queue
 * run            the given campaigns (or the queue); `all` = lessons-daily + lock + prep + queue + run + roll-up
 * lessons-daily  records for the day (decisions, grading) then lesson scores (code only)
 * curate         weekly lesson curator for the ISO week of <date> (LLM)
 * bootstrap      grade past Meta changes between <from> and <to> into records
 * --dry          prep + brief + journal + lessons files only, no LLM calls (`all --dry` skips lessons-daily)
 *
 * The dashboard's queue (POST …/agent/queue, worked by PmAgentQueueService when
 * PM_AGENT_WORKER=true) is the normal way to start runs; there is no cron.
 * `run`/`all` stay inline for ops, but each campaign is claimed with the same
 * atomic status transition as the worker, so a campaign/date the worker is
 * running is skipped here (and vice versa). The queue worker never starts
 * from the CLI.
 */
// Load .env before anything reads process.env at import time (PM_MODELS).
import 'dotenv/config';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import configuration from '../../../config/configuration';
import { PerformanceMarketeerModule } from '../../performance-marketeer.module';
import { dayRange } from '../../pm.logic';
import { PmLessonsService } from '../lessons/lessons.service';
import { PmRecordsService } from '../lessons/records.service';
import { PmPipelineService } from './pm-pipeline.service';

// The CLI never runs the queue worker, whatever .env says.
process.env.PM_AGENT_WORKER = 'false';

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
class PmAgentCliModule {}

const USAGE =
  'usage: pm-agent.cli.ts <prep|queue|run|all|lessons-daily|curate> <date YYYY-MM-DD> [campaignId,…] [--limit N] [--dry]\n' +
  '       pm-agent.cli.ts bootstrap <from YYYY-MM-DD> <to YYYY-MM-DD>';
const COMMANDS = [
  'prep',
  'queue',
  'run',
  'all',
  'lessons-daily',
  'curate',
  'bootstrap',
];

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? Number(args[li + 1]) : undefined;
  const pos = args.filter(
    (a, i) => !a.startsWith('--') && (li < 0 || i !== li + 1),
  );
  const [cmd, date, ids] = pos;
  if (!COMMANDS.includes(cmd) || !date) throw new Error(USAGE);
  if (cmd === 'bootstrap') {
    if (!ids) throw new Error(USAGE);
    dayRange(date, ids);
  } else dayRange(date, date);
  if (limit !== undefined && !(limit > 0))
    throw new Error('--limit needs a positive number');
  const campaignIds = ids
    ? ids
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const app = await NestFactory.createApplicationContext(PmAgentCliModule, {
    logger: ['log', 'warn', 'error'],
  });
  const p = app.get(PmPipelineService);
  const records = app.get(PmRecordsService);
  const lessons = app.get(PmLessonsService);
  const lessonsDaily = async () => {
    print(await records.daily(date));
    print(await lessons.scoreDaily(date));
  };
  const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  try {
    switch (cmd) {
      case 'prep':
        console.log(await p.prepareDay(date));
        break;
      case 'queue':
        print(await p.queue(date, { campaignIds, limit }));
        break;
      case 'run': {
        // Named campaigns run even below the queue's spend floor.
        const list =
          campaignIds ??
          (await p.queue(date, { limit })).map((q) => q.campaignId);
        if (dry) await p.prepareDay(date);
        for (const id of list) print(await p.runCampaign(date, id, { dry }));
        if (!dry) console.log(await p.writeRollup(date));
        break;
      }
      case 'all':
        // Fresh lesson scores before today's briefs/lessons files are built.
        if (dry) console.log('--dry: skipping lessons-daily (writes records)');
        else await lessonsDaily();
        print(await p.runAll(date, { campaignIds, limit, dry }));
        break;
      case 'lessons-daily':
        await lessonsDaily();
        break;
      case 'curate':
        print(await lessons.curate(date));
        break;
      case 'bootstrap':
        print(await records.bootstrap(date, ids));
        break;
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  new Logger('pm-agent-cli').error((e as Error).message);
  process.exit(1);
});
