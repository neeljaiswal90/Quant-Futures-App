"""RA-096 empirical sweep-continuation research.

This module is read-only with respect to capture inputs. It replays the
shipping dashboard sweep detector over rolling windows so the research output
measures the detector operators actually see, while keeping detectors,
contracts, capture/probe code, schedulers, and live-stack wiring untouched.
"""

from __future__ import annotations

import importlib
import json
import math
import os
import subprocess
import time
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from datetime import time as datetime_time
from pathlib import Path
from typing import Any, Literal, cast

from rithmic_dashboard.data_sources import load_envelope
from rithmic_dashboard.features.live_signals import _trade_tick as dashboard_trade_tick
from rithmic_dashboard.features.live_signals import structural_levels
from rithmic_dashboard.features.sweep_detector import detect_sweeps
from rithmic_dashboard.models import SweepEvent, TradeTick
from rithmic_dashboard.session_state import PT

from scalp_models.canonical import canonical_json, sha256_file, sha256_text
from scalp_models.pipeline import (
    DEFAULT_ANALYTICS_ROOT,
    DEFAULT_DASHBOARD_ROOT,
    REPO_ROOT,
    PipelineSession,
    SessionName,
)

TickDirection = Literal["long", "short"]
SessionCompletenessStatus = Literal["complete", "partial", "missing"]

TICK_SIZE = 0.25
DEFAULT_HORIZONS_SECONDS = (1, 5, 15, 60, 300)
DEFAULT_OUT_ROOT = REPO_ROOT / "services" / "scalp_models" / "runs" / "research"
LABEL_CLI = REPO_ROOT / "apps" / "backtester" / "src" / "forward-return-labels" / "cli.ts"
LIVE_WRITE_STALE_SECONDS = 120
NANOSECONDS_PER_SECOND = 1_000_000_000
ROLLING_DETECTOR_TAIL_SECONDS = 360
RTH_RECORD_FLOOR = 400_000
GLOBEX_RECORD_FLOOR = 200_000
MAX_MID_SESSION_GAP_SECONDS = 60.0
BONFERRONI_TESTS = 25


class SweepResearchError(RuntimeError):
    """Raised when RA-096 cannot safely produce deterministic artifacts."""


@dataclass(frozen=True)
class SweepResearchConfig:
    sessions: tuple[PipelineSession, ...]
    analytics_root: Path = DEFAULT_ANALYTICS_ROOT
    dashboard_root: Path = DEFAULT_DASHBOARD_ROOT
    out_root: Path = DEFAULT_OUT_ROOT
    run_id: str | None = None
    horizons_seconds: tuple[int, ...] = DEFAULT_HORIZONS_SECONDS
    target_ticks: float = 4.0
    min_cell_samples: int = 30
    include_partial_sessions: bool = False
    allow_live_capture_contention: bool = False
    detector_step_seconds: int = 5
    tick_size: float = TICK_SIZE
    live_write_stale_seconds: int = LIVE_WRITE_STALE_SECONDS
    node_runner: str = "npx.cmd" if os.name == "nt" else "npx"


@dataclass(frozen=True)
class SessionCompleteness:
    session: PipelineSession
    status: SessionCompletenessStatus
    reasons: tuple[str, ...]
    obs01_path: Path
    zones_path: Path
    trade_count: int
    first_trade_pt: str | None
    last_trade_pt: str | None
    obs01_mtime_pt: str | None
    max_gap_seconds: float | None
    max_gap_start_pt: str | None
    max_gap_end_pt: str | None


@dataclass(frozen=True)
class EnrichedSweepEvent:
    event_key: str
    session: PipelineSession
    timestamp_ns: int
    timestamp_pt: str
    level_id: str
    level_text: str
    level_price: float
    level_type: str
    direction: Literal["up", "down"]
    normalized_direction: TickDirection
    event_price: float
    moved_ticks: float
    intensity_score: float
    recovered_within_5min: bool | None
    prior_same_level_sweeps_10m: int
    cluster_bucket: str
    moved_ticks_bucket: str
    time_bucket: str
    pre_sweep_cvd: int
    cvd_direction_aligned: bool | None
    cvd_abs: int
    cvd_abs_quartile: int | None
    aggressor_net: int
    aggressor_flow_aligned: bool | None
    aggressor_ratio: float | None
    aggressor_ratio_quartile: int | None
    footprint_imbalance_aligned: bool | None
    source_obs01: Path
    completeness_status: SessionCompletenessStatus
    completeness_reasons: tuple[str, ...]


@dataclass(frozen=True)
class LabelOutcome:
    horizon_seconds: int
    status: str
    realized_ticks: float | None
    mfe_ticks: float | None
    mae_ticks: float | None
    continued: bool | None
    reversed: bool | None


@dataclass(frozen=True)
class SweepResearchResult:
    run_dir: Path
    report_path: Path
    conditional_tables_path: Path
    sample_counts_path: Path
    sweep_events_path: Path
    scatter_path: Path
    manifest_path: Path


def run_sweep_research(config: SweepResearchConfig) -> SweepResearchResult:
    """Run RA-096 sweep-continuation research and write all acceptance artifacts."""

    if not config.sessions:
        raise SweepResearchError("at least one capture date/session pair is required")
    if config.detector_step_seconds <= 0:
        raise SweepResearchError("--detector-step-seconds must be positive")
    if not config.horizons_seconds:
        raise SweepResearchError("--horizons-seconds must include at least one horizon")

    run_id = config.run_id or _derive_run_id(config)
    run_dir = config.out_root / run_id
    if run_dir.exists():
        raise SweepResearchError(f"output run directory already exists: {run_dir}")
    run_dir.mkdir(parents=True, exist_ok=False)

    for session in config.sessions:
        _assert_capture_not_active(session, config)

    session_artifacts: list[dict[str, Any]] = []
    all_events: list[EnrichedSweepEvent] = []
    labels_by_key: dict[str, list[LabelOutcome]] = {}
    audits: list[SessionCompleteness] = []

    for session in config.sessions:
        session_dir = run_dir / "sessions" / session.key
        session_dir.mkdir(parents=True, exist_ok=True)
        artifacts = _process_session(config, session, session_dir)
        session_artifacts.append(cast(dict[str, Any], artifacts["manifest"]))
        audits.append(cast(SessionCompleteness, artifacts["audit"]))
        all_events.extend(cast(list[EnrichedSweepEvent], artifacts["events"]))
        labels_by_key.update(cast(dict[str, list[LabelOutcome]], artifacts["labels"]))

    events_path = run_dir / "sweep_events.jsonl"
    _write_sweep_events(events_path, all_events, labels_by_key)

    complete_events = [
        event for event in all_events if event.completeness_status == "complete"
    ]
    partial_events = [
        event for event in all_events if event.completeness_status != "complete"
    ]
    included_events = complete_events if not config.include_partial_sessions else all_events
    included_tables = _build_conditional_tables(
        events=included_events,
        labels_by_key=labels_by_key,
        config=config,
    )
    complete_tables = _build_conditional_tables(
        events=complete_events,
        labels_by_key=labels_by_key,
        config=config,
    )
    partial_tables = (
        _build_conditional_tables(
            events=partial_events,
            labels_by_key=labels_by_key,
            config=config,
        )
        if config.include_partial_sessions
        else None
    )
    sample_counts = _build_sample_counts(audits, all_events, labels_by_key, config)

    tables_path = run_dir / "conditional_tables.json"
    counts_path = run_dir / "sample_counts.json"
    report_path = run_dir / "sweep_research_report.md"
    scatter_path = run_dir / "scatter_intensity_vs_return.png"
    manifest_path = run_dir / "pipeline_manifest.json"
    tables_path.write_text(canonical_json(included_tables) + "\n", encoding="utf-8")
    counts_path.write_text(canonical_json(sample_counts) + "\n", encoding="utf-8")
    _write_scatter(scatter_path, included_events, labels_by_key)
    _write_report(
        report_path,
        config=config,
        audits=audits,
        all_events=all_events,
        complete_tables=complete_tables,
        included_tables=included_tables,
        partial_tables=partial_tables,
        sample_counts=sample_counts,
    )
    _write_manifest(
        manifest_path,
        config=config,
        run_id=run_id,
        run_dir=run_dir,
        session_artifacts=session_artifacts,
        outputs=(events_path, tables_path, counts_path, scatter_path, report_path),
    )
    return SweepResearchResult(
        run_dir=run_dir,
        report_path=report_path,
        conditional_tables_path=tables_path,
        sample_counts_path=counts_path,
        sweep_events_path=events_path,
        scatter_path=scatter_path,
        manifest_path=manifest_path,
    )


