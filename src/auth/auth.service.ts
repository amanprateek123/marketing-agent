import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Single-operator auth: one email/password pair lives in env
 * (AUTH_EMAIL/AUTH_PASSWORD), checked here, JWT issued on match. No user
 * collection — this system has one operator, not a multi-tenant login.
 * Tenant-scoped data access is a separate concern (tenantId in the URL/DTO,
 * unaffected by this).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  async login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const expectedEmail = this.config.get<string>('auth.email') ?? '';
    const expectedPassword = this.config.get<string>('auth.password') ?? '';

    if (!expectedEmail || !expectedPassword) {
      // Misconfiguration, not a client error — surfaced distinctly so it
      // shows up in logs as "fix the deploy," not "user typo'd a password."
      this.logger.error(
        'AUTH_EMAIL / AUTH_PASSWORD not configured — login is impossible until set',
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    // Constant-time compare on both fields — a naive `===` leaks timing
    // information proportional to the matching prefix length, which is a
    // real (if minor) attack surface on a login endpoint reachable from the
    // public internet (this API sits behind an ALB per the deploy config).
    const emailOk = this.safeEqual(email, expectedEmail);
    const passwordOk = this.safeEqual(password, expectedPassword);
    if (!emailOk || !passwordOk) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const expiresIn =
      this.config.get<number>('auth.tokenTtlSeconds') ?? 604_800;
    const accessToken = await this.jwt.signAsync({ sub: email }, { expiresIn });
    return { accessToken, expiresIn };
  }

  private safeEqual(a: string, b: string): boolean {
    // timingSafeEqual throws on length mismatch rather than returning
    // false, and requires equal-length buffers — pad against random bytes
    // of the longer length so a length mismatch doesn't short-circuit
    // (which would itself leak length information) or throw.
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    const len = Math.max(bufA.length, bufB.length, 1);
    const paddedA = Buffer.concat([bufA, randomBytes(len - bufA.length)]);
    const paddedB = Buffer.concat([bufB, randomBytes(len - bufB.length)]);
    const lengthsMatch = bufA.length === bufB.length;
    const bytesMatch = timingSafeEqual(paddedA, paddedB);
    return lengthsMatch && bytesMatch;
  }
}
