#!/usr/bin/env python
"""SIM-03 fill/slippage calibration.

This tool fits SIM-02 queue/slippage constants from a SIM-03A verified
Databento corpus and scores the held-out validation split against plan 11.1
residual thresholds. Unit tests use tiny JSONL fixtures; production runs use
Databento DBN files from the SIM-03A manifest.
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Literal


CALIBRATION_REPORT_SCHEMA_VERSION = 1
SUPPORTED_MANIFEST_SCHEMA_VERSION = 1
SUPPORTED_VERIFIED_REPORT_SCHEMA_VERSION = 1
SUPPORTED_THRESHOLDS_SCHEMA_VERSION = 1
TICKET_ID = "SIM-03"
SIMULATED_EXECUTION_FITTER_VERSION = "fitter_v1"
TICK_SIZE_POINTS = 0.25
DBN_CHUNK_RECORDS = 100_000

DEFAULT_MIN_BUCKET_SAMPLE = 5
DEFAULT_KS_THRESHOLD = 0.15
DEFAULT_FILL_RATE_RESIDUAL_THRESHOLD = 0.10
DEFAULT_NO_FILL_RATE_RESIDUAL_THRESHOLD = 0.10
DEFAULT_TIME_TO_FILL_RELATIVE_THRESHOLD = 0.25
TIME_TO_FILL_EXACT_SAMPLE_LIMIT = 10_000
TIME_TO_FILL_BUCKET_MS = 100.0


@dataclass(frozen=True)
class CalibrationRequest:
    manifest_path: Path
    verified_report_path: Path
    thresholds_path: Path
    out_path: Path
    calibrated_at_ts_ns: str
    markdown_out_path: Path | None
    min_bucket_sample: int


@dataclass(frozen=True)
class BboSample:
    ts_event_ns: int
    bid_px: float
    ask_px: float


@dataclass
class OpenOrder:
    order_id: int
    side: str
    price: int
    size: int
    add_ts_ns: int
    queue_ahead_size: int
    queue_ahead_order_count: int
    session_id: str
    split: Literal["calibration", "validation"]


@dataclass
class LevelState:
    total_size: int = 0
    order_count: int = 0


SplitName = Literal["calibration", "validation"]


@dataclass
class ValueDistribution:
    counts: Counter[float] = field(default_factory=Counter)
    total_count: int = 0
    total_sum: float = 0.0
    total_abs_sum: float = 0.0

    def add(self, value: float) -> None:
        self.counts[value] += 1
        self.total_count += 1
        self.total_sum += value
        self.total_abs_sum += abs(value)

    def __len__(self) -> int:
        return self.total_count

    def mean(self) -> float | None:
        if self.total_count <= 0:
            return None
        return self.total_sum / self.total_count

    def mean_abs(self) -> float | None:
        if self.total_count <= 0:
            return None
        return self.total_abs_sum / self.total_count

    def count_at_or_above(self, threshold: float) -> int:
        return sum(count for value, count in self.counts.items() if value >= threshold)


@dataclass
class TimeToFillDistribution:
    exact_values: list[float] = field(default_factory=list)
    bucket_counts: Counter[int] = field(default_factory=Counter)
    total_count: int = 0
    quantized: bool = False

    def add(self, value: float) -> None:
        self.total_count += 1
        if not self.quantized and len(self.exact_values) < TIME_TO_FILL_EXACT_SAMPLE_LIMIT:
            self.exact_values.append(value)
            return
        if not self.quantized:
            for exact_value in self.exact_values:
                self.bucket_counts[self._bucket(exact_value)] += 1
            self.exact_values.clear()
            self.quantized = True
        self.bucket_counts[self._bucket(value)] += 1

    def median(self) -> float | None:
        if self.total_count <= 0:
            return None
        if not self.quantized:
            return _median(self.exact_values)
        rank = 0.5 * (self.total_count - 1)
        lower = math.floor(rank)
        upper = math.ceil(rank)
        if lower == upper:
            return self._bucket_value_at_index(int(rank))
        weight = rank - lower
        lower_value = self._bucket_value_at_index(lower)
        upper_value = self._bucket_value_at_index(upper)
        return lower_value * (1 - weight) + upper_value * weight

    @staticmethod
    def _bucket(value: float) -> int:
        return int(round(value / TIME_TO_FILL_BUCKET_MS))

    def _bucket_value_at_index(self, index: int) -> float:
        seen = 0
        for bucket, count in sorted(self.bucket_counts.items()):
            seen += count
            if index < seen:
                return bucket * TIME_TO_FILL_BUCKET_MS
        raise IndexError("time-to-fill distribution index out of range")


@dataclass
class MarketableAggregates:
    all_values_by_split: dict[str, ValueDistribution] = field(
        default_factory=lambda: {"calibration": ValueDistribution(), "validation": ValueDistribution()}
    )
    bucket_values_by_split: dict[str, dict[str, ValueDistribution]] = field(
        default_factory=lambda: {
            "calibration": defaultdict(ValueDistribution),
            "validation": defaultdict(ValueDistribution),
        }
    )
    bucket_ids: set[str] = field(default_factory=set)
    count: int = 0

    def add(self, split: SplitName, bucket_id: str, slippage_points: float) -> None:
        self.all_values_by_split[split].add(slippage_points)
        self.bucket_values_by_split[split][bucket_id].add(slippage_points)
        self.bucket_ids.add(bucket_id)
        self.count += 1


@dataclass
class LimitBucketAggregate:
    total_count: int = 0
    fill_count: int = 0
    time_to_fill_ms: TimeToFillDistribution = field(default_factory=TimeToFillDistribution)

    def add(self, *, filled: bool, time_to_fill_ms: float | None) -> None:
        self.total_count += 1
        if filled:
            self.fill_count += 1
        if time_to_fill_ms is not None:
            self.time_to_fill_ms.add(time_to_fill_ms)


@dataclass
class LimitAggregates:
    all_by_split: dict[str, LimitBucketAggregate] = field(
        default_factory=lambda: {"calibration": LimitBucketAggregate(), "validation": LimitBucketAggregate()}
    )
    bucket_by_split: dict[str, dict[str, LimitBucketAggregate]] = field(
        default_factory=lambda: {"calibration": defaultdict(LimitBucketAggregate), "validation": defaultdict(LimitBucketAggregate)}
    )
    bucket_names: set[str] = field(default_factory=set)
    count: int = 0

    def add(
        self,
        *,
        split: SplitName,
        queue_bucket: str,
        filled: bool,
        time_to_fill_ms: float | None,
    ) -> None:
        self.all_by_split[split].add(filled=filled, time_to_fill_ms=time_to_fill_ms)
        self.bucket_by_split[split][queue_bucket].add(filled=filled, time_to_fill_ms=time_to_fill_ms)
        self.bucket_names.add(queue_bucket)
        self.count += 1


def calibrate(request: CalibrationRequest) -> dict[str, Any]:
    manifest = _read_json(request.manifest_path)
    verified_report = _read_json(request.verified_report_path)
    thresholds = _read_json(request.thresholds_path)
    manifest_hash = _sha256_file(request.manifest_path)
    verified_report_hash = _sha256_file(request.verified_report_path)
    thresholds_hash = _sha256_file(request.thresholds_path)

    _validate_lineage(
        manifest=manifest,
        verified_report=verified_report,
        thresholds=thresholds,
        manifest_hash=manifest_hash,
        thresholds_hash=thresholds_hash,
    )

    verified_session_ids = _verified_session_ids(verified_report)
    source_sessions = _eligible_source_sessions(manifest, verified_session_ids)
    calibration_sessions = [session for session in source_sessions if session.get("split") == "calibration"]
    validation_sessions = [session for session in source_sessions if session.get("split") == "validation"]

    marketable_observations = MarketableAggregates()
    limit_observations = LimitAggregates()
    reader_diagnostics: list[dict[str, Any]] = []
    for session in source_sessions:
        diagnostics = _read_session_observations(
            session,
            marketable_observations=marketable_observations,
            limit_observations=limit_observations,
        )
        reader_diagnostics.append(diagnostics)

    marketable = _score_marketable(
        marketable_observations,
        min_bucket_sample=request.min_bucket_sample,
    )
    limit = _score_limit_queue(
        limit_observations,
        min_bucket_sample=request.min_bucket_sample,
    )
    strategy_cost = _score_strategy_cost(marketable_observations, request.min_bucket_sample)

    failure_reasons = [
        *marketable["failure_reasons"],
        *limit["failure_reasons"],
        *strategy_cost["failure_reasons"],
    ]
    if not calibration_sessions:
        failure_reasons.append("no verified calibration sessions found")
    if not validation_sessions:
        failure_reasons.append("no verified validation sessions found")

    status = "pass" if not failure_reasons else "fail"
    report: dict[str, Any] = {
        "calibration_report_schema_version": CALIBRATION_REPORT_SCHEMA_VERSION,
        "ticket_id": TICKET_ID,
        "status": status,
        "ready_for_rel01_execution_simulation": status == "pass",
        "simulated_execution_fitter_version": SIMULATED_EXECUTION_FITTER_VERSION,
        "calibrated_at_ts_ns": request.calibrated_at_ts_ns,
        "inputs": {
            "manifest_path": str(request.manifest_path),
            "manifest_hash": manifest_hash,
            "verified_report_path": str(request.verified_report_path),
            "verified_report_hash": verified_report_hash,
            "thresholds_path": str(request.thresholds_path),
            "thresholds_config_hash": thresholds_hash,
            "thresholds_schema_version": thresholds.get("thresholds_schema_version"),
            "verified_report_ready": verified_report.get("ready_for_sim03_model_fitting"),
        },
        "corpus_summary": {
            "verified_sessions": len(source_sessions),
            "calibration_sessions": len(calibration_sessions),
            "validation_sessions": len(validation_sessions),
            "marketable_observations": marketable_observations.count,
            "limit_observations": limit_observations.count,
            "quality_excluded_sessions": int(
                verified_report.get("corpus_summary", {}).get("quality_excluded_sessions", 0)
            ),
        },
        "residual_thresholds": {
            "marketable_slippage_ks": DEFAULT_KS_THRESHOLD,
            "marketable_p50_points": "max(0.25 tick, 20% empirical abs p50)",
            "marketable_p90_points": "max(0.50 tick, 25% empirical abs p90)",
            "adverse_p95_points": "max(0.50 tick, 25% empirical adverse p95)",
            "limit_fill_probability_points": DEFAULT_FILL_RATE_RESIDUAL_THRESHOLD,
            "limit_time_to_fill_relative": DEFAULT_TIME_TO_FILL_RELATIVE_THRESHOLD,
            "limit_no_fill_rate_points": DEFAULT_NO_FILL_RATE_RESIDUAL_THRESHOLD,
            "strategy_mean_slippage_points": "max(0.25 tick, 15% empirical mean abs slippage)",
            "min_bucket_sample": request.min_bucket_sample,
        },
        "fitted_constants": {
            "marketable_slippage": marketable["fitted_constants"],
            "queue_fill_model": limit["fitted_constants"],
        },
        "residuals": {
            "marketable_slippage": marketable["residuals"],
            "limit_queue": limit["residuals"],
            "strategy_level_cost": strategy_cost["residuals"],
        },
        "insufficient_sample_buckets": [
            *marketable["insufficient_sample_buckets"],
            *limit["insufficient_sample_buckets"],
            *strategy_cost["insufficient_sample_buckets"],
        ],
        "reader_diagnostics": reader_diagnostics,
        "failure_reasons": failure_reasons,
        "scope_note": (
            "SIM-03 fits and scores simulated execution constants from a verified SIM-03A corpus. "
            "It performs no Databento network calls and does not advance RSRCH or REL gates by itself."
        ),
    }
    _write_json(request.out_path, report)
    if request.markdown_out_path is not None:
        _write_markdown(request.markdown_out_path, report)
    return report


def _read_session_observations(
    session: dict[str, Any],
    *,
    marketable_observations: MarketableAggregates,
    limit_observations: LimitAggregates,
) -> dict[str, Any]:
    session_id = str(session["session_id"])
    split = _session_split(session)
    schemas = session.get("schemas", {})
    bbo_samples = _read_bbo_samples(Path(str(schemas["mbp-1"]["path"])))
    marketable_count = _read_marketable_observations(
        session=session,
        split=split,
        aggregates=marketable_observations,
        bbo_samples=bbo_samples,
        trades_path=Path(str(schemas["trades"]["path"])),
    )
    limit_count = _read_limit_observations(
        session=session,
        split=split,
        aggregates=limit_observations,
        mbo_path=Path(str(schemas["mbo"]["path"])),
    )
    return {
        "session_id": session_id,
        "split": split,
        "bbo_samples": len(bbo_samples),
        "marketable_observations": marketable_count,
        "limit_observations": limit_count,
    }


def _read_bbo_samples(path: Path) -> list[BboSample]:
    samples: list[BboSample] = []
    for record in _iter_records(path, "mbp-1"):
        ts = _int_field(record, "ts_event")
        bid = _price_field(record, "bid_px_00")
        ask = _price_field(record, "ask_px_00")
        if ts is None or bid is None or ask is None or bid <= 0 or ask <= 0 or bid > ask:
            continue
        samples.append(BboSample(ts_event_ns=ts, bid_px=bid, ask_px=ask))
    samples.sort(key=lambda sample: sample.ts_event_ns)
    return samples


def _read_marketable_observations(
    *,
    session: dict[str, Any],
    split: SplitName,
    aggregates: MarketableAggregates,
    bbo_samples: list[BboSample],
    trades_path: Path,
) -> int:
    if not bbo_samples:
        return 0
    bbo_ts = [sample.ts_event_ns for sample in bbo_samples]
    observation_count = 0
    start_ts_ns = int(session["rth_window"]["start_ts_ns"])
    end_ts_ns = int(session["rth_window"]["end_ts_ns"])
    for record in _iter_records(trades_path, "trades"):
        ts = _int_field(record, "ts_event")
        price = _price_field(record, "price")
        if ts is None or price is None or price <= 0:
            continue
        bbo_index = bisect.bisect_right(bbo_ts, ts) - 1
        if bbo_index < 0:
            continue
        bbo = bbo_samples[bbo_index]
        side = _aggressor_side(record, price=price, bbo=bbo)
        if side is None:
            continue
        if side == "buy":
            slippage = max(0.0, price - bbo.ask_px)
        else:
            slippage = max(0.0, bbo.bid_px - price)
        spread_ticks = max(0, round((bbo.ask_px - bbo.bid_px) / TICK_SIZE_POINTS))
        aggregates.add(
            split,
            _marketable_bucket_id(
                side=side,
                spread_bucket=_spread_bucket(spread_ticks),
                session_phase=_session_phase(ts, start_ts_ns, end_ts_ns),
                volatility_regime=_volatility_regime(spread_ticks),
            ),
            _round6(slippage),
        )
        observation_count += 1
    return observation_count


def _read_limit_observations(
    *,
    session: dict[str, Any],
    split: SplitName,
    aggregates: LimitAggregates,
    mbo_path: Path,
) -> int:
    session_id = str(session["session_id"])
    levels: dict[tuple[str, int], LevelState] = defaultdict(LevelState)
    orders: dict[int, OpenOrder] = {}
    observation_count = 0

    for record in _iter_records(mbo_path, "mbo"):
        ts = _int_field(record, "ts_event")
        order_id = _int_field(record, "order_id")
        price = _fixed_price_int(record.get("price"))
        size = _int_field(record, "size") or 0
        action = _str_field(record, "action")
        side = _book_side(record)
        if ts is None or order_id is None or action is None:
            continue

        if action == "A" and side is not None and price is not None and size > 0:
            level = levels[(side, price)]
            orders[order_id] = OpenOrder(
                order_id=order_id,
                side=side,
                price=price,
                size=size,
                add_ts_ns=ts,
                queue_ahead_size=level.total_size,
                queue_ahead_order_count=level.order_count,
                session_id=session_id,
                split=split,
            )
            level.total_size += size
            level.order_count += 1
            continue

        order = orders.get(order_id)
        if order is None:
            continue

        if action == "T":
            aggregates.add(
                split=split,
                queue_bucket=_queue_bucket(order.queue_ahead_size),
                filled=True,
                time_to_fill_ms=max(0.0, (ts - order.add_ts_ns) / 1_000_000),
            )
            observation_count += 1
            _remove_order(orders, levels, order_id, min(order.size, max(1, size)))
            continue

        if action == "C":
            aggregates.add(
                split=split,
                queue_bucket=_queue_bucket(order.queue_ahead_size),
                filled=False,
                time_to_fill_ms=None,
            )
            observation_count += 1
            _remove_order(orders, levels, order_id, order.size)
            continue

        if action == "M" and size > 0:
            level = levels[(order.side, order.price)]
            level.total_size += size - order.size
            order.size = size

    for order_id in sorted(orders):
        order = orders[order_id]
        aggregates.add(
            split=split,
            queue_bucket=_queue_bucket(order.queue_ahead_size),
            filled=False,
            time_to_fill_ms=None,
        )
        observation_count += 1
    return observation_count


def _remove_order(
    orders: dict[int, OpenOrder],
    levels: dict[tuple[str, int], LevelState],
    order_id: int,
    removed_size: int,
) -> None:
    order = orders.get(order_id)
    if order is None:
        return
    level = levels[(order.side, order.price)]
    level.total_size = max(0, level.total_size - removed_size)
    if removed_size >= order.size:
        level.order_count = max(0, level.order_count - 1)
        del orders[order_id]
    else:
        order.size -= removed_size


def _score_marketable(
    observations: MarketableAggregates,
    *,
    min_bucket_sample: int,
) -> dict[str, Any]:
    calibration_values = observations.all_values_by_split["calibration"]
    validation_values = observations.all_values_by_split["validation"]
    bucket_ids = sorted(observations.bucket_ids)
    if not bucket_ids:
        bucket_ids = ["all"]
    bucket_residuals: list[dict[str, Any]] = []
    fitted_constants: dict[str, Any] = {}
    insufficient: list[dict[str, Any]] = []
    for bucket_id in bucket_ids:
        cal_bucket = observations.bucket_values_by_split["calibration"].get(bucket_id, [])
        val_bucket = observations.bucket_values_by_split["validation"].get(bucket_id, [])
        if len(cal_bucket) < min_bucket_sample or len(val_bucket) < min_bucket_sample:
            model_values = calibration_values
            empirical_values = validation_values
            aggregation = "all_marketable_buckets"
        else:
            model_values = cal_bucket
            empirical_values = val_bucket
            aggregation = "exact_stratification_bucket"
        residual = _marketable_residual(
            bucket_id,
            model_values,
            empirical_values,
            min_bucket_sample,
            aggregation,
        )
        bucket_residuals.append(residual)
        if residual["status"] == "insufficient_sample":
            insufficient.append(residual)
        fitted_constants[bucket_id] = _marketable_constants(model_values)
    failures = _residual_failures("marketable_slippage", bucket_residuals)
    return {
        "fitted_constants": fitted_constants,
        "residuals": bucket_residuals,
        "insufficient_sample_buckets": insufficient,
        "failure_reasons": failures,
    }


def _marketable_residual(
    bucket_id: str,
    model_values: ValueDistribution,
    validation_values: ValueDistribution,
    min_bucket_sample: int,
    aggregation: str,
) -> dict[str, Any]:
    if len(model_values) < min_bucket_sample or len(validation_values) < min_bucket_sample:
        return {
            "bucket_id": bucket_id,
            "dimensions": _marketable_bucket_dimensions(bucket_id),
            "aggregation": aggregation,
            "status": "insufficient_sample",
            "calibration_sample_count": len(model_values),
            "validation_sample_count": len(validation_values),
            "failure_reasons": ["not enough samples after aggregation"],
        }
    empirical_p50 = _percentile(validation_values, 50) or 0.0
    empirical_p90 = _percentile(validation_values, 90) or 0.0
    empirical_p95 = _percentile(validation_values, 95) or 0.0
    modeled_p50 = _percentile(model_values, 50) or 0.0
    modeled_p90 = _percentile(model_values, 90) or 0.0
    modeled_p95 = _percentile(model_values, 95) or 0.0
    ks = _ks_statistic(model_values, validation_values)
    p50_residual = abs(modeled_p50 - empirical_p50)
    p90_residual = abs(modeled_p90 - empirical_p90)
    p95_residual = abs(modeled_p95 - empirical_p95)
    p50_threshold = max(TICK_SIZE_POINTS * 0.25, abs(empirical_p50) * 0.20)
    p90_threshold = max(TICK_SIZE_POINTS * 0.50, abs(empirical_p90) * 0.25)
    p95_threshold = max(TICK_SIZE_POINTS * 0.50, abs(empirical_p95) * 0.25)
    checks = {
        "ks_pass": ks <= DEFAULT_KS_THRESHOLD,
        "p50_pass": p50_residual <= p50_threshold,
        "p90_pass": p90_residual <= p90_threshold,
        "adverse_p95_pass": p95_residual <= p95_threshold,
    }
    return {
        "bucket_id": bucket_id,
        "dimensions": _marketable_bucket_dimensions(bucket_id),
        "aggregation": aggregation,
        "status": "pass" if all(checks.values()) else "fail",
        "calibration_sample_count": len(model_values),
        "validation_sample_count": len(validation_values),
        "ks_statistic": _round6(ks),
        "ks_threshold": DEFAULT_KS_THRESHOLD,
        "modeled_p50": _round6(modeled_p50),
        "empirical_p50": _round6(empirical_p50),
        "p50_residual": _round6(p50_residual),
        "p50_threshold": _round6(p50_threshold),
        "modeled_p90": _round6(modeled_p90),
        "empirical_p90": _round6(empirical_p90),
        "p90_residual": _round6(p90_residual),
        "p90_threshold": _round6(p90_threshold),
        "modeled_adverse_p95": _round6(modeled_p95),
        "empirical_adverse_p95": _round6(empirical_p95),
        "adverse_p95_residual": _round6(p95_residual),
        "adverse_p95_threshold": _round6(p95_threshold),
        "checks": checks,
        "failure_reasons": [name for name, passed in checks.items() if not passed],
    }


def _marketable_constants(values: ValueDistribution) -> dict[str, Any]:
    return {
        "base_slippage_points": _round6(_percentile(values, 50) or 0.0),
        "adverse_extra_tick_probability": _round6(
            values.count_at_or_above(TICK_SIZE_POINTS) / len(values)
            if len(values) > 0
            else 0.0
        ),
        "empirical_distribution_points": _distribution_summary(values),
        "sample_count": len(values),
    }


def _score_limit_queue(
    observations: LimitAggregates,
    *,
    min_bucket_sample: int,
) -> dict[str, Any]:
    calibration = observations.all_by_split["calibration"]
    validation = observations.all_by_split["validation"]
    buckets = sorted({_queue_sort_key(bucket) for bucket in observations.bucket_names})
    bucket_names = [_queue_bucket_name(key) for key in buckets]
    residuals: list[dict[str, Any]] = []
    fitted: dict[str, Any] = {}
    insufficient: list[dict[str, Any]] = []
    for bucket in bucket_names:
        cal_bucket = observations.bucket_by_split["calibration"].get(bucket, LimitBucketAggregate())
        val_bucket = observations.bucket_by_split["validation"].get(bucket, LimitBucketAggregate())
        if cal_bucket.total_count < min_bucket_sample or val_bucket.total_count < min_bucket_sample:
            cal_bucket = calibration
            val_bucket = validation
            aggregation = "all_queue_buckets"
        else:
            aggregation = "exact_queue_bucket"
        residual = _limit_residual(bucket, cal_bucket, val_bucket, min_bucket_sample, aggregation)
        residuals.append(residual)
        if residual["status"] == "insufficient_sample":
            insufficient.append(residual)
        fitted[bucket] = _limit_constants(cal_bucket)

    if not residuals:
        residuals.append(_limit_residual("all", calibration, validation, min_bucket_sample, "all_queue_buckets"))
        fitted["all"] = _limit_constants(calibration)

    return {
        "fitted_constants": fitted,
        "residuals": residuals,
        "insufficient_sample_buckets": insufficient,
        "failure_reasons": _residual_failures("limit_queue", residuals),
    }


def _limit_residual(
    bucket_id: str,
    calibration: LimitBucketAggregate,
    validation: LimitBucketAggregate,
    min_bucket_sample: int,
    aggregation: str,
) -> dict[str, Any]:
    if calibration.total_count < min_bucket_sample or validation.total_count < min_bucket_sample:
        return {
            "bucket_id": bucket_id,
            "aggregation": aggregation,
            "status": "insufficient_sample",
            "calibration_sample_count": calibration.total_count,
            "validation_sample_count": validation.total_count,
            "failure_reasons": ["not enough queue samples after aggregation"],
        }
    cal_fill_rate = _fill_rate(calibration)
    val_fill_rate = _fill_rate(validation)
    cal_no_fill_rate = 1.0 - cal_fill_rate
    val_no_fill_rate = 1.0 - val_fill_rate
    cal_median_ttf = calibration.time_to_fill_ms.median()
    val_median_ttf = validation.time_to_fill_ms.median()
    fill_residual = abs(cal_fill_rate - val_fill_rate)
    no_fill_residual = abs(cal_no_fill_rate - val_no_fill_rate)
    if cal_median_ttf is None or val_median_ttf is None:
        ttf_relative_error = math.inf
    else:
        ttf_relative_error = abs(cal_median_ttf - val_median_ttf) / max(1.0, val_median_ttf)
    checks = {
        "fill_probability_pass": fill_residual <= DEFAULT_FILL_RATE_RESIDUAL_THRESHOLD,
        "time_to_fill_pass": ttf_relative_error <= DEFAULT_TIME_TO_FILL_RELATIVE_THRESHOLD,
        "no_fill_rate_pass": no_fill_residual <= DEFAULT_NO_FILL_RATE_RESIDUAL_THRESHOLD,
    }
    return {
        "bucket_id": bucket_id,
        "aggregation": aggregation,
        "status": "pass" if all(checks.values()) else "fail",
        "calibration_sample_count": calibration.total_count,
        "validation_sample_count": validation.total_count,
        "modeled_fill_probability": _round6(cal_fill_rate),
        "empirical_fill_probability": _round6(val_fill_rate),
        "fill_probability_residual": _round6(fill_residual),
        "fill_probability_threshold": DEFAULT_FILL_RATE_RESIDUAL_THRESHOLD,
        "modeled_no_fill_rate": _round6(cal_no_fill_rate),
        "empirical_no_fill_rate": _round6(val_no_fill_rate),
        "no_fill_rate_residual": _round6(no_fill_residual),
        "no_fill_rate_threshold": DEFAULT_NO_FILL_RATE_RESIDUAL_THRESHOLD,
        "modeled_time_to_fill_median_ms": _round_nullable(cal_median_ttf),
        "empirical_time_to_fill_median_ms": _round_nullable(val_median_ttf),
        "time_to_fill_relative_error": _round_nullable(ttf_relative_error),
        "time_to_fill_relative_threshold": DEFAULT_TIME_TO_FILL_RELATIVE_THRESHOLD,
        "checks": checks,
        "failure_reasons": [name for name, passed in checks.items() if not passed],
    }


def _score_strategy_cost(
    observations: MarketableAggregates,
    min_bucket_sample: int,
) -> dict[str, Any]:
    calibration = observations.all_values_by_split["calibration"]
    validation = observations.all_values_by_split["validation"]
    if len(calibration) < min_bucket_sample or len(validation) < min_bucket_sample:
        residual = {
            "strategy_id": "sim03_proxy_all",
            "status": "insufficient_sample",
            "calibration_sample_count": len(calibration),
            "validation_sample_count": len(validation),
            "failure_reasons": ["not enough strategy-cost proxy samples"],
        }
    else:
        modeled_mean = calibration.mean() or 0.0
        empirical_mean = validation.mean() or 0.0
        empirical_mean_abs = validation.mean_abs() or 0.0
        threshold = max(TICK_SIZE_POINTS * 0.25, empirical_mean_abs * 0.15)
        diff = abs(modeled_mean - empirical_mean)
        residual = {
            "strategy_id": "sim03_proxy_all",
            "status": "pass" if diff <= threshold else "fail",
            "calibration_sample_count": len(calibration),
            "validation_sample_count": len(validation),
            "modeled_mean_slippage_points": _round6(modeled_mean),
            "empirical_mean_slippage_points": _round6(empirical_mean),
            "mean_residual": _round6(diff),
            "threshold": _round6(threshold),
            "failure_reasons": [] if diff <= threshold else ["strategy_mean_slippage_pass"],
        }
    return {
        "residuals": [residual],
        "insufficient_sample_buckets": [] if residual["status"] != "insufficient_sample" else [residual],
        "failure_reasons": _residual_failures("strategy_level_cost", [residual]),
    }


def _limit_constants(observations: LimitBucketAggregate) -> dict[str, Any]:
    fill_rate = _fill_rate(observations)
    median_ttf = observations.time_to_fill_ms.median()
    return {
        "fill_probability": _round6(fill_rate),
        "no_fill_probability": _round6(1.0 - fill_rate),
        "median_time_to_fill_ms": _round_nullable(median_ttf),
        "sample_count": observations.total_count,
    }


def _distribution_summary(values: ValueDistribution) -> dict[str, Any]:
    return {
        "count": len(values),
        "p50": _round_nullable(_percentile(values, 50)),
        "p90": _round_nullable(_percentile(values, 90)),
        "p95": _round_nullable(_percentile(values, 95)),
        "mean": _round_nullable(values.mean()),
    }


def _iter_records(path: Path, schema: str) -> Iterator[dict[str, Any]]:
    if path.suffix == ".jsonl":
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    record = json.loads(line)
                    if isinstance(record, dict):
                        yield record
        return
    if path.suffix == ".json":
        raw = json.loads(path.read_text(encoding="utf-8"))
        records = raw if isinstance(raw, list) else raw.get("records", []) if isinstance(raw, dict) else []
        for record in records:
            if isinstance(record, dict):
                yield record
        return

    import databento as db  # type: ignore[import-not-found]

    store = db.DBNStore.from_file(path)
    for chunk in store.to_ndarray(schema=schema, count=DBN_CHUNK_RECORDS):
        names = chunk.dtype.names or ()
        for row in chunk:
            yield {name: row[name].item() if hasattr(row[name], "item") else row[name] for name in names}


def _aggressor_side(
    record: dict[str, Any],
    *,
    price: float,
    bbo: BboSample,
) -> Literal["buy", "sell"] | None:
    if price >= bbo.ask_px:
        return "buy"
    if price <= bbo.bid_px:
        return "sell"
    side = _str_field(record, "side")
    if side == "A":
        return "buy"
    if side == "B":
        return "sell"
    return None


def _book_side(record: dict[str, Any]) -> str | None:
    side = _str_field(record, "side")
    if side == "A":
        return "ask"
    if side == "B":
        return "bid"
    return None


def _marketable_bucket_id(
    *,
    side: Literal["buy", "sell"],
    spread_bucket: str,
    session_phase: str,
    volatility_regime: str,
) -> str:
    return "|".join(
        [
            "order_type=marketable",
            f"side={side}",
            f"spread_bucket={spread_bucket}",
            f"session_phase={session_phase}",
            f"volatility_regime={volatility_regime}",
        ]
    )


def _marketable_bucket_dimensions(bucket_id: str) -> dict[str, str]:
    if bucket_id == "all":
        return {
            "order_type": "marketable",
            "side": "all",
            "spread_bucket": "all",
            "session_phase": "all",
            "volatility_regime": "all",
        }
    dimensions: dict[str, str] = {}
    for part in bucket_id.split("|"):
        if "=" in part:
            key, value = part.split("=", 1)
            dimensions[key] = value
    return dimensions


def _spread_bucket(spread_ticks: int) -> str:
    if spread_ticks <= 1:
        return "one_tick"
    if spread_ticks == 2:
        return "two_ticks"
    return "wide"


def _volatility_regime(spread_ticks: int) -> str:
    return "normal" if spread_ticks <= 1 else "elevated"


def _session_phase(ts_ns: int, start_ts_ns: int, end_ts_ns: int) -> str:
    duration = max(1, end_ts_ns - start_ts_ns)
    offset = ts_ns - start_ts_ns
    if offset <= 30 * 60 * 1_000_000_000:
        return "open"
    if end_ts_ns - ts_ns <= 30 * 60 * 1_000_000_000:
        return "close"
    if offset / duration < 0.5:
        return "early_mid"
    return "late_mid"


def _queue_bucket(queue_ahead_size: int) -> str:
    if queue_ahead_size <= 0:
        return "front"
    if queue_ahead_size <= 5:
        return "near"
    if queue_ahead_size <= 20:
        return "middle"
    return "back"


def _queue_sort_key(name: str) -> int:
    return {"front": 0, "near": 1, "middle": 2, "back": 3}.get(name, 99)


def _queue_bucket_name(key: int) -> str:
    return {0: "front", 1: "near", 2: "middle", 3: "back"}.get(key, "unknown")


def _fill_rate(observations: LimitBucketAggregate) -> float:
    if observations.total_count <= 0:
        return 0.0
    return observations.fill_count / observations.total_count


def _ks_statistic(left: ValueDistribution, right: ValueDistribution) -> float:
    values = sorted(set(left.counts) | set(right.counts))
    if not values or left.total_count <= 0 or right.total_count <= 0:
        return 0.0
    max_delta = 0.0
    left_seen = 0
    right_seen = 0
    for value in values:
        left_seen += left.counts.get(value, 0)
        right_seen += right.counts.get(value, 0)
        max_delta = max(
            max_delta,
            abs(left_seen / left.total_count - right_seen / right.total_count),
        )
    return max_delta


def _percentile(values: list[float] | ValueDistribution, percentile: float) -> float | None:
    if not values:
        return None
    if isinstance(values, ValueDistribution):
        if values.total_count == 1:
            return _distribution_value_at_index(values, 0)
        rank = (percentile / 100) * (values.total_count - 1)
        lower = math.floor(rank)
        upper = math.ceil(rank)
        if lower == upper:
            return _distribution_value_at_index(values, int(rank))
        weight = rank - lower
        lower_value = _distribution_value_at_index(values, lower)
        upper_value = _distribution_value_at_index(values, upper)
        return lower_value * (1 - weight) + upper_value * weight
    sorted_values = sorted(values)
    if len(sorted_values) == 1:
        return sorted_values[0]
    rank = (percentile / 100) * (len(sorted_values) - 1)
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return sorted_values[int(rank)]
    weight = rank - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def _distribution_value_at_index(values: ValueDistribution, index: int) -> float:
    if index < 0 or index >= values.total_count:
        raise IndexError("distribution index out of range")
    seen = 0
    for value in sorted(values.counts):
        seen += values.counts[value]
        if index < seen:
            return value
    raise IndexError("distribution index out of range")


def _median(values: list[float]) -> float | None:
    return _percentile(values, 50)


def _residual_failures(prefix: str, residuals: list[dict[str, Any]]) -> list[str]:
    failures: list[str] = []
    for residual in residuals:
        if residual["status"] == "fail":
            failures.append(f"{prefix}:{residual.get('bucket_id', residual.get('strategy_id'))}:failed thresholds")
        elif residual["status"] == "insufficient_sample":
            failures.append(f"{prefix}:{residual.get('bucket_id', residual.get('strategy_id'))}:insufficient_sample")
    return failures


def _eligible_source_sessions(
    manifest: dict[str, Any],
    verified_session_ids: set[str],
) -> list[dict[str, Any]]:
    sessions = []
    for session in manifest.get("sessions", []):
        if not isinstance(session, dict):
            continue
        if session.get("session_id") in verified_session_ids and session.get("status") == "complete":
            sessions.append(session)
    sessions.sort(key=lambda item: str(item.get("session_id")))
    return sessions


def _verified_session_ids(verified_report: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for session in verified_report.get("sessions", []):
        if isinstance(session, dict) and session.get("status") == "verified":
            ids.add(str(session.get("session_id")))
    return ids


def _validate_lineage(
    *,
    manifest: dict[str, Any],
    verified_report: dict[str, Any],
    thresholds: dict[str, Any],
    manifest_hash: str,
    thresholds_hash: str,
) -> None:
    if manifest.get("manifest_schema_version") != SUPPORTED_MANIFEST_SCHEMA_VERSION:
        raise ValueError("unsupported manifest_schema_version")
    if verified_report.get("verified_report_schema_version") != SUPPORTED_VERIFIED_REPORT_SCHEMA_VERSION:
        raise ValueError("unsupported verified_report_schema_version")
    if thresholds.get("thresholds_schema_version") != SUPPORTED_THRESHOLDS_SCHEMA_VERSION:
        raise ValueError("unsupported thresholds_schema_version")
    if manifest.get("ready_for_sim03_model_fitting") is not True:
        raise ValueError("manifest is not ready_for_sim03_model_fitting")
    if verified_report.get("ready_for_sim03_model_fitting") is not True:
        raise ValueError("verified report is not ready_for_sim03_model_fitting")
    if verified_report.get("source_manifest_hash") != manifest_hash:
        raise ValueError("manifest hash does not match verified report source_manifest_hash")
    if verified_report.get("thresholds_config_hash") != thresholds_hash:
        raise ValueError("thresholds hash does not match verified report thresholds_config_hash")


def _session_split(session: dict[str, Any]) -> Literal["calibration", "validation"]:
    split = session.get("split")
    if split not in {"calibration", "validation"}:
        raise ValueError(f"session {session.get('session_id')} has unsupported split {split}")
    return split  # type: ignore[return-value]


def _int_field(record: dict[str, Any], name: str) -> int | None:
    value = record.get(name)
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("ascii")
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _str_field(record: dict[str, Any], name: str) -> str | None:
    value = record.get(name)
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("ascii")
    if isinstance(value, str):
        return value
    return str(value)


def _fixed_price_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("ascii")
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _price_field(record: dict[str, Any], name: str) -> float | None:
    value = record.get(name)
    if isinstance(value, float):
        return value
    if isinstance(value, str) and "." in value:
        try:
            return float(value)
        except ValueError:
            return None
    fixed = _fixed_price_int(value)
    if fixed is not None:
        return fixed / 1_000_000_000
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _round6(value: float) -> float:
    if not math.isfinite(value):
        return value
    return round(value, 6)


def _round_nullable(value: float | None) -> float | None:
    if value is None:
        return None
    if not math.isfinite(value):
        return None
    return _round6(value)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return raw


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_markdown(path: Path, report: dict[str, Any]) -> None:
    lines = [
        "# SIM-03 Fill/Slippage Calibration",
        "",
        f"- Status: `{report['status']}`",
        f"- Fitter: `{report['simulated_execution_fitter_version']}`",
        f"- Ready for REL-01 execution simulation: `{str(report['ready_for_rel01_execution_simulation']).lower()}`",
        f"- Calibration sessions: `{report['corpus_summary']['calibration_sessions']}`",
        f"- Validation sessions: `{report['corpus_summary']['validation_sessions']}`",
        f"- Marketable observations: `{report['corpus_summary']['marketable_observations']}`",
        f"- Limit observations: `{report['corpus_summary']['limit_observations']}`",
        "",
        "## Failure Reasons",
        "",
    ]
    failures = report.get("failure_reasons", [])
    if failures:
        lines.extend(f"- `{reason}`" for reason in failures)
    else:
        lines.append("- None")
    lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _validate_timestamp_ns(value: str) -> str:
    if not value.isdecimal():
        raise ValueError("--calibrated-at-ts-ns must be a non-negative integer string")
    return value


class StrictArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(message)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = StrictArgumentParser(description="Fit and score SIM-03 fill/slippage calibration.")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--verified-report", required=True, type=Path)
    parser.add_argument("--thresholds", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--calibrated-at-ts-ns", required=True)
    parser.add_argument("--markdown-out", type=Path)
    parser.add_argument("--min-bucket-sample", type=int, default=DEFAULT_MIN_BUCKET_SAMPLE)
    return parser.parse_args(argv)


def request_from_args(args: argparse.Namespace) -> CalibrationRequest:
    if args.min_bucket_sample <= 0:
        raise ValueError("--min-bucket-sample must be positive")
    return CalibrationRequest(
        manifest_path=args.manifest,
        verified_report_path=args.verified_report,
        thresholds_path=args.thresholds,
        out_path=args.out,
        calibrated_at_ts_ns=_validate_timestamp_ns(str(args.calibrated_at_ts_ns)),
        markdown_out_path=args.markdown_out,
        min_bucket_sample=int(args.min_bucket_sample),
    )


def main(argv: list[str]) -> int:
    report = calibrate(request_from_args(parse_args(argv)))
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
