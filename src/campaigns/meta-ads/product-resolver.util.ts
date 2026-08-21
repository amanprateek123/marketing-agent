import { Model } from 'mongoose';
import { CampaignDocument } from '../schemas/campaign.schema';
import { IntelligenceBriefDocument } from '../../pipeline/schemas/intelligence-brief.schema';

/**
 * Batch-resolve each Meta campaign's product. Resolution order is deliberate:
 *
 *   1. Campaign.productName — authoritative choice persisted at creation.
 *   2. IntelligenceBrief.product — legacy agent campaigns predate productName.
 *   3. Caller-supplied detected product — e.g. historical Meta import using
 *      promoted_object/custom-conversion metadata.
 *   4. A unique, whole-phrase product-name match in the campaign name.
 *   5. The active product only when exactly one product is active.
 *
 * Done once per sync pass across all campaigns instead of once per campaign,
 * so a large-account sync doesn't turn into an N+1 brief lookup.
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
  detectedProductNameByCampaignId?: ReadonlyMap<string, string>,
): Promise<(metaCampaignId: string) => any | undefined> {
  const productList = products ?? [];
  const activeProducts = productList.filter((p: any) => p.active);
  const soleActiveProduct =
    activeProducts.length === 1 ? activeProducts[0] : undefined;
  const normalizeName = (name: string | undefined): string =>
    String(name ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const findProduct = (name: string | undefined): any | undefined => {
    const normalized = normalizeName(name);
    if (!normalized) return undefined;
    return productList.find(
      (product: any) => normalizeName(product?.name) === normalized,
    );
  };
  const findUniqueNameMatch = (
    campaignName: string | undefined,
  ): any | undefined => {
    const normalizedCampaign = normalizeName(campaignName);
    if (!normalizedCampaign) return undefined;
    const paddedCampaign = ` ${normalizedCampaign} `;
    const matches = productList.filter((product: any) => {
      const normalizedProduct = normalizeName(product?.name);
      return (
        normalizedProduct.length >= 3 &&
        paddedCampaign.includes(` ${normalizedProduct} `)
      );
    });
    return matches.length === 1 ? matches[0] : undefined;
  };
  if (metaCampaignIds.length === 0) {
    return () => soleActiveProduct;
  }

  const existingDocs = await campaignModel
    .find({ tenantId, metaCampaignId: { $in: metaCampaignIds } })
    .select('metaCampaignId briefId productName name')
    .lean()
    .exec();
  const briefIdByCampaign = new Map<string, string>();
  const explicitProductNameByCampaign = new Map<string, string>();
  const campaignNameByCampaign = new Map<string, string>();
  for (const d of existingDocs) {
    const briefId = (d as any).briefId;
    const metaCampaignId = (d as any).metaCampaignId;
    if (briefId && metaCampaignId)
      briefIdByCampaign.set(metaCampaignId, briefId);
    const productName = String((d as any).productName ?? '').trim();
    if (productName && metaCampaignId)
      explicitProductNameByCampaign.set(metaCampaignId, productName);
    const campaignName = String((d as any).name ?? '').trim();
    if (campaignName && metaCampaignId)
      campaignNameByCampaign.set(metaCampaignId, campaignName);
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
    const explicitProduct = findProduct(
      explicitProductNameByCampaign.get(metaCampaignId),
    );
    const briefId = briefIdByCampaign.get(metaCampaignId);
    const briefProduct = findProduct(
      briefId ? productNameByBriefId.get(briefId) : undefined,
    );
    const detectedProduct = findProduct(
      detectedProductNameByCampaignId?.get(metaCampaignId),
    );
    const campaignNameProduct = findUniqueNameMatch(
      campaignNameByCampaign.get(metaCampaignId),
    );
    return (
      explicitProduct ??
      briefProduct ??
      detectedProduct ??
      campaignNameProduct ??
      soleActiveProduct
    );
  };
}
