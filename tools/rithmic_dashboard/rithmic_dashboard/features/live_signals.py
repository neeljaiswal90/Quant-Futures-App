"""Live bounded-tail intra-session signal computation."""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from rithmic_dashboard.features.absorption_proxy import (
    append_new_absorption_proxies,
    detect_absorption_proxies,
    load_absorption_proxy_events,
)
from rithmic_dashboard.features.aggressor_metrics import (
    append_footprint_bar,
    append_new_aggressor_flow_events,
    build_aggressor_events,
    build_footprint_bar,
    compute_aggressor_metrics,
    compute_v_delta,
    load_aggressor_flow_events,
    recent_aggressor_flow_events,
)
from rithmic_dashboard.features.delta_dislocation import (
    append_dislocation_alerts,
    append_new_delta_dislocations,
    detect_delta_dislocations,
    dislocation_levels,
    load_delta_dislocations,
)
from rithmic_dashboard.features.ewma_volatility import compute_ewma_volatility_regime
from rithmic_dashboard.features.institutional_flow import (
    append_new_institutional_flow_events,
    compute_institutional_flow,
    load_institutional_flow_events,
    recent_institutional_flow_events,
    summarize_institutional_flow,
)
from rithmic_dashboard.features.sweep_detector import append_new_sweeps, detect_sweeps, load_sweeps
from rithmic_dashboard.features.threshold_calibration import load_threshold
from rithmic_dashboard.features.trade_size_classifier import load_trade_size_thresholds
from rithmic_dashboard.models import (
    AbsorptionProxyEvent,
    DashboardSession,
    DataWarning,
    DeltaDislocationEvent,
    LiveCvd,
    LiveSignals,
    LiveVwap,
    SweepEvent,
    TradeTick,
    VolumeVelocity,
)
from rithmic_dashboard.session_state import PT

DEFAULT_TAIL_BYTES = 20_000_000
DEFAULT_VWAP_WINDOW_MINUTES = 60
DEFAULT_DISLOCATION_THRESHOLD = 500.0
MIN_CVD_TAIL_MINUTES = 55.0
TICK_SIZE = 0.25


