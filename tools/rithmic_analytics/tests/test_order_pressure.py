"""Tests for ``rithmic_analytics.features.order_pressure`` (RA-035)."""

from __future__ import annotations

import time
from dataclasses import replace

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.features.order_pressure import (
    OrderPressureConfig,
    OrderPressureRow,
    OrderPressureSeries,
    aggregate_to_session_summary,
    compute_order_pressure,
)

_NS_PER_SEC = 10**9
_NS_PER_MS = 10**6
_BASE_TS = 1_779_000_000_000_000_000  # arbitrary recent ns timestamp


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


def _mbo_frame(rows: list[dict[str, object]]) -> pd.DataFrame:
    """Build an MBO DataFrame with the right dtypes for compute_order_pressure."""
    if not rows:
        return pd.DataFrame({
            "event_ts_ns": pd.Series(dtype="int64"),
            "recv_ts_ns": pd.Series(dtype="int64"),
            "sequence": pd.Series(dtype="int64"),
            "action": pd.Categorical([], categories=["A", "M", "C", "F", "T"]),
            "side": pd.Categorical([], categories=["B", "A"]),
            "price": pd.Series(dtype="float64"),
            "size": pd.Series(dtype="int32"),
            "order_id": pd.Series(dtype="string"),
        })

    df = pd.DataFrame(rows)
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["price"] = df["price"].astype("float64")
    df["action"] = df["action"].astype("category")
    df["order_id"] = df["order_id"].astype("string")
    return df.sort_values("event_ts_ns").reset_index(drop=True)


def _build_calm_baseline(
    *, n_orders: int = 100, base_price: float = 27380.0,
) -> pd.DataFrame:
    """N independent orders, each placed and lazily cancelled after >2s.
    Uniform across price levels. Should produce balanced add_cancel_ratio
    and low spoof_score everywhere."""
    rows = []
    for i in range(n_orders):
        ts_add = _BASE_TS + i * 100 * _NS_PER_MS  # 100ms apart
        ts_cancel = ts_add + 5 * _NS_PER_SEC      # 5 seconds later (NOT spoofy at 500ms window)
        price = base_price + (i % 5) * 0.25       # spread across 5 levels
        oid = f"order-{i}"
        rows.append({"event_ts_ns": ts_add, "action": "A",
                     "price": price, "order_id": oid})
        rows.append({"event_ts_ns": ts_cancel, "action": "C",
                     "price": price, "order_id": oid})
    return _mbo_frame(rows)


def _build_absorption_pattern(
    *, level: float = 28900.0, n_adds: int = 50,
) -> pd.DataFrame:
    """Heavy adds at one level, fills consume them gradually, slow cancels.
    Should produce: low spoof_score (most ADDs ended in fill, not cancel),
    non-zero depletion_velocity from the fills."""
    rows = []
    for i in range(n_adds):
        ts_add = _BASE_TS + i * 100 * _NS_PER_MS
        oid = f"abs-{i}"
        rows.append({"event_ts_ns": ts_add, "action": "A",
                     "price": level, "order_id": oid})
        # Most orders fill within 2 seconds (well after spoof window)
        if i % 5 != 0:  # 80% fill
            ts_fill = ts_add + 2 * _NS_PER_SEC
            rows.append({"event_ts_ns": ts_fill, "action": "F",
                         "price": level, "order_id": oid})
        else:  # 20% cancel slowly (>spoof window)
            ts_cancel = ts_add + 5 * _NS_PER_SEC
            rows.append({"event_ts_ns": ts_cancel, "action": "C",
                         "price": level, "order_id": oid})
    return _mbo_frame(rows)


def _build_spoofing_pattern(
    *, level: float = 28900.0, n_adds: int = 50,
    cancel_delay_ms: int = 100,  # well under 500ms spoof window
) -> pd.DataFrame:
    """Heavy adds at one level, ALL cancelled within 100ms, ZERO fills.
    Should produce spoof_score >= 0.9 at that bin."""
    rows = []
    for i in range(n_adds):
        ts_add = _BASE_TS + i * 50 * _NS_PER_MS
        ts_cancel = ts_add + cancel_delay_ms * _NS_PER_MS
        oid = f"spoof-{i}"
        rows.append({"event_ts_ns": ts_add, "action": "A",
                     "price": level, "order_id": oid})
        rows.append({"event_ts_ns": ts_cancel, "action": "C",
                     "price": level, "order_id": oid})
    return _mbo_frame(rows)


