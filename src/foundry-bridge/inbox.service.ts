import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotImplementedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AGENTS_BY_KEY } from './agents.registry';
import { FoundryBridgeService } from './foundry-bridge.service';
import {
  McpClient,
  McpToolError,
  McpTransportError,
  isUnknownTool,
} from './mcp.client';
import {
  competitorsOf,
  countsFrom,
  mapAlert,
  mapCandidate,
  mapFinding,
  mapInboxGate,
  mapQuestion,
  mapReport,
  mapWaitingRun,
  reportKindLabel,
  rowsOf,
} from './inbox.mapper';
import { PipelineBridgeService } from '../pipeline-bridge/pipeline-bridge.service';
import type {
  BrainCompetitorCandidateList,
  BrainCompetitorFindingList,
  BrainCompetitorList,
  BrainInbox,
  BrainInboxAlert,
  BrainInboxGate,
  BrainInboxQuestion,
  BrainQuestionList,
  BrainReport,
  BrainReportPage,
  BrainSectionState,
  BrainWaitingRun,
} from './brain.types';

/** One read, and whether it happened. */
interface Read<T> {
  state: BrainSectionState;
  value: T | null;
}

export interface CompetitorInput {
  name: string;
  website?: string | null;
  facebookPage?: string | null;
  products?: string[];
}

const NOT_YET =
  "This isn't available yet. It will work once the Brain has been updated for it.";

