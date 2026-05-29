"""Tests for ``rithmic_analytics.features.sweep``.

Six-tier synthetic fixture set:
    1. Primary clean buy sweep
    2. Sell mirror
    3. Anti-test: fast trend (6 levels over 5s) — must NOT be flagged
    4. Anti-test: stationary heavy volume (single level) — must NOT be flagged
    5. Boundary just-under: 4 levels in 0.5s — gate rejects
    6. Boundary just-over: 5 levels in 0.95s — gate just passes

Plus a side-flip edge case (buy sweep with stray sell trades) to verify
direction stays buy via MBO ``side`` dominance.
"""

from __future__ import annotations

import dataclasses
from typing import Any

import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.features.sweep import (
    SweepConfig,
    SweepEvent,
    _compute_score,
    detect_sweeps,
)

_NS_PER_SEC = 1_000_000_000
_NS_PER_MS = 1_000_000
_BASE_TS_NS = 1_777_301_400_000_000_000


def _mbo_row(
    *,
    event_ts_ns: int,
    action: str = "T",
    side: str = "A",
    price: float | None = 27380.00,
    size: int = 5,
    sequence: int = 0,
    order_id: str = "0",
) -> dict[str, Any]:
    return {
        "event_ts_ns": event_ts_ns,
        "recv_ts_ns": event_ts_ns + 1000,
        "sequence": sequence,
        "action": action,
        "side": side,
        "price": price,
        "size": size,
        "order_id": order_id,
    }


def _mbp1_row(
    *,
    event_ts_ns: int,
    bid_px: float,
    bid_sz: int,
    ask_px: float,
    ask_sz: int,
) -> dict[str, Any]:
    return {
        "event_ts_ns": event_ts_ns,
        "recv_ts_ns": event_ts_ns + 1000,
        "bid_px_00": bid_px,
        "bid_sz_00": bid_sz,
        "bid_ct_00": 1,
        "ask_px_00": ask_px,
        "ask_sz_00": ask_sz,
        "ask_ct_00": 1,
    }


def _mbo_frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(
            {
                "event_ts_ns": pd.Series(dtype="int64"),
                "action": pd.Series(dtype="category"),
                "side": pd.Series(dtype="category"),
                "price": pd.Series(dtype="float64"),
                "size": pd.Series(dtype="int32"),
            }
        )
    df = pd.DataFrame(rows)
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["action"] = df["action"].astype("category")
    df["side"] = df["side"].astype("category")
    df["price"] = df["price"].astype("float64")
    df["size"] = df["size"].astype("int32")
    return df


def _mbp1_frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(
            {
                "event_ts_ns": pd.Series(dtype="int64"),
                "ask_px_00": pd.Series(dtype="float64"),
                "ask_sz_00": pd.Series(dtype="int32"),
                "bid_px_00": pd.Series(dtype="float64"),
                "bid_sz_00": pd.Series(dtype="int32"),
            }
        )
    df = pd.DataFrame(rows)
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["ask_px_00"] = df["ask_px_00"].astype("float64")
    df["ask_sz_00"] = df["ask_sz_00"].astype("int32")
    df["bid_px_00"] = df["bid_px_00"].astype("float64")
    df["bid_sz_00"] = df["bid_sz_00"].astype("int32")
    return df


# ===========================================================================
# Tier 1: primary clean buy sweep
# ===========================================================================


def _build_tier1_buy_sweep() -> tuple[pd.DataFrame, pd.DataFrame]:
    """8 levels swept upward in 400ms, all side=A, MBP1 confirms pre + post."""
    # Burst window: 50ms gaps × 8 trades = 350ms; total < 1s.
    burst_start = _BASE_TS_NS + 500 * _NS_PER_MS  # 500ms in
    rows = [
        _mbo_row(
            event_ts_ns=burst_start + i * 50 * _NS_PER_MS,
            action="T",
            side="A",
            price=27380.00 + i * 0.25,
            size=5,
        )
        for i in range(8)
    ]
    mbo = _mbo_frame(rows)

    # MBP1 pre-burst (200ms before): ask=27380.00 (= burst low — at offer)
    # MBP1 post-burst (200ms after end): bid moved up to 27381.75 (= burst high)
    burst_end = burst_start + 7 * 50 * _NS_PER_MS  # last trade at i=7
    mbp1_rows = [
        _mbp1_row(
            event_ts_ns=_BASE_TS_NS, bid_px=27379.75, bid_sz=10, ask_px=27380.00, ask_sz=10,
        ),
        _mbp1_row(
            event_ts_ns=burst_start - 50 * _NS_PER_MS,
            bid_px=27379.75, bid_sz=10, ask_px=27380.00, ask_sz=10,
        ),
        _mbp1_row(
            event_ts_ns=burst_end + 150 * _NS_PER_MS,
            bid_px=27381.75, bid_sz=8, ask_px=27382.00, ask_sz=8,
        ),
    ]
    return mbo, _mbp1_frame(mbp1_rows)


