import { createHash } from 'node:crypto';
import {
  ACTIVE_STRATEGY_IDS,
  isStrategyId,
  type StrategyId,
} from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  buildCapabilityAssessmentSet,
  type CapabilityAssessmentSet,
  type StrategyCapabilityAssessment,
  type StrategyFeatureCapability,
  type StrategyCapabilityLimitation,
} from '../capability-assessment/index.js';
import {
  buildTierBOosReplayPlan,
  type StrategyOosWindowReason,
} from '../oos-replay/index.js';
import {
  computeStrategyFingerprintSet,
  STRATEGY_FINGERPRINT_ALGORITHM,
  type StrategyFingerprint,
  type StrategyFingerprintSet,
} from '../strategy-fingerprint/index.js';
import {
  runRealArchiveBacktest,
  type RealArchiveBacktestResult,
  type RealArchiveSessionSource,
} from '../real-archive-execution/index.js';
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
  HeldOutValidationRealArchiveOptions,
  HeldOutValidationRealArchiveResult,
  HeldOutValidationRealArchiveStrategyResult,
  HeldOutValidationRealArchiveWindowResult,
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

export async function executeHeldOutValidationAgainstArchive(
  options: HeldOutValidationRealArchiveOptions,
): Promise<HeldOutValidationRealArchiveResult> {
  validateRealArchiveOptions(options);
  const strategyOrder = resolveStrategyOrder(options.strategy_order);
  const sessionsById = new Map(options.archive_sessions.map((session) => [session.session_id, session]));
  const rawExecutionResults: RealArchiveBacktestResult[] = [];
  const validationWindows: StrategyValidationWindowInput[] = [];
  const perStrategy: HeldOutValidationRealArchiveStrategyResult[] = [];

  for (const strategyId of strategyOrder) {
    const windows: HeldOutValidationRealArchiveWindowResult[] = [];
    for (const window of options.walk_forward_plan.windows) {
      const windowSessions = sessionsForRange(
        options.walk_forward_plan.sessions,
        sessionsById,
        window.test.start_session,
        window.test.end_session,
      );
      if (windowSessions.length === 0) {
        windows.push(Object.freeze({
          result_schema_version: 1,
          strategy_id: strategyId,
          window_id: window.window_id,
          window_sequence: window.sequence,
          test_start_session: window.test.start_session,
          test_end_session: window.test.end_session,
          status: 'skipped_no_sessions',
          reasons: Object.freeze(['no_archive_sessions_for_test_window']),
          per_trade_records: Object.freeze([]),
          trade_summary: null,
          runtime_metrics: null,
        }));
        continue;
      }

      try {
        const execution = await runRealArchiveBacktest({
          run_id: `${options.run_id}-${strategyId}-${window.window_id}`,
          strategy_id: strategyId,
          sessions: windowSessions,
          run_started_at_ns: options.run_started_at_ns,
          fill_policy: options.fill_policy,
          initial_equity_cents: options.initial_equity_cents,
          strategy_generator: options.strategy_generators?.[strategyId],
        });
        rawExecutionResults.push(execution);
        const fingerprintSha256 = fingerprintExecution(strategyId, [execution]);
        validationWindows.push(validationWindowFromExecution({
          strategyId,
          windowId: window.window_id,
          sequence: window.sequence,
          startSession: window.test.start_session,
          endSession: window.test.end_session,
          startIndex: options.walk_forward_plan.sessions.indexOf(window.test.start_session),
          endIndex: options.walk_forward_plan.sessions.indexOf(window.test.end_session),
          execution,
          fingerprintSha256,
          initialEquityCents: options.initial_equity_cents ?? 3_000_000n,
        }));
        windows.push(Object.freeze({
          result_schema_version: 1,
          strategy_id: strategyId,
          window_id: window.window_id,
          window_sequence: window.sequence,
          test_start_session: window.test.start_session,
          test_end_session: window.test.end_session,
          status: 'executed',
          reasons: Object.freeze([]),
          per_trade_records: execution.per_trade_records,
          trade_summary: execution.trade_analysis.summary,
          runtime_metrics: execution.runtime_metrics,
        }));
      } catch (error) {
        windows.push(Object.freeze({
          result_schema_version: 1,
          strategy_id: strategyId,
          window_id: window.window_id,
          window_sequence: window.sequence,
          test_start_session: window.test.start_session,
          test_end_session: window.test.end_session,
          status: 'failed',
          reasons: Object.freeze([error instanceof Error ? error.message : String(error)]),
          per_trade_records: Object.freeze([]),
          trade_summary: null,
          runtime_metrics: null,
        }));
      }
    }
    const strategyExecutions = rawExecutionResults.filter((result) => result.strategy_id === strategyId);
    const fingerprintSha256 = fingerprintExecution(strategyId, strategyExecutions);
    perStrategy.push(Object.freeze({
      result_schema_version: 1,
      strategy_id: strategyId,
      fingerprint_sha256: fingerprintSha256,
      windows: Object.freeze(windows),
      total_trades: windows.reduce((sum, window) => sum + window.per_trade_records.length, 0),
    }));
  }

  const fingerprintSet = fingerprintSetFromRealArchive(perStrategy);
  const capabilitySet = capabilitySetFromRealArchive(perStrategy, fingerprintSet);
  const frameworkResult = buildHeldOutValidationResult({
    run_id: options.run_id,
    input_spec: options.input_spec,
    walk_forward_plan: options.walk_forward_plan,
    strategy_order: strategyOrder,
    validation_policy: options.validation_policy,
    strategy_fingerprint_set: fingerprintSet,
    capability_assessment_set: capabilitySet,
    validation_windows: validationWindows,
    trial_accounting: strategyOrder.map((strategyId) => trialAccounting(strategyId, strategyOrder.length)),
  });

  return Object.freeze({
    result_schema_version: 1,
    run_id: options.run_id,
    framework_result: frameworkResult,
    per_strategy_real_records: Object.freeze(perStrategy),
    raw_execution_results: Object.freeze(rawExecutionResults),
  });
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

function validateRealArchiveOptions(options: HeldOutValidationRealArchiveOptions): void {
  const issues: HeldOutValidationIssue[] = [];
  if (options.archive_sessions.length === 0) {
    issues.push({
      path: '$.archive_sessions',
      code: 'missing_input_spec',
      message: 'archive_sessions must include at least one session',
    });
  }
  validateOptions({
    run_id: options.run_id,
    input_spec: options.input_spec,
    walk_forward_plan: options.walk_forward_plan,
    strategy_order: options.strategy_order,
    validation_policy: options.validation_policy,
  });
  if (issues.length > 0) {
    throwHeldOutValidationIssues(issues);
  }
}

function sessionsForRange(
  sessionOrder: readonly string[],
  sessionsById: ReadonlyMap<string, RealArchiveSessionSource>,
  startSession: string,
  endSession: string,
): readonly RealArchiveSessionSource[] {
  const startIndex = sessionOrder.indexOf(startSession);
  const endIndex = sessionOrder.indexOf(endSession);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    return Object.freeze([]);
  }
  return Object.freeze(
    sessionOrder
      .slice(startIndex, endIndex)
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is RealArchiveSessionSource => session !== undefined),
  );
}

