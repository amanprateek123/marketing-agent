import { Controller, Post, Param, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CreativeProducerService, BriefData } from './creative-producer/creative-producer.service';
import { IntelligenceBrief, IntelligenceBriefDocument } from '../pipeline/schemas/intelligence-brief.schema';

@Controller('creative')
export class CreativeController {
  constructor(
    private readonly creativeProducer: CreativeProducerService,
    @InjectModel(IntelligenceBrief.name)
    private readonly intelligenceBriefModel: Model<IntelligenceBriefDocument>,
  ) {}

  /**
   * POST /api/v1/creative/:tenantId/briefs/:briefId/approve
   * Approve any idea (recommended or runner-up) and trigger creative production.
   */
  @Post(':tenantId/briefs/:briefId/approve')
  async approve(
    @Param('tenantId') tenantId: string,
    @Param('briefId') briefId: string,
  ) {
    const brief = await this.intelligenceBriefModel
      .findOne({ tenantId, briefId })
      .lean()
      .exec();

    if (!brief) {
      throw new NotFoundException(`Brief ${briefId} not found for tenant ${tenantId}`);
    }

    const briefData: BriefData = {
      topic: brief.topic,
      angle: brief.angle,
      platform: brief.platform,
      format: brief.format,
      audience: brief.audience,
      hook: (brief as any).hook ?? '',
      keyMessage: (brief as any).keyMessage ?? '',
      conversionBridge: (brief as any).conversionBridge ?? '',
    };

    // Fire and forget — returns immediately, production runs in background
    this.creativeProducer.produce(tenantId, briefId, brief.runId, briefData)
      .catch(() => {});

    return { status: 'started', briefId, topic: brief.topic };
  }
}
