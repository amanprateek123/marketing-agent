import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { AuthedRequest, brainPrincipal, Roles } from '../auth/roles';
import { FoundryBridgeService } from './foundry-bridge.service';
import { SendMessageDto } from './dto/conversation.dto';
import { GateDecisionDto } from './dto/gate-decision.dto';
import { SetTriggerEnabledDto } from './dto/trigger.dto';
import { StartAgentRunDto } from './dto/start-agent-run.dto';
import { isExperimentView } from './experiments.mapper';
import type {
  BrainAgent,
  BrainCampaignCreative,
  BrainCampaignRun,
  BrainCampaignRunSummary,
  BrainConversation,
  BrainDecision,
  BrainEventPage,
  BrainExperiment,
  BrainExperimentSummary,
  BrainGate,
  BrainGateDecisionResult,
  BrainPipelineRun,
  BrainRunDetail,
  BrainRunSummary,
  BrainState,
  BrainTrigger,
} from './brain.types';

/**
 * The Brain console's backend.
 *
 * Mounted at the root segment `brain` — `/api/v1/brain/:tenantId/...` — because that is the shape
 * `src/lib/brain-api.ts` already emits, and the frontend is the finished side of this contract.
 * A root segment also keeps these routes out of reach of an earlier `:param` route in another
 * controller, which is how a literal path silently disappears in this repo.
 *
 * Every route sits behind the global JwtAuthGuard; there is no `@Public()` here. Neither upstream
 * token — Foundry's or the brain's — is ever sent to the browser.
 *
 * BRAIN LOGIN ONLY. `@Roles('brain')` sits on the class, so every route here — and every route
 * added here later — requires the separate BRAIN_AUTH_* login. The shared workspace login gets 403;
 * with BRAIN_AUTH_* unset every route answers 503 (closed, never open). See src/auth/roles.ts.
 *
 * `tenantId` is accepted and ignored. The Brain is single-tenant: one brand, one ad account, one
 * portfolio. The parameter is in the path because the rest of this dashboard is addressed that way
 * and a console whose URLs did not match the others would be the odd one out for no gain.
 */
@Roles('brain')
@Controller('brain')
export class FoundryBridgeController {
  constructor(private readonly bridge: FoundryBridgeService) {}

  /** GET /api/v1/brain/:tenantId/state — the whole page header in one read. */
  @Get(':tenantId/state')
  async state(@Param('tenantId') _tenantId: string): Promise<BrainState> {
    return this.bridge.getState();
  }

  /** GET /api/v1/brain/:tenantId/agents — the eight agents and each one's last run. */
  @Get(':tenantId/agents')
  async agents(@Param('tenantId') _tenantId: string): Promise<BrainAgent[]> {
    return this.bridge.getAgents();
  }

  /** GET /api/v1/brain/:tenantId/decisions — what the Brain decided, and why. */
  @Get(':tenantId/decisions')
  async decisions(
    @Param('tenantId') _tenantId: string,
  ): Promise<BrainDecision[]> {
    return this.bridge.getDecisions();
  }

  /** GET /api/v1/brain/:tenantId/gates — everything waiting on a person. */
  @Get(':tenantId/gates')
  async gates(@Param('tenantId') _tenantId: string): Promise<BrainGate[]> {
    return this.bridge.getGates();
  }

  /**
   * GET /api/v1/brain/:tenantId/experiments/summary — how many experiments sit on each shelf
   * (testing / learned / dropped), overall and per product. `partial: true` means the brain cut a
   * read short and a count is a floor.
   */
  @Get(':tenantId/experiments/summary')
  async experimentSummary(
    @Param('tenantId') _tenantId: string,
  ): Promise<BrainExperimentSummary> {
    return this.bridge.getExperimentSummary();
  }