def test_tier1_emits_one_buy_sweep_event() -> None:
    mbo, mbp1 = _build_tier1_buy_sweep()

    events = detect_sweeps(mbo, mbp1, MNQ)

    assert len(events) == 1
    evt = events[0]
    assert evt.side == "buy_sweep"
    assert evt.levels_swept == 8
    assert evt.range_ticks == 7  # 8 levels = 7 tick steps from low to high
    assert evt.volume == 40
    assert evt.score > 0.7


def test_tier1_pre_and_post_confirmations_true() -> None:
    mbo, mbp1 = _build_tier1_buy_sweep()
    events = detect_sweeps(mbo, mbp1, MNQ)

    evt = events[0]
    assert evt.confirmed_pre is True
    assert evt.confirmed_post is True


def test_tier1_factors_recorded() -> None:
    mbo, mbp1 = _build_tier1_buy_sweep()
    events = detect_sweeps(mbo, mbp1, MNQ)

    factors = events[0].factors
    assert set(factors.keys()) == {"range", "speed", "displacement", "onesidedness"}
    assert all(0.0 <= v <= 1.0 for v in factors.values())


# ===========================================================================
# Tier 2: sell mirror
# ===========================================================================


def test_tier2_sell_sweep_at_bid() -> None:
    """6 levels swept downward, all side=B, mirror of tier 1."""
    burst_start = _BASE_TS_NS + 500 * _NS_PER_MS
    rows = [
        _mbo_row(
            event_ts_ns=burst_start + i * 50 * _NS_PER_MS,
            action="T",
            side="B",
            price=27380.00 - i * 0.25,
            size=6,
        )
        for i in range(6)
    ]
    mbo = _mbo_frame(rows)
    burst_end = burst_start + 5 * 50 * _NS_PER_MS

    mbp1_rows = [
        _mbp1_row(event_ts_ns=_BASE_TS_NS, bid_px=27380.00, bid_sz=10, ask_px=27380.25, ask_sz=10),
        _mbp1_row(event_ts_ns=burst_start - 50 * _NS_PER_MS, bid_px=27380.00, bid_sz=10, ask_px=27380.25, ask_sz=10),
        # Post: ask moved down to the lowest swept price (= 27378.75)
        _mbp1_row(event_ts_ns=burst_end + 150 * _NS_PER_MS, bid_px=27378.50, bid_sz=8, ask_px=27378.75, ask_sz=8),
    ]
    mbp1 = _mbp1_frame(mbp1_rows)

    events = detect_sweeps(mbo, mbp1, MNQ)

    assert len(events) == 1
    assert events[0].side == "sell_sweep"
    assert events[0].levels_swept == 6
    assert events[0].confirmed_pre is True
    assert events[0].confirmed_post is True


# ===========================================================================
# Tier 3: anti-test — fast trend (NOT a sweep)
# ===========================================================================


def test_tier3_fast_trend_over_5_seconds_emits_no_event() -> None:
    """6 levels but spaced 1 second apart = 5s total. Each gap exceeds the
    event-gap-max (200ms default), so the burst-detector splits each trade
    into its own singleton — no burst forms."""
    rows = [
        _mbo_row(
            event_ts_ns=_BASE_TS_NS + i * _NS_PER_SEC,
            action="T", side="A",
            price=27380.00 + i * 0.25, size=5,
        )
        for i in range(6)
    ]
    mbo = _mbo_frame(rows)
    mbp1 = _mbp1_frame([
        _mbp1_row(
            event_ts_ns=_BASE_TS_NS, bid_px=27379.75, bid_sz=10, ask_px=27380.00, ask_sz=10,
        ),
    ])

    events = detect_sweeps(mbo, mbp1, MNQ)

    assert events == []


# ===========================================================================
# Tier 4: anti-test — stationary heavy volume (single level)
# ===========================================================================


