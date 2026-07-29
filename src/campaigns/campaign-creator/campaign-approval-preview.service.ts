import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Campaign, CampaignDocument } from '../schemas/campaign.schema';
import { CampaignsService } from '../campaigns.service';
import { CompaniesService } from '../../companies/companies.service';
import { Product } from '../../companies/schemas/company.types';
import {
  getEffectiveConversionValue,
  getGrossConversionValue,
} from '../../common/conversion-value.util';
import { buildMetaCampaignName } from './meta-campaign-name.util';
import { tryResolveCampaignProduct } from './resolve-campaign-product';
import { checkCopySafety } from '../../common/safety/copy-safety-checker.util';

/**
 * Everything an operator needs to see BEFORE clicking Approve & Launch.
 *
 * The approve screen used to show the campaign document more or less raw,
 * which hid the two facts that actually decide whether a launch is correct:
 * which product the ads point at, and what Meta will receive. On 2026-07-27 a
 * campaign built for one product launched against another product's landing
 * page, pixel and custom conversion — and nothing on the approval screen could
 * have revealed it, because the destination wasn't resolved until launch.
 *
 * So this deliberately reports RESOLVED values, not stored ones: the exact
 * destination URL per ad set, the pixel and conversion the ad sets will
 * optimize toward, the ₹ each ad set gets per day, the copy and images that
 * will ship, and the Meta campaign name that will be created. Plus `blockers`
 * — the things that will make /approve fail — so they're visible before the
 * click rather than as an error after it.
 *
 * Read-only. It never mutates the campaign, and its product resolution uses
 * the non-throwing variant so a broken campaign still renders (with the
 * problem stated) instead of returning a 400 the operator can't act on.
 */

export interface ApprovalPreviewIssue {
  /** Stable code so the UI can style/localize; message is human-facing. */
  code: string;
  message: string;
  /** Where to go to fix it, when there's an obvious place. */
  fix?: string;
}

@Injectable()
export class CampaignApprovalPreviewService {
  private readonly logger = new Logger(CampaignApprovalPreviewService.name);

  constructor(
    @InjectModel(Campaign.name)
    private readonly campaignModel: Model<CampaignDocument>,
    private readonly campaignsService: CampaignsService,
    private readonly companiesService: CompaniesService,
  ) {}

  async build(tenantId: string, campaignId: string): Promise<any> {
    const campaign = await this.campaignModel
      .findOne({ tenantId, _id: campaignId })
      .lean()
      .exec();
    if (!campaign) throw new NotFoundException('Campaign not found');

    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company) throw new NotFoundException('Tenant not found');

    const blockers: ApprovalPreviewIssue[] = [];
    const warnings: ApprovalPreviewIssue[] = [];

    const config: any = (campaign as any).campaignConfig ?? {};
    const configAdSets: any[] = Array.isArray(config.adSets)
      ? config.adSets
      : [];
    const isLandingPageTest = !!config.isLandingPageTest;

    // ── Product: the single fact this whole screen exists to make visible ──
    const brief = campaign.briefId
      ? await this.campaignsService.findCreativeBrief(
          tenantId,
          campaign.briefId,
        )
      : null;
    const { resolution, error: productError } = tryResolveCampaignProduct(
      company as any,
      campaign as any,
      brief as any,
    );
    const product = resolution?.product;

    if (!product) {
      blockers.push({
        code: 'product_unresolved',
        message:
          productError ?? 'Cannot determine which product this campaign sells.',
        fix: `PATCH /api/v1/campaigns/${tenantId}/${campaignId}/config with { "productName": "<one of: ${(company.products ?? []).map((p: Product) => p.name).join(', ') || 'no products configured'}>" }`,
      });
    } else {
      if (!isLandingPageTest && !(product.landingUrl ?? '').trim()) {
        blockers.push({
          code: 'product_no_landing_url',
          message: `Product "${product.name}" has no Landing URL — the ads would have no destination.`,
          fix: `Set the product's Landing URL on the company/product screen.`,
        });
      }
      if (resolution!.source !== 'campaign') {
        warnings.push({
          code: 'product_inferred',
          message:
            resolution!.source === 'brief'
              ? `This campaign has no product recorded on it — "${product.name}" was inferred from its creative brief.`
              : `This campaign has no product recorded on it — "${product.name}" was used because it is the tenant's only active product.`,
          fix: `PATCH /config with { "productName": "${product.name}" } to record it explicitly.`,
        });
      }
      if (resolution!.matchedLoosely) {
        warnings.push({
          code: 'product_matched_loosely',
          message: `Requested product "${resolution!.matchedLoosely.requested}" matched "${resolution!.matchedLoosely.matched}" only after ignoring case/spacing.`,
          fix: `PATCH /config with { "productName": "${resolution!.matchedLoosely.matched}" }.`,
        });
      }
    }

