"""Session-return aggregation for ADR-0016 QFA-611.

Unit convention: output returns are decimals, e.g. 0.001 == 10 bps.
The denominator is fixed initial equity per strategy run, not rolling equity.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable, Mapping, Sequence


def _to_int_cents(value: object, field: str) -> int:
    if isinstance(value, bool):
        raise TypeError(f"{field} must be integer cents, not bool")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value)
    raise TypeError(f"{field} must be integer cents encoded as int or string")


def aggregate_session_returns(
    trades: Iterable[Mapping[str, object]],
    session_order: Sequence[str],
    initial_equity_cents: int,
) -> list[float]:
    if not isinstance(initial_equity_cents, int) or initial_equity_cents <= 0:
        raise ValueError("initial_equity_cents must be a positive integer")
    if len(session_order) == 0:
        raise ValueError("session_order must be non-empty")

    pnl_by_session: dict[str, int] = defaultdict(int)
    known_sessions = set(session_order)
    for trade in trades:
        session_id = trade.get("session_id")
        if not isinstance(session_id, str) or session_id == "":
            raise ValueError("trade.session_id must be a non-empty string")
        if session_id not in known_sessions:
            raise ValueError(f"trade session_id not in session_order: {session_id}")
        if "net_pnl_cents" not in trade:
            raise ValueError("trade.net_pnl_cents is required for gating returns")
        pnl_by_session[session_id] += _to_int_cents(trade["net_pnl_cents"], "net_pnl_cents")

    return [pnl_by_session[session_id] / initial_equity_cents for session_id in session_order]


def assert_decimal_returns(returns: Sequence[float]) -> None:
    if len(returns) == 0:
        raise ValueError("returns must be non-empty")
    for index, value in enumerate(returns):
        if isinstance(value, bool) or isinstance(value, int):
            raise TypeError(
                f"returns[{index}] looks like raw integer cents; expected decimal return float"
            )
        if not isinstance(value, float):
            raise TypeError(f"returns[{index}] must be float decimal return")
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError(f"returns[{index}] must be finite")