import { createHash } from 'crypto';
import { getProfile } from '../objective/kpi-profiles';
import type {
  CampaignActionType,
  ObjectiveKey,
  RecommendedAction,
} from '../orchestrator/decision-context';
import {
  INTELLIGENCE_EVIDENCE_SOURCES,
  INTELLIGENCE_REVIEW_SCHEMA_VERSION,
  type IntelligenceEvidenceUnknown,
  type IntelligenceReviewActionSnapshot,
  type IntelligenceReviewEvidenceFact,
  type IntelligenceReviewRequest,
  type PreparedIntelligenceReviewInput,
} from './intelligence-review.types';

export interface IntelligenceReviewValidationResult {
  valid: boolean;
  issues: string[];
}

const OBJECTIVES: readonly ObjectiveKey[] = [
  'sales',
  'leads',
  'awareness',
  'traffic',
  'engagement',
  'video_views',
  'app_installs',
  'messages',
  'catalog_sales',
  'retargeting',
];

const ACTION_TYPES: readonly CampaignActionType[] = [
  'pause_ad',
  'pause_adset',
  'scale_adset',
  'replace_creative',
  'add_creative',
  'add_adset',
  'shift_budget_between_adsets',
  'reduce_total_budget',
  'narrow_placement',
  'dayparting',
];

const TARGET_TYPES = ['campaign', 'adset', 'ad'] as const;
const RISKS = ['low', 'medium', 'high'] as const;
const VERDICTS = ['support', 'hold', 'reject'] as const;
const EVIDENCE_KINDS = [
  'observed',
  'derived',
  'policy',
  'model_output',
] as const;
const ALLOWED_KINDS_BY_SOURCE = {
  snapshot: ['observed', 'derived'],
  objective: ['policy'],
  lifecycle: ['derived'],
  trend: ['derived'],
  revenue: ['derived'],
  signal: ['derived'],
  diagnosis: ['model_output'],
  business: ['observed', 'policy'],
  portfolio: ['derived'],
  forecast: ['model_output'],
  confidence: ['derived'],
  memory: ['observed', 'derived', 'model_output'],
  recommendation: ['model_output'],
} as const;
const MAX_ISSUES = 100;
const MAX_FACTS = 100;
const MAX_PARAMETERS_LENGTH = 20_000;
const UNKNOWN_EFFECTS: readonly IntelligenceEvidenceUnknown['effect'][] = [
  'reduces_confidence',
  'blocks_diagnosis',
  'blocks_recommendation',
  'blocks_execution',
  'blocks_validation',
];
const SUPPORT_BLOCKING_EFFECTS: readonly IntelligenceEvidenceUnknown['effect'][] =
  ['blocks_recommendation', 'blocks_execution', 'blocks_validation'];

const QUANTITATIVE_PROSE =
  /(?:\d|[%₹$€£]|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|percent|percentage|half|double|triple)\b)/i;

type UnknownRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addIssue(issues: string[], issue: string): void {
  if (issues.length < MAX_ISSUES && !issues.includes(issue)) {
    issues.push(issue);
  }
}

function validateExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addIssue(issues, `${path}:unexpected_key`);
  }
  for (const key of required) {
    if (!hasOwn(value, key)) addIssue(issues, `${path}.${key}:required`);
  }
}

function validateString(
  value: unknown,
  path: string,
  issues: string[],
  maxLength = 500,
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > maxLength
  ) {
    addIssue(issues, `${path}:invalid_string`);
    return false;
  }
  return true;
}

function validatePlainEnglish(
  value: unknown,
  path: string,
  issues: string[],
  maxLength = 600,
): void {
  if (
    validateString(value, path, issues, maxLength) &&
    QUANTITATIVE_PROSE.test(value)
  ) {
    addIssue(issues, `${path}:unverified_number`);
  }
}

