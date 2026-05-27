import { describe, expect, it } from 'vitest';
import {
  type StrategyId,
} from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import { STRATEGY_FINGERPRINT_ALGORITHM } from '../../../src/strategy-fingerprint/index.js';
import type {
  CapabilityAssessmentSet,
  StrategyCapabilityAssessment,
  StrategyValidationWindowInput,
  TierBOosInputSpec,
  ValidationTrialAccounting,
  WalkForwardPlan,
} from '../../../src/index.js';
import {
  buildHeldOutValidationResult,
  HeldOutValidationInputError,
  runHeldOutValidation,
  type HeldOutValidationRunOptions,
} from '../../../src/held-out-validation/index.js';
import type {
  StrategyFingerprint,
  StrategyFingerprintSet,
} from '../../../src/strategy-fingerprint/index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const EXPLICIT_REPLAY_STRATEGY_IDS = [
  'vwap_overnight_reversal_long',
  'vwap_overnight_reversal_short',
  'regime_shock_reversion_short_v2',
] as const satisfies readonly StrategyId[];
const SESSION_ORDER = Object.freeze([
  '2026-02-02-rth',
  '2026-02-03-rth',
  '2026-02-04-rth',
  '2026-02-05-rth',
  '2026-02-06-rth',
  '2026-02-09-rth',
  '2026-02-10-rth',
  '2026-02-11-rth',
  '2026-02-12-rth',
  '2026-02-13-rth',
] as const);

