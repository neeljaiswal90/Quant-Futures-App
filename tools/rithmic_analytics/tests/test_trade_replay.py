"""Tests for ``rithmic_analytics.features.trade_replay`` (RA-026)."""

from __future__ import annotations

import math
import time

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.schema import Zone
from rithmic_analytics.core.trade_log import TradeFill
from rithmic_analytics.features.trade_replay import (
    FillSnapshot,
    ReplaySession,
    compute_fill_snapshot,
    replay_session,
)

_NS_PER_SECOND = 10**9


# ---------------------------------------------------------------------------
# Synthetic fixtures
# ---------------------------------------------------------------------------


def _make_trades(rows: list[tuple[int, float, int, int]]) -> pd.DataFrame:
    """Build a trades DataFrame from ``(event_ts_ns, price, quantity, signed_qty)``."""
    df = pd.DataFrame(
        rows, columns=["event_ts_ns", "price", "quantity", "signed_qty"]
    )
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["price"] = df["price"].astype("float64")
    df["quantity"] = df["quantity"].astype("int64")
    df["signed_qty"] = df["signed_qty"].astype("int64")
    df["session_id"] = "mnq-2026-05-19-rth"
    return df.sort_values("event_ts_ns").reset_index(drop=True)


def _make_fill(
    *,
    fill_ts_ns: int,
    side: str = "buy",
    price: float = 27000.0,
    quantity: int = 1,
    symbol: str = "MNQ",
    fill_id: str = "f-1",
    quarantined: bool = False,
) -> TradeFill:
    return TradeFill(
        fill_ts_ns=fill_ts_ns,
        symbol=symbol,
        side=side,  # type: ignore[arg-type]
        price=price,
        quantity=quantity,
        order_type="market",
        fill_id=fill_id,
        quarantined=quarantined,
    )


# Anchor: 9:30 ET → 13:30 UTC → 4860 * 60 * 60 * 1e9 ns since epoch is irrelevant;
# just use a large round timestamp.
_BASE_TS = 1_777_300_000_000_000_000  # 2026-04-27ish


# ---------------------------------------------------------------------------
# Hand-computed happy path
# ---------------------------------------------------------------------------


def test_compute_fill_snapshot_pre_window_volume_and_delta() -> None:
    """5 trades in pre window: 2 buys of 3, 1 sell of 2, 2 buys of 1 → vol=10, delta=+6."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND  # 60s after session start
    trades = _make_trades(
        [
            # In pre window [fill-60s, fill]
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 3, 3),   # buy 3
            (_BASE_TS + 20 * _NS_PER_SECOND, 27001.0, 3, 3),   # buy 3
            (_BASE_TS + 30 * _NS_PER_SECOND, 27000.5, 2, -2),  # sell 2
            (_BASE_TS + 40 * _NS_PER_SECOND, 27001.0, 1, 1),   # buy 1
            (_BASE_TS + 50 * _NS_PER_SECOND, 27001.5, 1, 1),   # buy 1
            # Outside pre window (after fill)
            (_BASE_TS + 90 * _NS_PER_SECOND, 27002.0, 1, 1),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts, price=27001.5)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    assert snap.pre_volume == 10
    assert snap.pre_delta == 6


def test_compute_fill_snapshot_aggressor_ratio_one_sided_buy() -> None:
    """All buys in pre window → ratio = 1.0."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 2, 2),
            (_BASE_TS + 30 * _NS_PER_SECOND, 27001.0, 3, 3),
            (_BASE_TS + 50 * _NS_PER_SECOND, 27002.0, 5, 5),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    assert snap.pre_aggressor_ratio == pytest.approx(1.0)


def test_compute_fill_snapshot_aggressor_ratio_balanced() -> None:
    """Equal buys/sells → ratio = 0.0."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 5, 5),
            (_BASE_TS + 30 * _NS_PER_SECOND, 27000.0, 5, -5),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    assert snap.pre_aggressor_ratio == pytest.approx(0.0)


def test_compute_fill_snapshot_vwap_volume_weighted() -> None:
    """VWAP = sum(p*q) / sum(q). Hand: (100*1 + 200*2 + 300*3) / (1+2+3) = 233.33..."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 100.0, 1, 1),
            (_BASE_TS + 30 * _NS_PER_SECOND, 200.0, 2, 2),
            (_BASE_TS + 50 * _NS_PER_SECOND, 300.0, 3, 3),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    expected_vwap = (100 * 1 + 200 * 2 + 300 * 3) / (1 + 2 + 3)
    assert snap.pre_vwap == pytest.approx(expected_vwap)


