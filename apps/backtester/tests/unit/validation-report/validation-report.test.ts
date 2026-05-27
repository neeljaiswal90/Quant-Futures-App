import { describe, expect, it } from 'vitest';

import type { StrategyId } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  createValidationReport,
  type ValidationGateResultSet,
} from '../../../src/index.js';

const EXPLICIT_REPLAY_STRATEGY_IDS = [
  'vwap_overnight_reversal_long',
  'vwap_overnight_reversal_short',
] as const satisfies readonly StrategyId[];

describe('validation report', () => {
  it('summarizes QFA-310 result fields without re-evaluating policy', () => {
    const resultSet = makeResultSet();
    const report = createValidationReport(resultSet);

    expect(report.summary).toEqual({
      total_strategies: 2,
      pass: 1,
      fail: 1,
      blocked: 0,
      insufficient_evidence: 0,
      warning_count: 1,
      reason_count: 1,
    });
    expect(report.strategy_results.map((result) => result.strategy_id)).toEqual([
      EXPLICIT_REPLAY_STRATEGY_IDS[1],
      EXPLICIT_REPLAY_STRATEGY_IDS[0],
    ]);
    expect(report.strategy_results[0]).toMatchObject({
      status: 'pass',
      fingerprint_lineage: {
        source: 'qfa-310-validation-gate-result',
        fingerprint_sha256: 'a'.repeat(64),
      },
      trial_accounting: {
        effective_trial_count: 99,
        scope: 'campaign',
        method: 'max_of_manual_and_distinct_fingerprints',
      },
    });
    expect(report.strategy_results[0]?.checks[0]).toMatchObject({
      name: 'aggregate_net_pnl',
      status: 'fail',
      observed: -1n,
      threshold: 1n,
    });
  });
});

function makeResultSet(): ValidationGateResultSet {
  return {
    result_set_schema_version: 1,
    policy_version: 1,
    results: [
      {
        result_schema_version: 1,
        strategy_id: EXPLICIT_REPLAY_STRATEGY_IDS[1]!,
        status: 'pass',
        capability_status: 'ready_for_replay',
        fingerprint_sha256: 'a'.repeat(64),
        evaluated_test_windows: 8,
        zero_trade_windows: 0,
        aggregate_net_pnl_cents: -1n,
        aggregate_profit_factor_ppm: 900_000,
        average_trade_pnl_cents: -1n,
        worst_window_drawdown_ppm: 60_000,
        positive_window_share_ppm: 125_000,
        effective_trial_count: 99,
        trial_accounting_scope: 'campaign',
        trial_accounting_method: 'max_of_manual_and_distinct_fingerprints',
        checks: [
          {
            name: 'aggregate_net_pnl',
            status: 'fail',
            observed: -1n,
            threshold: 1n,
            message: 'upstream supplied check is preserved',
          },
        ],
        warnings: [
          {
            code: 'high_effective_trial_count',
            message: 'upstream supplied warning is preserved',
          },
        ],
        reasons: [],
      },
      {
        result_schema_version: 1,
        strategy_id: EXPLICIT_REPLAY_STRATEGY_IDS[0]!,
        status: 'fail',
        capability_status: 'ready_for_replay',
        fingerprint_sha256: null,
        evaluated_test_windows: 0,
        zero_trade_windows: 0,
        aggregate_net_pnl_cents: null,
        aggregate_profit_factor_ppm: null,
        average_trade_pnl_cents: null,
        worst_window_drawdown_ppm: null,
        positive_window_share_ppm: null,
        effective_trial_count: null,
        trial_accounting_scope: null,
        trial_accounting_method: null,
        checks: [],
        warnings: [],
        reasons: ['threshold_failed'],
      },
    ],
  };
}
