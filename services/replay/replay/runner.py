"""RA-090a parity replay harness for Python live detectors.

The replay runner intentionally models what the live backend can see, not a
perfect-history research detector. It synthetic-appends source rows into an
isolated capture tree and calls ``compute_live_signals`` on the same
``DEFAULT_TAIL_BYTES`` 20MB bounded tail used in production. This means the
dataset labels ``P(outcome | what live sees)`` and avoids training on a detector
that never exists intraday.

Detector state starts fresh per replayed capture. The only seeded files are the
threshold/calibration inputs the live detector reads before writing session
JSONL: ``dislocation_thresholds.json``, ``trade_size_thresholds.json``, and
``iceberg_thresholds.json`` are copied into the scratch ``live_analysis`` when
found under either the dashboard or analytics root. The EWMA calibration file is
read-only from ``analytics_root/data/calibration_corpus/ewma_decay.json`` when
present and is recorded in the manifest rather than copied.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from contracts.realtime.events import SignalPayload, Tier
from realtime_backend.depth import (
    build_depth_payload,
    classify_depth_quality,
    resolve_depth_mid,
)
from realtime_backend.orderflow import build_orderflow_stats
from realtime_backend.price_ticks import latest_price_tick
from realtime_backend.signals import (
    MappedEvent,
    classify_tier,
    diff_signals,
    map_absorption,
    map_aggressor,
    map_dislocation,
    map_iceberg,
    map_regime,
    map_sweep,
)
from replay.canonical import canonical_json, sha256_file, sha256_text
from replay.dataset import DatasetManifest, ReplayContext, SignalDatasetRow, ZoneContext
from replay.sources import CaptureSources, SourceRow, iter_source_rows, resolve_capture_sources
from rithmic_dashboard.features.depth_book import DepthBook
from rithmic_dashboard.features.live_signals import DEFAULT_TAIL_BYTES, compute_live_signals
from rithmic_dashboard.features.mbo_order_tracker import _mbo_event
from rithmic_dashboard.features.recent_signals_panel import RecentSignal, build_recent_signals
from rithmic_dashboard.models import (
    InstitutionalFlowEvent,
    LiveSignals,
)
from rithmic_dashboard.session_state import PT, determine_session_state

STEP_NS = 500_000_000
THRESHOLD_FILES = (
    "dislocation_thresholds.json",
    "trade_size_thresholds.json",
    "iceberg_thresholds.json",
)


@dataclass(frozen=True)
class ReplayConfig:
    """Configuration for a single capture replay.

    ``tail_bytes`` defaults to ``DEFAULT_TAIL_BYTES`` and should remain there
    for parity mode. A future research mode may widen it, but that output must
    be tagged separately because it would not match live detector behavior.
    """

    analytics_root: Path
    capture_date: str
    session: str
    out_path: Path
    dashboard_root: Path | None = None
    scratch_dir: Path | None = None
    step_ms: int = 500
    tail_bytes: int = DEFAULT_TAIL_BYTES
    depth_n_ticks: int = 20
    max_price_distance: float = 30.0
    staleness_threshold_seconds: float = 30.0
    limit_steps: int | None = None


@dataclass(frozen=True)
class ReplayResult:
    """Resolved output paths and deterministic hash metadata."""

    out_path: Path
    manifest_path: Path
    row_count: int
    dataset_sha256: str


@dataclass
class _ReplayState:
    config: ReplayConfig
    sources: CaptureSources
    replay_analytics_root: Path
    detector_dashboard_dir: Path
    replay_capture_path: Path
    replay_obs_path: Path
    replay_mbo_path: Path
    envelope: dict[str, Any] | None
    seeded_files: dict[str, str | None]
    ewma_calibration_path: Path | None
    depth_book: DepthBook
    previous_signals: LiveSignals | None = None
    previous_institutional_keys: set[tuple[Any, ...]] | None = None
    rows: list[SignalDatasetRow] | None = None
    steps_run: int = 0


def run_replay(config: ReplayConfig) -> ReplayResult:
    """Replay one capture into a canonical detector-firing JSONL dataset."""

    if config.step_ms <= 0:
        raise ValueError("step_ms must be positive")
    sources = resolve_capture_sources(
        config.analytics_root,
        capture_date=config.capture_date,
        session=config.session,
    )
    if sources.trade_path is None and sources.mbo_path is None:
        raise FileNotFoundError(
            f"No trade or MBO sources found for {config.capture_date} {config.session}"
        )
    state = _prepare_state(config, sources)
    state.rows = []

    source_rows = iter_source_rows(sources)
    first_row = next(source_rows, None)
    if first_row is None:
        return _write_outputs(state)

    step_ns = config.step_ms * 1_000_000
    next_boundary_ns = _ceil_to_step(first_row.ts_ns, step_ns)
    appended_since_compute = False
    pending: SourceRow | None = first_row

    with state.replay_capture_path.open("a", encoding="utf-8") as raw_handle, (
        state.replay_obs_path.open("a", encoding="utf-8")
    ) as obs_handle, state.replay_mbo_path.open("a", encoding="utf-8") as mbo_handle:
        while pending is not None:
            while pending.ts_ns > next_boundary_ns and appended_since_compute:
                _compute_step(state, step_ns=next_boundary_ns)
                if _hit_step_limit(state):
                    return _write_outputs(state)
                appended_since_compute = False
                next_boundary_ns += step_ns
            while pending.ts_ns > next_boundary_ns:
                next_boundary_ns += step_ns
            _append_source_row(state, pending, raw_handle, obs_handle, mbo_handle)
            appended_since_compute = True
            pending = next(source_rows, None)

        if appended_since_compute:
            _compute_step(state, step_ns=next_boundary_ns)

    return _write_outputs(state)


def _prepare_state(config: ReplayConfig, sources: CaptureSources) -> _ReplayState:
    scratch_root = config.scratch_dir or config.out_path.parent / f"{config.out_path.stem}_scratch"
    if scratch_root.exists():
        shutil.rmtree(scratch_root)
    replay_analytics_root = scratch_root / "analytics"
    capture_dir = replay_analytics_root / "data" / "captures" / config.capture_date
    capture_dir.mkdir(parents=True, exist_ok=True)
    replay_capture_path = capture_dir / f"MNQ_{config.session}.jsonl"
    replay_obs_path = capture_dir / f"MNQ_{config.session}.obs01.jsonl"
    replay_mbo_path = capture_dir / f"MNQ_{config.session}.mbo.jsonl"
    replay_capture_path.write_text("", encoding="utf-8")
    replay_obs_path.write_text("", encoding="utf-8")
    replay_mbo_path.write_text("", encoding="utf-8")

    envelope = _copy_envelope(config.analytics_root, replay_analytics_root, config)
    detector_dashboard_dir = scratch_root / "detector" / "dashboard"
    detector_dashboard_dir.mkdir(parents=True, exist_ok=True)
    seeded_files = _seed_thresholds(config, detector_dashboard_dir.parent / "live_analysis")
    ewma_path = config.analytics_root / "data" / "calibration_corpus" / "ewma_decay.json"
    ewma_calibration_path = ewma_path if ewma_path.exists() else None
    if ewma_calibration_path is not None:
        seeded_files["ewma_decay.json"] = sha256_file(ewma_calibration_path)
    else:
        seeded_files["ewma_decay.json"] = None

    return _ReplayState(
        config=config,
        sources=sources,
        replay_analytics_root=replay_analytics_root,
        detector_dashboard_dir=detector_dashboard_dir,
        replay_capture_path=replay_capture_path,
        replay_obs_path=replay_obs_path,
        replay_mbo_path=replay_mbo_path,
        envelope=envelope,
        seeded_files=seeded_files,
        ewma_calibration_path=ewma_calibration_path,
        depth_book=DepthBook(),
        rows=[],
    )


def _copy_envelope(
    source_root: Path,
    replay_root: Path,
    config: ReplayConfig,
) -> dict[str, Any] | None:
    source = (
        source_root
        / "data"
        / "zones"
        / f"{config.capture_date}_MNQ_{config.session}.json"
    )
    if not source.exists():
        return None
    target = (
        replay_root
        / "data"
        / "zones"
        / f"{config.capture_date}_MNQ_{config.session}.json"
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _seed_thresholds(config: ReplayConfig, live_dir: Path) -> dict[str, str | None]:
    live_dir.mkdir(parents=True, exist_ok=True)
    roots = []
    if config.dashboard_root is not None:
        roots.append(config.dashboard_root / "data" / "live_analysis")
    roots.append(config.analytics_root / "data" / "live_analysis")
    seeded: dict[str, str | None] = {}
    for name in THRESHOLD_FILES:
        source = next((root / name for root in roots if (root / name).exists()), None)
        if source is None:
            seeded[name] = None
            continue
        target = live_dir / name
        shutil.copy2(source, target)
        seeded[name] = sha256_file(source)
    return seeded


def _append_source_row(
    state: _ReplayState,
    row: SourceRow,
    raw_handle: Any,
    obs_handle: Any,
    mbo_handle: Any,
) -> None:
    if row.kind == "mbo":
        mbo_handle.write(row.raw_line + "\n")
        mbo_handle.flush()
        event = _mbo_event(row.record)
        if event is not None:
            state.depth_book.apply(event)
        return
    raw_handle.write(row.raw_line + "\n")
    raw_handle.flush()
    obs_handle.write(row.raw_line + "\n")
    obs_handle.flush()


def _compute_step(state: _ReplayState, *, step_ns: int) -> None:
    config = state.config
    now_pt = datetime.fromtimestamp(step_ns / 1_000_000_000, tz=UTC).astimezone(PT)
    session = determine_session_state(
        now_pt=now_pt,
        analytics_root=state.replay_analytics_root,
        trading_date_override=config.capture_date,
        session_override=config.session,
    )
    signals = compute_live_signals(
        capture_path=session.capture_path,
        envelope=state.envelope,
        session=session,
        dashboard_dir=state.detector_dashboard_dir,
        ewma_calibration_path=state.ewma_calibration_path,
        tail_bytes=config.tail_bytes,
    )
    live_dir = state.detector_dashboard_dir.parent / "live_analysis"
    recent = build_recent_signals(
        live_dir=live_dir,
        session=session,
        audit=[],
        scenarios=[],
        levels=[],
        now_pt=now_pt,
    )
    tick = latest_price_tick(
        trade_source_path=session.capture_path.with_name(f"MNQ_{config.session}.obs01.jsonl"),
        capture_path=session.capture_path,
    )
    current_price = tick.price if tick is not None else signals.live_vwap.vwap
    diff = diff_signals(state.previous_signals, signals)
    orderflow = build_orderflow_stats(signals, tick)
    depth_payload = _depth_payload(state, tick=tick, step_ns=step_ns)

    mapped_rows = _mapped_event_rows(
        state,
        signals=signals,
        recent=recent,
        current_price=current_price,
        orderflow_snapshot=orderflow.model_dump(mode="json") if orderflow is not None else None,
        depth_snapshot=depth_payload.model_dump(mode="json") if depth_payload is not None else None,
        step_ns=step_ns,
        mapped_events=_events_with_timestamps(diff, signals, step_ns=step_ns),
    )
    institutional_rows = _institutional_rows(
        state,
        signals=signals,
        recent=recent,
        current_price=current_price,
        orderflow_snapshot=orderflow.model_dump(mode="json") if orderflow is not None else None,
        depth_snapshot=depth_payload.model_dump(mode="json") if depth_payload is not None else None,
        step_ns=step_ns,
    )
    assert state.rows is not None
    state.rows.extend(mapped_rows)
    state.rows.extend(institutional_rows)
    state.previous_signals = signals
    state.previous_institutional_keys = _institutional_keys(signals.institutional_flow_events)
    state.steps_run += 1


def _events_with_timestamps(
    diff: Any,
    signals: LiveSignals,
    *,
    step_ns: int,
) -> list[tuple[MappedEvent, int, str, str | None, str | None]]:
    events: list[tuple[MappedEvent, int, str, str | None, str | None]] = []
    events.extend(
        (
            map_sweep(event),
            _event_ts(event.timestamp_ns, step_ns),
            "sweep_detected",
            None,
            event.direction,
        )
        for event in diff.sweeps
    )
    events.extend(
        (
            map_absorption(event),
            _event_ts(event.timestamp_ns, step_ns),
            "absorption_proxy",
            event.side_inferred,
            None,
        )
        for event in diff.absorption
    )
    events.extend(
        (
            map_dislocation(event),
            _event_ts(event.timestamp_ns, step_ns),
            f"delta_dislocation_{event.side}_detected",
            event.side,
            event.side,
        )
        for event in diff.dislocations
    )
    events.extend(
        (
            map_iceberg(event),
            _event_ts(event.timestamp_ns, step_ns),
            event.event_type,
            event.side,
            event.direction,
        )
        for event in diff.icebergs
    )
    events.extend(
        (
            map_aggressor(event),
            _event_ts(event.timestamp_ns, step_ns),
            event.event_type,
            None,
            event.direction,
        )
        for event in diff.aggressor
    )
    if diff.regime_changed:
        mapped = map_regime(signals)
        if mapped is not None:
            events.append((mapped, step_ns, "vol_regime_changed", None, None))
    return events


def _mapped_event_rows(
    state: _ReplayState,
    *,
    signals: LiveSignals,
    recent: list[RecentSignal],
    current_price: float | None,
    orderflow_snapshot: dict[str, Any] | None,
    depth_snapshot: dict[str, Any] | None,
    step_ns: int,
    mapped_events: Iterable[tuple[MappedEvent, int, str, str | None, str | None]],
) -> list[SignalDatasetRow]:
    rows: list[SignalDatasetRow] = []
    for mapped, ts_ns, event_type, side, direction in mapped_events:
        tier = None
        if mapped.message_type != "regime":
            tier = classify_tier(
                mapped,
                recent_signals=recent,
                current_price=current_price,
                max_price_distance=state.config.max_price_distance,
            )
        try:
            row = SignalDatasetRow(
                ts_ns=ts_ns,
                family=mapped.family,  # type: ignore[arg-type]
                event_type=event_type,
                tier=tier,
                price=mapped.zone_price,
                level_id=_payload_attr(mapped.payload, "level_id"),
                side=side,
                direction=direction,
                zone_context=_zone_context(
                    state.envelope,
                    price=mapped.zone_price,
                    level_id=_payload_attr(mapped.payload, "level_id"),
                ),
                regime=_regime(signals),
                orderflow_snapshot=orderflow_snapshot,
                depth_snapshot=depth_snapshot,
                confluence_stack_size=_confluence_size(
                    mapped.zone_price,
                    recent,
                    state.config.max_price_distance,
                    mapped.family,
                ),
                payload=mapped.payload.model_dump(mode="json"),
                replay=_replay_context(state, step_ns=step_ns),
            )
        except ValidationError as exc:
            raise ValueError(f"Invalid replay dataset row for {event_type}") from exc
        rows.append(row)
    return rows


def _institutional_rows(
    state: _ReplayState,
    *,
    signals: LiveSignals,
    recent: list[RecentSignal],
    current_price: float | None,
    orderflow_snapshot: dict[str, Any] | None,
    depth_snapshot: dict[str, Any] | None,
    step_ns: int,
) -> list[SignalDatasetRow]:
    previous = state.previous_institutional_keys or set()
    rows: list[SignalDatasetRow] = []
    for event in signals.institutional_flow_events:
        if _institutional_key(event) in previous:
            continue
        side = event.side
        direction = "long" if side == "buy" else "short"
        price = event.level_price
        rows.append(
            SignalDatasetRow(
                ts_ns=_event_ts(event.timestamp_ns, step_ns),
                family="institutional_flow",
                event_type=event.event_type,
                tier=_tier_for_institutional(
                    event,
                    recent=recent,
                    current_price=current_price,
                    max_price_distance=state.config.max_price_distance,
                ),
                price=price,
                level_id=event.level_id,
                side=side,
                direction=direction,
                zone_context=_zone_context(state.envelope, price=price, level_id=event.level_id),
                regime=_regime(signals),
                orderflow_snapshot=orderflow_snapshot,
                depth_snapshot=depth_snapshot,
                confluence_stack_size=_confluence_size(
                    price,
                    recent,
                    state.config.max_price_distance,
                    "institutional_flow",
                ),
                payload=asdict(event),
                replay=_replay_context(state, step_ns=step_ns),
            )
        )
    return rows


def _depth_payload(state: _ReplayState, *, tick: Any, step_ns: int) -> Any:
    mid = resolve_depth_mid(tick)
    snapshot = state.depth_book.snapshot(mid=mid.mid, n_ticks=state.config.depth_n_ticks)
    quality = classify_depth_quality(
        has_book=state.depth_book.active_order_count > 0,
        book_ts_ns=state.depth_book.last_ts_ns,
        mid=mid,
        now_ns=step_ns,
        staleness_threshold_seconds=state.config.staleness_threshold_seconds,
    )
    return build_depth_payload(snapshot, quality=quality, ts_ns=state.depth_book.last_ts_ns)


def _write_outputs(state: _ReplayState) -> ReplayResult:
    rows = state.rows or []
    state.config.out_path.parent.mkdir(parents=True, exist_ok=True)
    dataset_text = "".join(canonical_json(row.model_dump(mode="json")) + "\n" for row in rows)
    state.config.out_path.write_text(dataset_text, encoding="utf-8")
    dataset_hash = sha256_text(dataset_text)
    manifest = DatasetManifest(
        capture_date=state.config.capture_date,
        session=state.config.session,
        row_count=len(rows),
        dataset_sha256=dataset_hash,
        settings={
            "mode": "parity",
            "step_ms": state.config.step_ms,
            "tail_bytes": state.config.tail_bytes,
            "default_tail_bytes": DEFAULT_TAIL_BYTES,
            "depth_n_ticks": state.config.depth_n_ticks,
            "max_price_distance": state.config.max_price_distance,
            "fresh_detector_state_per_session": True,
        },
        input_hashes=_input_hashes(state),
        seeded_files=state.seeded_files,
    )
    manifest_path = state.config.out_path.with_suffix(
        state.config.out_path.suffix + ".manifest.json"
    )
    manifest_path.write_text(
        canonical_json(manifest.model_dump(mode="json")) + "\n",
        encoding="utf-8",
    )
    return ReplayResult(
        out_path=state.config.out_path,
        manifest_path=manifest_path,
        row_count=len(rows),
        dataset_sha256=dataset_hash,
    )


def _input_hashes(state: _ReplayState) -> dict[str, str | None]:
    zones = (
        state.config.analytics_root
        / "data"
        / "zones"
        / f"{state.config.capture_date}_MNQ_{state.config.session}.json"
    )
    return {
        "raw": _hash_path(state.sources.raw_path),
        "trade": _hash_path(state.sources.trade_path),
        "mbo": _hash_path(state.sources.mbo_path),
        "zones": _hash_path(zones),
    }


def _hash_path(path: Path | None) -> str | None:
    if path is None or not path.exists():
        return None
    return sha256_file(path)


def _replay_context(state: _ReplayState, *, step_ns: int) -> ReplayContext:
    return ReplayContext(
        capture_date=state.config.capture_date,
        session=state.config.session,
        step_ns=step_ns,
        source_obs01=(
            str(state.sources.trade_path) if state.sources.trade_path is not None else None
        ),
        source_mbo=str(state.sources.mbo_path) if state.sources.mbo_path is not None else None,
    )


def _zone_context(
    envelope: dict[str, Any] | None,
    *,
    price: float | None,
    level_id: str | None,
) -> ZoneContext | None:
    levels = _zone_contexts(envelope)
    if not levels:
        return None
    if level_id is not None:
        for level in levels:
            if level.id == level_id:
                return level
    if price is None:
        return None
    return min(
        (
            ZoneContext(
                id=level.id,
                kind=level.kind,
                tier=level.tier,
                price=level.price,
                distance_pts=round(abs(level.price - price), 4),
            )
            for level in levels
        ),
        key=lambda level: (level.distance_pts, level.price),
        default=None,
    )


def _zone_contexts(envelope: dict[str, Any] | None) -> list[ZoneContext]:
    if not envelope:
        return []
    contexts: list[ZoneContext] = []
    for line in envelope.get("reference_lines", []):
        if not isinstance(line, dict):
            continue
        price = _float(line.get("price"))
        if price is None:
            continue
        source = str(line.get("source") or "reference")
        contexts.append(
            ZoneContext(
                id=f"ref-{source}-{price:.2f}",
                kind=source,
                tier=None,
                price=price,
                distance_pts=0.0,
            )
        )
    for idx, zone in enumerate(envelope.get("zones", [])):
        if not isinstance(zone, dict):
            continue
        top = _float(zone.get("top"))
        bottom = _float(zone.get("bottom"))
        price = _float(zone.get("price"))
        if price is None and top is not None and bottom is not None:
            price = (top + bottom) / 2.0
        if price is None:
            continue
        zone_id = str(zone.get("id") or f"zone-{idx}")
        tier = zone.get("conviction") or zone.get("tier")
        contexts.append(
            ZoneContext(
                id=zone_id,
                kind=str(zone.get("type") or zone.get("kind") or "zone"),
                tier=str(tier) if tier is not None else None,
                price=price,
                distance_pts=0.0,
            )
        )
    return contexts


def _confluence_size(
    price: float | None,
    recent: list[RecentSignal],
    max_distance: float,
    current_family: str,
) -> int:
    if price is None:
        return 1
    families = {current_family}
    for signal in recent:
        candidate = signal.level_price if signal.level_price is not None else signal.price
        if candidate is not None and abs(candidate - price) <= max_distance:
            families.add(signal.family)
    return max(1, len(families))


def _tier_for_institutional(
    event: InstitutionalFlowEvent,
    *,
    recent: list[RecentSignal],
    current_price: float | None,
    max_price_distance: float,
) -> Tier:
    mapped = MappedEvent(
        payload=SignalPayload(
            event_type=event.event_type,
            level_id=event.level_id,
            description=event.description,
            intensity=event.intensity,
            confidence="high" if event.confidence == "high" else "low",
            metadata={"family": "institutional_flow", "level_price": event.level_price},
        ),
        message_type="event",
        family="institutional_flow",
        zone_price=event.level_price,
        intensity=event.intensity,
        high_urgency=False,
    )
    return classify_tier(
        mapped,
        recent_signals=recent,
        current_price=current_price,
        max_price_distance=max_price_distance,
    )


def _institutional_keys(events: Iterable[InstitutionalFlowEvent]) -> set[tuple[Any, ...]]:
    return {_institutional_key(event) for event in events}


def _institutional_key(event: InstitutionalFlowEvent) -> tuple[Any, ...]:
    return (
        event.timestamp_ns,
        event.event_type,
        event.level_id,
        event.side,
        event.trade_count,
        event.institutional_volume,
    )


def _event_ts(value: int | None, fallback: int) -> int:
    return int(value) if value is not None else fallback


def _payload_attr(payload: Any, name: str) -> str | None:
    value = getattr(payload, name, None)
    return str(value) if value is not None else None


def _regime(signals: LiveSignals) -> str | None:
    return signals.volatility_regime.regime if signals.volatility_regime is not None else None


def _float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _ceil_to_step(ts_ns: int, step_ns: int) -> int:
    return ((ts_ns + step_ns - 1) // step_ns) * step_ns


def _hit_step_limit(state: _ReplayState) -> bool:
    limit = state.config.limit_steps
    return limit is not None and state.steps_run >= limit


__all__ = ["ReplayConfig", "ReplayResult", "run_replay"]