def test_compute_fill_snapshot_price_change_last_minus_first() -> None:
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1),
            (_BASE_TS + 30 * _NS_PER_SECOND, 27005.0, 1, 1),
            (_BASE_TS + 50 * _NS_PER_SECOND, 27003.0, 1, 1),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    # last (27003) - first (27000) = +3
    assert snap.pre_price_change == pytest.approx(3.0)


def test_compute_fill_snapshot_pre_cvd_cumulative_from_session_start() -> None:
    """pre_cvd is cumulative across ALL trades up to fill, not just window."""
    fill_ts = _BASE_TS + 120 * _NS_PER_SECOND  # fill at t+120s
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 10, 10),   # before window
            (_BASE_TS + 30 * _NS_PER_SECOND, 27000.0, 5, -5),    # before window
            (_BASE_TS + 80 * _NS_PER_SECOND, 27000.0, 3, 3),     # in window
            # Total signed_qty up to fill = 10 - 5 + 3 = 8
            (_BASE_TS + 150 * _NS_PER_SECOND, 27000.0, 2, 2),    # after fill (excluded)
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    assert snap.pre_cvd == 8


def test_compute_fill_snapshot_pnl_buy_positive() -> None:
    """Buy at 27000, market climbs to 27005 at +60s → PnL = (27005-27000)*$2*qty."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 50 * _NS_PER_SECOND, 27000.0, 1, 1),
            # At exactly fill+60s: price 27005
            (fill_ts + 60 * _NS_PER_SECOND, 27005.0, 1, 1),
            (fill_ts + 70 * _NS_PER_SECOND, 27006.0, 1, 1),  # buffer past horizon
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts, side="buy", price=27000.0, quantity=2)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    # 5 pts * $2/pt * 2 contracts = $20
    assert snap.realized_pnl[60] == pytest.approx(20.0)


def test_compute_fill_snapshot_pnl_sell_positive() -> None:
    """Sell at 27000, market drops to 26995 at +60s → PnL = (-1)*(26995-27000)*$2 = +$10."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 50 * _NS_PER_SECOND, 27000.0, 1, 1),
            (fill_ts + 60 * _NS_PER_SECOND, 26995.0, 1, -1),
            (fill_ts + 70 * _NS_PER_SECOND, 26994.0, 1, -1),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts, side="sell", price=27000.0, quantity=1)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    # -1 * (26995 - 27000) * $2 * 1 = +$10
    assert snap.realized_pnl[60] == pytest.approx(10.0)


def test_compute_fill_snapshot_pnl_late_session_returns_none() -> None:
    """Fill near end-of-session → 60s available, 300s & 900s None."""
    fill_ts = _BASE_TS + 100 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 50 * _NS_PER_SECOND, 27000.0, 1, 1),
            (fill_ts + 60 * _NS_PER_SECOND, 27005.0, 1, 1),  # exactly +60s
            (fill_ts + 70 * _NS_PER_SECOND, 27006.0, 1, 1),  # end of session
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts, price=27000.0)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    assert snap.realized_pnl[60] is not None
    assert snap.realized_pnl[300] is None
    assert snap.realized_pnl[900] is None


