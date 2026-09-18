import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AGENTS_BY_KEY, BRAIN_AGENTS } from './agents.registry';
import { McpClient, McpToolError, McpTransportError } from './mcp.client';
import {
  humanizeKey,
  mapDecision,
  mapRunDetail,
  mapRunEvents,
  mapRunSummary,
} from './mappers';
import type {
  BrainAgent,
  BrainConversation,
  BrainConversationTurn,
  BrainAgentKey,
  BrainAllocation,
  BrainAttentionItem,
  BrainDecision,
  BrainEventPage,
  BrainGate,
  BrainGateAction,
  BrainGateDecisionBody,
  BrainIdea,
  BrainPipelineRun,
  BrainPipelineStage,
  BrainRunDetail,
  BrainRunSummary,
  BrainStageKey,
  BrainStageState,
  BrainState,
} from './brain.types';

/**
 * The dashboard's route to Brain v2 and the agents around it.
 *
 * Two upstreams, deliberately not one:
 *
 *   THE BRAIN'S OWN MCP is where reads come from. Decisions, gates, plans and the pipeline queue
 *   are rows in Postgres that the Brain writes as it works, so reading them costs a query rather
 *   than a run. Replaying a Foundry run to find out what the Brain decided would cost dollars and
 *   minutes to recover something already written down.
 *
 *   FOUNDRY'S RUN API is where runs come from, and it is the only thing that can start one.
 *
 * Each is configured independently and each degrades independently. A dead Foundry gives a page
 * with `connected: false` and no run history; a dead brain gives a page with no decisions. Neither
 * blanks the console, because "could not read" and "there is nothing" are different facts and the
 * console draws them differently.
 */
@Injectable()
export class FoundryBridgeService {
  private readonly logger = new Logger(FoundryBridgeService.name);
  private readonly foundry: McpClient;
  private readonly brain: McpClient;
  /**
   * The Slack id the brain's approval allowlist recognises, held server-side.
   *
   * `approval_record` enforces `APPROVAL_SLACK_IDS` inside the brain, on purpose: approving in a
   * Slack channel means anyone who can type in it can type "approve". The dashboard has a real
   * login, but the brain has no way to see it, so a console decision still has to arrive carrying
   * an identity the allowlist knows. This is that identity — one operator id, never sent to the
   * browser, and useless without a JWT to reach this route at all.
   *
   * Unset, gate decisions 503 with a message naming the variable, rather than being sent upstream
   * to fail as an authorization fault and leave the operator staring at a gate that will not close.
   */
  private readonly approvalActorSlackId: string;

  constructor(private readonly config: ConfigService) {
    this.foundry = new McpClient(
      (this.config.get<string>('foundry.url') ?? '').trim(),
      (this.config.get<string>('foundry.token') ?? '').trim(),
      this.config.get<number>('foundry.timeoutMs') ?? 60000,
      'foundry',
    );
    this.brain = new McpClient(
      (this.config.get<string>('brain.url') ?? '').trim(),
      (this.config.get<string>('brain.token') ?? '').trim(),
      this.config.get<number>('brain.timeoutMs') ?? 30000,
      'brain',
    );
    this.approvalActorSlackId = (
      this.config.get<string>('brain.approvalActorSlackId') ?? ''
    ).trim();
  }

  isConfigured(): boolean {
    return this.foundry.isConfigured() || this.brain.isConfigured();
  }

  private assertFoundry(): void {
    if (!this.foundry.isConfigured()) {
      throw new ServiceUnavailableException(
        'Foundry is not configured (set FOUNDRY_RUN_MCP_URL and FOUNDRY_RUN_TOKEN).',
      );
    }
  }

  private assertBrain(): void {
    if (!this.brain.isConfigured()) {
      throw new ServiceUnavailableException(
        'The brain is not configured (set BRAIN_MCP_URL and BRAIN_MCP_BEARER_TOKEN).',
      );
    }
  }

  /**
   * Translate an MCP failure into an HTTP one.
   *
   * The same split `pipeline-bridge` makes: a tool that answered and refused carries a message the
   * operator needs verbatim, so it becomes a 400 with that message. Only an unreachable upstream
   * becomes a 502.
   */
  private rethrow(err: unknown): never {
    if (err instanceof McpToolError) {
      throw new BadRequestException(
        err.detail ? `${err.message}: ${err.detail}` : err.message,
      );
    }
    if (err instanceof McpTransportError) {
      this.logger.error(err.message);
      throw new BadGatewayException(err.message);
    }
    throw err;
  }

  // ── state ────────────────────────────────────────────────────────────────

