import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthRole } from './roles';

/**
 * Env-credential auth: two pairs live in env (the shared workspace login
 * AUTH_EMAIL/AUTH_PASSWORD and the separate Brain login
 * BRAIN_AUTH_USERNAME/BRAIN_AUTH_PASSWORD), checked here, JWT issued on match
 * carrying the matching role. No user collection.
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

  /**
   * Two env credential pairs, one route:
   * - AUTH_EMAIL / AUTH_PASSWORD → role `workspace` (everything but the Brain)
   * - BRAIN_AUTH_USERNAME / BRAIN_AUTH_PASSWORD → role `brain` (the only
   *   login that can see or act on the Brain)
   * Both pairs are always compared, so response time does not reveal which
   * pair (if any) an identifier belongs to. An unset pair never matches.
   */
  async login(
    identifier: string,
    password: string,
  ): Promise<{ accessToken: string; expiresIn: number; role: AuthRole }> {
    const expectedEmail = this.config.get<string>('auth.email') ?? '';
    const expectedPassword = this.config.get<string>('auth.password') ?? '';
    const brainUsername = this.config.get<string>('auth.brainUsername') ?? '';
    const brainPassword = this.config.get<string>('auth.brainPassword') ?? '';

    const workspaceConfigured = !!expectedEmail && !!expectedPassword;
    const brainConfigured = !!brainUsername && !!brainPassword;
    if (!workspaceConfigured && !brainConfigured) {
      // Misconfiguration, not a client error — surfaced distinctly so it
      // shows up in logs as "fix the deploy," not "user typo'd a password."
      this.logger.error(
        'Neither AUTH_EMAIL/AUTH_PASSWORD nor BRAIN_AUTH_USERNAME/BRAIN_AUTH_PASSWORD is configured — login is impossible until set',
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    // Constant-time compare on every field — a naive `===` leaks timing
    // information proportional to the matching prefix length, which is a
    // real (if minor) attack surface on a login endpoint reachable from the
    // public internet (this API sits behind an ALB per the deploy config).
    // `&` (not `&&`) so no comparison is skipped.
    const workspaceOk =
      workspaceConfigured &&
      !!(
        Number(this.safeEqual(identifier, expectedEmail)) &
        Number(this.safeEqual(password, expectedPassword))
      );
    const brainOk =
      brainConfigured &&
      !!(
        Number(this.safeEqual(identifier, brainUsername)) &
        Number(this.safeEqual(password, brainPassword))
      );

    // The Brain pair wins if both somehow match (the owner configured them
    // identically) — it is the more privileged login, and the deploy is
    // misconfigured anyway, so say so.
    let role: AuthRole;
    if (brainOk) {
      if (workspaceOk) {
        this.logger.warn(
          'BRAIN_AUTH_* equals AUTH_* — the shared login is the Brain login; set a separate pair',
        );
      }
      role = 'brain';
    } else if (workspaceOk) {
      role = 'workspace';
    } else {
      throw new UnauthorizedException('Invalid credentials');
    }

    const expiresIn =
      this.config.get<number>('auth.tokenTtlSeconds') ?? 604_800;
    const accessToken = await this.jwt.signAsync(
      { sub: identifier, role },
      { expiresIn },
    );
    return { accessToken, expiresIn, role };
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
