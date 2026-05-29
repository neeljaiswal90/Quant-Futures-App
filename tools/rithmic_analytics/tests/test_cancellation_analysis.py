"""Tests for ``rithmic_analytics.features.cancellation_analysis`` (RA-036)."""

from __future__ import annotations

from datetime import date

import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.trade_log import CancelledOrder, TradeFill
from rithmic_analytics.features.cancellation_analysis import (
    CancellationAnalysisConfig,
    CancelOutcome,
    analyze_cancellations,
)

_NS_PER_SEC = 10**9
_NS_PER_MIN = 60 * _NS_PER_SEC
_BASE_TS = 1_779_000_000_000_000_000  # arbitrary recent ns


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _cancel(
    *,
    ts: int,
    side: str = "buy",
    limit: float | None = 28900.0,
    order_type: str = "limit",
    qty: int = 1,
) -> CancelledOrder:
    return CancelledOrder(
        cancel_ts_ns=ts,
        symbol="MNQ",
        side=side,  # type: ignore[arg-type]
        order_type=order_type,  # type: ignore[arg-type]
        limit_price=limit,
        stop_price=None,
        quantity=qty,
        status="Cancelled (by trader)",
    )


def _fill(
    *,
    ts: int,
    side: str = "buy",
    price: float = 28900.0,
    fill_id: str = "f",
) -> TradeFill:
    return TradeFill(
        fill_ts_ns=ts,
        symbol="MNQ",
        side=side,  # type: ignore[arg-type]
        price=price,
        quantity=1,
        order_type="market",
        fill_id=fill_id,
    )


def _trades(rows: list[tuple[int, float]]) -> pd.DataFrame:
    """``[(ts_ns, price), ...]`` → trades DataFrame with the right dtypes."""
    if not rows:
        return pd.DataFrame({
            "event_ts_ns": pd.Series(dtype="int64"),
            "price": pd.Series(dtype="float64"),
        })
    df = pd.DataFrame(rows, columns=["event_ts_ns", "price"])
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["price"] = df["price"].astype("float64")
    df["session_id"] = "mnq-2026-05-19-rth"
    return df.sort_values("event_ts_ns").reset_index(drop=True)


# ---------------------------------------------------------------------------
# Acceptance criteria from the ticket spec
# ---------------------------------------------------------------------------


