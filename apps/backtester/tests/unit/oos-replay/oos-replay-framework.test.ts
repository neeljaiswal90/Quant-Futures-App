import { describe, expect, it } from 'vitest';
import { ACTIVE_STRATEGY_IDS, type StrategyId } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { StrategyCapabilityAssessment } from '../../../src/capability-assessment/index.js';
import type { StrategyFingerprint } from '../../../src/strategy-fingerprint/index.js';
import type { StrategyValidationGateResult, WalkForwardPlan } from '../../../src/index.js';
import {
  buildTierBOosInputSpec,
  buildTierBOosReplayPlan,
  defaultOosStrategyOrder,
  OosReplayInputError,
  type TierBOosInputSpec,
} from '../../../src/oos-replay/index.js';

const HASH_A = 'a'.repeat(64);
const EXPLICIT_REPLAY_STRATEGY_IDS = [
  'vwap_overnight_reversal_long',
  'vwap_overnight_reversal_short',
  'regime_shock_reversion_short_v2',
] as const satisfies readonly StrategyId[];

describe('QFA-403 Tier B OOS replay framework', () => {
  it('builds OOS window results from walk-forward test windows only', () => {
    const result = buildTierBOosReplayPlan({
      walk_forward_plan: walkForwardPlan(),
      strategy_order: [EXPLICIT_REPLAY_STRATEGY_IDS[0]],
      input_spec: inputSpec('passed'),
    });

    expect(result.windows).toEqual([
      expect.objectContaining({
        window_id: 'wf-1',
        window_sequence: 1,
        test_start_session: '2026-02-05-rth',
        test_end_session: '2026-02-06-rth',
      }),
      expect.objectContaining({
        window_id: 'wf-2',
        window_sequence: 2,
        test_start_session: '2026-02-06-rth',
        test_end_session: '2026-02-09-rth',
      }),
    ]);
  });

  it('ignores train and validation ranges for OOS result generation', () => {
    const base = buildTierBOosReplayPlan({
      walk_forward_plan: walkForwardPlan(),
      strategy_order: [EXPLICIT_REPLAY_STRATEGY_IDS[0]],
      input_spec: inputSpec('passed'),
    });
    const changedTrainValidation = buildTierBOosReplayPlan({
      walk_forward_plan: {
        ...walkForwardPlan(),
        windows: walkForwardPlan().windows.map((window) => ({
          ...window,
          train: { start_session: 'changed-train-start', end_session: 'changed-train-end' },
          validation: { start_session: 'changed-val-start', end_session: 'changed-val-end' },
        })),
      },
      strategy_order: [EXPLICIT_REPLAY_STRATEGY_IDS[0]],
      input_spec: inputSpec('passed'),
    });

    expect(changedTrainValidation).toEqual(base);
  });

  it('preserves explicit strategy order', () => {
    const order = [EXPLICIT_REPLAY_STRATEGY_IDS[2], EXPLICIT_REPLAY_STRATEGY_IDS[0]] as const;
    const result = buildTierBOosReplayPlan({
      walk_forward_plan: oneWindowPlan(),
      strategy_order: order,
      input_spec: inputSpec('passed'),
    });

    expect(result.windows.map((window) => window.strategy_id)).toEqual(order);
  });

  it('returns no OOS windows for the empty default active strategy order', () => {
    const result = buildTierBOosReplayPlan({
      walk_forward_plan: oneWindowPlan(),
      strategy_order: defaultOosStrategyOrder(),
      input_spec: inputSpec('passed'),
    });

    expect(ACTIVE_STRATEGY_IDS).toEqual([]);
    expect(result.windows.map((window) => window.strategy_id)).toEqual(ACTIVE_STRATEGY_IDS);
  });

  it('keeps pending fidelity from blocking framework construction', () => {
    const strategyId = EXPLICIT_REPLAY_STRATEGY_IDS[0];
    const result = buildTierBOosReplayPlan({
      walk_forward_plan: oneWindowPlan(),
      strategy_order: [strategyId],
      input_spec: inputSpec('pending'),
      strategy_fingerprints: [fingerprint(strategyId)],
      capability_assessments: [capability(strategyId, 'ready_for_replay')],
      validation_gate_results: [validation(strategyId, 'pass')],
    });

    expect(result.windows[0]).toMatchObject({
      status: 'evaluated',
      reasons: ['fidelity_pending'],
      fingerprint_sha256: fingerprint(strategyId).fingerprint_sha256,
      capability_status: 'ready_for_replay',
      validation_status: 'pass',
    });
  });

  it('blocks OOS results when fidelity prerequisite failed', () => {
    const strategyId = EXPLICIT_REPLAY_STRATEGY_IDS[0];
    const result = buildTierBOosReplayPlan({
      walk_forward_plan: oneWindowPlan(),
      strategy_order: [strategyId],
      input_spec: inputSpec('failed'),
      strategy_fingerprints: [fingerprint(strategyId)],
      capability_assessments: [capability(strategyId, 'ready_for_replay')],
      validation_gate_results: [validation(strategyId, 'pass')],
    });

    expect(result.windows[0]).toMatchObject({
      status: 'blocked',
      reasons: ['fidelity_failed'],
    });
  });

  it('returns insufficient evidence for framework-only results without replay execution artifacts', () => {
    const result = buildTierBOosReplayPlan({
      walk_forward_plan: oneWindowPlan(),
      strategy_order: [EXPLICIT_REPLAY_STRATEGY_IDS[0]],
      input_spec: inputSpec('passed'),
    });

    expect(result.windows[0]).toMatchObject({
      status: 'insufficient_evidence',
      reasons: ['fingerprint_missing', 'capability_missing', 'validation_gate_missing', 'framework_only_no_replay_execution'],
    });
  });

  it('rejects duplicate strategy order entries', () => {
    expect(() =>
      buildTierBOosReplayPlan({
        walk_forward_plan: oneWindowPlan(),
        strategy_order: [EXPLICIT_REPLAY_STRATEGY_IDS[0], EXPLICIT_REPLAY_STRATEGY_IDS[0]],
        input_spec: inputSpec('passed'),
      }),
    ).toThrow(OosReplayInputError);
  });

  it('repeated identical input produces deeply equal results', () => {
    const args = {
      walk_forward_plan: oneWindowPlan(),
      strategy_order: defaultOosStrategyOrder(),
      input_spec: inputSpec('passed'),
    };

    expect(buildTierBOosReplayPlan(args)).toEqual(buildTierBOosReplayPlan(args));
  });
});

