"""Probabilistic and deflated Sharpe helpers for ADR-0016.

Implements the Bailey-Lopez de Prado PSR/DSR closed-form family over
predeclared non-overlapping session returns. The load-bearing DSR field is the
signed z-statistic; the probability is informational.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import NormalDist
from typing import Sequence

from hac_sharpe import sample_mean, sample_std
from returns import assert_decimal_returns
from thresholds import ANNUALIZATION_SESSIONS

_NORMAL = NormalDist()
_EULER_GAMMA = 0.5772156649015329


@dataclass(frozen=True)
class PsrDsrResult:
    psr_zero_null: float
    psr_hurdle_null: float
    dsr_statistic: float
    dsr_probability: float
    observed_sharpe: float
    benchmark_hurdle_sharpe: float
    effective_trial_count: int
    skewness: float
    kurtosis: float


def skewness(values: Sequence[float]) -> float:
    mean = sample_mean(values)
    std = sample_std(values)
    n = len(values)
    return sum(((value - mean) / std) ** 3 for value in values) / n


def kurtosis(values: Sequence[float]) -> float:
    mean = sample_mean(values)
    std = sample_std(values)
    n = len(values)
    return sum(((value - mean) / std) ** 4 for value in values) / n


def sharpe_ratio(returns: Sequence[float]) -> float:
    assert_decimal_returns(returns)
    std = sample_std(returns)
    if std == 0.0:
        raise ValueError("sample standard deviation must be non-zero")
    return sample_mean(returns) / std


def sharpe_variance(
    observed_sharpe: float,
    skew: float,
    kurt: float,
    observation_count: int,
) -> float:
    if observation_count < 2:
        raise ValueError("observation_count must be at least 2")
    numerator = 1.0 - (skew * observed_sharpe) + (((kurt - 1.0) / 4.0) * observed_sharpe * observed_sharpe)
    return max(numerator / (observation_count - 1), 0.0)


def probabilistic_sharpe_ratio(
    returns: Sequence[float],
    benchmark_sharpe: float = 0.0,
) -> float:
    assert_decimal_returns(returns)
    observed = sharpe_ratio(returns)
    skew = skewness(returns)
    kurt = kurtosis(returns)
    variance = sharpe_variance(observed, skew, kurt, len(returns))
    if variance == 0.0:
        return 1.0 if observed > benchmark_sharpe else 0.0
    z_score = (observed - benchmark_sharpe) / math.sqrt(variance)
    return _NORMAL.cdf(z_score)


def hurdle_sharpe_for_annual_return(
    returns: Sequence[float],
    annual_hurdle_return: float = 0.12,
) -> float:
    assert_decimal_returns(returns)
    std = sample_std(returns)
    if std == 0.0:
        raise ValueError("sample standard deviation must be non-zero")
    annualized_volatility = std * math.sqrt(ANNUALIZATION_SESSIONS)
    annualized_hurdle_sharpe = annual_hurdle_return / annualized_volatility
    return annualized_hurdle_sharpe / math.sqrt(ANNUALIZATION_SESSIONS)


def expected_maximum_sharpe(effective_trial_count: int) -> float:
    if effective_trial_count < 1:
        raise ValueError("effective_trial_count must be positive")
    if effective_trial_count == 1:
        return 0.0
    n = float(effective_trial_count)
    return ((1.0 - _EULER_GAMMA) * _NORMAL.inv_cdf(1.0 - (1.0 / n))) + (
        _EULER_GAMMA * _NORMAL.inv_cdf(1.0 - (1.0 / (n * math.e)))
    )


def deflated_sharpe_statistic(
    returns: Sequence[float],
    effective_trial_count: int,
) -> float:
    assert_decimal_returns(returns)
    observed = sharpe_ratio(returns)
    skew = skewness(returns)
    kurt = kurtosis(returns)
    variance = sharpe_variance(observed, skew, kurt, len(returns))
    if variance == 0.0:
        return math.inf if observed > 0.0 else -math.inf
    selection_threshold = expected_maximum_sharpe(effective_trial_count) * math.sqrt(variance)
    return (observed - selection_threshold) / math.sqrt(variance)


def minimum_track_record_length(
    observed_sharpe: float,
    benchmark_sharpe: float,
    skew: float,
    kurt: float,
    confidence: float = 0.95,
) -> float:
    if observed_sharpe <= benchmark_sharpe:
        return math.inf
    z = _NORMAL.inv_cdf(confidence)
    numerator = 1.0 - (skew * observed_sharpe) + (((kurt - 1.0) / 4.0) * observed_sharpe * observed_sharpe)
    return 1.0 + numerator * (z / (observed_sharpe - benchmark_sharpe)) ** 2


def compute_psr_dsr(
    returns: Sequence[float],
    effective_trial_count: int,
    annual_hurdle_return: float = 0.12,
) -> PsrDsrResult:
    hurdle = hurdle_sharpe_for_annual_return(returns, annual_hurdle_return)
    dsr = deflated_sharpe_statistic(returns, effective_trial_count)
    return PsrDsrResult(
        psr_zero_null=probabilistic_sharpe_ratio(returns, 0.0),
        psr_hurdle_null=probabilistic_sharpe_ratio(returns, hurdle),
        dsr_statistic=dsr,
        dsr_probability=_NORMAL.cdf(dsr),
        observed_sharpe=sharpe_ratio(returns),
        benchmark_hurdle_sharpe=hurdle,
        effective_trial_count=effective_trial_count,
        skewness=skewness(returns),
        kurtosis=kurtosis(returns),
    )