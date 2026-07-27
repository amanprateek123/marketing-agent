/** Request shape for the dashboard's manual Create Campaign form. */

export interface ManualAdSetInput {
  name: string;
  /** Ignored (forced 100) when this is the only ad set, or campaignType is advantage_plus. */
  budgetPercent: number;
  audienceType:
    | 'advantage_plus'
    | 'lookalike'
    | 'retarget'
    | 'custom'
    | 'interest';
  /** Required when audienceType is lookalike/retarget/custom. */
  metaAudienceId?: string;
  excludeAudienceIds?: string[];
  ageMin?: number;
  ageMax?: number;
  gender?: 'male' | 'female' | 'all';
  /** ISO country codes, e.g. ['IN']. */
  geoLocations?: string[];
  /** Meta locale IDs (e.g. 84 = Marathi, 53 = Hindi) — filters delivery to users whose platform language matches. */
  locales?: number[];
  /** Required when audienceType is 'interest' — real Meta interest IDs (via the search endpoint), not keywords. */
  interests?: Array<{ id: string; name: string }>;
  optimizationGoal?: string;
  creativeFormat?: 'video' | 'image' | 'both' | 'mixed';
  /**
   * Which copy-variant indices this ad set should ship as ads — lets a
   * human distribute specific creatives to specific ad sets instead of
   * every ad set carrying the full pool. Omit (or leave empty) to default
   * to every variant, unchanged from prior behavior. Every variant must be
   * covered by at least one ad set across the whole campaign, or campaign
   * creation is rejected — see ManualCampaignService.buildAdSetConfigs.
   */
  ads?: number[];
}

export interface ManualCopyVariant {
  primaryText: string;
  headline: string;
  cta: string;
  hookStyle?: string;
}

export interface ManualCreativeImage {
  /** Index into creative.copyVariants this image pairs with. */
  variantIndex: number;
  imageUrl: string;
  /**
   * '9:16' | '1:1' | '4:5' | '16:9' — which size this is. Omit for a
   * variant with only one image (unchanged behavior). Give the SAME
   * variantIndex a second entry with a different aspectRatio to supply a
   * human creative team's pre-made sizes — launch() then uses Meta's
   * placement asset customization (Stories/Reels get the 9:16, everything
   * else gets the other) instead of auto-cropping one image.
   */
  aspectRatio?: string;
}

export interface ManualCreativeVideo {
  variantIndex: number;
  videoUrl: string;
  videoThumbnailUrl?: string;
  /**
   * '9:16' | '1:1' | '4:5' | '16:9' — which size this is. Only meaningful
   * when passed via `creative.videos` (plural) alongside sibling entries at
   * other aspect ratios; ignored (harmless) on the singular `creative.video`.
   */
  aspectRatio?: string;
}

export interface CreateManualCampaignDto {
  name: string;
  /** Which of the tenant's products this campaign is for — resolves conversion event/value. Defaults to the first active product. */
  productName?: string;
  /**
   * Which Meta ad account this campaign is being built for — audiences
   * (metaAudienceId on ad sets) are account-scoped Meta objects, so the
   * account picked here determines which audience list the Create Campaign
   * form fetches. Stored on the campaign as metaAccountId so the Approve
   * screen defaults to this SAME account instead of an arbitrary first one,
   * keeping the audiences chosen here valid at launch time. Falls back to
   * company.meta.accountId when omitted.
   */
  accountId?: string;
  campaignType: 'advantage_plus' | 'custom';
  /** Daily budget, ₹. */
  budget: number;
  objective?: string;
  adSets: ManualAdSetInput[];
  /**
   * Exactly one of `creative` or `creativePackageId` must be set.
   *   - `creative`: paste image/video URLs directly — builds a new,
   *     single-use CreativePackage (briefId='manual').
   *   - `creativePackageId`: reuse an existing, already-produced
   *     CreativePackage from the creative library instead.
   */
  creative?: {
    copyVariants: ManualCopyVariant[];
    images?: ManualCreativeImage[];
    video?: ManualCreativeVideo | null;
    /**
     * Additive to `video` — give a human creative team's multiple pre-made
     * sizes of the same video (each tagged with aspectRatio) instead of one.
     * When set, this takes priority over `video` entirely (don't set both).
     */
    videos?: ManualCreativeVideo[];
  };
  creativePackageId?: string;
}

/**
 * Request shape for editing a pending campaign's structure/targeting/budget.
 * Only valid while the campaign is still `pending_approval` with no
 * metaCampaignId — once launch() has created real Meta objects, changes go
 * through the live ad-set/budget levers instead (see campaigns.controller.ts).
 * All fields optional — omit anything unchanged; unset fields fall back to
 * the campaign's current values. Creative content itself (copy text, image,
 * video) is edited separately via
 * `PATCH /creative/:tenantId/packages/:creativePackageId`, not here.
 */
export interface UpdateManualCampaignConfigDto {
  name?: string;
  /**
   * Reassign the campaign to a different product. Re-resolves conversion
   * event/value from the new product and rewrites campaign.productName — which
   * is what launch() reads for the landing URL, pixel and custom conversion.
   * Also the repair path for pre-productName campaigns: set it once and the
   * launch-time refusal to guess goes away.
   */
  productName?: string;
  accountId?: string;
  campaignType?: 'advantage_plus' | 'custom';
  /** Daily budget, ₹. */
  budget?: number;
  objective?: string;
  adSets?: ManualAdSetInput[];
}