  /**
   * One read for the whole page header.
   *
   * Every section is a `tryCall`, so a page renders with whatever is reachable. `connected` means
   * FOUNDRY specifically — it is the thing that answers "can this console still start work" — and
   * it is false rather than an error, because a console that throws on an unreachable agent
   * platform tells the operator less than one that renders and says so.
   */
  async getState(): Promise<BrainState> {
    const now = new Date().toISOString();
    const [runnable, hint, planRead, pipeline, gates] = await Promise.all([
      this.foundry.isConfigured()
        ? this.foundry.tryCall<{ agents?: unknown[] }>('list_runnable_agents')
        : Promise.resolve(null),
      this.brain.isConfigured()
        ? this.brain.tryCall<Record<string, unknown>>('brain_mode_hint')
        : Promise.resolve(null),
      this.brain.isConfigured()
        ? this.brain.tryCall<{ rows?: unknown[] }>('brain_read', {
            table: 'daily_plans',
            order: 'plan_date.desc',
            limit: 1,
          })
        : Promise.resolve(null),
      this.getPipelineOrNull(),
      this.getGatesOrEmpty(),
    ]);

    const connected = runnable !== null;
    const grantedIds = new Set(
      ((runnable?.agents ?? []) as Array<{ agent_id?: string }>)
        .map((a) => a?.agent_id)
        .filter((id): id is string => typeof id === 'string'),
    );
    // "Live" means this token can actually run it. An agent the registry calls live but the run
    // token does not grant is not live to this console, and saying otherwise would send the
    // operator to a Run button that 403s.
    const agentsLive = BRAIN_AGENTS.filter((a) =>
      grantedIds.has(a.foundryAgentId),
    ).length;

    const hasWork = hint?.has_work;
    const idleWhy = typeof hint?.idle_why === 'string' ? hint.idle_why : null;
    const suggested =
      typeof hint?.suggested_mode === 'string' ? hint.suggested_mode : null;

    const plan = (planRead?.rows ?? [])[0] as
      | Record<string, unknown>
      | undefined;
    const allocations = this.planAllocations(plan);

    return {
      generatedAt: now,
      connected,
      brain: {
        // Driven by whether the BRAIN answered, not by whether Foundry did. Reading the brain
        // successfully and then reporting it "offline" because the agent platform is unreachable
        // was wrong on the first live run: `connected` already carries the Foundry fact, on its
        // own field, and the page draws them separately.
        status:
          hint === null
            ? 'offline'
            : hasWork === true
              ? 'thinking'
              : hasWork === false
                ? 'idle'
                : 'blocked',
        headline:
          hasWork === true
            ? `Work queued${suggested ? ` — next: ${suggested}` : ''}`
            : hasWork === false
              ? (idleWhy ?? 'Nothing is waiting.')
              : hint === null
                ? 'The brain could not be read.'
                : 'Standing by.',
        posture: 'Records and proposes. It does not act on the ad account.',
        lastCycleAt:
          typeof plan?.plan_date === 'string' ? plan.plan_date : null,
        // The daily review runs at 04:30 UTC (10:00 IST). Derived from the trigger's own cron
        // rather than read back from Foundry, which exposes no "next fire" on this API.
        nextCycleAt: nextDailyCycle(now),
        version: '2.6.0',
      },
      budget: {
        dailyTotal: typeof plan?.budget_inr === 'number' ? plan.budget_inr : 0,
        changedAt: typeof plan?.plan_date === 'string' ? plan.plan_date : null,
        allocations,
      },
      pipeline,
      openGates: gates.length,
      agentsLive,
      agentsTotal: BRAIN_AGENTS.length,
      attention: this.attentionFrom(
        hint,
        gates.length,
        connected,
        planRead === null,
      ),
    };
  }

  private planAllocations(
    plan: Record<string, unknown> | undefined,
  ): BrainAllocation[] {
    const budget = typeof plan?.budget_inr === 'number' ? plan.budget_inr : 0;
    const rows = Array.isArray(plan?.allocations) ? plan.allocations : [];
    return rows
      .map((raw) =>
        raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {},
      )
      .map((row): BrainAllocation | null => {
        const product =
          typeof row.offering_slug === 'string' ? row.offering_slug : null;
        const amount =
          typeof row.amount_inr === 'number' ? row.amount_inr : null;
        if (!product || amount === null) return null;
        return {
          product,
          dailyBudget: amount,
          previousDailyBudget: null,
          share: budget > 0 ? amount / budget : 0,
          reason: typeof row.reason === 'string' ? row.reason : '',
          health: 'unknown',
        };
      })
      .filter((a): a is BrainAllocation => a !== null);
  }