def test_compute_fill_snapshot_quarantined_pnl_nan() -> None:
    """Quarantined fill has nan price → nan PnL across all horizons."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 50 * _NS_PER_SECOND, 27000.0, 1, 1),
            (fill_ts + 60 * _NS_PER_SECOND, 27005.0, 1, 1),
        ]
    )
    fill = _make_fill(
        fill_ts_ns=fill_ts, price=float("nan"), quarantined=True
    )

    snap = compute_fill_snapshot(fill, trades, MNQ)

    for h in (60, 300, 900):
        assert math.isnan(snap.realized_pnl[h])  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Zone proximity
# ---------------------------------------------------------------------------


def _zone(zid: str, top: float, bot: float) -> Zone:
    return Zone(
        id=zid,
        top=top,
        bot=bot,
        type="support",
        conviction="MED",
        text=f"Zone {zid}",
        sources=["hvn_5m"],
    )


def test_compute_fill_snapshot_zone_proximity_within_atr() -> None:
    """Zones within 1×ATR of fill price are included; far zones excluded."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [(_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1)]
    )
    fill = _make_fill(fill_ts_ns=fill_ts, price=27000.0)

    zones = [
        _zone("near-1", 27003.0, 27001.0),   # center=27002, dist=2
        _zone("near-2", 27010.0, 27008.0),   # center=27009, dist=9
        _zone("far", 27200.0, 27198.0),      # center=27199, dist=199
    ]
    atr_14 = 30.0  # threshold

    snap = compute_fill_snapshot(fill, trades, MNQ, zones=zones, atr_14=atr_14)

    assert "near-1" in snap.pre_zone_proximity
    assert "near-2" in snap.pre_zone_proximity
    assert "far" not in snap.pre_zone_proximity
    assert snap.atr_fallback is False


def test_compute_fill_snapshot_zone_proximity_atr_none_falls_back_top5() -> None:
    """atr_14=None → top-5 nearest regardless of distance, atr_fallback=True."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [(_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1)]
    )
    fill = _make_fill(fill_ts_ns=fill_ts, price=27000.0)

    zones = [_zone(f"z-{i}", 27000.0 + i * 100, 27000.0 + i * 100 - 5) for i in range(8)]

    snap = compute_fill_snapshot(fill, trades, MNQ, zones=zones, atr_14=None)

    assert len(snap.pre_zone_proximity) == 5
    assert snap.atr_fallback is True


def test_compute_fill_snapshot_zone_proximity_atr_nan_falls_back() -> None:
    """atr_14=NaN treated identically to None."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [(_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1)]
    )
    fill = _make_fill(fill_ts_ns=fill_ts, price=27000.0)

    zones = [_zone("z-0", 27001.0, 26999.0)]
    snap = compute_fill_snapshot(fill, trades, MNQ, zones=zones, atr_14=float("nan"))

    assert "z-0" in snap.pre_zone_proximity
    assert snap.atr_fallback is True


def test_compute_fill_snapshot_no_zones_empty_dict() -> None:
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [(_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1)]
    )
    fill = _make_fill(fill_ts_ns=fill_ts)

    snap = compute_fill_snapshot(fill, trades, MNQ, zones=None, atr_14=10.0)

    assert snap.pre_zone_proximity == {}
    assert snap.atr_fallback is False


def test_compute_fill_snapshot_zone_proximity_caps_at_5_within_atr() -> None:
    """If 10 zones are all within 1×ATR, dict is still capped at 5 nearest."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [(_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1)]
    )
    fill = _make_fill(fill_ts_ns=fill_ts, price=27000.0)

    zones = [_zone(f"z-{i}", 27000.0 + i, 26999.0 + i) for i in range(10)]
    atr_14 = 100.0  # huge → all 10 zones are within

    snap = compute_fill_snapshot(fill, trades, MNQ, zones=zones, atr_14=atr_14)

    assert len(snap.pre_zone_proximity) == 5


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_compute_fill_snapshot_at_exact_tick_boundary() -> None:
    """A trade at exactly fill_ts is contextual to both pre and post windows."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 30 * _NS_PER_SECOND, 27000.0, 1, 1),
            (fill_ts, 27001.0, 5, 5),  # exactly at fill_ts
            (fill_ts + 30 * _NS_PER_SECOND, 27002.0, 1, 1),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts, price=27001.0)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    # Pre window includes the boundary trade (right-inclusive)
    assert snap.pre_volume >= 5
    # Post window also includes it (left-inclusive)
    assert snap.post_volume >= 5


