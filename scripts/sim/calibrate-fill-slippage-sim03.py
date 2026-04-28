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
from collections import defaultdict
from dataclasses import dataclass
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


@dataclass(frozen=True)
class MarketableObservation:
    session_id: str
    split: Literal["calibration", "validation"]
    side: Literal["buy", "sell"]
    spread_bucket: str
    session_phase: str
    volatility_regime: str
    slippage_points: float


@dataclass(frozen=True)
class LimitObservation:
    session_id: str
    split: Literal["calibration", "validation"]
    side: str
    queue_bucket: str
    session_phase: str
    filled: bool
    time_to_fill_ms: float | None


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

    marketable_observations: list[MarketableObservation] = []
    limit_observations: list[LimitObservation] = []
    reader_diagnostics: list[dict[str, Any]] = []
    for session in source_sessions:
        session_marketable, session_limits, diagnostics = _read_session_observations(session)
        marketable_observations.extend(session_marketable)
        limit_observations.extend(session_limits)
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
            "marketable_observations": len(marketable_observations),
            "limit_observations": len(limit_observations),
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
) -> tuple[list[MarketableObservation], list[LimitObservation], dict[str, Any]]:
    session_id = str(session["session_id"])
    split = _session_split(session)
    schemas = session.get("schemas", {})
    bbo_samples = _read_bbo_samples(Path(str(schemas["mbp-1"]["path"])))
    marketable = _read_marketable_observations(
        session=session,
        split=split,
        bbo_samples=bbo_samples,
        trades_path=Path(str(schemas["trades"]["path"])),
    )
    limits = _read_limit_observations(
        session=session,
        split=split,
        mbo_path=Path(str(schemas["mbo"]["path"])),
    )
    return (
        marketable,
        limits,
        {
            "session_id": session_id,
            "split": split,
            "bbo_samples": len(bbo_samples),
            "marketable_observations": len(marketable),
            "limit_observations": len(limits),
        },
    )


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
    split: Literal["calibration", "validation"],
    bbo_samples: list[BboSample],
    trades_path: Path,
) -> list[MarketableObservation]:
    if not bbo_samples:
        return []
    bbo_ts = [sample.ts_event_ns for sample in bbo_samples]
    observations: list[MarketableObservation] = []
    session_id = str(session["session_id"])
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
        observations.append(
            MarketableObservation(
                session_id=session_id,
                split=split,
                side=side,
                spread_bucket=_spread_bucket(spread_ticks),
                session_phase=_session_phase(ts, start_ts_ns, end_ts_ns),
                volatility_regime=_volatility_regime(spread_ticks),
                slippage_points=_round6(slippage),
            )
        )
    return observations


def _read_limit_observations(
    *,
    session: dict[str, Any],
    split: Literal["calibration", "validation"],
    mbo_path: Path,
) -> list[LimitObservation]:
    session_id = str(session["session_id"])
    start_ts_ns = int(session["rth_window"]["start_ts_ns"])
    end_ts_ns = int(session["rth_window"]["end_ts_ns"])
    levels: dict[tuple[str, int], LevelState] = defaultdict(LevelState)
    orders: dict[int, OpenOrder] = {}
    observations: list[LimitObservation] = []

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
            observations.append(
                LimitObservation(
                    session_id=session_id,
                    split=split,
                    side=order.side,
                    queue_bucket=_queue_bucket(order.queue_ahead_size),
                    session_phase=_session_phase(order.add_ts_ns, start_ts_ns, end_ts_ns),
                    filled=True,
                    time_to_fill_ms=max(0.0, (ts - order.add_ts_ns) / 1_000_000),
                )
            )
            _remove_order(orders, levels, order_id, min(order.size, max(1, size)))
            continue

        if action == "C":
            observations.append(
                LimitObservation(
                    session_id=session_id,
                    split=split,
                    side=order.side,
                    queue_bucket=_queue_bucket(order.queue_ahead_size),
                    session_phase=_session_phase(order.add_ts_ns, start_ts_ns, end_ts_ns),
                    filled=False,
                    time_to_fill_ms=None,
                )
            )
            _remove_order(orders, levels, order_id, order.size)
            continue

        if action == "M" and size > 0:
            level = levels[(order.side, order.price)]
            level.total_size += size - order.size
            order.size = size

    for order_id in sorted(orders):
        order = orders[order_id]
        observations.append(
            LimitObservation(
                session_id=session_id,
                split=split,
                side=order.side,
                queue_bucket=_queue_bucket(order.queue_ahead_size),
                session_phase=_session_phase(order.add_ts_ns, start_ts_ns, end_ts_ns),
                filled=False,
                time_to_fill_ms=None,
            )
        )
    return observations


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
    observations: list[MarketableObservation],
    *,
    min_bucket_sample: int,
) -> dict[str, Any]:
    calibration = [obs for obs in observations if obs.split == "calibration"]
    validation = [obs for obs in observations if obs.split == "validation"]
    calibration_values = [obs.slippage_points for obs in calibration]
    validation_values = [obs.slippage_points for obs in validation]
    bucket_ids = sorted({_marketable_bucket_id(obs) for obs in observations})
    if not bucket_ids:
        bucket_ids = ["all"]
    bucket_residuals: list[dict[str, Any]] = []
    fitted_constants: dict[str, Any] = {}
    insufficient: list[dict[str, Any]] = []
    for bucket_id in bucket_ids:
        cal_bucket = [obs.slippage_points for obs in calibration if _marketable_bucket_id(obs) == bucket_id]
        val_bucket = [obs.slippage_points for obs in validation if _marketable_bucket_id(obs) == bucket_id]
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
    model_values: list[float],
    validation_values: list[float],
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


