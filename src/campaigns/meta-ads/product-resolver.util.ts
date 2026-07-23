import { Model } from 'mongoose';
import { CampaignDocument } from '../schemas/campaign.schema';
import { IntelligenceBriefDocument } from '../../pipeline/schemas/intelligence-brief.schema';

/**
 * Batch-resolve each Meta campaign's product — brief.product name match,
 * else the tenant's first active product — the same fallback
 * campaign-auditor.service.ts applies per-campaign (line ~400-404). Done
 * once per sync pass across all campaigns instead of once per campaign, so a
 * large-account sync doesn't turn into an N+1 brief lookup.
 *
 * Needed because campaign-sync/deep-sync write GROSS revenue whenever Meta's
 * pixel reports real action_values — the refund-rate haircut (getRefundFactor)
 * that nets it down is per-product, so callers need the right product per
 * campaign, not just "the tenant's products".
 */
export async function buildProductResolver(
  campaignModel: Model<CampaignDocument>,
  briefModel: Model<IntelligenceBriefDocument>,
  tenantId: string,
  metaCampaignIds: string[],
  products: any[] | undefined,
): Promise<(metaCampaignId: string) => any | undefined> {
  const defaultActiveProduct = (products ?? []).find((p: any) => p.active);
  if (metaCampaignIds.length === 0) {
    return () => defaultActiveProduct;
  }

  const existingDocs = await campaignModel
    .find({ tenantId, metaCampaignId: { $in: metaCampaignIds } })
    .select('metaCampaignId briefId')
    .lean()
    .exec();
  const briefIdByCampaign = new Map<string, string>();
  for (const d of existingDocs) {
    const briefId = (d as any).briefId;
    const metaCampaignId = (d as any).metaCampaignId;
    if (briefId && metaCampaignId)
      briefIdByCampaign.set(metaCampaignId, briefId);
  }

  const briefIds = [...new Set(briefIdByCampaign.values())];
  const briefs = briefIds.length
    ? await briefModel
        .find({ tenantId, briefId: { $in: briefIds } })
        .select('briefId product')
        .lean()
        .exec()
    : [];
  const productNameByBriefId = new Map<string, string>();
  for (const b of briefs) {
    const product = (b as any).product;
    if (product) productNameByBriefId.set((b as any).briefId, product);
  }

  return (metaCampaignId: string) => {
    const briefId = briefIdByCampaign.get(metaCampaignId);
    const briefProduct = briefId
      ? productNameByBriefId.get(briefId)
      : undefined;
    return (
      (products ?? []).find((p: any) =>
        briefProduct ? p.name === briefProduct : p.active,
      ) ?? defaultActiveProduct
    );
  };
}
