import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('auth.jwtSecret');
        if (!secret) {
          // Fail loudly at boot rather than silently signing tokens with
          // undefined/empty secret — that would make every issued JWT
          // forgeable with an empty-string HMAC key.
          throw new Error(
            'AUTH_JWT_SECRET is not set — required to issue/verify auth tokens',
          );
        }
        return { secret };
      },
    }),
    // Only used to rate-limit the login route (see AuthController) — not
    // registered as a global guard, so it has zero effect on any other
    // endpoint's request rate.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', limit: 5, ttl: 60_000 }],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Global route guard — every controller in the app requires a valid
    // bearer token unless explicitly @Public(). Registering it here (rather
    // than in AppModule) keeps all auth wiring in one module.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
