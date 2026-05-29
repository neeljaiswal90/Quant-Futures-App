"""Orderflow pulse synthesized from completed analytics artifacts."""

from __future__ import annotations

import json
import math
from collections import deque
from collections.abc import Iterable, Mapping
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from rithmic_dashboard.features.institutional_flow import (
    load_institutional_flow_events,
    summarize_institutional_flow,
)
from rithmic_dashboard.models import (
    DashboardSession,
    DataWarning,
    InstitutionalFlowSummary,
    OrderflowPulse,
    SpoofBin,
)
from rithmic_dashboard.session_state import PT
from rithmic_dashboard.state_store import load_json_state, save_json_state

TICK_SIZE = 0.25
MAX_MBP1_TAIL_BYTES = 2_000_000
MIN_SPOOF_EVENTS = 25


def compute_orderflow_pulse(
    *,
    analytics_root: Path,
    dashboard_dir: Path,
    session: DashboardSession,
    zones_path: Path | None,
) -> OrderflowPulse:
    """Compute a compact pulse from existing OBS/MBP1/absorption/pressure artifacts."""

    artifact_date, artifact_session = _artifact_context(
        analytics_root=analytics_root,
        zones_path=zones_path,
        session=session,
    )
    paths = _artifact_paths(analytics_root, artifact_date, artifact_session)
    warnings: list[DataWarning] = []
    cache_path = dashboard_dir / "_orderflow_cache.json"
    cache = load_json_state(cache_path, {})
    cache_key = f"{artifact_date}_{artifact_session}"
    signature = _signature(paths)
    cached = cache.get(cache_key)
    if isinstance(cached, dict) and cached.get("signature") == signature:
        return _pulse_from_cache(cached, artifact_date, artifact_session)

    trade_stats = _compute_trade_stats(paths["obs"], warnings)
    spread_stats = _compute_spread_stats(paths["mbp1"], warnings)
    recent_absorption = _recent_absorption(paths["absorption"], warnings)
    top_spoof_bins, pressure_status = _top_spoof_bins(paths["pressure_summary"], warnings)
    institutional_summary = summarize_institutional_flow(
        load_institutional_flow_events(paths["institutional_flow"])
    )

    pulse = OrderflowPulse(
        artifact_date=artifact_date,
        artifact_session=artifact_session,
        session_cvd=_cached_int(trade_stats, "session_cvd"),
        last_60m_cvd=_cached_int(trade_stats, "last_60m_cvd"),
        buy_volume_pct=trade_stats.get("buy_volume_pct") if trade_stats else None,
        spread_mean_ticks=spread_stats.get("mean_ticks") if spread_stats else None,
        spread_p99_ticks=spread_stats.get("p99_ticks") if spread_stats else None,
        crossed_quotes=_cached_int(spread_stats, "crossed_quotes"),
        recent_absorption=recent_absorption,
        top_spoof_bins=tuple(top_spoof_bins),
        pressure_status=pressure_status,
        institutional_flow_summary=institutional_summary,
        warnings=tuple(warnings),
    )
    cache[cache_key] = {"signature": signature, "pulse": _dump_pulse(pulse)}
    save_json_state(cache_path, cache)
    return pulse


def _artifact_context(
    *,
    analytics_root: Path,
    zones_path: Path | None,
    session: DashboardSession,
) -> tuple[str, str]:
    if zones_path is None:
        return session.trading_date, session.session if session.session != "between" else "rth"
    parsed = _parse_zone_name(zones_path.name)
    if parsed is None:
        return session.trading_date, session.session if session.session != "between" else "rth"
    date, zone_session = parsed
    if zone_session == "session_combined":
        rth_obs = analytics_root / "data" / "captures" / date / "MNQ_rth.obs01.jsonl"
        globex_obs = analytics_root / "data" / "captures" / date / "MNQ_globex.obs01.jsonl"
        if rth_obs.exists():
            return date, "rth"
        if globex_obs.exists():
            return date, "globex"
        return date, "rth"
    if zone_session.endswith("_live"):
        zone_session = zone_session.removesuffix("_live")
    return date, zone_session


def _parse_zone_name(name: str) -> tuple[str, str] | None:
    if not name.endswith(".json") or "_MNQ_" not in name:
        return None
    date_part, rest = name.removesuffix(".json").split("_MNQ_", 1)
    return date_part, rest


def _artifact_paths(analytics_root: Path, date: str, session: str) -> dict[str, Path]:
    return {
        "obs": analytics_root / "data" / "captures" / date / f"MNQ_{session}.obs01.jsonl",
        "mbp1": analytics_root / "data" / "captures" / date / f"MNQ_{session}.mbp1.jsonl",
        "absorption": analytics_root / "data" / "absorption" / f"{date}_MNQ_{session}.json",
        "pressure_summary": analytics_root
        / "data"
        / "order_pressure"
        / f"{date}_MNQ_{session}_summary.json",
        "institutional_flow": analytics_root
        / "data"
        / "live_analysis"
        / f"{date}_{session}_institutional_flow.jsonl",
    }


