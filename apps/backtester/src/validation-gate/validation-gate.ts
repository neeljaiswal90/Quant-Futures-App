import {
  ACTIVE_STRATEGY_IDS,
  isStrategyId,
  type StrategyId,
} from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import { STRATEGY_FINGERPRINT_ALGORITHM } from '../strategy-fingerprint/index.js';
import { computeEffectiveTrialCount, validateTrialAccounting } from './trial-accounting.js';
import {
  DEFAULT_VALIDATION_GATE_POLICY_V1,
  resolveValidationGatePolicy,
} from './validation-policy.js';
import {
  throwValidationGateIssues,
  type ValidationGateIssue,
} from './validation-gate-error.js';
import type {
  StrategyValidationGateInput,
  StrategyValidationGateResult,
  StrategyValidationWindowInput,
  ValidationGateCheck,
  ValidationGateCheckName,
  ValidationGatePolicy,
  ValidationGateReason,
  ValidationGateResultSet,
  ValidationGateStatus,
  ValidationGateWarning,
  ValidationGateWarningCode,
} from './types.js';

const PPM = 1_000_000n;
const SHA_256_HEX = /^[a-f0-9]{64}$/u;

const CHECK_ORDER: readonly ValidationGateCheckName[] = [
  'capability_eligibility',
  'fingerprint_required',
  'determinism_required',
  'test_window_count',
  'non_overlapping_test_windows',
  'closed_trade_count_total',
  'closed_trade_count_per_window',
  'zero_trade_windows',
  'aggregate_net_pnl',
  'aggregate_profit_factor',
  'average_trade_pnl',
  'positive_window_share',
  'worst_window_drawdown',
  'trial_accounting_required',
  'trial_accounting_valid',
];

const REASON_ORDER: readonly ValidationGateReason[] = [
  'capability_status_blocked',
  'capability_status_degraded_replay',
  'missing_fingerprint',
  'missing_test_windows',
  'overlapping_test_windows',
  'insufficient_test_windows',
  'insufficient_closed_trades',
  'too_many_zero_trade_windows',
  'missing_trial_accounting',
  'invalid_trial_accounting',
  'threshold_failed',
];

const WARNING_ORDER: readonly ValidationGateWarningCode[] = [
  'degraded_replay_diagnostics_only',
  'high_effective_trial_count',
  'advanced_statistics_disabled',
  'validation_windows_excluded',
  'train_windows_excluded',
];