function validationWindowFromExecution(input: {
  readonly strategyId: StrategyId;
  readonly windowId: string;
  readonly sequence: number;
  readonly startSession: string;
  readonly endSession: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly execution: RealArchiveBacktestResult;
  readonly fingerprintSha256: string;
  readonly initialEquityCents: bigint;
}): StrategyValidationWindowInput {
  const summary = input.execution.trade_analysis.summary;
  return Object.freeze({
    strategy_id: input.strategyId,
    window_id: input.windowId,
    sequence: input.sequence,
    role: 'test',
    start_session: input.startSession,
    end_session: input.endSession,
    start_index: input.startIndex,
    end_index: input.endIndex,
    total_trades: summary.total_trades,
    gross_profit_cents: summary.gross_profit_cents,
    gross_loss_cents: absBigint(summary.gross_loss_cents),
    net_pnl_cents: summary.net_pnl_cents,
    profit_factor_ppm: summary.profit_factor_ppm,
    max_drawdown_cents: summary.max_drawdown_cents,
    initial_equity_cents: input.initialEquityCents,
    average_trade_pnl_cents: summary.average_trade_pnl_cents,
    win_rate_ppm: summary.win_rate_ppm,
    fingerprint_sha256: input.fingerprintSha256,
    fingerprint_algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
  });
}

function fingerprintSetFromRealArchive(
  perStrategy: readonly HeldOutValidationRealArchiveStrategyResult[],
): StrategyFingerprintSet {
  return Object.freeze({
    fingerprint_set_schema_version: 1,
    algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
    fingerprints: Object.freeze(
      perStrategy.map((strategy) => Object.freeze({
        fingerprint_schema_version: 1,
        algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
        strategy_id: strategy.strategy_id,
        decision_count: strategy.windows.reduce(
          (sum, window) => sum + (window.runtime_metrics?.bars_processed ?? 0),
          0,
        ),
        decisions_sha256: hashStable({
          strategy_id: strategy.strategy_id,
          windows: strategy.windows.map((window) => ({
            window_id: window.window_id,
            status: window.status,
            trades: window.per_trade_records,
          })),
        }),
        fingerprint_sha256: strategy.fingerprint_sha256,
      })),
    ),
  });
}

