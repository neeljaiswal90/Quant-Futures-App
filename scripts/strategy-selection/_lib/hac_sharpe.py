"""Sharpe and Newey-West HAC statistics for session-level returns."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from returns import assert_decimal_returns
from thresholds import ANNUALIZATION_SESSIONS


@dataclass(frozen=True)
class HacSharpeResult:
    annualized_sharpe: float
    hac_standard_error_of_mean: float
    hac_t_stat: float
    sample_mean: float
    sample_std: float
    bandwidth_lag: int
    observation_count: int


def automatic_newey_west_lag(observation_count: int) -> int:
    if observation_count <= 0:
        raise ValueError("observation_count must be positive")
    return int(math.floor(4.0 * ((observation_count / 100.0) ** (2.0 / 9.0))))


def sample_mean(values: Sequence[float]) -> float:
    return sum(values) / len(values)


def sample_std(values: Sequence[float]) -> float:
    if len(values) < 2:
        raise ValueError("at least two observations are required")
    mean = sample_mean(values)
    variance = sum((value - mean) ** 2 for value in values) / (len(values) - 1)
    return math.sqrt(variance)


def newey_west_standard_error_of_mean(
    returns: Sequence[float],
    bandwidth_lag: int | None = None,
) -> float:
    assert_decimal_returns(returns)
    n = len(returns)
    if n < 2:
        raise ValueError("at least two returns are required")
    lag = automatic_newey_west_lag(n) if bandwidth_lag is None else bandwidth_lag
    if lag < 0:
        raise ValueError("bandwidth_lag must be non-negative")
    lag = min(lag, n - 1)
    mean = sample_mean(returns)
    centered = [value - mean for value in returns]
    gamma0 = sum(value * value for value in centered) / n
    long_run_variance = gamma0
    for k in range(1, lag + 1):
        gamma_k = sum(centered[t] * centered[t - k] for t in range(k, n)) / n
        weight = 1.0 - (k / (lag + 1.0))
        long_run_variance += 2.0 * weight * gamma_k
    return math.sqrt(max(long_run_variance, 0.0) / n)


def compute_hac_sharpe(
    returns: Sequence[float],
    bandwidth_lag: int | None = None,
) -> HacSharpeResult:
    assert_decimal_returns(returns)
    n = len(returns)
    std = sample_std(returns)
    if std == 0.0:
        raise ValueError("sample standard deviation must be non-zero")
    mean = sample_mean(returns)
    lag = automatic_newey_west_lag(n) if bandwidth_lag is None else bandwidth_lag
    se = newey_west_standard_error_of_mean(returns, lag)
    if se == 0.0:
        raise ValueError("HAC standard error must be non-zero")
    return HacSharpeResult(
        annualized_sharpe=(mean / std) * math.sqrt(ANNUALIZATION_SESSIONS),
        hac_standard_error_of_mean=se,
        hac_t_stat=mean / se,
        sample_mean=mean,
        sample_std=std,
        bandwidth_lag=min(lag, n - 1),
        observation_count=n,
    )