  private attentionFrom(
    hint: Record<string, unknown> | null,
    openGates: number,
    connected: boolean,
    brainUnreadable: boolean,
  ): BrainAttentionItem[] {
    const items: BrainAttentionItem[] = [];
    if (!connected) {
      items.push({
        id: 'foundry-unreachable',
        label: 'Foundry is unreachable',
        detail:
          'Run history and starting an agent are unavailable. Decisions and gates below are read from the brain and are still current.',
        severity: 'bad',
        tab: 'agents',
      });
    }
    if (brainUnreadable) {
      items.push({
        id: 'brain-unreadable',
        label: 'The brain could not be read',
        detail:
          'Budget, decisions and gates on this page may be missing rather than empty.',
        severity: 'bad',
        tab: 'decisions',
      });
    }
    if (openGates > 0) {
      items.push({
        id: 'gates-open',
        label: `${openGates} decision${openGates === 1 ? '' : 's'} waiting on you`,
        detail: 'Nothing moves past a gate until somebody answers it.',
        severity: 'watch',
        tab: 'approvals',
      });
    }
    const work = Array.isArray(hint?.work) ? hint.work : [];
    for (const raw of work.slice(0, 4)) {
      const item =
        raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : null;
      const label =
        item && typeof item.what === 'string'
          ? item.what
          : typeof raw === 'string'
            ? raw
            : null;
      if (!label) continue;
      items.push({
        id: `work-${items.length}`,
        label,
        detail:
          item && typeof item.detail === 'string'
            ? item.detail
            : 'Queued for the next review.',
        severity: 'neutral',
        tab: null,
      });
    }
    return items;
  }

  // ── agents ───────────────────────────────────────────────────────────────

