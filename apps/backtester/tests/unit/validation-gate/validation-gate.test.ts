import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { StrategyId } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import type {
  StrategyCapabilityAssessment,
  StrategyCapabilityStatus,
} from '../../../src/capability-assessment/index.js';
import type { StrategyFingerprint } from '../../../src/strategy-fingerprint/index.js';
import {
  DEFAULT_VALIDATION_GATE_POLICY_V1,
  evaluateStrategyValidationGate,
  evaluateValidationGateSet,
  type StrategyValidationGateInput,
  type StrategyValidationWindowInput,
  type ValidationGateCheckName,
  type ValidationGateReason,
  type ValidationGateWarningCode,
  type ValidationTrialAccounting,
} from '../../../src/validation-gate/index.js';

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
] as const;

const EXPLICIT_REPLAY_STRATEGY_IDS = [
  'vwap_overnight_reversal_long',
  'vwap_overnight_reversal_short',
] as const satisfies readonly StrategyId[];

describe('validation gate evaluator', () => {
  it('passes ready replay with sufficient evidence and passing thresholds', () => {
    const result = evaluateStrategyValidationGate(makeGateInput());

    expect(result.status).toBe('pass');
    expect(result.reasons).toEqual([]);
    expect(result.evaluated_test_windows).toBe(8);
    expect(result.aggregate_net_pnl_cents).toBe(800n);
    expect(result.aggregate_profit_factor_ppm).toBe(2_000_000);
    expect(result.average_trade_pnl_cents).toBe(10n);
    expect(result.positive_window_share_ppm).toBe(1_000_000);
    expect(result.worst_window_drawdown_ppm).toBe(10_000);
  });

  it('fails when evidence is sufficient but a threshold fails', () => {
    const result = evaluateStrategyValidationGate(
      makeGateInput({
        windows: makeTestWindows({ netPnl: 0n, grossProfit: 80n, grossLoss: -100n }),
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.reasons).toEqual(['threshold_failed']);
  });

  it('blocks degraded replay and emits diagnostics warning', () => {
    const result = evaluateStrategyValidationGate(
      makeGateInput({ capabilityStatus: 'degraded_replay' }),
    );

    expect(result.status).toBe('blocked');
    expect(result.reasons).toEqual(['capability_status_degraded_replay']);
    expect(result.warnings.map((warning) => warning.code)).toContain(
      'degraded_replay_diagnostics_only',
    );
  });

  it('blocks blocked capability', () => {
    const result = evaluateStrategyValidationGate(makeGateInput({ capabilityStatus: 'blocked' }));

    expect(result.status).toBe('blocked');
    expect(result.reasons).toContain('capability_status_blocked');
  });

  it('blocks missing fingerprint', () => {
    const result = evaluateStrategyValidationGate(makeGateInput({ fingerprint: null }));

    expect(result.status).toBe('blocked');
    expect(result.fingerprint_sha256).toBeNull();
    expect(result.reasons).toContain('missing_fingerprint');
  });

  it('returns insufficient evidence when no test windows exist', () => {
    const result = evaluateStrategyValidationGate(makeGateInput({ windows: [] }));

    expect(result.status).toBe('insufficient_evidence');
    expect(result.reasons).toContain('missing_test_windows');
  });

  it('returns insufficient evidence for overlapping test windows', () => {
    const windows = makeTestWindows();
    const result = evaluateStrategyValidationGate(
      makeGateInput({
        windows: [
          windows[0]!,
          {
            ...windows[1]!,
            start_index: windows[0]!.start_index,
            start_session: windows[0]!.start_session,
          },
          ...windows.slice(2),
        ],
      }),
    );

    expect(result.status).toBe('insufficient_evidence');
    expect(result.reasons).toContain('overlapping_test_windows');
  });

  it('returns insufficient evidence for too few test windows', () => {
    const result = evaluateStrategyValidationGate(
      makeGateInput({ windows: makeTestWindows().slice(0, 7) }),
    );

    expect(result.status).toBe('insufficient_evidence');
    expect(result.reasons).toContain('insufficient_test_windows');
  });

  it('returns insufficient evidence for insufficient total trades', () => {
    const result = evaluateStrategyValidationGate(
      makeGateInput({ windows: makeTestWindows({ totalTrades: 9 }) }),
    );

    expect(result.status).toBe('insufficient_evidence');
    expect(result.reasons).toContain('insufficient_closed_trades');
  });

  it('returns insufficient evidence for insufficient per-window trades', () => {
    const windows = makeTestWindows();
    const result = evaluateStrategyValidationGate(
      makeGateInput({ windows: [{ ...windows[0]!, total_trades: 4 }, ...windows.slice(1)] }),
    );

    expect(result.status).toBe('insufficient_evidence');
    expect(result.reasons).toContain('insufficient_closed_trades');
  });

  it('returns insufficient evidence for too many zero-trade windows', () => {
    const windows = makeTestWindows();
    const result = evaluateStrategyValidationGate(
      makeGateInput({
        windows: [
          { ...windows[0]!, total_trades: 0 },
          { ...windows[1]!, total_trades: 0 },
          ...windows.slice(2),
        ],
      }),
    );

    expect(result.status).toBe('insufficient_evidence');
    expect(result.reasons).toContain('too_many_zero_trade_windows');
  });

  it('returns insufficient evidence for missing trial accounting', () => {
    const result = evaluateStrategyValidationGate(makeGateInput({ trialAccounting: null }));

    expect(result.status).toBe('insufficient_evidence');
    expect(result.reasons).toContain('missing_trial_accounting');
  });

  it('returns insufficient evidence for invalid trial accounting', () => {
    const result = evaluateStrategyValidationGate(
      makeGateInput({
        trialAccounting: {
          ...makeTrialAccounting(EXPLICIT_REPLAY_STRATEGY_IDS[0]!),
          effective_trial_count: 1,
        },
      }),
    );

    expect(result.status).toBe('insufficient_evidence');
    expect(result.reasons).toContain('invalid_trial_accounting');
  });

  it('warns on high trial count without failing solely because of it', () => {
    const result = evaluateStrategyValidationGate(
      makeGateInput({
        trialAccounting: makeTrialAccounting(EXPLICIT_REPLAY_STRATEGY_IDS[0]!, {
          manual: 30,
          distinct: 24,
        }),
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.effective_trial_count).toBe(30);
    expect(result.warnings.map((warning) => warning.code)).toContain(
      'high_effective_trial_count',
    );
  });

  it('fails aggregate net pnl threshold', () => {
    assertThresholdFailure(makeTestWindows({ netPnl: 0n, grossProfit: 80n, grossLoss: -100n }));
  });

  it('fails profit factor threshold', () => {
    assertThresholdFailure(makeTestWindows({ grossProfit: 100n, grossLoss: -100n }));
  });

  it('fails average trade pnl threshold', () => {
    assertThresholdFailure(makeTestWindows({ netPnl: 0n, grossProfit: 80n, grossLoss: -100n }));
  });

  it('fails positive window share threshold', () => {
    const windows = makeTestWindows();
    assertThresholdFailure(
      windows.map((window, index) =>
        index < 4
          ? { ...window, net_pnl_cents: -100n, gross_profit_cents: 100n, gross_loss_cents: -200n }
          : window,
      ),
    );
  });

  it('fails worst-window drawdown threshold', () => {
    const windows = makeTestWindows();
    assertThresholdFailure([
      { ...windows[0]!, max_drawdown_cents: 6_000n },
      ...windows.slice(1),
    ]);
  });

  it('excludes train and validation windows from final thresholds', () => {
    const windows = [
      makeDiagnosticWindow('train', 20),
      makeDiagnosticWindow('validation', 21),
      ...makeTestWindows(),
    ];
    const result = evaluateStrategyValidationGate(makeGateInput({ windows }));

    expect(result.status).toBe('pass');
    expect(result.evaluated_test_windows).toBe(8);
    expect(result.aggregate_net_pnl_cents).toBe(800n);
    expect(result.warnings.map((warning) => warning.code)).toContain('train_windows_excluded');
    expect(result.warnings.map((warning) => warning.code)).toContain('validation_windows_excluded');
  });

  it('orders result sets by explicit strategy order', () => {
    const inputA = makeGateInput({ strategyId: EXPLICIT_REPLAY_STRATEGY_IDS[0]! });
    const inputB = makeGateInput({ strategyId: EXPLICIT_REPLAY_STRATEGY_IDS[1]! });
    const result = evaluateValidationGateSet([inputA, inputB], DEFAULT_VALIDATION_GATE_POLICY_V1, [
      EXPLICIT_REPLAY_STRATEGY_IDS[1]!,
      EXPLICIT_REPLAY_STRATEGY_IDS[0]!,
    ]);

    expect(result.results.map((entry) => entry.strategy_id)).toEqual([
      EXPLICIT_REPLAY_STRATEGY_IDS[1],
      EXPLICIT_REPLAY_STRATEGY_IDS[0],
    ]);
  });

  it('emits checks in fixed order', () => {
    const result = evaluateStrategyValidationGate(makeGateInput());

    expect(result.checks.map((check) => check.name)).toEqual(CHECK_ORDER);
  });

  it('emits deterministic reasons', () => {
    const result = evaluateStrategyValidationGate(
      makeGateInput({ capabilityStatus: 'degraded_replay', fingerprint: null, windows: [] }),
    );

    expect(result.reasons).toEqual([
      'capability_status_degraded_replay',
      'missing_fingerprint',
      'missing_test_windows',
      'missing_trial_accounting',
    ].filter((reason): reason is ValidationGateReason => reason !== 'missing_trial_accounting'));
  });

  it('emits deterministic warnings', () => {
    const result = evaluateStrategyValidationGate(
      makeGateInput({
        capabilityStatus: 'degraded_replay',
        windows: [makeDiagnosticWindow('train', 20), makeDiagnosticWindow('validation', 21), ...makeTestWindows()],
        trialAccounting: makeTrialAccounting(EXPLICIT_REPLAY_STRATEGY_IDS[0]!, {
          manual: 30,
          distinct: 24,
        }),
      }),
    );

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'degraded_replay_diagnostics_only',
      'high_effective_trial_count',
      'advanced_statistics_disabled',
      'validation_windows_excluded',
      'train_windows_excluded',
    ] satisfies readonly ValidationGateWarningCode[]);
  });

  it('produces deeply equal results for identical inputs', () => {
    const first = evaluateStrategyValidationGate(makeGateInput());
    const second = evaluateStrategyValidationGate(makeGateInput());

    expect(second).toEqual(first);
  });

  it('does not introduce nondeterministic runtime calls in validation-gate source', () => {
    const sourceRoot = join(process.cwd(), 'apps/backtester/src/validation-gate');
    const forbidden = /Date\.now|Math\.random|randomUUID|new Date\(/u;

    for (const fileName of readdirSync(sourceRoot)) {
      if (!fileName.endsWith('.ts')) continue;
      const source = readFileSync(join(sourceRoot, fileName), 'utf8');
      expect(source, fileName).not.toMatch(forbidden);
    }
  });
});

function assertThresholdFailure(windows: readonly StrategyValidationWindowInput[]): void {
  const result = evaluateStrategyValidationGate(makeGateInput({ windows }));

  expect(result.status).toBe('fail');
  expect(result.reasons).toEqual(['threshold_failed']);
}

interface GateInputOverrides {
  readonly strategyId?: StrategyId;
  readonly capabilityStatus?: StrategyCapabilityStatus;
  readonly fingerprint?: StrategyFingerprint | null;
  readonly windows?: readonly StrategyValidationWindowInput[];
  readonly trialAccounting?: ValidationTrialAccounting | null;
}

function makeGateInput(overrides: GateInputOverrides = {}): StrategyValidationGateInput {
  const strategyId = overrides.strategyId ?? EXPLICIT_REPLAY_STRATEGY_IDS[0]!;
  const fingerprint = overrides.fingerprint === undefined ? makeFingerprint(strategyId) : overrides.fingerprint;
  return {
    strategy_id: strategyId,
    capability_assessment: makeCapability(strategyId, overrides.capabilityStatus ?? 'ready_for_replay', fingerprint),
    fingerprint,
    session_order: makeSessionOrder(),
    windows: overrides.windows ?? makeTestWindows({ strategyId }),
    trial_accounting:
      overrides.trialAccounting === undefined
        ? makeTrialAccounting(strategyId)
        : overrides.trialAccounting,
  };
}

function makeCapability(
  strategyId: StrategyId,
  status: StrategyCapabilityStatus,
  fingerprint: StrategyFingerprint | null,
): StrategyCapabilityAssessment {
  return {
    assessment_schema_version: 1,
    strategy_id: strategyId,
    status,
    replay_evaluations: status === 'blocked' ? 0 : 8,
    fingerprint_sha256: fingerprint?.fingerprint_sha256 ?? null,
    decision_count: fingerprint?.decision_count ?? null,
    features: [],
    limitations: [],
  };
}

function makeFingerprint(strategyId: StrategyId): StrategyFingerprint {
  return {
    fingerprint_schema_version: 1,
    algorithm: 'qfa_strategy_fingerprint_sha256_v1',
    strategy_id: strategyId,
    decision_count: 8,
    decisions_sha256: 'a'.repeat(64),
    fingerprint_sha256: 'b'.repeat(64),
  };
}

interface WindowOverrides {
  readonly strategyId?: StrategyId;
  readonly totalTrades?: number;
  readonly netPnl?: bigint;
  readonly grossProfit?: bigint;
  readonly grossLoss?: bigint;
}

function makeTestWindows(overrides: WindowOverrides = {}): readonly StrategyValidationWindowInput[] {
  return Array.from({ length: 8 }, (_, index) =>
    makeWindow({
      strategyId: overrides.strategyId ?? EXPLICIT_REPLAY_STRATEGY_IDS[0]!,
      sequence: index + 1,
      startIndex: index,
      endIndex: index + 1,
      role: 'test',
      totalTrades: overrides.totalTrades ?? 10,
      netPnl: overrides.netPnl ?? 100n,
      grossProfit: overrides.grossProfit ?? 200n,
      grossLoss: overrides.grossLoss ?? -100n,
    }),
  );
}

function makeDiagnosticWindow(
  role: 'train' | 'validation',
  sequence: number,
): StrategyValidationWindowInput {
  return makeWindow({
    strategyId: EXPLICIT_REPLAY_STRATEGY_IDS[0]!,
    sequence,
    startIndex: sequence,
    endIndex: sequence + 1,
    role,
    totalTrades: 0,
    netPnl: -9_999n,
    grossProfit: 0n,
    grossLoss: -9_999n,
  });
}

function makeWindow(input: {
  readonly strategyId: StrategyId;
  readonly sequence: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly role: 'train' | 'validation' | 'test';
  readonly totalTrades: number;
  readonly netPnl: bigint;
  readonly grossProfit: bigint;
  readonly grossLoss: bigint;
}): StrategyValidationWindowInput {
  const sessions = makeSessionOrder();
  return {
    strategy_id: input.strategyId,
    window_id: `window-${input.sequence}`,
    sequence: input.sequence,
    role: input.role,
    start_session: sessions[input.startIndex]!,
    end_session: sessions[input.endIndex]!,
    start_index: input.startIndex,
    end_index: input.endIndex,
    total_trades: input.totalTrades,
    gross_profit_cents: input.grossProfit,
    gross_loss_cents: input.grossLoss,
    net_pnl_cents: input.netPnl,
    profit_factor_ppm: null,
    max_drawdown_cents: 1_000n,
    initial_equity_cents: 100_000n,
    average_trade_pnl_cents:
      input.totalTrades === 0 ? null : input.netPnl / BigInt(input.totalTrades),
    win_rate_ppm: null,
    fingerprint_sha256: 'c'.repeat(64),
    fingerprint_algorithm: 'qfa_strategy_fingerprint_sha256_v1',
  };
}

function makeSessionOrder(): readonly string[] {
  return Array.from({ length: 32 }, (_, index) => `session-${String(index).padStart(2, '0')}`);
}

function makeTrialAccounting(
  strategyId: StrategyId,
  overrides: { readonly manual?: number; readonly distinct?: number } = {},
): ValidationTrialAccounting {
  const manual = overrides.manual ?? 4;
  const distinct = overrides.distinct ?? 8;
  return {
    trial_accounting_schema_version: 1,
    strategy_id: strategyId,
    campaign_id: 'campaign-qfa310',
    raw_research_trials: 12,
    excluded_determinism_reruns: 0,
    manual_declared_effective_trials: manual,
    distinct_window_fingerprint_tuples: distinct,
    effective_trial_count: Math.max(manual, distinct),
    effective_trial_scope: 'campaign',
    effective_trial_method: 'max_of_manual_and_distinct_fingerprints',
  };
}
