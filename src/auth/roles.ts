import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

/**
 * Two logins, two roles.
 *
 * - `workspace` — the shared AUTH_EMAIL/AUTH_PASSWORD login. Everything except the Brain.
 * - `brain` — the separate BRAIN_AUTH_USERNAME/BRAIN_AUTH_PASSWORD login. The only principal that
 *   can see or act on the Brain (every `/api/v1/brain/*` route).
 *
 * A token minted before roles existed carries no `role` claim; it is read as `workspace`, so no
 * existing session gains Brain access by accident.
 */
export type AuthRole = 'workspace' | 'brain';

/** What JwtAuthGuard attaches to `req.user` on every authenticated request. */
export interface AuthUser {
  sub: string;
  role: AuthRole;
}

export type AuthedRequest = Request & { user?: AuthUser };

export const ROLES_KEY = 'roles';

/** Restrict a route (or a whole controller) to principals holding one of these roles. */
export const Roles = (...roles: AuthRole[]) => SetMetadata(ROLES_KEY, roles);

/** The principal a Brain decision is recorded under: `dash:brain:<username>`. */
export function brainPrincipal(user: AuthUser): string {
  return `dash:brain:${user.sub}`;
}

/**
 * Global (APP_GUARD, registered after JwtAuthGuard so `req.user` is already set). A no-op on any
 * route without `@Roles(...)`.
 *
 * For `@Roles('brain')`:
 * - BRAIN_AUTH_* unset → 503. The Brain is closed, never open, when its login is not configured;
 *   this also voids every brain token already issued the moment the credential is removed.
 * - role is not `brain` → 403.
 * - the token's `sub` is not the CURRENT brain username → 403, so rotating the username retires
 *   every token issued under the old one without waiting for expiry.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AuthRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    if (required.includes('brain')) {
      const username = this.config.get<string>('auth.brainUsername') ?? '';
      const password = this.config.get<string>('auth.brainPassword') ?? '';
      if (!username || !password) {
        this.logger.error(
          'BRAIN_AUTH_USERNAME / BRAIN_AUTH_PASSWORD not configured — Brain routes are closed',
        );
        throw new ServiceUnavailableException('Brain login not configured');
      }
    }

    const user = context.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('This login cannot access the Brain');
    }
    if (
      user.role === 'brain' &&
      user.sub !== (this.config.get<string>('auth.brainUsername') ?? '')
    ) {
      throw new ForbiddenException('This Brain session is no longer valid');
    }
    return true;
  }
}