function validateFiniteNumber(
  value: unknown,
  path: string,
  issues: string[],
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addIssue(issues, `${path}:invalid_number`);
    return false;
  }
  return true;
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: string[],
  options: { min?: number; max?: number; maxItemLength?: number } = {},
): value is string[] {
  if (!Array.isArray(value)) {
    addIssue(issues, `${path}:invalid_array`);
    return false;
  }
  const min = options.min ?? 0;
  const max = options.max ?? 50;
  if (value.length < min || value.length > max) {
    addIssue(issues, `${path}:invalid_length`);
  }
  for (const item of value) {
    validateString(item, `${path}[]`, issues, options.maxItemLength ?? 200);
  }
  if (new Set(value).size !== value.length) {
    addIssue(issues, `${path}:duplicate`);
  }
  return value.every((item) => typeof item === 'string');
}

function validateJsonValue(
  value: unknown,
  path: string,
  issues: string[],
  depth = 0,
): boolean {
  if (depth > 8) {
    addIssue(issues, `${path}:too_deep`);
    return false;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return validateFiniteNumber(value, path, issues);
  }
  if (Array.isArray(value)) {
    if (value.length > 100) addIssue(issues, `${path}:invalid_length`);
    return value.every((item) =>
      validateJsonValue(item, `${path}[]`, issues, depth + 1),
    );
  }
  if (!isPlainObject(value)) {
    addIssue(issues, `${path}:not_json`);
    return false;
  }
  let valid = true;
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      addIssue(issues, `${path}:unsafe_key`);
      valid = false;
      continue;
    }
    if (key.length === 0 || key.length > 100) {
      addIssue(issues, `${path}:invalid_key`);
      valid = false;
    }
    valid =
      validateJsonValue(child, `${path}.${key}`, issues, depth + 1) && valid;
  }
  return valid;
}

function validateEvidenceRefs(
  value: unknown,
  path: string,
  knownRefs: Set<string>,
  issues: string[],
  min = 0,
): void {
  if (!validateStringArray(value, path, issues, { min, max: 20 })) return;
  for (const ref of value) {
    if (!knownRefs.has(ref)) addIssue(issues, `${path}:unknown_evidence_ref`);
  }
}

function validateEvidenceFact(
  value: unknown,
  packetCampaignId: string | undefined,
  issues: string[],
): void {
  const path = 'request.packet.facts[]';
  if (!isPlainObject(value)) {
    addIssue(issues, `${path}:invalid_object`);
    return;
  }
  validateExactKeys(
    value,
    ['ref', 'step', 'source', 'kind', 'statement', 'value'],
    ['unit', 'targetType', 'targetId'],
    path,
    issues,
  );
  const ref = value.ref;
  const refValid = validateString(ref, `${path}.ref`, issues, 84);
  const stepValid =
    validateFiniteNumber(value.step, `${path}.step`, issues) &&
    Number.isInteger(value.step) &&
    value.step >= 1 &&
    value.step <= 13;
  if (typeof value.step === 'number' && !stepValid) {
    addIssue(issues, `${path}.step:out_of_range`);
  }
  const sourceValid =
    typeof value.source === 'string' &&
    hasOwn(INTELLIGENCE_EVIDENCE_SOURCES, value.source);
  if (!sourceValid) addIssue(issues, `${path}.source:invalid`);
  const kindValid = EVIDENCE_KINDS.includes(value.kind as never);
  if (!kindValid) addIssue(issues, `${path}.kind:invalid`);
  if (
    sourceValid &&
    kindValid &&
    !ALLOWED_KINDS_BY_SOURCE[
      value.source as keyof typeof ALLOWED_KINDS_BY_SOURCE
    ].includes(value.kind as never)
  ) {
    addIssue(issues, `${path}:source_kind_mismatch`);
  }
  if (
    sourceValid &&
    stepValid &&
    INTELLIGENCE_EVIDENCE_SOURCES[
      value.source as keyof typeof INTELLIGENCE_EVIDENCE_SOURCES
    ] !== value.step
  ) {
    addIssue(issues, `${path}:step_source_mismatch`);
  }
  if (refValid && stepValid) {
    const match = /^s(\d{1,2})[.:][a-z0-9][a-z0-9_.:-]*$/i.exec(ref);
    if (!match || Number(match[1]) !== value.step) {
      addIssue(issues, `${path}.ref:step_mismatch`);
    }
  }
  validateString(value.statement, `${path}.statement`, issues, 500);
  if (
    value.value !== null &&
    typeof value.value !== 'string' &&
    typeof value.value !== 'boolean' &&
    !validateFiniteNumber(value.value, `${path}.value`, issues)
  ) {
    addIssue(issues, `${path}.value:invalid_scalar`);
  }
  if (typeof value.value === 'string' && value.value.length > 500) {
    addIssue(issues, `${path}.value:too_long`);
  }
  if (hasOwn(value, 'unit')) {
    validateString(value.unit, `${path}.unit`, issues, 40);
  }

  const hasTargetType = hasOwn(value, 'targetType');
  const hasTargetId = hasOwn(value, 'targetId');
  if (hasTargetType !== hasTargetId) {
    addIssue(issues, `${path}:incomplete_target`);
  }
  if (hasTargetType && !TARGET_TYPES.includes(value.targetType as never)) {
    addIssue(issues, `${path}.targetType:invalid`);
  }
  if (hasTargetId) {
    validateString(value.targetId, `${path}.targetId`, issues, 200);
  }
  if (
    value.targetType === 'campaign' &&
    typeof packetCampaignId === 'string' &&
    value.targetId !== packetCampaignId
  ) {
    addIssue(issues, `${path}:campaign_target_mismatch`);
  }
}

