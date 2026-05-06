import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VALIDATION_GATE_POLICY_V1,
  ValidationGateInputError,
  validateValidationGatePolicy,
} from '../../../src/validation-gate/index.js';

describe('validation gate default policy', () => {
  it('matches QFA-310 walkthrough defaults', () => {
    expect(DEFAULT_VALIDATION_GATE_POLICY_V1.policy_schema_version).toBe(1);
    expect(DEFAULT_VALIDATION_GATE_POLICY_V1.eligibility.allowed_passing_capability_statuses).toEqual([
      'ready_for_replay',
    ]);
    expect(DEFAULT_VALIDATION_GATE_POLICY_V1.eligibility.allow_degraded_replay_to_pass).toBe(false);
    expect(DEFAULT_VALIDATION_GATE_POLICY_V1.eligibility.required_fingerprint_algorithm).toBe(
      'qfa_strategy_fingerprint_sha256_v1',
    );
    expect(DEFAULT_VALIDATION_GATE_POLICY_V1.windowing).toMatchObject({
      evaluation_basis: 'test_only',
      require_non_overlapping_test_windows: true,
      on_overlap: 'insufficient_evidence',
      min_test_windows: 8,
      min_trades_total: 80,
      min_trades_per_window: 5,
      max_zero_trade_windows: 1,
    });
    expect(DEFAULT_VALIDATION_GATE_POLICY_V1.thresholds).toMatchObject({
      min_aggregate_net_pnl_cents: 1n,
      min_aggregate_profit_factor_ppm: 1_100_000,
      min_average_trade_pnl_cents: 1n,
      min_positive_window_share_ppm: 550_000,
      max_worst_window_drawdown_ppm: 50_000,
      min_win_rate_ppm: null,
    });
    expect(DEFAULT_VALIDATION_GATE_POLICY_V1.trial_accounting).toMatchObject({
      required: true,
      effective_trial_scope: 'campaign',
      effective_trial_method: 'max_of_manual_and_distinct_fingerprints',
      high_trial_warning_threshold: 20,
      max_effective_trial_count_for_pass: null,
    });
  });

  it('keeps advanced statistics hooks disabled by default', () => {
    expect(DEFAULT_VALIDATION_GATE_POLICY_V1.statistics).toEqual({
      dsr: { enabled: false, min_confidence_ppm: null },
      white_reality_check: { enabled: false, max_pvalue_ppm: null },
      spa: { enabled: false, max_pvalue_ppm: null },
      pbo: { enabled: false, max_probability_ppm: null },
    });
  });

  it('rejects policies that allow degraded replay to pass', () => {
    expect(() =>
      validateValidationGatePolicy({
        ...DEFAULT_VALIDATION_GATE_POLICY_V1,
        eligibility: {
          ...DEFAULT_VALIDATION_GATE_POLICY_V1.eligibility,
          allow_degraded_replay_to_pass: true,
        },
      }),
    ).toThrow(ValidationGateInputError);
  });
});
