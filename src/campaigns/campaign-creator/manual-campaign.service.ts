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
  UpdateManualCampaignConfigDto,
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
 *     a campaign without one. Two ways to get one: paste image/video URLs
 *     directly (creates a minimal one-off package, runId/briefId='manual'),
 *     or pass an existing creativePackageId from the creative library
 *     (src/creative — CreativeProducerService.produce()) instead. launch()
 *     doesn't care which source it came from, only that it's status='completed'.
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

    // ── Resolve the creative source: an existing library package, or a
    // fresh one-off built from pasted URLs. Everything downstream (ad set
    // config, forbidden-topics check, the campaign doc itself) reads off
    // whichever `creativePackage` this resolves to — it doesn't care which
    // source it came from. ──────────────────────────────────────────────
    let creativePackage: CreativePackageDocument;
    if (dto.creativePackageId) {
      const existing = await this.creativePackageModel
        .findOne({ _id: dto.creativePackageId, tenantId })
        .exec();
      if (!existing) {
        throw new Error(`Creative package ${dto.creativePackageId} not found`);
      }
      if (existing.status !== 'completed') {
        throw new Error(
          `Creative package ${dto.creativePackageId} is not ready yet (status: ${existing.status})`,
        );
      }
      creativePackage = existing;
    } else {
      creativePackage = await this.creativePackageModel.create({
        tenantId,
        runId: 'manual',
        briefId: 'manual',
        status: 'completed',
        copyVariants: dto.creative!.copyVariants,
        selectedCopyIndex: 0,
        images: dto.creative!.images ?? [],
        video: dto.creative!.videos?.length ? null : (dto.creative!.video ?? null),
        videos: dto.creative!.videos ?? [],
        carouselCards: [],
        completedAt: new Date(),
      });
    }

    SafetyChecks.checkForbiddenTopics(
      {
        topic: dto.name,
        hook: creativePackage.copyVariants[0]?.primaryText ?? '',
        keyMessage: creativePackage.copyVariants.map((v) => v.headline).join(' '),
      } as unknown as CreativeBrief,
      company,
    );

    const product = this.resolveProduct(
      company,
      dto.productName || (creativePackage as unknown as { productName?: string }).productName,
    );
    const adSets = this.buildAdSetConfigs(dto, creativePackage, company);

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

    const accountId = dto.accountId || company.meta?.accountId;
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
      // Pre-launch intent, not yet confirmed — /approve still requires an
      // explicit accountId and will overwrite this with whatever was
      // actually launched to. Set here only so the Approve screen can
      // default to the SAME account the audiences above were picked for.
      metaAccountId: accountId
        ? accountId.startsWith('act_') ? accountId : `act_${accountId}`
        : '',
    });

    this.logger.log(
      `[${tenantId}] manual campaign created: ${campaign._id} — "${dto.name}" (${dto.campaignType}, ${adSets.length} ad set(s), ₹${dto.budget}/day)`,
    );
    return campaign;
  }

  /**
   * Edit a still-pending campaign's structure/targeting/budget in place,
   * instead of the delete+recreate cycle that was the only option before
   * (name/objective, budget, ad sets — including targeting, audiences,
   * locales and per-ad-set creative split — all go through here; creative
   * content itself is edited separately via
   * PATCH /creative/:tenantId/packages/:creativePackageId).
   *
   * Reuses buildAdSetConfigs() so an edit gets the exact same union-coverage
   * and purchaser-exclusion validation as a fresh create() — no separate,
   * potentially-drifting validation path for edits vs. creation.
   */
  async update(
    tenantId: string,
    campaignId: string,
    company: CompanyDocument,
    dto: UpdateManualCampaignConfigDto,
  ): Promise<CampaignDocument> {
    const campaign = await this.campaignModel
      .findOne({ tenantId, _id: campaignId })
      .exec();
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
    if (campaign.status !== 'pending_approval' || campaign.metaCampaignId) {
      throw new Error(
        'Only pending campaigns that have not launched to Meta yet can be edited — this one already has (or no longer has) a pending_approval status.',
      );
    }
    if (
      !dto.name &&
      dto.budget === undefined &&
      !dto.objective &&
      !dto.campaignType &&
      !dto.adSets
    ) {
      throw new Error('No changes provided');
    }

    const existingConfig = campaign.campaignConfig;
    if (!existingConfig) {
      throw new Error(`Campaign ${campaignId} has no campaignConfig to edit`);
    }
    const creativePackage = await this.creativePackageModel
      .findOne({ _id: campaign.creativePackageId, tenantId })
      .exec();
    if (!creativePackage) {
      throw new Error(
        `Creative package ${campaign.creativePackageId} for this campaign no longer exists`,
      );
    }

    const wasAdvantagePlus =
      existingConfig.adSets.length === 1 &&
      existingConfig.adSets[0].audienceType === 'advantage_plus';

    const name = dto.name?.trim() || campaign.name;
    const budget = dto.budget !== undefined ? dto.budget : campaign.budget;
    const objective = dto.objective?.trim() || campaign.objective;
    const campaignType: CreateManualCampaignDto['campaignType'] =
      dto.campaignType || (wasAdvantagePlus ? 'advantage_plus' : 'custom');
    const accountId = dto.accountId || campaign.metaAccountId;

    // Reconstruct the ManualAdSetInput shape from the stored campaignConfig
    // when the caller isn't replacing ad sets this edit (e.g. a budget-only
    // change) — interests are stored as bare IDs on campaignConfig but
    // ManualAdSetInput wants {id, name}; buildOneAdSet only reads `.id`, so
    // the name copy here is a placeholder, not shown anywhere.
    const adSets: ManualAdSetInput[] =
      dto.adSets ??
      existingConfig.adSets.map((a) => ({
        name: a.name,
        budgetPercent: a.budgetPercent,
        audienceType: a.audienceType as ManualAdSetInput['audienceType'],
        metaAudienceId: a.metaAudienceId,
        excludeAudienceIds: a.excludeAudienceIds,
        ageMin: a.ageMin,
        ageMax: a.ageMax,
        gender: a.gender as ManualAdSetInput['gender'],
        geoLocations: a.geoLocations,
        locales: (a as { locales?: number[] }).locales,
        interests: (a.interests ?? []).map((id) => ({ id, name: id })),
        optimizationGoal: a.optimizationGoal,
        creativeFormat: a.creativeFormat as ManualAdSetInput['creativeFormat'],
        ads: a.ads,
      }));

    if (!name) throw new Error('Campaign name is required');
    if (!budget || budget <= 0)
      throw new Error('Daily budget must be greater than 0');
    if (!adSets.length) throw new Error('At least one ad set is required');

    // Same safety rails as create() — a pending campaign contributes zero
    // actual Meta spend, so re-running these against the edited budget can't
    // double-count against getWeeklySpend() (which only sums live spend).
    SafetyChecks.checkCampaignBudget(budget, company);
    await SafetyChecks.checkWeeklyBudget(
      tenantId,
      budget,
      company,
      this.campaignsService,
    );
    SafetyChecks.checkForbiddenTopics(
      {
        topic: name,
        hook: creativePackage.copyVariants[0]?.primaryText ?? '',
        keyMessage: creativePackage.copyVariants.map((v) => v.headline).join(' '),
      } as unknown as CreativeBrief,
      company,
    );

    const rebuiltAdSets = this.buildAdSetConfigs(
      { name, campaignType, adSets } as CreateManualCampaignDto,
      creativePackage,
      company,
    );

    // conversionEvent/conversionValue are intentionally carried over
    // unchanged from existingConfig, not re-resolved from company.products —
    // this DTO has no productName field, so re-resolving here would silently
    // fall back to the tenant's default active product and could overwrite
    // the value picked for a DIFFERENT product at create() time. Product
    // reassignment isn't part of this edit surface.
    campaign.name = name;
    campaign.budget = budget;
    campaign.objective = objective;
    campaign.campaignConfig = {
      budget,
      objective,
      conversionEvent: existingConfig.conversionEvent || 'Purchase',
      conversionValue: existingConfig.conversionValue || 0,
      adSets: rebuiltAdSets,
      scaleRules: existingConfig.scaleRules || '',
      pauseRules: existingConfig.pauseRules || '',
    };
    if (accountId) {
      campaign.metaAccountId = accountId.startsWith('act_')
        ? accountId
        : `act_${accountId}`;
    }

    await campaign.save();
    this.logger.log(
      `[${tenantId}] manual campaign updated: ${campaign._id} — "${name}" (${rebuiltAdSets.length} ad set(s), ₹${budget}/day)`,
    );
    return campaign;
  }

  private validate(dto: CreateManualCampaignDto): void {
    if (!dto.name?.trim()) throw new Error('Campaign name is required');
    if (!dto.budget || dto.budget <= 0)
      throw new Error('Daily budget must be greater than 0');
    if (!dto.adSets || dto.adSets.length === 0)
      throw new Error('At least one ad set is required');

    if (dto.creativePackageId) {
      if (dto.creative) {
        throw new Error('Provide either creative or creativePackageId, not both');
      }
      // The package itself (exists? belongs to this tenant? completed?) is
      // validated once it's actually fetched in create() — can't check that
      // from the DTO alone.
      return;
    }

    if (!dto.creative) {
      throw new Error(
        'Either creative (pasted URLs) or creativePackageId (from the creative library) is required',
      );
    }
    if (!dto.creative.copyVariants?.length) {
      throw new Error(
        'At least one copy variant (primary text + headline) is required',
      );
    }
    const hasImage = (dto.creative.images?.length ?? 0) > 0;
    const hasVideo = !!dto.creative.video || (dto.creative.videos?.length ?? 0) > 0;
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
    for (const v of dto.creative.videos?.length ? dto.creative.videos : dto.creative.video ? [dto.creative.video] : []) {
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

  private buildAdSetConfigs(
    dto: CreateManualCampaignDto,
    creativePackage: CreativePackageDocument,
    company: CompanyDocument,
  ) {
    // Sourced from the resolved package, not dto.creative directly — this
    // is identical whether the package was just built from pasted URLs or
    // fetched pre-existing from the creative library.
    const adIndices = creativePackage.copyVariants.map((_, i) => i);
    const hasVideo = !!creativePackage.video || ((creativePackage as any).videos?.length ?? 0) > 0;
    const defaultFormat = hasVideo ? 'video' : 'image';

    let adSets: any[];

    if (dto.campaignType === 'advantage_plus') {
      const first = dto.adSets[0];
      if (!first)
        throw new Error(
          'Advantage+ campaigns need one ad set (Meta handles targeting automatically)',
        );
      adSets = [
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
    } else {
      // Custom: 1..N ad sets, each independently targeted.
      const totalPct = dto.adSets.reduce((s, a) => s + (a.budgetPercent || 0), 0);
      if (dto.adSets.length > 1 && Math.abs(totalPct - 100) > 1) {
        throw new Error(
          `Ad set budget percentages must sum to 100 (currently ${totalPct})`,
        );
      }

      adSets = dto.adSets.map((a, i) =>
        this.buildOneAdSet(a, i, dto.adSets.length, adIndices, defaultFormat),
      );
    }

    // Auto-exclude past purchasers from prospecting ad sets. The AI review
    // team path (campaign-creator.service.ts) has done this for a while;
    // manual campaigns never got it, so a human building a prospecting ad
    // set here would silently spend part of the budget re-showing ads to
    // people who already bought (industry baseline 5-15% wasted spend).
    // Skipped for retargeting/custom ad sets, which DO want existing audiences.
    const purchasersAudId = (company.products ?? [])
      .flatMap((p: any) => p.metaAudiences ?? [])
      .find((a: any) => /Purchasers?_/i.test(a?.name ?? ''))?.id;
    if (purchasersAudId) {
      const PROSPECTING_TYPES = new Set(['advantage_plus', 'lookalike', 'broad', 'interest']);
      for (const adSet of adSets as any[]) {
        if (!PROSPECTING_TYPES.has(adSet.audienceType)) continue;
        const existing = new Set(adSet.excludeAudienceIds ?? []);
        existing.add(purchasersAudId);
        adSet.excludeAudienceIds = Array.from(existing);
      }
    }

    // Deliberate per-ad-set creative split — validate nothing gets silently
    // dropped campaign-wide. An ad set that didn't specify `ads` already
    // defaults to every variant (buildOneAdSet below), so this only ever
    // fires when someone actually narrowed one ad set's selection without
    // covering the rest elsewhere.
    const union = new Set<number>();
    for (const as of adSets) for (const v of as.ads) union.add(v);
    const missing = adIndices.filter((v) => !union.has(v));
    if (missing.length > 0) {
      const labels = missing.map(
        (v) => creativePackage.copyVariants[v]?.headline || `Variant ${v + 1}`,
      );
      throw new Error(
        `Creative variant(s) not assigned to any ad set: ${labels.join(', ')}. Every variant must appear in at least one ad set or it never gets shown — add it to an ad set's selection, or leave a variant selection empty to include everything by default.`,
      );
    }

    return adSets;
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

    // Explicit per-ad-set creative selection — lets a human distribute
    // specific variants to specific ad sets instead of every ad set
    // carrying the full pool. Omit (or leave empty) to default to all
    // variants, unchanged from prior behavior. Coverage across all ad
    // sets is validated by the caller (buildAdSetConfigs).
    let ads = adIndices;
    if (a.ads?.length) {
      const inRange = a.ads.filter((v) => adIndices.includes(v));
      if (inRange.length === 0) {
        throw new Error(
          `"${label}": selected creative variant(s) [${a.ads.join(',')}] are out of range (this package has ${adIndices.length} variant(s))`,
        );
      }
      ads = inRange;
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
      locales: a.locales?.length ? a.locales : undefined,
      interests: a.interests?.length ? a.interests.map((x) => x.id) : undefined,
      optimizationGoal: a.optimizationGoal || 'OFFSITE_CONVERSIONS',
      ads,
      creativeFormat: a.creativeFormat || defaultFormat,
    };
  }
}