def wilson_interval(
    successes: int,
    total: int,
    *,
    z: float = 1.959963984540054,
) -> tuple[float, float]:
    """Return a Wilson score confidence interval for a binomial proportion."""

    if total <= 0:
        return (0.0, 0.0)
    p_hat = successes / total
    denominator = 1.0 + (z * z) / total
    center = (p_hat + (z * z) / (2.0 * total)) / denominator
    margin = (
        z
        * math.sqrt((p_hat * (1.0 - p_hat) / total) + (z * z) / (4.0 * total * total))
        / denominator
    )
    return (max(0.0, center - margin), min(1.0, center + margin))


def parse_horizons(value: str) -> tuple[int, ...]:
    horizons = tuple(int(part.strip()) for part in value.split(",") if part.strip())
    if not horizons or any(item <= 0 for item in horizons):
        raise SweepResearchError("--horizons-seconds must be comma-separated positive integers")
    return horizons


def _process_session(
    config: SweepResearchConfig,
    session: PipelineSession,
    session_dir: Path,
) -> dict[str, Any]:
    capture_dir = config.analytics_root / "data" / "captures" / session.capture_date
    obs01_path = capture_dir / f"MNQ_{session.session}.obs01.jsonl"
    mbo_path = capture_dir / f"MNQ_{session.session}.mbo.jsonl"
    zones_path = config.analytics_root / "data" / "zones" / (
        f"{session.capture_date}_MNQ_{session.session}.json"
    )
    ticks = _load_trade_ticks(obs01_path)
    audit = _audit_session(session, obs01_path, zones_path, ticks)
    envelope, envelope_path, warnings = load_envelope(
        zones_path,
        analytics_root=config.analytics_root,
        symbol="MNQ",
    )
    levels = structural_levels(envelope or {})
    raw_events = _detect_research_sweeps(
        ticks,
        levels,
        detector_step_seconds=config.detector_step_seconds,
    )
    events = _enrich_events(
        session=session,
        ticks=ticks,
        raw_events=raw_events,
        levels=levels,
        obs01_path=obs01_path,
        audit=audit,
        tick_size=config.tick_size,
    )
    _assign_session_quartiles(events)

    label_input = session_dir / "sweep_label_input.jsonl"
    labels_path = session_dir / "labels.jsonl"
    labels_manifest = session_dir / "labels.manifest.json"
    _write_label_input(label_input, session, events, obs01_path, mbo_path, config)
    _run_label_cli(
        config=config,
        dataset_path=label_input,
        trade_tape_path=obs01_path,
        labels_path=labels_path,
        manifest_path=labels_manifest,
    )
    labels = _load_labels(labels_path, config)
    manifest = {
        "capture_date": session.capture_date,
        "session": session.session,
        "obs01_path": str(obs01_path),
        "obs01_sha256": sha256_file(obs01_path) if obs01_path.exists() else None,
        "mbo_path": str(mbo_path) if mbo_path.exists() else None,
        "mbo_sha256": sha256_file(mbo_path) if mbo_path.exists() else None,
        "zones_path": str(envelope_path or zones_path),
        "zones_sha256": sha256_file(envelope_path or zones_path)
        if (envelope_path or zones_path).exists()
        else None,
        "label_input_path": str(label_input),
        "label_input_sha256": sha256_file(label_input),
        "labels_path": str(labels_path),
        "labels_sha256": sha256_file(labels_path),
        "labels_manifest_path": str(labels_manifest),
        "labels_manifest_sha256": sha256_file(labels_manifest),
        "trade_count": len(ticks),
        "detected_sweeps": len(events),
        "completeness": _audit_to_dict(audit),
        "detector": {
            "module": "rithmic_dashboard.features.sweep_detector.detect_sweeps",
            "rolling_step_seconds": config.detector_step_seconds,
            "rolling_tail_seconds": ROLLING_DETECTOR_TAIL_SECONDS,
            "structural_levels_count": len(levels),
            "warnings": [warning.message for warning in warnings],
            "lvn_hvn_note": (
                "LVN/HVN levels are not measured because structural_levels() excludes "
                "them from the shipping sweep detector whitelist."
            ),
        },
    }
    (session_dir / "session_manifest.json").write_text(
        canonical_json(manifest) + "\n",
        encoding="utf-8",
    )
    return {
        "manifest": manifest,
        "audit": audit,
        "events": events,
        "labels": labels,
    }


def _load_trade_ticks(path: Path) -> list[TradeTick]:
    if not path.exists():
        return []
    ticks: list[TradeTick] = []
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for raw in handle:
            if not raw.strip():
                continue
            try:
                row = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            tick = dashboard_trade_tick(row)
            if tick is not None and tick.timestamp_ns is not None:
                ticks.append(tick)
    return sorted(ticks, key=lambda tick: int(tick.timestamp_ns or 0))