export function evaluateStrategyValidationGate(
  input: StrategyValidationGateInput,
  policy: ValidationGatePolicy = DEFAULT_VALIDATION_GATE_POLICY_V1,
): StrategyValidationGateResult {
  const resolvedPolicy = resolveValidationGatePolicy(policy);
  validateGateInput(input, resolvedPolicy);

  const testWindows = input.windows.filter((window) => window.role === 'test');
  const metrics = computeTestWindowMetrics(testWindows);
  const trialIssues =
    input.trial_accounting === null
      ? []
      : validateTrialAccounting(
          input.strategy_id,
          input.trial_accounting,
          resolvedPolicy,
          '$.trial_accounting',
        );

  const reasons: ValidationGateReason[] = [];
  const warnings: ValidationGateWarning[] = [];
  const addReason = (reason: ValidationGateReason) => reasons.push(reason);
  const addWarning = (code: ValidationGateWarningCode, message: string) =>
    warnings.push({ code, message });

  if (input.capability_assessment.status === 'blocked') {
    addReason('capability_status_blocked');
  }
  if (input.capability_assessment.status === 'degraded_replay') {
    addReason('capability_status_degraded_replay');
    if (resolvedPolicy.eligibility.allow_degraded_replay_for_diagnostics) {
      addWarning(
        'degraded_replay_diagnostics_only',
        'degraded replay may be inspected for diagnostics but cannot pass validation',
      );
    }
  }
  if (resolvedPolicy.eligibility.require_strategy_fingerprint && input.fingerprint === null) {
    addReason('missing_fingerprint');
  }
  if (testWindows.length === 0) {
    addReason('missing_test_windows');
  }
  if (
    resolvedPolicy.windowing.require_non_overlapping_test_windows &&
    hasOverlappingWindows(testWindows)
  ) {
    addReason('overlapping_test_windows');
  }
  if (testWindows.length > 0 && testWindows.length < resolvedPolicy.windowing.min_test_windows) {
    addReason('insufficient_test_windows');
  }
  if (
    testWindows.length > 0 &&
    (metrics.totalTrades < resolvedPolicy.windowing.min_trades_total ||
      testWindows.some((window) => window.total_trades < resolvedPolicy.windowing.min_trades_per_window))
  ) {
    addReason('insufficient_closed_trades');
  }
  if (metrics.zeroTradeWindows > resolvedPolicy.windowing.max_zero_trade_windows) {
    addReason('too_many_zero_trade_windows');
  }
  if (resolvedPolicy.trial_accounting.required && input.trial_accounting === null) {
    addReason('missing_trial_accounting');
  }
  if (trialIssues.length > 0) {
    addReason('invalid_trial_accounting');
  }

  const eligibilityBlocked = reasons.some((reason) =>
    ['capability_status_blocked', 'capability_status_degraded_replay', 'missing_fingerprint'].includes(
      reason,
    ),
  );
  const insufficientEvidence = reasons.some((reason) =>
    [
      'missing_test_windows',
      'overlapping_test_windows',
      'insufficient_test_windows',
      'insufficient_closed_trades',
      'too_many_zero_trade_windows',
      'missing_trial_accounting',
      'invalid_trial_accounting',
    ].includes(reason),
  );
  const evaluateThresholds = !eligibilityBlocked && !insufficientEvidence;
  const thresholdFailure = evaluateThresholds && thresholdsFail(metrics, resolvedPolicy);
  if (thresholdFailure) {
    addReason('threshold_failed');
  }

  if (
    input.trial_accounting !== null &&
    input.trial_accounting.effective_trial_count >
      resolvedPolicy.trial_accounting.high_trial_warning_threshold
  ) {
    addWarning(
      'high_effective_trial_count',
      `effective trial count ${input.trial_accounting.effective_trial_count} exceeds warning threshold`,
    );
  }
  if (advancedStatisticsDisabled(resolvedPolicy)) {
    addWarning('advanced_statistics_disabled', 'advanced statistics are disabled by policy v1');
  }
  if (input.windows.some((window) => window.role === 'validation')) {
    addWarning('validation_windows_excluded', 'validation windows are excluded from final gate status');
  }
  if (input.windows.some((window) => window.role === 'train')) {
    addWarning('train_windows_excluded', 'train windows are excluded from final gate status');
  }

  const status = deriveTopLevelStatus(eligibilityBlocked, insufficientEvidence, thresholdFailure);

  return {
    result_schema_version: 1,
    strategy_id: input.strategy_id,
    status,
    capability_status: input.capability_assessment.status,
    fingerprint_sha256: input.fingerprint?.fingerprint_sha256 ?? null,
    evaluated_test_windows: testWindows.length,
    zero_trade_windows: metrics.zeroTradeWindows,
    aggregate_net_pnl_cents: metrics.aggregateNetPnl,
    aggregate_profit_factor_ppm: metrics.aggregateProfitFactorPpm,
    average_trade_pnl_cents: metrics.averageTradePnl,
    worst_window_drawdown_ppm: metrics.worstWindowDrawdownPpm,
    positive_window_share_ppm: metrics.positiveWindowSharePpm,
    effective_trial_count: input.trial_accounting?.effective_trial_count ?? null,
    trial_accounting_scope: input.trial_accounting?.effective_trial_scope ?? null,
    trial_accounting_method: input.trial_accounting?.effective_trial_method ?? null,
    checks: buildChecks(input, resolvedPolicy, metrics, trialIssues, evaluateThresholds),
    warnings: sortWarnings(warnings),
    reasons: sortReasons(uniqueReasons(reasons)),
  };
}