function validateEvidenceUnknown(value: unknown, issues: string[]): void {
  const path = 'request.packet.unknowns[]';
  if (!isPlainObject(value)) {
    addIssue(issues, `${path}:invalid_object`);
    return;
  }
  validateExactKeys(value, ['code', 'statement', 'effect'], [], path, issues);
  if (
    validateString(value.code, `${path}.code`, issues, 200) &&
    !/^[a-z0-9][a-z0-9:_-]*$/i.test(value.code)
  ) {
    addIssue(issues, `${path}.code:invalid`);
  }
  validateString(value.statement, `${path}.statement`, issues, 500);
  if (!UNKNOWN_EFFECTS.includes(value.effect as never)) {
    addIssue(issues, `${path}.effect:invalid`);
  }
}

function validateExpectedImpact(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isPlainObject(value)) {
    addIssue(issues, `${path}:invalid_object`);
    return;
  }
  validateExactKeys(
    value,
    ['metric', 'deltaPct', 'confidence'],
    ['basis', 'currentValue', 'siblingBaselineValue', 'observedGapPct'],
    path,
    issues,
  );
  validateString(value.metric, `${path}.metric`, issues, 100);
  validateFiniteNumber(value.deltaPct, `${path}.deltaPct`, issues);
  if (validateFiniteNumber(value.confidence, `${path}.confidence`, issues)) {
    if (value.confidence < 0 || value.confidence > 1) {
      addIssue(issues, `${path}.confidence:out_of_range`);
    }
  }
  if (
    hasOwn(value, 'basis') &&
    !['modeled', 'observed_gap', 'not_estimated'].includes(
      value.basis as string,
    )
  ) {
    addIssue(issues, `${path}.basis:invalid`);
  }
  for (const field of [
    'currentValue',
    'siblingBaselineValue',
    'observedGapPct',
  ] as const) {
    if (hasOwn(value, field)) {
      validateFiniteNumber(value[field], `${path}.${field}`, issues);
    }
  }
}

