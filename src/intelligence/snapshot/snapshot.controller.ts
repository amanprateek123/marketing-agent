import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SnapshotEngine } from './snapshot-engine.service';
import {
  IntelligenceSnapshot,
  IntelligenceSnapshotDocument,
} from './snapshot.schema';
import { ProductForRevenue } from './snapshot.types';

@Controller('intelligence')
export class SnapshotController {
  constructor(
    private readonly engine: SnapshotEngine,
    @InjectModel(IntelligenceSnapshot.name)
    private readonly snapshotModel: Model<IntelligenceSnapshotDocument>,
  ) {}

  /** GET /api/v1/intelligence/:tenantId/snapshots/:campaignId?limit=50 */
  @Get(':tenantId/snapshots/:campaignId')
  async list(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Query('limit') limit?: string,
  ): Promise<IntelligenceSnapshot[]> {
    const n = limit ? parseInt(limit, 10) : 30;
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      throw new BadRequestException('limit must be 1..500');
    }
    return this.engine.getHistory(tenantId, campaignId, n);
  }

  /** GET /api/v1/intelligence/:tenantId/snapshot/:snapshotId */
  @Get(':tenantId/snapshot/:snapshotId')
  async one(
    @Param('tenantId') tenantId: string,
    @Param('snapshotId') snapshotId: string,
  ): Promise<IntelligenceSnapshot> {
    const doc = await this.snapshotModel.findOne({ tenantId, snapshotId }).lean().exec();
    if (!doc) throw new NotFoundException('snapshot not found');
    return doc;
  }

  /**
   * POST /api/v1/intelligence/:tenantId/snapshot
   * Body: { campaignId, metaCampaignId, products }
   * Fires the engine on demand and returns the snapshotId + confidence.
   */
  @Post(':tenantId/snapshot')
  async captureOnDemand(
    @Param('tenantId') tenantId: string,
    @Body()
    body: {
      campaignId: string;
      metaCampaignId: string;
      products?: ProductForRevenue[];
    },
  ): Promise<{ snapshotId: string; confidence: number }> {
    if (!body?.campaignId || !body?.metaCampaignId) {
      throw new BadRequestException('campaignId + metaCampaignId required');
    }
    return this.engine.capture({
      tenantId,
      campaignId: body.campaignId,
      metaCampaignId: body.metaCampaignId,
      products: body.products ?? [],
    });
  }
}