def test_compute_fill_snapshot_zero_pre_window_volume() -> None:
    """Fill at session start with no prior trades → pre stats are zero/None."""
    trades = _make_trades(
        [
            (_BASE_TS, 27000.0, 1, 1),
            (_BASE_TS + 30 * _NS_PER_SECOND, 27001.0, 1, 1),
        ]
    )
    # Fill 1 second before any data → pre window is empty
    fill = _make_fill(fill_ts_ns=_BASE_TS - 1 * _NS_PER_SECOND)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    assert snap.pre_volume == 0
    assert snap.pre_delta == 0
    assert snap.pre_aggressor_ratio is None
    assert snap.pre_vwap is None
    assert snap.pre_price_change is None


def test_compute_fill_snapshot_zero_post_window_volume() -> None:
    """Fill at session end → post stats are zero/None."""
    fill_ts = _BASE_TS + 100 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 50 * _NS_PER_SECOND, 27000.0, 1, 1),
            (fill_ts, 27001.0, 1, 1),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts + 10 * _NS_PER_SECOND)  # after last trade

    snap = compute_fill_snapshot(fill, trades, MNQ)

    assert snap.post_volume == 0
    assert snap.post_delta == 0
    assert snap.post_aggressor_ratio is None


def test_compute_fill_snapshot_post_cvd_60s_none_when_session_ends_before() -> None:
    fill_ts = _BASE_TS + 100 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 50 * _NS_PER_SECOND, 27000.0, 1, 1),
            (fill_ts + 30 * _NS_PER_SECOND, 27001.0, 1, 1),  # only +30s into post
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts)

    snap = compute_fill_snapshot(fill, trades, MNQ)

    assert snap.post_cvd_60s is None


# ---------------------------------------------------------------------------
# replay_session
# ---------------------------------------------------------------------------


def test_replay_session_sorts_by_fill_ts() -> None:
    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0 + i, 1, 1) for i in range(120)]
    )
    fills = [
        _make_fill(fill_ts_ns=_BASE_TS + 90 * _NS_PER_SECOND, fill_id="f-late"),
        _make_fill(fill_ts_ns=_BASE_TS + 30 * _NS_PER_SECOND, fill_id="f-early"),
    ]

    session = replay_session(fills, trades, MNQ)

    assert [s.fill.fill_id for s in session.snapshots] == ["f-early", "f-late"]


def test_replay_session_skips_symbol_mismatch_warns() -> None:
    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0, 1, 1) for i in range(120)]
    )
    fills = [
        _make_fill(fill_ts_ns=_BASE_TS + 30 * _NS_PER_SECOND, symbol="MNQ", fill_id="match"),
        _make_fill(fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND, symbol="ES", fill_id="mismatch"),
    ]

    session = replay_session(fills, trades, MNQ)

    assert len(session.snapshots) == 1
    assert session.snapshots[0].fill.fill_id == "match"
    assert session.fills_skipped_symbol_mismatch == 1
    assert session.fills_skipped_outside_window == 0


def test_replay_session_skips_outside_window() -> None:
    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0, 1, 1) for i in range(120)]
    )
    fills = [
        _make_fill(fill_ts_ns=_BASE_TS - 100 * _NS_PER_SECOND, fill_id="before"),
        _make_fill(fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND, fill_id="ok"),
        _make_fill(fill_ts_ns=_BASE_TS + 300 * _NS_PER_SECOND, fill_id="after"),
    ]

    session = replay_session(fills, trades, MNQ)

    assert {s.fill.fill_id for s in session.snapshots} == {"ok"}
    assert session.fills_skipped_outside_window == 2


def test_replay_session_empty_trades_skips_all_outside_window() -> None:
    """Empty trades DataFrame → every matching-symbol fill counted as outside-window."""
    trades = _make_trades([])
    fills = [
        _make_fill(fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND, symbol="MNQ"),
        _make_fill(fill_ts_ns=_BASE_TS + 60 * _NS_PER_SECOND, symbol="ES"),
    ]

    session = replay_session(fills, trades, MNQ)

    assert session.snapshots == []
    assert session.fills_skipped_outside_window == 1
    assert session.fills_skipped_symbol_mismatch == 1


def test_replay_session_preserves_cancelled_passthrough() -> None:
    from rithmic_analytics.core.trade_log import CancelledOrder

    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0, 1, 1) for i in range(120)]
    )
    cancelled = [
        CancelledOrder(
            cancel_ts_ns=_BASE_TS + 40 * _NS_PER_SECOND, symbol="MNQ", side="buy",
            order_type="limit", limit_price=27000.0, stop_price=None,
            quantity=1, status="Cancelled (by trader)",
        ),
    ]

    session = replay_session([], trades, MNQ, cancelled=cancelled)

    assert session.cancelled == cancelled


