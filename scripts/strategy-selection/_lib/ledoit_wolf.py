"""Ledoit-Wolf style studentized bootstrap tie-breaker helpers.

This module is intentionally small for Cycle1: it supports future multiple
ADVANCE tie-breaks without participating in the primary ADR-0016 gate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from block_bootstrap import percentile, stationary_bootstrap_matrix
from hac_sharpe import sample_std
from psr_dsr import sharpe_ratio


@dataclass(frozen=True)
class SharpeDifferenceCi:
    observed_difference: float
    ci_low: float
    ci_high: float
    confidence: float
    replications: int


def _standard_error(values: Sequence[float]) -> float:
    if len(values) < 2:
        raise ValueError("at least two bootstrap values are required")
    return sample_std(values) / math.sqrt(len(values))


def studentized_sharpe_difference_ci(
    returns_a: Sequence[float],
    returns_b: Sequence[float],
    replications: int = 10_000,
    seed: int = 42,
    confidence: float = 0.95,
) -> SharpeDifferenceCi:
    if len(returns_a) != len(returns_b):
        raise ValueError("return series must have equal length")
    observed = sharpe_ratio(returns_a) - sharpe_ratio(returns_b)
    samples_a = stationary_bootstrap_matrix(returns_a, replications, seed)
    samples_b = stationary_bootstrap_matrix(returns_b, replications, seed + 1_000_000)
    diffs = [sharpe_ratio(a) - sharpe_ratio(b) for a, b in zip(samples_a, samples_b)]
    se = _standard_error(diffs)
    if se == 0.0:
        return SharpeDifferenceCi(observed, observed, observed, confidence, replications)
    centered = sorted((diff - observed) / se for diff in diffs)
    alpha = 1.0 - confidence
    low_t = percentile(centered, 1.0 - alpha / 2.0)
    high_t = percentile(centered, alpha / 2.0)
    return SharpeDifferenceCi(
        observed_difference=observed,
        ci_low=observed - low_t * se,
        ci_high=observed - high_t * se,
        confidence=confidence,
        replications=replications,
    )