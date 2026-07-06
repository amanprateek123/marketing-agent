import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import {
  CreativePackage,
  CreativePackageDocument,
} from '../../creative/schemas/creative-package.schema';
import { CompanyDocument } from '../../companies/schemas/company.schema';
import { Product } from '../../companies/schemas/company.types';
import { CreativeBrief } from '../../pipeline/schemas/creative-brief.schema';
import { CampaignsService } from '../campaigns.service';
import { SafetyChecks } from './safety-checks';
import {
  CreateManualCampaignDto,
  ManualAdSetInput,
} from './manual-campaign.types';

/**
 * ManualCampaignService — the human-driven counterpart to CampaignCreatorService.
 *
 * Where CampaignCreatorService.create() always defers to the AI Campaign
 * Review Team to decide targeting, this path takes a fully human-specified
 * campaignConfig and writes it directly. It deliberately does NOT touch
 * CampaignCreatorService.launch() or MetaAdsService — it only produces a
 * pending_approval Campaign doc in the exact shape launch() already knows
 * how to read (confirmed against campaign-creator.service.ts + meta-ads.service.ts),
 * so the existing /approve endpoint (unchanged) does the actual Meta launch.
 *
 * Two things launch() relies on that create() normally provides, and that
 * this service must do itself since it bypasses create() entirely:
 *  1. Safety checks (budget caps, forbidden topics) — launch() runs none of
 *     these; they only exist in create(). Skipping them here would let a
 *     human-entered budget silently exceed weeklyBudgetCap/maxBudgetPerCampaign.
 *  2. A CreativePackage row — launch() looks one up by creativePackageId and
 *     uploads its image/video URLs to Meta itself. There is no path to launch
 *     a campaign without one, so this always creates a minimal package
 *     (runId/briefId = 'manual') from the copy/images/video the form submits.
 *
 * campaignConfig intentionally omits briefId on the Campaign doc — launch()
 * skips its deterministic audience-targeting-resolver defaulting whenever
 * creativeBrief is null (campaign-creator.service.ts, "manual campaigns,
 * missing briefId... skip the resolver entirely"), so whatever targeting is
 * set here ships as-is rather than being silently overwritten.
 */
@Injectable()
export class ManualCampaignService {
  private readonly logger = new Logger(ManualCampaignService.name);

  constructor(
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
    private readonly campaignsService: CampaignsService,
  ) {}

  async create(
    tenantId: string,
    company: CompanyDocument,
    dto: CreateManualCampaignDto,
  ): Promise<CampaignDocument> {
    this.validate(dto);

    // Safety rails — launch() (called from /approve) runs none of these;
    // they only exist in CampaignCreatorService.create(), which this path
    // bypasses entirely. Must run them here or a human could enter a budget
    // that later automated checks would have blocked.
    SafetyChecks.checkCampaignBudget(dto.budget, company);
    await SafetyChecks.checkWeeklyBudget(
      tenantId,
      dto.budget,
      company,
      this.campaignsService,
    );
    SafetyChecks.checkForbiddenTopics(
      {
        topic: dto.name,
        hook: dto.creative.copyVariants[0]?.primaryText ?? '',
        keyMessage: dto.creative.copyVariants.map((v) => v.headline).join(' '),
      } as unknown as CreativeBrief,
      company,
    );

    const product = this.resolveProduct(company, dto.productName);
    const adSets = this.buildAdSetConfigs(dto);

    const creativePackage = await this.creativePackageModel.create({
      tenantId,
      runId: 'manual',
      briefId: 'manual',
      status: 'completed',
      copyVariants: dto.creative.copyVariants,
      selectedCopyIndex: 0,
      images: dto.creative.images ?? [],
      video: dto.creative.video ?? null,
      carouselCards: [],
      completedAt: new Date(),
    });

    const objective = dto.objective?.trim() || 'OUTCOME_SALES';
    const campaignConfig = {
      budget: dto.budget,
      objective,
      conversionEvent: product?.conversionEvent || 'Purchase',
      conversionValue: product?.conversionValue || 0,
      adSets,
      scaleRules: '',
      pauseRules: '',
    };

    const campaign = await this.campaignModel.create({
      tenantId,
      name: dto.name.trim(),
      runId: '',
      briefId: '',
      source: 'human',
      status: 'pending_approval',
      budget: dto.budget,
      objective,
      creativePackageId: String(creativePackage._id),
      campaignConfig,
    });

    this.logger.log(
      `[${tenantId}] manual campaign created: ${campaign._id} — "${dto.name}" (${dto.campaignType}, ${adSets.length} ad set(s), ₹${dto.budget}/day)`,
    );
    return campaign;
  }

