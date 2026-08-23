import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Model } from 'mongoose';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'crypto';
import { AgentType } from '../claude/claude.types';
import { OpenAIChatService } from '../openai/openai-chat.service';
import { parseRobustJson } from '../common/llm/robust-json-parser.util';
import { CompaniesService } from '../companies/companies.service';
import { CompanyDocument } from '../companies/schemas/company.schema';
import { MetaAudience } from '../companies/schemas/company.types';
import { CampaignsService } from '../campaigns/campaigns.service';
import {
  MetaCustomAudience,
  MetaPageSummary,
  MetaAdsService,
} from '../campaigns/meta-ads/meta-ads.service';
import {
  CAMPAIGN_COPILOT_BUILD,
  CampaignCopilotMessage,
  CampaignCopilotModelTurn,
  CampaignCopilotNewProduct,
  CampaignCopilotPlan,
  CampaignCopilotRecommendations,
  CampaignCopilotSessionResponse,
  CampaignCopilotSessionStatus,
  emptyCampaignCopilotBuildState,
  emptyCampaignCopilotPlan,
} from './campaign-copilot.contracts';
import {
  buildCopilotRecommendations,
  clampDailyBudget,
  computeMaxAllowedDailyBudget,
  COPILOT_OPTIMIZATION_GOAL,
  configuredAccountIds,
  evaluateCopilotReadiness,
  explicitlyAcceptsRecommendation,
  findConfiguredProduct,
  isAudienceType,
  isCreativeFormat,
  isFunnelStage,
  isHttpUrl,
  isObjective,
  normalizeAccountId,
  normalizeName,
  sanitizeGeoLocations,
  sanitizeLanguage,
} from './campaign-copilot.rules';
import {
  CampaignCopilotSession,
  CampaignCopilotSessionDocument,
} from './schemas/campaign-copilot-session.schema';

interface RuntimeContext {
  company: CompanyDocument;
  currentWeeklySpend: number;
  accountAudiences: MetaAudience[] | null;
  accountAudiencesVerified: boolean;
  pages: MetaPageSummary[] | null;
  pagesVerified: boolean;
}

@Injectable()
export class CampaignCopilotService {
  private readonly logger = new Logger(CampaignCopilotService.name);

  constructor(
    @InjectModel(CampaignCopilotSession.name)
    private readonly sessionModel: Model<CampaignCopilotSessionDocument>,
    @InjectQueue(CAMPAIGN_COPILOT_BUILD)
    private readonly buildQueue: Queue,
    private readonly companiesService: CompaniesService,
    private readonly campaignsService: CampaignsService,
    private readonly metaAdsService: MetaAdsService,
    private readonly openaiChat: OpenAIChatService,
  ) {}

  async createSession(
    tenantId: string,
    message?: string,
    clientMessageId?: string,
  ): Promise<CampaignCopilotSessionResponse> {
    const initialKey = clientMessageId?.trim();
    if (initialKey) {
      const existing = await this.sessionModel
        .findOne({ tenantId, initialClientMessageId: initialKey })
        .exec();
      if (existing) return this.toResponse(existing);
    }
    const company = await this.companiesService.findByTenantId(tenantId);
    const plan = emptyCampaignCopilotPlan();
    const currentWeeklySpend =
      await this.campaignsService.getWeeklySpend(tenantId);
    const recommendations = buildCopilotRecommendations({
      company,
      plan,
      currentWeeklySpend,
    });
    const readiness = evaluateCopilotReadiness({
      company,
      plan,
      currentWeeklySpend,
    });
    let session: CampaignCopilotSessionDocument;
    try {
      session = await this.sessionModel.create({
        tenantId,
        sessionId: randomUUID(),
        ...(initialKey ? { initialClientMessageId: initialKey } : {}),
        status: CampaignCopilotSessionStatus.COLLECTING,
        messages: [],
        plan,
        recommendations,
        readiness,
        build: emptyCampaignCopilotBuildState(),
        turnNumber: 0,
        turnInProgress: false,
      });
    } catch (error: any) {
      if (initialKey && error?.code === 11000) {
        const raced = await this.sessionModel
          .findOne({ tenantId, initialClientMessageId: initialKey })
          .exec();
        if (raced) return this.toResponse(raced);
      }
      throw error;
    }
    return this.runConversationTurn(
      session,
      message?.trim() || null,
      clientMessageId,
      true,
    );
  }

  async getSession(
    tenantId: string,
    sessionId: string,
  ): Promise<CampaignCopilotSessionResponse> {
    const session = await this.findSession(tenantId, sessionId);
    return this.toResponse(session);
  }

  async sendMessage(
    tenantId: string,
    sessionId: string,
    message: string,
    clientMessageId?: string,
  ): Promise<CampaignCopilotSessionResponse> {
    const session = await this.findSession(tenantId, sessionId);
    return this.runConversationTurn(
      session,
      message.trim(),
      clientMessageId,
      false,
    );
  }