export function evaluateValidationGateSet(
  inputs: readonly StrategyValidationGateInput[],
  policy: ValidationGatePolicy = DEFAULT_VALIDATION_GATE_POLICY_V1,
  strategyOrder?: readonly StrategyId[],
): ValidationGateResultSet {
  const resolvedPolicy = resolveValidationGatePolicy(policy);
  const orderedInputs = orderGateInputs(inputs, strategyOrder);
  return {
    result_set_schema_version: 1,
    policy_version: resolvedPolicy.policy_schema_version,
    results: orderedInputs.map((input) => evaluateStrategyValidationGate(input, resolvedPolicy)),
  };
}

interface TestWindowMetrics {
  readonly totalTrades: number;
  readonly zeroTradeWindows: number;
  readonly aggregateNetPnl: bigint | null;
  readonly aggregateProfitFactorPpm: number | null;
  readonly averageTradePnl: bigint | null;
  readonly worstWindowDrawdownPpm: number | null;
  readonly positiveWindowSharePpm: number | null;
}

function computeTestWindowMetrics(
  testWindows: readonly StrategyValidationWindowInput[],
): TestWindowMetrics {
  if (testWindows.length === 0) {
    return {
      totalTrades: 0,
      zeroTradeWindows: 0,
      aggregateNetPnl: null,
      aggregateProfitFactorPpm: null,
      averageTradePnl: null,
      worstWindowDrawdownPpm: null,
      positiveWindowSharePpm: null,
    };
  }

  const totalTrades = testWindows.reduce((sum, window) => sum + window.total_trades, 0);
  const zeroTradeWindows = testWindows.filter((window) => window.total_trades === 0).length;
  const positiveWindows = testWindows.filter((window) => window.net_pnl_cents > 0n).length;
  const aggregateNetPnl = testWindows.reduce((sum, window) => sum + window.net_pnl_cents, 0n);
  const aggregateGrossProfit = testWindows.reduce(
    (sum, window) => sum + window.gross_profit_cents,
    0n,
  );
  const aggregateGrossLoss = testWindows.reduce((sum, window) => sum + window.gross_loss_cents, 0n);
  const aggregateProfitFactorPpm =
    aggregateGrossLoss === 0n
      ? null
      : bigintToSafeNumber((aggregateGrossProfit * PPM) / absBigint(aggregateGrossLoss));
  const averageTradePnl = totalTrades === 0 ? null : aggregateNetPnl / BigInt(totalTrades);
  const worstWindowDrawdownPpm = Math.max(
    ...testWindows.map((window) =>
      bigintToSafeNumber((window.max_drawdown_cents * PPM) / window.initial_equity_cents),
    ),
  );
  const positiveWindowSharePpm = bigintToSafeNumber(
    (BigInt(positiveWindows) * PPM) / BigInt(testWindows.length),
  );

  return {
    totalTrades,
    zeroTradeWindows,
    aggregateNetPnl,
    aggregateProfitFactorPpm,
    averageTradePnl,
    worstWindowDrawdownPpm,
    positiveWindowSharePpm,
  };
}

function thresholdsFail(metrics: TestWindowMetrics, policy: ValidationGatePolicy): boolean {
  return (
    metrics.aggregateNetPnl === null ||
    metrics.aggregateNetPnl < policy.thresholds.min_aggregate_net_pnl_cents ||
    metrics.aggregateProfitFactorPpm === null ||
    metrics.aggregateProfitFactorPpm < policy.thresholds.min_aggregate_profit_factor_ppm ||
    metrics.averageTradePnl === null ||
    metrics.averageTradePnl < policy.thresholds.min_average_trade_pnl_cents ||
    metrics.positiveWindowSharePpm === null ||
    metrics.positiveWindowSharePpm < policy.thresholds.min_positive_window_share_ppm ||
    metrics.worstWindowDrawdownPpm === null ||
    metrics.worstWindowDrawdownPpm > policy.thresholds.max_worst_window_drawdown_ppm
  );
}