describe('QFA-410 held-out validation runner', () => {
  it('builds held-out validation result from deterministic fixture inputs', async () => {
    const result = await runHeldOutValidation(
      optionsWithPassingArtifacts([EXPLICIT_REPLAY_STRATEGY_IDS[0]], 'passed'),
    );

    expect(result).toMatchObject({
      result_schema_version: 1,
      run_id: 'qfa-410-test-run',
      input_spec: inputSpec('passed'),
    });
    expect(result.validation_gate_result_set.results[0]?.status).toBe('pass');
    expect(result.window_results[0]).toMatchObject({
      replay_status: 'evaluated',
      validation_status: 'pass',
      reasons: [],
    });
  });

  it('consumes QFA-403 OOS replay framework result', () => {
    const result = buildHeldOutValidationResult(
      optionsWithPassingArtifacts([EXPLICIT_REPLAY_STRATEGY_IDS[0]], 'passed'),
    );

    expect(result.oos_framework_result.result_schema_version).toBe(1);
    expect(result.oos_framework_result.windows).toHaveLength(2);
    expect(result.window_results.map((window) => window.window_id)).toEqual(['wf-1', 'wf-2']);
  });

  it('uses walk-forward test windows only', () => {
    const base = buildHeldOutValidationResult(
      optionsWithPassingArtifacts([EXPLICIT_REPLAY_STRATEGY_IDS[0]], 'passed'),
    );
    const changedTrainValidation = buildHeldOutValidationResult({
      ...optionsWithPassingArtifacts([EXPLICIT_REPLAY_STRATEGY_IDS[0]], 'passed'),
      walk_forward_plan: {
        ...walkForwardPlan(),
        windows: walkForwardPlan().windows.map((window) => ({
          ...window,
          train: { start_session: 'changed-train-start', end_session: 'changed-train-end' },
          validation: { start_session: 'changed-val-start', end_session: 'changed-val-end' },
        })),
      },
    });

    expect(changedTrainValidation.window_results).toEqual(base.window_results);
  });

  it('preserves explicit strategy order', () => {
    const order = [EXPLICIT_REPLAY_STRATEGY_IDS[2], EXPLICIT_REPLAY_STRATEGY_IDS[0]] as const;
    const result = buildHeldOutValidationResult(optionsWithPassingArtifacts(order, 'passed'));

    expect(result.validation_gate_result_set.results.map((item) => item.strategy_id)).toEqual(order);
    expect(result.window_results.slice(0, 2).map((item) => item.strategy_id)).toEqual(order);
  });

  it('invokes QFA-302 fingerprint construction when fingerprints are not supplied', () => {
    const result = buildHeldOutValidationResult(baseOptions('passed'));
    const first = result.validation_gate_result_set.results[0];

    expect(first?.fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('invokes QFA-303 capability assessment when capabilities are not supplied', () => {
    const result = buildHeldOutValidationResult(baseOptions('passed'));

    expect(result.validation_gate_result_set.results[0]).toMatchObject({
      capability_status: 'blocked',
      status: 'blocked',
    });
  });

  it('invokes QFA-310 validation gate and includes its result set', () => {
    const result = buildHeldOutValidationResult(baseOptions('passed'));

    expect(result.validation_gate_result_set).toMatchObject({
      result_set_schema_version: 1,
      policy_version: 1,
    });
    expect(result.validation_gate_result_set.results[0]?.checks.map((check) => check.name)).toContain(
      'capability_eligibility',
    );
  });

  it('keeps pending fidelity prerequisites from fabricating fidelity pass/fail', () => {
    const result = buildHeldOutValidationResult(
      optionsWithPassingArtifacts([EXPLICIT_REPLAY_STRATEGY_IDS[0]], 'pending'),
    );

    expect(result.window_results[0]).toMatchObject({
      replay_status: 'evaluated',
      validation_status: 'pass',
      reasons: ['fidelity_pending'],
    });
  });

  it('blocks held-out results when fidelity prerequisites failed', () => {
    const result = buildHeldOutValidationResult(
      optionsWithPassingArtifacts([EXPLICIT_REPLAY_STRATEGY_IDS[0]], 'failed'),
    );

    expect(result.window_results[0]).toMatchObject({
      replay_status: 'blocked',
      validation_status: 'pass',
      reasons: ['fidelity_failed'],
    });
  });

  it('repeated identical input produces deeply equal results', async () => {
    const options = optionsWithPassingArtifacts(EXPLICIT_REPLAY_STRATEGY_IDS, 'passed');

    expect(await runHeldOutValidation(options)).toEqual(await runHeldOutValidation(options));
  });

  it('throws aggregate input errors for invalid options', () => {
    expect(() =>
      buildHeldOutValidationResult({
        ...baseOptions('passed'),
        run_id: '',
        strategy_order: [EXPLICIT_REPLAY_STRATEGY_IDS[0], EXPLICIT_REPLAY_STRATEGY_IDS[0]],
      }),
    ).toThrow(HeldOutValidationInputError);
  });
});

function baseOptions(
  fidelityStatus: TierBOosInputSpec['fidelity_status'],
): HeldOutValidationRunOptions {
  return {
    run_id: 'qfa-410-test-run',
    input_spec: inputSpec(fidelityStatus),
    walk_forward_plan: walkForwardPlan(),
    strategy_order: [EXPLICIT_REPLAY_STRATEGY_IDS[0]],
  };
}

function optionsWithPassingArtifacts(
  strategyOrder: readonly StrategyId[],
  fidelityStatus: TierBOosInputSpec['fidelity_status'],
): HeldOutValidationRunOptions {
  return {
    ...baseOptions(fidelityStatus),
    strategy_order: strategyOrder,
    strategy_fingerprint_set: fingerprintSet(strategyOrder),
    capability_assessment_set: capabilitySet(strategyOrder),
    validation_windows: strategyOrder.flatMap((strategyId) => validationWindows(strategyId)),
    trial_accounting: strategyOrder.map((strategyId) => trialAccounting(strategyId)),
  };
}

function inputSpec(fidelityStatus: TierBOosInputSpec['fidelity_status']): TierBOosInputSpec {
  return {
    spec_schema_version: 1,
    data_mode: 'tier_b_projection_from_tier_a',
    required_schemas: ['mbp-1', 'trades'],
    corpus_manifest_hashes: [HASH_A],
    fidelity_status: fidelityStatus,
  };
}

function walkForwardPlan(): WalkForwardPlan {
  return {
    policy: {
      policy_version: 1,
      train_sessions: 2,
      validation_sessions: 1,
      test_sessions: 1,
      step_sessions: 1,
      min_required_sessions: 4,
    },
    sessions: SESSION_ORDER,
    windows: [
      {
        window_id: 'wf-1',
        sequence: 1,
        train: { start_session: SESSION_ORDER[0], end_session: SESSION_ORDER[2] },
        validation: { start_session: SESSION_ORDER[2], end_session: SESSION_ORDER[3] },
        test: { start_session: SESSION_ORDER[3], end_session: SESSION_ORDER[4] },
      },
      {
        window_id: 'wf-2',
        sequence: 2,
        train: { start_session: SESSION_ORDER[1], end_session: SESSION_ORDER[3] },
        validation: { start_session: SESSION_ORDER[3], end_session: SESSION_ORDER[4] },
        test: { start_session: SESSION_ORDER[4], end_session: SESSION_ORDER[5] },
      },
    ],
  };
}

function fingerprintSet(strategyOrder: readonly StrategyId[]): StrategyFingerprintSet {
  return {
    fingerprint_set_schema_version: 1,
    algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
    fingerprints: strategyOrder.map((strategyId, index) => fingerprint(strategyId, index + 1)),
  };
}

function fingerprint(strategyId: StrategyId, seed: number): StrategyFingerprint {
  return {
    fingerprint_schema_version: 1,
    algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
    strategy_id: strategyId,
    decision_count: 1,
    decisions_sha256: makeHash(seed),
    fingerprint_sha256: makeHash(seed + 10),
  };
}

function capabilitySet(strategyOrder: readonly StrategyId[]): CapabilityAssessmentSet {
  return {
    assessment_set_schema_version: 1,
    assessments: strategyOrder.map((strategyId, index) => capability(strategyId, index + 1)),
  };
}

function capability(strategyId: StrategyId, seed: number): StrategyCapabilityAssessment {
  return {
    assessment_schema_version: 1,
    strategy_id: strategyId,
    status: 'ready_for_replay',
    replay_evaluations: 8,
    fingerprint_sha256: makeHash(seed + 10),
    decision_count: 1,
    features: [],
    limitations: [],
  };
}

function validationWindows(strategyId: StrategyId): readonly StrategyValidationWindowInput[] {
  return Array.from({ length: 8 }, (_, index) => ({
    strategy_id: strategyId,
    window_id: `validation-window-${index + 1}`,
    sequence: index + 1,
    role: 'test',
    start_session: SESSION_ORDER[index],
    end_session: SESSION_ORDER[index + 1],
    start_index: index,
    end_index: index + 1,
    total_trades: 10,
    gross_profit_cents: 20n,
    gross_loss_cents: 10n,
    net_pnl_cents: 10n,
    profit_factor_ppm: 2_000_000,
    max_drawdown_cents: 100n,
    initial_equity_cents: 100_000n,
    average_trade_pnl_cents: 1n,
    win_rate_ppm: 600_000,
    fingerprint_sha256: fingerprint(strategyId, 1).fingerprint_sha256,
    fingerprint_algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
  }));
}

function trialAccounting(strategyId: StrategyId): ValidationTrialAccounting {
  return {
    trial_accounting_schema_version: 1,
    strategy_id: strategyId,
    campaign_id: 'qfa-410-test-campaign',
    raw_research_trials: 1,
    excluded_determinism_reruns: 0,
    manual_declared_effective_trials: 1,
    distinct_window_fingerprint_tuples: 1,
    effective_trial_count: 1,
    effective_trial_scope: 'campaign',
    effective_trial_method: 'max_of_manual_and_distinct_fingerprints',
  };
}

function makeHash(seed: number): string {
  if (seed % 3 === 0) return HASH_C;
  if (seed % 2 === 0) return HASH_B;
  return HASH_A;
}