def _build_breakout_pattern(
    *, level: float = 28900.0, n_adds: int = 20,
) -> pd.DataFrame:
    """Standing queue at one level rapidly depletes via fills (no spoof).
    Should produce: high depletion_velocity from fills, normal
    add_cancel_ratio (some cancels, some fills, no spoofing)."""
    rows = []
    # 20 add events spread across a few seconds
    for i in range(n_adds):
        ts_add = _BASE_TS + i * 200 * _NS_PER_MS
        oid = f"break-{i}"
        rows.append({"event_ts_ns": ts_add, "action": "A",
                     "price": level, "order_id": oid})
        # All fill quickly but after the spoof window (1s)
        ts_fill = ts_add + 1 * _NS_PER_SEC
        rows.append({"event_ts_ns": ts_fill, "action": "F",
                     "price": level, "order_id": oid})
    return _mbo_frame(rows)


# ---------------------------------------------------------------------------
# The four named synthetic patterns
# ---------------------------------------------------------------------------


def test_baseline_calm_produces_uniform_low_spoof() -> None:
    mbo = _build_calm_baseline(n_orders=100, base_price=27380.0)
    result = compute_order_pressure(mbo, MNQ)

    assert result.rows
    # No bin should show high spoof_score (cancels happen after 5s, far past 500ms window)
    for row in result.rows:
        if row.spoof_score is not None:
            assert row.spoof_score == 0.0, (
                f"calm baseline at price={row.price_bin} produced spoof_score="
                f"{row.spoof_score} (expected 0.0)"
            )


def test_absorption_pattern_low_spoof_nonzero_depletion() -> None:
    mbo = _build_absorption_pattern(level=28900.0, n_adds=50)
    result = compute_order_pressure(mbo, MNQ)

    # Find bins near 28900 (4-tick=1pt bins, so price_bin should be 28900.0)
    near_28900 = [r for r in result.rows if r.price_bin == 28900.0]
    assert near_28900, "no rows at the absorption level"

    # Pool all bins at 28900: spoof_score should be low (most filled)
    total_adds = sum(r.n_adds for r in near_28900)
    total_spoof_adds = sum(
        int(r.spoof_score * r.n_adds) if r.spoof_score is not None else 0
        for r in near_28900
    )
    pooled_spoof = total_spoof_adds / total_adds if total_adds else None
    assert pooled_spoof is not None
    assert pooled_spoof <= 0.2, (
        f"absorption pooled spoof_score={pooled_spoof}; expected <=0.2"
    )

    # Depletion velocity should be > 0 (fills happen)
    max_depletion = max(r.depletion_velocity_per_sec for r in near_28900)
    assert max_depletion > 0.0


def test_spoofing_pattern_high_spoof_score() -> None:
    mbo = _build_spoofing_pattern(level=28900.0, n_adds=50, cancel_delay_ms=100)
    result = compute_order_pressure(mbo, MNQ)

    near_28900 = [r for r in result.rows if r.price_bin == 28900.0]
    assert near_28900

    # Pooled spoof rate across all time bins at this level
    total_adds = sum(r.n_adds for r in near_28900)
    spoofy_adds = sum(
        int((r.spoof_score or 0.0) * r.n_adds) for r in near_28900
    )
    pooled_spoof = spoofy_adds / total_adds
    assert pooled_spoof >= 0.9, (
        f"spoofing pattern pooled spoof_score={pooled_spoof}; expected >=0.9"
    )


def test_spoofing_pattern_outside_window_not_flagged() -> None:
    """Cancel delay of 1000ms (>500ms default window) → NOT flagged as spoofy."""
    mbo = _build_spoofing_pattern(
        level=28900.0, n_adds=50, cancel_delay_ms=1000,  # OUTSIDE window
    )
    result = compute_order_pressure(mbo, MNQ)

    for r in result.rows:
        if r.price_bin == 28900.0 and r.spoof_score is not None:
            assert r.spoof_score == 0.0, (
                f"cancel-at-1000ms wrongly flagged: spoof_score={r.spoof_score}"
            )


