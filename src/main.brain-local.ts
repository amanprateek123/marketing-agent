import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import configuration from './config/configuration';
import { AuthModule } from './auth/auth.module';
import { FoundryBridgeModule } from './foundry-bridge/foundry-bridge.module';

/**
 * A local harness for the Brain console, and nothing else.
 *
 * The full app imports sixteen modules, most of which register Mongoose schemas or BullMQ queues,
 * so `nest start` needs Mongo and Redis before it will boot. The foundry-bridge needs neither — it
 * owns no collection and no queue; every row it serves lives in the brain's own Postgres, reached
 * over MCP. This boots that one module so the console can be driven against the LIVE brain on a
 * laptop with no database installed.
 *
 * IT DOES CARRY REAL AUTH. AuthModule needs no database — this app has no user table, just
 * AUTH_EMAIL/AUTH_PASSWORD checked against the environment — so importing it costs nothing and
 * keeps local behaviour faithful: `JwtAuthGuard` goes on every route via APP_GUARD exactly as in
 * production, and the login flow is the same one the deployed dashboard uses. Local is worth less
 * as a rehearsal if the thing it skips is the guard.
 *
 * It still refuses to start unless APP_ENV is exactly `development`, and binds loopback only: it
 * serves a partial API (one module of sixteen), so it must never be mistaken for the real one.
 *
 *   APP_ENV=development npx ts-node -r tsconfig-paths/register src/main.brain-local.ts
 *
 * What it proves: the MCP transport, the mappers, and every /brain/* read against real data. What
 * it does not prove: that the module composes with the other fifteen — `nest build` and `tsc`
 * cover that, and only the full stack covers it at run time.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    AuthModule,
    FoundryBridgeModule,
  ],
})
class BrainLocalModule {}

async function bootstrap() {
  const env = process.env.APP_ENV ?? '';
  if (env !== 'development') {
    // Fail loudly rather than helpfully. An unauthenticated bridge that silently starts in a
    // staging shell is worse than one that refuses to start at all.
    console.error(
      `\nREFUSING TO START: main.brain-local.ts is a local harness with NO AUTH GUARD, and ` +
        `APP_ENV is "${env || '(unset)'}" rather than "development".\n` +
        `If you meant to run the real API, use "npm run start:dev" (needs Mongo and Redis).\n`,
    );
    process.exit(1);
  }

  const app = await NestFactory.create(BrainLocalModule, { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('api/v1');
  app.enableCors();
  // Same pipe as main.ts — whitelist:true strips undeclared properties, which is exactly the
  // behaviour the DTOs are written against. Running local without it would let a body through
  // here that production silently drops.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = Number(process.env.APP_PORT ?? 8082);
  // Loopback only. It serves a partial API against live production data; it should not be
  // reachable from the LAN even though the guard is on.
  await app.listen(port, '127.0.0.1');
  console.log(
    `\nBrain console API (LOCAL) → http://127.0.0.1:${port}/api/v1\n` +
      `  sign in as ${process.env.AUTH_EMAIL ?? '(AUTH_EMAIL unset)'}\n`,
  );
}

void bootstrap();
