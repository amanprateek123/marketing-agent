import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { AddOfferingDto } from './dto/add-offering.dto';
import { StartRunDto } from './dto/start-run.dto';
import { ClarifyDto, RegenerateDto, ReviseDto } from './dto/iterate.dto';
import {
  ApproveStageDto,
  BadgeDto,
  CampaignFieldsDto,
  DiscardIdeaDto,
  LearnDecisionDto,
  LogoDto,
  LanguageDto,
  ImageKindDto,
  OfferingDto,
  DisclaimerDto,
  RetryDto,
  ResearchPdfDto,
  ResearchRerunDto,
  ResearchSourcesDto,
  SetModelDto,
} from './dto/parity.dto';
import { PipelineBridgeService } from './pipeline-bridge.service';
import { AuthedRequest, brainPrincipal, Roles } from '../auth/roles';

/**
 * The dashboard's route to the external creative pipeline.
 *
 * Mounted at its own root (`/api/v1/pipeline-bridge/...`) rather than under
 * `/creative` on purpose: `campaigns.controller.ts` shows how easily a new
 * literal segment gets swallowed by an earlier `:param` route, and a separate
 * root removes the question entirely.
 *
 * Every route is protected by the global JwtAuthGuard (APP_GUARD in
 * AuthModule) — no `@Public()` here. The pipeline has its own bearer token,
 * held server-side and never sent to the browser.
 */
@Controller('pipeline-bridge')
export class PipelineBridgeController {
  constructor(private readonly bridge: PipelineBridgeService) {}

  /**
   * GET /api/v1/pipeline-bridge/:tenantId/options
   *
   * Formats, angles, tracks, languages, models and the count default. Served
   * from the pipeline rather than hardcoded here so that adding, say, a new raw
   * visual direction to the pipeline's guide shows up in the form without a
   * deploy on either side.
   */
  @Get(':tenantId/options')
  async options(@Param('tenantId') _tenantId: string): Promise<unknown> {
    return this.bridge.getOptions();
  }