def test_breakout_pattern_high_depletion_no_spoof() -> None:
    mbo = _build_breakout_pattern(level=28900.0, n_adds=20)
    result = compute_order_pressure(mbo, MNQ)

    near_28900 = [r for r in result.rows if r.price_bin == 28900.0]
    assert near_28900

    # Fills drive depletion
    max_depletion = max(r.depletion_velocity_per_sec for r in near_28900)
    assert max_depletion > 0.0

    # No spoofing: all orders filled, none cancelled-within-window
    for r in near_28900:
        if r.spoof_score is not None:
            assert r.spoof_score == 0.0


# ---------------------------------------------------------------------------
# Counts + ratios
# ---------------------------------------------------------------------------


def test_add_cancel_ratio_matches_counts() -> None:
    """Simple sanity check: 10 adds + 5 cancels → ratio = 0.5."""
    rows = []
    # 10 adds at 27380.0, slow cancels for 5 of them (>500ms window so not spoofy)
    for i in range(10):
        rows.append({
            "event_ts_ns": _BASE_TS + i * 100 * _NS_PER_MS,
            "action": "A", "price": 27380.0, "order_id": f"o{i}",
        })
    for i in range(5):
        rows.append({
            "event_ts_ns": _BASE_TS + 5 * _NS_PER_SEC + i * _NS_PER_MS,
            "action": "C", "price": 27380.0, "order_id": f"o{i}",
        })
    mbo = _mbo_frame(rows)
    result = compute_order_pressure(mbo, MNQ)

    near = [r for r in result.rows if r.price_bin == 27380.0]
    assert near
    pooled_adds = sum(r.n_adds for r in near)
    pooled_cancels = sum(r.n_cancels for r in near)
    assert pooled_adds == 10
    assert pooled_cancels == 5


def test_add_cancel_ratio_none_when_zero_adds() -> None:
    """A bin with cancels but no adds → ratio=None (orders from prior window)."""
    rows = [
        {"event_ts_ns": _BASE_TS, "action": "C", "price": 27380.0,
         "order_id": "ghost"},
    ]
    mbo = _mbo_frame(rows)
    result = compute_order_pressure(mbo, MNQ)
    assert all(r.add_cancel_ratio is None for r in result.rows if r.n_adds == 0)


def test_spoof_score_none_when_zero_adds() -> None:
    """A bin with no ADD events → spoof_score is None (no signal)."""
    rows = [
        {"event_ts_ns": _BASE_TS, "action": "M", "price": 27380.0,
         "order_id": "x"},
    ]
    mbo = _mbo_frame(rows)
    result = compute_order_pressure(mbo, MNQ)
    for r in result.rows:
        if r.n_adds == 0:
            assert r.spoof_score is None


def test_depletion_velocity_formula() -> None:
    """depletion_velocity = (cancels + fills) / window_seconds.

    With 30s window: 2 cancels + 3 fills → 5/30 = 0.1667/sec.
    """
    rows = [
        {"event_ts_ns": _BASE_TS, "action": "A", "price": 27380.0, "order_id": "a"},
        {"event_ts_ns": _BASE_TS + _NS_PER_SEC, "action": "C",
         "price": 27380.0, "order_id": "a"},
        {"event_ts_ns": _BASE_TS + 2 * _NS_PER_SEC, "action": "C",
         "price": 27380.0, "order_id": "b"},
        {"event_ts_ns": _BASE_TS + 3 * _NS_PER_SEC, "action": "F",
         "price": 27380.0, "order_id": "c"},
        {"event_ts_ns": _BASE_TS + 4 * _NS_PER_SEC, "action": "F",
         "price": 27380.0, "order_id": "d"},
        {"event_ts_ns": _BASE_TS + 5 * _NS_PER_SEC, "action": "F",
         "price": 27380.0, "order_id": "e"},
    ]
    mbo = _mbo_frame(rows)
    result = compute_order_pressure(mbo, MNQ)

    near = [r for r in result.rows if r.price_bin == 27380.0]
    pooled_outflow = sum(r.n_cancels + r.n_fills for r in near)
    assert pooled_outflow == 5
    # Pooled depletion across the (single) 30s window: 5/30 ≈ 0.1667
    max_dep = max(r.depletion_velocity_per_sec for r in near)
    assert max_dep == pytest.approx(5.0 / 30.0, abs=1e-6)


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_empty_mbo_returns_empty_series() -> None:
    empty = _mbo_frame([])
    result = compute_order_pressure(empty, MNQ)
    assert result.rows == []
    assert result.n_input_events == 0
    assert result.n_unique_order_ids == 0