  /**
   * The registry, plus each agent's most recent run.
   *
   * One `list_runs` for all of them rather than one per agent: the run history is already ordered
   * newest-first, so the first row seen for an agent is its last run.
   */
  async getAgents(): Promise<BrainAgent[]> {
    const [listed, runnable] = await Promise.all([
      this.foundry.isConfigured()
        ? this.foundry.tryCall<{ runs?: unknown[] }>('list_runs', { limit: 50 })
        : Promise.resolve(null),
      this.foundry.isConfigured()
        ? this.foundry.tryCall<{ agents?: unknown[] }>('list_runnable_agents')
        : Promise.resolve(null),
    ]);
    const grantedIds = new Set(
      ((runnable?.agents ?? []) as Array<{ agent_id?: string }>)
        .map((a) => a?.agent_id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const lastByAgent = new Map<BrainAgentKey, BrainRunSummary>();
    for (const raw of listed?.runs ?? []) {
      const row =
        raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const summary = mapRunSummary(row);
      if (summary && !lastByAgent.has(summary.agentKey))
        lastByAgent.set(summary.agentKey, summary);
    }
    return BRAIN_AGENTS.map((definition) => ({
      ...definition,
      nextRunAt: definition.schedule
        ? nextDailyCycle(new Date().toISOString())
        : null,
      lastRun: lastByAgent.get(definition.key) ?? null,
      // Unreachable Foundry means unknown rather than refused — but `false` is the honest
      // rendering either way, because a Run button that cannot work should not look like one
      // that can. The console previously had no way to learn this except by starting a run and
      // reading the refusal out of a 502.
      runnable: grantedIds.has(definition.foundryAgentId),
    }));
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  async getRuns(): Promise<BrainRunSummary[]> {
    this.assertFoundry();
    try {
      const listed = await this.foundry.call<{ runs?: unknown[] }>(
        'list_runs',
        { limit: 50 },
      );
      return (listed.runs ?? [])
        .map((raw) =>
          raw && typeof raw === 'object'
            ? (raw as Record<string, unknown>)
            : {},
        )
        .map(mapRunSummary)
        .filter((r): r is BrainRunSummary => r !== null);
    } catch (err) {
      this.rethrow(err);
    }
  }

  async getRun(runId: string): Promise<BrainRunDetail> {
    const run = await this.readRun(runId);
    const summary = mapRunSummary(run);
    if (!summary) {
      throw new NotFoundException(
        `Run ${runId} belongs to an agent this console does not show, or carries no agent id.`,
      );
    }
    return mapRunDetail(run, summary, this.runInputs(run));
  }

  /**
   * Foundry does not return a run's inputs, so they are reconstructed from what it does return.
   *
   * An empty object is the honest answer when nothing is recoverable — the detail panel renders
   * "no inputs recorded" rather than a fabricated question the operator never asked.
   */
  private runInputs(run: Record<string, unknown>): Record<string, string> {
    const raw = run.inputs;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
      else if (typeof value === 'number' || typeof value === 'boolean')
        out[key] = String(value);
    }
    return out;
  }

  private async readRun(runId: string): Promise<Record<string, unknown>> {
    this.assertFoundry();
    try {
      return await this.foundry.call<Record<string, unknown>>('get_run', {
        run_id: runId,
        include_steps: true,
      });
    } catch (err) {
      this.rethrow(err);
    }
  }

  /**
   * Cursor-paged events, `after` being the last `seq` the caller already has.
   *
   * `done` is the run being settled, not the page being empty: a running agent between steps
   * legitimately returns nothing new, and reporting that as done would stop the caller polling a
   * run that has not finished.
   */
  async getRunEvents(runId: string, after: number): Promise<BrainEventPage> {
    const run = await this.readRun(runId);
    const all = mapRunEvents(run);
    const fresh = all.filter((event) => event.seq > after);
    return {
      events: fresh,
      cursor: all.length ? all[all.length - 1].seq : after,
      done: run.finished === true,
    };
  }

  /**
   * Start an on-demand agent.
   *
   * THE INVOCATION CHECK IS HERE, not only in the UI. The console already refuses to start a
   * `brain_triggered` agent, but a stale tab, a replayed request or a direct call would sail past
   * that; the Brain owns when the creative chain runs, and a person starting a Builder out of band
   * would put a campaign into a pipeline run that nothing is tracking.
   *
   * `wait_seconds: 0` returns as soon as Foundry accepts the run. The console polls from there —
   * a Brain review takes minutes, and an HTTP request held open for it would time out somewhere in
   * the middle and report a failure to a run that was working perfectly.
   */
  async startRun(
    agentKey: string,
    input: Record<string, unknown>,
  ): Promise<{ runId: string }> {
    const definition = AGENTS_BY_KEY.get(agentKey as BrainAgentKey);
    if (!definition) throw new NotFoundException(`No agent '${agentKey}'.`);
    if (definition.invocation !== 'on_demand') {
      throw new ForbiddenException(
        `${definition.name} is started by the Brain, not by hand. Starting it out of band would ` +
          'put work into a pipeline run nothing is tracking.',
      );
    }
    this.assertFoundry();
    const inputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input ?? {})) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && !value.trim()) continue;
      inputs[key] = value;
    }
    try {
      const started = await this.foundry.call<Record<string, unknown>>(
        'run_agent',
        {
          agent_id: definition.foundryAgentId,
          inputs,
          wait_seconds: 0,
          include_summary: false,
        },
      );
      const runId = typeof started.run_id === 'string' ? started.run_id : null;
      if (!runId) {
        throw new BadGatewayException(
          'Foundry accepted the run but returned no run id.',
        );
      }
      return { runId };
    } catch (err) {
      this.rethrow(err);
    }
  }

  async cancelRun(runId: string): Promise<{ ok: true }> {
    this.assertFoundry();
    try {
      await this.foundry.call('cancel_run', { run_id: runId });
      return { ok: true };
    } catch (err) {
      this.rethrow(err);
    }
  }

  // ── decisions ────────────────────────────────────────────────────────────

  async getDecisions(): Promise<BrainDecision[]> {
    this.assertBrain();
    try {
      const read = await this.brain.call<{
        rows?: unknown[];
        decisions?: unknown[];
      }>('decisions_read', { limit: 50 });
      const rows = read.rows ?? read.decisions ?? [];
      return rows
        .map((raw) =>
          raw && typeof raw === 'object'
            ? (raw as Record<string, unknown>)
            : {},
        )
        .map(mapDecision)
        .filter((d): d is BrainDecision => d !== null);
    } catch (err) {
      this.rethrow(err);
    }
  }

  // ── pipeline ─────────────────────────────────────────────────────────────

  private async getPipelineOrNull(): Promise<BrainPipelineRun | null> {
    if (!this.brain.isConfigured()) return null;
    const read = await this.brain.tryCall<{ rows?: unknown[] }>(
      'pipeline_run_read',
      {
        status: 'open',
        limit: 1,
      },
    );
    const row = (read?.rows ?? [])[0];
    if (!row || typeof row !== 'object') return null;
    return this.mapPipelineRun(row as Record<string, unknown>);
  }

  async getPipeline(): Promise<BrainPipelineRun | null> {
    this.assertBrain();
    return this.getPipelineOrNull();
  }

  /**
   * One pipeline run as four stages.
   *
   * The brain stores a single `stage` string, not a per-stage record, so the four stages are
   * derived from where the run currently is: stages before it are done, the current one is running
   * (or waiting, or failed, matching the run's own status), and the ones after are idle. That is an
   * inference from one field and it is marked as such — no stage gets a start or finish time it
   * cannot prove, and `artifacts` stays empty rather than being populated with guesses.
   */
  private mapPipelineRun(row: Record<string, unknown>): BrainPipelineRun {
    const ORDER: Array<{
      key: BrainStageKey;
      stage: string;
      agentKey: BrainAgentKey;
      label: string;
      description: string;
    }> = [
      {
        key: 'producer',
        stage: 'producing',
        agentKey: 'creative-producer',
        label: 'Produce',
        description: 'Turn the briefed idea into a batch of creatives.',
      },
      {
        key: 'curator',
        stage: 'curating',
        agentKey: 'creative-curator',
        label: 'Curate',
        description: 'Judge the batch and decide which are fit to run.',
      },
      {
        key: 'builder',
        stage: 'building',
        agentKey: 'campaign-builder',
        label: 'Build',
        description: 'Build the campaign, ad set and ad — all paused.',
      },
      {
        key: 'launcher',
        stage: 'launching',
        agentKey: 'campaign-launcher',
        label: 'Launch',
        description: 'Get a human decision, then activate every level in Meta.',
      },
    ];
    const current = typeof row.stage === 'string' ? row.stage : 'planned';
    const status = typeof row.status === 'string' ? row.status : 'open';
    const currentIndex = ORDER.findIndex((s) => s.stage === current);
    const runId =
      row.id === undefined || row.id === null ? null : String(row.id);

    const stages: BrainPipelineStage[] = ORDER.map((entry, index) => {
      let state: BrainStageState = 'idle';
      if (current === 'done') state = 'done';
      else if (currentIndex === -1) state = 'idle';
      else if (index < currentIndex) state = 'done';
      else if (index === currentIndex) {
        state =
          status === 'blocked'
            ? 'blocked'
            : status === 'failed' || status === 'short'
              ? 'failed'
              : status === 'awaiting_human'
                ? 'waiting_for_human'
                : 'running';
      }
      return {
        key: entry.key,
        agentKey: entry.agentKey,
        label: entry.label,
        description: entry.description,
        state,
        runId,
        detail:
          index === currentIndex && typeof row.notes === 'string'
            ? row.notes
            : null,
        // The brain records no per-stage timing, and a time this bridge invented would read on the
        // page as a measurement.
        startedAt: null,
        finishedAt: null,
        artifacts: [],
        gateId: null,
      };
    });

    return {
      pipelineRunId: runId ?? 'unknown',
      product:
        typeof row.offering_slug === 'string' ? row.offering_slug : 'unknown',
      triggeredBy: 'Brain',
      startedAt:
        typeof row.plan_date === 'string'
          ? row.plan_date
          : new Date(0).toISOString(),
      status:
        current === 'done'
          ? 'succeeded'
          : status === 'blocked' || status === 'awaiting_human'
            ? 'waiting_for_human'
            : status === 'failed' || status === 'short'
              ? 'failed'
              : 'running',
      headline: `${typeof row.offering_slug === 'string' ? row.offering_slug : 'A product'} — ${humanizeKey(current)}`,
      stages,
    };
  }

  // ── gates ────────────────────────────────────────────────────────────────

  private async getGatesOrEmpty(): Promise<BrainGate[]> {
    if (!this.brain.isConfigured()) return [];
    try {
      return await this.getGates();
    } catch {
      return [];
    }
  }

  /**
   * Everything waiting on a person, from the two places the brain keeps it.
   *
   * SPEND GATES live in `approvals` — `plan`, `build`, `launch` and `scale`. Both the posted queue
   * and the unposted one are read: `approvals_pending` filters to gates that already reached Slack,
   * which would leave a gate opened two minutes ago invisible on this page until a daemon cycle
   * caught up. Reading the outbox is not draining it — nothing here calls `approval_mark_posted`,
   * so the daemon remains the only thing that posts.
   *
   * IDEA GATES are not approvals at all. A proposed idea is a row in `ideas` waiting for somebody
   * to approve or retire it, and `update_idea` is its decision path. It is a gate in every sense
   * that matters to an operator, so it is presented as one.
   *
   * There is NO `creative_craft` gate, and this returns none. The Curator's rubric verdicts are not
   * written anywhere a human is asked to confirm them; the fit/unfit call is the Curator's own and
   * the human gate comes later, at build and launch. Manufacturing an empty craft gate here would
   * put a decision on the page that nothing downstream is waiting for.
   */
  async getGates(): Promise<BrainGate[]> {
    this.assertBrain();
    const [pending, unposted, ideas] = await Promise.all([
      this.brain.tryCall<{ rows?: unknown[] }>('approvals_pending', {
        limit: 50,
      }),
      this.brain.tryCall<{ rows?: unknown[] }>('approvals_unposted', {
        limit: 50,
      }),
      this.brain.tryCall<{ rows?: unknown[] }>('brain_read', {
        table: 'ideas',
        where: { status: 'proposed' },
        order: 'id.desc',
        limit: 25,
      }),
    ]);
    if (pending === null && unposted === null && ideas === null) {
      throw new BadGatewayException(
        'The brain could not be read for open gates.',
      );
    }

    const seen = new Set<string>();
    const gates: BrainGate[] = [];
    for (const raw of [...(pending?.rows ?? []), ...(unposted?.rows ?? [])]) {
      const row =
        raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const id =
        row.id === undefined || row.id === null ? null : String(row.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      gates.push(this.mapApprovalGate(id, row));
    }

    const proposed = (ideas?.rows ?? [])
      .map((raw) =>
        raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {},
      )
      .map((row): BrainIdea | null => {
        const id =
          row.id === undefined || row.id === null ? null : String(row.id);
        const title = typeof row.title === 'string' ? row.title : null;
        if (!id || !title) return null;
        return {
          id,
          title,
          angle: typeof row.angle === 'string' ? row.angle : '',
          product:
            typeof row.offering_slug === 'string'
              ? row.offering_slug
              : 'unassigned',
          rationale: typeof row.hypothesis === 'string' ? row.hypothesis : '',
          state: 'proposed',
        };
      })
      .filter((i): i is BrainIdea => i !== null);

    if (proposed.length) {
      // One gate for the whole batch, not one per idea. Choosing which ideas to pursue is a single
      // comparative decision — approving them one at a time by separate cards loses the comparison
      // that makes the choice meaningful.
      gates.push({
        gateId: 'ideas:proposed',
        kind: 'idea_selection',
        title: `${proposed.length} idea${proposed.length === 1 ? '' : 's'} proposed`,
        summary:
          'Approved ideas can be briefed and produced. Anything not selected is retired — an idea left ' +
          'in `proposed` blocks nothing, but it also never gets made.',
        askedBy: 'Competitor Research',
        askedAt: new Date().toISOString(),
        product: null,
        slackChannel: null,
        slackPermalink: null,
        expiresAt: null,
        runId: null,
        payload: { kind: 'idea_selection', ideas: proposed },
        actions: GATE_ACTIONS,
        selection: 'multiple',
      });
    }

    return gates;
  }

  private mapApprovalGate(id: string, row: Record<string, unknown>): BrainGate {
    const gate = typeof row.gate === 'string' ? row.gate : 'plan';
    const summary = typeof row.summary === 'string' ? row.summary : '';
    const planDate = typeof row.plan_date === 'string' ? row.plan_date : null;
    const slackTs = typeof row.slack_ts === 'string' ? row.slack_ts : null;
    const isPlan = gate === 'plan';
    return {
      gateId: `approval:${id}`,
      kind: isPlan ? 'plan_approval' : 'campaign_launch',
      title: isPlan
        ? `Day plan${planDate ? ` for ${planDate}` : ''}`
        : `${humanizeKey(gate)} gate — run ${row.pipeline_run_id ?? '?'}`,
      summary,
      askedBy: 'Brain',
      askedAt:
        typeof row.created_at === 'string'
          ? row.created_at
          : new Date().toISOString(),
      product: typeof row.offering_slug === 'string' ? row.offering_slug : null,
      slackChannel:
        typeof row.slack_channel === 'string' ? row.slack_channel : null,
      // The brain stores a channel and a ts, not a permalink, and a permalink assembled from them
      // without the workspace domain would be a link that 404s.
      slackPermalink: null,
      expiresAt: null,
      runId: null,
      payload: isPlan
        ? {
            kind: 'plan_approval',
            plan: {
              planDate,
              budgetInr:
                typeof row.amount_override_inr === 'number'
                  ? row.amount_override_inr
                  : null,
              summary,
              posted: slackTs !== null,
            },
          }
        : {
            kind: 'campaign_launch',
            campaign: {
              name:
                typeof row.creative_key === 'string'
                  ? row.creative_key
                  : `Run ${row.pipeline_run_id ?? '?'}`,
              objective: humanizeKey(gate),
              dailyBudget:
                typeof row.amount_override_inr === 'number'
                  ? row.amount_override_inr
                  : 0,
              audience: 'See the review below.',
              placements: 'See the review below.',
              creatives: [],
              // The gate's whole review is prose written by the agent that opened it — it is the
              // thing a person is meant to read, so it is presented whole rather than chopped into
              // fields this bridge would have to invent.
              levels: [{ label: 'Review', value: summary, note: null }],
              checks: [],
            },
          },
      actions: GATE_ACTIONS,
      selection: 'none',
    };
  }

  /**
   * Answer a gate.
   *
   * Two different stores, two different decision paths, one route — so the dashboard and Slack can
   * never disagree about what a decision means, because both write the same row through the same
   * tool.
   *
   * A REFUSED WRITE IS REPORTED AS A FAILURE. `approval_record` can come back `recorded: false` in
   * two very different ways — an authorization fault (the gate stays decidable) or a gate that was
   * already decided (it never will be) — and both must reach the operator as errors. Returning
   * `{ok: true}` on either would close the card in front of them over a gate that is still open.
   */
  async decideGate(
    gateId: string,
    body: BrainGateDecisionBody,
  ): Promise<{ ok: true }> {
    this.assertBrain();
    if (gateId === 'ideas:proposed') return this.decideIdeas(body);
    if (!gateId.startsWith('approval:')) {
      throw new NotFoundException(`No gate '${gateId}'.`);
    }
    const id = Number(gateId.slice('approval:'.length));
    if (!Number.isInteger(id))
      throw new BadRequestException(`Malformed gate id '${gateId}'.`);
    if (body.action === 'revise') {
      throw new BadRequestException(
        'A spend gate is approved or rejected; there is no revise path. Reject it with a note ' +
          'saying what to change, and the run loops back.',
      );
    }
    if (!this.approvalActorSlackId) {
      throw new ServiceUnavailableException(
        'Gate decisions are not configured: set BRAIN_APPROVAL_ACTOR_SLACK_ID to a Slack id that ' +
          "is on the brain's APPROVAL_SLACK_IDS allowlist. Without it the brain refuses the " +
          'decision and the gate stays open.',
      );
    }
    try {
      const result = await this.brain.call<Record<string, unknown>>(
        'approval_record',
        {
          id,
          decision: body.action === 'approve' ? 'approved' : 'rejected',
          decided_by_slack_id: this.approvalActorSlackId,
          decided_by_name: 'Marketing dashboard',
          decision_text: body.note ?? '',
        },
      );
      if (result.recorded === false) {
        const why =
          typeof result.why === 'string'
            ? result.why
            : 'the brain refused the decision';
        throw new BadRequestException(
          result.authorization_failed === true
            ? `This decision was not recorded and the gate is still open: ${why}`
            : `This gate was not re-decided: ${why}`,
        );
      }
      return { ok: true };
    } catch (err) {
      this.rethrow(err);
    }
  }

  /**
   * Idea selection: approve what was picked, retire the rest.
   *
   * Retiring the unpicked is the point. `proposed → approved | retired` are the only transitions,
   * and an idea left in `proposed` after somebody has reviewed the batch looks forever like a
   * decision nobody has made. Selecting some ideas IS declining the others, and the write says so.
   */
  private async decideIdeas(
    body: BrainGateDecisionBody,
  ): Promise<{ ok: true }> {
    const selected = new Set(body.selectedIds ?? []);
    if (body.action === 'approve' && selected.size === 0) {
      throw new BadRequestException(
        'Select at least one idea to approve, or reject the batch.',
      );
    }
    const read = await this.brain.tryCall<{ rows?: unknown[] }>('brain_read', {
      table: 'ideas',
      where: { status: 'proposed' },
      order: 'id.desc',
      limit: 25,
    });
    const ids = (read?.rows ?? [])
      .map((raw) =>
        raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>).id
          : null,
      )
      .filter((id): id is number | string => id !== null && id !== undefined)
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id));

    const failures: string[] = [];
    for (const id of ids) {
      const status =
        body.action === 'approve' && selected.has(String(id))
          ? 'approved'
          : 'retired';
      try {
        await this.brain.call('update_idea', { id, status });
      } catch (err) {
        failures.push(`idea ${id} → ${status}: ${(err as Error).message}`);
      }
    }
    if (failures.length) {
      // Partial is reported as partial. Saying "ok" here would leave ideas in `proposed` that the
      // operator believes they have already dealt with.
      throw new BadGatewayException(
        `${ids.length - failures.length} of ${ids.length} ideas updated. Failed: ${failures.join('; ')}`,
      );
    }
    return { ok: true };
  }

  // ── conversation ─────────────────────────────────────────────────────────

  /**
   * One conversation thread, oldest first.
   *
   * Small defaults on purpose, and they are not this bridge's taste: a brain tool result over
   * roughly 2 KB comes back from Foundry as an artifact envelope that a code step cannot
   * materialize, so `select_mode` — which reads the same thread on the other side — would get an
   * unreadable history. Asking for the same shape here keeps the two surfaces looking at the same
   * conversation rather than at two different truncations of it.
   */
  async readConversation(
    sessionId: string,
    limit = 20,
  ): Promise<BrainConversation> {
    this.assertBrain();
    let raw: Record<string, unknown>;
    try {
      raw = await this.brain.call<Record<string, unknown>>(
        'conversation_read',
        {
          session_id: sessionId,
          limit: Math.min(Math.max(limit, 1), 50),
          // Bigger than the Brain's own read, and that difference is deliberate. The small default
          // exists because a result over ~2KB reaches a Foundry code step as an artifact envelope
          // it cannot materialize. Nothing here is a code step — this is an HTTP response to a
          // browser — so the operator gets the turn as it was written rather than clipped at 400
          // characters for a constraint that does not apply on this side.
          content_chars: 4000,
        },
      );
    } catch (err) {
      this.rethrow(err);
    }
    const turns = Array.isArray(raw.turns) ? raw.turns : [];
    return {
      sessionId:
        typeof raw.session_id === 'string' ? raw.session_id : sessionId,
      turns: turns
        .map((entry) =>
          entry && typeof entry === 'object'
            ? (entry as Record<string, unknown>)
            : {},
        )
        .map((turn): BrainConversationTurn | null => {
          const role =
            turn.role === 'brain'
              ? 'brain'
              : turn.role === 'user'
                ? 'user'
                : null;
          const content =
            typeof turn.content === 'string' ? turn.content : null;
          if (!role || content === null) return null;
          return {
            turnIndex:
              typeof turn.turn_index === 'number' ? turn.turn_index : 0,
            role,
            content,
            contentClipped: turn.content_clipped === true,
            evidenceRefs: Array.isArray(turn.evidence_refs)
              ? turn.evidence_refs.filter(
                  (ref): ref is string => typeof ref === 'string',
                )
              : [],
            runId: typeof turn.run_id === 'string' ? turn.run_id : null,
          };
        })
        .filter((t): t is BrainConversationTurn => t !== null),
      // Not a cosmetic count. A truncated history that looks complete is how an agent — or a
      // person reading over its shoulder — confidently contradicts what was agreed four turns ago.
      omittedOlder:
        typeof raw.omitted_older === 'number' ? raw.omitted_older : 0,
      lastTurn: typeof raw.last_turn === 'number' ? raw.last_turn : 0,
    };
  }

  /**
   * Say something to the Brain and get the run that will answer.
   *
   * The user's turn is written BEFORE the run starts, and that order is load-bearing. `select_mode`
   * reads the thread at the top of the run; a turn written after the run began would be invisible
   * to the run that exists to answer it. The Brain writes its own reply turn itself, in
   * `commit_decisions`, carrying the run id that produced it — this bridge never writes a brain
   * turn, because a turn attributed to the Brain that the Brain did not produce is exactly the
   * untraceable claim this system refuses.
   *
   * THE TURN INDEX IS CHOSEN HERE RATHER THAN LEFT TO THE BRAIN, and that is what makes a failed
   * send recoverable. Writing first means a run that never starts — an unreachable Foundry, a token
   * that does not grant the Brain — leaves a question recorded with nothing coming to answer it.
   * `conversation_append` is idempotent on (session, turn, role), so pinning the index makes
   * re-sending the same message land on the same row instead of filling the thread with duplicates
   * of a question that was only ever asked once.
   */
  async sendConversationMessage(
    sessionId: string,
    message: string,
    mode?: string,
  ): Promise<{ runId: string; sessionId: string }> {
    this.assertBrain();
    const text = (message ?? '').trim();
    if (!text) throw new BadRequestException('A message is required.');

    // Read before write, for the index. A failed read is not a reason to refuse the message — the
    // append assigns its own index in that case, which is the brain's normal behaviour.
    const existing = await this.brain.tryCall<Record<string, unknown>>(
      'conversation_read',
      { session_id: sessionId, limit: 2 },
    );
    const lastTurn =
      existing && typeof existing.last_turn === 'number'
        ? existing.last_turn
        : null;
    // AN UNANSWERED QUESTION IS RE-ASKED ON ITS OWN INDEX, NOT THE NEXT ONE.
    //
    // `lastTurn + 1` alone made the retry advice in the failure below a lie, and a measured one:
    // four sends of one sentence produced turns 1, 2, 3 and 4 — the same question asked four
    // times, which is exactly what pinning the index was meant to prevent. A turn is an EXCHANGE,
    // so a trailing `user` row with no `brain` row beside it is a question still waiting for its
    // answer, and the resend belongs on that index where ON CONFLICT DO NOTHING absorbs it.
    const turns = Array.isArray(existing?.turns) ? existing.turns : [];
    const tail =
      turns.length > 0
        ? (turns[turns.length - 1] as Record<string, unknown>)
        : null;
    const tailIsPendingQuestion =
      tail !== null &&
      tail.role === 'user' &&
      typeof tail.turn_index === 'number';
    const turnIndex = tailIsPendingQuestion
      ? (tail.turn_index as number)
      : lastTurn === null
        ? null
        : lastTurn + 1;

    try {
      await this.brain.call('conversation_append', {
        session_id: sessionId,
        role: 'user',
        content: text,
        surface: 'dashboard',
        ...(turnIndex === null ? {} : { turn_index: turnIndex }),
      });
    } catch (err) {
      this.rethrow(err);
    }

    try {
      const { runId } = await this.startRun('brain', {
        message: text,
        session_id: sessionId,
        ...(mode ? { mode } : {}),
      });
      return { runId, sessionId };
    } catch (err) {
      // Say what actually happened. "Failed to send" would be wrong — the message IS recorded, and
      // an operator told otherwise would either retype it or assume the Brain ignored them.
      const reason =
        err instanceof Error ? err.message : 'the run could not be started';
      throw new BadGatewayException(
        `Your message was recorded${turnIndex === null ? '' : ` as turn ${turnIndex}`}, but no run ` +
          `started to answer it: ${reason} Sending it again is safe — it lands on the same turn ` +
          'rather than asking twice.',
      );
    }
  }
}

const GATE_ACTIONS: BrainGateAction[] = [
  { key: 'approve', label: 'Approve', tone: 'primary', requiresNote: false },
  { key: 'reject', label: 'Reject', tone: 'danger', requiresNote: true },
];

/**
 * The next 04:30 UTC — 10:00 IST, the Brain's daily portfolio review.
 *
 * Derived from the trigger's cron rather than read back from Foundry, which exposes no next-fire
 * time on the run API. It is a schedule restated, not a measurement, and it is used only to tell
 * the operator roughly when the Brain next wakes.
 */
function nextDailyCycle(fromIso: string): string {
  const from = new Date(fromIso);
  const next = new Date(from);
  next.setUTCHours(4, 30, 0, 0);
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}
