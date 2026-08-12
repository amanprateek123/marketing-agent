import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  NotFoundException,
  BadRequestException,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CampaignsService } from './campaigns.service';
import { CampaignCreatorService } from './campaign-creator/campaign-creator.service';
import { ManualCampaignService } from './campaign-creator/manual-campaign.service';
import {
  CreateManualCampaignDto,
  UpdateManualCampaignConfigDto,
} from './campaign-creator/manual-campaign.types';
import { CampaignAuditorService } from './campaign-auditor/campaign-auditor.service';
import { CampaignOptimizerService } from './campaign-auditor/campaign-optimizer.service';
import { CompaniesService } from '../companies/companies.service';
import { MetaAdsService } from './meta-ads/meta-ads.service';
import { CampaignSyncService } from './meta-ads/campaign-sync.service';
import { MetaDeepSyncService } from './meta-ads/meta-deep-sync.service';
import { AudienceOrchestrationService } from './audience-orchestration/audience-orchestration.service';
import { META_LOCALE_IDS } from './campaign-creator/audience-targeting-resolver';
import {
  AuditSnapshot,
  AuditSnapshotDocument,
} from './schemas/audit-snapshot.schema';
import { Campaign, CampaignDocument } from './schemas/campaign.schema';
import {
  MetricTimeseries,
  MetricTimeseriesDocument,
} from './schemas/metric-timeseries.schema';
import {
  BreakdownSnapshot,
  BreakdownSnapshotDocument,
} from './schemas/breakdown-snapshot.schema';
import {
  ShadowAction,
  ShadowActionDocument,
} from '../learning/schemas/shadow-action.schema';
import {
  CreativeBrief,
  CreativeBriefDocument,
} from '../pipeline/schemas/creative-brief.schema';
import {
  CreativePackage,
  CreativePackageDocument,
} from '../creative/schemas/creative-package.schema';
import { SafetyChecks } from './campaign-creator/safety-checks';
import {
  assertProductLaunchable,
  resolveCampaignProduct,
} from './campaign-creator/resolve-campaign-product';
import { CampaignApprovalPreviewService } from './campaign-creator/campaign-approval-preview.service';
import { PlacementPreset, PLACEMENT_PRESET_LABELS } from './meta-ads/placement-presets';
import { VALID_OPTIMIZATION_GOALS } from './meta-ads/optimization-goals';

const VALID_PLACEMENT_PRESETS = new Set<PlacementPreset>(['vertical', 'vertical_feed', 'everywhere']);

