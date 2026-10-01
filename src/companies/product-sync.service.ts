import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Company, CompanyDocument } from './schemas/company.schema';
import { MetaAdsService } from '../campaigns/meta-ads/meta-ads.service';
import { PipelineBridgeService } from '../pipeline-bridge/pipeline-bridge.service';
import { McpClient } from '../foundry-bridge/mcp.client';

/**
 * The platform's product list is the source of each product's Facebook Page, pixel and purchase
 * conversion. This carries it to the Brain, which builds every campaign:
 *
 *   1. LINK each platform product (keyed by name) to a Brain product (keyed by slug) — the slug
 *      saved on the product, else an exact name match. A partial match is reported, never guessed.
 *   2. REGISTER a product the Brain does not have yet (it needs a landing page): creativebot gets its
 *      research pack, the Brain gets its offering row.
 *   3. RECORD its Meta ids as product-scope rows on the Brain: Page (+ the Instagram account
 *      connected to that Page), pixel and conversion — only what the product sets itself and only
 *      what changed. The company's Page/pixel are the account default, exactly the platform's own
 *      rule (`product.pageId ?? company.meta.pageId`).
 *
 * The Brain's daily validator then keeps every recorded id verified against Meta.
 * Never throws into a save: everything it could not do is returned (and logged).
 */

export interface BrainOffering {
  slug: string;
  display_name?: string | null;
}

export interface ProductLike {
  name?: string;
  active?: boolean;
  offeringSlug?: string;
  pageId?: string;
  pixelId?: string;
  customConversionId?: string;
  landingUrl?: string;
  price?: number;
}

export interface ConfigWrite {
  key: 'page_id' | 'instagram_actor_id' | 'pixel_id' | 'custom_conversion_id';
  value: string;
  offering_slug: string | null;
}

export interface ProductSyncResult {
  tenantId: string;
  skipped?: string;
  linked: Array<{
    product: string;
    slug: string;
    how: string;
    recorded: string[];
    warnings: string[];
  }>;
  registered: string[];
  unlinked: Array<{ product: string; reason: string }>;
  account: string[];
  errors: string[];
}

const norm = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function slugify(name: string): string {
  return norm(name).replace(/ /g, '_').slice(0, 64);
}

/** Which Brain product a platform product is. Exact only. */
export interface ProductLink {
  slug: string | null;
  how?: 'explicit' | 'name' | 'registered';
  reason?: string;
}

export function linkProduct(
  product: ProductLike,
  offerings: BrainOffering[],
): ProductLink {
  const bySlug = new Map(offerings.map((o) => [o.slug, o]));
  if (product.offeringSlug) {
    if (bySlug.has(product.offeringSlug))
      return { slug: product.offeringSlug, how: 'explicit' };
    return {
      slug: null,
      reason: `its linked Brain product "${product.offeringSlug}" no longer exists`,
    };
  }
  const want = norm(product.name);
  const hits = offerings.filter(
    (o) => norm(o.slug) === want || norm(o.display_name) === want,
  );
  const unique = [...new Set(hits.map((o) => o.slug))];
  if (unique.length === 1) return { slug: unique[0], how: 'name' };
  if (unique.length > 1)
    return {
      slug: null,
      reason: `matches several Brain products (${unique.join(', ')})`,
    };
  return {
    slug: null,
    reason:
      'no Brain product has this name (add a landing page to register it, or pick one)',
  };
}

/** The product-scope rows to write: only what the product sets itself, only what changed. */
export function plannedWrites(
  product: ProductLike,
  _company: { meta?: { pageId?: string; pixelId?: string } },
  slug: string,
  current: { resolved?: Record<string, { value?: string; scope?: string }> },
  instagramId: string | null,
): ConfigWrite[] {
  const want: Array<[ConfigWrite['key'], string | undefined | null]> = [
    ['page_id', product.pageId],
    ['instagram_actor_id', product.pageId ? instagramId : null],
    ['pixel_id', product.pixelId],
    ['custom_conversion_id', product.customConversionId],
  ];
  const mine = `offering:${slug}`;
  const out: ConfigWrite[] = [];
  for (const [key, value] of want) {
    if (!value) continue;
    const have = current?.resolved?.[key];
    if (have && have.scope === mine && String(have.value) === String(value))
      continue;
    out.push({ key, value: String(value), offering_slug: slug });
  }
  return out;
}

@Injectable()
export class ProductSyncService {
  private readonly logger = new Logger(ProductSyncService.name);
  private readonly brain: Pick<McpClient, 'isConfigured' | 'call'>;

  constructor(
    private readonly config: ConfigService,
    private readonly metaAds: MetaAdsService,
    private readonly pipeline: PipelineBridgeService,
    // Tests hand in a fake; Nest builds the real client from config.
    @Optional() brain?: Pick<McpClient, 'isConfigured' | 'call'>,
    @Optional()
    @InjectModel(Company.name)
    private readonly companyModel?: Model<CompanyDocument>,
  ) {
    this.brain =
      brain ??
      new McpClient(
        (this.config.get<string>('brain.url') ?? '').trim(),
        (this.config.get<string>('brain.token') ?? '').trim(),
        this.config.get<number>('brain.timeoutMs') ?? 30000,
        'brain',
      );
  }

