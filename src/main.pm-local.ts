import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import configuration from './config/configuration';
import { AuthModule } from './auth/auth.module';
import { PerformanceMarketeerModule } from './performance-marketeer/performance-marketeer.module';

/**
 * A local harness for the Performance Marketeer dashboard, and nothing else —
 * same idea as main.brain-local.ts.
 *
 * Boots only AuthModule (real JWT guard, same login as production), Mongo and
 * PerformanceMarketeerModule, so the dashboard section can be driven against
 * real synced data on a laptop without starting the other fifteen modules'
 * queues and jobs. ScheduleModule is NOT imported, so no cron (including the
 * Performance Marketeer's own syncs) can fire here.
 *
 * Refuses to start unless APP_ENV is exactly `development`; loopback only.
 *
 *   APP_ENV=development MONGO_URI=mongodb://localhost:27017/autonomous-marketing-agent \
 *     npx ts-node -r tsconfig-paths/register src/main.pm-local.ts
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('mongo.uri'),
      }),
    }),
    AuthModule,
    PerformanceMarketeerModule,
  ],
})
class PmLocalModule {}

async function bootstrap() {
  const env = process.env.APP_ENV ?? '';
  if (env !== 'development') {
    console.error(
      `\nREFUSING TO START: main.pm-local.ts is a partial local harness, and APP_ENV is ` +
        `"${env || '(unset)'}" rather than "development".\n` +
        `For the real API use "npm run start:dev".\n`,
    );
    process.exit(1);
  }
  const app = await NestFactory.create(PmLocalModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.setGlobalPrefix('api/v1');
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.APP_PORT ?? 8082);
  await app.listen(port, '127.0.0.1');
  console.log(
    `\nPerformance Marketeer API (LOCAL) → http://127.0.0.1:${port}/api/v1\n` +
      `  sign in as ${process.env.AUTH_EMAIL ?? '(AUTH_EMAIL unset)'}\n`,
  );
}

void bootstrap();