    // ── Creative package ──────────────────────────────────────────────────
    const pkg: any = campaign.creativePackageId
      ? await this.campaignsService.findCreativePackage(
          campaign.creativePackageId,
        )
      : null;
    const copyVariants: any[] = pkg?.copyVariants ?? [];
    const images: any[] = pkg?.images ?? [];
    const videos: any[] = pkg?.videos?.length
      ? pkg.videos
      : pkg?.video
        ? [pkg.video]
        : [];
    const carouselCards: any[] = pkg?.carouselCards ?? [];

    if (!pkg) {
      blockers.push({
        code: 'creative_package_missing',
        message: campaign.creativePackageId
          ? `Creative package ${campaign.creativePackageId} no longer exists.`
          : 'This campaign has no creative package — there is nothing to launch.',
      });
    } else if (pkg.status !== 'completed') {
      blockers.push({
        code: 'creative_package_not_ready',
        message: `Creative package is "${pkg.status}", not "completed".`,
      });
    }
    if (pkg && copyVariants.length === 0) {
      blockers.push({
        code: 'no_copy_variants',
        message: 'Creative package has no copy variants.',
      });
    }
    if (
      pkg &&
      images.length === 0 &&
      videos.length === 0 &&
      carouselCards.length === 0
    ) {
      blockers.push({
        code: 'no_creative_assets',
        message: 'Creative package has no images, videos or carousel cards.',
      });
    }

    // ── Copy policy gate, run BEFORE the operator clicks Approve ──────────
    //
    // launchCampaign enforces this too, but only after uploading every image
    // to Meta — on a 40-variant package that's ~157 uploads and several
    // minutes of waiting before a single bad word aborts the whole launch.
    // Worse, this screen used to report "Ready to launch" regardless, because
    // it never looked at the copy at all. Surfacing it here means the Approve
    // button reflects the same rules the launch will apply.
    const copyFailures = copyVariants
      .map((v, i) => ({ i, v, safety: checkCopySafety({
        primaryText: v?.primaryText,
        headline: v?.headline,
        cta: v?.cta,
        declaredSpecialAdCategories: company.meta?.specialAdCategories ?? [],
      }) }))
      .filter((r) => !r.safety.safe);
    for (const { i, v, safety } of copyFailures) {
      const detail = [
        ...safety.forbiddenClaims.map((f) => `"${f.phrase}" in ${f.copyField} (${f.reason})`),
        ...safety.specialAdCategoryTriggers.map(
          (f) => `"${f.phrase}" in ${f.copyField} → needs ${f.category}`,
        ),
      ].join('; ');
      blockers.push({
        code: 'copy_policy_violation',
        message: `Copy variant #${i}${v?.headline ? ` ("${String(v.headline).slice(0, 50)}")` : ''} would be rejected at launch: ${detail}`,
        fix: 'Edit this variant on the campaign edit screen, or declare the special ad category on the company, then re-check.',
      });
    }