/**
 * "Waiting on you", Reports, alerts and competitors — everything the dashboard now shows instead of
 * posting to Slack.
 *
 * Separate from `FoundryBridgeService` because it talks to a different set of brain tools with a
 * different posture: every one of them may not exist yet. They ship in the brain alongside this
 * bridge, and until that brain is deployed each call answers "unknown tool". A read then marks its
 * section `not_available_yet` and the page says so in words; a write answers 501 with the same
 * sentence. Neither is an error the operator can fix, and neither is shown as one.
 *
 * Brain calls use BRAIN_DASHBOARD_TOKEN (config `brain.token` falls back to the shared token while
 * the dashboard identity is not issued).
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);
  private readonly brain: McpClient;
  private readonly foundry: McpClient;
  private readonly panelsBaseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly bridge: FoundryBridgeService,
    private readonly pipeline: PipelineBridgeService,
  ) {
    this.brain = new McpClient(
      (this.config.get<string>('brain.url') ?? '').trim(),
      (this.config.get<string>('brain.token') ?? '').trim(),
      this.config.get<number>('brain.timeoutMs') ?? 30000,
      'brain',
    );
    this.foundry = new McpClient(
      (this.config.get<string>('foundry.url') ?? '').trim(),
      (this.config.get<string>('foundry.token') ?? '').trim(),
      this.config.get<number>('foundry.timeoutMs') ?? 60000,
      'foundry',
    );
    this.panelsBaseUrl = (this.config.get<string>('brain.panelsBaseUrl') ?? '').trim();
  }

  private assertBrain(): void {
    if (!this.brain.isConfigured()) {
      throw new ServiceUnavailableException(
        "The Brain isn't connected on the server (BRAIN_MCP_URL is unset).",
      );
    }
  }

  /** A read that degrades to a section state instead of throwing. */
  private async read<T = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<Read<T>> {
    if (!this.brain.isConfigured()) return { state: 'could_not_load', value: null };
    try {
      return { state: 'ok', value: await this.brain.call<T>(tool, args) };
    } catch (err) {
      if (isUnknownTool(err)) return { state: 'not_available_yet', value: null };
      this.logger.warn(`brain ${tool} unavailable: ${(err as Error).message}`);
      return { state: 'could_not_load', value: null };
    }
  }

  /** A write: unknown tool → 501 in words; a refusal → 400 with the brain's reason; down → 502. */
  private async write<T = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    this.assertBrain();
    try {
      return await this.brain.call<T>(tool, args);
    } catch (err) {
      if (isUnknownTool(err)) throw new NotImplementedException(NOT_YET);
      if (err instanceof McpToolError) {
        throw new BadRequestException(err.detail ? `${err.message}: ${err.detail}` : err.message);
      }
      if (err instanceof McpTransportError) {
        throw new BadGatewayException("We couldn't reach the Brain. Try again in a minute.");
      }
      throw err;
    }
  }

  // ── inbox ────────────────────────────────────────────────────────────────

  async getInbox(viewer?: string | null): Promise<BrainInbox> {
    const [summary, gates, questions, alerts, reports, waiting] = await Promise.all([
      this.read('inbox_summary'),
      this.readGates(),
      this.readQuestions({ since_days: 14, limit: 30 }, viewer),
      this.readAlerts(true),
      this.readReports({ unread_only: true, limit: 20 }),
      this.readWaiting(),
    ]);
    const openQuestions = questions.value?.filter((q) => q.open) ?? [];
    return {
      counts: countsFrom(summary.state === 'ok' ? (summary.value as Record<string, unknown>) : null, {
        gates: gates.value?.length ?? 0,
        questions: openQuestions.length,
        reports: reports.value?.length ?? 0,
        alerts: alerts.value?.length ?? 0,
        waiting: waiting.value?.length ?? 0,
      }),
      gates: gates.value ?? [],
      questions: questions.value ?? [],
      alerts: alerts.value ?? [],
      reports: reports.value ?? [],
      waiting: waiting.value ?? [],
      availability: {
        gates: gates.state,
        questions: questions.state,
        alerts: alerts.state,
        reports: reports.state,
        waiting: waiting.state,
      },
    };
  }

  private async readGates(): Promise<Read<BrainInboxGate[]>> {
    try {
      const gates = await this.bridge.getGates();
      return { state: 'ok', value: gates.map(mapInboxGate) };
    } catch (err) {
      this.logger.warn(`gates unavailable: ${(err as Error).message}`);
      return { state: 'could_not_load', value: null };
    }
  }

  private async readQuestions(
    args: Record<string, unknown>,
    viewer?: string | null,
  ): Promise<Read<BrainInboxQuestion[]>> {
    const r = await this.read('questions_list', args);
    if (r.state !== 'ok') return { state: r.state, value: null };
    return {
      state: 'ok',
      value: rowsOf(r.value, 'questions')
        .map((row) => mapQuestion(row, viewer))
        .filter((q): q is BrainInboxQuestion => q !== null),
    };
  }

  private async readAlerts(openOnly: boolean): Promise<Read<BrainInboxAlert[]>> {
    const r = await this.read('alerts_list', { open_only: openOnly, limit: 50 });
    if (r.state !== 'ok') return { state: r.state, value: null };
    return {
      state: 'ok',
      value: rowsOf(r.value, 'alerts')
        .map(mapAlert)
        .filter((a): a is BrainInboxAlert => a !== null),
    };
  }

  private async readReports(args: Record<string, unknown>): Promise<Read<BrainReport[]>> {
    const r = await this.read('reports_list', args);
    if (r.state !== 'ok') return { state: r.state, value: null };
    return {
      state: 'ok',
      value: rowsOf(r.value, 'reports')
        .map((row) => mapReport(row, this.panelsBaseUrl))
        .filter((x): x is BrainReport => x !== null),
    };
  }

  private async readWaiting(): Promise<Read<BrainWaitingRun[]>> {
    try {
      const runs = await this.pipeline.listWaitingRuns();
      if (runs === null) return { state: 'not_available_yet', value: null };
      return {
        state: 'ok',
        value: runs.map(mapWaitingRun).filter((w): w is BrainWaitingRun => w !== null),
      };
    } catch (err) {
      this.logger.warn(`waiting creative runs unavailable: ${(err as Error).message}`);
      return { state: 'could_not_load', value: null };
    }
  }

  // ── reports ──────────────────────────────────────────────────────────────

  static readonly REPORTS_PER_PAGE = 20;

  /**
   * One page of reports, newest first. `reports_list` has no offset, so page N asks for the first
   * N pages plus one row and slices — the extra row is how `hasMore` is known without a count.
   */
  async getReports(kind: string | null, page: number): Promise<BrainReportPage> {
    const per = InboxService.REPORTS_PER_PAGE;
    const p = Math.max(1, Math.min(page, 20));
    const r = await this.readReports({
      ...(kind ? { kind } : {}),
      since_days: 90,
      limit: per * p + 1,
    });
    const all = r.value ?? [];
    const slice = all.slice(per * (p - 1), per * p);
    const kinds = new Map<string, string>();
    for (const rep of all) kinds.set(rep.kind, rep.kindLabel);
    if (kind && !kinds.has(kind)) kinds.set(kind, reportKindLabel(kind));
    return {
      state: r.state,
      reports: slice,
      page: p,
      hasMore: all.length > per * p,
      kinds: [...kinds].map(([key, label]) => ({ key, label })),
    };
  }

  async markReportRead(id: string, principal: string): Promise<{ ok: true }> {
    await this.write('report_mark_read', { id: numericOr(id), principal });
    return { ok: true };
  }

  // ── questions ────────────────────────────────────────────────────────────

  async getQuestions(viewer?: string | null): Promise<BrainQuestionList> {
    const r = await this.readQuestions({ since_days: 30, limit: 50 }, viewer);
    return { state: r.state, questions: r.value ?? [] };
  }

  async askQuestion(text: string, principal: string): Promise<{ ok: true }> {
    const t = text.trim();
    if (!t) throw new BadRequestException('Write a question first.');
    await this.write('question_ask', { text: t, principal });
    return { ok: true };
  }

  // ── alerts ───────────────────────────────────────────────────────────────

  async ackAlert(id: string, principal: string): Promise<{ ok: true }> {
    await this.write('alert_ack', { id: numericOr(id), principal });
    return { ok: true };
  }

  // ── competitors ──────────────────────────────────────────────────────────

  private async names(): Promise<Map<string, string>> {
    try {
      return await this.bridge.productNames();
    } catch {
      return new Map();
    }
  }

  async getCompetitors(): Promise<BrainCompetitorList> {
    const [r, names] = await Promise.all([this.read('competitors_read'), this.names()]);
    return {
      state: r.state,
      competitors: r.state === 'ok' ? competitorsOf(r.value, names) : [],
      products: [...names]
        .map(([key, name]) => ({ key, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async saveCompetitors(list: CompetitorInput[]): Promise<BrainCompetitorList> {
    const seen = new Set<string>();
    const competitors = list.map((c) => {
      const name = c.name.trim();
      if (!name) throw new BadRequestException('Every competitor needs a name.');
      const key = name.toLowerCase();
      if (seen.has(key)) throw new BadRequestException(`"${name}" is listed twice.`);
      seen.add(key);
      return {
        name,
        website: c.website?.trim() || null,
        facebook_page: c.facebookPage?.trim() || null,
        products: (c.products ?? []).map((p) => p.trim()).filter(Boolean),
      };
    });
    await this.write('competitors_write', { competitors });
    return this.getCompetitors();
  }

  async getFindings(): Promise<BrainCompetitorFindingList> {
    const r = await this.read('competitor_findings', { since_days: 30, limit: 40 });
    return {
      state: r.state,
      findings: rowsOf(r.value, 'findings', 'observations')
        .map(mapFinding)
        .filter((f): f is NonNullable<typeof f> => f !== null),
    };
  }

  async getCandidates(): Promise<BrainCompetitorCandidateList> {
    const [r, names] = await Promise.all([
      this.read('competitor_candidates', { status: 'candidate' }),
      this.names(),
    ]);
    return {
      state: r.state,
      candidates: rowsOf(r.value, 'candidates', 'learnings')
        .map((row) => mapCandidate(row, names))
        .filter((c): c is NonNullable<typeof c> => c !== null),
    };
  }

  async decideCandidate(
    id: string,
    decision: 'accept' | 'reject',
    reason: string,
    principal: string,
  ): Promise<{ ok: true }> {
    const why = reason.trim();
    if (!why) {
      throw new BadRequestException(
        decision === 'accept'
          ? 'Say why this idea is worth keeping — it is saved with the idea.'
          : 'Say why you are turning this idea down.',
      );
    }
    await this.write('competitor_candidate_decide', {
      id: numericOr(id),
      decision,
      principal,
      reason: why,
    });
    return { ok: true };
  }

  /**
   * Start Competitor Research now, with the Foundry RUN token. It reads the competitor list itself
   * (`load_competitors`), so nothing is passed in.
   */
  async runCompetitorResearch(): Promise<{ runId: string }> {
    const agent = AGENTS_BY_KEY.get('competitor-research');
    if (!agent) throw new NotImplementedException(NOT_YET);
    if (!this.foundry.isConfigured()) {
      throw new ServiceUnavailableException(
        "Agents can't be started from here yet — Foundry isn't connected on the server.",
      );
    }
    try {
      const started = await this.foundry.call<Record<string, unknown>>('run_agent', {
        agent_id: agent.foundryAgentId,
        inputs: {},
        wait_seconds: 0,
        include_summary: false,
      });
      const runId = typeof started.run_id === 'string' ? started.run_id : null;
      if (!runId) throw new BadGatewayException("Competitor research didn't start. Try again.");
      return { runId };
    } catch (err) {
      if (err instanceof McpToolError) {
        throw new BadRequestException(
          `Competitor research couldn't start: ${err.detail ?? err.message}`,
        );
      }
      if (err instanceof McpTransportError) {
        throw new BadGatewayException("We couldn't reach Foundry. Try again in a minute.");
      }
      throw err;
    }
  }
}

/** Brain row ids are integers; pass one as a number when it is one. */
function numericOr(id: string): number | string {
  return /^\d+$/.test(id) ? Number(id) : id;
}