@Controller('campaigns')
export class CampaignsController {
  private readonly logger = new Logger(CampaignsController.name);

  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly campaignCreator: CampaignCreatorService,
    private readonly manualCampaignService: ManualCampaignService,
    private readonly approvalPreview: CampaignApprovalPreviewService,
    private readonly campaignAuditorService: CampaignAuditorService,
    private readonly campaignOptimizerService: CampaignOptimizerService,
    private readonly companiesService: CompaniesService,
    private readonly metaAdsService: MetaAdsService,
    private readonly campaignSyncService: CampaignSyncService,
    private readonly metaDeepSyncService: MetaDeepSyncService,
    private readonly audienceOrchestration: AudienceOrchestrationService,
    @InjectModel(AuditSnapshot.name)
    private readonly snapshotModel: Model<AuditSnapshotDocument>,
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    @InjectModel(ShadowAction.name)
    private readonly shadowActionModel: Model<ShadowActionDocument>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBriefDocument>,
    @InjectModel(CreativePackage.name)
    private readonly creativePackageModel: Model<CreativePackageDocument>,
    @InjectModel(MetricTimeseries.name)
    private readonly timeseriesModel: Model<MetricTimeseriesDocument>,
    @InjectModel(BreakdownSnapshot.name)
    private readonly breakdownModel: Model<BreakdownSnapshotDocument>,
  ) {}

  @Get(':tenantId')
  async findAll(@Param('tenantId') tenantId: string) {
    return this.campaignsService.findAll(tenantId);
  }

  /**
   * GET /api/v1/campaigns/:tenantId/meta-audiences?productName=X
   * Lists the tenant's saved Meta custom/lookalike audiences (product.metaAudiences)
   * for the Create Campaign form's audience picker. productName filters to one
   * product; omit to get every product's audiences (tagged with productName).
   *
   * Registered BEFORE :tenantId/:campaignId — Nest/Express match routes in
   * registration order, and "meta-audiences" would otherwise satisfy the
   * :campaignId wildcard and get swallowed by findOne() below (hit 2026-07-06:
   * every call here 500'd with a Mongo ObjectId cast error on the literal
   * string "meta-audiences").
   */
  @Get(':tenantId/meta-audiences')
  async getMetaAudiencesForCreate(
    @Param('tenantId') tenantId: string,
    @Query('productName') productName?: string,
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company) throw new NotFoundException('Tenant not found');
    const products = ((company.products ?? []) as any[]).filter(
      (p) => !productName || p.name === productName,
    );
    return products.flatMap((p) =>
      (p.metaAudiences ?? []).map((a: any) => ({ ...a, productName: p.name })),
    );
  }

  /**
   * GET /api/v1/campaigns/:tenantId/meta-interest-search?q=keyword
   * Proxies Meta's detailed-targeting interest search — powers the Create
   * Campaign form's interest picker. Returns real Meta interest IDs so
   * whatever the user picks passes launch-time validation unchanged.
   *
   * Same route-ordering requirement as meta-audiences above — must precede
   * :tenantId/:campaignId.
   */
  @Get(':tenantId/meta-interest-search')
  async searchMetaInterests(
    @Param('tenantId') tenantId: string,
    @Query('q') q?: string,
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company) throw new NotFoundException('Tenant not found');
    if (!company.meta?.accessToken) {
      throw new BadRequestException(
        'No Meta access token configured for this tenant',
      );
    }
    try {
      return await this.metaAdsService.searchInterests(
        q ?? '',
        company.meta.accessToken,
      );
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * GET /api/v1/campaigns/:tenantId/meta-geo-search?q=maha&type=region&country=IN
   * Proxies Meta's adgeolocation search so the Create Campaign form can target
   * states/cities instead of whole countries. Returns Meta region/city `key`
   * values — the exact thing createAdSet() writes into
   * targeting.geo_locations.regions[].key / .cities[].key.
   *
   * Same route-ordering requirement as meta-audiences/meta-interest-search
   * above — must precede :tenantId/:campaignId.
   */
  @Get(':tenantId/meta-geo-search')
  async searchMetaGeo(
    @Param('tenantId') tenantId: string,
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('country') country?: string,
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company) throw new NotFoundException('Tenant not found');
    if (!company.meta?.accessToken) {
      throw new BadRequestException(
        'No Meta access token configured for this tenant',
      );
    }
    if (type && type !== 'region' && type !== 'city') {
      throw new BadRequestException(`type must be "region" or "city" (got "${type}")`);
    }
    try {
      return await this.metaAdsService.searchGeoLocations(
        q ?? '',
        company.meta.accessToken,
        { type: (type as 'region' | 'city') ?? 'region', countryCode: country },
      );
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * GET /api/v1/campaigns/:tenantId/meta-geo-resolve?regions=1735,1738&cities=777934
   * Reverse of meta-geo-search: turns saved geo keys back into display names
   * so the Create/Edit Campaign form can show "Maharashtra" rather than the
   * stored "1735". Returns a flat { key: name } map, and {} on any lookup
   * failure — the form falls back to rendering raw keys rather than breaking.
   *
   * Same route-ordering requirement as the searches above.
   */
  @Get(':tenantId/meta-geo-resolve')
  async resolveMetaGeo(
    @Param('tenantId') tenantId: string,
    @Query('regions') regions?: string,
    @Query('cities') cities?: string,
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company) throw new NotFoundException('Tenant not found');
    if (!company.meta?.accessToken) {
      throw new BadRequestException(
        'No Meta access token configured for this tenant',
      );
    }
    const split = (v?: string) =>
      (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return this.metaAdsService.resolveGeoLocations(
      { regions: split(regions), cities: split(cities) },
      company.meta.accessToken,
    );
  }

  /**
   * GET /api/v1/campaigns/:tenantId/meta-account-audiences?accountId=act_X
   * Live custom + lookalike audiences for ONE specific ad account — unlike
   * meta-audiences above (which reads the saved, single-account snapshot on
   * product.metaAudiences), this hits Meta directly so the Create Campaign
   * form can show the audiences that actually exist in whichever account
   * the campaign is being built for. Custom Audiences are account-scoped
   * Meta objects; an audience created in one ad account isn't usable in
   * another unless explicitly Business-Manager-shared.
   * Same route-ordering requirement as meta-audiences/meta-interest-search
   * above — must precede :tenantId/:campaignId.
   */
  @Get(':tenantId/meta-account-audiences')
  async getMetaAccountAudiences(
    @Param('tenantId') tenantId: string,
    @Query('accountId') accountId?: string,
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company) throw new NotFoundException('Tenant not found');
    if (!company.meta?.accessToken) {
      throw new BadRequestException('No Meta access token configured for this tenant');
    }
    if (!accountId) {
      throw new BadRequestException('accountId query param is required');
    }
    try {
      return await this.metaAdsService.listCustomAudiences(accountId, company.meta.accessToken);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * GET /api/v1/campaigns/:tenantId/meta-locales
   * Verified Meta locale IDs for language targeting — the Create Campaign
   * form's locale picker reads this instead of hardcoding IDs, so it can
   * never drift from META_LOCALE_IDS the way a copy-pasted comment did
   * (marathi was guessed as 84 instead of 81, hindi as 53 instead of 46 —
   * both silently resolved to unrelated languages until caught before
   * launch). Only VERIFIED entries are exposed; unverified guesses in that
   * table are commented out and intentionally excluded here.
   */
  @Get(':tenantId/meta-locales')
  getMetaLocales() {
    return Object.entries(META_LOCALE_IDS).map(([name, id]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      id,
    }));
  }

  /**
   * GET /api/v1/campaigns/:tenantId/weekly-spend
   * The rolling-7-day spend estimate used to gate new campaign creation
   * (see SafetyChecks.checkWeeklyBudget / CampaignsService.getWeeklySpend) —
   * exposed read-only so the dashboard can show the SAME number that's
   * actually enforced, instead of the frontend reimplementing (and getting
   * wrong) its own version of "weekly budget in use".
   * Same route-ordering requirement as meta-audiences/meta-interest-search
   * above — must precede :tenantId/:campaignId.
   */
  @Get(':tenantId/weekly-spend')
  async getWeeklySpend(@Param('tenantId') tenantId: string) {
    return { weeklySpend: await this.campaignsService.getWeeklySpend(tenantId) };
  }

  @Get(':tenantId/:campaignId')
  async findOne(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/review
   * Everything the Approve & Launch screen should show before the click:
   * the RESOLVED product (and how it was resolved), the exact destination URL
   * per ad set, pixel + conversion tracking, per-ad-set ₹/day and targeting,
   * every copy variant and asset that will ship, the Meta campaign name that
   * will be created, and `blockers` — the things that will make /approve fail.
   *
   * Read-only, and safe to call on a broken campaign: it renders the problem
   * in `blockers` instead of erroring, so the operator can see and fix it.
   */
  @Get(':tenantId/:campaignId/review')
  async reviewBeforeApproval(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.approvalPreview.build(tenantId, campaignId);
  }

  /**
   * POST /api/v1/campaigns/:tenantId/create-manual
   * Manual Create Campaign form — a human specifies budget, targeting (or
   * Advantage+), and creative directly; no AI Campaign Review Team involved.
   * Writes a pending_approval Campaign exactly like the AI path produces, so
   * the existing /approve endpoint launches it to Meta unchanged. Returns the
   * new campaign id — the frontend should navigate to its detail page, where
   * the standard "Awaiting Approval" panel and Approve & Launch flow take over.
   */
  @Post(':tenantId/create-manual')
  async createManual(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateManualCampaignDto,
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company) throw new NotFoundException('Tenant not found');
    if (!company.meta?.accessToken) {
      throw new BadRequestException(
        'No Meta access token configured for this tenant',
      );
    }
    try {
      const campaign = await this.manualCampaignService.create(
        tenantId,
        company,
        dto,
      );
      return {
        success: true,
        campaignId: String(campaign._id),
        status: campaign.status,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * PATCH /api/v1/campaigns/:tenantId/:campaignId/config
   * Edits a still-pending campaign's name/budget/objective/ad sets in place —
   * the alternative to deleting and recreating the whole campaign for a
   * targeting or budget fix. Only works while status is still
   * pending_approval and no metaCampaignId exists yet (see
   * ManualCampaignService.update). Creative content itself (copy text,
   * image/video) is edited via PATCH /creative/:tenantId/packages/:id.
   */
  @Patch(':tenantId/:campaignId/config')
  async updateConfig(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body() dto: UpdateManualCampaignConfigDto,
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company) throw new NotFoundException('Tenant not found');
    try {
      const campaign = await this.manualCampaignService.update(
        tenantId,
        campaignId,
        company,
        dto,
      );
      return {
        success: true,
        campaignId: String(campaign._id),
        campaignConfig: campaign.campaignConfig,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/approve
   * Body: { accountId: "act_123456" } — must be one of company.meta.accountIds
   * Human approves a pending campaign → launches on Meta Ads.
   */
  @Post(':tenantId/:campaignId/approve')
  async approve(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('accountId') accountId: string,
  ) {
    try {
      const company = await this.companiesService.findByTenantId(tenantId);

      // Validate accountId is in the tenant's allowed list
      const allowedIds =
        company.meta?.accountIds ??
        (company.meta?.accountId ? [company.meta.accountId] : []);
      if (!accountId) {
        throw new Error(
          `accountId is required. Available accounts: ${allowedIds.join(', ')}`,
        );
      }
      if (!accountId.startsWith('act_')) {
        throw new Error(
          `accountId must start with "act_" (e.g. act_549390260260950). Got: "${accountId}"`,
        );
      }
      // Tolerate legacy/mixed-format entries in company.meta.accountIds
      // (some were stored "act_"-prefixed before the sync endpoint normalized
      // on write) by comparing bare IDs on both sides instead of trusting
      // the stored format.
      const stripPrefix = (id: string) => (id.startsWith('act_') ? id.slice(4) : id);
      const normalizedAllowed = new Set(allowedIds.map(stripPrefix));
      if (!normalizedAllowed.has(stripPrefix(accountId))) {
        throw new Error(
          `accountId "${accountId}" is not in your Meta account list. Available: ${allowedIds.join(', ')}`,
        );
      }

      const campaign = await this.campaignCreator.launch(
        campaignId,
        company,
        accountId,
      );
      return {
        success: true,
        metaCampaignId: campaign.metaCampaignId,
        status: campaign.status,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/patch-audience
   * Body: { customAudienceId: "120242..." }   — must exist in product.metaAudiences
   *        OR { audienceName: "91Astrology_Visitors_30d" } — resolved by name
   *
   * Use case: agent campaigns launched before the warm/hot guard (pre 2026-05-15)
   * shipped audienceType="retarget" with no metaAudienceId → Meta defaulted to
   * Advantage+ broad delivery. This endpoint attaches a real custom audience to
   * every live ad set on the campaign and disables Advantage+ audience expansion.
   *
   * Symptom in Meta UI:  "Audience: Advantage+ on" + "Custom audiences: None"
   * After running:        "Custom audiences: <name>" with broad expansion off
   */
  @Post(':tenantId/:campaignId/patch-audience')
  async patchAudience(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('customAudienceId') customAudienceId: string,
    @Body('audienceName') audienceName: string,
  ) {
    const campaign: any = await this.campaignsService.findById(
      tenantId,
      campaignId,
    );
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.metaCampaignId)
      throw new BadRequestException('Campaign was never launched on Meta');

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken)
      throw new BadRequestException('No Meta access token configured');

    // Resolve audience: prefer explicit ID, else look up by name in product config
    const allAudiences = (company.products ?? []).flatMap(
      (p: any) => p.metaAudiences ?? [],
    );
    let resolvedId = customAudienceId;
    if (!resolvedId && audienceName) {
      const match = allAudiences.find((a: any) => a.name === audienceName);
      if (!match) {
        throw new BadRequestException(
          `Audience name "${audienceName}" not found on any product. Available: ${allAudiences.map((a: any) => a.name).join(', ') || 'none configured'}`,
        );
      }
      resolvedId = match.id;
    }
    if (!resolvedId) {
      throw new BadRequestException(
        `Provide either customAudienceId or audienceName. Available custom audiences on this tenant: ${
          allAudiences
            .filter((a: any) => a.type === 'custom')
            .map((a: any) => `${a.name} (${a.id})`)
            .join(', ') || 'none'
        }`,
      );
    }

    // Verify the audience exists in product config — guard against typo'd IDs
    const auditMatch = allAudiences.find((a: any) => a.id === resolvedId);
    if (!auditMatch) {
      throw new BadRequestException(
        `customAudienceId "${resolvedId}" not found in any product.metaAudiences. Cannot verify it's a valid audience for this tenant — refusing to patch.`,
      );
    }

    const results: Array<{
      adSetId: string;
      status: 'patched' | 'failed';
      error?: string;
    }> = [];
    for (const liveAdSet of campaign.metaAdSets ?? []) {
      try {
        await this.metaAdsService.patchAdSetAudience(
          liveAdSet.id,
          company.meta.accessToken,
          resolvedId,
        );
        results.push({ adSetId: liveAdSet.id, status: 'patched' });
      } catch (err: any) {
        results.push({
          adSetId: liveAdSet.id,
          status: 'failed',
          error: err.message,
        });
      }
    }

    // Persist the chosen audience back to campaignConfig so future syncs / audits see it
    try {
      const cfg = (campaign as any).campaignConfig;
      if (cfg?.adSets) {
        for (const as of cfg.adSets) {
          if (['retarget', 'custom'].includes(as.audienceType)) {
            as.metaAudienceId = resolvedId;
          }
        }
        await this.campaignModel.updateOne(
          { _id: campaign._id },
          { $set: { campaignConfig: cfg } },
        );
      }
    } catch {
      // best-effort persist
    }

    return {
      campaignId,
      patchedAudience: {
        id: resolvedId,
        name: auditMatch.name,
        type: auditMatch.type,
      },
      patched: results.filter((r) => r.status === 'patched').length,
      failed: results.filter((r) => r.status === 'failed').length,
      results,
    };
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/backfill-variants
   *
   * Top up a launched campaign with copy/image variants that exist in the
   * creative_package but never made it onto Meta. Use case: pre-2026-05-14
   * campaigns where the Campaign Review Team narrowed image ad sets to one
   * variant index, leaving 3/4 of generated creative on the floor. Adds the
   * missing variants to each existing live ad set as PAUSED → ACTIVE ads.
   *
   * Idempotent: skips variants whose name already exists on the ad set.
   */
  @Post(':tenantId/:campaignId/backfill-variants')
  async backfillVariants(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign: any = await this.campaignsService.findById(
      tenantId,
      campaignId,
    );
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.metaCampaignId)
      throw new BadRequestException(
        'Campaign was never launched on Meta — backfill not applicable',
      );

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken)
      throw new BadRequestException(
        'No Meta access token configured for tenant',
      );

    const pkg: any = await this.campaignsService.findCreativePackage(
      campaign.creativePackageId,
    );
    if (!pkg)
      throw new BadRequestException(
        `creativePackage ${campaign.creativePackageId} not found`,
      );

    const copyVariants = pkg.copyVariants ?? [];
    const images = pkg.images ?? [];
    if (copyVariants.length === 0 || images.length === 0) {
      throw new BadRequestException(
        'Creative package has no variants or images',
      );
    }

    // Resolve product → landing URL. campaign.productName first, then the
    // brief; never "the first active product" — these ads are being added to a
    // LIVE campaign, so a wrong guess silently points new ads at another
    // product's funnel alongside correct ones.
    const brief = campaign.briefId
      ? await this.creativeBriefModel
          .findOne({ tenantId, briefId: campaign.briefId })
          .lean()
          .exec()
      : null;
    let product: any;
    try {
      product = resolveCampaignProduct(company, campaign as any, brief as any)
        .product;
      assertProductLaunchable(product, 'create');
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
    const landingUrl = product.landingUrl as string;
    const pageId = product.pageId ?? company.meta.pageId;
    if (!pageId)
      throw new BadRequestException(
        'product.pageId or company.meta.pageId is required for ad creative creation',
      );

    const results: Array<{
      adSetId: string;
      variantIndex: number;
      status: 'created' | 'skipped' | 'failed';
      adId?: string;
      error?: string;
    }> = [];

    for (const liveAdSet of campaign.metaAdSets ?? []) {
      const liveAds = liveAdSet.ads ?? [];
      // Variants already on this ad set — keyed by hookStyle since the ad name
      // includes "Variant N (hookStyle)" but variant index isn't directly stored
      // on the live ad. Use hookStyle as the dedupe key (each variant has a
      // distinct hookStyle in a single creative package).
      const existingHookStyles = new Set(
        liveAds
          .map((ad: any) => (ad.hookStyle ?? '').toLowerCase())
          .filter(Boolean),
      );

      for (let variantIdx = 0; variantIdx < copyVariants.length; variantIdx++) {
        const variant = copyVariants[variantIdx];
        const image = images.find(
          (img: any) => img.variantIndex === variantIdx,
        );
        if (!image?.imageUrl) {
          results.push({
            adSetId: liveAdSet.id,
            variantIndex: variantIdx,
            status: 'failed',
            error: 'no image generated for this variant',
          });
          continue;
        }
        const hs = (variant.hookStyle ?? '').toLowerCase();
        if (hs && existingHookStyles.has(hs)) {
          results.push({
            adSetId: liveAdSet.id,
            variantIndex: variantIdx,
            status: 'skipped',
          });
          continue;
        }

        const adName = `${liveAdSet.name} — Variant ${variantIdx + 1} (${variant.hookStyle ?? 'unknown'})`;
        try {
          const r = await this.metaAdsService.createAdInAdSet(
            liveAdSet.id,
            company.meta.accessToken,
            adName,
            {
              primaryText: variant.primaryText,
              headline: variant.headline,
              cta: variant.cta,
            },
            image.imageUrl,
            pageId,
            landingUrl,
            company.meta.specialAdCategories,
          );
          results.push({
            adSetId: liveAdSet.id,
            variantIndex: variantIdx,
            status: 'created',
            adId: r.adId,
          });
        } catch (err: any) {
          results.push({
            adSetId: liveAdSet.id,
            variantIndex: variantIdx,
            status: 'failed',
            error: err.message,
          });
        }
      }
    }

    // Trigger a sync of all active campaigns so the new ads appear in
    // metaAdSets[].ads on the next read. Don't fail the response on sync error.
    try {
      await this.campaignSyncService.syncActiveCampaigns(company);
    } catch {
      // best-effort
    }

    return {
      campaignId,
      created: results.filter((r) => r.status === 'created').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
      results,
    };
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/swap-page
   *
   * Fixes which Facebook Page a LIVE campaign's ads post as, in place — same
   * campaign, same ad sets, same ad IDs. Meta ad creatives are immutable, so
   * this clones each ad's current creative with the corrected page_id and
   * points the ad at the clone (meta-ads.service.ts#swapAdPage).
   *
   * The target Page must already be promote_pages-authorized on this
   * campaign's ad account (Business Settings → Ad Account → Pages) — Meta
   * rejects the new creative outright otherwise. A per-ad failure is
   * recorded and the rest still run, so one Meta hiccup doesn't leave the
   * campaign in a half-swapped state.
   *
   * Fire-and-forget, same reasoning as /sync: 40 ads × ~3 Meta calls each can
   * run minutes past the ALB's 60s gateway timeout. Validates synchronously
   * (fast, no Meta calls), writes campaign.pageSwapStatus so the dashboard
   * can poll GET /:tenantId/:campaignId for live progress, then dispatches
   * the actual swap in the background and returns 202 immediately.
   */
  @Post(':tenantId/:campaignId/swap-page')
  @HttpCode(202)
  async swapCampaignPage(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body() body: { pageId: string },
  ) {
    const campaign: any = await this.campaignModel
      .findOne({ _id: campaignId, tenantId })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.metaCampaignId)
      throw new BadRequestException(
        'Campaign was never launched on Meta — nothing to swap',
      );
    if (!body?.pageId) throw new BadRequestException('pageId is required');
    if (campaign.pageSwapStatus?.status === 'running')
      throw new BadRequestException(
        'A Page swap is already running for this campaign',
      );

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken)
      throw new BadRequestException(
        'No Meta access token configured for tenant',
      );

    const allAds = (campaign.metaAdSets ?? []).flatMap((as: any) =>
      (as.ads ?? []).map((ad: any) => ({ adSetId: as.id, adId: ad.id })),
    );
    if (allAds.length === 0)
      throw new BadRequestException('Campaign has no live ads to swap');

    await this.campaignModel.updateOne(
      { _id: campaignId, tenantId },
      {
        pageSwapStatus: {
          status: 'running',
          targetPageId: body.pageId,
          total: allAds.length,
          swapped: 0,
          failed: 0,
          startedAt: new Date(),
          results: [],
        },
      },
    );

    this.runPageSwap(
      tenantId,
      campaignId,
      allAds,
      body.pageId,
      company.meta.accessToken,
    ).catch((err: any) => {
      this.logger.error(
        `Background page swap failed for ${campaignId}: ${err.message}`,
      );
    });

    return {
      campaignId,
      pageId: body.pageId,
      status: 'started',
      total: allAds.length,
      message: `Page swap started in the background for ${allAds.length} ads — poll GET /:tenantId/:campaignId (campaign.pageSwapStatus) for live progress.`,
    };
  }

  /**
   * Runs the actual per-ad swap loop and writes progress back to
   * campaign.pageSwapStatus after every ad — not just at the end — so a
   * poller sees live movement instead of a status stuck on "running" for
   * however long the whole batch takes.
   */
  private async runPageSwap(
    tenantId: string,
    campaignId: string,
    ads: Array<{ adSetId: string; adId: string }>,
    pageId: string,
    accessToken: string,
  ): Promise<void> {
    const results: Array<{
      adSetId: string;
      adId: string;
      status: 'swapped' | 'failed';
      newCreativeId?: string;
      error?: string;
    }> = [];

    for (const { adSetId, adId } of ads) {
      try {
        const { newCreativeId } = await this.metaAdsService.swapAdPage(
          adId,
          pageId,
          accessToken,
        );
        results.push({ adSetId, adId, status: 'swapped', newCreativeId });
      } catch (err: any) {
        results.push({ adSetId, adId, status: 'failed', error: err.message });
      }

      await this.campaignModel.updateOne(
        { _id: campaignId, tenantId },
        {
          'pageSwapStatus.swapped': results.filter(
            (r) => r.status === 'swapped',
          ).length,
          'pageSwapStatus.failed': results.filter((r) => r.status === 'failed')
            .length,
          'pageSwapStatus.results': results,
        },
      );
    }

    await this.campaignModel.updateOne(
      { _id: campaignId, tenantId },
      {
        'pageSwapStatus.status': 'complete',
        'pageSwapStatus.completedAt': new Date(),
      },
    );

    // Refresh metaAdSets[].ads so the new creativeId shows up on next read.
    try {
      const company = await this.companiesService.findByTenantId(tenantId);
      await this.campaignSyncService.syncActiveCampaigns(company);
    } catch {
      // best-effort
    }
  }

  @Post(':tenantId/:campaignId/pause')
  async pause(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('reason') reason: string,
  ) {
    if (!reason) throw new BadRequestException('reason is required');
    const campaign = await this.campaignsService.pause(
      tenantId,
      campaignId,
      reason,
    );
    if (!campaign) throw new NotFoundException('Campaign not found');

    // Also pause on Meta if campaign was launched
    const metaCampaignId = (campaign as any).metaCampaignId;
    if (metaCampaignId) {
      const company = await this.companiesService.findByTenantId(tenantId);
      if (company?.meta?.accessToken) {
        await this.metaAdsService.pauseCampaign(
          metaCampaignId,
          company.meta.accessToken,
        );
      }
    }

    return campaign;
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/actions
   * List audit actions for a campaign. Optional ?status=pending|executed|overridden filter.
   */
  @Get(':tenantId/:campaignId/actions')
  async getActions(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Query('status') status?: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    const actions = (campaign as any).pendingActions ?? [];
    const filtered = status
      ? actions.filter((a: any) => a.status === status)
      : actions;
    return filtered.map((a: any) => ({
      actionId: a.actionId,
      type: a.type,
      targetId: a.targetId,
      targetName: a.targetName,
      reason: a.reason,
      status: a.status,
      recommendedAt: a.recommendedAt,
      executeAt: a.executeAt,
      executedAt: a.executedAt,
      metrics: a.metrics,
      replacementStatus: a.replacementStatus ?? null,
    }));
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/pending-actions
   * Backward-compatible alias — returns only pending actions.
   */
  @Get(':tenantId/:campaignId/pending-actions')
  async getPendingActions(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.getActions(tenantId, campaignId, 'pending');
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/approve
   * Approve a pending audit action — executes immediately.
   */
  @Post(':tenantId/:campaignId/actions/:actionId/approve')
  async approveAction(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Param('actionId') actionId: string,
  ) {
    try {
      // 1. Flip status in DB
      const result = await this.campaignsService.executeAction(
        tenantId,
        campaignId,
        actionId,
      );

      // 2. Execute on Meta immediately (don't wait for next audit cycle)
      const company = await this.companiesService.findByTenantId(tenantId);
      const campaign = await this.campaignsService.findById(
        tenantId,
        campaignId,
      );
      if (campaign && company) {
        await this.campaignAuditorService.executeApprovedAction(
          campaign,
          company,
          actionId,
        );
      }

      return { success: true, ...result, executedImmediately: true };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/reject
   * Reject a pending campaign — marks it as failed without launching.
   */
  @Post(':tenantId/:campaignId/reject')
  async reject(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('reason') reason: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    if ((campaign as any).status !== 'pending_approval') {
      throw new BadRequestException(
        'Only pending_approval campaigns can be rejected',
      );
    }
    await this.campaignsService.reject(
      tenantId,
      campaignId,
      reason ?? 'Rejected by tenant',
    );
    return { success: true, message: 'Campaign rejected' };
  }

  /**
   * DELETE /api/v1/campaigns/:tenantId/:campaignId
   * Removes a pending_approval campaign entirely (not just marked rejected).
   * Only for campaigns that never launched to Meta — CampaignsService.deleteCampaign
   * refuses anything with a metaCampaignId to avoid orphaning a real ad.
   */
  @Delete(':tenantId/:campaignId')
  async deleteCampaign(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    if ((campaign as any).status !== 'pending_approval') {
      throw new BadRequestException(
        'Only pending_approval campaigns can be deleted this way — use reject/pause for launched campaigns',
      );
    }
    try {
      await this.campaignsService.deleteCampaign(tenantId, campaignId);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
    return { success: true, message: 'Campaign deleted' };
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/regenerate
   * Re-runs Phase G (Campaign Review Team → campaign creation) for an existing
   * pending_approval campaign. Reuses the original brief + creative package —
   * no scout/research/creative-production rerun. Marks the old campaign as
   * 'superseded' and returns the freshly-created pending_approval campaign.
   *
   * Use when: review team produced a config that needs a re-debate (e.g. wrong
   * budget shape, stale prompt) but the underlying creatives are still good.
   */
  @Post(':tenantId/:campaignId/regenerate')
  async regenerate(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('reason') reason?: string,
  ) {
    try {
      const oldCampaign = await this.campaignModel
        .findOne({ _id: campaignId, tenantId })
        .exec();
      if (!oldCampaign) throw new NotFoundException('Campaign not found');
      if (oldCampaign.status !== 'pending_approval') {
        throw new BadRequestException(
          `Only pending_approval campaigns can be regenerated (current: ${oldCampaign.status})`,
        );
      }
      if (!oldCampaign.briefId) {
        throw new BadRequestException(
          'Campaign has no briefId — cannot reload original brief',
        );
      }

      const brief = await this.creativeBriefModel
        .findOne({ tenantId, briefId: oldCampaign.briefId })
        .exec();
      if (!brief)
        throw new NotFoundException(`Brief ${oldCampaign.briefId} not found`);

      const creativePackage = await this.creativePackageModel
        .findOne({
          tenantId,
          briefId: oldCampaign.briefId,
          status: 'completed',
        })
        .exec();
      if (!creativePackage) {
        throw new NotFoundException(
          `No completed creative package found for brief ${oldCampaign.briefId}`,
        );
      }

      const company = await this.companiesService.findByTenantId(tenantId);

      // Mark old campaign superseded BEFORE creating new — idempotency check on
      // create() filters out superseded so the new one will save cleanly.
      await this.campaignModel.updateOne(
        { _id: campaignId, tenantId },
        {
          $set: {
            status: 'superseded',
            pauseReason: reason ?? 'Regenerated via /regenerate endpoint',
            pausedAt: new Date(),
          },
        },
      );

      let newCampaign;
      try {
        newCampaign = await this.campaignCreator.create(
          brief,
          creativePackage,
          company,
          oldCampaign.runId,
        );
      } catch (err: any) {
        // Restore old campaign if regenerate fails — don't leave the tenant
        // with no pending campaign at all.
        await this.campaignModel.updateOne(
          { _id: campaignId, tenantId },
          {
            $set: { status: 'pending_approval' },
            $unset: { pauseReason: '', pausedAt: '' },
          },
        );
        throw err;
      }

      return {
        success: true,
        oldCampaignId: campaignId,
        newCampaignId: (newCampaign as any)._id.toString(),
        newCampaignName: newCampaign.name,
        newBudget: newCampaign.budget,
        message: `Old campaign superseded — new pending_approval campaign created`,
      };
    } catch (err: any) {
      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException
      )
        throw err;
      throw new BadRequestException(err.message);
    }
  }

  /**
   * PATCH /api/v1/campaigns/:tenantId/:campaignId/budget
   * Edit a pending_approval campaign's daily budget. Re-runs the same TS-level
   * budget validation (per-campaign cap + weekly cap) that initial creation ran,
   * so the LLM/operator can't override safety here either. Used by the
   * Approvals Inbox "✏️ Edit Budget" button.
   */
  @Patch(':tenantId/:campaignId/budget')
  async editBudget(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body('budget') budget: number,
  ) {
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
      throw new BadRequestException('budget must be a positive number');
    }
    const campaign = await this.campaignModel
      .findOne({ _id: campaignId, tenantId })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.status !== 'pending_approval') {
      throw new BadRequestException(
        `Only pending_approval campaigns can edit budget (current: ${campaign.status})`,
      );
    }

    const company = await this.companiesService.findByTenantId(tenantId);

    // Same gates that ran at create time — TS-level safety, never overridable.
    SafetyChecks.checkCampaignBudget(budget, company);
    await SafetyChecks.checkWeeklyBudget(
      tenantId,
      budget,
      company,
      this.campaignsService,
    );

    await this.campaignModel.updateOne(
      { _id: campaignId, tenantId },
      { $set: { budget } },
    );

    return {
      campaignId,
      budget,
      status: campaign.status,
      message: `Budget updated to ₹${budget}/day`,
    };
  }

  /**
   * PATCH /api/v1/campaigns/:tenantId/:campaignId/adsets/:adSetId/budget
   *
   * Operator sets a live ad set's daily budget directly — "put ₹3,000/day on
   * this one" — rather than waiting on the AI's percent-based scale/shift/
   * reduce proposals. The only path that previously existed for a live
   * campaign was accept-or-reject the AI's own number; this is the first
   * free-entry budget field for an already-launched ad set.
   *
   * Same TS-side caps as every other budget path (maxBudgetPerCampaign,
   * weeklyBudgetCap) via CampaignOptimizerService.setAdSetBudget — a human
   * typing a number doesn't get to skip the rails an AI-proposed change would
   * have to clear.
   */
  @Patch(':tenantId/:campaignId/adsets/:adSetId/budget')
  async editAdSetBudget(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Param('adSetId') adSetId: string,
    @Body('dailyBudget') dailyBudget: number,
  ) {
    if (
      typeof dailyBudget !== 'number' ||
      !Number.isFinite(dailyBudget) ||
      dailyBudget <= 0
    ) {
      throw new BadRequestException('dailyBudget must be a positive number');
    }

    const campaign = await this.campaignModel
      .findOne({ _id: campaignId, tenantId })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.metaCampaignId) {
      throw new BadRequestException(
        'Campaign was never launched on Meta — use PATCH /budget (pre-launch) instead',
      );
    }

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken) {
      throw new BadRequestException('No Meta access token configured for tenant');
    }

    try {
      const result = await this.campaignOptimizerService.setAdSetBudget(
        campaign,
        company,
        adSetId,
        dailyBudget,
      );

      // Refresh metaAdSets[].dailyBudget so the dashboard doesn't show a
      // stale per-ad-set figure until the next scheduled sync.
      try {
        await this.campaignSyncService.syncActiveCampaigns(company);
      } catch {
        // best-effort
      }

      return {
        campaignId,
        adSetId,
        ...result,
        message: `Ad set budget updated to ₹${dailyBudget}/day`,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * PATCH /api/v1/campaigns/:tenantId/:campaignId/adsets/:adSetId/placement
   *
   * Operator changes which Meta surfaces a live ad set can serve on —
   * "switch this to Vertical + Feed" — the manual counterpart to the AI
   * audit loop's narrow_placement action, but broadening as well as
   * narrowing, and expressed as a fixed preset (see placement-presets.ts)
   * rather than raw Facebook/Instagram position arrays an operator would
   * have to get right by hand.
   *
   * Body: { placementPreset: 'vertical' | 'vertical_feed' | 'everywhere' }.
   */
  @Patch(':tenantId/:campaignId/adsets/:adSetId/placement')
  async editAdSetPlacement(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Param('adSetId') adSetId: string,
    @Body('placementPreset') placementPreset: PlacementPreset,
  ) {
    if (!VALID_PLACEMENT_PRESETS.has(placementPreset)) {
      throw new BadRequestException(
        `placementPreset must be one of ${[...VALID_PLACEMENT_PRESETS].join(', ')}`,
      );
    }

    const campaign = await this.campaignModel
      .findOne({ _id: campaignId, tenantId })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.metaCampaignId) {
      throw new BadRequestException(
        'Campaign was never launched on Meta — nothing to change placements on',
      );
    }

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken) {
      throw new BadRequestException(
        'No Meta access token configured for tenant',
      );
    }

    try {
      const result = await this.campaignOptimizerService.setAdSetPlacement(
        campaign,
        company,
        adSetId,
        placementPreset,
      );

      // Refresh metaAdSets[].targetingDetail so the dashboard doesn't show
      // stale placement chips until the next scheduled sync.
      try {
        await this.campaignSyncService.syncActiveCampaigns(company);
      } catch {
        // best-effort
      }

      return {
        campaignId,
        ...result,
        message: `Ad set placements updated to ${PLACEMENT_PRESET_LABELS[placementPreset]}`,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/adsets
   *
   * Operator adds a brand-new ad set to an already-live campaign — same
   * campaign, a new ad set inside it. Manual counterpart to the auditor's
   * automated `add_adset` action.
   *
   * Body: { name?, audienceType: 'advantage_plus'|'retarget'|'lookalike',
   * metaAudienceId? (required unless advantage_plus), dailyBudget,
   * placementPreset? ('vertical'|'vertical_feed'|'everywhere', defaults to
   * 'vertical'), optimizationGoal? (defaults to inheriting the campaign's
   * existing goal — only pass this to deliberately ship a DIFFERENT goal;
   * the frontend gates that behind an operator confirmation, since mixed
   * goals in one campaign split the audit loop's ROAS/CPA comparison) }
   * plus EITHER a single creative ({assetType, mediaUrl, primaryText,
   * headline, cta}) OR a whole Gallery sheet ({sheetId, excludeAssetIds?})
   * — every usable asset in the sheet becomes its own ad in the new ad set,
   * copy pulled from each asset's own source package. Same TS-side budget
   * caps as every other budget path, via CampaignOptimizerService.addAdSet.
   */
  @Post(':tenantId/:campaignId/adsets')
  async addAdSet(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Body()
    body: {
      name?: string;
      audienceType: 'advantage_plus' | 'retarget' | 'lookalike';
      metaAudienceId?: string;
      dailyBudget: number;
      placementPreset?: PlacementPreset;
      optimizationGoal?: string;
      sheetId?: string;
      excludeAssetIds?: string[];
      assetType?: 'image' | 'video';
      mediaUrl?: string;
      primaryText?: string;
      headline?: string;
      cta?: string;
    },
  ) {
    if (!body?.audienceType) {
      throw new BadRequestException('audienceType is required');
    }
    if (
      typeof body?.dailyBudget !== 'number' ||
      !Number.isFinite(body.dailyBudget) ||
      body.dailyBudget <= 0
    ) {
      throw new BadRequestException('dailyBudget must be a positive number');
    }
    if (
      body.placementPreset !== undefined &&
      !VALID_PLACEMENT_PRESETS.has(body.placementPreset)
    ) {
      throw new BadRequestException(
        `placementPreset must be one of ${[...VALID_PLACEMENT_PRESETS].join(', ')}`,
      );
    }
    if (
      body.optimizationGoal !== undefined &&
      !VALID_OPTIMIZATION_GOALS.has(body.optimizationGoal)
    ) {
      throw new BadRequestException(
        `optimizationGoal must be one of ${[...VALID_OPTIMIZATION_GOALS].join(', ')}`,
      );
    }
    if (!!body?.sheetId === !!body?.mediaUrl) {
      throw new BadRequestException(
        'Provide exactly one of sheetId or mediaUrl',
      );
    }
    if (!body.sheetId) {
      if (body?.assetType !== 'image' && body?.assetType !== 'video') {
        throw new BadRequestException("assetType must be 'image' or 'video'");
      }
      if (!body?.primaryText?.trim() || !body?.headline?.trim()) {
        throw new BadRequestException('primaryText and headline are required');
      }
    }

    const campaign = await this.campaignModel
      .findOne({ _id: campaignId, tenantId })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.metaCampaignId) {
      throw new BadRequestException(
        'Campaign was never launched on Meta — nothing to add an ad set to',
      );
    }

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken) {
      throw new BadRequestException('No Meta access token configured for tenant');
    }

    try {
      const result = await this.campaignOptimizerService.addAdSet(
        campaign,
        company,
        {
          name: body.name,
          audienceType: body.audienceType,
          metaAudienceId: body.metaAudienceId,
          dailyBudget: body.dailyBudget,
          placementPreset: body.placementPreset,
          optimizationGoal: body.optimizationGoal,
          ...(body.sheetId
            ? { sheetId: body.sheetId, excludeAssetIds: body.excludeAssetIds }
            : {
                assetType: body.assetType!,
                mediaUrl: body.mediaUrl!,
                copy: {
                  primaryText: body.primaryText!,
                  headline: body.headline!,
                  cta: body.cta || 'Shop Now',
                },
              }),
        },
      );

      // Refresh metaAdSets[] so the new ad set/ad(s) show up on next read.
      try {
        await this.campaignSyncService.syncActiveCampaigns(company);
      } catch {
        // best-effort
      }

      const skippedNote = result.skippedCarousel
        ? `, skipped ${result.skippedCarousel} carousel card(s)`
        : '';
      const failedNote = result.failed.length
        ? `, ${result.failed.length} failed`
        : '';
      return {
        campaignId,
        ...result,
        message: `New ${body.audienceType} ad set created with ${result.createdAds.length} ad(s) at ₹${body.dailyBudget}/day${failedNote}${skippedNote}`,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/adsets/:adSetId/creatives
   *
   * Operator-authored creative added to an EXISTING live ad set — the human
   * writes their own copy and supplies their own image/video (already
   * uploaded via POST /creative/:tenantId/upload-file), rather than the AI
   * generating something or backfill-variants re-adding an existing package
   * variant. The ad set's budget/audience are untouched — only a new ad
   * joins it.
   *
   * Body: { name?, assetType: 'image'|'video', mediaUrl, primaryText,
   * headline, cta }.
   */
  @Post(':tenantId/:campaignId/adsets/:adSetId/creatives')
  async addCreativeToAdSet(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Param('adSetId') adSetId: string,
    @Body()
    body: {
      name?: string;
      assetType: 'image' | 'video';
      mediaUrl: string;
      primaryText: string;
      headline: string;
      cta: string;
    },
  ) {
    if (body?.assetType !== 'image' && body?.assetType !== 'video') {
      throw new BadRequestException("assetType must be 'image' or 'video'");
    }
    if (!body?.mediaUrl) {
      throw new BadRequestException('mediaUrl is required');
    }
    if (!body?.primaryText?.trim() || !body?.headline?.trim()) {
      throw new BadRequestException('primaryText and headline are required');
    }

    const campaign = await this.campaignModel
      .findOne({ _id: campaignId, tenantId })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.metaCampaignId) {
      throw new BadRequestException(
        'Campaign was never launched on Meta — nothing to add a creative to',
      );
    }

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken) {
      throw new BadRequestException('No Meta access token configured for tenant');
    }

    try {
      const result = await this.campaignOptimizerService.addCreativeToAdSet(
        campaign,
        company,
        {
          adSetId,
          name: body.name,
          assetType: body.assetType,
          mediaUrl: body.mediaUrl,
          copy: {
            primaryText: body.primaryText,
            headline: body.headline,
            cta: body.cta || 'Shop Now',
          },
        },
      );

      // Refresh metaAdSets[].ads so the new ad shows up on next read.
      try {
        await this.campaignSyncService.syncActiveCampaigns(company);
      } catch {
        // best-effort
      }

      return {
        campaignId,
        adSetId,
        ...result,
        message: `New ${body.assetType} ad added to ad set`,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/adsets/:adSetId/creatives/bulk
   *
   * Whole-sheet counterpart to addCreativeToAdSet above — attaches every
   * usable asset in a Gallery sheet to this EXISTING live ad set as its own
   * new ad, copy pulled from each asset's own source package instead of
   * being typed once. The ad set's budget/audience are untouched.
   *
   * Body: { sheetId, excludeAssetIds? }.
   */
  @Post(':tenantId/:campaignId/adsets/:adSetId/creatives/bulk')
  async addCreativeToAdSetBulk(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Param('adSetId') adSetId: string,
    @Body() body: { sheetId?: string; excludeAssetIds?: string[] },
  ) {
    if (!body?.sheetId) {
      throw new BadRequestException('sheetId is required');
    }

    const campaign = await this.campaignModel
      .findOne({ _id: campaignId, tenantId })
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (!campaign.metaCampaignId) {
      throw new BadRequestException(
        'Campaign was never launched on Meta — nothing to add a creative to',
      );
    }

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company?.meta?.accessToken) {
      throw new BadRequestException(
        'No Meta access token configured for tenant',
      );
    }

    try {
      const result = await this.campaignOptimizerService.addCreativeToAdSet(
        campaign,
        company,
        {
          adSetId,
          sheetId: body.sheetId,
          excludeAssetIds: body.excludeAssetIds,
        },
      );

      // Refresh metaAdSets[].ads so the new ads show up on next read.
      try {
        await this.campaignSyncService.syncActiveCampaigns(company);
      } catch {
        // best-effort
      }

      const skippedNote = result.skippedCarousel
        ? `, skipped ${result.skippedCarousel} carousel card(s)`
        : '';
      const failedNote = result.failed.length
        ? `, ${result.failed.length} failed`
        : '';
      return {
        campaignId,
        adSetId,
        ...result,
        message: `${result.createdAds.length} ad(s) added to ad set${failedNote}${skippedNote}`,
      };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/shadow-actions
   * Returns the LLM-proposed-but-blocked actions for this campaign with their
   * regretLabel (correct_block / missed_signal / inconclusive — set by the
   * shadow-eval cron 72h after the block). Lets the dashboard show whether
   * the safety guards were correctly tuned.
   */
  @Get(':tenantId/:campaignId/shadow-actions')
  async getShadowActions(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign = await this.campaignModel
      .findOne({ _id: campaignId, tenantId })
      .select('_id')
      .lean()
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');
    return this.shadowActionModel
      .find({ tenantId, campaignId })
      .sort({ blockedAt: -1 })
      .limit(50)
      .lean()
      .exec();
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/audit-snapshots
   * Returns audit history for a campaign — last 30 snapshots sorted newest first.
   * Each entry has: auditedAt, metrics, verdict (verdict/urgency/contextInsight/recommendedActions), adSets[]
   */
  @Get(':tenantId/:campaignId/audit-snapshots')
  async getAuditSnapshots(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');

    const snapshots = await this.snapshotModel
      .find({ tenantId, campaignId })
      .sort({ auditedAt: -1 })
      .limit(30)
      .lean()
      .exec();

    return snapshots.map((s) => ({
      auditedAt: s.auditedAt,
      metrics: s.metrics,
      adSets: s.adSets,
      verdict: s.verdict,
    }));
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/breakdowns
   * Segment performance: age×gender, region, placement, hourly, day-of-week,
   * and per-asset (video/body/title) rows — campaign-level rollup by default.
   * Pass ?level=adset&entityId=<metaAdSetId> for one ad set's own rows instead.
   */
  @Get(':tenantId/:campaignId/breakdowns')
  async getCampaignBreakdowns(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Query('level') level?: string,
    @Query('entityId') entityId?: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    const metaCampaignId = (campaign as any).metaCampaignId;
    if (!metaCampaignId) return {};

    // Default (no entityId): campaign-wide view. Rollup types (age_gender,
    // region, placement, hourly, dow) live as ONE doc at level='campaign'.
    // Per-asset types (asset_body/title/video) live as ONE doc PER AD at
    // level='ad' — there is no campaign-level rollup for those, so they must
    // be concatenated across every ad's doc, not selected by a single level
    // filter (querying level='campaign' alone silently returned zero rows
    // for every asset_* type).
    const docs = await this.breakdownModel
      .find(
        entityId
          ? { tenantId, entityId }
          : level
            ? { tenantId, metaCampaignId, level }
            : { tenantId, metaCampaignId, level: { $in: ['campaign', 'ad'] } },
      )
      .lean()
      .exec();

    const byType: Record<
      string,
      { rows: unknown[]; fetchedAt: Date; window: string }
    > = {};
    for (const d of docs) {
      const bucket = byType[d.breakdownType] ?? {
        rows: [],
        fetchedAt: d.fetchedAt,
        window: d.window,
      };
      bucket.rows.push(...d.rows);
      if (d.fetchedAt > bucket.fetchedAt) bucket.fetchedAt = d.fetchedAt;
      byType[d.breakdownType] = bucket;
    }
    return byType;
  }

  /**
   * GET /api/v1/campaigns/:tenantId/:campaignId/timeseries
   * Daily rows (time_increment=1) for trend charts. level=campaign|adset|ad,
   * defaults to campaign; pass entityId for a specific adset/ad's own series.
   */
  @Get(':tenantId/:campaignId/timeseries')
  async getCampaignTimeseries(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Query('level') level?: string,
    @Query('entityId') entityId?: string,
  ) {
    const campaign = await this.campaignsService.findById(tenantId, campaignId);
    if (!campaign) throw new NotFoundException('Campaign not found');
    const metaCampaignId = (campaign as any).metaCampaignId;
    if (!metaCampaignId) return [];

    const lvl = level ?? 'campaign';
    const filter: Record<string, unknown> = {
      tenantId,
      metaCampaignId,
      level: lvl,
    };
    if (entityId) filter.entityId = entityId;
    else if (lvl === 'campaign') filter.entityId = metaCampaignId;

    return this.timeseriesModel
      .find(filter)
      .sort({ date: 1 })
      .select(
        '-_id date spend impressions reach frequency clicks ctr cpc cpm conversions revenue addToCart initiateCheckout landingPageView video3s thruplay entityId adsetId',
      )
      .lean()
      .exec();
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/actions/:actionId/override
   * Override (skip) a pending audit action — it won't auto-execute.
   */
  @Post(':tenantId/:campaignId/actions/:actionId/override')
  async overrideAction(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
    @Param('actionId') actionId: string,
  ) {
    try {
      await this.campaignsService.overrideAction(
        tenantId,
        campaignId,
        actionId,
      );
      return { success: true, message: 'Action overridden — will not execute' };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/sync
   * Manually trigger a Meta campaign sync for a tenant.
   *
   * Fire-and-forget: this instance sits behind an ALB with a 60s gateway
   * timeout, well under the multi-minute runtime a sync can take (bulk
   * chunked+paginated Meta fetches). Awaiting the sync here meant the ALB
   * always killed the connection and returned a 504 to the caller even when
   * the sync succeeded underneath — the backend kept running and wrote to
   * Mongo regardless, but every caller saw a false failure. Validates
   * preconditions synchronously (fast — no Meta calls), then dispatches the
   * actual sync in the background and returns 202 immediately. Poll
   * GET /:tenantId shortly after, or check server logs, for completion.
   */
  @Post(':tenantId/sync')
  @HttpCode(202)
  async syncCampaigns(@Param('tenantId') tenantId: string) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company.meta?.accessToken) {
      throw new BadRequestException(
        'No Meta access token configured for this tenant',
      );
    }

    this.campaignSyncService.syncActiveCampaigns(company).catch((err: any) => {
      this.logger.error(`Background campaign sync failed for ${tenantId}: ${err.message}`);
    });

    return {
      success: true,
      status: 'started',
      message: 'Campaign sync started in the background — poll GET /:tenantId shortly for updated data.',
    };
  }

  /**
   * POST /api/v1/campaigns/:tenantId/deep-sync
   * Daily-series backfill (time_increment=1, default 90d) + segment
   * breakdowns (age×gender, region, placement, hourly, dow, per-asset) for
   * all ACTIVE campaigns. Read-only against Meta. Heavier than /sync —
   * expect a few minutes for a 7-campaign account.
   *
   * Fire-and-forget for the same reason as /sync above — the ALB's 60s
   * gateway timeout can't turn a successful deep-sync into a false-looking
   * 504. Returns 202 immediately; segment/timeseries data lands in Mongo a
   * few minutes later regardless of whether anyone is still listening on
   * the connection.
   */
  @Post(':tenantId/deep-sync')
  @HttpCode(202)
  async deepSyncCampaigns(
    @Param('tenantId') tenantId: string,
    @Query('backfillDays') backfillDays?: string,
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company.meta?.accessToken) {
      throw new BadRequestException(
        'No Meta access token configured for this tenant',
      );
    }

    const parsedBackfillDays = backfillDays ? parseInt(backfillDays, 10) : undefined;
    this.metaDeepSyncService
      .deepSync(company, { backfillDays: parsedBackfillDays })
      .catch((err: any) => {
        this.logger.error(`Background deep-sync failed for ${tenantId}: ${err.message}`);
      });

    return {
      success: true,
      status: 'started',
      message: 'Deep sync started in the background — segment/timeseries data will update over the next few minutes.',
    };
  }

  /**
   * POST /api/v1/campaigns/:tenantId/audit
   * Manually trigger a campaign audit pass for a tenant — runs the same logic
   * as the 6h cron job (safety rails → signals → verdict → snapshot).
   */
  @Post(':tenantId/audit')
  async triggerAudit(@Param('tenantId') tenantId: string) {
    try {
      const result = await this.campaignAuditorService.audit(tenantId);
      return { success: true, ...result };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/:campaignId/audit
   * Manually trigger an audit for a single campaign — same flow as the tenant-wide
   * audit, scoped to one campaign. Useful for the dashboard "Run Audit" button and
   * for re-evaluating one campaign after a config change without touching the rest.
   */
  @Post(':tenantId/:campaignId/audit')
  async triggerAuditOne(
    @Param('tenantId') tenantId: string,
    @Param('campaignId') campaignId: string,
  ) {
    try {
      const result = await this.campaignAuditorService.auditOne(
        tenantId,
        campaignId,
      );
      return { success: true, campaignId, ...result };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/audiences/setup
   * Body: { productName?: string }
   *
   * Provision the standard retargeting cohort stack on Meta for this tenant
   * (page visitors at 30/90d, booking-initiated, purchasers, 1% / 2% lookalikes
   * of purchasers). Idempotent — cohorts that already exist by name are skipped.
   * Returns per-cohort status (created / exists / failed / skipped).
   *
   * Today: manual trigger. Future: scheduled weekly refresh in scheduler module.
   */
  @Post(':tenantId/audiences/setup')
  async setupStandardAudiences(
    @Param('tenantId') tenantId: string,
    @Body() body: { productName?: string } = {},
  ) {
    try {
      const results = await this.audienceOrchestration.createStandardStack(
        tenantId,
        body.productName,
      );
      const summary = {
        created: results.filter((r) => r.status === 'created').length,
        exists: results.filter((r) => r.status === 'exists').length,
        failed: results.filter((r) => r.status === 'failed').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        // Not a failure — the seed audience just isn't populated yet. These
        // become real audiences on a later audiences/rebuild-lookalikes run.
        deferred: results.filter((r) => r.status === 'deferred').length,
      };
      return { tenantId, summary, cohorts: results };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * POST /api/v1/campaigns/:tenantId/audiences/rebuild-lookalikes
   * Body: { productName?: string, force?: boolean }
   *
   * Creates lookalikes that were deferred at setup time (seed not yet
   * populated) and repairs ones Meta has marked dead — a lookalike built from
   * an empty seed fails permanently with operation_status 433 and can only be
   * fixed by delete-and-recreate, which this does once the seed is ready.
   *
   * Idempotent and safe to schedule. Healthy lookalikes are left untouched
   * unless force=true, since deleting a live audience would break running ad
   * sets that reference it.
   */
  @Post(':tenantId/audiences/rebuild-lookalikes')
  async rebuildLookalikes(
    @Param('tenantId') tenantId: string,
    @Body() body: { productName?: string; force?: boolean } = {},
  ) {
    try {
      const results = await this.audienceOrchestration.rebuildLookalikes(
        tenantId,
        body.productName,
        body.force === true,
      );
      const summary = {
        created: results.filter((r) => r.status === 'created').length,
        repaired: results.filter((r) => r.status === 'repaired').length,
        exists: results.filter((r) => r.status === 'exists').length,
        deferred: results.filter((r) => r.status === 'deferred').length,
        failed: results.filter((r) => r.status === 'failed').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
      };
      return { tenantId, summary, cohorts: results };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  /**
   * GET /api/v1/campaigns/:tenantId/audiences/status?productName=X
   * Read-only view of which standard cohorts exist for this tenant.
   */
  @Get(':tenantId/audiences/status')
  async getAudienceStatus(
    @Param('tenantId') tenantId: string,
    @Query('productName') productName?: string,
  ) {
    return this.audienceOrchestration.listCohortStatus(tenantId, productName);
  }
}