    // ── Meta account / credentials ────────────────────────────────────────
    if (!company.meta?.accessToken) {
      blockers.push({
        code: 'no_access_token',
        message: 'No Meta access token configured for this tenant.',
      });
    }
    if (!company.meta?.pageId) {
      blockers.push({
        code: 'no_page_id',
        message:
          'No Meta Page ID configured — ad creatives cannot be created without one.',
      });
    }
    const allowedAccountIds =
      company.meta?.accountIds ??
      (company.meta?.accountId ? [company.meta.accountId] : []);
    const stripPrefix = (id: string) =>
      id.startsWith('act_') ? id.slice(4) : id;
    const intendedAccountId =
      campaign.metaAccountId || company.meta?.accountId || '';
    if (
      intendedAccountId &&
      !allowedAccountIds
        .map(stripPrefix)
        .includes(stripPrefix(intendedAccountId))
    ) {
      warnings.push({
        code: 'account_not_in_list',
        message: `Intended ad account ${intendedAccountId} is not in the tenant's account list (${allowedAccountIds.join(', ') || 'none'}). /approve will reject it.`,
      });
    }

    // ── Status ────────────────────────────────────────────────────────────
    if (campaign.status !== 'pending_approval') {
      blockers.push({
        code: 'not_pending_approval',
        message: `Campaign status is "${campaign.status}" — only pending_approval campaigns can be approved.`,
      });
    }
    if (campaign.metaCampaignId) {
      blockers.push({
        code: 'already_launched',
        message: `Already launched on Meta as ${campaign.metaCampaignId}.`,
      });
    }

    // ── Budget ────────────────────────────────────────────────────────────
    const dailyBudget = campaign.budget ?? config.budget ?? 0;
    const weeklySpend = await this.campaignsService.getWeeklySpend(tenantId);
    const projectedWeekly = dailyBudget * 7;
    const weeklyCap = (company as any).weeklyBudgetCap ?? 0;
    const maxPerCampaign = (company as any).maxBudgetPerCampaign ?? 0;
    if (maxPerCampaign && dailyBudget > maxPerCampaign) {
      blockers.push({
        code: 'over_campaign_cap',
        message: `Daily budget ₹${dailyBudget} exceeds the per-campaign cap of ₹${maxPerCampaign}.`,
      });
    }
    if (weeklyCap && weeklySpend + projectedWeekly > weeklyCap) {
      blockers.push({
        code: 'over_weekly_cap',
        message: `₹${weeklySpend} already committed this week + ₹${projectedWeekly} projected (₹${dailyBudget}/day × 7) exceeds the ₹${weeklyCap} weekly cap.`,
      });
    }

    // ── Ad sets: resolved, in the shape they'll hit Meta ───────────────────
    // Audience IDs are opaque numbers on the campaign; look their names up
    // across every product so the operator reads "Purchasers 180d", not
    // "120212...". Includes/excludes both.
    const audienceNames = new Map<string, string>();
    for (const p of (company.products ?? []) as Product[]) {
      for (const a of (p.metaAudiences ?? []) as any[]) {
        if (a?.id) audienceNames.set(String(a.id), a.name ?? String(a.id));
      }
    }
    const nameAudience = (id?: string) =>
      id
        ? { id, name: audienceNames.get(String(id)) ?? '(name not on file)' }
        : null;

    const totalPercent = configAdSets.reduce(
      (sum, a) => sum + (a.budgetPercent ?? 0),
      0,
    );
    if (configAdSets.length === 0) {
      blockers.push({
        code: 'no_ad_sets',
        message: 'Campaign has no ad sets configured.',
      });
    } else if (Math.abs(totalPercent - 100) > 1) {
      warnings.push({
        code: 'budget_split_not_100',
        message: `Ad set budget split adds up to ${totalPercent}%, not 100% — the daily amounts below reflect what will actually be sent.`,
      });
    }

