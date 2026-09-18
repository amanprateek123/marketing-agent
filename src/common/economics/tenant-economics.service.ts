import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Company } from '../../companies/schemas/company.schema';
import {
  Economics,
  GENERIC_MARGIN,
  deriveEconomics,
} from './economics';

/**
 * How the tenant's margin was determined. Surfaced to the UI because a
 * breakeven derived from a generic 40% default is a guess, and any verdict
 * built on it deserves a visible caveat rather than the same confident
 * green/red chip as a configured one.
 */
export type EconomicsMethod = 'product-config' | 'generic-default';

export interface ProductEconomics extends Economics {
  productName: string | null;
  method: EconomicsMethod;
  /** Human-readable derivation trail for the "how do you know?" tooltip. */
  notes: string[];
}

export interface TenantEconomics extends ProductEconomics {
  /**
   * Per-product economics, keyed by configured product name.
   *
   * A tenant's products can have wildly different margins — this account runs
   * a 97%-margin digital report (breakeven 1.03x) alongside a 45%-margin
   * reading (breakeven 2.22x). Judging both against one number is not a
   * rounding error: it reports a 2.03x campaign on the 45% product as
   * comfortably profitable when it is in fact below its own breakeven.
   * Callers that can attribute a campaign to a product MUST use `forProduct`.
   */
  byProduct: Record<string, ProductEconomics>;
  /** True when products disagree enough that one headline breakeven misleads. */
  hasMixedMargins: boolean;
}

/**
 * Resolves a tenant's unit economics once, for the whole account.
 *
 * The per-campaign RevenueEngine already does this inside its decision-context
 * slice, but that path only exists for campaigns that have been through an
 * intelligence cycle. Account-level surfaces (the dashboard rollup, the budget
 * validator) need the same numbers without a campaign in hand.
 */
@Injectable()
export class TenantEconomicsService {
  private readonly logger = new Logger(TenantEconomicsService.name);

  constructor(
    @InjectModel(Company.name)
    private readonly companyModel: Model<Company>,
  ) {}

  async forTenant(tenantId: string): Promise<TenantEconomics> {
    const products = await this.loadProducts(tenantId);

    if (!products.length) {
      return { ...this.genericFallback(), byProduct: {}, hasMixedMargins: false };
    }

    const byProduct: Record<string, ProductEconomics> = {};
    for (const p of products) byProduct[p.name] = this.deriveForProduct(p);

    // Headline economics come from the active product — the one most spend is
    // presumed to sit behind. Per-campaign judgements use byProduct instead.
    const primarySource = products.find((p) => p.active) ?? products[0];
    const primary = byProduct[primarySource.name];

    const breakevens = Object.values(byProduct).map((e) => e.breakevenROAS);
    const hasMixedMargins =
      breakevens.length > 1 &&
      Math.max(...breakevens) - Math.min(...breakevens) > 0.1;

    const notes = [...primary.notes];
    if (hasMixedMargins) {
      const spread = Object.values(byProduct)
        .map((e) => `${e.productName} ${e.breakevenROAS.toFixed(2)}x`)
        .join(', ');
      notes.push(
        `Products have different margins, so breakeven differs per product (${spread}). ` +
          `Campaign verdicts use each campaign's own product; this headline uses "${primary.productName}".`,
      );
    }

    return { ...primary, notes, byProduct, hasMixedMargins };
  }

  /**
   * Economics for one product by name, falling back to the tenant headline
   * when a campaign could not be attributed to a configured product.
   */
  forProduct(
    econ: TenantEconomics,
    productName: string | null | undefined,
  ): ProductEconomics {
    if (!productName) return econ;
    return econ.byProduct[productName] ?? econ;
  }

  private deriveForProduct(p: LoadedProduct): ProductEconomics {
    const hasMargin =
      p.contributionMargin != null && Number.isFinite(p.contributionMargin);
    const refundPct = (p.refundRatePercent ?? 0) / 100;
    const econ = deriveEconomics({
      marginPct: hasMargin ? p.contributionMargin : GENERIC_MARGIN,
      refundPct,
    });

    const notes: string[] = [];
    if (hasMargin) {
      notes.push(
        `Contribution margin ${(econ.marginPct * 100).toFixed(0)}% from product "${p.name}".`,
      );
    } else {
      notes.push(
        `Product "${p.name}" has no contributionMargin set — assuming ${(GENERIC_MARGIN * 100).toFixed(0)}%.`,
      );
    }
    if (econ.refundPct > 0) {
      notes.push(
        `Refund rate ${(econ.refundPct * 100).toFixed(0)}% applied — net margin ${(econ.netMarginPct * 100).toFixed(0)}%.`,
      );
    }
    notes.push(
      `Breakeven ROAS ${econ.breakevenROAS.toFixed(2)}x (1 / ${(econ.netMarginPct * 100).toFixed(0)}%). Target ${econ.targetROAS.toFixed(2)}x.`,
    );

    return {
      ...econ,
      productName: p.name,
      method: hasMargin ? 'product-config' : 'generic-default',
      notes,
    };
  }

  private genericFallback(): ProductEconomics {
    return {
      ...deriveEconomics({ marginPct: GENERIC_MARGIN, refundPct: 0 }),
      productName: null,
      method: 'generic-default',
      notes: [
        `No product config found for this tenant — assuming a generic ${(GENERIC_MARGIN * 100).toFixed(0)}% contribution margin.`,
        "Set the product's contributionMargin in Settings to get an accurate breakeven.",
      ],
    };
  }

  private async loadProducts(tenantId: string): Promise<LoadedProduct[]> {
    try {
      const company = await this.companyModel
        .findOne({ tenantId })
        .lean()
        .exec();
      if (!company) return [];
      const raw = ((company as unknown as {
        products?: Array<Record<string, unknown>>;
      }).products ?? []) as Array<Record<string, unknown>>;
      return raw
        .filter((p) => p && p.name)
        .map((p) => ({
          name: String(p.name),
          active: p.active !== false,
          contributionMargin: numOrUndef(p.contributionMargin),
          refundRatePercent: numOrUndef(p.refundRatePercent),
          conversionValue: numOrUndef(p.conversionValue),
        }));
    } catch (err: any) {
      this.logger.warn(
        `Could not resolve economics for ${tenantId}: ${err.message}`,
      );
      return [];
    }
  }
}

interface LoadedProduct {
  name: string;
  active: boolean;
  contributionMargin?: number;
  refundRatePercent?: number;
  conversionValue?: number;
}

function numOrUndef(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
