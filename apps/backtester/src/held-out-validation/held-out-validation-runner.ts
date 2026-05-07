import {
  ACTIVE_STRATEGY_IDS,
  isStrategyId,
  type StrategyId,
} from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  buildCapabilityAssessmentSet,
  type CapabilityAssessmentSet,
  type StrategyCapabilityAssessment,
  type StrategyCapabilityLimitation,
} from '../capability-assessment/index.js';
import {
  buildTierBOosReplayPlan,
  type StrategyOosWindowReason,
} from '../oos-replay/index.js';
import {
  computeStrategyFingerprintSet,
  type StrategyFingerprint,
  type StrategyFingerprintSet,
} from '../strategy-fingerprint/index.js';
import {
  DEFAULT_VALIDATION_GATE_POLICY_V1,
  evaluateValidationGateSet,
  type StrategyValidationGateInput,
  type StrategyValidationWindowInput,
  type StrategyValidationGateResult,
  type ValidationTrialAccounting,
} from '../validation-gate/index.js';
import {
  throwHeldOutValidationIssues,
  type HeldOutValidationIssue,
} from './held-out-validation-error.js';
import type {
  HeldOutValidationRunOptions,
  HeldOutValidationRunResult,
  HeldOutValidationWindowReason,
  HeldOutValidationWindowResult,
} from './types.js';

const HELD_OUT_REASON_ORDER: readonly HeldOutValidationWindowReason[] = Object.freeze([
  'fidelity_failed',
  'fidelity_pending',
  'fingerprint_missing',
  'capability_missing',
  'capability_blocked',
  'validation_gate_missing',
  'validation_gate_blocked',
  'validation_gate_insufficient_evidence',
  'validation_gate_failed',
  'framework_only_no_replay_execution',
]);

export async function runHeldOutValidation(
  options: HeldOutValidationRunOptions,
): Promise<HeldOutValidationRunResult> {
  return buildHeldOutValidationResult(options);
}

export function buildHeldOutValidationResult(
  options: HeldOutValidationRunOptions,
): HeldOutValidationRunResult {
  validateOptions(options);

  const strategyOrder = resolveStrategyOrder(options.strategy_order);
  const replayEvaluations = options.replay_evaluations ?? [];
  const fingerprintSet =
    options.strategy_fingerprint_set ??
    computeStrategyFingerprintSet(replayEvaluations, ACTIVE_STRATEGY_IDS);
  const capabilitySet =
    options.capability_assessment_set ??
    buildCapabilityAssessmentSet(replayEvaluations, fingerprintSet, {
      strategy_order: ACTIVE_STRATEGY_IDS,
    });

  const validationGateResultSet = evaluateValidationGateSet(
    buildValidationGateInputs(options, strategyOrder, fingerprintSet, capabilitySet),
    options.validation_policy ?? DEFAULT_VALIDATION_GATE_POLICY_V1,
    strategyOrder,
  );

  const oosFrameworkResult = buildTierBOosReplayPlan({
    walk_forward_plan: options.walk_forward_plan,
    strategy_order: strategyOrder,
    input_spec: options.input_spec,
    strategy_fingerprints: fingerprintSet,
    capability_assessments: capabilitySet,
    validation_gate_results: validationGateResultSet,
  });
  const validationByStrategy = indexValidationResults(validationGateResultSet.results);
  const windowResults = Object.freeze(
    oosFrameworkResult.windows.map((window): HeldOutValidationWindowResult => {
      const validation = validationByStrategy.get(window.strategy_id) ?? null;
      return Object.freeze({
        result_schema_version: 1,
        strategy_id: window.strategy_id,
        window_id: window.window_id,
        window_sequence: window.window_sequence,
        replay_status: window.status,
        fingerprint_sha256: window.fingerprint_sha256,
        capability_status: window.capability_status,
        validation_status: window.validation_status,
        reasons: mergeReasons(window.reasons, validation),
      });
    }),
  );

  return Object.freeze({
    result_schema_version: 1,
    run_id: options.run_id,
    input_spec: options.input_spec,
    oos_framework_result: oosFrameworkResult,
    validation_gate_result_set: validationGateResultSet,
    window_results: windowResults,
  });
}

function validateOptions(options: HeldOutValidationRunOptions): void {
  const issues: HeldOutValidationIssue[] = [];
  if (options.run_id.trim().length === 0) {
    issues.push({
      path: '$.run_id',
      code: 'missing_run_id',
      message: 'run_id must be a non-empty string',
    });
  }
  if (options.input_spec === null || typeof options.input_spec !== 'object') {
    issues.push({
      path: '$.input_spec',
      code: 'missing_input_spec',
      message: 'input_spec is required',
    });
  }
  if (
    options.walk_forward_plan === null ||
    typeof options.walk_forward_plan !== 'object' ||
    !Array.isArray(options.walk_forward_plan.windows)
  ) {
    issues.push({
      path: '$.walk_forward_plan',
      code: 'missing_walk_forward_plan',
      message: 'walk_forward_plan with windows is required',
    });
  }
  validateStrategyOrder(options.strategy_order, issues);
  validateValidationArtifacts(options.validation_windows ?? [], issues);
  if (issues.length > 0) {
    throwHeldOutValidationIssues(issues);
  }
}

function validateStrategyOrder(
  strategyOrder: readonly StrategyId[],
  issues: HeldOutValidationIssue[],
): void {
  if (strategyOrder.length === 0) {
    issues.push({
      path: '$.strategy_order',
      code: 'invalid_strategy_order',
      message: 'strategy_order must include at least one strategy',
    });
    return;
  }
  const seen = new Set<StrategyId>();
  strategyOrder.forEach((strategyId, index) => {
    if (!isStrategyId(strategyId)) {
      issues.push({
        path: `$.strategy_order[${index}]`,
        code: 'invalid_strategy_order',
        message: `unknown strategy_id: ${String(strategyId)}`,
      });
      return;
    }
    if (seen.has(strategyId)) {
      issues.push({
        path: `$.strategy_order[${index}]`,
        code: 'duplicate_strategy_id',
        message: `duplicate strategy_id: ${strategyId}`,
      });
      return;
    }
    seen.add(strategyId);
  });
}

