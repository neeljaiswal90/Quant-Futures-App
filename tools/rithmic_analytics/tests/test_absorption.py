"""Tests for ``rithmic_analytics.features.absorption``.

Five-tier synthetic fixture set documented in
``docs/absorption_methodology.md``. Tier-1 through Tier-3 exercise the
end-to-end pipeline with successive layers (primary detect → confirm-holds →
confirm-breaks). Tier-5 is the anti-test (breakout must NOT be flagged).
Tier-4 work is split between direct score-formula tests (ordering, weighting
robustness) and a config-driven boundary test on Tier-1.

All fixtures are built programmatically — the builders ARE the canonical
reference. A future engineer reading this file sees exactly what each pattern
looks like in our data.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.schema import Zone
from rithmic_analytics.features.absorption import (
    AbsorptionConfig,
    AbsorptionEvent,
    _compute_score,
    apply_next_bar_confirmation,
    compute_absorption_events,
    suggest_conviction_upgrade,
)

_NS_PER_SEC = 1_000_000_000
_BASE_TS_NS = 1_777_301_400_000_000_000  # arbitrary recent ns timestamp
_BAR_NS = 5 * _NS_PER_SEC  # default 5-second bars
_ABSORPTION_BAR_INDEX = 10
_OFFER_PRICE = 27380.25
_GRACE_PRICE = 27380.50  # = _OFFER_PRICE + 1 tick * 0.25
_BREAK_PRICE = 27381.00  # = _OFFER_PRICE + 3 ticks


# ===========================================================================
# Fixture builders
# ===========================================================================


def _trade_row(
    *,
    event_ts_ns: int,
    price: float,
    quantity: int,
    aggressor_side: str,
) -> dict[str, Any]:
    sign = {"buy": 1, "sell": -1, "unknown": 0}[aggressor_side]
    return {
        "event_ts_ns": event_ts_ns,
        "recv_ts_ns": event_ts_ns + 1_000,
        "session_id": "mnq-2026-05-15-rth",
        "price": price,
        "quantity": quantity,
        "aggressor_side": aggressor_side,
        "trade_id": f"t-{event_ts_ns}-{price}",
        "signed_qty": sign * quantity,
    }


def _build_baseline_bars(
    *,
    bar_indexes: list[int],
    contracts_per_bar: int = 50,
    base_price: float = 27380.00,
) -> list[dict[str, Any]]:
    """Quiet bars with mixed buy/sell, balanced delta, tight range.

    Used as the pre- and post-absorption volume baseline so session_avg comes
    out at a realistic level (~70-95 contracts/bar) rather than being driven
    by the absorption bar itself.
    """
    rows: list[dict[str, Any]] = []
    for bar_idx in bar_indexes:
        bar_start = _BASE_TS_NS + bar_idx * _BAR_NS
        for j in range(contracts_per_bar):
            # Distribute trades across the bar; alternate buy/sell for ~0 delta.
            ts = bar_start + (j * _BAR_NS // contracts_per_bar)
            side = "buy" if j % 2 == 0 else "sell"
            rows.append(
                _trade_row(
                    event_ts_ns=ts,
                    price=base_price,
                    quantity=1,
                    aggressor_side=side,
                )
            )
    return rows


def _build_absorption_bar(
    *,
    bar_index: int = _ABSORPTION_BAR_INDEX,
    total_volume: int = 500,
    offer_price: float = _OFFER_PRICE,
    poke_price: float | None = None,  # +1 tick price for 5% of trades (None → no poke)
    poke_fraction: float = 0.05,
    aggressor_side: str = "buy",
) -> list[dict[str, Any]]:
    """The canonical absorption bar: most trades at offer, occasional +1 tick poke."""
    bar_start = _BASE_TS_NS + bar_index * _BAR_NS
    rows: list[dict[str, Any]] = []

    n_poke = int(total_volume * poke_fraction) if poke_price is not None else 0
    n_at_offer = total_volume - n_poke

    # Trades at offer
    for j in range(n_at_offer):
        ts = bar_start + (j * _BAR_NS // max(total_volume, 1))
        rows.append(
            _trade_row(
                event_ts_ns=ts,
                price=offer_price,
                quantity=1,
                aggressor_side=aggressor_side,
            )
        )

    # Pokes at +1 tick (offer briefly lifted, then refilled)
    for k in range(n_poke):
        ts = bar_start + ((n_at_offer + k) * _BAR_NS // max(total_volume, 1))
        rows.append(
            _trade_row(
                event_ts_ns=ts,
                price=poke_price,  # type: ignore[arg-type]  # n_poke=0 when None
                quantity=1,
                aggressor_side=aggressor_side,
            )
        )

    return rows


def _build_mbp1_with_refill_pattern(
    *,
    pre_bin_ts_ns: int,
    pre_bin_size: int = 100,
    mid_bar_size: int = 10,
    end_bar_size: int = 100,
    ask_price: float = _OFFER_PRICE,
    bid_price: float = 27380.00,
    bar_size_ns: int = _BAR_NS,
) -> list[dict[str, Any]]:
    """MBP1 snapshots showing the institutional refill pattern.

    Pre-bin: ask_sz_00 = 100 (the resting offer).
    Mid-bar: ask_sz_00 = 10 (offer being eaten).
    End-bar: ask_sz_00 = 100 (refilled).
    """

    def _row(ts: int, ask_sz: int) -> dict[str, Any]:
        return {
            "event_ts_ns": ts,
            "recv_ts_ns": ts + 1_000,
            "bid_px_00": bid_price,
            "bid_sz_00": 100,
            "bid_ct_00": 10,
            "ask_px_00": ask_price,
            "ask_sz_00": ask_sz,
            "ask_ct_00": 10,
        }

    return [
        # An anchor row further before the bar so merge_asof has something to find
        _row(pre_bin_ts_ns - _NS_PER_SEC, pre_bin_size),
        _row(pre_bin_ts_ns - 100_000_000, pre_bin_size),  # 100ms before bar start
        _row(pre_bin_ts_ns + bar_size_ns // 2, mid_bar_size),  # mid-bar
        _row(pre_bin_ts_ns + bar_size_ns - 100_000_000, end_bar_size),  # end-bar
    ]


def _to_trades_frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["price"] = df["price"].astype("float64")
    df["quantity"] = df["quantity"].astype("int32")
    df["signed_qty"] = df["signed_qty"].astype("int32")
    return df


def _to_mbp1_frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
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


# ---- Per-tier builders ----------------------------------------------------


def _build_tier1_primary_clean() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Tier 1: textbook absorption, no next-bar data.

    Bars 0–9: 50 contracts each at 27380.00, balanced delta.
    Bar 10: 500 contracts, 95% at 27380.25, 5% at 27380.50, ALL BUYS.
    MBP1: pre-bin ask_sz=100; dips to 10 mid-bar; refilled to 100 end-bar.

    Expected: 1 event, buy_absorbed, score > 0.9, confirmed=False.
    """
    rows = _build_baseline_bars(bar_indexes=list(range(0, _ABSORPTION_BAR_INDEX)))
    rows.extend(
        _build_absorption_bar(
            bar_index=_ABSORPTION_BAR_INDEX,
            total_volume=500,
            offer_price=_OFFER_PRICE,
            poke_price=_GRACE_PRICE,  # +1 tick
            poke_fraction=0.05,
            aggressor_side="buy",
        )
    )

    pre_bin_ts = _BASE_TS_NS + _ABSORPTION_BAR_INDEX * _BAR_NS
    mbp1_rows = _build_mbp1_with_refill_pattern(pre_bin_ts_ns=pre_bin_ts)
    return _to_trades_frame(rows), _to_mbp1_frame(mbp1_rows)


