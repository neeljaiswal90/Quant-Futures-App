"""Stationary block bootstrap helpers for QFA-611."""

from __future__ import annotations

import hashlib
import json
import math
import random
from typing import Iterable, Sequence


def politis_white_median_block_length(observation_count: int) -> int:
    if observation_count <= 0:
        raise ValueError("observation_count must be positive")
    return max(1, int(round(observation_count ** (1.0 / 3.0))))


def stationary_bootstrap_sample(
    values: Sequence[float],
    seed: int,
    mean_block_length: int | None = None,
) -> list[float]:
    if len(values) == 0:
        raise ValueError("values must be non-empty")
    block_length = mean_block_length or politis_white_median_block_length(len(values))
    if block_length <= 0:
        raise ValueError("mean_block_length must be positive")
    rng = random.Random(seed)
    continuation_probability = 1.0 - (1.0 / block_length)
    index = rng.randrange(len(values))
    sample: list[float] = []
    while len(sample) < len(values):
        sample.append(float(values[index]))
        if rng.random() < continuation_probability:
            index = (index + 1) % len(values)
        else:
            index = rng.randrange(len(values))
    return sample


def stationary_bootstrap_matrix(
    values: Sequence[float],
    replications: int = 10_000,
    seed: int = 42,
    mean_block_length: int | None = None,
) -> list[list[float]]:
    if replications <= 0:
        raise ValueError("replications must be positive")
    return [
        stationary_bootstrap_sample(values, seed + replication, mean_block_length)
        for replication in range(replications)
    ]


def stacked_sample_matrix_sha256(samples: Iterable[Sequence[float]]) -> str:
    payload = json.dumps([[round(float(value), 12) for value in row] for row in samples], separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def percentile(values: Sequence[float], q: float) -> float:
    if not 0.0 <= q <= 1.0:
        raise ValueError("q must be in [0, 1]")
    if len(values) == 0:
        raise ValueError("values must be non-empty")
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[int(position)]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight