import type { BrainAgentDefinition } from './brain.types';

/**
 * The eight marketing agents the console may show, and the four it may start.
 *
 * Static rather than discovered. Foundry's `list_runnable_agents` returns whatever the run token
 * happens to grant, which is a deployment fact, not a product decision — driving the console off it
 * would let a token change silently add an internal coding agent to a marketing surface, or drop
 * the Brain from the page without anyone noticing. The console's contract says these eight exist;
 * whether each is *reachable* is answered separately by `state.connected` and by a start attempt.
 *
 * THE BRAIN ID IS v2, AND THAT IS A CORRECTION.
 * `src/lib/brain-fixtures.ts` on the frontend hardcodes `agt_01a06ffbcad170d08890150a61e209d3` —
 * Brain **v1**. Everything that makes this console worth building is v2
 * (`agt_01a08a637be471038bba2efa34cb8c92`): decisions recorded with goal/reason/evidence, a
 * conversation that survives between turns, validated allocation arithmetic, and the honest
 * `record_and_propose` labelling. Pointing the bridge at v1 would ship the old Brain behind a new
 * page — runs with no reasons attached, and no thread to continue.
 *
 * `invocation` is the load-bearing field. `on_demand` agents can be started from the dashboard;
 * `brain_triggered` ones render read-only because the Brain owns when they run. The controller
 * enforces that, not just the UI — see `foundry-bridge.controller.ts`.
 */
export const BRAIN_AGENTS: BrainAgentDefinition[] = [
  {
    key: 'brain',
    foundryAgentId: 'agt_01a08a637be471038bba2efa34cb8c92',
    name: 'Brain — Marketing Head',
    whatItDoes:
      'Decides what the company should investigate, improve, stop, sustain, test and launch across the whole portfolio, targeting 1.2 portfolio ROAS. Records every decision with its goal, reason and the sources it read. Proposes; does not act on the ad account.',
    invocation: 'on_demand',
    stage: 'control',
    status: 'live',
    schedule: 'Once a day, 10:00 IST — a full portfolio review',
    inputs: [
      {
        key: 'message',
        label: 'Question',
        hint: 'Leave blank for a full portfolio review. Ask a follow-up and it continues the thread.',
        type: 'textarea',
        required: false,
        placeholder:
          'Should we cut automatic placements on nadi_report_premium?',
      },
      {
        key: 'mode',
        label: 'Mode',
        hint: 'Sense only looks. Allocate plans the day and may propose a spend split.',
        type: 'select',
        required: false,
        defaultValue: 'decide',
        options: [
          { value: 'decide', label: 'Decide — answer a question' },
          { value: 'sense', label: 'Sense — look, change nothing' },
          { value: 'allocate', label: 'Allocate — plan the day' },
          {
            value: 'consolidate',
            label: 'Consolidate — fold results into context',
          },
        ],
      },
      {
        key: 'plan_date',
        label: 'Plan date',
        hint: 'Allocate mode only. YYYY-MM-DD.',
        type: 'text',
        required: false,
        placeholder: '2026-09-18',
      },
    ],
  },
  {
    key: 'competitor-research',
    foundryAgentId: 'agt_01a06ca170ae7050a4a76a9638a3c99d',
    name: 'Competitor Research',
    whatItDoes:
      'Turns supplied competitor observations into evidence-backed learnings and product-specific ideas. Competitor copy supplies angles to test, never competitor performance.',
    invocation: 'on_demand',
    stage: 'understand',
    status: 'live',
    schedule: null,
    inputs: [
      {
        key: 'observations',
        label: 'Observations',
        hint: 'What you saw. One per line.',
        type: 'textarea',
        required: true,
        placeholder:
          'Competitor X is running a ₹499 trial offer on Instagram reels…',
      },
    ],
  },
  {
    key: 'campaign-report',
    foundryAgentId: 'agt_01a06cab88347d609c3c5d8233ae2545',
    name: 'Campaign Report Generator',
    whatItDoes:
      "Turns the Campaign Monitor's latest findings into a shareable performance report. Reads the brain rather than re-reading Meta, so it costs nothing against the ad account's rate limit.",
    invocation: 'on_demand',
    stage: 'prove',
    status: 'live',
    schedule: null,
    inputs: [
      {
        key: 'window',
        label: 'Window',
        type: 'select',
        required: false,
        defaultValue: 'last_7d',
        options: [
          { value: 'last_7d', label: 'Last 7 days' },
          { value: 'last_30d', label: 'Last 30 days' },
          { value: 'last_90d', label: 'Last 90 days' },
        ],
      },
    ],
  },
  {
    key: 'performance-analyst',
    foundryAgentId: 'agt_01a06cab76527a52b8e5c1563d3665ae',
    name: 'Performance & Self Data Analyst',
    whatItDoes:
      'Analyses what went live and how it performed — spend, CTR, cost per purchase — grouped by the creative attributes recorded in the brain, then writes attribute-level learnings. It reads stored attributes, not the creative image itself.',
    invocation: 'on_demand',
    stage: 'improve',
    status: 'live',
    schedule: null,
    inputs: [
      {
        key: 'window',
        label: 'Window',
        type: 'select',
        required: false,
        defaultValue: 'last_7d',
        options: [
          { value: 'last_7d', label: 'Last 7 days' },
          { value: 'last_30d', label: 'Last 30 days' },
        ],
      },
    ],
  },

  // ── Brain-triggered. Rendered read-only; the controller refuses to start them. ──
  {
    key: 'creative-producer',
    foundryAgentId: 'agt_01a06cab057578d391774dd3b5d505d2',
    name: 'Creative Batch Producer',
    whatItDoes:
      'Turns a briefed idea into a batch of finished creatives, choosing the research or direct route and the raw or polished track.',
    invocation: 'brain_triggered',
    stage: 'create',
    status: 'live',
    schedule: null,
    inputs: [],
  },
  {
    key: 'creative-curator',
    foundryAgentId: 'agt_01a06cab17a2711188d3271c904a52ce',
    name: 'Creative Curator',
    whatItDoes:
      'Judges a finished batch against a quality rubric, decides which are fit to go live, and sends near-misses back for revision.',
    invocation: 'brain_triggered',
    stage: 'create',
    status: 'live',
    schedule: null,
    inputs: [],
  },
  {
    key: 'campaign-builder',
    foundryAgentId: 'agt_01a06cab3042723089ba8b9184682cd1',
    name: 'Campaign Builder',
    whatItDoes:
      'Builds a complete Meta campaign for an approved creative — campaign, ad set and ad — leaving everything PAUSED for a separate human-gated launch.',
    invocation: 'brain_triggered',
    stage: 'create',
    status: 'live',
    schedule: null,
    inputs: [],
  },
  {
    key: 'campaign-launcher',
    foundryAgentId: 'agt_01a06cab48557860a97f5ceac20acdba',
    name: 'Campaign Launcher',
    whatItDoes:
      'Presents a fully-built paused campaign for human approval, then activates every level in Meta and records who approved it.',
    invocation: 'brain_triggered',
    stage: 'control',
    status: 'live',
    schedule: null,
    inputs: [],
  },
];

export const AGENTS_BY_KEY = new Map(BRAIN_AGENTS.map((a) => [a.key, a]));
