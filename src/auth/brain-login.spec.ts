import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { FoundryBridgeController } from '../foundry-bridge/foundry-bridge.controller';
import { FoundryBridgeService } from '../foundry-bridge/foundry-bridge.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles';

const SECRET = 'test-secret';

async function makeApp(env: Record<string, unknown>) {
  const values: Record<string, unknown> = {
    'auth.email': 'ops@example.com',
    'auth.password': 'shared-pw',
    'auth.tokenTtlSeconds': 600,
    ...env,
  };
  const bridge = {
    getState: jest.fn().mockResolvedValue({ ok: true }),
    decideGate: jest.fn().mockResolvedValue({ ok: true }),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      JwtModule.register({ global: true, secret: SECRET }),
      ThrottlerModule.forRoot({
        throttlers: [{ name: 'default', limit: 100, ttl: 60_000 }],
      }),
    ],
    controllers: [AuthController, FoundryBridgeController],
    providers: [
      AuthService,
      { provide: ConfigService, useValue: { get: (k: string) => values[k] } },
      { provide: FoundryBridgeService, useValue: bridge },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return { app, bridge, jwt: moduleRef.get(JwtService) };
}

const BRAIN_ENV = {
  'auth.brainUsername': 'brain-owner',
  'auth.brainPassword': 'brain-pw',
};

describe('Brain login (role-gated /brain routes)', () => {
  let app: INestApplication;
  afterEach(async () => app?.close());

  it('workspace login issues role workspace and gets 403 on a brain route', async () => {
    const ctx = await makeApp(BRAIN_ENV);
    app = ctx.app;
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ops@example.com', password: 'shared-pw' })
      .expect(200);
    expect(login.body.role).toBe('workspace');
    await request(app.getHttpServer())
      .get('/brain/t1/state')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(403);
    expect(ctx.bridge.getState).not.toHaveBeenCalled();
  });

  it('brain login issues role brain and is allowed; gate decision carries the principal', async () => {
    const ctx = await makeApp(BRAIN_ENV);
    app = ctx.app;
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'brain-owner', password: 'brain-pw' })
      .expect(200);
    expect(login.body.role).toBe('brain');
    const auth = `Bearer ${login.body.accessToken}`;
    await request(app.getHttpServer())
      .get('/brain/t1/state')
      .set('Authorization', auth)
      .expect(200);
    await request(app.getHttpServer())
      .post('/brain/t1/gates/approval:7/decision')
      .set('Authorization', auth)
      .send({ action: 'approve' })
      .expect(201);
    expect(ctx.bridge.decideGate).toHaveBeenCalledWith(
      'approval:7',
      expect.objectContaining({ action: 'approve' }),
      { principal: 'dash:brain:brain-owner', displayName: 'brain-owner' },
    );
  });

  it('a token without a role claim is workspace (403 on brain routes)', async () => {
    const ctx = await makeApp(BRAIN_ENV);
    app = ctx.app;
    const legacy = await ctx.jwt.signAsync({ sub: 'ops@example.com' });
    await request(app.getHttpServer())
      .get('/brain/t1/state')
      .set('Authorization', `Bearer ${legacy}`)
      .expect(403);
  });

  it('a brain token for a username no longer configured is refused', async () => {
    const ctx = await makeApp(BRAIN_ENV);
    app = ctx.app;
    const stale = await ctx.jwt.signAsync({ sub: 'old-owner', role: 'brain' });
    await request(app.getHttpServer())
      .get('/brain/t1/state')
      .set('Authorization', `Bearer ${stale}`)
      .expect(403);
  });

  it('BRAIN_AUTH_* unset → brain routes 503, brain login refused, workspace login still works', async () => {
    const ctx = await makeApp({});
    app = ctx.app;
    const brainToken = await ctx.jwt.signAsync({
      sub: 'brain-owner',
      role: 'brain',
    });
    const res = await request(app.getHttpServer())
      .get('/brain/t1/state')
      .set('Authorization', `Bearer ${brainToken}`)
      .expect(503);
    expect(res.body.message).toBe('Brain login not configured');
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'brain-owner', password: 'brain-pw' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ops@example.com', password: 'shared-pw' })
      .expect(200);
  });

  it('unauthenticated brain route is still 401', async () => {
    const ctx = await makeApp(BRAIN_ENV);
    app = ctx.app;
    await request(app.getHttpServer()).get('/brain/t1/state').expect(401);
  });

  it('wrong password on either pair is 401', async () => {
    const ctx = await makeApp(BRAIN_ENV);
    app = ctx.app;
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'brain-owner', password: 'shared-pw' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ops@example.com', password: 'brain-pw' })
      .expect(401);
  });
});
