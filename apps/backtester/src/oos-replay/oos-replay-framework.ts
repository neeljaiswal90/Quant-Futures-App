import { ACTIVE_STRATEGY_IDS, isStrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { StrategyFingerprint, StrategyFingerprintSet } from '../strategy-fingerprint/index.js';
import type {
  CapabilityAssessmentSet,
  StrategyCapabilityAssessment,
} from '../capability-assessment/index.js';
import type {
  StrategyValidationGateResult,
  ValidationGateResultSet,
} from '../validation-gate/index.js';
import {
  OosReplayInputError,
  type OosReplayIssue,
} from './oos-replay-error.js';
import {
  type BuildTierBOosReplayPlanArgs,
  type OosReplayFrameworkResult,
  type StrategyOosWindowReason,
  type StrategyOosWindowResult,
  type StrategyOosWindowStatus,
  type TierBOosInputSpec,
} from './types.js';

const REASON_ORDER: readonly StrategyOosWindowReason[] = Object.freeze([
  'fidelity_failed',
  'fidelity_pending',
  'fingerprint_missing',
  'capability_missing',
  'capability_blocked',
  'validation_gate_missing',
  'validation_gate_blocked',
  'framework_only_no_replay_execution',
]);

export function buildTierBOosReplayPlan(args: BuildTierBOosReplayPlanArgs): OosReplayFrameworkResult {
  validateReplayPlanArgs(args);
  const strategyOrder = resolveStrategyOrder(args.strategy_order);
  const fingerprints = indexFingerprints(args.strategy_fingerprints);
  const capabilities = indexCapabilities(args.capability_assessments);
  const validationResults = indexValidationResults(args.validation_gate_results);

  const windows: StrategyOosWindowResult[] = [];
  for (const window of args.walk_forward_plan.windows) {
    for (const strategyId of strategyOrder) {
      const fingerprint = fingerprints.get(strategyId) ?? null;
      const capability = capabilities.get(strategyId) ?? null;
      const validation = validationResults.get(strategyId) ?? null;
      const reasons = buildReasons(args.input_spec, fingerprint, capability, validation);
      windows.push(Object.freeze({
        result_schema_version: 1,
        strategy_id: strategyId,
        window_id: window.window_id,
        window_sequence: window.sequence,
        test_start_session: window.test.start_session,
        test_end_session: window.test.end_session,
        status: deriveWindowStatus(args.input_spec, capability, validation),
        fingerprint_sha256: fingerprint?.fingerprint_sha256 ?? null,
        capability_status: capability?.status ?? null,
        validation_status: validation?.status ?? null,
        reasons,
      }));
    }
  }

  return Object.freeze({
    result_schema_version: 1,
    input_spec: args.input_spec,
    windows,
  });
}

function validateReplayPlanArgs(args: BuildTierBOosReplayPlanArgs): void {
  const issues: OosReplayIssue[] = [];
  if (args.walk_forward_plan === null || typeof args.walk_forward_plan !== 'object') {
    issues.push({
      path: '$.walk_forward_plan',
      code: 'missing_walk_forward_plan',
      message: 'walk_forward_plan is required',
    });
  }
  if (args.input_spec === null || typeof args.input_spec !== 'object') {
    issues.push({
      path: '$.input_spec',
      code: 'missing_input_spec',
      message: 'input_spec is required',
    });
  } else {
    validateInputSpec(args.input_spec, issues);
  }
  validateStrategyOrder(args.strategy_order, issues);
  if (issues.length > 0) {
    throw new OosReplayInputError(issues);
  }
}

function validateInputSpec(inputSpec: TierBOosInputSpec, issues: OosReplayIssue[]): void {
  if (
    inputSpec.spec_schema_version !== 1 ||
    inputSpec.required_schemas[0] !== 'mbp-1' ||
    inputSpec.required_schemas[1] !== 'trades'
  ) {
    issues.push({
      path: '$.input_spec',
      code: 'invalid_input_spec',
      message: 'input_spec must be a Tier B OOS spec requiring mbp-1 and trades',
    });
  }
}

function validateStrategyOrder(strategyOrder: readonly StrategyId[], issues: OosReplayIssue[]): void {
  const seen = new Set<StrategyId>();
  strategyOrder.forEach((strategyId, index) => {
    if (!isStrategyId(strategyId)) {
      issues.push({
        path: `$.strategy_order[${index}]`,
        code: 'unknown_strategy_id',
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

function resolveStrategyOrder(strategyOrder: readonly StrategyId[]): readonly StrategyId[] {
  validateStrategyOrder(strategyOrder, []);
  return Object.freeze([...strategyOrder]);
}

function indexFingerprints(
  input: StrategyFingerprintSet | readonly StrategyFingerprint[] | undefined,
): ReadonlyMap<StrategyId, StrategyFingerprint> {
  const fingerprints = isReadonlyArray<StrategyFingerprint>(input) ? input : input?.fingerprints ?? [];
  return indexByStrategy(fingerprints, 'fingerprint');
}

function indexCapabilities(
  input: CapabilityAssessmentSet | readonly StrategyCapabilityAssessment[] | undefined,
): ReadonlyMap<StrategyId, StrategyCapabilityAssessment> {
  const capabilities = isReadonlyArray<StrategyCapabilityAssessment>(input) ? input : input?.assessments ?? [];
  return indexByStrategy(capabilities, 'capability');
}

function indexValidationResults(
  input: ValidationGateResultSet | readonly StrategyValidationGateResult[] | undefined,
): ReadonlyMap<StrategyId, StrategyValidationGateResult> {
  const validationResults = isReadonlyArray<StrategyValidationGateResult>(input) ? input : input?.results ?? [];
  return indexByStrategy(validationResults, 'validation');
}

function isReadonlyArray<TItem>(input: unknown): input is readonly TItem[] {
  return Array.isArray(input);
}

function indexByStrategy<TItem extends { readonly strategy_id: StrategyId }>(
  items: readonly TItem[],
  artifactName: string,
): ReadonlyMap<StrategyId, TItem> {
  const issues: OosReplayIssue[] = [];
  const output = new Map<StrategyId, TItem>();
  items.forEach((item, index) => {
    if (!isStrategyId(item.strategy_id)) {
      issues.push({
        path: `$.${artifactName}[${index}].strategy_id`,
        code: 'invalid_artifact_strategy_id',
        message: `${artifactName} has unknown strategy_id: ${String(item.strategy_id)}`,
      });
      return;
    }
    output.set(item.strategy_id, item);
  });
  if (issues.length > 0) {
    throw new OosReplayInputError(issues);
  }
  return output;
}

function deriveWindowStatus(
  inputSpec: TierBOosInputSpec,
  capability: StrategyCapabilityAssessment | null,
  validation: StrategyValidationGateResult | null,
): StrategyOosWindowStatus {
  if (inputSpec.fidelity_status === 'failed') {
    return 'blocked';
  }
  if (capability?.status === 'blocked') {
    return 'blocked';
  }
  if (validation?.status === 'blocked') {
    return 'blocked';
  }
  if (validation === null) {
    return 'insufficient_evidence';
  }
  return 'evaluated';
}

function buildReasons(
  inputSpec: TierBOosInputSpec,
  fingerprint: StrategyFingerprint | null,
  capability: StrategyCapabilityAssessment | null,
  validation: StrategyValidationGateResult | null,
): readonly StrategyOosWindowReason[] {
  const reasons = new Set<StrategyOosWindowReason>();
  if (inputSpec.fidelity_status === 'failed') {
    reasons.add('fidelity_failed');
  }
  if (inputSpec.fidelity_status === 'pending') {
    reasons.add('fidelity_pending');
  }
  if (fingerprint === null) {
    reasons.add('fingerprint_missing');
  }
  if (capability === null) {
    reasons.add('capability_missing');
  }
  if (capability?.status === 'blocked') {
    reasons.add('capability_blocked');
  }
  if (validation === null) {
    reasons.add('validation_gate_missing');
    reasons.add('framework_only_no_replay_execution');
  }
  if (validation?.status === 'blocked') {
    reasons.add('validation_gate_blocked');
  }
  return Object.freeze(REASON_ORDER.filter((reason) => reasons.has(reason)));
}

export function defaultOosStrategyOrder(): readonly StrategyId[] {
  return Object.freeze([...ACTIVE_STRATEGY_IDS]);
}