    const adSets = configAdSets.map((as: any, i: number) => {
      // Same precedence launch() uses: a per-ad-set override (landing-page
      // tests) beats the campaign-wide product URL. UTM params are appended
      // per ad at launch, so this is the base URL.
      const destination = as.landingUrlOverride || (product?.landingUrl ?? '');
      if (!destination) {
        blockers.push({
          code: 'ad_set_no_destination',
          message: `Ad set "${as.name ?? `#${i}`}" has no destination URL.`,
        });
      }

      const variantIndices: number[] = Array.isArray(as.ads) ? as.ads : [];
      for (const idx of variantIndices) {
        if (!copyVariants[idx]) {
          blockers.push({
            code: 'ad_set_missing_variant',
            message: `Ad set "${as.name ?? `#${i}`}" references copy variant ${idx}, which does not exist (package has ${copyVariants.length}).`,
          });
        }
      }
      if (variantIndices.length === 0) {
        blockers.push({
          code: 'ad_set_no_ads',
          message: `Ad set "${as.name ?? `#${i}`}" has no ads configured.`,
        });
      }
      if (
        (as.creativeFormat === 'video' || as.creativeFormat === 'both') &&
        videos.length === 0
      ) {
        warnings.push({
          code: 'video_missing',
          message: `Ad set "${as.name ?? `#${i}`}" asks for video but the package has none — launch will fall back to image.`,
        });
      }

      return {
        name: as.name ?? `Ad set ${i + 1}`,
        budgetPercent: as.budgetPercent ?? 0,
        dailyBudget: Math.round(dailyBudget * ((as.budgetPercent ?? 0) / 100)),
        audienceType: as.audienceType ?? 'advantage_plus',
        customAudience: nameAudience(as.metaAudienceId),
        excludedAudiences: (as.excludeAudienceIds ?? []).map((id: string) =>
          nameAudience(id),
        ),
        ageMin: as.ageMin ?? null,
        ageMax: as.ageMax ?? null,
        gender: as.gender ?? 'all',
        geoLocations: as.geoLocations ?? [],
        // Region/city keys suppress the country layer at launch (createAdSet
        // drops geo_locations.countries when either is set — Meta rejects the
        // overlap). Surfaced separately so the approval screen shows the geo
        // that will ACTUALLY ship, not the country that gets discarded.
        geoStates: as.geoStates ?? [],
        geoCities: as.geoCities ?? [],
        effectiveGeoLayer:
          (as.geoCities?.length ?? 0) > 0
            ? 'cities'
            : (as.geoStates?.length ?? 0) > 0
              ? 'regions'
              : 'countries',
        locales: as.locales ?? [],
        interestIds: as.interests ?? [],
        optimizationGoal: as.optimizationGoal ?? '',
        creativeFormat: as.creativeFormat ?? 'image',
        copyVariantIndices: variantIndices,
        /** The exact page traffic lands on (UTM params appended per ad). */
        destinationUrl: destination,
      };
    });

    // The optimization goal the operator's product choice will actually force —
    // launch() overrides the stored per-ad-set goal when the product sets one.
    if (product?.metaOptimizationGoal) {
      const overridden = configAdSets.filter(
        (as: any) => as.optimizationGoal !== product.metaOptimizationGoal,
      );
      if (overridden.length > 0) {
        warnings.push({
          code: 'optimization_goal_overridden',
          message: `Product "${product.name}" forces optimizationGoal=${product.metaOptimizationGoal}; ${overridden.length} ad set(s) storing a different goal will be overridden at launch.`,
        });
      }
    }

    // Advantage+ ships custom audiences and interests as SUGGESTIONS
    // (advantage_audience=1), so delivery goes well outside them. An operator
    // who picked a retargeting audience here almost certainly expected it to
    // confine spend — it doesn't, and the money is gone before that's visible
    // in the metrics. Warn at the one moment it's still cheap to change.
    const seededAdvantagePlus = configAdSets.filter(
      (as: any) => as.audienceType === 'advantage_plus' && as.metaAudienceId,
    );
    if (seededAdvantagePlus.length > 0) {
      warnings.push({
        code: 'advantage_plus_audience_is_a_suggestion',
        message: `${seededAdvantagePlus.length} Advantage+ ad set(s) include a custom audience. Advantage+ treats it as a seed, not a filter — Meta will deliver to people outside it.`,
        fix: 'If this is meant to be retargeting, rebuild as a Custom Targeting campaign with audience source "Retarget" — that sets advantage_audience=0 and actually confines delivery.',
      });
    }