  /** GET /api/v1/pipeline-bridge/:tenantId/health — lets the UI distinguish "offline" from "broken". */
  @Get(':tenantId/health')
  async health(@Param('tenantId') _tenantId: string): Promise<unknown> {
    return this.bridge.health();
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/offerings
   *
   * Add a new 91Astrology product by giving its landing page. The pipeline scrapes that page into
   * the research pack its authoring session reads, then registers the product so it becomes
   * selectable everywhere — this form, Slack, and the MCP's allowed list.
   *
   * Slow and synchronous: there is a headless browser render in the middle. That is deliberate,
   * because the caller's next action is to pick the product, which it cannot do until it exists.
   *
   * Only `landing_url` is required; the slug and display name are derived from it otherwise.
   */
  @Post(':tenantId/offerings')
  async addOffering(
    @Param('tenantId') tenantId: string,
    @Body() dto: AddOfferingDto,
  ): Promise<unknown> {
    return this.bridge.addOffering(tenantId, dto);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/runs
   *
   * Start a Custom-brief run. Returns immediately with `{ run_id, count, ... }`
   * — the work is queued on the pipeline, not done inline. Poll the two routes
   * below for progress; finished creatives arrive on their own via the
   * pipeline's push into `/creative/:tenantId/packages/upload-bulk`.
   */
  @Post(':tenantId/runs')
  async startRun(
    @Param('tenantId') tenantId: string,
    @Body() dto: StartRunDto,
  ): Promise<unknown> {
    return this.bridge.startRun(tenantId, dto);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/uploads
   *
   * Reference image(s) for a Custom-brief run, returned as refs to pass back as
   * `image_refs`. Kept separate from `runs` so the run body stays plain JSON and
   * the operator can upload while still filling in the form.
   */
  @Post(':tenantId/uploads')
  @UseInterceptors(FilesInterceptor('files', 5))
  async uploads(
    @Param('tenantId') _tenantId: string,
    @UploadedFiles()
    files: Array<{ originalname: string; buffer: Buffer; mimetype: string }>,
  ): Promise<unknown> {
    if (!files?.length) {
      throw new BadRequestException('No files were uploaded.');
    }
    return this.bridge.uploadImages(files);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/packages/:packageId/resize
   *
   * Generate the remaining placement sizes for a creative the pipeline produced. Returns
   * immediately — the cascade is Playwright-driven and takes minutes, and the finished sizes are
   * attached to the package by the pipeline itself. 404 if the pipeline did not make this package.
   */
  @Post(':tenantId/packages/:packageId/resize')
  async resizePackage(
    @Param('tenantId') _tenantId: string,
    @Param('packageId') packageId: string,
  ): Promise<unknown> {
    return this.bridge.resizePackage(packageId);
  }

  /**
   * GET /api/v1/pipeline-bridge/:tenantId/packages/:packageId
   *
   * Whether this creative was produced by the pipeline, and its run. The creative detail page
   * probes this once on load to decide whether its Rewrite / Edit / Retry buttons drive the
   * pipeline or the built-in generator. **404 is the expected answer** for a package the dashboard
   * made itself — callers should treat it as "not ours", not as a failure.
   */
  @Get(':tenantId/packages/:packageId')
  async getPackage(
    @Param('tenantId') _tenantId: string,
    @Param('packageId') packageId: string,
  ): Promise<unknown> {
    return this.bridge.getPackage(packageId);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/packages/:packageId/revise
   *
   * Re-author the brief from an instruction and regenerate — the pipeline's equivalent of the
   * built-in "Rewrite". Returns a NEW run id, because the pipeline revises a clone so the source
   * creative keeps its artifacts; the revision lands as its own package.
   */
  @Post(':tenantId/packages/:packageId/revise')
  async revisePackage(
    @Param('tenantId') _tenantId: string,
    @Param('packageId') packageId: string,
    @Body() dto: ReviseDto,
  ): Promise<unknown> {
    return this.bridge.revisePackage(packageId, dto.instruction);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/packages/:packageId/regenerate
   *
   * Edit the delivered image in place from free text — the pipeline's equivalent of the built-in
   * "Edit". Same package, pixels only.
   */
  @Post(':tenantId/packages/:packageId/regenerate')
  async regeneratePackage(
    @Param('tenantId') _tenantId: string,
    @Param('packageId') packageId: string,
    @Body() dto: RegenerateDto,
  ): Promise<unknown> {
    return this.bridge.regeneratePackage(packageId, dto.instruction, dto.tag);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/clarify
   *
   * Answer the question a stalled revise asked. Addressed by run, not package, because the run
   * waiting on the answer is the clone — which has no package of its own yet.
   */
  @Post(':tenantId/runs/:runId/clarify')
  async clarifyRun(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
    @Body() dto: ClarifyDto,
  ): Promise<unknown> {
    return this.bridge.clarifyRun(runId, dto.answer);
  }

  /** GET /api/v1/pipeline-bridge/:tenantId/runs/:runId — status + per-child progress. */
  @Get(':tenantId/runs/:runId')
  async getRun(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
  ): Promise<unknown> {
    return this.bridge.getRun(runId);
  }

  /**
   * GET /api/v1/pipeline-bridge/:tenantId/runs/:runId/events?after=<cursor>
   *
   * Cursor-paged progress events. Pass back the `cursor` from the previous
   * response so each poll only returns what is new.
   */
  @Get(':tenantId/runs/:runId/events')
  async getEvents(
    @Param('tenantId') _tenantId: string,
    @Param('runId') runId: string,
    @Query('after') after?: string,
  ): Promise<unknown> {
    return this.bridge.getEvents(runId, Number(after ?? 0));
  }

  // ─── Creative studio parity: every action a Slack button used to be the only door to ───

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/cancel */
  @Post(':tenantId/runs/:runId/cancel')
  async cancelRun(@Param('runId') runId: string): Promise<unknown> {
    return this.bridge.cancelRun(runId);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/retry */
  @Post(':tenantId/runs/:runId/retry')
  async retryRun(
    @Param('runId') runId: string,
    @Body() dto: RetryDto,
  ): Promise<unknown> {
    return this.bridge.retryRun(runId, dto?.step);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/run-anyway — override a quality-check block. */
  @Post(':tenantId/runs/:runId/run-anyway')
  async runAnyway(@Param('runId') runId: string): Promise<unknown> {
    return this.bridge.runAnyway(runId);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/model */
  @Post(':tenantId/runs/:runId/model')
  async setModel(
    @Param('runId') runId: string,
    @Body() dto: SetModelDto,
  ): Promise<unknown> {
    return this.bridge.setModel(runId, dto.model, dto.quality);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/approve — `preview` (Gate A) or `full` (Gate B). */
  @Post(':tenantId/runs/:runId/approve')
  async approveRun(
    @Param('runId') runId: string,
    @Body() dto: ApproveStageDto,
  ): Promise<unknown> {
    return this.bridge.approveRun(runId, dto.stage);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/campaign-fields — write the ad copy. */
  @Post(':tenantId/runs/:runId/campaign-fields')
  async generateCampaignFields(
    @Param('runId') runId: string,
  ): Promise<unknown> {
    return this.bridge.generateCampaignFields(runId);
  }

  /** PUT /api/v1/pipeline-bridge/:tenantId/runs/:runId/campaign-fields — save edits to the ad copy. */
  @Put(':tenantId/runs/:runId/campaign-fields')
  async editCampaignFields(
    @Param('runId') runId: string,
    @Body() dto: CampaignFieldsDto,
  ): Promise<unknown> {
    const fields = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(fields).length === 0) {
      throw new BadRequestException(
        'Change at least one field of the ad copy before saving.',
      );
    }
    return this.bridge.editCampaignFields(runId, fields);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/campaign-fields/approve */
  @Post(':tenantId/runs/:runId/campaign-fields/approve')
  async approveCampaignFields(@Param('runId') runId: string): Promise<unknown> {
    return this.bridge.approveCampaignFields(runId);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/badge — `upload_id` from the uploads route. */
  @Post(':tenantId/runs/:runId/badge')
  async setBadge(
    @Param('runId') runId: string,
    @Body() dto: BadgeDto,
  ): Promise<unknown> {
    return this.bridge.setBadge(runId, dto.upload_id);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/logo */
  @Post(':tenantId/runs/:runId/logo')
  async setLogo(
    @Param('runId') runId: string,
    @Body() dto: LogoDto,
  ): Promise<unknown> {
    return this.bridge.setLogo(runId, dto.include, dto.disclaimer);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/language — at `awaiting_language`. */
  @Post(':tenantId/runs/:runId/language')
  setLanguage(@Param('runId') runId: string, @Body() dto: LanguageDto): Promise<unknown> {
    const languages = (dto.languages ?? []).map((l) => l.trim()).filter(Boolean);
    const language = dto.language?.trim();
    if (!language && languages.length === 0) {
      throw new BadRequestException('Choose at least one language.');
    }
    return this.bridge.setLanguage(runId, languages.length ? { languages } : { language });
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/image-kind — at `awaiting_image_kind`. */
  @Post(':tenantId/runs/:runId/image-kind')
  setImageKind(@Param('runId') runId: string, @Body() dto: ImageKindDto): Promise<unknown> {
    return this.bridge.setImageKind(runId, dto.kind, dto.text?.trim() || undefined);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/offering — at `awaiting_offering`. */
  @Post(':tenantId/runs/:runId/offering')
  setOffering(@Param('runId') runId: string, @Body() dto: OfferingDto): Promise<unknown> {
    return this.bridge.setOffering(runId, dto.offering);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/runs/:runId/disclaimer — astro or automotive small print. */
  @Post(':tenantId/runs/:runId/disclaimer')
  setDisclaimer(@Param('runId') runId: string, @Body() dto: DisclaimerDto): Promise<unknown> {
    return this.bridge.setDisclaimer(runId, dto.choice);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/ideas/:runId/discard — the RUN showing the idea, as Slack's button carried. */
  @Post(':tenantId/ideas/:runId/discard')
  async discardIdea(
    @Param('runId') runId: string,
    @Body() dto: DiscardIdeaDto,
  ): Promise<unknown> {
    return this.bridge.discardIdea(runId, dto.reason);
  }

  // ─── Research ───

  /** POST /api/v1/pipeline-bridge/:tenantId/research/pdf — start research from an uploaded PDF. */
  @Post(':tenantId/research/pdf')
  async researchFromPdf(@Body() dto: ResearchPdfDto): Promise<unknown> {
    return this.bridge.researchFromPdf(dto.upload_id, dto.product);
  }

  /** GET /api/v1/pipeline-bridge/:tenantId/research/:researchId/sources */
  @Get(':tenantId/research/:researchId/sources')
  async getResearchSources(
    @Param('researchId') researchId: string,
  ): Promise<unknown> {
    return this.bridge.getResearchSources(researchId);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/research/:researchId/sources — confirm, or override with `urls`. */
  @Post(':tenantId/research/:researchId/sources')
  async confirmResearchSources(
    @Param('researchId') researchId: string,
    @Body() dto: ResearchSourcesDto,
  ): Promise<unknown> {
    return this.bridge.confirmResearchSources(
      researchId,
      dto.confirm,
      dto.urls,
    );
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/research/:researchId/rerun — `reuse` or `rerun`. */
  @Post(':tenantId/research/:researchId/rerun')
  async rerunResearch(
    @Param('researchId') researchId: string,
    @Body() dto: ResearchRerunDto,
  ): Promise<unknown> {
    return this.bridge.rerunResearch(researchId, dto.choice);
  }

  /** GET /api/v1/pipeline-bridge/:tenantId/research/:researchId/directions */
  @Get(':tenantId/research/:researchId/directions')
  async getResearchDirections(
    @Param('researchId') researchId: string,
  ): Promise<unknown> {
    return this.bridge.getResearchDirections(researchId);
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/research/:researchId/directions/:direction/build */
  @Post(':tenantId/research/:researchId/directions/:direction/build')
  async buildDirection(
    @Param('researchId') researchId: string,
    @Param('direction') direction: string,
  ): Promise<unknown> {
    return this.bridge.buildDirection(researchId, direction);
  }

  /**
   * POST /api/v1/pipeline-bridge/:tenantId/research/:researchId/directions/:conceptIndex/expand
   *
   * Takes a CONCEPT's `index` from GET directions, not a direction id — culled concepts have no
   * database id. Building still uses the direction id.
   */
  @Post(':tenantId/research/:researchId/directions/:conceptIndex/expand')
  expandConcept(
    @Param('researchId') researchId: string,
    @Param('conceptIndex') conceptIndex: string,
  ): Promise<unknown> {
    if (!/^\d+$/.test(conceptIndex)) {
      throw new BadRequestException('Pick one of the ideas in the pool to develop.');
    }
    return this.bridge.expandConcept(researchId, conceptIndex);
  }

  // ─── Learnings proposals: BRAIN LOGIN ONLY ───
  //
  // The old /learnings Slack flow decided what the whole system believes, so it sits behind the
  // same role as every /brain route even though it proxies creativebot. The decision is recorded
  // under the Brain principal, never the workspace login.

  /** GET /api/v1/pipeline-bridge/:tenantId/learn/proposals */
  @Roles('brain')
  @Get(':tenantId/learn/proposals')
  async getLearnProposals(): Promise<unknown> {
    return this.bridge.getLearnProposals();
  }

  /** POST /api/v1/pipeline-bridge/:tenantId/learn/proposals/:proposalId — approve | reject | edit. */
  @Roles('brain')
  @Post(':tenantId/learn/proposals/:proposalId')
  async decideLearnProposal(
    @Param('proposalId') proposalId: string,
    @Body() dto: LearnDecisionDto,
    @Req() req: AuthedRequest,
  ): Promise<unknown> {
    const text = dto.text?.trim();
    if (dto.decision === 'edit' && !text) {
      throw new BadRequestException(
        'Write the corrected learning before saving the edit.',
      );
    }
    const user = req.user;
    if (!user) throw new BadRequestException('Sign in to the Brain first.');
    return this.bridge.decideLearnProposal(proposalId, {
      decision: dto.decision,
      ...(text ? { text } : {}),
      decided_by: brainPrincipal(user),
    });
  }
}
