from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class SymbolSubscription:
    symbol: str
    exchange: str


class SubscriptionManager:
    def __init__(self, client: Any) -> None:
        self._client = client
        self._subscriptions: set[tuple[str, str]] = set()

    def subscribe(self, symbol: str, exchange: str) -> None:
        self._subscriptions.add((symbol, exchange))
        method = getattr(self._client, "subscribe_symbol", None) or getattr(self._client, "subscribe", None)
        if callable(method):
            method(symbol=symbol, exchange=exchange)

    def unsubscribe(self, symbol: str, exchange: str) -> None:
        self._subscriptions.discard((symbol, exchange))
        method = getattr(self._client, "unsubscribe_symbol", None) or getattr(self._client, "unsubscribe", None)
        if callable(method):
            method(symbol=symbol, exchange=exchange)

    def snapshot(self) -> list[dict[str, str]]:
        return [
            {"symbol": symbol, "exchange": exchange}
            for symbol, exchange in sorted(self._subscriptions)
        ]

    def drain_ticks(self) -> Iterable[dict[str, Any]]:
        for method_name in ("drain_ticks", "pop_ticks", "ticks"):
            method = getattr(self._client, method_name, None)
            if callable(method):
                ticks = method()
                if ticks is None:
                    return []
                return list(ticks)
        return []


def normalize_tick(raw: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    tick_type = str(raw.get("type", raw.get("kind", "quote"))).lower()
    base = {
        "symbol": str(raw.get("symbol", "MNQM6")),
        "exchange": str(raw.get("exchange", "CME")),
        "tick_ts_ns": str(raw.get("tick_ts_ns", raw.get("event_ts_ns", "0"))),
        "sidecar_recv_ts_ns": str(raw.get("sidecar_recv_ts_ns", raw.get("received_ts_ns", "0"))),
    }
    if tick_type in {"trade", "tick_trade"}:
        return "tick_trade", {
            **base,
            "price": float(raw.get("price", raw.get("trade_price", 0.0))),
            "quantity": float(raw.get("quantity", raw.get("size", 0.0))),
            "aggressor_side": str(raw.get("aggressor_side", "unknown")),
            **({"trade_id": str(raw["trade_id"])} if raw.get("trade_id") is not None else {}),
        }
    if tick_type in {"book", "book_rebuild", "tick_book_rebuild"}:
        return "tick_book_rebuild", {**base, "levels": raw.get("levels", [])}
    return "tick_quote", {
        **base,
        "bid_px": float(raw.get("bid_px", raw.get("bid", 0.0))),
        "bid_qty": float(raw.get("bid_qty", raw.get("bid_size", 0.0))),
        "ask_px": float(raw.get("ask_px", raw.get("ask", 0.0))),
        "ask_qty": float(raw.get("ask_qty", raw.get("ask_size", 0.0))),
    }