def _detect_research_sweeps(
    ticks: list[TradeTick],
    levels: list[dict[str, Any]],
    *,
    detector_step_seconds: int,
) -> list[SweepEvent]:
    if not ticks or not levels:
        return []
    ordered = sorted(ticks, key=lambda tick: int(tick.timestamp_ns or 0))
    first_ts = int(ordered[0].timestamp_ns or 0)
    last_ts = int(ordered[-1].timestamp_ns or 0)
    step_ns = detector_step_seconds * NANOSECONDS_PER_SECOND
    tail_ns = ROLLING_DETECTOR_TAIL_SECONDS * NANOSECONDS_PER_SECOND
    start_index = 0
    end_index = 0
    target_ts = first_ts
    by_key: dict[str, SweepEvent] = {}
    while target_ts <= last_ts:
        while end_index < len(ordered) and int(ordered[end_index].timestamp_ns or 0) <= target_ts:
            end_index += 1
        cutoff = target_ts - tail_ns
        while start_index < end_index and int(ordered[start_index].timestamp_ns or 0) < cutoff:
            start_index += 1
        if end_index > start_index:
            for event in detect_sweeps(ordered[start_index:end_index], levels):
                key = _raw_event_key(event)
                existing = by_key.get(key)
                if existing is None or (
                    existing.recovered_within_5min is None
                    and event.recovered_within_5min is not None
                ):
                    by_key[key] = event
        target_ts += step_ns
    return sorted(by_key.values(), key=lambda event: int(event.timestamp_ns or 0))


def _enrich_events(
    *,
    session: PipelineSession,
    ticks: list[TradeTick],
    raw_events: list[SweepEvent],
    levels: list[dict[str, Any]],
    obs01_path: Path,
    audit: SessionCompleteness,
    tick_size: float,
) -> list[EnrichedSweepEvent]:
    by_ts = _ticks_by_ts(ticks)
    level_map = {str(level.get("level_id")): level for level in levels}
    enriched: list[EnrichedSweepEvent] = []
    for raw in raw_events:
        if raw.timestamp_ns is None:
            continue
        timestamp_ns = int(raw.timestamp_ns)
        event_price = _event_price(raw, by_ts)
        if event_price is None:
            continue
        level = level_map.get(raw.level_id, {})
        pre_ticks = _ticks_between(
            ticks,
            start_ns=timestamp_ns - 60 * NANOSECONDS_PER_SECOND,
            end_ns=timestamp_ns,
            include_end=False,
        )
        buy_volume = sum(tick.quantity for tick in pre_ticks if tick.aggressor_side == "buy")
        sell_volume = sum(tick.quantity for tick in pre_ticks if tick.aggressor_side == "sell")
        pre_cvd = buy_volume - sell_volume
        normalized_direction: TickDirection = "long" if raw.direction == "up" else "short"
        cvd_aligned = _aligned(pre_cvd, normalized_direction) if pre_ticks else None
        aggressor_net = buy_volume - sell_volume
        aggressor_aligned = _aligned(aggressor_net, normalized_direction) if pre_ticks else None
        smaller = min(buy_volume, sell_volume)
        larger = max(buy_volume, sell_volume)
        ratio = None if larger <= 0 else (float(larger) if smaller == 0 else larger / smaller)
        prior_count = sum(
            1
            for prior in enriched
            if prior.level_id == raw.level_id
            and prior.direction == raw.direction
            and 0
            < timestamp_ns - prior.timestamp_ns
            <= 10 * 60 * NANOSECONDS_PER_SECOND
        )
        moved_ticks = abs(event_price - raw.level_price) / tick_size
        enriched.append(
            EnrichedSweepEvent(
                event_key=_research_event_key(session, timestamp_ns, raw.level_id, raw.direction),
                session=session,
                timestamp_ns=timestamp_ns,
                timestamp_pt=_format_pt(timestamp_ns),
                level_id=raw.level_id,
                level_text=raw.level_text,
                level_price=raw.level_price,
                level_type=_level_type(level, raw),
                direction=raw.direction,
                normalized_direction=normalized_direction,
                event_price=event_price,
                moved_ticks=round(moved_ticks, 4),
                intensity_score=raw.intensity_score,
                recovered_within_5min=raw.recovered_within_5min,
                prior_same_level_sweeps_10m=prior_count,
                cluster_bucket=_cluster_bucket(prior_count),
                moved_ticks_bucket=_moved_ticks_bucket(moved_ticks),
                time_bucket=_time_bucket(session, timestamp_ns),
                pre_sweep_cvd=pre_cvd,
                cvd_direction_aligned=cvd_aligned,
                cvd_abs=abs(pre_cvd),
                cvd_abs_quartile=None,
                aggressor_net=aggressor_net,
                aggressor_flow_aligned=aggressor_aligned,
                aggressor_ratio=None if ratio is None else round(ratio, 4),
                aggressor_ratio_quartile=None,
                footprint_imbalance_aligned=None,
                source_obs01=obs01_path,
                completeness_status=audit.status,
                completeness_reasons=audit.reasons,
            )
        )
    return enriched


def _assign_session_quartiles(events: list[EnrichedSweepEvent]) -> None:
    by_session: dict[str, list[EnrichedSweepEvent]] = {}
    for event in events:
        by_session.setdefault(event.session.key, []).append(event)
    replacements: dict[str, EnrichedSweepEvent] = {}
    for session_events in by_session.values():
        cvd_values = sorted(float(event.cvd_abs) for event in session_events)
        ratio_values = sorted(
            event.aggressor_ratio for event in session_events if event.aggressor_ratio is not None
        )
        for event in session_events:
            replacement = {
                **event.__dict__,
                "cvd_abs_quartile": _quartile(float(event.cvd_abs), cvd_values),
                "aggressor_ratio_quartile": (
                    _quartile(float(event.aggressor_ratio), ratio_values)
                    if event.aggressor_ratio is not None
                    else None
                ),
            }
            replacements[event.event_key] = EnrichedSweepEvent(**replacement)
    for index, event in enumerate(events):
        events[index] = replacements[event.event_key]


def _write_label_input(
    path: Path,
    session: PipelineSession,
    events: list[EnrichedSweepEvent],
    obs01_path: Path,
    mbo_path: Path,
    config: SweepResearchConfig,
) -> None:
    rows: list[dict[str, Any]] = []
    for event in events:
        rows.append(
            {
                "schema_version": 1,
                "ts_ns": str(event.timestamp_ns),
                "family": "sweep",
                "event_type": f"sweep_{event.direction}",
                "tier": _tier_from_intensity(event.intensity_score),
                "price": event.event_price,
                "level_id": event.level_id,
                "side": "buy" if event.direction == "up" else "sell",
                "direction": event.normalized_direction,
                "zone_context": {
                    "level_id": event.level_id,
                    "level_text": event.level_text,
                    "level_price": event.level_price,
                    "level_type": event.level_type,
                },
                "regime": None,
                "orderflow_snapshot": {
                    "pre_sweep_cvd": event.pre_sweep_cvd,
                    "cvd_direction_aligned": event.cvd_direction_aligned,
                    "aggressor_net": event.aggressor_net,
                    "aggressor_flow_aligned": event.aggressor_flow_aligned,
                },
                "depth_snapshot": None,
                "confluence_stack_size": event.prior_same_level_sweeps_10m + 1,
                "payload": _event_payload(event),
                "replay": {
                    "capture_date": session.capture_date,
                    "session": session.session,
                    "step_ns": str(config.detector_step_seconds * NANOSECONDS_PER_SECOND),
                    "source_obs01": str(obs01_path),
                    "source_mbo": str(mbo_path) if mbo_path.exists() else None,
                    "schema_version": 1,
                },
            }
        )
    path.write_text(_jsonl(rows), encoding="utf-8")


