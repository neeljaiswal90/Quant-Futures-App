from __future__ import annotations

import json
import math
import sys
import unittest
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LIB_DIR))

from block_bootstrap import stacked_sample_matrix_sha256, stationary_bootstrap_matrix
from effective_trials import compute_effective_trial_count
from hac_sharpe import automatic_newey_west_lag, compute_hac_sharpe, newey_west_standard_error_of_mean
from psr_dsr import compute_psr_dsr, probabilistic_sharpe_ratio
from returns import aggregate_session_returns
from thresholds import ADR0016_RISK_BUDGETS, ADR0016_STAGE1_THRESHOLDS, ADR0016_STAGE2_THRESHOLDS


class Qfa611StatCoreTests(unittest.TestCase):
    def test_threshold_shape_and_field_names(self) -> None:
        self.assertEqual(ADR0016_STAGE1_THRESHOLDS["annualized_return_min_decimal"], 0.12)
        self.assertEqual(ADR0016_STAGE1_THRESHOLDS["annualized_sharpe_min"], 1.0)
        self.assertEqual(ADR0016_STAGE1_THRESHOLDS["dsr_statistic_min"], 0.0)
        self.assertEqual(ADR0016_STAGE1_THRESHOLDS["psr_zero_null_min"], 0.80)
        self.assertEqual(ADR0016_STAGE1_THRESHOLDS["max_drawdown_max_decimal"], 0.08)
        self.assertEqual(ADR0016_STAGE1_THRESHOLDS["profit_factor_min"], 1.35)
        self.assertEqual(ADR0016_STAGE1_THRESHOLDS["total_trades_min"], 300)
        self.assertEqual(ADR0016_RISK_BUDGETS["max_risk_per_trade_pct"], 0.25)
        self.assertEqual(ADR0016_STAGE2_THRESHOLDS["psr_zero_null_min"], 0.95)

    def test_returns_are_decimal_net_returns_with_fixed_denominator(self) -> None:
        trades = [
            {"session_id": "s1", "gross_pnl_cents": "999999", "net_pnl_cents": "100"},
            {"session_id": "s1", "gross_pnl_cents": "999999", "net_pnl_cents": "-50"},
            {"session_id": "s3", "gross_pnl_cents": "999999", "net_pnl_cents": "200"},
        ]
        self.assertEqual(
            aggregate_session_returns(trades, ["s1", "s2", "s3"], 10_000),
            [0.005, 0.0, 0.02],
        )

    def test_integer_cent_returns_are_rejected_by_sharpe_psr(self) -> None:
        with self.assertRaises(TypeError):
            compute_hac_sharpe([100, -50, 200])  # type: ignore[list-item]
        with self.assertRaises(TypeError):
            probabilistic_sharpe_ratio([100, -50, 200])  # type: ignore[list-item]

    def test_hac_fields_are_separate_and_deterministic(self) -> None:
        returns = [0.003, -0.001, 0.002, 0.004, -0.002, 0.001, 0.003, 0.0]
        result = compute_hac_sharpe(returns, bandwidth_lag=2)
        self.assertAlmostEqual(result.annualized_sharpe, 9.354143467, places=9)
        self.assertAlmostEqual(result.hac_standard_error_of_mean, 0.000233854, places=9)
        self.assertAlmostEqual(result.hac_t_stat, 5.345224838, places=9)
        self.assertEqual(result.bandwidth_lag, 2)
        self.assertEqual(automatic_newey_west_lag(57), 3)

    def test_psr_dsr_emits_required_fields(self) -> None:
        returns = [0.003, -0.001, 0.002, 0.004, -0.002, 0.001, 0.003, 0.0]
        result = compute_psr_dsr(returns, effective_trial_count=4)
        self.assertGreater(result.psr_zero_null, 0.90)
        self.assertGreater(result.psr_hurdle_null, 0.80)
        self.assertTrue(math.isfinite(result.dsr_statistic))
        self.assertTrue(0.0 <= result.dsr_probability <= 1.0)
        self.assertEqual(result.effective_trial_count, 4)

    def test_stationary_bootstrap_reproducibility(self) -> None:
        returns = [0.001, 0.002, -0.001, 0.003, 0.0]
        a = stationary_bootstrap_matrix(returns, replications=5, seed=42, mean_block_length=2)
        b = stationary_bootstrap_matrix(returns, replications=5, seed=42, mean_block_length=2)
        c = stationary_bootstrap_matrix(returns, replications=5, seed=43, mean_block_length=2)
        self.assertEqual(stacked_sample_matrix_sha256(a), stacked_sample_matrix_sha256(b))
        self.assertNotEqual(stacked_sample_matrix_sha256(a), stacked_sample_matrix_sha256(c))

    def test_effective_trials_mirror(self) -> None:
        self.assertEqual(compute_effective_trial_count(3, 7), 7)
        self.assertEqual(compute_effective_trial_count(11, 7), 11)
        self.assertEqual(compute_effective_trial_count(3, 7, "manual_declared"), 3)
        self.assertEqual(compute_effective_trial_count(3, 7, "distinct_window_fingerprint_tuples"), 7)


if __name__ == "__main__":
    unittest.main()