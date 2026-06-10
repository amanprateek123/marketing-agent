import { Injectable, Logger } from '@nestjs/common';

/**
 * Experiment design layer — turns a regular brief into an A/B-structured brief
 * with isolation. SCAFFOLD ONLY: the design heuristics + integration with
 * Strategy Team are intentionally minimal until the next session picks this up.
 *
 * The idea: when the Strategy Team produces a brief, the experiment designer
 * decides whether this brief should be a free-form 4-variant generation (today's
 * default) or a structured experiment that varies exactly one isolated variable.
 *
 * Design rules (proposed, not yet enforced):
 *  - Skip experiment design for: warm/hot retargeting (low volume, slow learning),
 *    exploit-winner clones (variable to test already known), exploration-arm briefs
 *    (already exploratory by definition).
 *  - Use experiment design for: cold prospecting on a hypothesis-stage product
 *    (every signal counts), brand-new audience-product combination, contradicting
 *    a prior winningHook by deliberately testing the loser again with isolation.
 *
 * Sample size: power-calc.util.ts already has the math; this service should
 * call it with the brief's baseline conversion rate to compute sampleSizeTarget.
 *
 * Future wiring (next session):
 *  - Strategy Team calls `proposeExperiment(brief, learnings)` before
 *    emitting the brief; if `shouldRunExperiment` returns true, the brief
 *    is stamped with experimentId + isolatedVariable + controlVariantIdx +
 *    sampleSizeTarget.
 *  - Creative Team reads experiment metadata: when isolatedVariable=hookStyle,
 *    all 4 variants share the same image+headline structure, only hookStyle varies.
 *  - Audit loop polls at sample size; when sampleSizeTarget conversions land,
 *    calls `evaluate()` and writes the result back as a causalInsight with
 *    high confidence (isolation = real causation, not correlation).
 */
@Injectable()
export class ExperimentDesignerService {
  private readonly logger = new Logger(ExperimentDesignerService.name);

  /**
   * Decide whether a brief should be a structured experiment.
   * STUB — returns null today. Next-session implementation reads brief stage,
   * product confidence, and learnings to decide which variable to isolate.
   */
  proposeExperiment(_brief: any, _company: any): ExperimentSpec | null {
    return null;
  }

  /**
   * Build a unique experiment ID. Caller stamps it on the brief and on every
   * resulting ad/ad set so the auditor can correlate.
   */
  generateExperimentId(): string {
    return `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Evaluate an experiment when sample-size threshold is reached. STUB —
   * next-session implementation: pull per-variant conversion counts from
   * the campaign's metaAdSets[].ads[].metrics, run power-calc significance
   * test, return the winning variant + confidence + recommended action.
   */
  evaluate(_briefId: string, _campaign: any): ExperimentResult | null {
    return null;
  }
}

export interface ExperimentSpec {
  experimentId: string;
  isolatedVariable: 'hookStyle' | 'audience' | 'budget_band' | 'format' | 'cta' | 'headline_pattern';
  controlVariantIdx: number;
  /**
   * Description of what's held constant across variants. The Creative Team
   * MUST honor this when generating variants — only `isolatedVariable` differs.
   */
  heldConstant: string[];
  sampleSizeTarget: number;
  designRationale: string;
}

export interface ExperimentResult {
  experimentId: string;
  winnerVariantIdx: number | null;     // null if inconclusive
  status: 'evaluated' | 'inconclusive' | 'aborted';
  pValue?: number;
  effectSize?: number;
  confidence: number;                   // 0-1, drives causalInsight.confidence write
  finding: string;                      // human-readable result for causalInsight.finding
  recommendation: 'adopt_winner' | 'rerun_larger' | 'discard_test' | 'no_action';
}