  private validate(dto: CreateManualCampaignDto): void {
    if (!dto.name?.trim()) throw new Error('Campaign name is required');
    if (!dto.budget || dto.budget <= 0)
      throw new Error('Daily budget must be greater than 0');
    if (!dto.adSets || dto.adSets.length === 0)
      throw new Error('At least one ad set is required');
    if (!dto.creative?.copyVariants?.length) {
      throw new Error(
        'At least one copy variant (primary text + headline) is required',
      );
    }
    const hasImage = (dto.creative.images?.length ?? 0) > 0;
    const hasVideo = !!dto.creative.video;
    if (!hasImage && !hasVideo) {
      throw new Error(
        'At least one image or a video is required to launch ads',
      );
    }
    const variantCount = dto.creative.copyVariants.length;
    for (const img of dto.creative.images ?? []) {
      if (img.variantIndex < 0 || img.variantIndex >= variantCount) {
        throw new Error(
          `Image references copy variant ${img.variantIndex}, but only ${variantCount} exist`,
        );
      }
    }
    if (dto.creative.video) {
      const v = dto.creative.video;
      if (v.variantIndex < 0 || v.variantIndex >= variantCount) {
        throw new Error(
          `Video references copy variant ${v.variantIndex}, but only ${variantCount} exist`,
        );
      }
    }
  }

  private resolveProduct(
    company: CompanyDocument,
    productName?: string,
  ): Product | undefined {
    const products = ((company as any).products ?? []) as Product[];
    if (productName) {
      const match = products.find((p) => p.name === productName);
      if (match) return match;
    }
    return products.find((p) => p.active !== false) ?? products[0];
  }

  private buildAdSetConfigs(dto: CreateManualCampaignDto) {
    const adIndices = dto.creative.copyVariants.map((_, i) => i);
    const defaultFormat = dto.creative.video ? 'video' : 'image';

    if (dto.campaignType === 'advantage_plus') {
      const first = dto.adSets[0];
      if (!first)
        throw new Error(
          'Advantage+ campaigns need one ad set (Meta handles targeting automatically)',
        );
      return [
        {
          name: first.name?.trim() || `${dto.name.trim()} — Advantage+`,
          budgetPercent: 100,
          audienceType: 'advantage_plus',
          optimizationGoal: first.optimizationGoal || 'OFFSITE_CONVERSIONS',
          ads: adIndices,
          creativeFormat: first.creativeFormat || defaultFormat,
          // No age/gender/geo/interests: Meta requires Advantage+ ad sets to
          // stay unconstrained (meta-ads.service.ts skips these entirely for
          // audienceType='advantage_plus').
        },
      ];
    }

    // Custom: 1..N ad sets, each independently targeted.
    const totalPct = dto.adSets.reduce((s, a) => s + (a.budgetPercent || 0), 0);
    if (dto.adSets.length > 1 && Math.abs(totalPct - 100) > 1) {
      throw new Error(
        `Ad set budget percentages must sum to 100 (currently ${totalPct})`,
      );
    }

    return dto.adSets.map((a, i) =>
      this.buildOneAdSet(a, i, dto.adSets.length, adIndices, defaultFormat),
    );
  }

  private buildOneAdSet(
    a: ManualAdSetInput,
    index: number,
    totalAdSets: number,
    adIndices: number[],
    defaultFormat: 'image' | 'video',
  ) {
    const label = a.name?.trim() || `Ad set ${index + 1}`;
    if (!a.name?.trim())
      throw new Error(`Ad set ${index + 1}: name is required`);

    if (
      ['lookalike', 'retarget', 'custom'].includes(a.audienceType) &&
      !a.metaAudienceId
    ) {
      throw new Error(
        `"${label}": ${a.audienceType} targeting requires selecting a Meta audience`,
      );
    }
    if (a.audienceType === 'interest' && !a.interests?.length) {
      throw new Error(
        `"${label}": interest targeting requires at least one interest`,
      );
    }
    if (a.audienceType === 'advantage_plus') {
      throw new Error(
        `"${label}": use the Advantage+ campaign type for Advantage+ ad sets, not a custom ad set`,
      );
    }

    return {
      name: label,
      budgetPercent: totalAdSets === 1 ? 100 : a.budgetPercent,
      audienceType: a.audienceType,
      metaAudienceId: a.metaAudienceId || undefined,
      excludeAudienceIds: a.excludeAudienceIds?.length
        ? a.excludeAudienceIds
        : undefined,
      ageMin: a.ageMin,
      ageMax: a.ageMax,
      gender: a.gender && a.gender !== 'all' ? a.gender : undefined,
      geoLocations: a.geoLocations?.length ? a.geoLocations : undefined,
      interests: a.interests?.length ? a.interests.map((x) => x.id) : undefined,
      optimizationGoal: a.optimizationGoal || 'OFFSITE_CONVERSIONS',
      ads: adIndices,
      creativeFormat: a.creativeFormat || defaultFormat,
    };
  }
}