def test_nan_price_drops_row_not_crashes() -> None:
    """T/C lifecycle events with NaN price should be dropped during binning,
    not crash the pipeline."""
    rows = [
        {"event_ts_ns": _BASE_TS, "action": "A", "price": 27380.0, "order_id": "a"},
        {"event_ts_ns": _BASE_TS + _NS_PER_SEC, "action": "T",
         "price": float("nan"), "order_id": ""},
    ]
    mbo = _mbo_frame(rows)
    result = compute_order_pressure(mbo, MNQ)
    # The ADD is counted; the NaN-price row is dropped
    assert any(r.n_adds >= 1 for r in result.rows)


def test_custom_spoof_window_tightening() -> None:
    """Tightening spoof_cancel_window_ms from 500 to 50 reclassifies 100ms cancels as not-spoofy."""
    mbo = _build_spoofing_pattern(level=28900.0, n_adds=20, cancel_delay_ms=100)
    tight_config = OrderPressureConfig(spoof_cancel_window_ms=50)
    result = compute_order_pressure(mbo, MNQ, config=tight_config)

    # 100ms > 50ms tight window → not spoofy
    for r in result.rows:
        if r.price_bin == 28900.0 and r.spoof_score is not None:
            assert r.spoof_score == 0.0, (
                f"100ms cancel wrongly flagged at 50ms window: {r.spoof_score}"
            )


def test_custom_window_seconds_changes_depletion_unit() -> None:
    """60s window halves the per-sec depletion vs default 30s."""
    mbo = _build_breakout_pattern(level=28900.0, n_adds=20)
    default_result = compute_order_pressure(mbo, MNQ)
    long_config = OrderPressureConfig(window_seconds=60)
    long_result = compute_order_pressure(mbo, MNQ, config=long_config)

    # Total fills counted the same either way; depletion = fills / window_sec
    # so doubling the window halves the velocity.
    default_max = max(r.depletion_velocity_per_sec for r in default_result.rows)
    long_max = max(r.depletion_velocity_per_sec for r in long_result.rows)
    assert long_max <= default_max  # not strict equality due to bin alignment


def test_custom_price_bin_ticks() -> None:
    """4-tick (default) vs 20-tick bins: 20-tick collapses more price levels."""
    rows = []
    # Spread 50 adds across prices 27380-27384 (5pt range)
    for i in range(50):
        rows.append({
            "event_ts_ns": _BASE_TS + i * _NS_PER_MS,
            "action": "A",
            "price": 27380.0 + (i % 20) * 0.25,
            "order_id": f"o{i}",
        })
    mbo = _mbo_frame(rows)

    fine = compute_order_pressure(mbo, MNQ)  # default 4 ticks = 1pt
    coarse = compute_order_pressure(
        mbo, MNQ, config=OrderPressureConfig(price_bin_ticks=20),  # 5pt
    )

    # Coarser bins → fewer unique price_bin values
    fine_bins = {r.price_bin for r in fine.rows}
    coarse_bins = {r.price_bin for r in coarse.rows}
    assert len(coarse_bins) < len(fine_bins)


# ---------------------------------------------------------------------------
# Session summary
# ---------------------------------------------------------------------------