  async confirm(
    tenantId: string,
    sessionId: string,
  ): Promise<CampaignCopilotSessionResponse> {
    let session = await this.findSession(tenantId, sessionId);
    if (
      [
        CampaignCopilotSessionStatus.BUILD_QUEUED,
        CampaignCopilotSessionStatus.BUILDING,
        CampaignCopilotSessionStatus.PENDING_APPROVAL,
      ].includes(session.status)
    ) {
      return this.toResponse(session);
    }
    if (session.turnInProgress) {
      throw new ConflictException(
        'Wait for the current ChatGPT turn to finish before confirming.',
      );
    }

    const runtime = await this.loadRuntimeContext(
      tenantId,
      session.plan.accountId,
    );
    const readiness = evaluateCopilotReadiness({
      company: runtime.company,
      plan: session.plan,
      currentWeeklySpend: runtime.currentWeeklySpend,
      accountAudiences: runtime.accountAudiences,
      accountAudiencesVerified: runtime.accountAudiencesVerified,
      promotablePageIds: runtime.pages
        ?.filter((page) => page.promotable)
        .map((page) => page.id),
      pagesVerified: runtime.pagesVerified,
    });
    if (!readiness.ready) {
      session.readiness = readiness;
      session.status = CampaignCopilotSessionStatus.COLLECTING;
      session.markModified('readiness');
      await session.save();
      throw new BadRequestException({
        message: 'Campaign plan is not ready to confirm.',
        readiness,
      });
    }

    const frozenPlan = structuredClone(session.plan);
    const confirmationHash = createHash('sha256')
      .update(JSON.stringify(frozenPlan))
      .digest('hex');
    const tenantKey = tenantId.replace(/[^a-zA-Z0-9_-]/g, '-');
    // Stable for duplicate confirms of this immutable snapshot, distinct for
    // a revised plan confirmed after a terminal build failure.
    const jobId = `${CAMPAIGN_COPILOT_BUILD}-${tenantKey}-${sessionId}-${confirmationHash.slice(0, 12)}`;
    const now = new Date();
    const queued = await this.sessionModel
      .findOneAndUpdate(
        {
          tenantId,
          sessionId,
          status: {
            $in: [
              CampaignCopilotSessionStatus.READY,
              CampaignCopilotSessionStatus.FAILED,
            ],
          },
          turnInProgress: false,
        },
        {
          $set: {
            status: CampaignCopilotSessionStatus.BUILD_QUEUED,
            readiness,
            confirmedPlan: frozenPlan,
            confirmedPlanHash: confirmationHash,
            confirmedAt: now,
            build: {
              ...emptyCampaignCopilotBuildState(),
              jobId,
            },
          },
        },
        { new: true },
      )
      .exec();

    if (!queued) {
      session = await this.findSession(tenantId, sessionId);
      if (
        [
          CampaignCopilotSessionStatus.BUILD_QUEUED,
          CampaignCopilotSessionStatus.BUILDING,
          CampaignCopilotSessionStatus.PENDING_APPROVAL,
        ].includes(session.status)
      ) {
        return this.toResponse(session);
      }
      throw new ConflictException(
        'The plan changed while it was being confirmed. Review it and confirm again.',
      );
    }

    try {
      await this.buildQueue.add(
        CAMPAIGN_COPILOT_BUILD,
        { tenantId, sessionId, confirmationHash },
        {
          jobId,
          attempts: 2,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: 100,
          removeOnFail: true,
        },
      );
    } catch (error) {
      await this.sessionModel.updateOne(
        { tenantId, sessionId, confirmedPlanHash: confirmationHash },
        {
          $set: {
            status: CampaignCopilotSessionStatus.READY,
            'build.error':
              error instanceof Error ? error.message : String(error),
          },
        },
      );
      throw error;
    }
    return this.toResponse(queued);
  }