def compute_live_signals(
    *,
    capture_path: Path,
    envelope: dict[str, Any] | None,
    session: DashboardSession,
    dashboard_dir: Path,
    ewma_calibration_path: Path | None = None,
    tail_bytes: int = DEFAULT_TAIL_BYTES,
    vwap_window_minutes: int = DEFAULT_VWAP_WINDOW_MINUTES,
) -> LiveSignals:
    """Compute live signals from a bounded tail of the active capture."""

    warnings: list[DataWarning] = []
    tick_source_path = _trade_tail_source_path(capture_path)
    ticks = load_trade_ticks_from_tail(tick_source_path, tail_bytes=tail_bytes, warnings=warnings)
    tail_span = _tail_span_minutes(ticks)
    if tick_source_path != capture_path:
        warnings.append(
            DataWarning("info", f"Live signals using normalized trade tail: {tick_source_path}")
        )
    if ticks and tail_span < MIN_CVD_TAIL_MINUTES:
        warnings.append(
            DataWarning(
                "warn",
                (
                    f"Live trade tail spans only {tail_span:.1f}min; "
                    "60m CVD/dislocation signals may be under-covered."
                ),
            )
        )
    now = session.now_pt
    live_dir = dashboard_dir.parent / "live_analysis"
    live_dir.mkdir(parents=True, exist_ok=True)
    prefix = f"{session.trading_date}_{session.session}"
    sweep_path = live_dir / f"{prefix}_sweeps.jsonl"
    absorption_path = live_dir / f"{prefix}_absorption_proxy.jsonl"
    dislocation_path = live_dir / f"{prefix}_delta_dislocations.jsonl"
    dislocation_alert_path = live_dir / f"{prefix}_delta_dislocation_alerts.jsonl"
    institutional_flow_path = live_dir / f"{prefix}_institutional_flow.jsonl"
    aggressor_flow_path = live_dir / f"{prefix}_aggressor_flow.jsonl"
    aggressor_state_path = live_dir / f"{prefix}_aggressor_flow_state.json"
    footprint_path = live_dir / f"{prefix}_footprint.jsonl"
    cvd_path = live_dir / f"{prefix}_cvd.jsonl"

    live_vwap = _live_vwap(ticks, window_minutes=vwap_window_minutes)
    levels = structural_levels(envelope or {})
    detected_sweeps = detect_sweeps(ticks, levels)
    append_new_sweeps(sweep_path, detected_sweeps)
    persisted_sweeps = _recent_sweeps(load_sweeps(sweep_path), now, minutes=60)

    prior_absorption = load_absorption_proxy_events(absorption_path)
    detected_absorption = detect_absorption_proxies(ticks, prior_events=prior_absorption)
    append_new_absorption_proxies(absorption_path, detected_absorption)
    persisted_absorption = _recent_absorption(
        load_absorption_proxy_events(absorption_path),
        now,
        minutes=60,
    )

    threshold = _dislocation_threshold(
        live_dir / "dislocation_thresholds.json",
        envelope or {},
        warnings,
    )
    detected_dislocations = detect_delta_dislocations(
        ticks,
        dislocation_levels(envelope or {}, live_vwap=live_vwap),
        threshold=threshold,
        live_vwap=live_vwap,
        atr=_float((envelope or {}).get("atr_14")),
    )
    new_dislocations = append_new_delta_dislocations(dislocation_path, detected_dislocations)
    append_dislocation_alerts(dislocation_alert_path, new_dislocations)
    persisted_dislocations = _recent_delta_dislocations(
        load_delta_dislocations(dislocation_path),
        now,
        minutes=60,
    )

    thresholds = load_trade_size_thresholds(
        live_dir / "trade_size_thresholds.json",
        symbol=str((envelope or {}).get("symbol") or "MNQ"),
    )
    institutional_result = compute_institutional_flow(
        ticks,
        levels,
        thresholds=thresholds,
        tail_span_minutes=tail_span,
    )
    append_new_institutional_flow_events(
        institutional_flow_path,
        institutional_result.events,
    )
    persisted_institutional_events = recent_institutional_flow_events(
        load_institutional_flow_events(institutional_flow_path),
        now,
        minutes=60,
    )[:12]
    institutional_summary = summarize_institutional_flow(persisted_institutional_events)
    aggressor_windows = compute_aggressor_metrics(ticks)
    v_delta, v_delta_event = compute_v_delta(ticks, state_path=aggressor_state_path)
    footprint_bar = build_footprint_bar(ticks)
    append_footprint_bar(footprint_path, footprint_bar)
    aggressor_events = build_aggressor_events(
        windows=aggressor_windows,
        footprint_bar=footprint_bar,
        v_delta_event=v_delta_event,
        timestamp_ns=ticks[-1].timestamp_ns if ticks else None,
    )
    append_new_aggressor_flow_events(aggressor_flow_path, aggressor_events)
    persisted_aggressor_events = recent_aggressor_flow_events(
        load_aggressor_flow_events(aggressor_flow_path),
        now,
        minutes=60,
    )
    volatility_regime = None
    if ewma_calibration_path is not None:
        volatility_regime = compute_ewma_volatility_regime(
            session=session,
            ticks=ticks,
            live_dir=live_dir,
            calibration_path=ewma_calibration_path,
        )

    cvd = _live_cvd(ticks)
    velocity = _volume_velocity(ticks)
    signals = LiveSignals(
        trading_date=session.trading_date,
        session=session.session,
        computed_at_pt=now.strftime("%Y-%m-%d %H:%M:%S PT"),
        source_path=tick_source_path,
        tail_bytes=tail_bytes,
        trade_count=len(ticks),
        live_vwap=live_vwap,
        cvd=cvd,
        velocity=velocity,
        sweeps=tuple(persisted_sweeps),
        absorption_proxies=tuple(persisted_absorption),
        delta_dislocations=tuple(persisted_dislocations),
        institutional_flow_events=tuple(persisted_institutional_events),
        institutional_flow_summary=institutional_summary,
        volatility_regime=volatility_regime,
        aggressor_windows=aggressor_windows,
        v_delta=v_delta,
        footprint_bar=footprint_bar,
        aggressor_flow_events=tuple(persisted_aggressor_events),
        warnings=tuple(warnings),
    )
    _append_cvd_reading(cvd_path, signals)
    return signals