  /**
   * GET /api/v1/brain/:tenantId/experiments?view=testing|learned|dropped&product=<productKey>
   *
   * Plain-language experiments: a claim sentence, a kind and status label, progress for live tests
   * and a result sentence for judged ones. No attribute codes, enum values or ids reach the page;
   * `ref` is opaque. An unknown `view` is treated as `testing` rather than refused — the tab's
   * default shelf.
   */
  @Get(':tenantId/experiments')
  async experiments(
    @Param('tenantId') _tenantId: string,
    @Query('view') view?: string,
    @Query('product') product?: string,
  ): Promise<BrainExperiment[]> {
    return this.bridge.getExperiments(
      isExperimentView(view) ? view : 'testing',
      product && product.trim() ? product.trim() : null,
    );
  }

  /**
   * GET /api/v1/brain/:tenantId/pipeline — the open creative run, or null.
   *
   * Null is a real answer: no campaign is being built right now. The console draws an empty
   * pipeline for it rather than an error.
   */
  @Get(':tenantId/pipeline')
  async pipeline(
    @Param('tenantId') _tenantId: string,
  ): Promise<BrainPipelineRun | null> {
    return this.bridge.getPipeline();
  }

  /**
   * GET /api/v1/brain/:tenantId/pipeline/runs?limit=N — every campaign run, newest first.
   *
   * The three routes below are the non-technical view of the same machinery `/pipeline` exposes.
   * They exist separately rather than as a richer `/pipeline` because they answer a different
   * question: `/pipeline` is "is anything in flight", these are "what did we build, and what is
   * actually going out". Declared most-specific-first, as `runs/:runId/events` is above.
   */
  @Get(':tenantId/pipeline/runs')
  async campaignRuns(
    @Param('tenantId') _tenantId: string,
    @Query('limit') limit?: string,
  ): Promise<BrainCampaignRunSummary[]> {
    const parsed = Number(limit);
    return this.bridge.getCampaignRuns(
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 25,
    );
  }

  /** GET /api/v1/brain/:tenantId/pipeline/runs/:runId/creatives — the ads that will go live. */
  @Get(':tenantId/pipeline/runs/:runId/creatives')
  async campaignRunCreatives(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
  ): Promise<BrainCampaignCreative[]> {
    return this.bridge.getCampaignRunCreatives(runId);
  }

  /** GET /api/v1/brain/:tenantId/pipeline/runs/:runId — one campaign run, in plain language. */
  @Get(':tenantId/pipeline/runs/:runId')
  async campaignRun(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
  ): Promise<BrainCampaignRun> {
    return this.bridge.getCampaignRun(runId);
  }

  /** GET /api/v1/brain/:tenantId/runs — recent runs across every agent on this console. */
  @Get(':tenantId/runs')
  async runs(@Param('tenantId') _tenantId: string): Promise<BrainRunSummary[]> {
    return this.bridge.getRuns();
  }

  /**
   * GET /api/v1/brain/:tenantId/runs/:runId/events?after=<cursor>
   *
   * Declared BEFORE `runs/:runId`. Nest matches in declaration order, and a two-segment route
   * registered after a one-segment `:param` route still resolves, but keeping the more specific
   * path first removes the question entirely.
   */
  @Get(':tenantId/runs/:runId/events')
  async events(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
    @Query('after') after?: string,
  ): Promise<BrainEventPage> {
    const cursor = Number(after);
    return this.bridge.getRunEvents(
      runId,
      Number.isFinite(cursor) && cursor > 0 ? cursor : 0,
    );
  }

  /** GET /api/v1/brain/:tenantId/runs/:runId — one run, its steps and its output. */
  @Get(':tenantId/runs/:runId')
  async run(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
  ): Promise<BrainRunDetail> {
    return this.bridge.getRun(runId);
  }

  /**
   * POST /api/v1/brain/:tenantId/agents/:agentKey/runs
   *
   * Returns as soon as Foundry accepts the run. Starting an agent the Brain owns is refused here,
   * in the transport, and not only in the UI.
   */
  @Post(':tenantId/agents/:agentKey/runs')
  async startRun(
    @Param('tenantId') _tenantId: string,
    @Param('agentKey') agentKey: string,
    @Body() dto: StartAgentRunDto,
  ): Promise<{ runId: string }> {
    return this.bridge.startRun(agentKey, { ...dto });
  }