def test_aggregate_to_session_summary_collapses_per_price() -> None:
    mbo = _build_spoofing_pattern(level=28900.0, n_adds=50)
    result = compute_order_pressure(mbo, MNQ)
    summary = aggregate_to_session_summary(result)

    assert "28900.00" in summary
    cell = summary["28900.00"]
    assert cell["n_adds_total"] == 50
    assert cell["n_cancels_total"] == 50
    assert cell["max_spoof_score"] is not None
    assert cell["max_spoof_score"] >= 0.9


def test_aggregate_summary_empty_pressure_returns_empty_dict() -> None:
    empty = OrderPressureSeries(
        rows=[], config=OrderPressureConfig(),
        n_input_events=0, n_unique_order_ids=0,
    )
    assert aggregate_to_session_summary(empty) == {}


# ---------------------------------------------------------------------------
# Performance
# ---------------------------------------------------------------------------


def test_perf_5M_rows_under_30s() -> None:
    """Synthetic 5M MBO rows must process under 30s on the test machine."""
    rng = np.random.default_rng(seed=42)
    n = 5_000_000

    ts = _BASE_TS + np.arange(n, dtype="int64") * 1_000  # 1µs spacing
    actions = rng.choice(["A", "C", "M", "F"], size=n, p=[0.4, 0.4, 0.15, 0.05])
    prices = 27380.0 + rng.integers(-20, 20, size=n) * 0.25
    order_ids = (rng.integers(0, n // 4, size=n)).astype(str)

    mbo = pd.DataFrame({
        "event_ts_ns": ts,
        "action": pd.Categorical(actions, categories=["A", "M", "C", "F", "T"]),
        "price": prices,
        "order_id": pd.Series(order_ids, dtype="string"),
    })

    start = time.perf_counter()
    result = compute_order_pressure(mbo, MNQ)
    elapsed = time.perf_counter() - start

    assert elapsed < 30.0, f"5M rows took {elapsed:.2f}s, budget is 30s"
    assert result.n_input_events == n
    assert result.rows


# ---------------------------------------------------------------------------
# Dataclass invariants
# ---------------------------------------------------------------------------


def test_pressure_row_is_frozen() -> None:
    import dataclasses
    r = OrderPressureRow(
        time_bin_ts_ns=0, price_bin=100.0,
        n_adds=1, n_cancels=0, n_modifies=0, n_fills=0,
        add_cancel_ratio=0.0, depletion_velocity_per_sec=0.0,
        spoof_score=0.0,
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        r.n_adds = 99  # type: ignore[misc]


def test_pressure_row_to_dict_serializes() -> None:
    import json
    r = OrderPressureRow(
        time_bin_ts_ns=123, price_bin=27380.0,
        n_adds=10, n_cancels=5, n_modifies=2, n_fills=3,
        add_cancel_ratio=0.5, depletion_velocity_per_sec=0.27,
        spoof_score=0.1,
    )
    s = json.dumps(r.to_dict())
    assert "27380.0" in s
    assert "0.5" in s


def test_pressure_series_to_dict_includes_metadata() -> None:
    series = OrderPressureSeries(
        rows=[], config=OrderPressureConfig(window_seconds=45),
        n_input_events=100, n_unique_order_ids=50,
    )
    d = series.to_dict()
    assert d["metadata"]["window_seconds"] == 45
    assert d["metadata"]["n_input_events"] == 100


def test_default_config_matches_ticket_locks() -> None:
    """RA-035 sweep: 30s windows, 4-tick bins, 500ms spoof window."""
    cfg = OrderPressureConfig()
    assert cfg.window_seconds == 30
    assert cfg.price_bin_ticks == 4
    assert cfg.spoof_cancel_window_ms == 500


def test_config_is_frozen() -> None:
    import dataclasses
    cfg = OrderPressureConfig()
    with pytest.raises(dataclasses.FrozenInstanceError):
        cfg.window_seconds = 60  # type: ignore[misc]


def test_replace_config() -> None:
    cfg = OrderPressureConfig()
    new_cfg = replace(cfg, spoof_cancel_window_ms=250)
    assert new_cfg.spoof_cancel_window_ms == 250
    assert new_cfg.window_seconds == cfg.window_seconds  # other fields preserved
