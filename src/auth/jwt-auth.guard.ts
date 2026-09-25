import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AuthUser } from './roles';

/**
 * Applied globally (APP_GUARD, see auth.module.ts) — every route under the
 * api/v1 prefix requires a valid `Authorization: Bearer <token>` header
 * unless marked with @Public(). No per-module opt-in; new controllers are
 * protected by default, which is the safer failure mode for an API that
 * sits behind a public ALB and can pause/scale live ad spend.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: { sub?: unknown; role?: unknown };
    try {
      // Signature + expiry verification (verifyAsync throws on either).
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    // Attached for RolesGuard and for anything that records who acted. A
    // token without a role claim predates roles and is the shared
    // workspace login — never `brain`.
    const user: AuthUser = {
      sub: typeof payload.sub === 'string' ? payload.sub : '',
      role: payload.role === 'brain' ? 'brain' : 'workspace',
    };
    (request as Request & { user?: AuthUser }).user = user;
    return true;
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' ? token : undefined;
  }
}
