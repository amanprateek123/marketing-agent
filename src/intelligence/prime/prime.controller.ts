import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
} from '@nestjs/common';
import { PrimeService } from './prime.service';

/**
 * POST /api/v1/intelligence/:tenantId/prime
 *
 * Manual "Look again now" trigger. Delegates to PrimeService — same code path
 * as the automatic cascade scheduler.
 *
 * Nothing on Meta is mutated. Recommendations land in `intelligence_decisions`
 * with `shadowModeOnly=true` and a 48h review window.
 */
@Controller('intelligence')
export class PrimeController {
  constructor(private readonly prime: PrimeService) {}

  @Post(':tenantId/prime')
  async primeTenant(
    @Param('tenantId') tenantId: string,
    @Body()
    body?: {
      skipSync?: boolean;
      maxCampaigns?: number;
    },
  ) {
    const res = await this.prime.runFor(tenantId, body ?? {});
    if (!res.ok) throw new BadRequestException(res.message);
    return res;
  }
}
