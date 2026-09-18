import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route (or whole controller) as exempt from JwtAuthGuard. The
 * guard is applied globally (APP_GUARD in auth.module.ts) — this is the
 * only escape hatch, used on the login route itself.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
