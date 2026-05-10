"""Python mirror of validation-gate trial-accounting effective-count logic."""

from __future__ import annotations


def compute_effective_trial_count(
    manual_declared_effective_trials: int,
    distinct_window_fingerprint_tuples: int,
    effective_trial_method: str = "max_of_manual_and_distinct_fingerprints",
) -> int:
    if manual_declared_effective_trials < 0 or distinct_window_fingerprint_tuples < 0:
        raise ValueError("trial counts must be non-negative")
    if effective_trial_method == "manual_declared":
        return manual_declared_effective_trials
    if effective_trial_method == "distinct_window_fingerprint_tuples":
        return distinct_window_fingerprint_tuples
    if effective_trial_method == "max_of_manual_and_distinct_fingerprints":
        return max(manual_declared_effective_trials, distinct_window_fingerprint_tuples)
    raise ValueError(f"unsupported effective_trial_method: {effective_trial_method}")