function buildChecks(
  input: StrategyValidationGateInput,
  policy: ValidationGatePolicy,
  metrics: TestWindowMetrics,
  trialIssues: readonly ValidationGateIssue[],
  evaluateThresholds: boolean,
): readonly ValidationGateCheck[] {
  const testWindows = input.windows.filter((window) => window.role === 'test');
  const overlapping = hasOverlappingWindows(testWindows);
  const checks = new Map<ValidationGateCheckName, ValidationGateCheck>();
  const add = (check: ValidationGateCheck) => checks.set(check.name, check);

  add({
    name: 'capability_eligibility',
    status:
      input.capability_assessment.status === 'ready_for_replay'
        ? 'pass'
        : 'blocked',
    observed: input.capability_assessment.status,
    threshold: 'ready_for_replay',
    message: 'degraded or blocked capability cannot pass validation gate v1',
  });
  add({
    name: 'fingerprint_required',
    status:
      !policy.eligibility.require_strategy_fingerprint || input.fingerprint !== null
        ? 'pass'
        : 'blocked',
    observed: input.fingerprint?.fingerprint_sha256 ?? null,
    threshold: policy.eligibility.require_strategy_fingerprint ? 'required' : 'not_required',
    message: 'strategy fingerprint is required by validation gate policy v1',
  });
  add({
    name: 'determinism_required',
    status: policy.eligibility.require_ci_determinism_coverage ? 'blocked' : 'not_evaluated',
    observed: policy.eligibility.require_ci_determinism_coverage ? 'required' : 'not_required',
    threshold: 'not_required',
    message: 'CI determinism coverage is not required by policy v1',
  });
  add({
    name: 'test_window_count',
    status: testWindows.length >= policy.windowing.min_test_windows ? 'pass' : 'fail',
    observed: testWindows.length,
    threshold: policy.windowing.min_test_windows,
    message: 'final validation status is based on test windows only',
  });
  add({
    name: 'non_overlapping_test_windows',
    status: !overlapping ? 'pass' : 'fail',
    observed: overlapping ? 'overlap_detected' : 'no_overlap',
    threshold: policy.windowing.require_non_overlapping_test_windows ? 'required' : 'not_required',
    message: 'test windows must be non-overlapping half-open ranges',
  });
  add({
    name: 'closed_trade_count_total',
    status: metrics.totalTrades >= policy.windowing.min_trades_total ? 'pass' : 'fail',
    observed: metrics.totalTrades,
    threshold: policy.windowing.min_trades_total,
    message: 'total closed trades across test windows must meet minimum evidence',
  });
  const minWindowTrades =
    testWindows.length === 0 ? 0 : Math.min(...testWindows.map((window) => window.total_trades));
  add({
    name: 'closed_trade_count_per_window',
    status:
      testWindows.length > 0 &&
      testWindows.every((window) => window.total_trades >= policy.windowing.min_trades_per_window)
        ? 'pass'
        : 'fail',
    observed: minWindowTrades,
    threshold: policy.windowing.min_trades_per_window,
    message: 'each test window must meet the per-window closed trade minimum',
  });
  add({
    name: 'zero_trade_windows',
    status: metrics.zeroTradeWindows <= policy.windowing.max_zero_trade_windows ? 'pass' : 'fail',
    observed: metrics.zeroTradeWindows,
    threshold: policy.windowing.max_zero_trade_windows,
    message: 'zero-trade test windows are limited by policy',
  });

  const thresholdStatus = (passes: boolean): 'pass' | 'fail' | 'not_evaluated' =>
    evaluateThresholds ? (passes ? 'pass' : 'fail') : 'not_evaluated';
  add({
    name: 'aggregate_net_pnl',
    status: thresholdStatus(
      metrics.aggregateNetPnl !== null &&
        metrics.aggregateNetPnl >= policy.thresholds.min_aggregate_net_pnl_cents,
    ),
    observed: metrics.aggregateNetPnl,
    threshold: policy.thresholds.min_aggregate_net_pnl_cents,
    message: 'aggregate test-window net PnL must be positive above threshold',
  });
  add({
    name: 'aggregate_profit_factor',
    status: thresholdStatus(
      metrics.aggregateProfitFactorPpm !== null &&
        metrics.aggregateProfitFactorPpm >= policy.thresholds.min_aggregate_profit_factor_ppm,
    ),
    observed: metrics.aggregateProfitFactorPpm,
    threshold: policy.thresholds.min_aggregate_profit_factor_ppm,
    message: 'aggregate test-window profit factor must meet ppm threshold',
  });
  add({
    name: 'average_trade_pnl',
    status: thresholdStatus(
      metrics.averageTradePnl !== null &&
        metrics.averageTradePnl >= policy.thresholds.min_average_trade_pnl_cents,
    ),
    observed: metrics.averageTradePnl,
    threshold: policy.thresholds.min_average_trade_pnl_cents,
    message: 'average trade PnL across test windows must be positive above threshold',
  });
  add({
    name: 'positive_window_share',
    status: thresholdStatus(
      metrics.positiveWindowSharePpm !== null &&
        metrics.positiveWindowSharePpm >= policy.thresholds.min_positive_window_share_ppm,
    ),
    observed: metrics.positiveWindowSharePpm,
    threshold: policy.thresholds.min_positive_window_share_ppm,
    message: 'positive test-window share must meet ppm threshold',
  });
  add({
    name: 'worst_window_drawdown',
    status: thresholdStatus(
      metrics.worstWindowDrawdownPpm !== null &&
        metrics.worstWindowDrawdownPpm <= policy.thresholds.max_worst_window_drawdown_ppm,
    ),
    observed: metrics.worstWindowDrawdownPpm,
    threshold: policy.thresholds.max_worst_window_drawdown_ppm,
    message: 'worst test-window drawdown must not exceed ppm threshold',
  });
  add({
    name: 'trial_accounting_required',
    status: !policy.trial_accounting.required || input.trial_accounting !== null ? 'pass' : 'fail',
    observed: input.trial_accounting === null ? null : 'present',
    threshold: policy.trial_accounting.required ? 'required' : 'not_required',
    message: 'trial accounting is required by validation gate policy v1',
  });
  add({
    name: 'trial_accounting_valid',
    status:
      input.trial_accounting === null
        ? 'not_evaluated'
        : trialIssues.length === 0
          ? 'pass'
          : 'fail',
    observed: input.trial_accounting?.effective_trial_count ?? null,
    threshold: 'valid_trial_accounting',
    message: 'trial accounting must match policy v1 effective trial method',
  });

  return CHECK_ORDER.map((name) => checks.get(name)!);
}