def load_trade_ticks_from_tail(
    capture_path: Path,
    *,
    tail_bytes: int = DEFAULT_TAIL_BYTES,
    warnings: list[DataWarning] | None = None,
) -> list[TradeTick]:
    """Parse recent LAST_TRADE/OBS rows from a bounded tail."""

    if not capture_path.exists():
        if warnings is not None:
            warnings.append(
                DataWarning("warn", f"Live signals unavailable; missing {capture_path}")
            )
        return []
    size = capture_path.stat().st_size
    seek_pos = max(0, size - tail_bytes)
    with capture_path.open("rb") as f:
        f.seek(seek_pos)
        text = f.read().decode("utf-8", errors="ignore")
    lines = text.splitlines()
    if seek_pos > 0 and lines:
        lines = lines[1:]
    ticks: list[TradeTick] = []
    for raw in lines:
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        tick = _trade_tick(rec)
        if tick is not None:
            ticks.append(tick)
    return sorted(ticks, key=lambda tick: tick.timestamp_ns or 0)


def _trade_tail_source_path(capture_path: Path) -> Path:
    """Prefer normalized OBS trade tails over raw mixed-stream captures."""

    if capture_path.name.endswith(".jsonl"):
        obs_path = capture_path.with_name(f"{capture_path.name.removesuffix('.jsonl')}.obs01.jsonl")
        if obs_path.exists() and obs_path.stat().st_size > 0:
            return obs_path
    return capture_path


def _tail_span_minutes(ticks: list[TradeTick]) -> float:
    if len(ticks) < 2:
        return 0.0
    first = ticks[0].timestamp_ns
    last = ticks[-1].timestamp_ns
    if first is None or last is None or last <= first:
        return 0.0
    return (last - first) / 60_000_000_000


def structural_levels(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    """Return levels eligible for live sweep detection."""

    levels: list[dict[str, Any]] = []
    for line in envelope.get("reference_lines", []):
        if not isinstance(line, dict):
            continue
        source = str(line.get("source", ""))
        if source not in {"vpoc", "vah", "val"} and "vwap" not in source:
            continue
        price = _float(line.get("price"))
        if price is None:
            continue
        levels.append(
            {
                "level_id": f"ref-{source}-{price:.2f}",
                "text": str(line.get("text", source)),
                "source": source,
                "price": price,
            }
        )
    for zone in envelope.get("zones", []):
        if not isinstance(zone, dict) or zone.get("conviction") not in {"HIGH", "SUPER"}:
            continue
        top = _float(zone.get("top"))
        bot = _float(zone.get("bot"))
        if top is None or bot is None:
            continue
        price = (top + bot) / 2.0
        levels.append(
            {
                "level_id": str(zone.get("id", f"zone-{price:.2f}")),
                "text": str(zone.get("text", "HIGH/SUPER zone")),
                "source": "zone",
                "price": price,
            }
        )
    return _dedupe_levels(levels)


def _trade_tick(rec: dict[str, Any]) -> TradeTick | None:
    raw_payload = rec.get("payload")
    payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}
    stream = rec.get("stream")
    event_type = rec.get("type")
    if stream not in {"LAST_TRADE", "TRADE"} and event_type != "TRADE" and "price" not in rec:
        return None
    price = _float(rec.get("price", payload.get("price")))
    quantity = _int(
        rec.get(
            "size",
            rec.get("quantity", rec.get("qty", payload.get("quantity", payload.get("size")))),
        )
    )
    ts = _int(_first_present(rec, payload, "exchange_event_ts_ns", "ts_event_ns", "ts_ns"))
    if ts is None:
        ts = _int(rec.get("sidecar_recv_ts_ns"))
    if price is None or quantity is None or quantity <= 0 or ts is None:
        return None
    return TradeTick(
        timestamp_ns=ts,
        price=price,
        quantity=quantity,
        aggressor_side=_aggressor(
            rec.get("aggressor", rec.get("aggressor_side", payload.get("aggressor_side")))
        ),
    )


