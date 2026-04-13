import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { PromptGeneratorService } from './prompt-generator/prompt-generator.service';
import { MetaLearningImporterService } from '../campaigns/meta-ads/meta-learning-importer.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

@Controller('companies')
export class CompaniesController {
  private readonly logger = new Logger(CompaniesController.name);

  constructor(
    private readonly companiesService: CompaniesService,
    private readonly promptGenerator: PromptGeneratorService,
    private readonly metaLearningImporter: MetaLearningImporterService,
    @Inject(forwardRef(() => SchedulerService))
    private readonly schedulerService: SchedulerService,
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