function validateGateInput(input: StrategyValidationGateInput, policy: ValidationGatePolicy): void {
  const issues: ValidationGateIssue[] = [];
  if (!isStrategyId(input.strategy_id)) {
    issues.push(issue('$.strategy_id', 'unknown_strategy_id', `unknown strategy_id ${String(input.strategy_id)}`));
  }
  if (input.capability_assessment.strategy_id !== input.strategy_id) {
    issues.push(
      issue(
        '$.capability_assessment.strategy_id',
        'fingerprint_strategy_mismatch',
        'capability assessment strategy_id must match gate input strategy_id',
      ),
    );
  }
  if (input.fingerprint !== null) {
    if (input.fingerprint.strategy_id !== input.strategy_id) {
      issues.push(
        issue('$.fingerprint.strategy_id', 'fingerprint_strategy_mismatch', 'fingerprint strategy mismatch'),
      );
    }
    if (input.fingerprint.algorithm !== policy.eligibility.required_fingerprint_algorithm) {
      issues.push(
        issue('$.fingerprint.algorithm', 'fingerprint_strategy_mismatch', 'fingerprint algorithm mismatch'),
      );
    }
  }
  validateSessionOrder(input.session_order, issues);
  input.windows.forEach((window, index) =>
    validateWindowInput(input.strategy_id, input.session_order, window, index, policy, issues),
  );

  if (issues.length > 0) {
    throwValidationGateIssues(issues);
  }
}