def _signature(paths: dict[str, Path]) -> dict[str, dict[str, int | bool]]:
    return {name: _file_signature(path) for name, path in paths.items()}


def _file_signature(path: Path) -> dict[str, int | bool]:
    if not path.exists():
        return {"exists": False, "size": 0, "mtime_ns": 0}
    stat = path.stat()
    return {"exists": True, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def _compute_trade_stats(
    path: Path,
    warnings: list[DataWarning],
) -> dict[str, float | int | None] | None:
    if not path.exists():
        warnings.append(DataWarning("warn", f"CVD unavailable; missing OBS file: {path}"))
        return None
    session_cvd = 0
    buy_qty = 0
    sell_qty = 0
    last_hour: deque[tuple[int, int]] = deque()
    for rec in _iter_jsonl(path):
        payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else rec
        if not isinstance(payload, dict):
            continue
        ts = _int(payload.get("exchange_event_ts_ns") or rec.get("ts_ns"))
        side = str(payload.get("aggressor_side", "")).lower()
        qty = _int(payload.get("quantity")) or 0
        if ts is None or qty <= 0:
            continue
        signed = qty if side == "buy" else -qty if side == "sell" else 0
        session_cvd += signed
        if side == "buy":
            buy_qty += qty
        elif side == "sell":
            sell_qty += qty
        last_hour.append((ts, signed))
        cutoff = ts - int(timedelta(minutes=60).total_seconds() * 1_000_000_000)
        while last_hour and last_hour[0][0] < cutoff:
            last_hour.popleft()
    denom = buy_qty + sell_qty
    return {
        "session_cvd": session_cvd,
        "last_60m_cvd": sum(signed for _, signed in last_hour),
        "buy_volume_pct": buy_qty / denom if denom else None,
    }


def _compute_spread_stats(path: Path, warnings: list[DataWarning]) -> dict[str, float | int] | None:
    if not path.exists():
        warnings.append(DataWarning("warn", f"Spread unavailable; missing MBP1 file: {path}"))
        return None
    spreads: list[float] = []
    crossed = 0
    for rec in _iter_tail_jsonl(path, MAX_MBP1_TAIL_BYTES):
        bid = _float(rec.get("bid_px_00"))
        ask = _float(rec.get("ask_px_00"))
        if bid is None or ask is None or bid <= 0 or ask <= 0:
            continue
        if ask < bid:
            crossed += 1
            continue
        spreads.append((ask - bid) / TICK_SIZE)
    if not spreads:
        warnings.append(
            DataWarning("warn", f"Spread unavailable; no two-sided MBP1 rows in {path}")
        )
        return None
    spreads.sort()
    return {
        "mean_ticks": sum(spreads) / len(spreads),
        "p99_ticks": _percentile(spreads, 0.99),
        "crossed_quotes": crossed,
    }


def _recent_absorption(path: Path, warnings: list[DataWarning]) -> str | None:
    if not path.exists():
        warnings.append(DataWarning("warn", f"Absorption unavailable; missing artifact: {path}"))
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        warnings.append(DataWarning("warn", f"Absorption unavailable; could not parse {path}"))
        return None
    if not isinstance(data, list) or not data:
        return "none emitted"
    rows = [row for row in data if isinstance(row, dict)]
    if not rows:
        return "none emitted"
    row = max(rows, key=lambda item: _int(item.get("end_ts_ns"), default=0) or 0)
    price = _float(row.get("dominant_price") or row.get("price_center"))
    score = _float(row.get("score"))
    side = str(row.get("side", "unknown"))
    ts = _int(row.get("end_ts_ns"))
    ts_text = _fmt_ts(ts)
    if price is None or score is None:
        return f"{side} at {ts_text}"
    return f"{price:,.2f} score {score:.2f} {side} at {ts_text}"


def _top_spoof_bins(
    path: Path,
    warnings: list[DataWarning],
) -> tuple[list[SpoofBin], str]:
    if not path.exists():
        return [], "n/a - summary missing"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        warnings.append(DataWarning("warn", f"Pressure unavailable; could not parse {path}"))
        return [], "n/a - parse failed"
    if not isinstance(data, dict):
        return [], "n/a - unexpected schema"
    bins: list[SpoofBin] = []
    for raw_price, raw_stats in data.items():
        if not isinstance(raw_stats, dict):
            continue
        price = _float(raw_price)
        score = _float(raw_stats.get("max_spoof_score"))
        adds = _int(raw_stats.get("n_adds_total"), default=0) or 0
        cancels = _int(raw_stats.get("n_cancels_total"), default=0) or 0
        fills = _int(raw_stats.get("n_fills_total"), default=0) or 0
        n_events = adds + cancels + fills
        if price is None or score is None or not 10_000 <= price <= 50_000:
            continue
        if n_events < MIN_SPOOF_EVENTS:
            continue
        bins.append(SpoofBin(price=price, n_events=n_events, spoof_score=score))
    bins.sort(key=lambda item: (item.spoof_score, item.n_events), reverse=True)
    return bins[:3], f"ok - {len(data):,} bins"


def _pulse_from_cache(
    cached: dict[str, Any],
    artifact_date: str,
    artifact_session: str,
) -> OrderflowPulse:
    raw = cached.get("pulse")
    pulse = raw if isinstance(raw, dict) else {}
    return OrderflowPulse(
        artifact_date=artifact_date,
        artifact_session=artifact_session,
        session_cvd=_int(pulse.get("session_cvd")),
        last_60m_cvd=_int(pulse.get("last_60m_cvd")),
        buy_volume_pct=_float(pulse.get("buy_volume_pct")),
        spread_mean_ticks=_float(pulse.get("spread_mean_ticks")),
        spread_p99_ticks=_float(pulse.get("spread_p99_ticks")),
        crossed_quotes=_int(pulse.get("crossed_quotes")),
        recent_absorption=pulse.get("recent_absorption"),
        top_spoof_bins=tuple(SpoofBin(**item) for item in pulse.get("top_spoof_bins", [])),
        pressure_status=str(pulse.get("pressure_status", "n/a")),
        institutional_flow_summary=_institutional_summary_from_cache(
            pulse.get("institutional_flow_summary")
        ),
        warnings=tuple(
            DataWarning(**item)
            for item in pulse.get("warnings", [])
            if isinstance(item, dict)
        ),
    )


def _dump_pulse(pulse: OrderflowPulse) -> dict[str, Any]:
    return {
        "artifact_date": pulse.artifact_date,
        "artifact_session": pulse.artifact_session,
        "session_cvd": pulse.session_cvd,
        "last_60m_cvd": pulse.last_60m_cvd,
        "buy_volume_pct": pulse.buy_volume_pct,
        "spread_mean_ticks": pulse.spread_mean_ticks,
        "spread_p99_ticks": pulse.spread_p99_ticks,
        "crossed_quotes": pulse.crossed_quotes,
        "recent_absorption": pulse.recent_absorption,
        "top_spoof_bins": [asdict(item) for item in pulse.top_spoof_bins],
        "pressure_status": pulse.pressure_status,
        "institutional_flow_summary": (
            asdict(pulse.institutional_flow_summary)
            if pulse.institutional_flow_summary is not None
            else None
        ),
        "warnings": [asdict(item) for item in pulse.warnings],
    }


def _institutional_summary_from_cache(value: Any) -> InstitutionalFlowSummary | None:
    if not isinstance(value, dict):
        return None
    try:
        return InstitutionalFlowSummary(
            total_institutional_volume=int(value["total_institutional_volume"]),
            net_institutional_delta=int(value["net_institutional_delta"]),
            block_trade_count=int(value["block_trade_count"]),
            concentration_count=int(value["concentration_count"]),
            top_zone_text=value.get("top_zone_text"),
            top_zone_price=_float(value.get("top_zone_price")),
            top_zone_volume_pct=_float(value.get("top_zone_volume_pct")),
            latest_event=value.get("latest_event"),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _cached_int(data: Mapping[str, float | int | None] | None, key: str) -> int | None:
    if data is None:
        return None
    value = data.get(key)
    return int(value) if isinstance(value, int) else None


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for raw in f:
            if not raw.strip():
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict):
                yield rec


def _iter_tail_jsonl(path: Path, tail_bytes: int) -> Iterable[dict[str, Any]]:
    size = path.stat().st_size
    seek_pos = max(0, size - tail_bytes)
    with path.open("rb") as f:
        f.seek(seek_pos)
        text = f.read().decode("utf-8", errors="ignore")
    lines = text.splitlines()
    if seek_pos > 0:
        lines = lines[1:]
    for raw in lines:
        if not raw.strip():
            continue
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            yield rec


def _percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    idx = min(len(values) - 1, max(0, math.ceil(q * len(values)) - 1))
    return values[idx]


def _fmt_ts(ts_ns: int | None) -> str:
    if ts_ns is None:
        return "unknown"
    return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC).astimezone(PT).strftime("%H:%M PT")


def _int(value: Any, default: int | None = None) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None
