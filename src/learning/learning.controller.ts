import { Controller, Get, Param } from '@nestjs/common';
import { ActionOutcomeService } from './action-outcome.service';
import { ShadowActionService } from './shadow-action.service';
import { PromptVersionEvalService } from './prompt-version-eval.service';

/**
 * Read-only intelligence endpoints for the dashboard — surfaces the feedback
 * loops that previously lived only in Mongo: executed-action outcomes,
 * guardrail regret stats, and prompt-version evals. All data is written by
 * the audit/eval machinery; this controller never mutates.
 */
@Controller('learning')
export class LearningController {
  constructor(
    private readonly actionOutcomes: ActionOutcomeService,
    private readonly shadowActions: ShadowActionService,
    private readonly promptVersionEvals: PromptVersionEvalService,
  ) {}

  /** Executed-action track record (+72h outcome rates by type) + recent actions. */
  @Get(':tenantId/action-outcomes')
  async actionOutcomes_(@Param('tenantId') tenantId: string) {
    const [trackRecord, recent] = await Promise.all([
      this.actionOutcomes.getTrackRecord(tenantId),
      this.actionOutcomes.listRecent(tenantId, 50),
    ]);
    return { trackRecord, recent };
  }

  /** Guardrail regret rates per (actionType, blockedReason) over blocked actions. */
  @Get(':tenantId/regret-summary')
  async regretSummary(@Param('tenantId') tenantId: string) {
    return this.shadowActions.getRegretSummary(tenantId);
  }

  /** Prompt-version eval history (did each learning cycle's regen help?). */
  @Get(':tenantId/prompt-version-evals')
  async promptVersionEvalsList(@Param('tenantId') tenantId: string) {
    return this.promptVersionEvals.list(tenantId);
  }
}