function validateSessionOrder(
  sessionOrder: readonly string[],
  issues: ValidationGateIssue[],
): void {
  const seen = new Set<string>();
  sessionOrder.forEach((session, index) => {
    if (typeof session !== 'string' || session.trim() === '') {
      issues.push(issue(`$.session_order[${index}]`, 'session_order_invalid', 'session must be non-empty'));
      return;
    }
    if (seen.has(session)) {
      issues.push(issue(`$.session_order[${index}]`, 'session_order_invalid', `duplicate session ${session}`));
      return;
    }
    if (index > 0 && session <= sessionOrder[index - 1]!) {
      issues.push(issue(`$.session_order[${index}]`, 'session_order_invalid', 'sessions must be sorted ascending'));
    }
    seen.add(session);
  });
}

function validateWindowInput(
  strategyId: StrategyId,
  sessionOrder: readonly string[],
  window: StrategyValidationWindowInput,
  index: number,
  policy: ValidationGatePolicy,
  issues: ValidationGateIssue[],
): void {
  const path = `$.windows[${index}]`;
  if (window.strategy_id !== strategyId) {
    issues.push(issue(`${path}.strategy_id`, 'window_strategy_mismatch', 'window strategy mismatch'));
  }
  if (!['train', 'validation', 'test'].includes(window.role)) {
    issues.push(issue(`${path}.role`, 'invalid_window_input', 'window role is invalid'));
  }
  if (!Number.isSafeInteger(window.sequence) || window.sequence <= 0) {
    issues.push(issue(`${path}.sequence`, 'invalid_window_input', 'sequence must be positive safe integer'));
  }
  if (
    !Number.isSafeInteger(window.start_index) ||
    !Number.isSafeInteger(window.end_index) ||
    window.start_index < 0 ||
    window.end_index <= window.start_index ||
    window.end_index >= sessionOrder.length
  ) {
    issues.push(issue(`${path}.start_index`, 'invalid_window_input', 'window indices must be valid half-open session indices'));
  } else {
    if (sessionOrder[window.start_index] !== window.start_session) {
      issues.push(issue(`${path}.start_session`, 'invalid_window_input', 'start_session does not match session_order'));
    }
    if (sessionOrder[window.end_index] !== window.end_session) {
      issues.push(issue(`${path}.end_session`, 'invalid_window_input', 'end_session does not match session_order'));
    }
  }
  if (!Number.isSafeInteger(window.total_trades) || window.total_trades < 0) {
    issues.push(issue(`${path}.total_trades`, 'invalid_window_input', 'total_trades must be non-negative safe integer'));
  }
  if (window.initial_equity_cents <= 0n) {
    issues.push(issue(`${path}.initial_equity_cents`, 'invalid_window_input', 'initial equity must be positive'));
  }
  if (window.max_drawdown_cents < 0n) {
    issues.push(issue(`${path}.max_drawdown_cents`, 'invalid_window_input', 'drawdown must be non-negative'));
  }
  if (policy.eligibility.require_window_fingerprints) {
    if (!SHA_256_HEX.test(window.fingerprint_sha256)) {
      issues.push(issue(`${path}.fingerprint_sha256`, 'invalid_window_input', 'window fingerprint must be lowercase sha256'));
    }
    if (window.fingerprint_algorithm !== policy.eligibility.required_fingerprint_algorithm) {
      issues.push(issue(`${path}.fingerprint_algorithm`, 'invalid_window_input', 'window fingerprint algorithm mismatch'));
    }
  }
}

