"""First-30-minute session signal matrix."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from rithmic_dashboard.models import SessionSignals


def compute_session_signals(
    envelope: dict[str, Any],
    capture_file: Path,
    current_price: float,
    session_start: datetime,
) -> SessionSignals | None:
    """Compute first-30-minute signals, or ``None`` outside the window."""

    now = datetime.now(session_start.tzinfo)
    if not session_start <= now < session_start + timedelta(minutes=30):
        return None
    records = list(
        _iter_trade_records(capture_file, session_start, session_start + timedelta(minutes=30))
    )
    if not records:
        return None

    open_print = records[0]["price"]
    ref = _line(envelope, "vpoc", default=current_price)
    vwap = _vwap(records)
    net_cvd = _net_cvd(records)
    lower_low, lower_high = _lower_confluence(envelope)
    upper_low, upper_high = _upper_confluence(envelope)
    return SessionSignals(
        open_print=open_print,
        open_vs_close_ref=_compare(open_print, ref),
        first_30min_vwap=vwap,
        first_30min_vwap_vs_threshold=_vwap_bias(vwap, ref),
        net_cvd_30min=net_cvd,
        cvd_direction=_cvd_direction(net_cvd),
        first_test_of_lower_confluence=any(lower_low <= r["price"] <= lower_high for r in records),
        first_test_of_upper_confluence=any(upper_low <= r["price"] <= upper_high for r in records),
        captured_at_pt=now,
    )


def compute_session_signals_for_window(
    envelope: dict[str, Any],
    capture_file: Path,
    session_start: datetime,
) -> SessionSignals | None:
    """Test-friendly variant that always evaluates the first 30-minute window."""

    records = list(
        _iter_trade_records(capture_file, session_start, session_start + timedelta(minutes=30))
    )
    if not records:
        return None
    open_print = records[0]["price"]
    ref = _line(envelope, "vpoc", default=open_print)
    vwap = _vwap(records)
    net_cvd = _net_cvd(records)
    lower_low, lower_high = _lower_confluence(envelope)
    upper_low, upper_high = _upper_confluence(envelope)
    return SessionSignals(
        open_print=open_print,
        open_vs_close_ref=_compare(open_print, ref),
        first_30min_vwap=vwap,
        first_30min_vwap_vs_threshold=_vwap_bias(vwap, ref),
        net_cvd_30min=net_cvd,
        cvd_direction=_cvd_direction(net_cvd),
        first_test_of_lower_confluence=any(lower_low <= r["price"] <= lower_high for r in records),
        first_test_of_upper_confluence=any(upper_low <= r["price"] <= upper_high for r in records),
        captured_at_pt=session_start + timedelta(minutes=30),
    )


def _iter_trade_records(
    path: Path,
    start: datetime,
    end: datetime,
    *,
    max_lines: int = 200_000,
    max_bytes: int = 1_000_000,
) -> Iterator[dict[str, Any]]:
    if not path.exists():
        return
    start_ns = int(start.astimezone(UTC).timestamp() * 1_000_000_000)
    end_ns = int(end.astimezone(UTC).timestamp() * 1_000_000_000)
    bytes_read = 0
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for idx, raw in enumerate(f):
            if idx >= max_lines:
                break
            bytes_read += len(raw.encode("utf-8", errors="ignore"))
            if bytes_read > max_bytes:
                break
            if not raw.strip():
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            trade = _extract_trade(rec)
            if trade is None:
                continue
            ts = trade["ts_ns"]
            if ts < start_ns:
                continue
            if ts > end_ns:
                break
            yield trade


def _extract_trade(rec: dict[str, Any]) -> dict[str, Any] | None:
    raw_payload = rec.get("payload")
    payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}
    if rec.get("stream") not in {"LAST_TRADE", "TRADE"} and rec.get("type") != "TRADE":
        return None
    raw_price = rec.get("price", payload.get("price"))
    raw_qty = rec.get("quantity", payload.get("quantity", 1))
    raw_side = rec.get("aggressor_side", payload.get("aggressor_side", "unknown"))
    raw_ts = (
        rec.get("exchange_event_ts_ns")
        or rec.get("ts_ns")
        or rec.get("ts_event_ns")
        or payload.get("exchange_event_ts_ns")
    )
    if raw_price is None or raw_ts is None:
        return None
    try:
        return {
            "price": float(raw_price),
            "quantity": int(raw_qty),
            "aggressor_side": str(raw_side),
            "ts_ns": int(raw_ts),
        }
    except (TypeError, ValueError):
        return None


def _vwap(records: list[dict[str, Any]]) -> float | None:
    denom = sum(int(r["quantity"]) for r in records)
    if denom <= 0:
        return None
    return sum(float(r["price"]) * int(r["quantity"]) for r in records) / denom


def _net_cvd(records: list[dict[str, Any]]) -> int:
    total = 0
    for record in records:
        qty = int(record["quantity"])
        side = str(record["aggressor_side"]).lower()
        if side == "buy":
            total += qty
        elif side == "sell":
            total -= qty
    return total


def _cvd_direction(net_cvd: int | None) -> Literal["bull", "bear", "neutral"]:
    if net_cvd is None:
        return "neutral"
    if net_cvd >= 500:
        return "bull"
    if net_cvd <= -500:
        return "bear"
    return "neutral"


def _vwap_bias(vwap: float | None, ref: float) -> Literal["bull", "bear", "neutral"]:
    if vwap is None or abs(vwap - ref) < 1.0:
        return "neutral"
    return "bull" if vwap > ref else "bear"


def _compare(price: float, ref: float) -> Literal["above", "below", "at"]:
    if abs(price - ref) < 0.25:
        return "at"
    return "above" if price > ref else "below"


def _lower_confluence(envelope: dict[str, Any]) -> tuple[float, float]:
    vpoc = _line(envelope, "vpoc", default=_number(envelope.get("vpoc"), 0.0))
    minus = _line(envelope, "_band_m1sd", default=vpoc)
    center = min(vpoc, minus)
    return center - 5.0, max(vpoc, minus) + 5.0


def _upper_confluence(envelope: dict[str, Any]) -> tuple[float, float]:
    vah = _line(envelope, "vah", default=_number(envelope.get("vah"), 0.0))
    plus = _line(envelope, "_band_p1sd", default=vah)
    center = max(vah, plus)
    return min(vah, plus) - 5.0, center + 5.0


def _line(envelope: dict[str, Any], source_fragment: str, *, default: float) -> float:
    for line in envelope.get("reference_lines", []):
        if isinstance(line, dict) and source_fragment in str(line.get("source", "")):
            return _number(line.get("price"), default)
    return default


def _number(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed
