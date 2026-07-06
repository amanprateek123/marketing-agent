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
  /** Required when audienceType is 'interest' — real Meta interest IDs (via the search endpoint), not keywords. */
  interests?: Array<{ id: string; name: string }>;
  optimizationGoal?: string;
  creativeFormat?: 'video' | 'image' | 'both' | 'mixed';
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
}

export interface ManualCreativeVideo {
  variantIndex: number;
  videoUrl: string;
  videoThumbnailUrl?: string;
}

export interface CreateManualCampaignDto {
  name: string;
  /** Which of the tenant's products this campaign is for — resolves conversion event/value. Defaults to the first active product. */
  productName?: string;
  campaignType: 'advantage_plus' | 'custom';
  /** Daily budget, ₹. */
  budget: number;
  objective?: string;
  adSets: ManualAdSetInput[];
  creative: {
    copyVariants: ManualCopyVariant[];
    images?: ManualCreativeImage[];
    video?: ManualCreativeVideo | null;
  };
}