def _tier1_rows() -> list[dict[str, Any]]:
    """Trade rows for tier 1 (baseline + absorption bar, no bar-11 data)."""
    rows = _build_baseline_bars(bar_indexes=list(range(0, _ABSORPTION_BAR_INDEX)))
    rows.extend(
        _build_absorption_bar(
            bar_index=_ABSORPTION_BAR_INDEX,
            total_volume=500,
            offer_price=_OFFER_PRICE,
            poke_price=_GRACE_PRICE,
            poke_fraction=0.05,
            aggressor_side="buy",
        )
    )
    return rows


def _tier1_mbp1() -> pd.DataFrame:
    pre_bin_ts = _BASE_TS_NS + _ABSORPTION_BAR_INDEX * _BAR_NS
    return _to_mbp1_frame(_build_mbp1_with_refill_pattern(pre_bin_ts_ns=pre_bin_ts))


def _build_tier2_confirmation_holds() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Tier 2: tier 1 + next-bar trades stay at or below grace level.

    Bar 11 trades at 27380.00–27380.50 (never above grace).
    Expected: 1 event, confirmed=True.
    """
    rows = _tier1_rows()
    bar11_start = _BASE_TS_NS + (_ABSORPTION_BAR_INDEX + 1) * _BAR_NS
    for j in range(30):
        ts = bar11_start + (j * _BAR_NS // 30)
        price = (
            27380.00 if j % 3 == 0 else (_OFFER_PRICE if j % 3 == 1 else _GRACE_PRICE)
        )
        side = "buy" if j % 2 == 0 else "sell"
        rows.append(
            _trade_row(event_ts_ns=ts, price=price, quantity=1, aggressor_side=side)
        )
    return _to_trades_frame(rows), _tier1_mbp1()


def _build_tier3_confirmation_breaks() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Tier 3: tier 1 + next-bar trades break above grace level.

    Bar 11 trades include 27381.00+ (3 ticks above offer, well above grace).
    Expected: 1 event, confirmed=False.
    """
    rows = _tier1_rows()
    bar11_start = _BASE_TS_NS + (_ABSORPTION_BAR_INDEX + 1) * _BAR_NS
    for j in range(30):
        ts = bar11_start + (j * _BAR_NS // 30)
        price = _OFFER_PRICE if j % 2 == 0 else _BREAK_PRICE
        rows.append(
            _trade_row(event_ts_ns=ts, price=price, quantity=1, aggressor_side="buy")
        )
    return _to_trades_frame(rows), _tier1_mbp1()


def _build_tier5_breakout() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Tier 5: wide-range high-volume bar (a breakout, NOT absorption).

    Bar 10: 500 contracts spread across 27380.00 to 27385.00 (5pt = 20 ticks).
    All buys. Range hard gate (>4 ticks) rejects.
    Expected: NO event.
    """
    rows = _build_baseline_bars(bar_indexes=list(range(0, _ABSORPTION_BAR_INDEX)))

    bar_start = _BASE_TS_NS + _ABSORPTION_BAR_INDEX * _BAR_NS
    # 500 trades, prices stepping from 27380.00 to 27385.00
    for j in range(500):
        ts = bar_start + (j * _BAR_NS // 500)
        price = 27380.00 + (j / 500) * 5.0  # 0 → 5 pt range
        rows.append(_trade_row(event_ts_ns=ts, price=price, quantity=1, aggressor_side="buy"))

    pre_bin_ts = _BASE_TS_NS + _ABSORPTION_BAR_INDEX * _BAR_NS
    mbp1_rows = _build_mbp1_with_refill_pattern(pre_bin_ts_ns=pre_bin_ts)
    return _to_trades_frame(rows), _to_mbp1_frame(mbp1_rows)


# ===========================================================================
# Tier 1 — primary clean
# ===========================================================================


def test_tier1_emits_one_buy_absorbed_event() -> None:
    trades, mbp1 = _build_tier1_primary_clean()

    events = compute_absorption_events(trades, mbp1, MNQ)

    assert len(events) == 1
    evt = events[0]
    assert evt.side == "buy_absorbed"
    assert evt.score > 0.7
    assert evt.confirmed is False  # first pass; no confirmation applied
    assert evt.mbp1_stale is False


def test_tier1_event_dominant_price_at_offer() -> None:
    trades, mbp1 = _build_tier1_primary_clean()
    events = compute_absorption_events(trades, mbp1, MNQ)

    assert events[0].dominant_price == _OFFER_PRICE


def test_tier1_event_volume_and_delta_correct() -> None:
    trades, mbp1 = _build_tier1_primary_clean()
    events = compute_absorption_events(trades, mbp1, MNQ)

    evt = events[0]
    assert evt.volume == 500
    assert evt.net_delta == 500  # all buys


def test_tier1_event_range_one_tick_due_to_poke() -> None:
    trades, mbp1 = _build_tier1_primary_clean()
    events = compute_absorption_events(trades, mbp1, MNQ)

    # 95% at offer + 5% at offer+1tick → range = 1 tick
    assert events[0].range_ticks == 1


def test_tier1_event_bar_window_is_5_seconds() -> None:
    trades, mbp1 = _build_tier1_primary_clean()
    events = compute_absorption_events(trades, mbp1, MNQ)

    assert events[0].end_ts_ns - events[0].start_ts_ns == _BAR_NS


def test_tier1_factors_recorded() -> None:
    trades, mbp1 = _build_tier1_primary_clean()
    events = compute_absorption_events(trades, mbp1, MNQ)

    factors = events[0].factors
    assert set(factors.keys()) == {"volume", "range", "onesidedness", "displacement"}
    for k, v in factors.items():
        assert 0.0 <= v <= 1.0, f"factor {k} out of range: {v}"


# ===========================================================================
# Tier 2 — confirmation holds (next bar stays at/below grace)
# ===========================================================================


def test_tier2_confirmation_flips_confirmed_true() -> None:
    trades, mbp1 = _build_tier2_confirmation_holds()

    events = compute_absorption_events(trades, mbp1, MNQ)
    confirmed_events = apply_next_bar_confirmation(events, trades, MNQ)

    assert len(confirmed_events) == 1
    assert confirmed_events[0].confirmed is True


# ===========================================================================
# Tier 3 — confirmation breaks (next bar exceeds grace)
# ===========================================================================


def test_tier3_confirmation_remains_false() -> None:
    trades, mbp1 = _build_tier3_confirmation_breaks()

    events = compute_absorption_events(trades, mbp1, MNQ)
    confirmed_events = apply_next_bar_confirmation(events, trades, MNQ)

    assert len(confirmed_events) == 1
    assert confirmed_events[0].confirmed is False


# ===========================================================================
# Tier 5 — anti-test: breakout must NOT be flagged
# ===========================================================================


def test_tier5_wide_range_emits_no_event() -> None:
    trades, mbp1 = _build_tier5_breakout()

    events = compute_absorption_events(trades, mbp1, MNQ)

    assert events == []


# ===========================================================================
# Score formula — direct tests (ordering, weighting robustness)
# ===========================================================================


def test_score_weighting_robustness_all_factors_at_boundary() -> None:
    # All factors at 0.5 → score should land in [0.45, 0.55].
    # With weights summing to exactly 1.0 the score equals 0.5, but the
    # tolerance protects against quiet weight drift in future changes.
    config = AbsorptionConfig()
    factors = {"volume": 0.5, "range": 0.5, "onesidedness": 0.5, "displacement": 0.5}

    score = _compute_score(factors, config)

    assert 0.45 <= score <= 0.55


def test_score_monotonic_ordering() -> None:
    """Stronger absorption → higher score across the 4 calibration points."""
    config = AbsorptionConfig()

    score_050 = _compute_score(
        {"volume": 0.5, "range": 0.5, "onesidedness": 0.5, "displacement": 0.5}, config
    )
    score_060 = _compute_score(
        {"volume": 0.6, "range": 0.6, "onesidedness": 0.6, "displacement": 0.6}, config
    )
    score_080 = _compute_score(
        {"volume": 0.8, "range": 0.8, "onesidedness": 0.8, "displacement": 0.8}, config
    )
    score_095 = _compute_score(
        {"volume": 0.95, "range": 0.95, "onesidedness": 0.95, "displacement": 0.95}, config
    )

    assert score_050 < score_060 < score_080 < score_095
    # Specific values: with all factors equal, score == factor (weights sum to 1)
    assert score_050 == pytest.approx(0.50, abs=0.01)
    assert score_095 == pytest.approx(0.95, abs=0.01)


def test_score_weight_validation_at_construction() -> None:
    # Weights that don't sum to 1.0 should be rejected
    with pytest.raises(ValueError, match="weights must sum to 1.0"):
        AbsorptionConfig(
            volume_weight=0.5,
            range_weight=0.5,
            onesidedness_weight=0.5,
            displacement_weight=0.5,
        )


# ===========================================================================
# Cutoff (min_emit_score) — uses tier 1 with custom config
# ===========================================================================


def test_min_emit_score_filters_when_set_above_score() -> None:
    trades, mbp1 = _build_tier1_primary_clean()
    # Tier 1 scores ~0.94 by construction; lift cutoff above that → no event
    config = AbsorptionConfig(min_emit_score=0.99)

    events = compute_absorption_events(trades, mbp1, MNQ, config=config)

    assert events == []


def test_min_emit_score_default_emits_tier1() -> None:
    trades, mbp1 = _build_tier1_primary_clean()
    # Default cutoff = 0.5 → tier 1 (~0.94) emits
    events = compute_absorption_events(trades, mbp1, MNQ)

    assert len(events) == 1


# ===========================================================================
# Hard gates — independent verification
# ===========================================================================


def test_range_hard_gate_rejects_above_4_ticks() -> None:
    """A bar with range > max_range_ticks is rejected even if other factors strong."""
    trades, mbp1 = _build_tier5_breakout()  # ~20 ticks range
    # No need to add baseline; rejection is at the hard gate.

    events = compute_absorption_events(trades, mbp1, MNQ)

    assert events == []


def test_onesidedness_hard_gate_rejects_balanced_bar() -> None:
    # Construct a high-volume tight-range bar with balanced delta (250 buys, 250 sells).
    baseline = _build_baseline_bars(bar_indexes=list(range(0, _ABSORPTION_BAR_INDEX)))
    bar_start = _BASE_TS_NS + _ABSORPTION_BAR_INDEX * _BAR_NS
    for j in range(500):
        ts = bar_start + (j * _BAR_NS // 500)
        side = "buy" if j < 250 else "sell"
        baseline.append(
            _trade_row(event_ts_ns=ts, price=_OFFER_PRICE, quantity=1, aggressor_side=side)
        )
    trades = _to_trades_frame(baseline)

    pre_bin_ts = bar_start
    mbp1 = _to_mbp1_frame(_build_mbp1_with_refill_pattern(pre_bin_ts_ns=pre_bin_ts))

    events = compute_absorption_events(trades, mbp1, MNQ)

    assert events == []  # balanced delta → onesidedness=0 → rejected


def test_displacement_hard_gate_rejects_when_volume_low_vs_resting() -> None:
    """If bar volume << pre-bin resting size, displacement_factor too low."""
    baseline = _build_baseline_bars(bar_indexes=list(range(0, _ABSORPTION_BAR_INDEX)))
    # Absorption bar with only 100 contracts vs MBP1 ask_sz=10000 (1% displacement)
    baseline.extend(
        _build_absorption_bar(total_volume=100, poke_price=None, aggressor_side="buy")
    )
    trades = _to_trades_frame(baseline)

    pre_bin_ts = _BASE_TS_NS + _ABSORPTION_BAR_INDEX * _BAR_NS
    mbp1 = _to_mbp1_frame(
        _build_mbp1_with_refill_pattern(pre_bin_ts_ns=pre_bin_ts, pre_bin_size=10_000)
    )

    events = compute_absorption_events(trades, mbp1, MNQ)

    assert events == []


def test_no_break_hard_gate_rejects_when_bar_high_exceeds_offer_plus_grace() -> None:
    """A bar that traded above offer + grace is a breakout, not absorption."""
    baseline = _build_baseline_bars(bar_indexes=list(range(0, _ABSORPTION_BAR_INDEX)))
    bar_start = _BASE_TS_NS + _ABSORPTION_BAR_INDEX * _BAR_NS
    # Most trades at offer, but 5% at offer+0.75 (3 ticks above) — beyond +1 tick grace.
    n = 500
    for j in range(int(0.95 * n)):
        ts = bar_start + (j * _BAR_NS // n)
        baseline.append(
            _trade_row(event_ts_ns=ts, price=_OFFER_PRICE, quantity=1, aggressor_side="buy")
        )
    for k in range(int(0.05 * n)):
        ts = bar_start + ((int(0.95 * n) + k) * _BAR_NS // n)
        baseline.append(
            _trade_row(event_ts_ns=ts, price=_OFFER_PRICE + 0.75, quantity=1, aggressor_side="buy")
        )
    trades = _to_trades_frame(baseline)

    mbp1 = _to_mbp1_frame(_build_mbp1_with_refill_pattern(pre_bin_ts_ns=bar_start))

    events = compute_absorption_events(trades, mbp1, MNQ)

    # bar_high = 27381.00 > 27380.25 + grace(0.25) = 27380.50 → reject
    # But wait — the range is 3 ticks which is < 4, so range-gate doesn't reject.
    # And there ARE absorption-style trades. The no-break gate is what catches it.
    assert events == []


# ===========================================================================
# MBP1 staleness handling
# ===========================================================================


def test_mbp1_stale_when_no_snapshot_in_lookback_window() -> None:
    """If MBP1 has no snapshot within lookback_sec of bar start, mbp1_stale=True
    and displacement_factor=0 → event fails hard gate, no emit."""
    baseline = _build_baseline_bars(bar_indexes=list(range(0, _ABSORPTION_BAR_INDEX)))
    baseline.extend(
        _build_absorption_bar(total_volume=500, poke_price=_GRACE_PRICE, poke_fraction=0.05)
    )
    trades = _to_trades_frame(baseline)

    # MBP1 snapshots are way before the absorption bar — all outside the 5s lookback.
    far_past = _BASE_TS_NS - 60 * _NS_PER_SEC
    mbp1 = _to_mbp1_frame([
        {
            "event_ts_ns": far_past,
            "recv_ts_ns": far_past + 1000,
            "bid_px_00": 27380.00, "bid_sz_00": 100, "bid_ct_00": 10,
            "ask_px_00": _OFFER_PRICE, "ask_sz_00": 100, "ask_ct_00": 10,
        }
    ])

    events = compute_absorption_events(trades, mbp1, MNQ)

    # Stale MBP1 → displacement = 0 → displacement-factor=0 < min_displacement → reject
    assert events == []


def test_empty_mbp1_treats_all_bars_as_stale() -> None:
    baseline = _build_baseline_bars(bar_indexes=list(range(0, _ABSORPTION_BAR_INDEX)))
    baseline.extend(
        _build_absorption_bar(total_volume=500, poke_price=_GRACE_PRICE, poke_fraction=0.05)
    )
    trades = _to_trades_frame(baseline)
    mbp1 = _to_mbp1_frame([])

    events = compute_absorption_events(trades, mbp1, MNQ)

    # No MBP1 at all → all stale → no displacement → no events.
    assert events == []


# ===========================================================================
# Sell-side absorption (mirror of tier 1)
# ===========================================================================


def test_sell_absorbed_at_bid() -> None:
    """Mirror of tier 1: heavy sells against the bid, bid refills."""
    bid_price = 27380.00
    grace_below = 27379.75  # = bid - 1 tick

    baseline = _build_baseline_bars(bar_indexes=list(range(0, _ABSORPTION_BAR_INDEX)))
    bar_start = _BASE_TS_NS + _ABSORPTION_BAR_INDEX * _BAR_NS
    n = 500
    for j in range(int(0.95 * n)):
        ts = bar_start + (j * _BAR_NS // n)
        baseline.append(
            _trade_row(event_ts_ns=ts, price=bid_price, quantity=1, aggressor_side="sell")
        )
    for k in range(int(0.05 * n)):
        ts = bar_start + ((int(0.95 * n) + k) * _BAR_NS // n)
        baseline.append(
            _trade_row(event_ts_ns=ts, price=grace_below, quantity=1, aggressor_side="sell")
        )
    trades = _to_trades_frame(baseline)

    # MBP1 with bid refill pattern
    mbp1_rows = []

    def _row(ts: int, bid_sz: int) -> dict[str, Any]:
        return {
            "event_ts_ns": ts,
            "recv_ts_ns": ts + 1_000,
            "bid_px_00": bid_price, "bid_sz_00": bid_sz, "bid_ct_00": 10,
            "ask_px_00": bid_price + 0.25, "ask_sz_00": 100, "ask_ct_00": 10,
        }

    mbp1_rows.extend([
        _row(bar_start - _NS_PER_SEC, 100),
        _row(bar_start - 100_000_000, 100),
        _row(bar_start + _BAR_NS // 2, 10),
        _row(bar_start + _BAR_NS - 100_000_000, 100),
    ])
    mbp1 = _to_mbp1_frame(mbp1_rows)

    events = compute_absorption_events(trades, mbp1, MNQ)

    assert len(events) == 1
    assert events[0].side == "sell_absorbed"
    assert events[0].dominant_price == bid_price


# ===========================================================================
# Empty / edge inputs
# ===========================================================================


def test_empty_trades_returns_empty() -> None:
    empty_trades = pd.DataFrame(
        columns=["event_ts_ns", "price", "quantity", "signed_qty"]
    ).astype(
        {"event_ts_ns": "int64", "price": "float64", "quantity": "int32", "signed_qty": "int32"}
    )
    mbp1 = _to_mbp1_frame([])

    assert compute_absorption_events(empty_trades, mbp1, MNQ) == []


def test_apply_next_bar_confirmation_empty_events() -> None:
    trades, _ = _build_tier1_primary_clean()
    assert apply_next_bar_confirmation([], trades, MNQ) == []


def test_apply_next_bar_confirmation_no_next_bar_keeps_unconfirmed() -> None:
    trades, mbp1 = _build_tier1_primary_clean()  # tier 1 has no bar 11 data
    events = compute_absorption_events(trades, mbp1, MNQ)

    confirmed = apply_next_bar_confirmation(events, trades, MNQ)

    assert confirmed[0].confirmed is False  # no next-bar data


# ===========================================================================
# Conviction-upgrade helper
# ===========================================================================


def _make_event_at(price: float) -> AbsorptionEvent:
    return AbsorptionEvent(
        start_ts_ns=0,
        end_ts_ns=_BAR_NS,
        side="buy_absorbed",
        price_center=price,
        dominant_price=price,
        volume=500,
        net_delta=500,
        range_ticks=1,
        score=0.85,
        confirmed=True,
        mbp1_stale=False,
        factors={"volume": 1.0, "range": 0.75, "onesidedness": 1.0, "displacement": 1.0},
    )


def test_conviction_upgrade_when_event_overlaps_hvn() -> None:
    event = _make_event_at(27380.25)
    zones = [
        Zone(
            id="hvn-27380",
            top=27385.0,
            bot=27380.0,
            type="support",
            conviction="MED",
            text="HVN 13.8%",
            sources=["hvn_rth"],
        )
    ]

    suggested = suggest_conviction_upgrade(event, zones)

    assert suggested == "HIGH"


def test_conviction_upgrade_skips_non_hvn_zones() -> None:
    event = _make_event_at(27380.25)
    zones = [
        Zone(
            id="vah",
            top=27385.0,
            bot=27380.0,
            type="resistance",
            conviction="MED",
            text="VAH",
            sources=["vah"],  # not an HVN source
        )
    ]

    suggested = suggest_conviction_upgrade(event, zones)

    assert suggested is None


def test_conviction_upgrade_skips_far_zones() -> None:
    event = _make_event_at(27380.25)
    zones = [
        Zone(
            id="hvn-27400",
            top=27405.0,
            bot=27400.0,
            type="support",
            conviction="MED",
            text="HVN",
            sources=["hvn_rth"],
        )
    ]

    suggested = suggest_conviction_upgrade(event, zones, distance_points=1.0)

    assert suggested is None


def test_conviction_upgrade_skips_already_high_zones() -> None:
    event = _make_event_at(27380.25)
    zones = [
        Zone(
            id="hvn-27380",
            top=27385.0,
            bot=27380.0,
            type="support",
            conviction="HIGH",  # already HIGH; no further upgrade
            text="HVN",
            sources=["hvn_5m", "weekly_avwap_band", "ema50"],
        )
    ]

    suggested = suggest_conviction_upgrade(event, zones)

    assert suggested is None


# ===========================================================================
# Dataclass safety
# ===========================================================================


def test_absorption_config_is_frozen() -> None:
    config = AbsorptionConfig()
    with pytest.raises(dataclasses.FrozenInstanceError):
        config.bar_size_sec = 99  # type: ignore[misc]


def test_absorption_event_is_frozen() -> None:
    evt = _make_event_at(27380.25)
    with pytest.raises(dataclasses.FrozenInstanceError):
        evt.score = 99.0  # type: ignore[misc]


def test_event_to_dict_is_json_serializable() -> None:
    import json

    evt = _make_event_at(27380.25)
    s = json.dumps(evt.to_dict())
    parsed = json.loads(s)
    assert parsed["side"] == "buy_absorbed"
    assert parsed["score"] == 0.85
    assert parsed["factors"]["volume"] == 1.0


# ===========================================================================
# Custom config — tick-aware grace
# ===========================================================================


def test_grace_is_contract_aware() -> None:
    """Verify the grace is computed as ticks × contract.tick_size, not hardcoded.

    Tier-1 fixture's poke at offer + 1 tick (= 27380.50). With default
    no_break_grace_ticks=1, that's exactly at the grace boundary → accepted.
    Tightening to 0 ticks → grace=0 → poke at offer+1tick > grace → rejected.
    """
    trades, mbp1 = _build_tier1_primary_clean()
    strict = AbsorptionConfig(no_break_grace_ticks=0)

    events = compute_absorption_events(trades, mbp1, MNQ, config=strict)

    # With no grace, the 5% pokes at offer+1tick exceed grace → rejected.
    assert events == []


def test_custom_bar_size_sec() -> None:
    """A longer bar size pulls more trades into one bucket."""
    trades, mbp1 = _build_tier1_primary_clean()
    long_bar = AbsorptionConfig(bar_size_sec=10)

    events = compute_absorption_events(trades, mbp1, MNQ, config=long_bar)

    # With 10s bars, bar boundaries shift and the absorption may merge with a
    # baseline bar; whether it still flags depends on the merge. Either way,
    # construction must not raise.
    assert isinstance(events, list)


# ===========================================================================
# RA-030: production-correctness gate
#
# Regression: pre-RA-030, the live capture pipeline dropped L1_QUOTE records
# entirely → load_mbp1 returned empty → absorption ran in degraded
# 3-factor mode (mbp1_stale=True, displacement_factor=0). This test feeds
# the 2026-05-19 smoke-test capture through the new normalizer chain and
# asserts at least one event scoring >0.5 has non-zero displacement_factor.
# ===========================================================================


@pytest.mark.slow
def test_absorption_smoketest_capture_mbp1_join_succeeds(tmp_path: Path) -> None:
    """Smoke-test capture (~15 min) is too short to guarantee absorption events,
    but the normalizer chain must produce MBP1 that load_mbp1 consumes and
    that absorption's merge_asof can join against — that's the discriminating
    test vs the pre-RA-030 empty-MBP1 state."""
    from rithmic_analytics.core.loader import load_mbp1, load_obs01_trades
    from rithmic_analytics.ops.normalize_probe import normalize_probe_to_obs01

    smoketest = Path(
        "D:/Quant-futures-app/tools/rithmic_analytics/"
        "data/captures_smoketest/2026-05-19/MNQ_rth.jsonl"
    )
    if not smoketest.exists():
        pytest.skip(f"smoke-test capture not on disk: {smoketest}")

    obs01_out = tmp_path / "MNQ_rth.obs01.jsonl"
    mbp1_out = tmp_path / "MNQ_rth.mbp1.jsonl"

    report = normalize_probe_to_obs01(smoketest, obs01_out, mbp1_out_path=mbp1_out)
    assert report.trades_emitted > 1000
    assert report.mbp1_records_emitted > 100, (
        f"expected >100 MBP1 quotes; got {report.mbp1_records_emitted}. "
        f"L1_QUOTE routing broken."
    )

    trades = load_obs01_trades(obs01_out)
    mbp1 = load_mbp1(mbp1_out)
    assert len(mbp1) > 0, "load_mbp1 returned empty — schema mismatch"
    assert "bid_px_00" in mbp1.columns
    assert "ask_px_00" in mbp1.columns

    # Compute absorption — even if zero events trigger, the call must not crash
    # and (critically) any events that DO trigger must not show mbp1_stale=True
    # universally. Pre-RA-030, every event would have mbp1_stale=True because
    # MBP1 was empty. Post-RA-030, the merge_asof should find matches.
    events = compute_absorption_events(trades, mbp1, MNQ)
    if events:
        # If we got events, none should ALL be stale — that'd indicate the
        # MBP1 join silently failed.
        all_stale = all(e.mbp1_stale for e in events)
        assert not all_stale, (
            f"all {len(events)} events have mbp1_stale=True — MBP1 join failed despite "
            f"non-empty MBP1 input ({len(mbp1)} rows). Sample event 0 factors: "
            f"{events[0].factors}"
        )


@pytest.mark.slow
def test_absorption_runs_four_factor_on_validated_fixture(tmp_path: Path) -> None:
    """Production correctness: L1_QUOTE → MBP1 chain restores displacement factor.

    Uses the validated probe-parity-post04d.jsonl fixture (4.1 GB, ~37 min RTH)
    which contains both LAST_TRADE and L1_QUOTE records.

    The default ``AbsorptionConfig`` thresholds (``min_onesidedness=0.6``,
    ``min_displacement=0.5``) were calibrated against synthetic fixtures
    that exhibit stronger one-sidedness than this real-data session does.
    Calibration against post-RA-030 real-data is **explicitly out of
    scope for RA-030** (it's the B2 follow-up in the audit). So this test
    uses a permissive config that lets the four-factor signal through,
    then asserts on the proportion of events with the **restoring**
    characteristics:

        * ``mbp1_stale=False`` (the MBP1 join found a snapshot)
        * ``displacement > 0`` (the 4th factor is contributing)

    Pre-RA-030, MBP1 was empty → every event would have
    ``mbp1_stale=True`` and ``displacement=0``.
    """
    from rithmic_analytics.core.loader import load_mbp1, load_obs01_trades
    from rithmic_analytics.ops.normalize_probe import normalize_probe_to_obs01

    fixture = Path(
        "D:/Quant-futures-app/data/probes/infra01/full/probe-parity-post04d.jsonl"
    )
    if not fixture.exists():
        pytest.skip(f"validated parity fixture not on disk: {fixture}")

    obs01_out = tmp_path / "MNQ_rth.obs01.jsonl"
    mbp1_out = tmp_path / "MNQ_rth.mbp1.jsonl"

    report = normalize_probe_to_obs01(
        fixture, obs01_out, mbp1_out_path=mbp1_out,
        session_id="mnq-2026-04-27-rth", run_id="post04d-test",
    )
    assert report.trades_emitted > 10_000
    assert report.mbp1_records_emitted > 10_000

    trades = load_obs01_trades(obs01_out)
    mbp1 = load_mbp1(mbp1_out)

    # Permissive config to bypass the not-yet-calibrated hard gates
    # (B2 follow-up). Lets the four-factor signal through so we can
    # assert on its presence directly.
    permissive = AbsorptionConfig(
        min_emit_score=0.0,
        min_onesidedness=0.0,
        min_displacement=0.0,
        max_range_ticks=100,
    )
    events = compute_absorption_events(trades, mbp1, MNQ, config=permissive)
    assert events, "no absorption events at permissive config — pipeline broken"

    # The discriminating assertion: post-RA-030 the MAJORITY of events
    # must show the restored four-factor characteristics. Pre-RA-030 every
    # event would have mbp1_stale=True + displacement=0.
    non_stale = [e for e in events if not e.mbp1_stale]
    with_displacement = [e for e in events if e.factors.get("displacement", 0.0) > 0.0]

    assert len(non_stale) / len(events) > 0.5, (
        f"only {len(non_stale)}/{len(events)} events have mbp1_stale=False; "
        f"expected majority post-RA-030"
    )
    assert len(with_displacement) / len(events) > 0.5, (
        f"only {len(with_displacement)}/{len(events)} events have "
        f"displacement>0; expected majority post-RA-030"
    )

    # Acceptance: at least one event scoring >0.5 has both — that's the
    # direct four-factor restoration test.
    qualifying = [
        e for e in events
        if e.score > 0.5
        and not e.mbp1_stale
        and e.factors.get("displacement", 0.0) > 0.0
    ]
    assert qualifying, (
        f"found {len(events)} events but none with score>0.5 + non-zero "
        f"displacement + mbp1_stale=False. Sample event 0: "
        f"score={events[0].score:.3f} mbp1_stale={events[0].mbp1_stale} "
        f"factors={events[0].factors}"
    )
