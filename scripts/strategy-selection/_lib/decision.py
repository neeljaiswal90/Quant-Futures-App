"""Pure QFA-611 verdict logic."""

from __future__ import annotations

from typing import Any, Mapping

from thresholds import ADR0016_STAGE1_THRESHOLDS


MIN_THRESHOLD_FIELDS = {
    "hurdle_pass": ("annualized_return", "annualized_return_min_decimal"),
    "sharpe_pass": ("annualized_sharpe", "annualized_sharpe_min"),
    "dsr_pass": ("dsr_statistic", "dsr_statistic_min"),
    "psr_zero_pass": ("psr_zero_null", "psr_zero_null_min"),
    "pf_pass": ("profit_factor", "profit_factor_min"),
    "trade_count_pass": ("total_trades", "total_trades_min"),
}

MAX_THRESHOLD_FIELDS = {
    "drawdown_pass": ("max_drawdown_pct", "max_drawdown_max_decimal"),
}


def decide_strategy_verdict(
    evidence: Mapping[str, Any],
    threshold_results: Mapping[str, bool],
    sensitivity_audit: Mapping[str, Any],
) -> dict[str, str]:
    failed = [name for name, passed in threshold_results.items() if not passed]
    if not failed:
        return {"verdict": "ADVANCE_TO_PAPER", "reason": "all_stage1_thresholds_passed"}

    severe = [name for name in failed if threshold_miss_is_severe(name, evidence)]
    if len(failed) <= 2 and not severe:
        return {"verdict": "RESEARCH_FURTHER", "reason": "one_or_two_thresholds_failed_within_20pct"}
    if sensitivity_audit.get("flag") is True and failed == ["sensitivity_audit_pass"]:
        return {"verdict": "RESEARCH_FURTHER", "reason": str(sensitivity_audit.get("reason", "sensitivity_audit_flag"))}
    if len(failed) >= 3:
        return {"verdict": "REJECT", "reason": "three_or_more_stage1_thresholds_failed"}
    if severe:
        return {"verdict": "REJECT", "reason": f"stage1_threshold_failed_by_20pct_or_more:{','.join(severe)}"}
    return {"verdict": "RESEARCH_FURTHER", "reason": "stage1_thresholds_require_research_followup"}


def threshold_miss_is_severe(name: str, evidence: Mapping[str, Any]) -> bool:
    thresholds = ADR0016_STAGE1_THRESHOLDS
    if name in MIN_THRESHOLD_FIELDS:
        metric_field, threshold_field = MIN_THRESHOLD_FIELDS[name]
        value = evidence.get(metric_field)
        threshold = thresholds[threshold_field]
        if value is None:
            return True
        if threshold == 0:
            return float(value) < 0
        return float(value) < (0.8 * float(threshold))
    if name in MAX_THRESHOLD_FIELDS:
        metric_field, threshold_field = MAX_THRESHOLD_FIELDS[name]
        value = evidence.get(metric_field)
        threshold = thresholds[threshold_field]
        if value is None:
            return True
        return float(value) > (1.2 * float(threshold))
    if name == "regime_trade_pass":
        return True
    if name == "sensitivity_audit_pass":
        return False
    return True