function validateValidationArtifacts(
  validationWindows: readonly StrategyValidationWindowInput[],
  issues: HeldOutValidationIssue[],
): void {
  validationWindows.forEach((window, index) => {
    if (!isStrategyId(window.strategy_id)) {
      issues.push({
        path: `$.validation_windows[${index}].strategy_id`,
        code: 'invalid_validation_artifact',
        message: `unknown validation window strategy_id: ${String(window.strategy_id)}`,
      });
    }
  });
}

function resolveStrategyOrder(strategyOrder: readonly StrategyId[]): readonly StrategyId[] {
  return Object.freeze([...strategyOrder]);
}

function buildValidationGateInputs(
  options: HeldOutValidationRunOptions,
  strategyOrder: readonly StrategyId[],
  fingerprintSet: StrategyFingerprintSet,
  capabilitySet: CapabilityAssessmentSet,
): readonly StrategyValidationGateInput[] {
  const fingerprints = indexFingerprints(fingerprintSet.fingerprints);
  const capabilities = indexCapabilities(capabilitySet.assessments);
  const validationWindows = groupValidationWindows(options.validation_windows ?? []);
  const trialAccounting = indexTrialAccounting(options.trial_accounting ?? []);

  return Object.freeze(
    strategyOrder.map((strategyId) =>
      Object.freeze({
        strategy_id: strategyId,
        capability_assessment:
          capabilities.get(strategyId) ?? missingCapabilityAssessment(strategyId),
        fingerprint: fingerprints.get(strategyId) ?? null,
        session_order: options.walk_forward_plan.sessions,
        windows: validationWindows.get(strategyId) ?? [],
        trial_accounting: trialAccounting.get(strategyId) ?? null,
      }),
    ),
  );
}

function missingCapabilityAssessment(strategyId: StrategyId): StrategyCapabilityAssessment {
  const limitations: readonly StrategyCapabilityLimitation[] = Object.freeze([
    {
      code: 'replay_missing',
      message: 'held-out validation replay artifacts were not provided',
    },
    {
      code: 'fingerprint_missing',
      message: 'held-out validation fingerprint artifact was not provided',
    },
  ]);

  return Object.freeze({
    assessment_schema_version: 1,
    strategy_id: strategyId,
    status: 'blocked',
    replay_evaluations: 0,
    fingerprint_sha256: null,
    decision_count: null,
    features: Object.freeze([]),
    limitations,
  });
}

function indexFingerprints(
  fingerprints: readonly StrategyFingerprint[],
): ReadonlyMap<StrategyId, StrategyFingerprint> {
  const output = new Map<StrategyId, StrategyFingerprint>();
  for (const fingerprint of fingerprints) {
    output.set(fingerprint.strategy_id, fingerprint);
  }
  return output;
}

function indexCapabilities(
  capabilities: readonly StrategyCapabilityAssessment[],
): ReadonlyMap<StrategyId, StrategyCapabilityAssessment> {
  const output = new Map<StrategyId, StrategyCapabilityAssessment>();
  for (const capability of capabilities) {
    output.set(capability.strategy_id, capability);
  }
  return output;
}

function indexTrialAccounting(
  trialAccounting: readonly ValidationTrialAccounting[],
): ReadonlyMap<StrategyId, ValidationTrialAccounting> {
  const output = new Map<StrategyId, ValidationTrialAccounting>();
  for (const trial of trialAccounting) {
    output.set(trial.strategy_id, trial);
  }
  return output;
}

function groupValidationWindows(
  windows: readonly StrategyValidationWindowInput[],
): ReadonlyMap<StrategyId, readonly StrategyValidationWindowInput[]> {
  const grouped = new Map<StrategyId, StrategyValidationWindowInput[]>();
  for (const window of windows) {
    const group = grouped.get(window.strategy_id);
    if (group === undefined) {
      grouped.set(window.strategy_id, [window]);
      continue;
    }
    group.push(window);
  }
  const sorted = new Map<StrategyId, readonly StrategyValidationWindowInput[]>();
  for (const [strategyId, group] of grouped.entries()) {
    sorted.set(
      strategyId,
      Object.freeze(
        [...group].sort((left, right) => {
          const sequenceOrder = left.sequence - right.sequence;
          if (sequenceOrder !== 0) {
            return sequenceOrder;
          }
          return left.window_id.localeCompare(right.window_id);
        }),
      ),
    );
  }
  return sorted;
}

function indexValidationResults(
  results: readonly StrategyValidationGateResult[],
): ReadonlyMap<StrategyId, StrategyValidationGateResult> {
  const output = new Map<StrategyId, StrategyValidationGateResult>();
  for (const result of results) {
    output.set(result.strategy_id, result);
  }
  return output;
}

function mergeReasons(
  oosReasons: readonly StrategyOosWindowReason[],
  validation: StrategyValidationGateResult | null,
): readonly HeldOutValidationWindowReason[] {
  const reasons = new Set<HeldOutValidationWindowReason>(oosReasons);
  if (validation?.status === 'insufficient_evidence') {
    reasons.add('validation_gate_insufficient_evidence');
  }
  if (validation?.status === 'fail') {
    reasons.add('validation_gate_failed');
  }
  return Object.freeze(HELD_OUT_REASON_ORDER.filter((reason) => reasons.has(reason)));
}