function hasOverlappingWindows(windows: readonly StrategyValidationWindowInput[]): boolean {
  for (let leftIndex = 0; leftIndex < windows.length; leftIndex += 1) {
    const left = windows[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < windows.length; rightIndex += 1) {
      const right = windows[rightIndex]!;
      if (left.start_index < right.end_index && right.start_index < left.end_index) {
        return true;
      }
    }
  }
  return false;
}

function deriveTopLevelStatus(
  eligibilityBlocked: boolean,
  insufficientEvidence: boolean,
  thresholdFailure: boolean,
): ValidationGateStatus {
  if (eligibilityBlocked) return 'blocked';
  if (insufficientEvidence) return 'insufficient_evidence';
  if (thresholdFailure) return 'fail';
  return 'pass';
}

function orderGateInputs(
  inputs: readonly StrategyValidationGateInput[],
  strategyOrder?: readonly StrategyId[],
): readonly StrategyValidationGateInput[] {
  const issues: ValidationGateIssue[] = [];
  const byStrategy = new Map<StrategyId, StrategyValidationGateInput>();
  inputs.forEach((input, index) => {
    if (!isStrategyId(input.strategy_id)) {
      issues.push(issue(`$[${index}].strategy_id`, 'unknown_strategy_id', 'unknown strategy_id'));
      return;
    }
    if (byStrategy.has(input.strategy_id)) {
      issues.push(issue(`$[${index}].strategy_id`, 'duplicate_strategy_id', 'duplicate strategy input'));
      return;
    }
    byStrategy.set(input.strategy_id, input);
  });

  const order = strategyOrder ?? ACTIVE_STRATEGY_IDS;
  const seen = new Set<StrategyId>();
  order.forEach((strategyId, index) => {
    if (!isStrategyId(strategyId)) {
      issues.push(issue(`$.strategy_order[${index}]`, 'unknown_strategy_id', 'unknown strategy_id'));
      return;
    }
    if (seen.has(strategyId)) {
      issues.push(issue(`$.strategy_order[${index}]`, 'duplicate_strategy_id', 'duplicate strategy in order'));
    }
    seen.add(strategyId);
  });

  for (const strategyId of byStrategy.keys()) {
    if (!seen.has(strategyId)) {
      issues.push(
        issue('$.strategy_order', 'unknown_strategy_id', `strategy_order omitted input for ${strategyId}`),
      );
    }
  }
  if (issues.length > 0) {
    throwValidationGateIssues(issues);
  }

  return order.flatMap((strategyId) => {
    const input = byStrategy.get(strategyId);
    return input === undefined ? [] : [input];
  });
}

function advancedStatisticsDisabled(policy: ValidationGatePolicy): boolean {
  return (
    !policy.statistics.dsr.enabled &&
    !policy.statistics.white_reality_check.enabled &&
    !policy.statistics.spa.enabled &&
    !policy.statistics.pbo.enabled
  );
}

function sortReasons(reasons: readonly ValidationGateReason[]): readonly ValidationGateReason[] {
  return [...reasons].sort((left, right) => REASON_ORDER.indexOf(left) - REASON_ORDER.indexOf(right));
}

function sortWarnings(warnings: readonly ValidationGateWarning[]): readonly ValidationGateWarning[] {
  return [...warnings].sort((left, right) => {
    const codeOrder = WARNING_ORDER.indexOf(left.code) - WARNING_ORDER.indexOf(right.code);
    if (codeOrder !== 0) return codeOrder;
    return left.message.localeCompare(right.message);
  });
}

function uniqueReasons(reasons: readonly ValidationGateReason[]): readonly ValidationGateReason[] {
  return [...new Set(reasons)];
}

function bigintToSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throwValidationGateIssues([
      issue('$', 'invalid_window_input', 'computed ppm value exceeds Number.MAX_SAFE_INTEGER'),
    ]);
  }
  return Number(value);
}

function absBigint(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function issue(
  path: string,
  code: ValidationGateIssue['code'],
  message: string,
): ValidationGateIssue {
  return { path, code, message };
}