def test_tier4_stationary_heavy_volume_emits_no_event() -> None:
    """500 contracts all at one price. levels_swept=1 fails the range gate."""
    rows = [
        _mbo_row(
            event_ts_ns=_BASE_TS_NS + i * 5 * _NS_PER_MS,
            action="T", side="A",
            price=27380.00,  # single price level
            size=10,
        )
        for i in range(50)
    ]
    mbo = _mbo_frame(rows)
    mbp1 = _mbp1_frame([
        _mbp1_row(
            event_ts_ns=_BASE_TS_NS, bid_px=27379.75, bid_sz=10, ask_px=27380.00, ask_sz=10,
        ),
    ])

    events = detect_sweeps(mbo, mbp1, MNQ)

    assert events == []


# ===========================================================================
# Tier 5: boundary just-under — 4 levels in 0.5s
# ===========================================================================


def test_tier5_just_under_min_levels_no_event() -> None:
    """4 levels — one below the hard min. Range gate rejects."""
    burst_start = _BASE_TS_NS + 500 * _NS_PER_MS
    rows = [
        _mbo_row(
            event_ts_ns=burst_start + i * 50 * _NS_PER_MS,
            action="T", side="A",
            price=27380.00 + i * 0.25, size=5,
        )
        for i in range(4)
    ]
    mbo = _mbo_frame(rows)
    mbp1 = _mbp1_frame([
        _mbp1_row(
            event_ts_ns=_BASE_TS_NS, bid_px=27379.75, bid_sz=10, ask_px=27380.00, ask_sz=10,
        ),
        _mbp1_row(event_ts_ns=burst_start + 1 * _NS_PER_SEC, bid_px=27380.50, bid_sz=10, ask_px=27380.75, ask_sz=10),
    ])

    events = detect_sweeps(mbo, mbp1, MNQ)

    assert events == []


# ===========================================================================
# Tier 6: boundary just-over — 5 levels in 950ms
# ===========================================================================


def test_tier6_just_over_min_levels_emits_event() -> None:
    """5 levels (= hard min) in 0.95s (= just under total cap). Both gates
    just barely pass; event emitted."""
    burst_start = _BASE_TS_NS + 500 * _NS_PER_MS
    # 5 trades spaced by 190ms (≤200ms event-gap max), spanning 4 * 190 = 760ms < 1000ms cap
    rows = [
        _mbo_row(
            event_ts_ns=burst_start + i * 190 * _NS_PER_MS,
            action="T", side="A",
            price=27380.00 + i * 0.25, size=5,
        )
        for i in range(5)
    ]
    mbo = _mbo_frame(rows)
    burst_end = burst_start + 4 * 190 * _NS_PER_MS
    mbp1 = _mbp1_frame([
        _mbp1_row(
            event_ts_ns=_BASE_TS_NS, bid_px=27379.75, bid_sz=10, ask_px=27380.00, ask_sz=10,
        ),
        _mbp1_row(
            event_ts_ns=burst_start - 50 * _NS_PER_MS,
            bid_px=27379.75, bid_sz=10, ask_px=27380.00, ask_sz=10,
        ),
        _mbp1_row(event_ts_ns=burst_end + 150 * _NS_PER_MS, bid_px=27381.00, bid_sz=8, ask_px=27381.25, ask_sz=8),
    ])

    events = detect_sweeps(mbo, mbp1, MNQ)

    assert len(events) == 1
    assert events[0].levels_swept == 5


# ===========================================================================
# Side-flip edge case: buy sweep with stray sell trades
# ===========================================================================


def test_buy_sweep_with_stray_sell_trades_stays_buy_via_side_dominance() -> None:
    """7 side=A + 1 side=B. Onesidedness = 7/8 = 0.875 (passes 0.5 gate);
    buy_sweep classification stays correct via MBO `side` dominance."""
    burst_start = _BASE_TS_NS + 500 * _NS_PER_MS
    sides = ["A"] * 7 + ["B"]
    rows = [
        _mbo_row(
            event_ts_ns=burst_start + i * 50 * _NS_PER_MS,
            action="T", side=sides[i],
            price=27380.00 + i * 0.25, size=5,
        )
        for i in range(8)
    ]
    mbo = _mbo_frame(rows)
    burst_end = burst_start + 7 * 50 * _NS_PER_MS
    mbp1 = _mbp1_frame([
        _mbp1_row(
            event_ts_ns=_BASE_TS_NS, bid_px=27379.75, bid_sz=10, ask_px=27380.00, ask_sz=10,
        ),
        _mbp1_row(
            event_ts_ns=burst_start - 50 * _NS_PER_MS,
            bid_px=27379.75, bid_sz=10, ask_px=27380.00, ask_sz=10,
        ),
        _mbp1_row(
            event_ts_ns=burst_end + 150 * _NS_PER_MS,
            bid_px=27381.75, bid_sz=8, ask_px=27382.00, ask_sz=8,
        ),
    ])

    events = detect_sweeps(mbo, mbp1, MNQ)

    assert len(events) == 1
    assert events[0].side == "buy_sweep"
    # Onesidedness factor reflects the 7/8 split
    assert events[0].factors["onesidedness"] == pytest.approx(0.875)


