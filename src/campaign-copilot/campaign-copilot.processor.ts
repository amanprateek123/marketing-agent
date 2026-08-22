import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import { CompaniesService } from '../companies/companies.service';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { Product } from '../companies/schemas/company.types';
import { CreativeProducerService } from '../creative/creative-producer/creative-producer.service';
import { ManualCampaignService } from '../campaigns/campaign-creator/manual-campaign.service';
import { CreateManualCampaignDto } from '../campaigns/campaign-creator/manual-campaign.types';
import { CampaignsService } from '../campaigns/campaigns.service';
import { resolveLocaleIds } from '../campaigns/campaign-creator/audience-targeting-resolver';
import {
  CreativeBrief,
  CreativeBriefDocument,
} from '../pipeline/schemas/creative-brief.schema';
import {
  PipelineRun,
  PipelineRunDocument,
} from '../pipeline/schemas/pipeline-run.schema';
import {
  CAMPAIGN_COPILOT_BUILD,
  CampaignCopilotBuildJob,
  CampaignCopilotPlan,
  CampaignCopilotSessionStatus,
} from './campaign-copilot.contracts';
import {
  COPILOT_OBJECTIVE_TO_META,
  COPILOT_OPTIMIZATION_GOAL,
  findConfiguredProduct,
  normalizeName,
} from './campaign-copilot.rules';
import {
  CampaignCopilotSession,
  CampaignCopilotSessionDocument,
} from './schemas/campaign-copilot-session.schema';