  /**
   * GET /api/v1/brain/:tenantId/agents/:agentKey/triggers
   *
   * What starts this agent, and whether it is on. A paused schedule is invisible until something
   * does not happen — which is how four stage agents read as broken for six days when they had
   * been correctly replaced by a sweeper.
   */
  @Get(':tenantId/agents/:agentKey/triggers')
  async triggers(
    @Param('tenantId') _tenantId: string,
    @Param('agentKey') agentKey: string,
  ): Promise<BrainTrigger[]> {
    return this.bridge.getAgentTriggers(agentKey);
  }

  /**
   * PATCH /api/v1/brain/:tenantId/agents/:agentKey/triggers/:triggerId
   *
   * Pause or resume. Nothing else — the transport itself is restricted to `list_triggers` and
   * `update_trigger`, because the token behind them can rewrite the agent.
   */
  @Patch(':tenantId/agents/:agentKey/triggers/:triggerId')
  async setTrigger(
    @Param('tenantId') _tenantId: string,
    @Param('agentKey') agentKey: string,
    @Param('triggerId') triggerId: string,
    @Body() dto: SetTriggerEnabledDto,
  ): Promise<BrainTrigger | null> {
    return this.bridge.setTriggerEnabled(agentKey, triggerId, dto.enabled);
  }

  /** POST /api/v1/brain/:tenantId/runs/:runId/cancel — stop an in-flight run. */
  @Post(':tenantId/runs/:runId/cancel')
  async cancel(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
  ): Promise<{ ok: true }> {
    return this.bridge.cancelRun(runId);
  }

  /**
   * POST /api/v1/brain/:tenantId/gates/:gateId/decision
   *
   * The same rows Slack decides, through the same tools. The two surfaces share state rather than
   * synchronising: a gate answered here reads as answered from Slack, and vice versa, because
   * neither holds a copy.
   */
  @Post(':tenantId/gates/:gateId/decision')
  async decideGate(
    @Param('tenantId') _tenantId: string,
    @Param('gateId') gateId: string,
    @Body() dto: GateDecisionDto,
    @Req() req: AuthedRequest,
  ): Promise<BrainGateDecisionResult> {
    // RolesGuard has already required a brain principal; the decision is recorded under it.
    const user = req.user!;
    return this.bridge.decideGate(gateId, dto, {
      principal: brainPrincipal(user),
      displayName: user.sub,
    });
  }

  // ── conversation ─────────────────────────────────────────────────────────

  /**
   * GET /api/v1/brain/:tenantId/conversation/:sessionId — the thread so far, oldest first.
   *
   * The session id is the console's to choose and to keep. It is a durable thread, not a request:
   * the same id tomorrow continues the same conversation, which is the whole reason
   * `conversation_turns` exists.
   */
  @Get(':tenantId/conversation/:sessionId')
  async conversation(
    @Param('tenantId') _tenantId: string,
    @Param('sessionId') sessionId: string,
    @Query('limit') limit?: string,
  ): Promise<BrainConversation> {
    const parsed = Number(limit);
    return this.bridge.readConversation(
      sessionId,
      Number.isFinite(parsed) && parsed > 0 ? parsed : 20,
    );
  }

  /**
   * POST /api/v1/brain/:tenantId/conversation/:sessionId/messages
   *
   * Writes the turn, then starts the run that answers it, and hands back the run id so the console
   * streams the reply through the same events route everything else uses.
   * `correlationId` is what the Brain (2.11.0+) stamps as the `run_id` of its answering turn, so the
   * console matches the answer on it and falls back to `runId` for an older Brain. The Brain writes its own
   * side of the conversation when it commits — nothing here puts words in its mouth.
   */
  @Post(':tenantId/conversation/:sessionId/messages')
  async sendMessage(
    @Param('tenantId') _tenantId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: SendMessageDto,
  ): Promise<{ runId: string; correlationId: string; sessionId: string }> {
    return this.bridge.sendConversationMessage(
      sessionId,
      dto.message,
      dto.mode,
    );
  }
}