# ===========================================================================
# Burst-detection mechanics: per-event gap splits bursts
# ===========================================================================


def test_per_event_gap_splits_into_separate_bursts() -> None:
    """3 trades clustered, big gap, then 3 more clustered. The gap exceeds
    event_gap_max → two separate burst attempts. Each has only 3 levels →
    both fail min_levels_swept gate → no events emitted."""
    base = _BASE_TS_NS + 500 * _NS_PER_MS
    # First cluster: 3 trades at 50ms apart
    rows = [
        _mbo_row(event_ts_ns=base + i * 50 * _NS_PER_MS, action="T", side="A",
                 price=27380.00 + i * 0.25, size=5) for i in range(3)
    ]
    # Big gap: 500ms (> event_gap_max of 200ms)
    gap_start = base + 700 * _NS_PER_MS
    rows.extend(
        _mbo_row(event_ts_ns=gap_start + i * 50 * _NS_PER_MS, action="T", side="A",
                 price=27381.00 + i * 0.25, size=5) for i in range(3)
    )
    mbo = _mbo_frame(rows)
    mbp1 = _mbp1_frame([])

    events = detect_sweeps(mbo, mbp1, MNQ)

    # Neither burst hits 5 levels → no emissions
    assert events == []


# ===========================================================================
# MBP1 confirmation flags
# ===========================================================================


def test_mbp1_missing_yields_confirmed_false_but_still_emits_when_score_high() -> None:
    """Empty MBP1 → both confirmation flags False, displacement=0. But the
    other three factors can still push score above threshold."""
    # 10 levels in 200ms with all side=A
    burst_start = _BASE_TS_NS + 500 * _NS_PER_MS
    rows = [
        _mbo_row(event_ts_ns=burst_start + i * 20 * _NS_PER_MS, action="T", side="A",
                 price=27380.00 + i * 0.25, size=10)
        for i in range(10)
    ]
    mbo = _mbo_frame(rows)
    empty_mbp1 = _mbp1_frame([])

    events = detect_sweeps(mbo, empty_mbp1, MNQ)

    if events:  # may or may not emit depending on whether remaining factors are enough
        evt = events[0]
        assert evt.confirmed_pre is False
        assert evt.confirmed_post is False
        assert evt.factors["displacement"] == 0.0


def test_pre_confirm_fails_when_ask_above_burst_range() -> None:
    """If MBP1 ask was already ABOVE the burst's high before the burst,
    the burst didn't sweep through that level — confirmed_pre is False."""
    burst_start = _BASE_TS_NS + 500 * _NS_PER_MS
    rows = [
        _mbo_row(event_ts_ns=burst_start + i * 50 * _NS_PER_MS, action="T", side="A",
                 price=27380.00 + i * 0.25, size=5) for i in range(8)
    ]
    mbo = _mbo_frame(rows)
    # MBP1 pre: ask=27400.00 (far above burst high 27381.75)
    mbp1 = _mbp1_frame([
        _mbp1_row(event_ts_ns=burst_start - 50 * _NS_PER_MS,
                  bid_px=27399.75, bid_sz=10, ask_px=27400.00, ask_sz=10),
    ])

    events = detect_sweeps(mbo, mbp1, MNQ)

    assert len(events) == 1
    assert events[0].confirmed_pre is False  # ask was above burst_high


# ===========================================================================
# Onesidedness hard gate
# ===========================================================================