def _run_label_cli(
    *,
    config: SweepResearchConfig,
    dataset_path: Path,
    trade_tape_path: Path,
    labels_path: Path,
    manifest_path: Path,
) -> None:
    command = [
        config.node_runner,
        "tsx",
        str(LABEL_CLI),
        "--dataset",
        str(dataset_path),
        "--trade-tape",
        str(trade_tape_path),
        "--out",
        str(labels_path),
        "--manifest",
        str(manifest_path),
        "--tick-size",
        str(config.tick_size),
        "--horizons",
        ",".join(str(item) for item in config.horizons_seconds),
    ]
    completed = subprocess.run(command, cwd=REPO_ROOT, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise SweepResearchError(
            "forward-return label CLI failed:\n"
            f"stdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        )


def _load_labels(path: Path, config: SweepResearchConfig) -> dict[str, list[LabelOutcome]]:
    labels: dict[str, list[LabelOutcome]] = {}
    if not path.exists():
        return labels
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        row = json.loads(raw)
        signal = row.get("signal", {})
        replay = signal.get("replay", {})
        ts_ns = int(signal["ts_ns"])
        direction = "up" if signal.get("direction") == "long" else "down"
        key = _research_event_key(
            PipelineSession(
                capture_date=str(replay.get("capture_date")),
                session=cast(SessionName, replay.get("session")),
            ),
            ts_ns,
            str(signal.get("level_id")),
            direction,
        )
        outcomes = []
        for label in row.get("forward_returns", []):
            status = str(label.get("status"))
            realized = _optional_float(label.get("realized_ticks"))
            outcomes.append(
                LabelOutcome(
                    horizon_seconds=int(label["horizon_seconds"]),
                    status=status,
                    realized_ticks=realized,
                    mfe_ticks=_optional_float(label.get("mfe_ticks")),
                    mae_ticks=_optional_float(label.get("mae_ticks")),
                    continued=(
                        realized >= config.target_ticks
                        if status == "ok" and realized is not None
                        else None
                    ),
                    reversed=(
                        realized <= -config.target_ticks
                        if status == "ok" and realized is not None
                        else None
                    ),
                )
            )
        labels[key] = outcomes
    return labels


def _build_conditional_tables(
    *,
    events: list[EnrichedSweepEvent],
    labels_by_key: dict[str, list[LabelOutcome]],
    config: SweepResearchConfig,
) -> dict[str, Any]:
    records = _analysis_records(events, labels_by_key)
    output: dict[str, Any] = {
        "metadata": {
            "target_ticks": config.target_ticks,
            "min_cell_samples": config.min_cell_samples,
            "bonferroni_tests_planned": BONFERRONI_TESTS,
            "lvn_hvn_not_measured": (
                "LVN/HVN levels are not measured by the shipping sweep_detector because "
                "structural_levels() excludes them from its whitelist. Measuring LVN/HVN "
                "sweeps requires a detector taxonomy expansion (RA-099 candidate)."
            ),
        },
        "baseline": {},
        "q1_by_level_type": {},
        "q2_confirmation_conditions": {},
        "q3_cluster_count": {},
        "q4_moved_ticks": {},
        "q5_time_bucket": {},
    }
    for horizon in config.horizons_seconds:
        horizon_records = [record for record in records if record["horizon_seconds"] == horizon]
        output["baseline"][str(horizon)] = _stats_for_records(
            horizon_records,
            min_cell_samples=config.min_cell_samples,
        )
        output["q1_by_level_type"][str(horizon)] = _group_table(
            horizon_records,
            key="level_type",
            min_cell_samples=config.min_cell_samples,
        )
        output["q3_cluster_count"][str(horizon)] = _group_table(
            horizon_records,
            key="cluster_bucket",
            min_cell_samples=config.min_cell_samples,
        )
        output["q4_moved_ticks"][str(horizon)] = _group_table(
            horizon_records,
            key="moved_ticks_bucket",
            min_cell_samples=config.min_cell_samples,
        )
        output["q5_time_bucket"][str(horizon)] = _group_table(
            horizon_records,
            key="time_bucket",
            min_cell_samples=config.min_cell_samples,
        )
    for condition in (
        "cvd_direction_aligned",
        "cvd_abs_q4",
        "aggressor_flow_aligned",
        "aggressor_ratio_q4",
        "footprint_imbalance_aligned",
    ):
        output["q2_confirmation_conditions"][condition] = {}
        for horizon in config.horizons_seconds:
            horizon_records = [record for record in records if record["horizon_seconds"] == horizon]
            output["q2_confirmation_conditions"][condition][str(horizon)] = _condition_table(
                horizon_records,
                condition=condition,
                min_cell_samples=config.min_cell_samples,
            )
    return output


def _analysis_records(
    events: list[EnrichedSweepEvent],
    labels_by_key: dict[str, list[LabelOutcome]],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for event in events:
        for label in labels_by_key.get(event.event_key, []):
            records.append(
                {
                    "event_key": event.event_key,
                    "horizon_seconds": label.horizon_seconds,
                    "status": label.status,
                    "ok": label.status == "ok",
                    "continued": bool(label.continued),
                    "reversed": bool(label.reversed),
                    "realized_ticks": label.realized_ticks,
                    "level_type": event.level_type,
                    "cluster_bucket": event.cluster_bucket,
                    "moved_ticks_bucket": event.moved_ticks_bucket,
                    "time_bucket": event.time_bucket,
                    "cvd_direction_aligned": event.cvd_direction_aligned,
                    "cvd_abs_q4": (
                        event.cvd_abs_quartile == 4
                        if event.cvd_abs_quartile is not None
                        else None
                    ),
                    "aggressor_flow_aligned": event.aggressor_flow_aligned,
                    "aggressor_ratio_q4": (
                        event.aggressor_ratio_quartile == 4
                        if event.aggressor_ratio_quartile is not None
                        else None
                    ),
                    "footprint_imbalance_aligned": event.footprint_imbalance_aligned,
                }
            )
    return records


def _stats_for_records(records: list[dict[str, Any]], *, min_cell_samples: int) -> dict[str, Any]:
    ok_records = [record for record in records if record["ok"]]
    n = len(ok_records)
    continued = sum(1 for record in ok_records if record["continued"])
    reversed_count = sum(1 for record in ok_records if record["reversed"])
    low, high = wilson_interval(continued, n)
    status_counts = Counter(str(record["status"]) for record in records)
    return {
        "n": n,
        "continued": continued,
        "reversed": reversed_count,
        "pushed": max(0, n - continued - reversed_count),
        "continuation_rate": continued / n if n else None,
        "wilson_ci_95": [low, high] if n else None,
        "below_min_cell_samples": n < min_cell_samples,
        "status_counts": dict(sorted(status_counts.items())),
    }


def _group_table(
    records: list[dict[str, Any]],
    *,
    key: str,
    min_cell_samples: int,
) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        groups.setdefault(str(record.get(key)), []).append(record)
    return {
        group: _stats_for_records(group_records, min_cell_samples=min_cell_samples)
        for group, group_records in sorted(groups.items())
    }


def _condition_table(
    records: list[dict[str, Any]],
    *,
    condition: str,
    min_cell_samples: int,
) -> dict[str, Any]:
    known = [
        record
        for record in records
        if record["ok"] and isinstance(record.get(condition), bool)
    ]
    true_records = [record for record in known if record.get(condition) is True]
    false_records = [record for record in known if record.get(condition) is False]
    p_value = _chi_square_p_value(true_records, false_records)
    p_adj = min(1.0, p_value * BONFERRONI_TESTS) if p_value is not None else None
    return {
        "true": _stats_for_records(true_records, min_cell_samples=min_cell_samples),
        "false": _stats_for_records(false_records, min_cell_samples=min_cell_samples),
        "unknown_or_unavailable": len(records) - len(known),
        "chi_squared_p": p_value,
        "bonferroni_p": p_adj,
        "significant_after_bonferroni": p_adj is not None and p_adj < 0.05,
    }


def _chi_square_p_value(
    true_records: list[dict[str, Any]],
    false_records: list[dict[str, Any]],
) -> float | None:
    true_success = sum(1 for record in true_records if record["continued"])
    true_fail = len(true_records) - true_success
    false_success = sum(1 for record in false_records if record["continued"])
    false_fail = len(false_records) - false_success
    if min(true_success + true_fail, false_success + false_fail) == 0:
        return None
    if true_success + false_success == 0 or true_fail + false_fail == 0:
        return None
    try:
        scipy_stats = importlib.import_module("scipy.stats")
        result = scipy_stats.chi2_contingency(
            [[true_success, true_fail], [false_success, false_fail]],
            correction=False,
        )
    except Exception:
        return None
    return float(result.pvalue if hasattr(result, "pvalue") else result[1])


def _build_sample_counts(
    audits: list[SessionCompleteness],
    events: list[EnrichedSweepEvent],
    labels_by_key: dict[str, list[LabelOutcome]],
    config: SweepResearchConfig,
) -> dict[str, Any]:
    complete_events = [event for event in events if event.completeness_status == "complete"]
    labels = [label for event in events for label in labels_by_key.get(event.event_key, [])]
    return {
        "sessions": {
            "total": len(audits),
            "complete": sum(1 for audit in audits if audit.status == "complete"),
            "partial": sum(1 for audit in audits if audit.status == "partial"),
            "missing": sum(1 for audit in audits if audit.status == "missing"),
            "audit": [_audit_to_dict(audit) for audit in audits],
        },
        "events": {
            "total": len(events),
            "complete_session_events": len(complete_events),
            "partial_session_events": len(events) - len(complete_events),
            "by_level_type": dict(sorted(Counter(event.level_type for event in events).items())),
            "complete_by_level_type": dict(
                sorted(Counter(event.level_type for event in complete_events).items())
            ),
        },
        "labels": {
            "total_horizon_rows": len(labels),
            "ok_horizon_rows": sum(1 for label in labels if label.status == "ok"),
            "status_counts": dict(sorted(Counter(label.status for label in labels).items())),
            "horizons_seconds": list(config.horizons_seconds),
        },
    }


def _write_sweep_events(
    path: Path,
    events: list[EnrichedSweepEvent],
    labels_by_key: dict[str, list[LabelOutcome]],
) -> None:
    rows = []
    for event in events:
        rows.append(
            {
                **_event_payload(event),
                "source_obs01": str(event.source_obs01),
                "forward_returns": [
                    {
                        "horizon_seconds": label.horizon_seconds,
                        "status": label.status,
                        "realized_ticks": label.realized_ticks,
                        "mfe_ticks": label.mfe_ticks,
                        "mae_ticks": label.mae_ticks,
                        "continued": label.continued,
                        "reversed": label.reversed,
                    }
                    for label in labels_by_key.get(event.event_key, [])
                ],
            }
        )
    path.write_text(_jsonl(rows), encoding="utf-8")


def _write_report(
    path: Path,
    *,
    config: SweepResearchConfig,
    audits: list[SessionCompleteness],
    all_events: list[EnrichedSweepEvent],
    complete_tables: dict[str, Any],
    included_tables: dict[str, Any],
    partial_tables: dict[str, Any] | None,
    sample_counts: dict[str, Any],
) -> None:
    lines = [
        "# RA-096 Sweep-Continuation Research",
        "",
        "## Scope",
        "",
        (
            "This report measures sweep continuation using the shipping dashboard "
            "`sweep_detector.detect_sweeps()` over rolling replay windows. It is "
            "read-only on captures and excludes incomplete sessions from the main "
            "tables by default."
        ),
        "",
        (
            "**LVN/HVN limitation:** LVN/HVN levels are not measured by the shipping "
            "`sweep_detector` because they are not in `structural_levels()`'s whitelist. "
            "To measure sweep behavior at LVNs/HVNs, the detector's level taxonomy must "
            "be expanded in a separate ticket (RA-099 candidate)."
        ),
        "",
        "## Complete vs Partial Sessions",
        "",
        "| Session | Status | Trades | Max gap | Reasons |",
        "|---|---:|---:|---:|---|",
    ]
    for audit in audits:
        lines.append(
            "| "
            f"{audit.session.capture_date} {audit.session.session} | "
            f"{audit.status} | {audit.trade_count} | "
            f"{_fmt_optional(audit.max_gap_seconds)} | "
            f"{', '.join(audit.reasons) if audit.reasons else 'ok'} |"
        )
    lines.extend(
        [
            "",
            "## Five Operator-Readable Findings",
            "",
            *_finding_lines(complete_tables, sample_counts, config),
            "",
            "## Main Tables (Complete Sessions Only)",
            "",
            _table_summary_markdown(complete_tables, config),
            "",
            "## Statistical Honesty",
            "",
            (
                f"Cells below n={config.min_cell_samples} are marked underpowered. "
                "Wilson 95% confidence intervals are reported for continuation rates. "
                f"Chi-squared condition tests use Bonferroni correction across "
                f"{BONFERRONI_TESTS} planned comparisons."
            ),
        ]
    )
    if config.include_partial_sessions and partial_tables is not None:
        lines.extend(
            [
                "",
                "## Preliminary Findings - Partial Sessions",
                "",
                (
                    "This section is explicitly preliminary. It includes partial or "
                    "incomplete sessions because `--include-partial-sessions` was set."
                ),
                "",
                _table_summary_markdown(partial_tables, config),
            ]
        )
    elif included_tables != complete_tables:
        lines.extend(
            ["", "## Included Tables", "", _table_summary_markdown(included_tables, config)]
        )
    lines.extend(
        [
            "",
            "## Artifact Paths",
            "",
            "- `conditional_tables.json`",
            "- `sample_counts.json`",
            "- `sweep_events.jsonl`",
            "- `scatter_intensity_vs_return.png`",
            "- `pipeline_manifest.json`",
            "",
            f"Total sweeps detected across all requested sessions: {len(all_events)}.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _finding_lines(
    tables: dict[str, Any],
    sample_counts: dict[str, Any],
    config: SweepResearchConfig,
) -> list[str]:
    lines: list[str] = []
    sessions = sample_counts["sessions"]
    events = sample_counts["events"]
    lines.append(
        "1. "
        f"{sessions['complete']} of {sessions['total']} requested sessions qualified "
        f"as complete; the main tables use {events['complete_session_events']} sweeps."
    )
    horizon = "60" if "60" in tables["baseline"] else str(config.horizons_seconds[0])
    baseline = tables["baseline"].get(horizon, {})
    lines.append(
        "2. "
        f"Baseline {horizon}s continuation is {_fmt_rate(baseline)} "
        f"on n={baseline.get('n', 0)} complete-session samples."
    )
    q1 = tables["q1_by_level_type"].get(horizon, {})
    best_level = _best_group(q1)
    lines.append(
        "3. "
        + (
            f"Best measured level family at {horizon}s is `{best_level[0]}` with "
            f"{_fmt_rate(best_level[1])} on n={best_level[1].get('n', 0)}."
            if best_level is not None
            else "No level-family cell has enough valid samples to rank honestly yet."
        )
    )
    cvd = tables["q2_confirmation_conditions"].get("cvd_direction_aligned", {}).get(horizon, {})
    lines.append(
        "4. "
        f"CVD-aligned vs non-aligned {horizon}s continuation: "
        f"true={_fmt_rate(cvd.get('true', {}))}, false={_fmt_rate(cvd.get('false', {}))}; "
        f"Bonferroni p={_fmt_optional(cvd.get('bonferroni_p'))}."
    )
    lines.append(
        "5. "
        "LVN/HVN behavior is not measured in this run; that is a detector-taxonomy "
        "coverage gap, not a statistical result."
    )
    return lines


def _table_summary_markdown(tables: dict[str, Any], config: SweepResearchConfig) -> str:
    horizon = "60" if "60" in tables["baseline"] else str(config.horizons_seconds[0])
    rows = [
        f"### Horizon {horizon}s",
        "",
        "| Slice | Group | n | Continuation | Wilson 95% CI | Underpowered |",
        "|---|---|---:|---:|---|---:|",
    ]
    for slice_name in ("q1_by_level_type", "q3_cluster_count", "q4_moved_ticks", "q5_time_bucket"):
        for group, stats in tables.get(slice_name, {}).get(horizon, {}).items():
            rows.append(
                "| "
                f"{slice_name} | {group} | {stats.get('n', 0)} | "
                f"{_fmt_rate(stats)} | {_fmt_ci(stats)} | "
                f"{stats.get('below_min_cell_samples', True)} |"
            )
    return "\n".join(rows)


def _write_scatter(
    path: Path,
    events: list[EnrichedSweepEvent],
    labels_by_key: dict[str, list[LabelOutcome]],
) -> None:
    pyplot = importlib.import_module("matplotlib.pyplot")
    xs: list[float] = []
    ys: list[float] = []
    for event in events:
        for label in labels_by_key.get(event.event_key, []):
            if (
                label.horizon_seconds == 60
                and label.status == "ok"
                and label.realized_ticks is not None
            ):
                xs.append(event.intensity_score)
                ys.append(label.realized_ticks)
                break
    figure = pyplot.figure(figsize=(8, 5))
    axis = figure.add_subplot(1, 1, 1)
    if xs:
        axis.scatter(xs, ys, s=14, alpha=0.65, color="#f59e0b")
    else:
        axis.text(0.5, 0.5, "No 60s ok labels", ha="center", va="center")
    axis.axhline(0, color="#777777", linewidth=1)
    axis.set_xlabel("Sweep intensity score")
    axis.set_ylabel("60s realized return (ticks)")
    axis.set_title("Sweep intensity vs forward return")
    figure.tight_layout()
    figure.savefig(path, dpi=140)
    pyplot.close(figure)


def _write_manifest(
    path: Path,
    *,
    config: SweepResearchConfig,
    run_id: str,
    run_dir: Path,
    session_artifacts: list[dict[str, Any]],
    outputs: tuple[Path, ...],
) -> None:
    chain = _artifact_chain(
        [
            *[
                {
                    "name": f"input:{item['capture_date']}:{item['session']}:obs01",
                    "sha256": item["obs01_sha256"],
                }
                for item in session_artifacts
                if item.get("obs01_sha256")
            ],
            *[
                {
                    "name": f"input:{item['capture_date']}:{item['session']}:zones",
                    "sha256": item["zones_sha256"],
                }
                for item in session_artifacts
                if item.get("zones_sha256")
            ],
            *[{"name": output.name, "sha256": sha256_file(output)} for output in outputs],
        ]
    )
    manifest = {
        "schema_version": 1,
        "generated_by": "ra096_sweep_research_v1",
        "generated_at_ns": time.time_ns(),
        "run_id": run_id,
        "run_dir": str(run_dir),
        "git": _git_state(),
        "settings": {
            "analytics_root": str(config.analytics_root),
            "dashboard_root": str(config.dashboard_root),
            "horizons_seconds": list(config.horizons_seconds),
            "target_ticks": config.target_ticks,
            "min_cell_samples": config.min_cell_samples,
            "include_partial_sessions": config.include_partial_sessions,
            "detector_step_seconds": config.detector_step_seconds,
            "tick_size": config.tick_size,
        },
        "sessions": session_artifacts,
        "artifact_hash_chain": chain,
        "artifact_chain_tip": chain[-1]["chain_sha256"] if chain else None,
    }
    path.write_text(canonical_json(manifest) + "\n", encoding="utf-8")


def _audit_session(
    session: PipelineSession,
    obs01_path: Path,
    zones_path: Path,
    ticks: list[TradeTick],
) -> SessionCompleteness:
    reasons: list[str] = []
    if not obs01_path.exists():
        return SessionCompleteness(
            session=session,
            status="missing",
            reasons=("missing_obs01",),
            obs01_path=obs01_path,
            zones_path=zones_path,
            trade_count=0,
            first_trade_pt=None,
            last_trade_pt=None,
            obs01_mtime_pt=None,
            max_gap_seconds=None,
            max_gap_start_pt=None,
            max_gap_end_pt=None,
        )
    window = _session_window(session)
    first_ts = int(ticks[0].timestamp_ns or 0) if ticks else None
    last_ts = int(ticks[-1].timestamp_ns or 0) if ticks else None
    if first_ts is None:
        reasons.append("no_trade_ticks")
    elif first_ts > _dt_to_ns(window["first_trade_latest"]):
        reasons.append("first_trade_after_threshold")
    if last_ts is None:
        reasons.append("no_trade_ticks")
    elif last_ts < _dt_to_ns(window["last_trade_earliest"]):
        reasons.append("last_trade_before_threshold")
    mtime = datetime.fromtimestamp(obs01_path.stat().st_mtime, tz=UTC).astimezone(PT)
    if mtime < window["mtime_earliest"]:
        reasons.append("mtime_before_threshold")
    floor = RTH_RECORD_FLOOR if session.session == "rth" else GLOBEX_RECORD_FLOOR
    if len(ticks) < floor:
        reasons.append("record_count_below_floor")
    max_gap, gap_start, gap_end = _max_gap_inside_window(
        ticks,
        start_ns=_dt_to_ns(window["official_start"]),
        end_ns=_dt_to_ns(window["official_end"]),
    )
    if max_gap is not None and max_gap > MAX_MID_SESSION_GAP_SECONDS:
        reasons.append("max_gap_gt_60s")
    status: SessionCompletenessStatus = "complete" if not reasons else "partial"
    return SessionCompleteness(
        session=session,
        status=status,
        reasons=tuple(reasons),
        obs01_path=obs01_path,
        zones_path=zones_path,
        trade_count=len(ticks),
        first_trade_pt=_format_pt(first_ts) if first_ts is not None else None,
        last_trade_pt=_format_pt(last_ts) if last_ts is not None else None,
        obs01_mtime_pt=mtime.strftime("%Y-%m-%d %H:%M:%S PT"),
        max_gap_seconds=max_gap,
        max_gap_start_pt=_format_pt(gap_start) if gap_start is not None else None,
        max_gap_end_pt=_format_pt(gap_end) if gap_end is not None else None,
    )


def _session_window(session: PipelineSession) -> dict[str, datetime]:
    capture_date = date.fromisoformat(session.capture_date)
    if session.session == "rth":
        official_start = datetime.combine(capture_date, datetime_time(6, 30), tzinfo=PT)
        official_end = datetime.combine(capture_date, datetime_time(13, 5), tzinfo=PT)
        return {
            "official_start": official_start,
            "official_end": official_end,
            "first_trade_latest": datetime.combine(capture_date, datetime_time(6, 45), tzinfo=PT),
            "last_trade_earliest": datetime.combine(capture_date, datetime_time(13, 0), tzinfo=PT),
            "mtime_earliest": datetime.combine(capture_date, datetime_time(13, 5), tzinfo=PT),
        }
    previous = capture_date - timedelta(days=1)
    official_start = datetime.combine(previous, datetime_time(15, 0), tzinfo=PT)
    official_end = datetime.combine(capture_date, datetime_time(6, 30), tzinfo=PT)
    return {
        "official_start": official_start,
        "official_end": official_end,
        "first_trade_latest": datetime.combine(previous, datetime_time(15, 20), tzinfo=PT),
        "last_trade_earliest": datetime.combine(capture_date, datetime_time(6, 20), tzinfo=PT),
        "mtime_earliest": datetime.combine(capture_date, datetime_time(6, 20), tzinfo=PT),
    }


def _max_gap_inside_window(
    ticks: list[TradeTick],
    *,
    start_ns: int,
    end_ns: int,
) -> tuple[float | None, int | None, int | None]:
    in_window = [
        int(tick.timestamp_ns or 0)
        for tick in ticks
        if start_ns <= int(tick.timestamp_ns or 0) <= end_ns
    ]
    if len(in_window) < 2:
        return (None, None, None)
    max_gap_ns = 0
    gap_start = in_window[0]
    gap_end = in_window[1]
    for left, right in zip(in_window, in_window[1:], strict=False):
        gap = right - left
        if gap > max_gap_ns:
            max_gap_ns = gap
            gap_start = left
            gap_end = right
    return (max_gap_ns / NANOSECONDS_PER_SECOND, gap_start, gap_end)


def _assert_capture_not_active(session: PipelineSession, config: SweepResearchConfig) -> None:
    if config.allow_live_capture_contention:
        return
    recent_files = _recent_capture_writes(session, config)
    process_lines = _matching_capture_processes(session)
    if recent_files or process_lines:
        raise SweepResearchError(
            "target capture appears active; rerun in a quiet window or pass "
            "--allow-live-capture-contention. details="
            + canonical_json(
                {
                    "recent_files": [str(path) for path in recent_files],
                    "matching_processes": process_lines,
                }
            )
        )


def _recent_capture_writes(session: PipelineSession, config: SweepResearchConfig) -> list[Path]:
    capture_dir = config.analytics_root / "data" / "captures" / session.capture_date
    candidates = [
        capture_dir / f"MNQ_{session.session}.jsonl",
        capture_dir / f"MNQ_{session.session}.obs01.jsonl",
        capture_dir / f"MNQ_{session.session}.mbo.jsonl",
    ]
    cutoff = time.time() - config.live_write_stale_seconds
    return [
        path
        for path in candidates
        if path.exists() and path.stat().st_size > 0 and path.stat().st_mtime >= cutoff
    ]


def _matching_capture_processes(session: PipelineSession) -> list[str]:
    if os.name != "nt":
        return []
    script = (
        f"$session = '{session.session}'; "
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine "
        "-and $_.CommandLine -match '(start_capture|capture-rithmic-probe)' "
        "-and $_.CommandLine -match $session } | "
        "ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"
    )
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", script],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return []
    return [line.strip() for line in completed.stdout.splitlines() if line.strip()]


def _ticks_by_ts(ticks: list[TradeTick]) -> dict[int, list[TradeTick]]:
    output: dict[int, list[TradeTick]] = {}
    for tick in ticks:
        if tick.timestamp_ns is not None:
            output.setdefault(int(tick.timestamp_ns), []).append(tick)
    return output


def _event_price(event: SweepEvent, ticks_by_ts: dict[int, list[TradeTick]]) -> float | None:
    if event.timestamp_ns is None:
        return None
    candidates = ticks_by_ts.get(int(event.timestamp_ns), [])
    if not candidates:
        return None
    if event.direction == "up":
        return max(tick.price for tick in candidates)
    return min(tick.price for tick in candidates)


def _ticks_between(
    ticks: list[TradeTick],
    *,
    start_ns: int,
    end_ns: int,
    include_end: bool,
) -> list[TradeTick]:
    if include_end:
        return [
            tick
            for tick in ticks
            if start_ns <= int(tick.timestamp_ns or 0) <= end_ns
        ]
    return [
        tick
        for tick in ticks
        if start_ns <= int(tick.timestamp_ns or 0) < end_ns
    ]


def _aligned(value: int, direction: TickDirection) -> bool:
    if value == 0:
        return False
    return value > 0 if direction == "long" else value < 0


def _level_type(level: dict[str, Any], event: SweepEvent) -> str:
    source = str(level.get("source") or "").lower()
    text = event.level_text.lower()
    level_id = event.level_id.lower()
    if source in {"vpoc", "vah", "val"}:
        return source
    if "vwap" in source or "vwap" in text or "vwap" in level_id:
        return "vwap"
    if source == "zone" or "zone" in level_id:
        return "high_super_zone"
    return source or "other"


def _cluster_bucket(prior_count: int) -> str:
    if prior_count <= 0:
        return "0_prior"
    if prior_count == 1:
        return "1_prior"
    if prior_count <= 3:
        return "2_3_prior"
    return "4plus_prior"


def _moved_ticks_bucket(value: float) -> str:
    if value < 4:
        return "3_4_ticks"
    if value < 7:
        return "4_7_ticks"
    if value < 12:
        return "7_12_ticks"
    return "12plus_ticks"


def _time_bucket(session: PipelineSession, ts_ns: int) -> str:
    local = datetime.fromtimestamp(ts_ns / NANOSECONDS_PER_SECOND, tz=UTC).astimezone(PT)
    minutes = local.hour * 60 + local.minute
    if session.session == "rth":
        if minutes < 7 * 60 + 30:
            return "rth_open_0630_0730"
        if minutes < 11 * 60:
            return "rth_mid_0730_1100"
        return "rth_late_1100_1305"
    if 15 * 60 <= minutes < 18 * 60:
        return "globex_open_1500_1800"
    if minutes >= 18 * 60:
        return "globex_evening_1800_2400"
    if minutes < 3 * 60:
        return "globex_overnight_0000_0300"
    return "globex_premarket_0300_0630"


def _quartile(value: float, sorted_values: list[float]) -> int | None:
    if not sorted_values:
        return None
    less_equal = sum(1 for item in sorted_values if item <= value)
    percentile = less_equal / len(sorted_values)
    if percentile <= 0.25:
        return 1
    if percentile <= 0.50:
        return 2
    if percentile <= 0.75:
        return 3
    return 4


def _raw_event_key(event: SweepEvent) -> str:
    return f"{event.timestamp_ns}|{event.level_id}|{event.direction}"


def _research_event_key(
    session: PipelineSession,
    timestamp_ns: int,
    level_id: str,
    direction: str,
) -> str:
    return f"{session.capture_date}|{session.session}|{timestamp_ns}|{level_id}|{direction}"


def _event_payload(event: EnrichedSweepEvent) -> dict[str, Any]:
    return {
        "event_key": event.event_key,
        "capture_date": event.session.capture_date,
        "session": event.session.session,
        "timestamp_ns": str(event.timestamp_ns),
        "timestamp_pt": event.timestamp_pt,
        "family": "sweep",
        "event_type": f"sweep_{event.direction}",
        "level_id": event.level_id,
        "level_text": event.level_text,
        "level_price": event.level_price,
        "level_type": event.level_type,
        "direction": event.direction,
        "normalized_direction": event.normalized_direction,
        "event_price": event.event_price,
        "moved_ticks": event.moved_ticks,
        "intensity_score": event.intensity_score,
        "recovered_within_5min": event.recovered_within_5min,
        "prior_same_level_sweeps_10m": event.prior_same_level_sweeps_10m,
        "cluster_bucket": event.cluster_bucket,
        "moved_ticks_bucket": event.moved_ticks_bucket,
        "time_bucket": event.time_bucket,
        "pre_sweep_cvd": event.pre_sweep_cvd,
        "cvd_direction_aligned": event.cvd_direction_aligned,
        "cvd_abs": event.cvd_abs,
        "cvd_abs_quartile": event.cvd_abs_quartile,
        "aggressor_net": event.aggressor_net,
        "aggressor_flow_aligned": event.aggressor_flow_aligned,
        "aggressor_ratio": event.aggressor_ratio,
        "aggressor_ratio_quartile": event.aggressor_ratio_quartile,
        "footprint_imbalance_aligned": event.footprint_imbalance_aligned,
        "completeness_status": event.completeness_status,
        "completeness_reasons": list(event.completeness_reasons),
    }


def _tier_from_intensity(intensity: float) -> str:
    if intensity >= 4.0:
        return "CRITICAL"
    if intensity >= 2.5:
        return "HIGH"
    return "MEDIUM"


def _jsonl(rows: list[dict[str, Any]]) -> str:
    return "".join(canonical_json(row) + "\n" for row in rows)


def _audit_to_dict(audit: SessionCompleteness) -> dict[str, Any]:
    return {
        "capture_date": audit.session.capture_date,
        "session": audit.session.session,
        "status": audit.status,
        "reasons": list(audit.reasons),
        "obs01_path": str(audit.obs01_path),
        "zones_path": str(audit.zones_path),
        "trade_count": audit.trade_count,
        "first_trade_pt": audit.first_trade_pt,
        "last_trade_pt": audit.last_trade_pt,
        "obs01_mtime_pt": audit.obs01_mtime_pt,
        "max_gap_seconds": audit.max_gap_seconds,
        "max_gap_start_pt": audit.max_gap_start_pt,
        "max_gap_end_pt": audit.max_gap_end_pt,
    }


def _artifact_chain(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    previous = "0" * 64
    output: list[dict[str, str]] = []
    for item in items:
        chain_hash = sha256_text(canonical_json([previous, item["name"], item["sha256"]]))
        output.append(
            {
                "name": str(item["name"]),
                "sha256": str(item["sha256"]),
                "chain_sha256": chain_hash,
            }
        )
        previous = chain_hash
    return output


def _derive_run_id(config: SweepResearchConfig) -> str:
    payload = {
        "sessions": [session.__dict__ for session in config.sessions],
        "horizons_seconds": list(config.horizons_seconds),
        "target_ticks": config.target_ticks,
        "min_cell_samples": config.min_cell_samples,
        "detector_step_seconds": config.detector_step_seconds,
    }
    return f"ra096_{sha256_text(canonical_json(payload))[:12]}"


def _git_state() -> dict[str, Any]:
    commit = _git(["rev-parse", "HEAD"])
    status = _git(["status", "--short"])
    return {
        "commit": commit.strip() or None,
        "dirty": bool(status.strip()),
        "status_short": status.splitlines(),
        "note": "dirty status is recorded for audit only; unrelated files are not hashed",
    }


def _git(args: list[str]) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    return completed.stdout if completed.returncode == 0 else ""


def _dt_to_ns(value: datetime) -> int:
    return int(value.astimezone(UTC).timestamp() * NANOSECONDS_PER_SECOND)


def _format_pt(ts_ns: int) -> str:
    return datetime.fromtimestamp(ts_ns / NANOSECONDS_PER_SECOND, tz=UTC).astimezone(PT).strftime(
        "%Y-%m-%d %H:%M:%S PT"
    )


def _fmt_optional(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.4g}"
    return str(value)


def _fmt_rate(stats: dict[str, Any]) -> str:
    rate = stats.get("continuation_rate")
    return "-" if rate is None else f"{float(rate) * 100:.1f}%"


def _fmt_ci(stats: dict[str, Any]) -> str:
    ci = stats.get("wilson_ci_95")
    if not ci:
        return "-"
    return f"{float(ci[0]) * 100:.1f}% - {float(ci[1]) * 100:.1f}%"


def _best_group(groups: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    eligible = [
        (name, stats)
        for name, stats in groups.items()
        if stats.get("n", 0) > 0 and stats.get("continuation_rate") is not None
    ]
    if not eligible:
        return None
    return max(eligible, key=lambda item: (float(item[1]["continuation_rate"]), int(item[1]["n"])))


def _optional_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
