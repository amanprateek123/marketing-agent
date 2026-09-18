import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  ParseIntPipe,
  BadRequestException,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UsageLog } from '../claude/schemas/usage-log.schema';
import { CompaniesService } from './companies.service';
import { PromptGeneratorService } from './prompt-generator/prompt-generator.service';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';
import { MetaAdsService, MetaAdAccountSummary } from '../campaigns/meta-ads/meta-ads.service';
import { CampaignSyncService } from '../campaigns/meta-ads/campaign-sync.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

function normalizeMetaAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('act_') ? trimmed : `act_${trimmed}`;
}

function normalizeMetaCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

/** Keep unselected account evidence while refreshing selected accounts. */
export function mergeMetaAccountCurrencies(
  existing: Record<string, string> | undefined,
  discovered: MetaAdAccountSummary[],
  selectedAccountIds: string[],
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [rawId, rawCurrency] of Object.entries(existing ?? {})) {
    const accountId = normalizeMetaAccountId(rawId);
    const currency = normalizeMetaCurrency(rawCurrency);
    if (accountId && currency) merged[accountId] = currency;
  }

  const selected = new Set(
    selectedAccountIds
      .map(normalizeMetaAccountId)
      .filter((id): id is string => Boolean(id)),
  );
  for (const account of discovered) {
    const accountId = normalizeMetaAccountId(account.id);
    const currency = normalizeMetaCurrency(account.currency);
    if (accountId && selected.has(accountId) && currency) merged[accountId] = currency;
  }
  return merged;
}

@Controller('companies')
export class CompaniesController {
  private readonly logger = new Logger(CompaniesController.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly promptGenerator: PromptGeneratorService,
    private readonly metaLearningImporter: MetaLearningImporterService,
    private readonly metaAdsService: MetaAdsService,
    private readonly campaignSyncService: CampaignSyncService,
    @Inject(forwardRef(() => SchedulerService))
    private readonly schedulerService: SchedulerService,
    @InjectModel(UsageLog.name)
    private readonly usageLogModel: Model<UsageLog>,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateCompanyDto) {
    const company = await this.companiesService.create(dto);

    // Fire and forget — don't block the response
    this.promptGenerator.generate(company.tenantId).catch((err) =>
      this.logger.error(`Prompt generation failed for ${company.tenantId}: ${err.message}`),
    );

    // Schedule all recurring jobs for new tenant
    Promise.all([
      this.schedulerService.scheduleForTenant(company.tenantId, new Date((company as any).createdAt), company.pipelineConfig),
      this.schedulerService.scheduleAuditForTenant(company.tenantId),
      this.schedulerService.scheduleLearningForTenant(company.tenantId),
      this.schedulerService.scheduleCampaignSyncForTenant(company.tenantId),
    ]).catch((err) =>
      this.logger.error(`Job scheduling failed for ${company.tenantId}: ${err.message}`),
    );

    return {
      tenantId: company.tenantId,
      apiKey: company.apiKey,
      message: 'Company created. Generating 9 agent prompts in background.',
    };
  }

  @Get()
  findAll() {
    return this.companiesService.findAll();
  }

  @Get(':tenantId')
  findOne(@Param('tenantId') tenantId: string) {
    return this.companiesService.findByTenantId(tenantId);
  }

  /**
   * GET /api/v1/companies/:tenantId/settings
   * Returns company data organized by dashboard sections.
   */
  @Get(':tenantId/settings')
  async getSettings(@Param('tenantId') tenantId: string) {
    const c = await this.companiesService.findByTenantId(tenantId);
    return {
      info: {
        tenantId: c.tenantId,
        name: c.name,
        industry: c.industry,
        geography: c.geography,
        language: c.language,
      },
      brand: {
        targetAudience: c.targetAudience,
        audiencePersonas: c.audiencePersonas,
        customerLanguage: c.customerLanguage,
        tone: c.tone,
        avoid: c.avoid,
        uniqueValue: c.uniqueValue,
        brandGuidelines: c.brandGuidelines,
      },
      products: c.products,
      services: c.services,
      activePromotions: c.activePromotions,
      competitors: {
        competitors: c.competitors,
        competitorNotes: c.competitorNotes,
        calendarContext: c.calendarContext,
      },
      delivery: c.delivery,
      meta: c.meta,
      budget: {
        weeklyBudgetCap: c.weeklyBudgetCap,
        maxBudgetPerCampaign: c.maxBudgetPerCampaign,
        maxBudgetScalePercent: c.maxBudgetScalePercent,
        primaryObjective: c.primaryObjective,
        targetROAS: c.targetROAS,
        targetCPA: c.targetCPA,
        pauseIfROASBelow: c.pauseIfROASBelow,
        pauseIfCTRBelow: c.pauseIfCTRBelow,
        pauseIfFrequencyAbove: c.pauseIfFrequencyAbove,
        pauseAfterDaysInLearning: c.pauseAfterDaysInLearning,
        scaleIfROASAbove: c.scaleIfROASAbove,
      },
      marketing: {
        platforms: c.platforms,
        preferredFormats: c.preferredFormats,
        forbiddenTopics: c.forbiddenTopics,
        campaignsPerRun: c.campaignsPerRun,
        runFrequency: c.runFrequency,
      },
      pipeline: c.pipelineConfig,
    };
  }