def _marketable_constants(values: list[float]) -> dict[str, Any]:
    return {
        "base_slippage_points": _round6(_percentile(values, 50) or 0.0),
        "adverse_extra_tick_probability": _round6(
            sum(1 for value in values if value >= TICK_SIZE_POINTS) / len(values)
            if values
            else 0.0
        ),
        "empirical_distribution_points": _distribution_summary(values),
        "sample_count": len(values),
    }


def _score_limit_queue(
    observations: list[LimitObservation],
    *,
    min_bucket_sample: int,
) -> dict[str, Any]:
    calibration = [obs for obs in observations if obs.split == "calibration"]
    validation = [obs for obs in observations if obs.split == "validation"]
    buckets = sorted({_queue_sort_key(obs.queue_bucket) for obs in observations})
    bucket_names = [_queue_bucket_name(key) for key in buckets]
    residuals: list[dict[str, Any]] = []
    fitted: dict[str, Any] = {}
    insufficient: list[dict[str, Any]] = []
    for bucket in bucket_names:
        cal_bucket = [obs for obs in calibration if obs.queue_bucket == bucket]
        val_bucket = [obs for obs in validation if obs.queue_bucket == bucket]
        if len(cal_bucket) < min_bucket_sample or len(val_bucket) < min_bucket_sample:
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
    calibration: list[LimitObservation],
    validation: list[LimitObservation],
    min_bucket_sample: int,
    aggregation: str,
) -> dict[str, Any]:
    if len(calibration) < min_bucket_sample or len(validation) < min_bucket_sample:
        return {
            "bucket_id": bucket_id,
            "aggregation": aggregation,
            "status": "insufficient_sample",
            "calibration_sample_count": len(calibration),
            "validation_sample_count": len(validation),
            "failure_reasons": ["not enough queue samples after aggregation"],
        }
    cal_fill_rate = _fill_rate(calibration)
    val_fill_rate = _fill_rate(validation)
    cal_no_fill_rate = 1.0 - cal_fill_rate
    val_no_fill_rate = 1.0 - val_fill_rate
    cal_median_ttf = _median([obs.time_to_fill_ms for obs in calibration if obs.time_to_fill_ms is not None])
    val_median_ttf = _median([obs.time_to_fill_ms for obs in validation if obs.time_to_fill_ms is not None])
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
        "calibration_sample_count": len(calibration),
        "validation_sample_count": len(validation),
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
    observations: list[MarketableObservation],
    min_bucket_sample: int,
) -> dict[str, Any]:
    calibration = [obs.slippage_points for obs in observations if obs.split == "calibration"]
    validation = [obs.slippage_points for obs in observations if obs.split == "validation"]
    if len(calibration) < min_bucket_sample or len(validation) < min_bucket_sample:
        residual = {
            "strategy_id": "sim03_proxy_all",
            "status": "insufficient_sample",
            "calibration_sample_count": len(calibration),
            "validation_sample_count": len(validation),
            "failure_reasons": ["not enough strategy-cost proxy samples"],
        }
    else:
        modeled_mean = sum(calibration) / len(calibration)
        empirical_mean = sum(validation) / len(validation)
        empirical_mean_abs = sum(abs(value) for value in validation) / len(validation)
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


def _limit_constants(observations: list[LimitObservation]) -> dict[str, Any]:
    fill_rate = _fill_rate(observations)
    median_ttf = _median([obs.time_to_fill_ms for obs in observations if obs.time_to_fill_ms is not None])
    return {
        "fill_probability": _round6(fill_rate),
        "no_fill_probability": _round6(1.0 - fill_rate),
        "median_time_to_fill_ms": _round_nullable(median_ttf),
        "sample_count": len(observations),
    }


def _distribution_summary(values: list[float]) -> dict[str, Any]:
    return {
        "count": len(values),
        "p50": _round_nullable(_percentile(values, 50)),
        "p90": _round_nullable(_percentile(values, 90)),
        "p95": _round_nullable(_percentile(values, 95)),
        "mean": _round_nullable(sum(values) / len(values) if values else None),
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


def _marketable_bucket_id(observation: MarketableObservation) -> str:
    return "|".join(
        [
            "order_type=marketable",
            f"side={observation.side}",
            f"spread_bucket={observation.spread_bucket}",
            f"session_phase={observation.session_phase}",
            f"volatility_regime={observation.volatility_regime}",
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


def _fill_rate(observations: list[LimitObservation]) -> float:
    if not observations:
        return 0.0
    return sum(1 for obs in observations if obs.filled) / len(observations)


def _ks_statistic(left: list[float], right: list[float]) -> float:
    left_sorted = sorted(left)
    right_sorted = sorted(right)
    values = sorted(set(left_sorted + right_sorted))
    if not values:
        return 0.0
    max_delta = 0.0
    left_index = 0
    right_index = 0
    for value in values:
        while left_index < len(left_sorted) and left_sorted[left_index] <= value:
            left_index += 1
        while right_index < len(right_sorted) and right_sorted[right_index] <= value:
            right_index += 1
        max_delta = max(max_delta, abs(left_index / len(left_sorted) - right_index / len(right_sorted)))
    return max_delta


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
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