    if (product?.customConversionId) {
      warnings.push({
        code: 'custom_conversion_account_scoped',
        message: `Optimizing toward Custom Conversion ${product.customConversionId}. Custom conversions are ad-account-scoped — launch verifies it exists on the chosen account and falls back to plain pixel+event tracking if not.`,
      });
    }
    if (!product?.pixelId && !company.meta?.pixelId) {
      blockers.push({
        code: 'no_pixel',
        message:
          'Neither the product nor the company has a Pixel ID — conversion optimization cannot be configured.',
      });
    }

    const grossValue = getGrossConversionValue(product as any);
    const netValue = getEffectiveConversionValue(product as any);
    const margin = product?.contributionMargin;

    return {
      ready: blockers.length === 0,
      blockers,
      warnings,

      campaign: {
        id: String((campaign as any)._id),
        /** Name stored in our DB. */
        name: campaign.name,
        /** Name Meta will actually create — same helper launch() uses. */
        metaCampaignName: buildMetaCampaignName(campaign as any),
        status: campaign.status,
        source: campaign.source,
        objective: config.objective ?? campaign.objective,
        dailyBudget,
        projectedWeeklySpend: projectedWeekly,
        spendCap: (campaign as any).spendCap ?? 0,
        stopTime: (campaign as any).stopTime ?? null,
        intendedAccountId,
        allowedAccountIds,
        isLandingPageTest,
        briefId: campaign.briefId || null,
        creativePackageId: campaign.creativePackageId || null,
        createdAt: (campaign as any).createdAt ?? null,
        reviewNotes: (campaign as any).reviewNotes ?? '',
      },

      // What the ads sell, and everything derived from that choice. This block
      // is the answer to "is this campaign pointing at the right thing?".
      product: product
        ? {
            name: product.name,
            /** 'campaign' = recorded explicitly; anything else was inferred. */
            resolvedVia: resolution!.source,
            landingUrl: product.landingUrl ?? '',
            price: product.price ?? null,
            currency: product.currency ?? 'INR',
            conversionValueGross: grossValue,
            conversionValueNet: netValue,
            refundRatePercent: (product as any).refundRatePercent ?? 0,
            contributionMargin: margin ?? null,
            breakevenROAS: margin ? Number((1 / margin).toFixed(2)) : null,
            conversionTracking: product.customConversionId
              ? { type: 'custom_conversion', id: product.customConversionId }
              : (product as any).customEventName
                ? {
                    type: 'custom_event',
                    name: (product as any).customEventName,
                  }
                : {
                    type: 'standard_event',
                    event: product.conversionEvent || 'Purchase',
                  },
            pixelId: (product as any).pixelId || company.meta?.pixelId || '',
            pixelSource: (product as any).pixelId
              ? 'product'
              : 'company_default',
            metaOptimizationGoal: (product as any).metaOptimizationGoal ?? null,
            languages: product.languages ?? [],
          }
        : null,

      adSets,

      creative: {
        packageId: campaign.creativePackageId || null,
        status: pkg?.status ?? null,
        copyVariants: copyVariants.map((v: any, i: number) => ({
          index: i,
          hookStyle: v.hookStyle ?? '',
          primaryText: v.primaryText ?? '',
          headline: v.headline ?? '',
          description: v.description ?? '',
          cta: v.cta ?? '',
        })),
        images: images.map((im: any) => ({
          variantIndex: im.variantIndex,
          aspectRatio: im.aspectRatio ?? null,
          imageUrl: im.imageUrl ?? '',
          rejected: !!im.rejected,
        })),
        videos: videos.map((v: any) => ({
          variantIndex: v.variantIndex ?? 0,
          aspectRatio: v.aspectRatio ?? null,
          videoUrl: v.videoUrl ?? '',
        })),
        carouselCards: carouselCards.map((c: any, i: number) => ({
          index: i,
          headline: c.headline ?? '',
          description: c.description ?? '',
          imageUrl: c.imageUrl ?? '',
          link: c.cardLink ?? product?.landingUrl ?? '',
        })),
      },

      budgetContext: {
        weeklyAlreadyCommitted: weeklySpend,
        weeklyCap,
        weeklyRemaining: weeklyCap
          ? Math.max(0, weeklyCap - weeklySpend - projectedWeekly)
          : null,
        maxBudgetPerCampaign: maxPerCampaign,
      },
    };
  }
}
