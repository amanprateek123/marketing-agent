import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import configuration from './config/configuration';
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
 * IT HAS NO AUTH GUARD. The real app puts `JwtAuthGuard` on every route via APP_GUARD in
 * AuthModule; AuthModule is not imported here, because it needs Mongo for the user lookup. That is
 * the whole reason for the environment check below: this file must never be the thing that boots
 * in front of a real ad account. It is not in `package.json`'s scripts, it binds loopback only, and
 * it refuses to start unless APP_ENV is explicitly `development`.
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
  // Loopback only. This process has no authentication; it should not be reachable from the LAN.
  await app.listen(port, '127.0.0.1');
  console.log(`\nBrain console API (LOCAL, no auth) → http://127.0.0.1:${port}/api/v1/brain/:tenantId/state\n`);
}

void bootstrap();