  /**
   * GET /api/v1/companies/:tenantId/meta-accounts
   * Discover ad accounts visible to the tenant's stored Meta access token —
   * for the settings UI to pick which accounts to sync, instead of hand-typing
   * account IDs into company.meta.accountIds. Active only by default; pass
   * ?all=true to include disabled/pending accounts too.
   */
  @Get(':tenantId/meta-accounts')
  async listMetaAccounts(
    @Param('tenantId') tenantId: string,
    @Query('all') all?: string,
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company.meta?.accessToken) {
      throw new BadRequestException('No Meta access token configured for this tenant');
    }

    const accounts = await this.metaAdsService.listAdAccounts(company.meta.accessToken, company.meta.businessId);
    const filtered = all === 'true' ? accounts : accounts.filter((a) => a.status === 'active');
    // Stored accountIds are bare ("123456"); Meta's API always returns the
    // "act_"-prefixed form — normalize both sides or every account reads as
    // not-synced even when it is.
    const normalize = (id: string) => (id.startsWith('act_') ? id : `act_${id}`);
    const activeIds = new Set(
      (company.meta.accountIds ?? [company.meta.accountId]).map(normalize),
    );

    return {
      accounts: filtered.map((a) => ({ ...a, currentlySynced: activeIds.has(a.id) })),
      total: accounts.length,
      active: accounts.filter((a) => a.status === 'active').length,
    };
  }

  /**
   * GET /api/v1/companies/:tenantId/meta-pages
   * Discover Facebook Pages visible to the tenant's stored Meta access token —
   * for the settings UI to pick company.meta.pageId from a real list instead
   * of hand-typing a Page ID. Root-caused a prod incident (2026-07-29): with
   * no picker, pageId was silently set to the wrong Page under the same
   * Business Manager and every ad launched under the wrong brand identity.
   *
   * Also flags which Pages are `promotable` — authorized on THIS tenant's
   * own ad account(s) right now (Meta's promote_pages allowlist) — so the UI
   * can put ready-to-use Pages first instead of drowning them in every Page
   * the whole (often shared/agency) Business Manager happens to own.
   */
  @Get(':tenantId/meta-pages')
  async listMetaPages(@Param('tenantId') tenantId: string) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company.meta?.accessToken) {
      throw new BadRequestException('No Meta access token configured for this tenant');
    }
    const accountIds = company.meta.accountIds?.length
      ? company.meta.accountIds
      : company.meta.accountId
        ? [company.meta.accountId]
        : [];
    const pages = await this.metaAdsService.listPages(company.meta.accessToken, company.meta.businessId, accountIds);
    return {
      pages: pages.map((p) => ({ ...p, currentlySelected: p.id === company.meta?.pageId })),
      total: pages.length,
      accessible: pages.filter((p) => p.accessible).length,
      promotable: pages.filter((p) => p.promotable).length,
    };
  }

  /**
   * GET /api/v1/companies/:tenantId/meta-businesses
   * Lists Business Managers the tenant's Meta access token belongs to — lets
   * the settings UI offer a picker for company.meta.businessId instead of
   * the tenant hunting for it in Meta's own Business Settings pages.
   */
  @Get(':tenantId/meta-businesses')
  async listMetaBusinesses(@Param('tenantId') tenantId: string) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company.meta?.accessToken) {
      throw new BadRequestException('No Meta access token configured for this tenant');
    }
    const businesses = await this.metaAdsService.listBusinesses(company.meta.accessToken);
    return { businesses };
  }

  /**
   * POST /api/v1/companies/:tenantId/meta-accounts/sync
   * Sets which ad accounts CampaignSyncService pulls campaigns from, then
   * kicks off a sync in the background. Body: { accountIds?: string[] } —
   * omit to auto-select every currently-active account from Meta.
   * Fire-and-forget for the same reason as POST /campaigns/:tenantId/sync
   * (multi-minute Meta calls would blow the ALB's 60s timeout).
   */
  @Post(':tenantId/meta-accounts/sync')
  @HttpCode(HttpStatus.ACCEPTED)
  async syncMetaAccounts(
    @Param('tenantId') tenantId: string,
    @Body() body: { accountIds?: string[] },
  ) {
    const company = await this.companiesService.findByTenantId(tenantId);
    if (!company.meta?.accessToken) {
      throw new BadRequestException('No Meta access token configured for this tenant');
    }

    // Stored accountIds must be bare ("123456"), not "act_"-prefixed — see
    // the normalize() comment above. Strip whatever format arrives so this
    // endpoint can't write mixed-format entries into company.meta.accountIds.
    const stripPrefix = (id: string) => (id.startsWith('act_') ? id.slice(4) : id);
    // One account-level discovery response supplies the selected IDs and their
    // authoritative currencies; no per-campaign/ad-set/ad request is added.
    const accounts = await this.metaAdsService.listAdAccounts(company.meta.accessToken, company.meta.businessId);
    let accountIds = body.accountIds?.map(stripPrefix);
    if (!accountIds?.length) {
      accountIds = accounts.filter((a) => a.status === 'active').map((a) => stripPrefix(a.id));
    }
    if (!accountIds.length) {
      throw new BadRequestException('No active Meta ad accounts found for this tenant');
    }

    const { company: updated } = await this.companiesService.update(tenantId, {
      meta: {
        ...company.meta,
        accountId: company.meta.accountId ?? accountIds[0],
        accountIds,
        accountCurrencies: mergeMetaAccountCurrencies(
          company.meta.accountCurrencies,
          accounts,
          accountIds,
        ),
      },
    } as any);

    this.campaignSyncService.syncActiveCampaigns(updated).catch((err: any) => {
      this.logger.error(`Background campaign sync failed for ${tenantId}: ${err.message}`);
    });

    return {
      success: true,
      status: 'started',
      accountIds,
      message: `Syncing campaigns across ${accountIds.length} ad account(s) in the background — poll GET /:tenantId shortly for updated data.`,
    };
  }

  @Put(':tenantId')
  async update(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    const { company, needsPromptRegen } = await this.companiesService.update(tenantId, dto);

    if (needsPromptRegen) {
      // Fire and forget
      this.promptGenerator.generate(tenantId).catch((err) =>
        this.logger.error(`Prompt regeneration failed for ${tenantId}: ${err.message}`),
      );
    }

    return {
      tenantId: company.tenantId,
      promptRegenTriggered: needsPromptRegen,
      message: needsPromptRegen
        ? 'Company updated. Regenerating agent prompts in background.'
        : 'Company updated.',
    };
  }

  /**
   * POST /api/v1/companies/:tenantId/promote-landing-page
   * Operator promotes a landing-page test winner: sets the product's live
   * landingUrl to `url` and clears the test. Body: { product, url }.
   */
  @Post(':tenantId/promote-landing-page')
  async promoteLandingPage(
    @Param('tenantId') tenantId: string,
    @Body() body: { product: string; url: string },
  ) {
    if (!body.product || !body.url) {
      throw new BadRequestException('Both product and url are required.');
    }
    await this.companiesService.promoteLandingPageWinner(tenantId, body.product, body.url);
    return { ok: true, product: body.product, landingUrl: body.url };
  }

  /**
   * POST /api/v1/companies/:tenantId/cancel-landing-page-test
   * Clear a product's landing-page test record (stop tracking it). Does NOT
   * pause the underlying Meta campaign — pause that separately if it's live.
   * Body: { product }.
   */
  @Post(':tenantId/cancel-landing-page-test')
  async cancelLandingPageTest(
    @Param('tenantId') tenantId: string,
    @Body() body: { product: string },
  ) {
    if (!body.product) throw new BadRequestException('product is required.');
    await this.companiesService.setProductLandingPageTest(tenantId, body.product, null);
    return { ok: true, product: body.product };
  }

  @Post(':tenantId/regenerate')
  @HttpCode(HttpStatus.ACCEPTED)
  async regenerate(@Param('tenantId') tenantId: string) {
    // Verify company exists before triggering
    await this.companiesService.findByTenantId(tenantId);

    this.promptGenerator.generate(tenantId).catch((err) =>
      this.logger.error(`Manual prompt regeneration failed for ${tenantId}: ${err.message}`),
    );

    return { tenantId, message: 'Prompt regeneration started.' };
  }

  /**
   * POST /api/v1/companies/:tenantId/prompts/rollback/:version
   * Restore a prior prompts version from history. The target version is
   * cloned forward as a new version (audit-friendly — every change is a
   * forward step, never destructive).
   */
  @Post(':tenantId/prompts/rollback/:version')
  async rollbackPrompts(
    @Param('tenantId') tenantId: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    const newVersion = await this.companiesService.rollbackPromptsToVersion(tenantId, version);
    this.logger.log(`Prompts rolled back: tenantId=${tenantId} target=v${version} → new=v${newVersion}`);
    return {
      tenantId,
      rolledBackTo: version,
      promptsVersion: newVersion,
      message: `Rolled back to v${version} as new v${newVersion}.`,
    };
  }

  /**
   * GET /api/v1/companies/:tenantId/usage?from=ISO&to=ISO
   * Aggregate Claude API spend over a window — by day, by agent, by run.
   * Reads usage_logs collection (each runAgent() call writes a row).
   */
  @Get(':tenantId/usage')
  async getUsage(
    @Param('tenantId') tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    const match = { tenantId, timestamp: { $gte: fromDate, $lte: toDate } };

    const [totals, byDay, byAgent, byRun] = await Promise.all([
      this.usageLogModel.aggregate([
        { $match: match },
        { $group: { _id: null, totalUSD: { $sum: '$costUSD' }, callCount: { $sum: 1 } } },
      ]),
      this.usageLogModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
              agent: '$agent',
            },
            costUSD: { $sum: '$costUSD' },
          },
        },
        {
          $group: {
            _id: '$_id.date',
            costUSD: { $sum: '$costUSD' },
            agentBreakdown: { $push: { k: '$_id.agent', v: '$costUSD' } },
          },
        },
        { $project: { _id: 0, date: '$_id', costUSD: 1, agentBreakdown: { $arrayToObject: '$agentBreakdown' } } },
        { $sort: { date: 1 } },
      ]),
      this.usageLogModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$agent',
            callCount: { $sum: 1 },
            totalUSD: { $sum: '$costUSD' },
            avgUSD: { $avg: '$costUSD' },
            inputTokens: { $sum: '$inputTokens' },
            outputTokens: { $sum: '$outputTokens' },
          },
        },
        { $project: { _id: 0, agentType: '$_id', callCount: 1, totalUSD: 1, avgUSD: 1, inputTokens: 1, outputTokens: 1 } },
        { $sort: { totalUSD: -1 } },
      ]),
      this.usageLogModel.aggregate([
        { $match: { ...match, runId: { $ne: null, $exists: true } } },
        {
          $group: {
            _id: '$runId',
            startedAt: { $min: '$timestamp' },
            totalUSD: { $sum: '$costUSD' },
            callCount: { $sum: 1 },
          },
        },
        { $project: { _id: 0, runId: '$_id', startedAt: 1, totalUSD: 1, callCount: 1 } },
        { $sort: { startedAt: -1 } },
        { $limit: 100 },
      ]),
    ]);

    return {
      tenantId,
      window: { from: fromDate, to: toDate },
      totalUSD: totals[0]?.totalUSD ?? 0,
      callCount: totals[0]?.callCount ?? 0,
      byDay,
      byAgent,
      byRun,
    };
  }

  /**
   * GET /api/v1/companies/:tenantId/case-studies
   * Returns campaign case studies for the learnings page.
   */
  @Get(':tenantId/case-studies')
  async getCaseStudies(@Param('tenantId') tenantId: string) {
    return this.metaLearningImporter.getRelevantCaseStudies(tenantId, { limit: 50 });
  }

  /**
   * POST /api/v1/companies/:tenantId/import-learnings
   * Starts a queue-based import of historical campaign data from Meta.
   * Returns immediately with importId — poll /import-status for progress.
   */
  @Post(':tenantId/import-learnings')
  async importLearnings(@Param('tenantId') tenantId: string) {
    const company = await this.companiesService.findByTenantId(tenantId);

    if (!company.meta?.accessToken || !company.meta?.accountId) {
      return { error: 'Meta credentials not configured. Set company.meta.accessToken and accountId first.' };
    }

    this.logger.log(`Starting Meta learning import for ${tenantId}`);

    const result = await this.metaLearningImporter.startImport(company);

    return {
      tenantId,
      importId: result.importId,
      totalCampaigns: result.totalCampaigns,
      totalBatches: result.totalBatches,
      message: result.totalCampaigns > 0
        ? `Import started: ${result.totalCampaigns} campaigns in ${result.totalBatches} batches. Poll /import-status for progress.`
        : 'No campaigns with spend > ₹500 found.',
    };
  }

  /**
   * POST /api/v1/companies/:tenantId/finalize-import
   * Re-runs finalize on the latest import without re-enriching — useful after code fixes.
   */
  @Post(':tenantId/finalize-import')
  async finalizeImport(@Param('tenantId') tenantId: string) {
    const latest = await this.metaLearningImporter.getImportStatus(tenantId);
    if (!latest || latest.status === 'none') {
      return { error: 'No import found for this tenant' };
    }
    await this.metaLearningImporter.finalizeImport(latest.importId);
    return { success: true, importId: latest.importId };
  }

  /**
   * POST /api/v1/companies/:tenantId/import-creative-learnings
   * Fetches ad copy directly from Meta API and runs Claude copy pattern analysis.
   * Updates ctaInsights, copyToneInsights, visualInsights without a full import.
   */
  @Post(':tenantId/import-creative-learnings')
  async importCreativeLearnings(@Param('tenantId') tenantId: string) {
    const company = await this.companiesService.findByTenantId(tenantId);
    const result = await this.metaLearningImporter.runCopyPatternAnalysis(company);
    return { success: true, ...result, message: `Copy pattern insights updated from ${result.adsAnalyzed} ads` };
  }

  /**
   * GET /api/v1/companies/:tenantId/import-status
   * Returns the current status of the Meta learning import.
   */
  @Get(':tenantId/import-status')
  async getImportStatus(@Param('tenantId') tenantId: string) {
    return this.metaLearningImporter.getImportStatus(tenantId);
  }

  /**
   * PUT /api/v1/companies/:tenantId/budget
   * Update budget settings from the dashboard.
   * Body: { weeklyBudgetCap, maxBudgetPerCampaign, maxBudgetScalePercent }
   */
  @Put(':tenantId/budget')
  async updateBudgetSettings(
    @Param('tenantId') tenantId: string,
    @Body() body: {
      weeklyBudgetCap?: number;
      maxBudgetPerCampaign?: number;
      maxBudgetScalePercent?: number;
      targetROAS?: number;
      targetCPA?: number;
      pauseIfROASBelow?: number;
      pauseIfCTRBelow?: number;
      pauseIfFrequencyAbove?: number;
      scaleIfROASAbove?: number;
    },
  ) {
    const company = await this.companiesService.update(tenantId, body);
    return {
      tenantId,
      weeklyBudgetCap: company.company.weeklyBudgetCap,
      maxBudgetPerCampaign: company.company.maxBudgetPerCampaign,
      maxBudgetScalePercent: company.company.maxBudgetScalePercent,
      message: 'Budget settings updated.',
    };
  }

  /**
   * PUT /api/v1/companies/:tenantId/products
   * Replace the full products array from the dashboard.
   * Body: { products: [...] }
   */
  @Put(':tenantId/products')
  async updateProducts(
    @Param('tenantId') tenantId: string,
    @Body() body: { products: any[] },
  ) {
    const { company, needsPromptRegen } = await this.companiesService.update(tenantId, { products: body.products });

    if (needsPromptRegen) {
      this.promptGenerator.generate(tenantId).catch((err) =>
        this.logger.error(`Prompt regeneration failed for ${tenantId}: ${err.message}`),
      );
    }

    return {
      tenantId,
      products: company.products,
      promptRegenTriggered: needsPromptRegen,
      message: needsPromptRegen
        ? 'Products updated. Regenerating agent prompts in background.'
        : 'Products updated.',
    };
  }
}