def _live_vwap(ticks: list[TradeTick], *, window_minutes: int) -> LiveVwap:
    recent = _ticks_within(ticks, minutes=window_minutes)
    if not recent:
        return LiveVwap(window_minutes, None, None, None, None)
    total_qty = sum(max(0, tick.quantity) for tick in recent)
    if total_qty <= 0:
        return LiveVwap(window_minutes, None, None, None, None)
    vwap = sum(tick.price * tick.quantity for tick in recent) / total_qty
    variance = sum(tick.quantity * (tick.price - vwap) ** 2 for tick in recent) / total_qty
    sigma = math.sqrt(max(0.0, variance))
    return LiveVwap(
        window_minutes=window_minutes,
        vwap=vwap,
        sigma=sigma,
        plus_1sd=vwap + sigma,
        minus_1sd=vwap - sigma,
    )


def _live_cvd(ticks: list[TradeTick]) -> LiveCvd:
    if not ticks:
        return LiveCvd(None, None, None, "unknown", "unknown", False)
    signed = [(tick.timestamp_ns or 0, _signed_qty(tick)) for tick in ticks]
    session_cvd = sum(value for _, value in signed)
    last_60m = sum(_signed_qty(tick) for tick in _ticks_within(ticks, minutes=60))
    last_15m = sum(_signed_qty(tick) for tick in _ticks_within(ticks, minutes=15))
    session_direction = _direction(session_cvd)
    last_15m_direction = _direction(last_15m)
    flip = (
        session_direction in {"bullish", "bearish"}
        and last_15m_direction in {"bullish", "bearish"}
        and session_direction != last_15m_direction
    )
    return LiveCvd(session_cvd, last_60m, last_15m, session_direction, last_15m_direction, flip)


def _volume_velocity(ticks: list[TradeTick]) -> VolumeVelocity:
    if not ticks:
        return VolumeVelocity(0, None, None, None, "unknown")
    latest = ticks[-1].timestamp_ns or 0
    cutoff = latest - int(timedelta(minutes=15).total_seconds() * 1_000_000_000)
    recent = [tick for tick in ticks if (tick.timestamp_ns or 0) >= cutoff]
    prior = [tick for tick in ticks if (tick.timestamp_ns or 0) < cutoff]
    recent_rate = len(recent) / 15.0
    if prior:
        duration_ns = (prior[-1].timestamp_ns or 0) - (prior[0].timestamp_ns or 0)
        duration_min = max(1.0, duration_ns / 60_000_000_000)
        baseline = len(prior) / duration_min
    else:
        span_ns = (ticks[-1].timestamp_ns or 0) - (ticks[0].timestamp_ns or 0)
        span_min = max(1.0, span_ns / 60_000_000_000)
        baseline = len(ticks) / span_min
    if baseline <= 0:
        return VolumeVelocity(len(recent), recent_rate, None, None, "unknown")
    ratio = recent_rate / baseline
    state: Literal["active", "normal", "quiet"] = (
        "active" if ratio > 1.5 else "quiet" if ratio < 0.7 else "normal"
    )
    return VolumeVelocity(len(recent), recent_rate, baseline, ratio, state)