  private async runConversationTurn(
    original: CampaignCopilotSessionDocument,
    userMessage: string | null,
    clientMessageId: string | undefined,
    initial: boolean,
  ): Promise<CampaignCopilotSessionResponse> {
    if (
      [
        CampaignCopilotSessionStatus.BUILD_QUEUED,
        CampaignCopilotSessionStatus.BUILDING,
        CampaignCopilotSessionStatus.PENDING_APPROVAL,
      ].includes(original.status)
    ) {
      throw new ConflictException(
        'This plan has already been confirmed and can no longer be edited.',
      );
    }

    const messageId = clientMessageId?.trim() || randomUUID();
    if (
      clientMessageId &&
      original.messages.some(
        (entry) => entry.role === 'user' && entry.id === messageId,
      )
    ) {
      return this.toResponse(original);
    }

    const userEntry: CampaignCopilotMessage | null = userMessage
      ? {
          id: messageId,
          role: 'user',
          content: userMessage,
          createdAt: new Date(),
        }
      : null;
    const setOnLock: Record<string, unknown> = {
      turnInProgress: true,
    };
    if (original.status === CampaignCopilotSessionStatus.FAILED) {
      setOnLock.status = CampaignCopilotSessionStatus.COLLECTING;
      setOnLock.confirmedPlan = null;
      setOnLock.confirmedPlanHash = null;
      setOnLock.confirmedAt = null;
      setOnLock['build.error'] = null;
    }
    const update: Record<string, unknown> = { $set: setOnLock };
    if (userEntry) {
      update.$push = { messages: userEntry };
      update.$inc = { turnNumber: 1 };
    }
    const locked = await this.sessionModel
      .findOneAndUpdate(
        {
          tenantId: original.tenantId,
          sessionId: original.sessionId,
          turnInProgress: false,
        },
        update,
        { new: true },
      )
      .exec();
    if (!locked) {
      throw new ConflictException(
        'ChatGPT is already answering another message in this session.',
      );
    }

    try {
      const before = await this.loadRuntimeContext(
        locked.tenantId,
        locked.plan.accountId,
      );
      const recommendations = buildCopilotRecommendations({
        company: before.company,
        plan: locked.plan,
        currentWeeklySpend: before.currentWeeklySpend,
        accountAudiences: before.accountAudiences,
      });
      const readiness = evaluateCopilotReadiness({
        company: before.company,
        plan: locked.plan,
        currentWeeklySpend: before.currentWeeklySpend,
        accountAudiences: before.accountAudiences,
        accountAudiencesVerified: before.accountAudiencesVerified,
        promotablePageIds: before.pages
          ?.filter((page) => page.promotable)
          .map((page) => page.id),
        pagesVerified: before.pagesVerified,
      });
      const result = await this.openaiChat.runChat({
        tenantId: locked.tenantId,
        runId: `copilot-chat-${locked.sessionId}`,
        agentType: AgentType.CAMPAIGN_COPILOT,
        systemPrompt: this.systemPrompt(),
        userMessage: this.buildTurnPrompt({
          company: before.company,
          currentWeeklySpend: before.currentWeeklySpend,
          accountAudiences: before.accountAudiences,
          pages: before.pages,
          session: locked,
          recommendations,
          readiness,
          latestUserMessage:
            userMessage ??
            'Start the campaign-planning conversation. Briefly explain that you will prepare a campaign for human approval, then ask the single most important first question.',
          initial,
        }),
        expectJson: true,
      });
      const parsed = parseRobustJson(
        result.content,
      ) as CampaignCopilotModelTurn;
      if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
        throw new Error(
          'ChatGPT returned an invalid Campaign Copilot response.',
        );
      }

      const applied = this.applyPlanPatch({
        plan: locked.plan,
        patch: parsed.planPatch,
        latestUserMessage: userMessage ?? '',
        company: before.company,
        recommendations,
        accountAudiences: before.accountAudiences,
        currentWeeklySpend: before.currentWeeklySpend,
      });
      // Most turns keep the same account. Reuse the already-verified runtime
      // snapshot so a chat message does not repeat both live Meta calls and
      // both tenant DB reads. A changed account must be loaded and verified
      // independently before any audience/Page choice from it can be accepted.
      const accountChanged =
        normalizeAccountId(applied.plan.accountId) !==
        normalizeAccountId(locked.plan.accountId);
      const after = accountChanged
        ? await this.loadRuntimeContext(locked.tenantId, applied.plan.accountId)
        : before;
      const finalRecommendations = buildCopilotRecommendations({
        company: after.company,
        plan: applied.plan,
        currentWeeklySpend: after.currentWeeklySpend,
        accountAudiences: after.accountAudiences,
      });
      const finalReadiness = evaluateCopilotReadiness({
        company: after.company,
        plan: applied.plan,
        currentWeeklySpend: after.currentWeeklySpend,
        accountAudiences: after.accountAudiences,
        accountAudiencesVerified: after.accountAudiencesVerified,
        promotablePageIds: after.pages
          ?.filter((page) => page.promotable)
          .map((page) => page.id),
        pagesVerified: after.pagesVerified,
      });
      const suffix = applied.notes.length
        ? `\n\nSafety check: ${applied.notes.join(' ')}`
        : '';
      const assistantEntry: CampaignCopilotMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: `${parsed.reply.trim()}${suffix}`,
        createdAt: new Date(),
      };
      const updated = await this.sessionModel
        .findOneAndUpdate(
          {
            tenantId: locked.tenantId,
            sessionId: locked.sessionId,
            turnInProgress: true,
          },
          {
            $set: {
              turnInProgress: false,
              plan: applied.plan,
              recommendations: finalRecommendations,
              readiness: finalReadiness,
              status: finalReadiness.ready
                ? CampaignCopilotSessionStatus.READY
                : CampaignCopilotSessionStatus.COLLECTING,
            },
            $push: { messages: assistantEntry },
          },
          { new: true },
        )
        .exec();
      if (!updated) throw new Error('Campaign Copilot session disappeared.');
      return this.toResponse(updated);
    } catch (error) {
      this.logger.error(
        `Campaign Copilot turn failed: tenant=${locked.tenantId} session=${locked.sessionId} error=${error instanceof Error ? error.message : String(error)}`,
      );
      const assistantEntry: CampaignCopilotMessage = {
        id: randomUUID(),
        role: 'assistant',
        content:
          'ChatGPT is temporarily unavailable, so I did not change the campaign plan. Please retry your last message.',
        createdAt: new Date(),
      };
      const recovered = await this.sessionModel
        .findOneAndUpdate(
          {
            tenantId: locked.tenantId,
            sessionId: locked.sessionId,
          },
          {
            $set: { turnInProgress: false },
            $push: { messages: assistantEntry },
          },
          { new: true },
        )
        .exec();
      if (!recovered) throw error;
      return this.toResponse(recovered);
    }
  }

  private applyPlanPatch(input: {
    plan: CampaignCopilotPlan;
    patch: CampaignCopilotModelTurn['planPatch'];
    latestUserMessage: string;
    company: CompanyDocument;
    recommendations: CampaignCopilotRecommendations;
    accountAudiences: MetaAudience[] | null;
    currentWeeklySpend: number;
  }): { plan: CampaignCopilotPlan; notes: string[] } {
    const plan = structuredClone(input.plan);
    const patch = input.patch ?? {};
    const notes: string[] = [];
    const latest = input.latestUserMessage;
    // Numbers are only accepted when the operator actually typed them, which
    // stops the model inventing a price. Digit-group separators have to be
    // normalized first, though: "₹1,299" is extracted as 1299, and a raw
    // substring test against "1,299" fails — silently dropping a value the
    // operator clearly supplied. Handles Indian grouping ("1,29,999") too.
    const latestDigitsNormalized = latest.replace(/(\d)[, \s](?=\d)/g, '$1');
    const mentionsNumber = (value: unknown): boolean => {
      const n = Number(value);
      if (!Number.isFinite(n)) return false;
      const asText = String(n);
      return latest.includes(asText) || latestDigitsNormalized.includes(asText);
    };
    // The initial greeting may explain available choices but cannot make any
    // choice on the operator's behalf.
    if (!latest.trim()) return { plan, notes };
    const recommendedSubjects = (
      [
        ['budget', patch.useRecommendedBudget],
        ['objective', patch.useRecommendedObjective],
        ['account', patch.useRecommendedAccount],
        ['audience', patch.useRecommendedAudience],
        ['format', patch.useRecommendedCreativeFormat],
      ] as const
    )
      .filter(([, requested]) => requested)
      .map(([subject]) => subject);
    const acceptsRecommendation = (
      subject: (typeof recommendedSubjects)[number],
    ) =>
      explicitlyAcceptsRecommendation(
        latest,
        subject,
        recommendedSubjects.length === 1 && recommendedSubjects[0] === subject,
      );

    const requestedProduct =
      typeof patch.productName === 'string' ? patch.productName.trim() : '';
    if (requestedProduct) {
      const configured = findConfiguredProduct(input.company, requestedProduct);
      const productWasChanged =
        normalizeName(plan.productName) !== normalizeName(requestedProduct);
      const productWasNamed = normalizeName(latest).includes(
        normalizeName(requestedProduct),
      );
      const activeProducts = (input.company.products ?? []).filter(
        (product) => product.active !== false,
      );
      const soleProductAccepted =
        explicitlyAcceptsRecommendation(
          latest,
          'product',
          recommendedSubjects.length === 0,
        ) &&
        activeProducts.length === 1 &&
        normalizeName(activeProducts[0].name) ===
          normalizeName(requestedProduct);
      if (
        configured &&
        patch.productMode !== 'new' &&
        (productWasNamed || soleProductAccepted)
      ) {
        plan.productMode = 'existing';
        plan.productName = configured.name;
        // Existing canonical URL is authoritative. A new URL is accepted only
        // when the configured product is missing one, then persisted at build.
        if (productWasChanged) {
          plan.landingUrl = configured.landingUrl?.trim() || null;
          plan.newProduct = null;
          this.clearAudience(plan);
        } else if (configured.landingUrl?.trim()) {
          plan.landingUrl = configured.landingUrl.trim();
        }
      } else if (
        patch.productMode === 'new' &&
        productWasNamed &&
        /\b(new|create|add|not (available|listed|there)|doesn'?t exist)\b/i.test(
          latest,
        )
      ) {
        const switchingToNewProduct =
          productWasChanged || plan.productMode !== 'new';
        plan.productMode = 'new';
        plan.productName = requestedProduct.slice(0, 200);
        if (switchingToNewProduct) {
          plan.landingUrl = null;
          plan.newProduct = this.emptyNewProduct();
          this.clearAudience(plan);
        } else if (!plan.newProduct) {
          plan.newProduct = this.emptyNewProduct();
        }
      } else if (!configured) {
        // Only say something was ignored when it actually was. Once the plan
        // already carries this product as a new one, later turns still mention
        // it — emitting the note there tells the operator their input was
        // rejected when it was accepted, which is worse than saying nothing.
        const alreadyAcceptedAsNew =
          plan.productMode === 'new' &&
          normalizeName(plan.productName ?? '') ===
            normalizeName(requestedProduct);
        if (!alreadyAcceptedAsNew) {
          notes.push(
            `I ignored product "${requestedProduct}" because it is not configured and you did not explicitly ask to create it as a new product.`,
          );
        }
      }
    }

    const selectedProduct = findConfiguredProduct(
      input.company,
      plan.productName,
    );
    if (isHttpUrl(patch.landingUrl)) {
      if (!latest.includes(patch.landingUrl)) {
        notes.push(
          'I ignored a landing URL that was not present in your message.',
        );
      } else if (selectedProduct?.landingUrl) {
        plan.landingUrl = selectedProduct.landingUrl;
        if (selectedProduct.landingUrl !== patch.landingUrl) {
          notes.push(
            `The existing product URL remains authoritative (${selectedProduct.landingUrl}); this flow will not silently overwrite it.`,
          );
        }
      } else {
        plan.landingUrl = patch.landingUrl;
      }
    }

    if (patch.newProduct && (plan.productMode === 'new' || selectedProduct)) {
      const current = plan.newProduct ?? this.emptyNewProduct();
      const next = patch.newProduct;
      if (
        typeof next.description === 'string' &&
        next.description.trim() &&
        normalizeName(latest).includes(normalizeName(next.description))
      )
        current.description = next.description.trim().slice(0, 2_000);
      if (
        Number.isFinite(Number(next.price)) &&
        Number(next.price) > 0 &&
        mentionsNumber(next.price)
      )
        current.price = Number(next.price);
      if (
        typeof next.currency === 'string' &&
        next.currency.trim() &&
        (latest.toLowerCase().includes(next.currency.toLowerCase()) ||
          /₹|rupees?|\binr\b/i.test(latest))
      )
        current.currency = next.currency.trim().toUpperCase().slice(0, 3);
      if (
        typeof next.conversionEvent === 'string' &&
        next.conversionEvent.trim() &&
        (latest.toLowerCase().includes(next.conversionEvent.toLowerCase()) ||
          /\b(purchase|lead|registration|subscribe|conversion event)\b/i.test(
            latest,
          ))
      )
        current.conversionEvent = next.conversionEvent.trim().slice(0, 100);
      if (
        Number.isFinite(Number(next.conversionValue)) &&
        Number(next.conversionValue) > 0 &&
        mentionsNumber(next.conversionValue)
      )
        current.conversionValue = Number(next.conversionValue);
      for (const field of [
        'pixelId',
        'customConversionId',
        'pageId',
        'metaAppId',
        'metaAppStoreUrl',
      ] as const) {
        const value = next[field];
        if (typeof value === 'string' && value.trim()) {
          if (field === 'metaAppStoreUrl') {
            if (isHttpUrl(value) && latest.includes(value))
              current[field] = value;
          } else if (latest.includes(value)) {
            current[field] = value.trim();
          }
        }
      }
      // For an existing product this object is a fill-missing-only patch. The
      // worker never overwrites an already-configured value.
      plan.newProduct = current;
    }
    if (selectedProduct && plan.newProduct) {
      for (const field of [
        'conversionEvent',
        'conversionValue',
        'pixelId',
        'customConversionId',
        'pageId',
        'metaAppId',
        'metaAppStoreUrl',
      ] as const) {
        if (selectedProduct[field]) plan.newProduct[field] = null;
      }
    }

    if (isObjective(patch.objective)) {
      const aliases: Record<string, RegExp> = {
        sales_purchase: /\b(sales?|purchase|conversion)\b/i,
        leads: /\b(leads?|registration)\b/i,
        traffic: /\btraffic|landing page views?|clicks?\b/i,
        engagement: /\bengagement|post engagement\b/i,
        awareness: /\bawareness|ad recall\b/i,
        reach: /\breach\b/i,
        app_promotion: /\bapp promotion|app installs?|app engagement\b/i,
      };
      if (
        aliases[patch.objective].test(latest) ||
        (patch.useRecommendedObjective && acceptsRecommendation('objective'))
      ) {
        if (plan.objective !== patch.objective) {
          plan.appPlatform = null;
          const supplementalEvent = plan.newProduct?.conversionEvent ?? '';
          const eventCompatible =
            patch.objective === 'sales_purchase'
              ? /purchase|order.*complete|payment.*complete|sale/i.test(
                  supplementalEvent,
                )
              : patch.objective === 'leads'
                ? /lead|registration/i.test(supplementalEvent)
                : true;
          if (!eventCompatible && plan.newProduct) {
            plan.newProduct.conversionEvent = null;
          }
        }
        plan.objective = patch.objective;
      }
    } else if (
      patch.useRecommendedObjective &&
      acceptsRecommendation('objective')
    ) {
      plan.objective = input.recommendations.objective;
    }

    const accounts = configuredAccountIds(input.company);
    let accountChanged = false;
    const acceptedRecommendedAccount =
      patch.useRecommendedAccount && acceptsRecommendation('account');
    const proposedAccount = acceptedRecommendedAccount
      ? input.recommendations.accountId
      : normalizeAccountId(patch.accountId);
    if (proposedAccount) {
      const directlyNamed =
        latest.includes(proposedAccount) ||
        latest.includes(proposedAccount.replace(/^act_/, ''));
      if (
        accounts.includes(proposedAccount) &&
        (directlyNamed || acceptedRecommendedAccount)
      ) {
        if (plan.accountId !== proposedAccount) {
          accountChanged = true;
          this.clearAudience(plan);
        }
        plan.accountId = proposedAccount;
      } else if (!accounts.includes(proposedAccount)) {
        notes.push(
          'I ignored an account ID that is not configured for this tenant.',
        );
      }
    }

    const maxAllowed = computeMaxAllowedDailyBudget({
      company: input.company,
      currentWeeklySpend: input.currentWeeklySpend,
    });
    let requestedBudget: number | null = null;
    if (patch.useRecommendedBudget && acceptsRecommendation('budget')) {
      requestedBudget = input.recommendations.budget?.dailyBudget ?? null;
    } else if (
      Number.isFinite(Number(patch.dailyBudget)) &&
      Number(patch.dailyBudget) > 0 &&
      (/\d/.test(latest) || /\b(hundred|thousand|lakh)\b/i.test(latest)) &&
      // The currency symbols must sit OUTSIDE the \b group: ₹ and $ are
      // non-word characters, so "\b₹" never matches after a space and that
      // alternative was silently dead. "₹500/day" — the most natural way to
      // write it — was therefore rejected unless the operator also happened
      // to type the word "budget".
      (/\b(?:budget|daily|per\s*day|a\s*day|spend|rs\.?|rupees?|inr)\b/i.test(
        latest,
      ) ||
        /[₹$]/.test(latest) ||
        /\/\s*day\b/i.test(latest))
    ) {
      requestedBudget = Number(patch.dailyBudget);
    }
    if (requestedBudget !== null) {
      plan.requestedDailyBudget = Math.round(requestedBudget);
      plan.dailyBudget = clampDailyBudget(requestedBudget, maxAllowed);
      if (plan.dailyBudget !== plan.requestedDailyBudget) {
        notes.push(
          `The requested budget was clamped to ₹${plan.dailyBudget ?? 0}/day by the current spend caps.`,
        );
      }
    }

    if (
      isFunnelStage(patch.funnelStage) &&
      new RegExp(`\\b${patch.funnelStage}\\b`, 'i').test(latest)
    )
      plan.funnelStage = patch.funnelStage;

    if (accountChanged) {
      notes.push(
        'The account changed, so any saved audience from the previous account was cleared. A broad or Advantage+ choice still applies; a specific saved audience will be verified against the new account first.',
      );
    }
    // A changed account only invalidates account-SCOPED audiences (a saved
    // lookalike belongs to one account). It must not discard a generic type
    // like Advantage+ that the operator states in the very same message —
    // that read as the assistant ignoring a clear instruction.
    if (
      !accountChanged &&
      patch.useRecommendedAudience &&
      acceptsRecommendation('audience')
    ) {
      const recommendation = input.recommendations.audience;
      if (recommendation) {
        plan.funnelStage = recommendation.funnelStage;
        plan.audienceType = recommendation.type;
        plan.audienceName = recommendation.name;
        plan.metaAudienceId = recommendation.metaAudienceId;
        plan.targetSegment = recommendation.targetSegment;
      }
    } else {
      if (
        isAudienceType(patch.audienceType) &&
        (latest.toLowerCase().includes(patch.audienceType.replace('_', ' ')) ||
          (patch.audienceType === 'advantage_plus' &&
            /advantage\+?|broad/i.test(latest)))
      ) {
        plan.audienceType = patch.audienceType;
        if (patch.audienceType === 'advantage_plus') {
          plan.audienceName = null;
          plan.metaAudienceId = null;
        }
      }
      // Saved audiences stay blocked for one turn after an account switch:
      // their IDs belong to the previous account and cannot be trusted yet.
      const requestedAudience = (
        accountChanged ? [] : (input.accountAudiences ?? [])
      ).find(
        (audience) =>
          (typeof patch.metaAudienceId === 'string' &&
            audience.id === patch.metaAudienceId &&
            latest.includes(audience.id)) ||
          (typeof patch.audienceName === 'string' &&
            normalizeName(audience.name) ===
              normalizeName(patch.audienceName) &&
            normalizeName(latest).includes(normalizeName(audience.name))),
      );
      if (requestedAudience) {
        plan.audienceName = requestedAudience.name;
        plan.metaAudienceId = requestedAudience.id;
        plan.audienceType =
          requestedAudience.type === 'lookalike'
            ? 'lookalike'
            : plan.funnelStage === 'hot'
              ? 'retarget'
              : 'custom';
      } else if (patch.metaAudienceId) {
        notes.push(
          'I ignored an audience ID that was not verified in the selected Meta account.',
        );
      }
    }

    if (typeof patch.targetSegment === 'string' && selectedProduct) {
      const segment = (selectedProduct.audienceSegments ?? []).find(
        (candidate) =>
          normalizeName(candidate.name) === normalizeName(patch.targetSegment),
      );
      if (
        segment &&
        normalizeName(latest).includes(normalizeName(segment.name))
      )
        plan.targetSegment = segment.name;
    }

    const geos = sanitizeGeoLocations(patch.geoLocations);
    const geoGrounded = geos?.every((geo) => {
      const names: Record<string, RegExp> = {
        IN: /\b(?:india|India|INDIA|IN)\b/,
        US: /\b(united states|usa|us)\b/i,
        GB: /\b(united kingdom|uk|gb)\b/i,
        CA: /\b(canada|ca)\b/i,
        AU: /\b(australia|au)\b/i,
      };
      return (names[geo] ?? new RegExp(`\\b${geo}\\b`, 'i')).test(latest);
    });
    if (geos?.length && geoGrounded) plan.geoLocations = geos;
    const language = sanitizeLanguage(patch.language);
    if (language && latest.toLowerCase().includes(language))
      plan.language = language;
    if (
      isCreativeFormat(patch.creativeFormat) &&
      latest.toLowerCase().includes(patch.creativeFormat)
    ) {
      plan.creativeFormat = patch.creativeFormat;
    } else if (
      patch.useRecommendedCreativeFormat &&
      acceptsRecommendation('format')
    ) {
      plan.creativeFormat = input.recommendations.creativeFormat;
    }
    if (
      (patch.appPlatform === 'iOS' || patch.appPlatform === 'Android') &&
      latest.toLowerCase().includes(patch.appPlatform.toLowerCase())
    ) {
      plan.appPlatform = patch.appPlatform;
    }

    for (const field of ['campaignName', 'angle', 'keyMessage'] as const) {
      const value = patch[field];
      if (
        typeof value === 'string' &&
        value.trim() &&
        normalizeName(latest).includes(normalizeName(value))
      ) {
        plan[field] = value
          .trim()
          .slice(0, field === 'keyMessage' ? 1_000 : 200);
      }
    }

    const effectiveProduct = findConfiguredProduct(
      input.company,
      plan.productName,
    );
    plan.optimizationGoal = plan.objective
      ? COPILOT_OPTIMIZATION_GOAL[plan.objective]
      : null;
    plan.pageId =
      effectiveProduct?.pageId ??
      plan.newProduct?.pageId ??
      input.company.meta?.pageId ??
      null;
    plan.conversionEvent =
      effectiveProduct?.conversionEvent ??
      plan.newProduct?.conversionEvent ??
      null;
    plan.conversionValue =
      effectiveProduct?.conversionValue ??
      plan.newProduct?.conversionValue ??
      null;

    return { plan, notes };
  }

  private clearAudience(plan: CampaignCopilotPlan): void {
    plan.audienceType = null;
    plan.audienceName = null;
    plan.metaAudienceId = null;
    plan.targetSegment = null;
  }

  private emptyNewProduct(): CampaignCopilotNewProduct {
    return {
      description: null,
      price: null,
      currency: null,
      conversionEvent: null,
      conversionValue: null,
      pixelId: null,
      customConversionId: null,
      pageId: null,
      metaAppId: null,
      metaAppStoreUrl: null,
    };
  }

  private async loadRuntimeContext(
    tenantId: string,
    accountId: string | null,
  ): Promise<RuntimeContext> {
    const company = await this.companiesService.findByTenantId(tenantId);
    const currentWeeklySpend =
      await this.campaignsService.getWeeklySpend(tenantId);
    const normalizedAccount = normalizeAccountId(accountId);
    if (
      !normalizedAccount ||
      !configuredAccountIds(company).includes(normalizedAccount) ||
      !company.meta?.accessToken
    ) {
      return {
        company,
        currentWeeklySpend,
        accountAudiences: null,
        accountAudiencesVerified: false,
        pages: null,
        pagesVerified: false,
      };
    }
    const [audienceResult, pageResult] = await Promise.allSettled([
      this.metaAdsService.listCustomAudiences(
        normalizedAccount,
        company.meta.accessToken,
      ),
      this.metaAdsService.listPages(
        company.meta.accessToken,
        company.meta.businessId,
        [normalizedAccount],
      ),
    ]);
    if (audienceResult.status === 'rejected') {
      this.logger.warn(
        `Could not verify account audiences: tenant=${tenantId} account=${normalizedAccount} error=${audienceResult.reason instanceof Error ? audienceResult.reason.message : String(audienceResult.reason)}`,
      );
    }
    if (pageResult.status === 'rejected') {
      this.logger.warn(
        `Could not verify account pages: tenant=${tenantId} account=${normalizedAccount} error=${pageResult.reason instanceof Error ? pageResult.reason.message : String(pageResult.reason)}`,
      );
    }
    return {
      company,
      currentWeeklySpend,
      accountAudiences:
        audienceResult.status === 'fulfilled'
          ? audienceResult.value.map(this.toMetaAudience)
          : null,
      accountAudiencesVerified: audienceResult.status === 'fulfilled',
      pages: pageResult.status === 'fulfilled' ? pageResult.value : null,
      pagesVerified: pageResult.status === 'fulfilled',
    };
  }

  private readonly toMetaAudience = (
    audience: MetaCustomAudience,
  ): MetaAudience => ({
    id: audience.id,
    name: audience.name,
    type: audience.type,
  });

  private systemPrompt(): string {
    return `You are Campaign Copilot, a practical Meta Ads strategist inside Meridian. You help a non-marketer turn intent into a complete campaign plan that stops at human approval.

Rules:
- Be concise, helpful, and conversational. Answer the user's question first, then ask the single highest-priority missing question.
- You may recommend a budget, objective, funnel, audience, geo, language, and creative format using ONLY the supplied tenant context and performance summaries. State when evidence is thin.
- Never invent a product, landing URL, account ID, Page ID, Pixel ID, conversion ID, audience ID, performance result, or cap.
- Existing products/accounts/audiences must use their exact configured values. If a product is absent, ask whether the user wants to configure it as NEW; collect every missing setup field.
- Do not silently apply a recommendation. Set a useRecommended* flag only after the user clearly says to use/accept/choose it.
- A plan is only being prepared for pending approval. Never claim that it is live, launched, spending, or guaranteed profitable.
- Full intelligence diagnosis needs post-launch metrics; do not pretend the 16-engine cascade has evaluated a new campaign.
- Return exactly one JSON object, no markdown, matching this shape:
{
  "reply": "natural-language response",
  "planPatch": {
    "campaignName": "optional",
    "productMode": "existing|new",
    "productName": "optional exact name",
    "landingUrl": "optional user-supplied URL",
    "newProduct": {"description":null,"price":null,"currency":null,"conversionEvent":null,"conversionValue":null,"pixelId":null,"customConversionId":null,"pageId":null,"metaAppId":null,"metaAppStoreUrl":null},
    "objective": "sales_purchase|leads|traffic|engagement|awareness|reach|app_promotion",
    "dailyBudget": null,
    "accountId": null,
    "funnelStage": "cold|warm|hot",
    "audienceType": "advantage_plus|lookalike|retarget|custom",
    "audienceName": null,
    "metaAudienceId": null,
    "targetSegment": null,
    "geoLocations": ["IN"],
    "language": "hinglish|hindi|english|marathi|tamil|telugu|bengali|gujarati|punjabi|kannada|malayalam|urdu",
    "creativeFormat": "image|video|carousel|meme",
    "appPlatform": "iOS|Android",
    "angle": null,
    "keyMessage": null,
    "useRecommendedBudget": false,
    "useRecommendedAudience": false,
    "useRecommendedAccount": false,
    "useRecommendedObjective": false,
    "useRecommendedCreativeFormat": false
  }
}
Omit unchanged planPatch fields. Never use null to erase a field.`;
  }

  private buildTurnPrompt(input: {
    company: CompanyDocument;
    currentWeeklySpend: number;
    accountAudiences: MetaAudience[] | null;
    pages?: MetaPageSummary[] | null;
    session: CampaignCopilotSessionDocument;
    recommendations: CampaignCopilotRecommendations;
    readiness: CampaignCopilotSessionDocument['readiness'];
    latestUserMessage: string;
    initial: boolean;
  }): string {
    const company = input.company;
    const learnings = company.learnings as any;
    const safeContext = {
      business: {
        name: company.name,
        industry: company.industry,
        targetAudience: company.targetAudience,
        customerLanguage: company.customerLanguage,
        tone: company.tone,
        uniqueValue: company.uniqueValue,
        geography: company.geography,
        language: company.language,
        primaryObjective: company.primaryObjective,
        preferredFormats: company.preferredFormats,
        targetROAS: company.targetROAS ?? null,
        targetCPA: company.targetCPA ?? null,
      },
      spendSafety: {
        weeklyBudgetCap: company.weeklyBudgetCap,
        maxBudgetPerCampaign: company.maxBudgetPerCampaign,
        currentWeeklyManagedSpend: input.currentWeeklySpend,
        maxDailyAvailableNow: computeMaxAllowedDailyBudget({
          company,
          currentWeeklySpend: input.currentWeeklySpend,
        }),
      },
      metaConfiguration: {
        accountIds: configuredAccountIds(company),
        pageId: company.meta?.pageId ?? null,
        pixelId: company.meta?.pixelId ?? null,
        connected: !!company.meta?.accessToken,
        selectedAccountAudiences: input.accountAudiences ?? [],
        selectedAccountPages: (input.pages ?? []).map((page) => ({
          id: page.id,
          name: page.name,
          accessible: page.accessible,
          promotable: page.promotable,
        })),
      },
      products: (company.products ?? []).map((product) => ({
        name: product.name,
        active: product.active !== false,
        price: product.price,
        currency: product.currency,
        description: product.description,
        landingUrl: product.landingUrl ?? null,
        languages: product.languages ?? [],
        conversionEvent: product.conversionEvent ?? null,
        conversionValue: product.conversionValue ?? null,
        contributionMargin: product.contributionMargin ?? null,
        pageId: product.pageId ?? null,
        pixelId: product.pixelId ?? null,
        customConversionId: product.customConversionId ?? null,
        metaAppId: product.metaAppId ?? null,
        metaAppStoreUrl: product.metaAppStoreUrl ?? null,
        metaAppStoreUrlIos: product.metaAppStoreUrlIos ?? null,
        metaAppStoreUrlAndroid: product.metaAppStoreUrlAndroid ?? null,
        audienceSegments: product.audienceSegments ?? [],
        performance: product.performance ?? null,
      })),
      learnings: learnings
        ? {
            version: learnings.version,
            creative: {
              winningHooks: learnings.creative?.winningHooks ?? [],
              losingHooks: learnings.creative?.losingHooks ?? [],
              winningFormats: learnings.creative?.winningFormats ?? [],
              losingFormats: learnings.creative?.losingFormats ?? [],
              ctaInsights: learnings.creative?.ctaInsights ?? [],
            },
            campaign: {
              audienceScores: learnings.campaign?.audienceScores ?? {},
              audienceScoresByProduct:
                learnings.campaign?.audienceScoresByProduct ?? {},
              budgetInsights: learnings.campaign?.budgetInsights ?? [],
              objectiveInsights: learnings.campaign?.objectiveInsights ?? [],
              offerAudienceFitIssues:
                learnings.campaign?.offerAudienceFitIssues ?? [],
            },
            causalInsights: (learnings.causalInsights ?? []).slice(0, 20),
            hotWinners: (learnings.hotWinners ?? [])
              .slice(0, 10)
              .map((winner: any) => ({
                productName: winner.productName,
                hookStyle: winner.hookStyle,
                audienceType: winner.audienceType,
                format: winner.format,
                spend: winner.spend,
                conversions: winner.conversions,
                cpa: winner.cpa,
                roas: winner.roas,
                budgetTier: winner.budgetTier,
                observedAt: winner.observedAt,
              })),
          }
        : null,
    };
    const transcript = input.session.messages
      .slice(-20)
      .map((message) => ({ role: message.role, content: message.content }));
    return `TENANT CONTEXT (allowlisted; selectedAccountAudiences are the only account-verified audience IDs):
${JSON.stringify(safeContext, null, 2)}

CURRENT PLAN:
${JSON.stringify(input.session.plan, null, 2)}

DETERMINISTIC RECOMMENDATIONS:
${JSON.stringify(input.recommendations, null, 2)}

READINESS:
${JSON.stringify(input.readiness, null, 2)}

RECENT TRANSCRIPT:
${JSON.stringify(transcript, null, 2)}

LATEST ${input.initial ? 'START/USER' : 'USER'} MESSAGE:
${input.latestUserMessage}`;
  }

  private async findSession(
    tenantId: string,
    sessionId: string,
  ): Promise<CampaignCopilotSessionDocument> {
    const session = await this.sessionModel
      .findOne({ tenantId, sessionId })
      .exec();
    if (!session) {
      throw new NotFoundException(
        `Campaign Copilot session "${sessionId}" not found.`,
      );
    }
    return session;
  }

  private toResponse(
    session: CampaignCopilotSessionDocument,
  ): CampaignCopilotSessionResponse {
    return {
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      status: session.status,
      messages: session.messages ?? [],
      plan: session.plan,
      recommendations:
        session.recommendations ??
        ({
          budget: null,
          audience: null,
          accountId: null,
          objective: 'sales_purchase',
          creativeFormat: 'image',
        } as CampaignCopilotRecommendations),
      readiness: session.readiness ?? {
        ready: false,
        missingFields: [],
        blockers: [],
        warnings: [],
      },
      build: session.build ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}