def test_replay_session_metadata_carries_window_and_horizons() -> None:
    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0, 1, 1) for i in range(120)]
    )
    session = replay_session([], trades, MNQ, window_seconds=45, pnl_horizons_seconds=(30, 90))
    assert session.window_seconds == 45
    assert session.pnl_horizons_seconds == (30, 90)


# ---------------------------------------------------------------------------
# Perf
# ---------------------------------------------------------------------------


def test_replay_session_perf_100k_trades_50_fills() -> None:
    """Sub-5s budget per RA-026 spec."""
    rng = np.random.default_rng(seed=42)
    n = 100_000
    ts = _BASE_TS + np.arange(n, dtype="int64") * 10**6  # 1ms spacing
    prices = 27000.0 + rng.normal(0, 5, size=n)
    qtys = rng.integers(1, 5, size=n)
    signed = qtys * rng.choice([1, -1], size=n)
    df = pd.DataFrame({
        "event_ts_ns": ts,
        "price": prices,
        "quantity": qtys.astype("int64"),
        "signed_qty": signed.astype("int64"),
        "session_id": "perf",
    })

    # 50 fills spread across the session
    fill_idxs = rng.integers(1000, n - 1000, size=50)
    fills = [
        _make_fill(
            fill_ts_ns=int(ts[i]),
            price=float(prices[i]),
            fill_id=f"f-{k}",
        )
        for k, i in enumerate(fill_idxs)
    ]

    start = time.perf_counter()
    session = replay_session(fills, df, MNQ)
    elapsed = time.perf_counter() - start

    assert len(session.snapshots) == 50
    assert elapsed < 5.0, f"replay took {elapsed:.2f}s, budget is 5s"


# ---------------------------------------------------------------------------
# Dataclass invariants
# ---------------------------------------------------------------------------


def test_fill_snapshot_is_frozen() -> None:
    import dataclasses
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1),
            (fill_ts + 60 * _NS_PER_SECOND, 27001.0, 1, 1),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts)
    snap = compute_fill_snapshot(fill, trades, MNQ)
    with pytest.raises(dataclasses.FrozenInstanceError):
        snap.pre_volume = 999  # type: ignore[misc]


def test_replay_session_to_dict_serialises_cleanly() -> None:
    """FillSnapshot.to_dict() is JSON-safe."""
    import json
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1),
            (fill_ts + 60 * _NS_PER_SECOND, 27005.0, 1, 1),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts, price=27000.0)
    snap = compute_fill_snapshot(fill, trades, MNQ)

    d = snap.to_dict()
    # All values must be JSON-serializable (NaN handled by allow_nan default).
    serialized = json.dumps(d, default=str)
    assert len(serialized) > 0
    assert "fill_id" in serialized


def test_default_pnl_horizons_match_spec() -> None:
    """RA-026 spec: 60s / 300s / 900s as defaults."""
    from rithmic_analytics.features.trade_replay import DEFAULT_PNL_HORIZONS_SEC
    assert DEFAULT_PNL_HORIZONS_SEC == (60, 300, 900)


def test_fill_snapshot_dict_round_trip_stability() -> None:
    """Identical inputs → identical to_dict() output."""
    fill_ts = _BASE_TS + 60 * _NS_PER_SECOND
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1),
            (fill_ts + 60 * _NS_PER_SECOND, 27005.0, 1, 1),
        ]
    )
    fill = _make_fill(fill_ts_ns=fill_ts)

    snap_a = compute_fill_snapshot(fill, trades, MNQ)
    snap_b = compute_fill_snapshot(fill, trades, MNQ)
    assert snap_a.to_dict() == snap_b.to_dict()
    assert isinstance(snap_a, FillSnapshot)
    assert isinstance(
        ReplaySession(snapshots=[], cancelled=[], target_symbol="MNQ",
                      fills_skipped_symbol_mismatch=0,
                      fills_skipped_outside_window=0, window_seconds=60),
        ReplaySession,
    )
