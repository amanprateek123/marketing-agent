import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { AuthedRequest, brainPrincipal, Roles } from '../auth/roles';
import { InboxService } from './inbox.service';
import {
  AskQuestionDto,
  CandidateDecisionDto,
  SaveCompetitorsDto,
} from './dto/inbox.dto';
import type {
  BrainCompetitorCandidateList,
  BrainCompetitorFindingList,
  BrainCompetitorList,
  BrainInbox,
  BrainQuestionList,
  BrainReportPage,
} from './brain.types';

/**
 * "Waiting on you", Reports, alerts and competitors — what used to arrive in Slack.
 *
 * Same root segment and the same BRAIN LOGIN ONLY rule as `FoundryBridgeController`:
 * `@Roles('brain')` on the class, so the shared workspace login gets 403 and an unset brain login
 * answers 503. Every write is recorded under the signed-in principal (`dash:brain:<username>`).
 *
 * Routes here never collide with the console's: none of these first segments (`inbox`, `reports`,
 * `questions`, `alerts`, `competitors`) is used there.
 */
@Roles('brain')
@Controller('brain')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  /** GET /api/v1/brain/:tenantId/inbox — counts plus everything waiting on a person. */
  @Get(':tenantId/inbox')
  async getInbox(
    @Param('tenantId') _tenantId: string,
    @Req() req: AuthedRequest,
  ): Promise<BrainInbox> {
    return this.inbox.getInbox(req.user?.sub ?? null);
  }

  /** GET /api/v1/brain/:tenantId/reports?kind=&page= */
  @Get(':tenantId/reports')
  async reports(
    @Param('tenantId') _tenantId: string,
    @Query('kind') kind?: string,
    @Query('page') page?: string,
  ): Promise<BrainReportPage> {
    const k = kind && /^[a-z0-9_]{1,40}$/i.test(kind.trim()) ? kind.trim() : null;
    const n = Number(page);
    return this.inbox.getReports(k, Number.isInteger(n) && n > 0 ? n : 1);
  }

  /** POST /api/v1/brain/:tenantId/reports/:id/read */
  @Post(':tenantId/reports/:id/read')
  async markRead(
    @Param('tenantId') _tenantId: string,
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    return this.inbox.markReportRead(id, brainPrincipal(req.user!));
  }

  /** GET /api/v1/brain/:tenantId/questions */
  @Get(':tenantId/questions')
  async questions(
    @Param('tenantId') _tenantId: string,
    @Req() req: AuthedRequest,
  ): Promise<BrainQuestionList> {
    return this.inbox.getQuestions(req.user?.sub ?? null);
  }

  /** POST /api/v1/brain/:tenantId/questions {text} — ask the Brain something. */
  @Post(':tenantId/questions')
  async ask(
    @Param('tenantId') _tenantId: string,
    @Body() dto: AskQuestionDto,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    return this.inbox.askQuestion(dto.text, brainPrincipal(req.user!));
  }

  /** POST /api/v1/brain/:tenantId/alerts/:id/ack */
  @Post(':tenantId/alerts/:id/ack')
  async ack(
    @Param('tenantId') _tenantId: string,
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    return this.inbox.ackAlert(id, brainPrincipal(req.user!));
  }

  // ── competitors ── declared most-specific-first ─────────────────────────

  /** GET /api/v1/brain/:tenantId/competitors/findings — what competitors are running. */
  @Get(':tenantId/competitors/findings')
  async findings(@Param('tenantId') _tenantId: string): Promise<BrainCompetitorFindingList> {
    return this.inbox.getFindings();
  }

  /** GET /api/v1/brain/:tenantId/competitors/candidates — ideas from competitors to review. */
  @Get(':tenantId/competitors/candidates')
  async candidates(
    @Param('tenantId') _tenantId: string,
  ): Promise<BrainCompetitorCandidateList> {
    return this.inbox.getCandidates();
  }

  /** POST /api/v1/brain/:tenantId/competitors/candidates/:id/decision {decision, reason} */
  @Post(':tenantId/competitors/candidates/:id/decision')
  async decide(
    @Param('tenantId') _tenantId: string,
    @Param('id') id: string,
    @Body() dto: CandidateDecisionDto,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    return this.inbox.decideCandidate(id, dto.decision, dto.reason, brainPrincipal(req.user!));
  }

  /** POST /api/v1/brain/:tenantId/competitors/run — start Competitor Research now. */
  @Post(':tenantId/competitors/run')
  async run(@Param('tenantId') _tenantId: string): Promise<{ runId: string }> {
    return this.inbox.runCompetitorResearch();
  }

  /** GET /api/v1/brain/:tenantId/competitors */
  @Get(':tenantId/competitors')
  async competitors(@Param('tenantId') _tenantId: string): Promise<BrainCompetitorList> {
    return this.inbox.getCompetitors();
  }

  /** PUT /api/v1/brain/:tenantId/competitors {competitors:[…]} — replaces the list. */
  @Put(':tenantId/competitors')
  async saveCompetitors(
    @Param('tenantId') _tenantId: string,
    @Body() dto: SaveCompetitorsDto,
  ): Promise<BrainCompetitorList> {
    return this.inbox.saveCompetitors(dto.competitors);
  }
}