  /** Nightly, so products added outside Settings (e.g. by the Copilot) catch up too. */
  @Cron('30 2 * * *')
  async syncAll(): Promise<void> {
    if (!this.companyModel) return;
    for (const company of await this.companyModel.find().exec()) {
      const r = await this.syncCompany(company);
      this.logger.log(`product sync ${r.tenantId}: ${this.summary(r)}`);
    }
  }

  summary(r: ProductSyncResult): string {
    if (r.skipped) return `skipped (${r.skipped})`;
    return (
      `${r.linked.length} linked, ${r.registered.length} registered, ${r.unlinked.length} not linked` +
      `${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`
    );
  }

  async syncCompany(company: CompanyDocument): Promise<ProductSyncResult> {
    const result: ProductSyncResult = {
      tenantId: (company as any).tenantId,
      linked: [],
      registered: [],
      unlinked: [],
      account: [],
      errors: [],
    };
    if (!this.brain.isConfigured())
      return {
        ...result,
        skipped: 'the Brain is not connected (BRAIN_MCP_URL unset)',
      };

    let offerings: BrainOffering[];
    try {
      const read = await this.brain.call<{ rows?: BrainOffering[] }>(
        'brain_read',
        { table: 'offerings', limit: 1000 },
      );
      offerings = Array.isArray(read?.rows) ? read.rows : [];
    } catch (err) {
      return {
        ...result,
        skipped: `could not read the Brain's products: ${(err as Error).message}`,
      };
    }

    const token: string | undefined = (company as any).meta?.accessToken;
    let changed = false;
    const products: ProductLike[] = ((company as any).products ??
      []) as ProductLike[];

    for (const product of products) {
      const name = String(product?.name ?? '').trim();
      if (!name || product.active === false) continue;
      try {
        let link: ProductLink = linkProduct(product, offerings);

        if (
          !link.slug &&
          !product.offeringSlug &&
          /^https:\/\//i.test(product.landingUrl ?? '')
        ) {
          const slug = slugify(name);
          await this.pipeline.addOffering((company as any).tenantId, {
            landing_url: product.landingUrl!,
            display_name: name,
            slug,
          } as any);
          await this.brain.call('offering_register', {
            slug,
            display_name: name,
            landing_url: product.landingUrl,
            ...(typeof product.price === 'number' && product.price > 0
              ? { price_inr: product.price }
              : {}),
          });
          offerings.push({ slug, display_name: name });
          result.registered.push(slug);
          link = { slug, how: 'registered' };
        }

        if (!link.slug) {
          result.unlinked.push({
            product: name,
            reason: link.reason ?? 'not linked',
          });
          continue;
        }
        const how = link.how ?? 'name';
        const slug = link.slug;
        if (product.offeringSlug !== slug) {
          product.offeringSlug = slug;
          changed = true;
        }

        const warnings: string[] = [];
        let instagramId: string | null = null;
        if (product.pageId && token) {
          try {
            instagramId = await this.metaAds.resolveInstagramIdentity(
              product.pageId,
              token,
            );
          } catch (err) {
            warnings.push(
              `Instagram account for Page ${product.pageId} not found: ${(err as Error).message}`,
            );
          }
        }
        const current = await this.brain.call<any>('ad_account_config_read', {
          offering_slug: slug,
        });
        const writes = plannedWrites(
          product,
          company as any,
          slug,
          current ?? {},
          instagramId,
        );
        const label = await this.pageLabel(product.pageId, token, name);
        for (const w of writes) {
          await this.brain.call('ad_account_config_write', {
            ...w,
            source: 'human',
            label: w.key === 'page_id' ? label : `marketing-agent: ${name}`,
            notes: `From the marketing platform's product "${name}".`,
          });
        }
        result.linked.push({
          product: name,
          slug,
          how,
          recorded: writes.map((w) => w.key),
          warnings,
        });
      } catch (err) {
        result.errors.push(`${name}: ${(err as Error).message}`);
      }
    }

    if (changed) {
      (company as any).markModified('products');
      await (company as any).save();
    }
    if (result.errors.length || result.unlinked.length) {
      this.logger.warn(
        `product sync ${result.tenantId}: ${this.summary(result)} — ` +
          [
            ...result.unlinked.map((u) => `${u.product}: ${u.reason}`),
            ...result.errors,
          ].join('; '),
      );
    }
    return result;
  }

  private async pageLabel(
    pageId: string | undefined,
    token: string | undefined,
    product: string,
  ): Promise<string> {
    if (!pageId || !token) return `marketing-agent: ${product}`;
    try {
      const page = await this.metaAds.getPage(pageId, token);
      return page?.name
        ? `${page.name} (marketing-agent: ${product})`
        : `marketing-agent: ${product}`;
    } catch {
      return `marketing-agent: ${product}`;
    }
  }
}
