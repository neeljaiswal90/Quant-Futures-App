"""Latest-trade price tick extraction for the realtime backend.

The detector stack computes signals over bounded tails, but the v2 chart needs
a separate market-time trade tick so it can update lightweight-charts without a
full snapshot redraw. This module intentionally stays backend-local and does
not change the frozen wire contract.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_TRADE_BBO_DEVIATION_POINTS = 5.0


@dataclass(frozen=True)
class LatestPriceTick:
    """One latest trade plus optional top-of-book context.

    ``volume`` is the per-trade quantity, not cumulative session volume.
    The dedupe key is trade identity only; bid/ask are ride-along context and
    must not cause a new chart tick when only top-of-book changes.
    """

    trade_ts_ns: int
    price: float
    volume: int
    bid: float | None = None
    ask: float | None = None
    aggressor_side: str = "unknown"
    observed_at_ns: int | None = None

    @property
    def dedupe_key(self) -> tuple[int, float, int]:
        return (self.trade_ts_ns, self.price, self.volume)


def latest_price_tick(
    *,
    trade_source_path: Path,
    capture_path: Path,
    tail_bytes: int = 512_000,
) -> LatestPriceTick | None:
    """Return the newest trade as a chart-ready price tick.

    Raw capture tails contain many non-trade records with a top-level ``price``
    field, especially MBO order lifecycle updates. Only explicit trade records
    may drive the dashboard price line.
    """
    trade = _latest_trade(trade_source_path, tail_bytes=tail_bytes)
    if trade is None:
        return None
    bid, ask = _latest_quote(capture_path, tail_bytes=tail_bytes)
    if _outside_quote_context(trade.price, bid, ask):
        return None
    return LatestPriceTick(
        trade_ts_ns=trade.trade_ts_ns,
        price=trade.price,
        volume=trade.volume,
        bid=bid,
        ask=ask,
        aggressor_side=trade.aggressor_side,
        observed_at_ns=time.time_ns(),
    )


@dataclass(frozen=True)
class _TradeOnly:
    trade_ts_ns: int
    price: float
    volume: int
    aggressor_side: str


def _latest_trade(path: Path, *, tail_bytes: int) -> _TradeOnly | None:
    for rec in _tail_records_reversed(path, tail_bytes=tail_bytes):
        payload = _payload_dict(rec)
        stream = rec.get("stream")
        event_type = rec.get("type")
        if stream not in {"LAST_TRADE", "TRADE"} and event_type != "TRADE":
            continue
        price = _float(_first_present(rec, payload, "price"))
        volume = _int(_first_present(rec, payload, "size", "quantity", "qty"))
        ts_ns = _int(
            _first_present(
                rec,
                payload,
                "exchange_event_ts_ns",
                "ts_event_ns",
                "ts_ns",
                "sidecar_recv_ts_ns",
            )
        )
        if price is None or volume is None or volume <= 0 or ts_ns is None:
            continue
        return _TradeOnly(
            trade_ts_ns=ts_ns,
            price=price,
            volume=volume,
            aggressor_side=_aggressor_side(rec, payload),
        )
    return None


def _outside_quote_context(
    price: float,
    bid: float | None,
    ask: float | None,
) -> bool:
    """Reject display ticks that are wildly outside the current quote context."""
    if bid is not None and price < bid - MAX_TRADE_BBO_DEVIATION_POINTS:
        return True
    return ask is not None and price > ask + MAX_TRADE_BBO_DEVIATION_POINTS


def _latest_quote(capture_path: Path, *, tail_bytes: int) -> tuple[float | None, float | None]:
    if not capture_path.name.endswith(".jsonl"):
        return None, None
    mbp1_path = capture_path.with_name(f"{capture_path.name.removesuffix('.jsonl')}.mbp1.jsonl")
    for rec in _tail_records_reversed(mbp1_path, tail_bytes=tail_bytes):
        payload = _payload_dict(rec)
        bid = _float(_first_present(rec, payload, "bid_px_00", "bid_px", "bid"))
        ask = _float(_first_present(rec, payload, "ask_px_00", "ask_px", "ask"))
        if bid is not None or ask is not None:
            return bid, ask
    return None, None


def _tail_records_reversed(path: Path, *, tail_bytes: int) -> list[dict[str, Any]]:
    if not path.exists() or path.stat().st_size <= 0:
        return []
    size = path.stat().st_size
    seek_pos = max(0, size - tail_bytes)
    with path.open("rb") as f:
        f.seek(seek_pos)
        text = f.read().decode("utf-8", errors="ignore")
    lines = text.splitlines()
    if seek_pos > 0 and lines:
        lines = lines[1:]
    records: list[dict[str, Any]] = []
    for raw in reversed(lines):
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            records.append(rec)
    return records


def _first_present(rec: dict[str, Any], payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if rec.get(key) is not None:
            return rec.get(key)
        if payload.get(key) is not None:
            return payload.get(key)
    return None


def _payload_dict(rec: dict[str, Any]) -> dict[str, Any]:
    payload = rec.get("payload")
    if not isinstance(payload, dict):
        return {}
    return {str(key): value for key, value in payload.items()}


def _aggressor_side(rec: dict[str, Any], payload: dict[str, Any]) -> str:
    value = _first_present(
        rec,
        payload,
        "aggressor_side",
        "aggressor",
        "trade_aggressor",
        "side",
    )
    if value is None:
        return "unknown"
    text = str(value).strip().lower()
    if text in {"buy", "a", "ask", "buyer", "lift", "lift_ask", "at_ask"}:
        return "buy"
    if text in {"sell", "b", "bid", "seller", "hit", "hit_bid", "at_bid"}:
        return "sell"
    return "unknown"


def _float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


__all__ = ["LatestPriceTick", "latest_price_tick"]