function capabilitySetFromRealArchive(
  perStrategy: readonly HeldOutValidationRealArchiveStrategyResult[],
  fingerprints: StrategyFingerprintSet,
): CapabilityAssessmentSet {
  const fingerprintByStrategy = new Map(fingerprints.fingerprints.map((fingerprint) => [
    fingerprint.strategy_id,
    fingerprint,
  ]));
  return Object.freeze({
    assessment_set_schema_version: 1,
    assessments: Object.freeze(
      perStrategy.map((strategy) => {
        const fingerprint = fingerprintByStrategy.get(strategy.strategy_id) ?? null;
        const executedWindows = strategy.windows.filter((window) => window.status === 'executed');
        return Object.freeze({
          assessment_schema_version: 1,
          strategy_id: strategy.strategy_id,
          status: executedWindows.length === 0 ? 'blocked' : 'ready_for_replay',
          replay_evaluations: executedWindows.reduce(
            (sum, window) => sum + (window.runtime_metrics?.bars_processed ?? 0),
            0,
          ),
          fingerprint_sha256: fingerprint?.fingerprint_sha256 ?? null,
          decision_count: fingerprint?.decision_count ?? null,
          features: realArchiveFeatureCapabilities(fingerprint?.fingerprint_sha256 ?? null),
          limitations: executedWindows.length === 0
            ? Object.freeze([{
              code: 'replay_missing' as const,
              message: 'no real-archive held-out windows executed',
            }])
            : Object.freeze([]),
        } satisfies StrategyCapabilityAssessment);
      }),
    ),
  });
}

function realArchiveFeatureCapabilities(
  fingerprintSha256: string | null,
): readonly StrategyFeatureCapability[] {
  return Object.freeze([
    {
      category: 'instrument',
      status: 'real',
      source: 'QFA-201c real-archive execution',
      details: 'instrument identity is derived from archive-backed bars',
    },
    {
      category: 'session',
      status: 'real',
      source: 'QFA-410b archive session source',
      details: 'session id and regime are carried from archive session metadata',
    },
    {
      category: 'quote',
      status: 'real',
      source: 'MBP-1',
      details: 'quote values are derived from archive MBP-1 top of book',
    },
    {
      category: 'bars',
      status: 'real',
      source: 'trades',
      details: 'OHLCV bars are built from archive trades',
    },
    {
      category: 'indicators',
      status: 'real',
      source: 'QFA-201c feature snapshot',
      details: 'indicator values are computed from archive-backed bars',
    },
    {
      category: 'structure',
      status: 'real',
      source: 'QFA-201c feature snapshot',
      details: 'structure levels are computed from archive-backed bars',
    },
    {
      category: 'microstructure',
      status: 'real',
      source: 'MBP-1',
      details: 'spread and queue buckets are derived from archive MBP-1',
    },
    {
      category: 'config_lineage',
      status: 'real',
      source: 'strategy candidate config lineage',
      details: 'candidate config lineage is preserved in emitted events',
    },
    {
      category: 'fingerprint',
      status: fingerprintSha256 === null ? 'unavailable' : 'real',
      source: fingerprintSha256 === null ? null : STRATEGY_FINGERPRINT_ALGORITHM,
      details: fingerprintSha256 === null ? 'fingerprint missing' : `fingerprint_sha256=${fingerprintSha256}`,
    },
  ]);
}

function trialAccounting(
  strategyId: StrategyId,
  effectiveTrialCount: number,
): ValidationTrialAccounting {
  return Object.freeze({
    trial_accounting_schema_version: 1,
    strategy_id: strategyId,
    campaign_id: 'qfa-410b-real-archive-execution',
    raw_research_trials: effectiveTrialCount,
    excluded_determinism_reruns: 0,
    manual_declared_effective_trials: effectiveTrialCount,
    distinct_window_fingerprint_tuples: effectiveTrialCount,
    effective_trial_count: effectiveTrialCount,
    effective_trial_scope: 'campaign',
    effective_trial_method: 'max_of_manual_and_distinct_fingerprints',
  });
}

function fingerprintExecution(
  strategyId: StrategyId,
  executions: readonly RealArchiveBacktestResult[],
): string {
  return hashStable({
    strategy_id: strategyId,
    executions: executions.map((execution) => ({
      run_id: execution.run_id,
      runtime_metrics: execution.runtime_metrics,
      per_trade_records: execution.per_trade_records,
    })),
  });
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, bigintReplacer), 'utf8').digest('hex');
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function absBigint(value: bigint): bigint {
  return value < 0n ? -value : value;
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