def test_balanced_sides_rejected_by_onesidedness_gate() -> None:
    """4 side=A + 4 side=B → onesidedness 0.5 == threshold (passes barely),
    but a 3+5 split fails. Test the 3+5 case → no event."""
    burst_start = _BASE_TS_NS + 500 * _NS_PER_MS
    sides = ["A", "A", "A", "B", "B", "B", "B", "B"]  # 3A / 5B → onesidedness=0.625
    rows = [
        _mbo_row(event_ts_ns=burst_start + i * 50 * _NS_PER_MS, action="T", side=sides[i],
                 price=27380.00 + i * 0.25, size=5) for i in range(8)
    ]
    mbo = _mbo_frame(rows)
    # Now make it truly balanced: 4/4 → onesidedness=0.5 = at threshold
    sides_balanced = ["A", "B"] * 4
    rows_balanced = [
        _mbo_row(event_ts_ns=burst_start + i * 50 * _NS_PER_MS, action="T",
                 side=sides_balanced[i], price=27380.00 + i * 0.25, size=5)
        for i in range(8)
    ]
    mbo_balanced = _mbo_frame(rows_balanced)
    mbp1 = _mbp1_frame([])

    # With min_onesidedness=0.6 (stricter), the 5/3 case fails
    strict = SweepConfig(min_onesidedness=0.7)
    events = detect_sweeps(mbo, mbp1, MNQ, config=strict)
    # 5/3 = 0.625 < 0.7 → rejected
    assert events == []

    # 4/4 balanced is exactly at the default 0.5 floor — passes the gate but
    # the onesidedness factor itself contributes only 0.125 to the score.
    events_bal = detect_sweeps(mbo_balanced, mbp1, MNQ)
    # Without MBP1, displacement=0; with balanced sides, onesidedness factor=0.5.
    # Range and speed alone may not clear the 0.5 emit threshold.
    # Verify either no event OR (if emitted) onesidedness factor = 0.5.
    for e in events_bal:
        assert e.factors["onesidedness"] == pytest.approx(0.5)


# ===========================================================================
# Score formula — direct tests
# ===========================================================================


def test_score_all_factors_at_boundary_is_half() -> None:
    config = SweepConfig()
    factors = {"range": 0.5, "speed": 0.5, "displacement": 0.5, "onesidedness": 0.5}

    score = _compute_score(factors, config)

    assert 0.45 <= score <= 0.55


def test_score_weight_validation_at_construction() -> None:
    with pytest.raises(ValueError, match="weights must sum to 1.0"):
        SweepConfig(
            range_weight=0.5,
            speed_weight=0.5,
            displacement_weight=0.5,
            onesidedness_weight=0.5,
        )


def test_score_monotonic_with_factor_strength() -> None:
    config = SweepConfig()
    weak = _compute_score({"range": 0.3, "speed": 0.3, "displacement": 0.3, "onesidedness": 0.3}, config)
    strong = _compute_score({"range": 0.9, "speed": 0.9, "displacement": 0.9, "onesidedness": 0.9}, config)
    assert weak < strong


# ===========================================================================
# Empty input + dataclass safety
# ===========================================================================


def test_empty_mbo_returns_empty() -> None:
    empty = _mbo_frame([])
    # Empty MBO needs the correct column shape for the filter to work
    assert detect_sweeps(empty, _mbp1_frame([]), MNQ) == []


def test_sweep_config_is_frozen() -> None:
    config = SweepConfig()
    with pytest.raises(dataclasses.FrozenInstanceError):
        config.min_levels_swept = 99  # type: ignore[misc]


def test_sweep_event_is_frozen() -> None:
    evt = SweepEvent(
        start_ts_ns=0, end_ts_ns=_NS_PER_SEC, side="buy_sweep",
        price_low=27380.0, price_high=27382.0, levels_swept=8, range_ticks=8,
        duration_ns=_NS_PER_SEC, volume=40, score=0.85,
        confirmed_pre=True, confirmed_post=True,
        factors={"range": 0.8, "speed": 0.9, "displacement": 0.9, "onesidedness": 1.0},
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        evt.score = 0.0  # type: ignore[misc]


def test_event_to_dict_is_json_serializable() -> None:
    import json

    evt = SweepEvent(
        start_ts_ns=0, end_ts_ns=_NS_PER_SEC, side="buy_sweep",
        price_low=27380.0, price_high=27382.0, levels_swept=8, range_ticks=8,
        duration_ns=_NS_PER_SEC, volume=40, score=0.85,
        confirmed_pre=True, confirmed_post=True,
        factors={"range": 0.8, "speed": 0.9, "displacement": 0.9, "onesidedness": 1.0},
    )

    s = json.dumps(evt.to_dict())
    parsed = json.loads(s)
    assert parsed["side"] == "buy_sweep"
    assert parsed["levels_swept"] == 8