function validateAction(
  value: unknown,
  packetCampaignId: string | undefined,
  issues: string[],
): void {
  const path = 'request.action';
  if (!isPlainObject(value)) {
    addIssue(issues, `${path}:invalid_object`);
    return;
  }
  validateExactKeys(
    value,
    [
      'actionId',
      'type',
      'targetType',
      'targetId',
      'parameters',
      'expectedImpact',
      'expectedProfitDeltaINR7d',
      'reasoning',
      'evidenceChain',
      'risk',
      'implementationCost',
      'score',
      'gatedBy',
      'requiresHumanApproval',
    ],
    [],
    path,
    issues,
  );
  validateString(value.actionId, `${path}.actionId`, issues, 200);
  if (!ACTION_TYPES.includes(value.type as CampaignActionType)) {
    addIssue(issues, `${path}.type:invalid`);
  }
  if (!TARGET_TYPES.includes(value.targetType as never)) {
    addIssue(issues, `${path}.targetType:invalid`);
  }
  validateString(value.targetId, `${path}.targetId`, issues, 200);
  if (
    value.targetType === 'campaign' &&
    typeof packetCampaignId === 'string' &&
    value.targetId !== packetCampaignId
  ) {
    addIssue(issues, `${path}:campaign_target_mismatch`);
  }
  if (!isPlainObject(value.parameters)) {
    addIssue(issues, `${path}.parameters:invalid_object`);
  } else {
    validateJsonValue(value.parameters, `${path}.parameters`, issues);
    try {
      if (stableStringify(value.parameters).length > MAX_PARAMETERS_LENGTH) {
        addIssue(issues, `${path}.parameters:too_large`);
      }
    } catch {
      addIssue(issues, `${path}.parameters:not_json`);
    }
  }
  validateExpectedImpact(
    value.expectedImpact,
    `${path}.expectedImpact`,
    issues,
  );
  validateFiniteNumber(
    value.expectedProfitDeltaINR7d,
    `${path}.expectedProfitDeltaINR7d`,
    issues,
  );
  validateString(value.reasoning, `${path}.reasoning`, issues, 5_000);
  if (!Array.isArray(value.evidenceChain) || value.evidenceChain.length > 100) {
    addIssue(issues, `${path}.evidenceChain:invalid_array`);
  } else {
    for (const item of value.evidenceChain) {
      if (!isPlainObject(item)) {
        addIssue(issues, `${path}.evidenceChain[]:invalid_object`);
        continue;
      }
      validateExactKeys(
        item,
        ['step', 'source'],
        [],
        `${path}.evidenceChain[]`,
        issues,
      );
      validateString(item.step, `${path}.evidenceChain[].step`, issues, 500);
      validateString(
        item.source,
        `${path}.evidenceChain[].source`,
        issues,
        200,
      );
    }
  }
  if (!RISKS.includes(value.risk as never)) {
    addIssue(issues, `${path}.risk:invalid`);
  }
  validateFiniteNumber(
    value.implementationCost,
    `${path}.implementationCost`,
    issues,
  );
  validateFiniteNumber(value.score, `${path}.score`, issues);
  validateStringArray(value.gatedBy, `${path}.gatedBy`, issues, {
    max: 50,
    maxItemLength: 200,
  });
  if (typeof value.requiresHumanApproval !== 'boolean') {
    addIssue(issues, `${path}.requiresHumanApproval:invalid_boolean`);
  }
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (isPlainObject(value)) {
    const copy: UnknownRecord = {};
    for (const [key, child] of Object.entries(value)) {
      copy[key] = cloneJsonValue(child);
    }
    return copy as T;
  }
  return value;
}

export function toIntelligenceReviewActionSnapshot(
  action: RecommendedAction,
): IntelligenceReviewActionSnapshot {
  return {
    actionId: action.actionId,
    type: action.type,
    targetType: action.targetType,
    targetId: action.targetId,
    parameters: cloneJsonValue(action.parameters),
    expectedImpact: { ...action.expectedImpact },
    expectedProfitDeltaINR7d: action.expectedProfitDeltaINR7d,
    risk: action.risk,
    implementationCost: action.implementationCost,
    score: action.score,
    gatedBy: [...action.gatedBy],
    requiresHumanApproval: action.requiresHumanApproval,
  };
}