def test_buy_cancel_reaches_limit_favorable_direction() -> None:
    """Spec example: cancel BUY at 28900 → tape prints 28895 within 5min."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    # tape after cancel: drops to 28895 (well below limit) — extends past
    # the default 5min window so window_truncated stays False
    trades = _trades([
        (cancel_ts + 1 * _NS_PER_MIN, 28898.0),
        (cancel_ts + 2 * _NS_PER_MIN, 28897.0),
        (cancel_ts + 3 * _NS_PER_MIN, 28895.0),  # reaches limit
        (cancel_ts + 4 * _NS_PER_MIN, 28896.0),
        (cancel_ts + 5 * _NS_PER_MIN, 28896.0),
        (cancel_ts + 7 * _NS_PER_MIN, 28896.0),  # past the window
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)

    assert len(report.per_cancel_outcomes) == 1
    o = report.per_cancel_outcomes[0]
    assert o.reached_limit is True
    assert o.direction == "favorable"
    assert o.max_favorable_pts == pytest.approx(5.0)  # 28900 - 28895
    assert o.has_sufficient_tape is True
    assert o.window_truncated is False


def test_sell_cancel_reaches_limit_favorable_direction() -> None:
    """Spec example: cancel SELL at 28900 → tape prints 28905 within 5min."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="sell", limit=28900.0)]
    trades = _trades([
        (cancel_ts + 1 * _NS_PER_MIN, 28902.0),
        (cancel_ts + 2 * _NS_PER_MIN, 28903.0),
        (cancel_ts + 3 * _NS_PER_MIN, 28905.0),  # reaches limit (≥)
        (cancel_ts + 4 * _NS_PER_MIN, 28903.0),
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    o = report.per_cancel_outcomes[0]
    assert o.reached_limit is True
    assert o.direction == "favorable"
    assert o.max_favorable_pts == pytest.approx(5.0)  # 28905 - 28900


def test_buy_cancel_price_goes_away_unfavorable_direction() -> None:
    """Buy cancel at 28900 → price goes UP to 28920 → cancel was correct."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    trades = _trades([
        (cancel_ts + 1 * _NS_PER_MIN, 28905.0),
        (cancel_ts + 3 * _NS_PER_MIN, 28920.0),
        (cancel_ts + 4 * _NS_PER_MIN, 28918.0),
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    o = report.per_cancel_outcomes[0]
    assert o.reached_limit is False
    assert o.direction == "unfavorable"
    # max_favorable_pts is signed: positive=favorable, negative=unfavorable
    # min_post=28905, limit=28900 → fav = 28900 - 28905 = -5pt
    assert o.max_favorable_pts is not None
    assert o.max_favorable_pts == pytest.approx(-5.0)


def test_neutral_when_price_oscillates_within_tolerance() -> None:
    """Price hovers between 28899.85 and 28900.15 (within ±1 tick = 0.25) → neutral."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    # ±0.15 oscillation around 28900 — within 1 tick tolerance for MNQ (0.25)
    trades = _trades([
        (cancel_ts + 1 * _NS_PER_MIN, 28899.85),
        (cancel_ts + 2 * _NS_PER_MIN, 28900.15),
        (cancel_ts + 3 * _NS_PER_MIN, 28900.00),
        (cancel_ts + 4 * _NS_PER_MIN, 28899.90),
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    o = report.per_cancel_outcomes[0]
    # reached_limit fires (within tolerance) but direction is neutral
    assert o.direction == "neutral"
    # max_favorable_pts is between ±tolerance: 28900 - 28899.85 = 0.15 < 0.25
    assert -0.25 < (o.max_favorable_pts or 0) < 0.25


def test_regret_rebuy_buy_side() -> None:
    """Cancel BUY at 28900, then fill BUY at 28920 → regret_rebuy=True."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    fills = [
        _fill(ts=cancel_ts + 5 * _NS_PER_MIN, side="buy", price=28920.0, fill_id="r1"),
    ]
    trades = _trades([
        (cancel_ts + 1 * _NS_PER_MIN, 28910.0),
        (cancel_ts + 4 * _NS_PER_MIN, 28920.0),
    ])

    report = analyze_cancellations(cancellations, trades, MNQ, fills=fills)
    o = report.per_cancel_outcomes[0]
    assert o.regret_rebuy_at_worse_price is True


def test_rebuy_at_better_price_not_regret() -> None:
    """Cancel BUY at 28900, fill BUY at 28880 (better!) → NOT regret_rebuy."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    fills = [
        _fill(ts=cancel_ts + 5 * _NS_PER_MIN, side="buy", price=28880.0, fill_id="r1"),
    ]
    trades = _trades([(cancel_ts + 1 * _NS_PER_MIN, 28890.0)])

    report = analyze_cancellations(cancellations, trades, MNQ, fills=fills)
    assert report.per_cancel_outcomes[0].regret_rebuy_at_worse_price is False


def test_rebuy_opposite_side_not_regret() -> None:
    """Cancel BUY, then SELL fill — not a rebuy (opposite side)."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    fills = [
        _fill(ts=cancel_ts + 5 * _NS_PER_MIN, side="sell", price=28920.0, fill_id="r1"),
    ]
    trades = _trades([(cancel_ts + 1 * _NS_PER_MIN, 28910.0)])

    report = analyze_cancellations(cancellations, trades, MNQ, fills=fills)
    assert report.per_cancel_outcomes[0].regret_rebuy_at_worse_price is False


def test_rebuy_outside_window_not_regret() -> None:
    """Rebuy fires AT the boundary — must be strictly within window. Test 11min for default 10min window."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    fills = [
        _fill(ts=cancel_ts + 11 * _NS_PER_MIN, side="buy", price=28920.0, fill_id="r1"),
    ]
    trades = _trades([(cancel_ts + 1 * _NS_PER_MIN, 28910.0)])

    report = analyze_cancellations(cancellations, trades, MNQ, fills=fills)
    assert report.per_cancel_outcomes[0].regret_rebuy_at_worse_price is False


def test_rebuy_sell_side_worse_price() -> None:
    """Cancel SELL at 28900, fill SELL at 28880 (worse — sold for less) → regret_rebuy."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="sell", limit=28900.0)]
    fills = [
        _fill(ts=cancel_ts + 5 * _NS_PER_MIN, side="sell", price=28880.0, fill_id="r1"),
    ]
    trades = _trades([(cancel_ts + 1 * _NS_PER_MIN, 28890.0)])

    report = analyze_cancellations(cancellations, trades, MNQ, fills=fills)
    assert report.per_cancel_outcomes[0].regret_rebuy_at_worse_price is True


# ---------------------------------------------------------------------------
# Window truncation + insufficient tape
# ---------------------------------------------------------------------------


def test_window_truncated_when_tape_ends_early() -> None:
    """Cancel near session end → window extends past last bar → window_truncated."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    # Only 2 min of tape after cancel (default window is 5)
    trades = _trades([
        (cancel_ts + 1 * _NS_PER_MIN, 28898.0),
        (cancel_ts + 2 * _NS_PER_MIN, 28897.0),
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    o = report.per_cancel_outcomes[0]
    assert o.window_truncated is True


def test_window_not_truncated_when_tape_extends_past_window() -> None:
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    # 10 min of tape after cancel — well past 5min window
    trades = _trades([
        (cancel_ts + i * _NS_PER_MIN, 28900.0 - i)
        for i in range(1, 11)
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    assert report.per_cancel_outcomes[0].window_truncated is False


def test_has_sufficient_tape_false_when_under_60s() -> None:
    """Default min_window_seconds=60. Tape with <60s after cancel → insufficient."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    # Only 30 seconds of tape after cancel
    trades = _trades([
        (cancel_ts + 10 * _NS_PER_SEC, 28898.0),
        (cancel_ts + 30 * _NS_PER_SEC, 28897.0),
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    o = report.per_cancel_outcomes[0]
    assert o.has_sufficient_tape is False
    # Excluded from regret_cancel_rate denominator
    assert report.session_summary.n_cancels_analyzed == 0
    assert report.session_summary.regret_cancel_rate is None


def test_insufficient_tape_excluded_from_summary_denominator() -> None:
    """One sufficient + one insufficient → denominator counts only the sufficient one."""
    cancel_ts_1 = _BASE_TS
    cancel_ts_2 = _BASE_TS + 10 * _NS_PER_MIN
    cancellations = [
        _cancel(ts=cancel_ts_1, side="buy", limit=28900.0),
        _cancel(ts=cancel_ts_2, side="buy", limit=28910.0),
    ]
    # First cancel has lots of tape after; second cancel has only 5s
    trades = _trades([
        (cancel_ts_1 + i * _NS_PER_MIN, 28890.0)  # reaches limit
        for i in range(1, 8)
    ] + [
        (cancel_ts_2 + 5 * _NS_PER_SEC, 28912.0),  # <60s after second cancel
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    s = report.session_summary
    assert s.n_cancels_total == 2
    assert s.n_cancels_analyzed == 1  # only the first
    assert s.n_reached_limit == 1
    assert s.regret_cancel_rate == 1.0


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_no_limit_price_unanalyzable() -> None:
    """A market-cancel (limit_price=None) is recorded as unanalyzable."""
    cancellations = [_cancel(ts=_BASE_TS, side="buy", limit=None, order_type="market")]
    trades = _trades([(_BASE_TS + _NS_PER_MIN, 28900.0)])

    report = analyze_cancellations(cancellations, trades, MNQ)
    o = report.per_cancel_outcomes[0]
    assert o.unanalyzable_reason == "no_limit_price"
    assert o.has_sufficient_tape is False
    assert report.session_summary.n_cancels_analyzed == 0


def test_no_tape_after_cancel() -> None:
    """Cancel after the last tape bar → no_tape_after_cancel."""
    cancel_ts = _BASE_TS + 10 * _NS_PER_MIN
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    # Tape ends BEFORE the cancel
    trades = _trades([(_BASE_TS, 28900.0)])

    report = analyze_cancellations(cancellations, trades, MNQ)
    o = report.per_cancel_outcomes[0]
    assert o.unanalyzable_reason == "no_tape_after_cancel"
    assert o.window_truncated is True
    assert o.has_sufficient_tape is False


def test_empty_trades_marks_empty_tape() -> None:
    cancellations = [_cancel(ts=_BASE_TS, side="buy", limit=28900.0)]
    empty_trades = _trades([])

    report = analyze_cancellations(cancellations, empty_trades, MNQ)
    o = report.per_cancel_outcomes[0]
    assert o.unanalyzable_reason == "empty_tape"


def test_empty_cancellations_returns_empty_report() -> None:
    trades = _trades([(_BASE_TS, 28900.0)])
    report = analyze_cancellations([], trades, MNQ)

    assert report.per_cancel_outcomes == []
    assert report.session_summary.n_cancels_total == 0
    assert report.session_summary.regret_cancel_rate is None


def test_tolerance_1_tick_reaches_at_one_tick_away() -> None:
    """Buy at 28900, min_post = 28900.25 (1 tick above) → reached_limit=True (tolerance)."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    trades = _trades([
        (cancel_ts + _NS_PER_MIN, 28900.25),  # exactly 1 tick above limit
        (cancel_ts + 2 * _NS_PER_MIN, 28900.25),
        (cancel_ts + 3 * _NS_PER_MIN, 28900.25),
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    assert report.per_cancel_outcomes[0].reached_limit is True


def test_tolerance_zero_strict_match() -> None:
    """Tighter tolerance — 0 ticks — means price must reach exact limit (or beyond)."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    trades = _trades([
        (cancel_ts + _NS_PER_MIN, 28900.25),
        (cancel_ts + 2 * _NS_PER_MIN, 28900.25),
        (cancel_ts + 3 * _NS_PER_MIN, 28900.25),
    ])
    strict = CancellationAnalysisConfig(regret_tolerance_ticks=0)

    report = analyze_cancellations(cancellations, trades, MNQ, config=strict)
    # 28900.25 > 28900.0 by 0.25; with tol=0, NOT reached
    assert report.per_cancel_outcomes[0].reached_limit is False


def test_custom_regret_window_minutes_affects_lookforward() -> None:
    """Tighter window (1 min) misses a reach-at-3min that the default catches."""
    cancel_ts = _BASE_TS
    cancellations = [_cancel(ts=cancel_ts, side="buy", limit=28900.0)]
    # Price reaches limit at +3 min (inside default 5min window, outside 1min window)
    trades = _trades([
        (cancel_ts + 30 * _NS_PER_SEC, 28905.0),
        (cancel_ts + 3 * _NS_PER_MIN, 28895.0),  # reaches limit
        (cancel_ts + 6 * _NS_PER_MIN, 28890.0),
    ])

    # Default 5min — captures the reach
    default = analyze_cancellations(cancellations, trades, MNQ)
    assert default.per_cancel_outcomes[0].reached_limit is True

    # 1min window — misses it (insufficient_tape check may still fire)
    tight = analyze_cancellations(
        cancellations, trades, MNQ,
        config=CancellationAnalysisConfig(regret_window_minutes=1, min_window_seconds=30),
    )
    assert tight.per_cancel_outcomes[0].reached_limit is False


# ---------------------------------------------------------------------------
# Session summary roll-ups
# ---------------------------------------------------------------------------


def test_session_summary_counts_correctly() -> None:
    """3 cancels: 1 favorable (price drops well past), 1 unfavorable (price never
    came near), 1 neutral (price grazed within tolerance and bounced).

    Note: ``reached_limit`` is independent of ``direction``. A neutral
    cancel that grazes the limit within tolerance still has
    ``reached_limit=True``. This is intentional — Rule 7's "did price
    come to you?" question is about the touch, not the conviction of
    the move.
    """
    base = _BASE_TS
    cancellations = [
        _cancel(ts=base, side="buy", limit=28900.0),
        _cancel(ts=base + 20 * _NS_PER_MIN, side="buy", limit=28910.0),
        _cancel(ts=base + 40 * _NS_PER_MIN, side="buy", limit=28920.0),
    ]
    # Tape: cancel 1 reaches + favorable; cancel 2 unfavorable (price away);
    #       cancel 3 grazes within tolerance (neutral direction but reached).
    trades = _trades([
        (base + 2 * _NS_PER_MIN, 28895.0),  # cancel 1: favorable, reached
        (base + 4 * _NS_PER_MIN, 28895.0),
        (base + 6 * _NS_PER_MIN, 28900.0),
        (base + 22 * _NS_PER_MIN, 28925.0),  # cancel 2: unfavorable, NOT reached
        (base + 24 * _NS_PER_MIN, 28930.0),
        (base + 26 * _NS_PER_MIN, 28930.0),
        (base + 42 * _NS_PER_MIN, 28920.05),  # cancel 3: grazes 28920 → reached, neutral
        (base + 44 * _NS_PER_MIN, 28919.95),
        (base + 46 * _NS_PER_MIN, 28920.05),
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    s = report.session_summary
    assert s.n_cancels_total == 3
    assert s.n_cancels_analyzed == 3
    # 2 reached (favorable + neutral-graze); 1 didn't (unfavorable)
    assert s.n_reached_limit == 2
    assert s.n_favorable == 1
    assert s.n_unfavorable == 1
    assert s.n_neutral == 1
    assert s.regret_cancel_rate == pytest.approx(2.0 / 3.0)


def test_avg_regret_pts_averages_favorable_only() -> None:
    """avg_regret_pts averages over favorable outcomes only."""
    base = _BASE_TS
    cancellations = [
        _cancel(ts=base, side="buy", limit=28900.0),
        _cancel(ts=base + 20 * _NS_PER_MIN, side="buy", limit=28910.0),
    ]
    # Cancel 1: drops 5pt favorable. Cancel 2: drops 10pt favorable.
    trades = _trades([
        (base + 2 * _NS_PER_MIN, 28895.0),
        (base + 4 * _NS_PER_MIN, 28895.0),
        (base + 5 * _NS_PER_MIN, 28895.0),
        (base + 22 * _NS_PER_MIN, 28900.0),
        (base + 24 * _NS_PER_MIN, 28900.0),
        (base + 25 * _NS_PER_MIN, 28900.0),
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    # Avg of (5pt, 10pt) = 7.5pt
    assert report.session_summary.avg_regret_pts == pytest.approx(7.5)


# ---------------------------------------------------------------------------
# Today's data: 3 cancellations should produce 3 outcomes
# ---------------------------------------------------------------------------


def test_three_cancels_three_outcomes() -> None:
    """Acceptance criterion: 3 cancelled orders → 3 CancelOutcome rows."""
    base = _BASE_TS
    cancellations = [
        _cancel(ts=base + i * 20 * _NS_PER_MIN, side="buy", limit=28900.0 + i * 10)
        for i in range(3)
    ]
    # Just enough tape after each cancel to make them analyzable
    trades = _trades([
        (base + i * 20 * _NS_PER_MIN + 2 * _NS_PER_MIN, 28900.0 + i * 10 + 5)
        for i in range(3)
    ] + [
        (base + i * 20 * _NS_PER_MIN + 4 * _NS_PER_MIN, 28900.0 + i * 10 + 5)
        for i in range(3)
    ])

    report = analyze_cancellations(cancellations, trades, MNQ)
    assert len(report.per_cancel_outcomes) == 3


# ---------------------------------------------------------------------------
# Schema + dataclass invariants
# ---------------------------------------------------------------------------


def test_report_schema_version_is_1() -> None:
    """Forward-compat: schema_version=1 at top of output (RA-035 pattern)."""
    report = analyze_cancellations([], _trades([]), MNQ)
    assert report.schema_version == 1
    d = report.to_dict()
    assert d["schema_version"] == 1


def test_default_config_matches_ticket_locks() -> None:
    """RA-036 sweep: 5min regret, 10min rebuy, 1 tick, 60s min tape."""
    cfg = CancellationAnalysisConfig()
    assert cfg.regret_window_minutes == 5
    assert cfg.rebuy_window_minutes == 10
    assert cfg.regret_tolerance_ticks == 1
    assert cfg.min_window_seconds == 60


def test_cancel_outcome_is_frozen() -> None:
    import dataclasses
    o = CancelOutcome(
        cancel_ts_ns=0, limit_price=100.0, side="buy",
        reached_limit=False, direction="neutral",
        max_favorable_pts=None, regret_rebuy_at_worse_price=False,
        window_truncated=False, has_sufficient_tape=False,
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        o.reached_limit = True  # type: ignore[misc]


def test_report_to_dict_serialisable_as_json() -> None:
    import json
    base = _BASE_TS
    cancellations = [_cancel(ts=base, side="buy", limit=28900.0)]
    trades = _trades([
        (base + 2 * _NS_PER_MIN, 28895.0),
        (base + 5 * _NS_PER_MIN, 28895.0),
    ])
    report = analyze_cancellations(
        cancellations, trades, MNQ, trading_date=date(2026, 5, 19),
    )
    s = json.dumps(report.to_dict(), default=str)
    assert "schema_version" in s
    assert "session_summary" in s
    assert "trading_date" in s


def test_report_carries_config_in_metadata() -> None:
    """Configurable knobs surface in the report metadata."""
    report = analyze_cancellations(
        [], _trades([]), MNQ,
        config=CancellationAnalysisConfig(
            regret_window_minutes=3, rebuy_window_minutes=7,
            regret_tolerance_ticks=2, min_window_seconds=45,
        ),
    )
    meta = report.to_dict()["metadata"]
    assert meta["regret_window_minutes"] == 3
    assert meta["rebuy_window_minutes"] == 7
    assert meta["regret_tolerance_ticks"] == 2
    assert meta["min_window_seconds"] == 45