function inputSpec(fidelityStatus: TierBOosInputSpec['fidelity_status']): TierBOosInputSpec {
  return buildTierBOosInputSpec({
    data_mode: 'tier_b_projection_from_tier_a',
    corpus_manifests: [{ event_schemas: ['trades', 'mbp-1', 'mbp-10', 'mbo'] }],
    corpus_manifest_hashes: [HASH_A],
    fidelity_status: fidelityStatus,
  });
}

function oneWindowPlan(): WalkForwardPlan {
  return {
    policy: {
      policy_version: 1,
      train_sessions: 2,
      validation_sessions: 1,
      test_sessions: 1,
      step_sessions: 1,
      min_required_sessions: 4,
    },
    sessions: ['2026-02-02-rth', '2026-02-03-rth', '2026-02-04-rth', '2026-02-05-rth'],
    windows: [
      {
        window_id: 'wf-1',
        sequence: 1,
        train: { start_session: '2026-02-02-rth', end_session: '2026-02-04-rth' },
        validation: { start_session: '2026-02-04-rth', end_session: '2026-02-05-rth' },
        test: { start_session: '2026-02-05-rth', end_session: '2026-02-06-rth' },
      },
    ],
  };
}

function walkForwardPlan(): WalkForwardPlan {
  return {
    ...oneWindowPlan(),
    sessions: [...oneWindowPlan().sessions, '2026-02-06-rth'],
    windows: [
      ...oneWindowPlan().windows,
      {
        window_id: 'wf-2',
        sequence: 2,
        train: { start_session: '2026-02-03-rth', end_session: '2026-02-05-rth' },
        validation: { start_session: '2026-02-05-rth', end_session: '2026-02-06-rth' },
        test: { start_session: '2026-02-06-rth', end_session: '2026-02-09-rth' },
      },
    ],
  };
}

function fingerprint(strategyId: StrategyId): StrategyFingerprint {
  return {
    fingerprint_schema_version: 1,
    algorithm: 'qfa_strategy_fingerprint_sha256_v1',
    strategy_id: strategyId,
    decision_count: 1,
    decisions_sha256: `${strategyId.length.toString(16).padStart(64, '0')}`,
    fingerprint_sha256: `${(strategyId.length + 1).toString(16).padStart(64, '0')}`,
  };
}

function capability(
  strategyId: StrategyId,
  status: StrategyCapabilityAssessment['status'],
): StrategyCapabilityAssessment {
  return {
    assessment_schema_version: 1,
    strategy_id: strategyId,
    status,
    replay_evaluations: 1,
    fingerprint_sha256: fingerprint(strategyId).fingerprint_sha256,
    decision_count: 1,
    features: [],
    limitations: [],
  };
}

function validation(strategyId: StrategyId, status: StrategyValidationGateResult['status']): StrategyValidationGateResult {
  return {
    result_schema_version: 1,
    strategy_id: strategyId,
    status,
    capability_status: 'ready_for_replay',
    fingerprint_sha256: fingerprint(strategyId).fingerprint_sha256,
    evaluated_test_windows: 1,
    zero_trade_windows: 0,
    aggregate_net_pnl_cents: 1n,
    aggregate_profit_factor_ppm: 1_100_000,
    average_trade_pnl_cents: 1n,
    worst_window_drawdown_ppm: 10_000,
    positive_window_share_ppm: 1_000_000,
    effective_trial_count: 1,
    trial_accounting_scope: 'campaign',
    trial_accounting_method: 'max_of_manual_and_distinct_fingerprints',
    checks: [],
    warnings: [],
    reasons: [],
  };
}