def _ticks_within(ticks: list[TradeTick], *, minutes: int) -> list[TradeTick]:
    if not ticks:
        return []
    latest = ticks[-1].timestamp_ns or 0
    cutoff = latest - int(timedelta(minutes=minutes).total_seconds() * 1_000_000_000)
    return [tick for tick in ticks if (tick.timestamp_ns or 0) >= cutoff]


def _recent_sweeps(events: list[SweepEvent], now: datetime, *, minutes: int) -> list[SweepEvent]:
    cutoff = now.astimezone(PT) - timedelta(minutes=minutes)
    return [
        event
        for event in events
        if event.timestamp_ns is None or _event_time(event.timestamp_ns) >= cutoff
    ][-12:]


def _recent_absorption(
    events: list[AbsorptionProxyEvent],
    now: datetime,
    *,
    minutes: int,
) -> list[AbsorptionProxyEvent]:
    cutoff = now.astimezone(PT) - timedelta(minutes=minutes)
    return [
        event
        for event in events
        if event.timestamp_ns is None or _event_time(event.timestamp_ns) >= cutoff
    ][-12:]


def _recent_delta_dislocations(
    events: list[DeltaDislocationEvent],
    now: datetime,
    *,
    minutes: int,
) -> list[DeltaDislocationEvent]:
    cutoff = now.astimezone(PT) - timedelta(minutes=minutes)
    return [
        event
        for event in events
        if event.timestamp_ns is None or _event_time(event.timestamp_ns) >= cutoff
    ][-12:]


def _append_cvd_reading(path: Path, signals: LiveSignals) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "computed_at_pt": signals.computed_at_pt,
        "trade_count": signals.trade_count,
        "session_cvd": signals.cvd.session_cvd,
        "last_60m_cvd": signals.cvd.last_60m_cvd,
        "last_15m_cvd": signals.cvd.last_15m_cvd,
        "velocity_state": signals.velocity.state,
        "velocity_ratio": signals.velocity.ratio,
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")


def _dislocation_threshold(
    path: Path,
    envelope: dict[str, Any],
    warnings: list[DataWarning],
) -> float:
    symbol = str(envelope.get("symbol") or "MNQ")
    threshold = load_threshold(path, symbol=symbol)
    if threshold is None:
        warnings.append(
            DataWarning(
                "warn",
                (
                    f"Dislocation threshold missing for {symbol}; "
                    f"using {DEFAULT_DISLOCATION_THRESHOLD:.0f}."
                ),
            )
        )
        return DEFAULT_DISLOCATION_THRESHOLD
    return threshold


def _dedupe_levels(levels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, int]] = set()
    deduped: list[dict[str, Any]] = []
    for level in levels:
        source = str(level.get("source", ""))
        price = _float(level.get("price"))
        if price is None:
            continue
        key = (source, round(price / TICK_SIZE))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(level)
    return deduped


def _signed_qty(tick: TradeTick) -> int:
    if tick.aggressor_side == "buy":
        return tick.quantity
    if tick.aggressor_side == "sell":
        return -tick.quantity
    return 0


def _event_time(ts_ns: int) -> datetime:
    return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC).astimezone(PT)


def _first_present(rec: dict[str, Any], payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if rec.get(key) is not None:
            return rec.get(key)
        if payload.get(key) is not None:
            return payload.get(key)
    return None


def _direction(value: int) -> Literal["bullish", "bearish", "neutral"]:
    if value >= 500:
        return "bullish"
    if value <= -500:
        return "bearish"
    return "neutral"


def _aggressor(value: Any) -> Literal["buy", "sell", "unknown"]:
    raw = str(value or "").lower()
    if raw in {"b", "buy", "bid", "buyer", "aggressor_buy"}:
        return "buy"
    if raw in {"s", "sell", "ask", "seller", "aggressor_sell"}:
        return "sell"
    return "unknown"


def _float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