@Injectable()
@Processor(CAMPAIGN_COPILOT_BUILD, {
  // Creative generation can include several model/image/video calls.
  lockDuration: 30 * 60 * 1000,
  lockRenewTime: 10 * 60 * 1000,
  stalledInterval: 10 * 60 * 1000,
})
export class CampaignCopilotProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignCopilotProcessor.name);

  constructor(
    @InjectModel(CampaignCopilotSession.name)
    private readonly sessionModel: Model<CampaignCopilotSessionDocument>,
    @InjectModel(CreativeBrief.name)
    private readonly creativeBriefModel: Model<CreativeBriefDocument>,
    @InjectModel(PipelineRun.name)
    private readonly pipelineRunModel: Model<PipelineRunDocument>,
    private readonly companiesService: CompaniesService,
    private readonly creativeProducer: CreativeProducerService,
    private readonly manualCampaignService: ManualCampaignService,
    private readonly campaignsService: CampaignsService,
  ) {
    super();
  }

  async process(job: Job<CampaignCopilotBuildJob>): Promise<void> {
    const { tenantId, sessionId, confirmationHash } = job.data;
    const planVersion = confirmationHash.slice(0, 12);
    const runId = `copilot-${sessionId}-${planVersion}`;
    const briefId = `copilot-brief-${sessionId}-${planVersion}`;
    let session = await this.sessionModel
      .findOne({ tenantId, sessionId })
      .exec();
    if (!session)
      throw new Error(`Campaign Copilot session ${sessionId} not found`);
    if (
      session.status === CampaignCopilotSessionStatus.PENDING_APPROVAL &&
      session.build?.campaignId
    ) {
      return;
    }
    if (
      !session.confirmedPlan ||
      session.confirmedPlanHash !== confirmationHash
    ) {
      throw new Error(
        'Confirmed campaign plan hash does not match the queued build. Refusing to build a mutable or stale draft.',
      );
    }

    const buildStartedAt = session.build?.startedAt ?? new Date();
    session = await this.sessionModel
      .findOneAndUpdate(
        {
          tenantId,
          sessionId,
          confirmedPlanHash: confirmationHash,
          status: {
            $in: [
              CampaignCopilotSessionStatus.BUILD_QUEUED,
              CampaignCopilotSessionStatus.BUILDING,
              CampaignCopilotSessionStatus.FAILED,
            ],
          },
        },
        {
          $set: {
            status: CampaignCopilotSessionStatus.BUILDING,
            'build.startedAt': buildStartedAt,
            'build.error': null,
          },
        },
        { new: true },
      )
      .exec();
    if (!session) {
      throw new Error(`Campaign Copilot session ${sessionId} is not buildable`);
    }
    if (!session.confirmedPlan) {
      throw new Error('Campaign Copilot session has no frozen confirmed plan');
    }

    try {
      const plan: CampaignCopilotPlan = structuredClone(session.confirmedPlan);
      let company = await this.companiesService.findByTenantId(tenantId);
      await this.pipelineRunModel.findOneAndUpdate(
        { tenantId, runId },
        {
          $setOnInsert: {
            tenantId,
            runId,
            startedAt: session.createdAt,
            promptsVersion: (company as any).promptsVersion ?? 1,
          },
          $set: {
            status: 'creative_running',
            phase: 'creative',
            selectedBriefId: briefId,
          },
          $unset: { error: 1, completedAt: 1 },
        },
        { upsert: true, new: true },
      );

      const resolvedProduct = await this.ensureProduct(
        company,
        plan,
        sessionId,
      );
      const product = resolvedProduct.product;
      company = resolvedProduct.company;

      const existingCampaign = await this.campaignsService.findByRunId(
        tenantId,
        runId,
      );
      if (existingCampaign) {
        await this.finish(
          session,
          runId,
          briefId,
          String(existingCampaign._id),
          existingCampaign.creativePackageId,
        );
        return;
      }

      const topic =
        plan.campaignName?.trim() ||
        `${product.name} — ${this.objectiveLabel(plan)}`;
      const audience =
        plan.audienceName ||
        plan.targetSegment ||
        `${plan.funnelStage} ${plan.audienceType}`;
      const angle =
        plan.angle?.trim() ||
        `${this.objectiveLabel(plan)} for ${plan.funnelStage} audiences`;
      const keyMessage =
        plan.keyMessage?.trim() ||
        product.description ||
        `${product.name}: ${this.objectiveLabel(plan)}`;
      const creativeBrief = await this.creativeBriefModel
        .findOneAndUpdate(
          { tenantId, briefId },
          {
            $set: {
              tenantId,
              runId,
              briefId,
              product: product.name,
              topic,
              angle,
              platform: 'Meta',
              format: plan.creativeFormat,
              audience,
              hook: angle,
              keyMessage,
              conversionBridge: this.conversionBridge(plan, product.name),
              audienceStage: plan.funnelStage,
              targetSegment: plan.targetSegment ?? '',
              targetLanguage: plan.language ?? '',
              suggestedBudget: plan.dailyBudget,
              finalScore: 0,
              selected: true,
              selectionReason:
                'Confirmed by the operator through Campaign Copilot.',
              debateRationale:
                'ChatGPT Campaign Copilot plan; deterministic safety validation applied before confirmation.',
            },
          },
          { upsert: true, new: true },
        )
        .exec();

      const creativePackage = await this.creativeProducer.produce(
        tenantId,
        briefId,
        runId,
        {
          topic: creativeBrief.topic,
          angle: creativeBrief.angle,
          platform: creativeBrief.platform,
          format: creativeBrief.format,
          audience: creativeBrief.audience,
          hook: creativeBrief.hook,
          keyMessage: creativeBrief.keyMessage,
          conversionBridge: creativeBrief.conversionBridge,
          product: product.name,
          targetSegment: creativeBrief.targetSegment,
          targetLanguage: plan.language as any,
          audienceStage: plan.funnelStage ?? undefined,
        },
        {
          forceOpenAI: true,
          imageProvider: 'gpt_image',
          skipVisionQa: true,
        },
      );
      if (creativePackage.status !== 'completed') {
        throw new Error(
          `Creative production did not complete (status: ${creativePackage.status})`,
        );
      }

      await this.pipelineRunModel.updateOne(
        { tenantId, runId },
        { status: 'campaign_launching', phase: 'campaign' },
      );
      const segment = (product.audienceSegments ?? []).find(
        (candidate) => candidate.name === plan.targetSegment,
      );
      const locales = resolveLocaleIds(
        plan.language ? [plan.language] : undefined,
      ).ids;
      const campaign = await this.manualCampaignService.create(
        tenantId,
        company,
        this.buildManualDto({
          plan,
          product,
          topic,
          briefId,
          creativePackageId: String(creativePackage._id),
          segment,
          locales,
        }),
        {
          source: 'agent',
          runId,
          briefId,
          authoringMode: 'campaign_copilot',
          copilotSessionId: sessionId,
          reviewNotes:
            'Prepared by ChatGPT Campaign Copilot from an operator-confirmed plan. Budget, product, account and audience IDs were deterministically validated. Rendered-image vision QA was not run (checked=false) to preserve the ChatGPT-only/no-Claude boundary; copy safety and approval-time launch validation remain active.',
        },
      );
      await this.finish(
        session,
        runId,
        briefId,
        String(campaign._id),
        String(creativePackage._id),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = Number(job.opts.attempts ?? 1);
      const isFinalAttempt = job.attemptsMade + 1 >= attempts;
      await Promise.all([
        this.pipelineRunModel.updateOne(
          { tenantId, runId },
          isFinalAttempt
            ? {
                status: 'failed',
                phase: 'failed',
                error: message,
                completedAt: new Date(),
              }
            : {
                status: 'creative_running',
                phase: 'retry_queued',
                error: `Attempt ${job.attemptsMade + 1}/${attempts} failed; retrying: ${message}`,
              },
        ),
        this.sessionModel.updateOne(
          { tenantId, sessionId, confirmedPlanHash: confirmationHash },
          {
            $set: {
              status: isFinalAttempt
                ? CampaignCopilotSessionStatus.FAILED
                : CampaignCopilotSessionStatus.BUILD_QUEUED,
              'build.error': isFinalAttempt
                ? message
                : `Build attempt ${job.attemptsMade + 1}/${attempts} failed and will retry automatically.`,
            },
          },
        ),
      ]);
      this.logger.error(
        `Campaign Copilot build failed: tenant=${tenantId} session=${sessionId} error=${message}`,
      );
      throw error;
    }
  }

  private async ensureProduct(
    company: CompanyDocument,
    plan: CampaignCopilotPlan,
    sessionId: string,
  ): Promise<{ product: Product; company: CompanyDocument }> {
    if (!plan.productName)
      throw new Error('Confirmed plan has no product name');
    const existing = findConfiguredProduct(company, plan.productName);
    if (plan.productMode === 'existing') {
      if (!existing) {
        throw new Error(
          `Configured product "${plan.productName}" no longer exists`,
        );
      }
      const missingFields: Partial<Product> = {};
      if (!existing.landingUrl && plan.landingUrl) {
        missingFields.landingUrl = plan.landingUrl;
      } else if (
        existing.landingUrl &&
        plan.landingUrl &&
        existing.landingUrl !== plan.landingUrl
      ) {
        throw new Error(
          `Product "${existing.name}" landingUrl changed after confirmation; review and confirm the plan again`,
        );
      }
      // Only fill genuinely missing fields explicitly captured in the plan;
      // never overwrite a product's live tracking configuration.
      const supplied = plan.newProduct;
      if (supplied) {
        for (const field of [
          'conversionEvent',
          'conversionValue',
          'pixelId',
          'customConversionId',
          'pageId',
          'metaAppId',
          'metaAppStoreUrl',
        ] as const) {
          const requested = supplied[field];
          if (
            requested === undefined ||
            requested === null ||
            requested === ''
          ) {
            continue;
          }
          const current = existing[field];
          if (
            current === undefined ||
            current === null ||
            current === '' ||
            current === 0
          ) {
            (missingFields as any)[field] = requested;
          } else if (current !== requested) {
            throw new Error(
              `Product "${existing.name}" field "${field}" changed after confirmation; review and confirm the plan again`,
            );
          }
        }
      }
      if (Object.keys(missingFields).length) {
        const updatedCompany =
          await this.companiesService.fillMissingCopilotProductFields(
            company.tenantId,
            existing.name,
            missingFields,
          );
        const updatedProduct = findConfiguredProduct(
          updatedCompany,
          existing.name,
        );
        if (!updatedProduct) {
          throw new Error(
            `Configured product "${existing.name}" disappeared while filling its missing setup`,
          );
        }
        for (const [field, requested] of Object.entries(missingFields)) {
          if ((updatedProduct as any)[field] !== requested) {
            throw new Error(
              `Product "${existing.name}" field "${field}" changed after confirmation; review and confirm the plan again`,
            );
          }
        }
        return { product: updatedProduct, company: updatedCompany };
      }
      return { product: existing, company };
    }

    if (plan.productMode !== 'new' || !plan.newProduct) {
      throw new Error(
        'Confirmed plan does not contain a complete product setup',
      );
    }
    if (existing && existing.copilotSessionId === sessionId) {
      // A previous Bull attempt created this exact product before failing in a
      // later creative/campaign step. Reuse it; this is not a duplicate.
      this.assertNewProductMatchesConfirmedPlan(existing, plan, sessionId);
      return { product: existing, company };
    }
    if (existing) {
      throw new Error(
        `Product "${existing.name}" appeared after confirmation; refusing to create a duplicate`,
      );
    }
    const setup = plan.newProduct;
    const product: Product = {
      name: plan.productName,
      price: setup.price!,
      currency: setup.currency!,
      description: setup.description!,
      active: true,
      copilotSessionId: sessionId,
      landingUrl: plan.landingUrl!,
      languages: plan.language ? [plan.language] : [],
      conversionEvent: setup.conversionEvent ?? undefined,
      conversionValue: setup.conversionValue ?? undefined,
      pixelId: setup.pixelId ?? undefined,
      customConversionId: setup.customConversionId ?? undefined,
      pageId: setup.pageId ?? undefined,
      metaAppId: setup.metaAppId ?? undefined,
      metaAppStoreUrl: setup.metaAppStoreUrl ?? undefined,
      audienceSegments: [],
      metaAudiences: [],
      performance: {
        totalConversions: 0,
        avgCPA: null,
        avgROAS: null,
        bestHookStyle: null,
        bestPlatform: null,
        confidenceLevel: 'hypothesis',
      },
    };
    const productKey = normalizeName(product.name);
    const updatedCompany =
      await this.companiesService.appendCopilotProductIfAbsent(
        company.tenantId,
        productKey,
        product,
      );
    if (updatedCompany) {
      const created = findConfiguredProduct(updatedCompany, product.name);
      if (!created || created.copilotSessionId !== sessionId) {
        throw new Error(
          `Product "${product.name}" could not be resolved after creation`,
        );
      }
      this.assertNewProductMatchesConfirmedPlan(created, plan, sessionId);
      return { product: created, company: updatedCompany };
    }

    // The atomic predicate lost a race. Re-read instead of saving the stale
    // company document: a retry from this session may reuse its own product,
    // while a different session's equivalent product must stop this build.
    const currentCompany = await this.companiesService.findByTenantId(
      company.tenantId,
    );
    const raced = findConfiguredProduct(currentCompany, product.name);
    if (raced?.copilotSessionId === sessionId) {
      this.assertNewProductMatchesConfirmedPlan(raced, plan, sessionId);
      return { product: raced, company: currentCompany };
    }
    if (raced) {
      throw new Error(
        `Product "${raced.name}" appeared after confirmation; refusing to create a duplicate`,
      );
    }
    throw new Error(
      `Company "${company.tenantId}" changed while creating product "${product.name}"; retry the build`,
    );
  }

  private assertNewProductMatchesConfirmedPlan(
    product: Product,
    plan: CampaignCopilotPlan,
    sessionId: string,
  ): void {
    if (!plan.productName || !plan.newProduct || !plan.landingUrl) {
      throw new Error('Confirmed plan does not contain a complete new product');
    }
    const setup = plan.newProduct;
    const expected: Array<[keyof Product, unknown]> = [
      ['name', plan.productName],
      ['price', setup.price],
      ['currency', setup.currency],
      ['description', setup.description],
      ['active', true],
      ['copilotSessionId', sessionId],
      ['landingUrl', plan.landingUrl],
      ['languages', plan.language ? [plan.language] : []],
      ['conversionEvent', setup.conversionEvent],
      ['conversionValue', setup.conversionValue],
      ['pixelId', setup.pixelId],
      ['customConversionId', setup.customConversionId],
      ['pageId', setup.pageId],
      ['metaAppId', setup.metaAppId],
      ['metaAppStoreUrl', setup.metaAppStoreUrl],
    ];
    for (const [field, confirmed] of expected) {
      const live = product[field];
      const matches =
        Array.isArray(confirmed) || Array.isArray(live)
          ? JSON.stringify(live ?? []) === JSON.stringify(confirmed ?? [])
          : (live ?? null) === (confirmed ?? null);
      if (!matches) {
        throw new Error(
          `New product "${product.name}" field "${field}" changed after confirmation; review and confirm the plan again`,
        );
      }
    }
  }

  private buildManualDto(input: {
    plan: CampaignCopilotPlan;
    product: Product;
    topic: string;
    briefId: string;
    creativePackageId: string;
    segment:
      | {
          ageMin: number;
          ageMax: number;
          gender: 'all' | 'male' | 'female';
        }
      | undefined;
    locales: number[];
  }): CreateManualCampaignDto {
    const { plan } = input;
    const isAdvantagePlus = plan.audienceType === 'advantage_plus';
    return {
      name: input.topic,
      productName: input.product.name,
      accountId: plan.accountId!,
      campaignType: isAdvantagePlus ? 'advantage_plus' : 'custom',
      budget: plan.dailyBudget!,
      objective: COPILOT_OBJECTIVE_TO_META[plan.objective!],
      adSets: [
        {
          name: `${input.topic} — ${plan.funnelStage}`,
          budgetPercent: 100,
          audienceType: plan.audienceType!,
          metaAudienceId: plan.metaAudienceId ?? undefined,
          ageMin: input.segment?.ageMin,
          ageMax: input.segment?.ageMax,
          gender: input.segment?.gender,
          geoLocations: plan.geoLocations,
          locales: input.locales.length ? input.locales : undefined,
          userOs:
            plan.objective === 'app_promotion' && plan.appPlatform
              ? [plan.appPlatform]
              : undefined,
          optimizationGoal: COPILOT_OPTIMIZATION_GOAL[plan.objective!],
          creativeFormat:
            plan.creativeFormat === 'meme' ? 'image' : plan.creativeFormat!,
        },
      ],
      creativePackageId: input.creativePackageId,
    };
  }

  private objectiveLabel(plan: CampaignCopilotPlan): string {
    return (plan.objective ?? 'campaign').replace(/_/g, ' ');
  }

  private conversionBridge(
    plan: CampaignCopilotPlan,
    productName: string,
  ): string {
    switch (plan.objective) {
      case 'sales_purchase':
        return `Purchase ${productName}`;
      case 'leads':
        return `Submit a qualified lead for ${productName}`;
      case 'traffic':
        return `Visit the ${productName} landing page`;
      case 'engagement':
        return `Engage with the ${productName} message`;
      case 'awareness':
        return `Remember ${productName}`;
      case 'reach':
        return `See the ${productName} message`;
      case 'app_promotion':
        return `Install or open ${productName}`;
      default:
        return `Learn about ${productName}`;
    }
  }

  private async finish(
    session: CampaignCopilotSessionDocument,
    runId: string,
    briefId: string,
    campaignId: string,
    creativePackageId: string,
  ): Promise<void> {
    const now = new Date();
    await Promise.all([
      this.pipelineRunModel.updateOne(
        { tenantId: session.tenantId, runId },
        {
          status: 'completed',
          phase: 'done',
          completedAt: now,
          briefsGenerated: 1,
          selectedBriefId: briefId,
          campaignId,
        },
      ),
      this.sessionModel.updateOne(
        {
          tenantId: session.tenantId,
          sessionId: session.sessionId,
          confirmedPlanHash: session.confirmedPlanHash,
        },
        {
          $set: {
            status: CampaignCopilotSessionStatus.PENDING_APPROVAL,
            'build.completedAt': now,
            'build.campaignId': campaignId,
            'build.creativeBriefId': briefId,
            'build.creativePackageId': creativePackageId,
            'build.error': null,
          },
        },
      ),
    ]);
    this.logger.log(
      `Campaign Copilot build ready for approval: tenant=${session.tenantId} session=${session.sessionId} campaign=${campaignId}`,
    );
  }
}