function copyEvidenceFact(
  fact: IntelligenceReviewEvidenceFact,
): IntelligenceReviewEvidenceFact {
  return {
    ref: fact.ref,
    step: fact.step,
    source: fact.source,
    kind: fact.kind,
    statement: fact.statement,
    value: fact.value,
    ...(fact.unit === undefined ? {} : { unit: fact.unit }),
    ...(fact.targetType === undefined
      ? {}
      : { targetType: fact.targetType, targetId: fact.targetId }),
  };
}

export function prepareIntelligenceReviewInput(
  request: IntelligenceReviewRequest,
): PreparedIntelligenceReviewInput {
  return {
    schemaVersion: INTELLIGENCE_REVIEW_SCHEMA_VERSION,
    packet: {
      schemaVersion: request.packet.schemaVersion,
      cycleId: request.packet.cycleId,
      tenantId: request.packet.tenantId,
      campaignId: request.packet.campaignId,
      goal: {
        objective: request.packet.goal.objective,
        primaryKPI: request.packet.goal.primaryKPI,
        supportingKPIs: [...request.packet.goal.supportingKPIs].sort(),
        optimizationGoal: request.packet.goal.optimizationGoal,
        optimizationMetric: request.packet.goal.optimizationMetric,
      },
      facts: request.packet.facts
        .map(copyEvidenceFact)
        .sort((left, right) => left.ref.localeCompare(right.ref)),
      unknowns: request.packet.unknowns
        .map((unknown) => ({ ...unknown }))
        .sort((left, right) => left.code.localeCompare(right.code)),
    },
    action: {
      ...toIntelligenceReviewActionSnapshot(request.action),
      gatedBy: [...request.action.gatedBy].sort(),
    },
  };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new Error('Value is not JSON serializable');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (!isPlainObject(value))
    throw new Error('Value is not a plain JSON object');
  const fields = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${fields.join(',')}}`;
}

export function hashIntelligenceReviewInput(
  prepared: PreparedIntelligenceReviewInput,
): string {
  return createHash('sha256').update(stableStringify(prepared)).digest('hex');
}

export class IntelligenceReviewValidator {
  validateRequest(request: unknown): IntelligenceReviewValidationResult {
    const issues: string[] = [];
    if (!isPlainObject(request)) {
      return { valid: false, issues: ['request:invalid_object'] };
    }
    validateExactKeys(
      request,
      ['packet', 'action'],
      ['model'],
      'request',
      issues,
    );

    let campaignId: string | undefined;
    if (!isPlainObject(request.packet)) {
      addIssue(issues, 'request.packet:invalid_object');
    } else {
      const packet = request.packet;
      validateExactKeys(
        packet,
        [
          'schemaVersion',
          'cycleId',
          'tenantId',
          'campaignId',
          'goal',
          'facts',
          'unknowns',
        ],
        [],
        'request.packet',
        issues,
      );
      if (packet.schemaVersion !== INTELLIGENCE_REVIEW_SCHEMA_VERSION) {
        addIssue(issues, 'request.packet.schemaVersion:unsupported');
      }
      validateString(packet.cycleId, 'request.packet.cycleId', issues, 200);
      validateString(packet.tenantId, 'request.packet.tenantId', issues, 200);
      if (
        validateString(
          packet.campaignId,
          'request.packet.campaignId',
          issues,
          200,
        )
      ) {
        campaignId = packet.campaignId;
      }

      if (!isPlainObject(packet.goal)) {
        addIssue(issues, 'request.packet.goal:invalid_object');
      } else {
        validateExactKeys(
          packet.goal,
          [
            'objective',
            'primaryKPI',
            'supportingKPIs',
            'optimizationGoal',
            'optimizationMetric',
          ],
          [],
          'request.packet.goal',
          issues,
        );
        const objectiveValid = OBJECTIVES.includes(
          packet.goal.objective as ObjectiveKey,
        );
        if (!objectiveValid) {
          addIssue(issues, 'request.packet.goal.objective:invalid');
        }
        validateString(
          packet.goal.primaryKPI,
          'request.packet.goal.primaryKPI',
          issues,
          100,
        );
        const supportingKPIs = packet.goal.supportingKPIs;
        const supportingValid = validateStringArray(
          supportingKPIs,
          'request.packet.goal.supportingKPIs',
          issues,
          { max: 20, maxItemLength: 100 },
        );
        if (objectiveValid) {
          const profile = getProfile(packet.goal.objective as ObjectiveKey);
          if (packet.goal.primaryKPI !== profile.primaryKPI) {
            addIssue(issues, 'request.packet.goal:primary_kpi_mismatch');
          }
          if (
            supportingValid &&
            stableStringify([...supportingKPIs].sort()) !==
              stableStringify([...profile.supportingKPIs].sort())
          ) {
            addIssue(issues, 'request.packet.goal:supporting_kpis_mismatch');
          }
        }
        for (const field of [
          'optimizationGoal',
          'optimizationMetric',
        ] as const) {
          if (
            packet.goal[field] !== null &&
            !validateString(
              packet.goal[field],
              `request.packet.goal.${field}`,
              issues,
              100,
            )
          ) {
            addIssue(issues, `request.packet.goal.${field}:invalid`);
          }
        }
      }

      if (!Array.isArray(packet.facts)) {
        addIssue(issues, 'request.packet.facts:invalid_array');
      } else {
        if (packet.facts.length === 0 || packet.facts.length > MAX_FACTS) {
          addIssue(issues, 'request.packet.facts:invalid_length');
        }
        for (const fact of packet.facts) {
          validateEvidenceFact(fact, campaignId, issues);
        }
        const refs = packet.facts
          .filter(isPlainObject)
          .map((fact) => fact.ref)
          .filter((ref): ref is string => typeof ref === 'string');
        if (new Set(refs).size !== refs.length) {
          addIssue(issues, 'request.packet.facts:duplicate_ref');
        }
        if (
          !packet.facts.some(
            (fact) => isPlainObject(fact) && fact.kind === 'observed',
          )
        ) {
          addIssue(issues, 'request.packet.facts:observed_fact_required');
        }
      }

      if (!Array.isArray(packet.unknowns)) {
        addIssue(issues, 'request.packet.unknowns:invalid_array');
      } else {
        if (packet.unknowns.length > 50) {
          addIssue(issues, 'request.packet.unknowns:invalid_length');
        }
        for (const unknown of packet.unknowns) {
          validateEvidenceUnknown(unknown, issues);
        }
        const codes = packet.unknowns
          .filter(isPlainObject)
          .map((unknown) => unknown.code)
          .filter((code): code is string => typeof code === 'string');
        if (new Set(codes).size !== codes.length) {
          addIssue(issues, 'request.packet.unknowns:duplicate_code');
        }
      }
    }

    validateAction(request.action, campaignId, issues);
    if (hasOwn(request, 'model')) {
      if (
        validateString(request.model, 'request.model', issues, 100) &&
        !/^[a-z0-9][a-z0-9._:-]*$/i.test(request.model)
      ) {
        addIssue(issues, 'request.model:invalid');
      }
    }
    return { valid: issues.length === 0, issues };
  }

  validateDraft(
    draft: unknown,
    prepared: PreparedIntelligenceReviewInput,
  ): IntelligenceReviewValidationResult {
    const issues: string[] = [];
    if (!isPlainObject(draft)) {
      return { valid: false, issues: ['draft:invalid_object'] };
    }
    validateExactKeys(
      draft,
      [
        'verdict',
        'goal',
        'headline',
        'summary',
        'observedFacts',
        'hypotheses',
        'unknowns',
        'recommendation',
        'validationPlan',
      ],
      [],
      'draft',
      issues,
    );
    if (!VERDICTS.includes(draft.verdict as never)) {
      addIssue(issues, 'draft.verdict:invalid');
    }
    if (draft.verdict === 'support' && prepared.action.gatedBy.length > 0) {
      addIssue(issues, 'draft.verdict:gated_action_cannot_be_supported');
    }
    if (
      draft.verdict === 'support' &&
      prepared.packet.unknowns.some((unknown) =>
        SUPPORT_BLOCKING_EFFECTS.includes(unknown.effect),
      )
    ) {
      addIssue(issues, 'draft.verdict:blocking_unknown_cannot_be_supported');
    }

    if (!isPlainObject(draft.goal)) {
      addIssue(issues, 'draft.goal:invalid_object');
    } else {
      validateExactKeys(
        draft.goal,
        [
          'objective',
          'primaryKPI',
          'optimizationGoal',
          'optimizationMetric',
        ],
        [],
        'draft.goal',
        issues,
      );
      if (
        draft.goal.objective !== prepared.packet.goal.objective ||
        draft.goal.primaryKPI !== prepared.packet.goal.primaryKPI ||
        draft.goal.optimizationGoal !==
          prepared.packet.goal.optimizationGoal ||
        draft.goal.optimizationMetric !==
          prepared.packet.goal.optimizationMetric
      ) {
        addIssue(issues, 'draft.goal:mismatch');
      }
    }

    validatePlainEnglish(draft.headline, 'draft.headline', issues, 160);
    validatePlainEnglish(draft.summary, 'draft.summary', issues, 800);

    const factsByRef = new Map(
      prepared.packet.facts.map((fact) => [fact.ref, fact]),
    );
    const knownRefs = new Set(factsByRef.keys());
    if (!Array.isArray(draft.observedFacts)) {
      addIssue(issues, 'draft.observedFacts:invalid_array');
    } else {
      if (draft.observedFacts.length === 0 || draft.observedFacts.length > 20) {
        addIssue(issues, 'draft.observedFacts:invalid_length');
      }
      const seen = new Set<string>();
      for (const item of draft.observedFacts) {
        if (!isPlainObject(item)) {
          addIssue(issues, 'draft.observedFacts[]:invalid_object');
          continue;
        }
        validateExactKeys(
          item,
          ['evidenceRef', 'statement'],
          [],
          'draft.observedFacts[]',
          issues,
        );
        const evidenceRef = item.evidenceRef;
        const refValid = validateString(
          evidenceRef,
          'draft.observedFacts[].evidenceRef',
          issues,
          84,
        );
        validateString(
          item.statement,
          'draft.observedFacts[].statement',
          issues,
          500,
        );
        if (refValid) {
          if (seen.has(evidenceRef)) {
            addIssue(issues, 'draft.observedFacts:duplicate_evidence_ref');
          }
          seen.add(evidenceRef);
          const sourceFact = factsByRef.get(evidenceRef);
          if (!sourceFact) {
            addIssue(issues, 'draft.observedFacts:unknown_evidence_ref');
          } else if (sourceFact.kind !== 'observed') {
            addIssue(issues, 'draft.observedFacts:not_observed');
          } else if (item.statement !== sourceFact.statement) {
            addIssue(issues, 'draft.observedFacts:unsupported_claim');
          }
        }
      }
    }

    if (!Array.isArray(draft.hypotheses)) {
      addIssue(issues, 'draft.hypotheses:invalid_array');
    } else {
      if (draft.hypotheses.length > 10) {
        addIssue(issues, 'draft.hypotheses:invalid_length');
      }
      for (const item of draft.hypotheses) {
        if (!isPlainObject(item)) {
          addIssue(issues, 'draft.hypotheses[]:invalid_object');
          continue;
        }
        validateExactKeys(
          item,
          ['statement', 'confidence', 'evidenceRefs', 'counterevidenceRefs'],
          [],
          'draft.hypotheses[]',
          issues,
        );
        validatePlainEnglish(
          item.statement,
          'draft.hypotheses[].statement',
          issues,
          500,
        );
        if (
          validateFiniteNumber(
            item.confidence,
            'draft.hypotheses[].confidence',
            issues,
          ) &&
          (item.confidence < 0 || item.confidence > 1)
        ) {
          addIssue(issues, 'draft.hypotheses[].confidence:out_of_range');
        }
        validateEvidenceRefs(
          item.evidenceRefs,
          'draft.hypotheses[].evidenceRefs',
          knownRefs,
          issues,
          1,
        );
        validateEvidenceRefs(
          item.counterevidenceRefs,
          'draft.hypotheses[].counterevidenceRefs',
          knownRefs,
          issues,
        );
      }
    }

    if (!Array.isArray(draft.unknowns)) {
      addIssue(issues, 'draft.unknowns:invalid_array');
    } else {
      if (draft.unknowns.length > 10) {
        addIssue(issues, 'draft.unknowns:invalid_length');
      }
      for (const item of draft.unknowns) {
        if (!isPlainObject(item)) {
          addIssue(issues, 'draft.unknowns[]:invalid_object');
          continue;
        }
        validateExactKeys(
          item,
          ['question', 'whyItMatters'],
          [],
          'draft.unknowns[]',
          issues,
        );
        validatePlainEnglish(
          item.question,
          'draft.unknowns[].question',
          issues,
        );
        validatePlainEnglish(
          item.whyItMatters,
          'draft.unknowns[].whyItMatters',
          issues,
        );
      }
    }

    if (!isPlainObject(draft.recommendation)) {
      addIssue(issues, 'draft.recommendation:invalid_object');
    } else {
      validateExactKeys(
        draft.recommendation,
        ['action', 'interpretation'],
        [],
        'draft.recommendation',
        issues,
      );
      validatePlainEnglish(
        draft.recommendation.interpretation,
        'draft.recommendation.interpretation',
        issues,
        800,
      );
      try {
        if (
          stableStringify(draft.recommendation.action) !==
          stableStringify(prepared.action)
        ) {
          addIssue(issues, 'draft.recommendation.action:changed');
        }
      } catch {
        addIssue(issues, 'draft.recommendation.action:changed');
      }
    }

    const allowedMetrics = new Set([
      prepared.packet.goal.primaryKPI,
      ...prepared.packet.goal.supportingKPIs,
      prepared.action.expectedImpact.metric,
    ]);
    if (!isPlainObject(draft.validationPlan)) {
      addIssue(issues, 'draft.validationPlan:invalid_object');
    } else {
      validateExactKeys(
        draft.validationPlan,
        ['after24h', 'after72h'],
        [],
        'draft.validationPlan',
        issues,
      );
      for (const horizon of ['after24h', 'after72h'] as const) {
        const checks = draft.validationPlan[horizon];
        if (!Array.isArray(checks)) {
          addIssue(issues, `draft.validationPlan.${horizon}:invalid_array`);
          continue;
        }
        if (checks.length === 0 || checks.length > 8) {
          addIssue(issues, `draft.validationPlan.${horizon}:invalid_length`);
        }
        for (const item of checks) {
          const path = `draft.validationPlan.${horizon}[]`;
          if (!isPlainObject(item)) {
            addIssue(issues, `${path}:invalid_object`);
            continue;
          }
          validateExactKeys(
            item,
            ['metric', 'check', 'evidenceRefs'],
            [],
            path,
            issues,
          );
          if (
            validateString(item.metric, `${path}.metric`, issues, 100) &&
            !allowedMetrics.has(item.metric)
          ) {
            addIssue(issues, `${path}.metric:goal_mismatch`);
          }
          validatePlainEnglish(item.check, `${path}.check`, issues, 400);
          validateEvidenceRefs(
            item.evidenceRefs,
            `${path}.evidenceRefs`,
            knownRefs,
            issues,
            1,
          );
        }
      }
    }

    return { valid: issues.length === 0, issues };
  }
}
