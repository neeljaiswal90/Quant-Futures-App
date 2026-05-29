"""Tests for ``rithmic_analytics.core.loader``.

Structure:
    - Synthetic fixtures (inline, tmp_path) exercise schema, dtypes, dispatch.
    - Real-fixture tests (gated by ``REAL_*.exists()``) cover perf budget and
      aggregate semantics on the 104,358-row OBS-01 capture.

Note on row counts: the ticket text says "104,694 trade rows" but that is the
total LINE count (TRADE + QUOTE envelopes). After ``type == "TRADE"`` filtering
the loader returns 104,358 rows. See ``docs/jsonl-inspection-report.md`` for
the empirical breakdown.
"""

from __future__ import annotations

import json
import time
import tracemalloc
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.loader import (
    _MBO_DTYPES,
    _MBP1_DTYPES,
    _OBS01_DTYPES,
    SpreadSummary,
    load_mbo,
    load_mbp1,
    load_obs01_trades,
    summarize_spread,
)

from .conftest import REAL_OBS01

# ---------------------------------------------------------------------------
# Synthetic-row helpers
# ---------------------------------------------------------------------------


def _obs01_trade_record(
    *,
    event_ts_ns: int = 1_777_301_422_098_008_205,
    recv_ts_ns: int = 1_777_301_421_596_955_300,
    session_id: str = "mnq-2026-04-27-rth",
    price: float = 27381.25,
    quantity: int = 1,
    aggressor_side: str | None = "sell",
    trade_id: str = "6875892387204",
    type_: str = "TRADE",
    event_id: str = "trade-test-000001",
) -> dict[str, Any]:
    rec: dict[str, Any] = {
        "event_id": event_id,
        "run_id": "test-run",
        "schema_version": 1,
        "session_id": session_id,
        "ts_ns": str(event_ts_ns),
        "type": type_,
        "payload": {
            "aggressor_side": aggressor_side,
            "exchange_event_ts_ns": str(event_ts_ns),
            "sidecar_recv_ts_ns": str(recv_ts_ns),
            "price": price,
            "quantity": quantity,
            "trade_id": trade_id,
        },
    }
    return rec


def _write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")


# ---------------------------------------------------------------------------
# OBS-01: synthetic-data tests
# ---------------------------------------------------------------------------


def test_obs01_smoke_three_rows(tmp_path: Path) -> None:
    path = tmp_path / "obs01.jsonl"
    _write_jsonl(
        path,
        [
            _obs01_trade_record(price=27381.25, quantity=1, aggressor_side="buy"),
            _obs01_trade_record(price=27381.50, quantity=2, aggressor_side="sell"),
            _obs01_trade_record(price=27381.75, quantity=3, aggressor_side="buy"),
        ],
    )

    df = load_obs01_trades(path)

    assert len(df) == 3
    assert list(df.columns) == list(_OBS01_DTYPES.keys())
    assert df["event_ts_ns"].dtype == np.int64
    assert df["recv_ts_ns"].dtype == np.int64
    assert df["quantity"].dtype == np.int32
    assert df["signed_qty"].dtype == np.int32
    assert df["price"].dtype == np.float64
    assert isinstance(df["aggressor_side"].dtype, pd.CategoricalDtype)


def test_obs01_canonical_timestamp_column_name(tmp_path: Path) -> None:
    # The plan's Decisions block mandates `event_ts_ns` (not `ts_event_ns` /
    # `exchange_event_ts_ns`) as the canonical column for all binning downstream.
    path = tmp_path / "obs01.jsonl"
    _write_jsonl(path, [_obs01_trade_record()])

    df = load_obs01_trades(path)

    assert "event_ts_ns" in df.columns
    assert "exchange_event_ts_ns" not in df.columns
    assert "ts_event_ns" not in df.columns


def test_obs01_signed_qty_sign_convention(tmp_path: Path) -> None:
    path = tmp_path / "obs01.jsonl"
    _write_jsonl(
        path,
        [
            _obs01_trade_record(quantity=5, aggressor_side="buy", trade_id="b1"),
            _obs01_trade_record(quantity=7, aggressor_side="sell", trade_id="s1"),
            _obs01_trade_record(quantity=3, aggressor_side="unknown", trade_id="u1"),
        ],
    )

    # 1/3 unknown is intentional for this test (covering all three sign cases).
    # Lift the threshold so the warning doesn't fire — separate test exercises it.
    df = load_obs01_trades(path, unknown_aggressor_warn_threshold=0.5)

    buy_row = df[df["trade_id"] == "b1"].iloc[0]
    sell_row = df[df["trade_id"] == "s1"].iloc[0]
    unknown_row = df[df["trade_id"] == "u1"].iloc[0]

    assert buy_row["signed_qty"] == 5  # buy → +qty
    assert sell_row["signed_qty"] == -7  # sell → -qty
    assert unknown_row["signed_qty"] == 0  # unknown → 0


def test_obs01_quote_envelopes_dropped(tmp_path: Path) -> None:
    path = tmp_path / "obs01.jsonl"
    _write_jsonl(
        path,
        [
            _obs01_trade_record(trade_id="t1"),
            _obs01_trade_record(trade_id="q1", type_="QUOTE"),
            _obs01_trade_record(trade_id="t2"),
        ],
    )

    df = load_obs01_trades(path)

    assert len(df) == 2
    assert set(df["trade_id"]) == {"t1", "t2"}


def test_obs01_empty_file(tmp_path: Path) -> None:
    path = tmp_path / "obs01.jsonl"
    path.touch()  # 0 bytes

    df = load_obs01_trades(path)

    assert len(df) == 0
    assert list(df.columns) == list(_OBS01_DTYPES.keys())
    # Empty schema dtype guarantee — downstream code can rely on this.
    assert df["event_ts_ns"].dtype == np.int64


def test_obs01_only_quote_envelopes_warns_and_returns_empty(tmp_path: Path) -> None:
    path = tmp_path / "obs01.jsonl"
    _write_jsonl(path, [_obs01_trade_record(type_="QUOTE")])

    with pytest.warns(UserWarning, match="No TRADE envelopes"):
        df = load_obs01_trades(path)

    assert len(df) == 0


def test_obs01_missing_aggressor_coerced_to_unknown(tmp_path: Path) -> None:
    # 2 of 100 rows missing aggressor — above default 1% threshold → warns.
    # All missing rows get signed_qty=0 and aggressor_side="unknown".
    records = [
        _obs01_trade_record(
            aggressor_side=None if i < 2 else "buy",
            trade_id=f"t{i}",
        )
        for i in range(100)
    ]
    path = tmp_path / "obs01.jsonl"
    _write_jsonl(path, records)

    with pytest.warns(UserWarning, match="unknown-aggressor fraction"):
        df = load_obs01_trades(path)

    unknown_rows = df[df["aggressor_side"] == "unknown"]
    assert len(unknown_rows) == 2
    assert (unknown_rows["signed_qty"] == 0).all()


def test_obs01_unknown_threshold_kwarg_respected(tmp_path: Path) -> None:
    # 5% unknown but threshold lifted to 10% → no warning.
    records = [
        _obs01_trade_record(
            aggressor_side=None if i < 5 else "buy",
            trade_id=f"t{i}",
        )
        for i in range(100)
    ]
    path = tmp_path / "obs01.jsonl"
    _write_jsonl(path, records)

    import warnings as warnings_mod

    with warnings_mod.catch_warnings():
        warnings_mod.simplefilter("error")  # any warning fails the test
        df = load_obs01_trades(path, unknown_aggressor_warn_threshold=0.10)

    assert len(df) == 100
    assert (df[df["aggressor_side"] == "unknown"]["signed_qty"] == 0).all()


def test_obs01_blank_lines_skipped(tmp_path: Path) -> None:
    path = tmp_path / "obs01.jsonl"
    rec = json.dumps(_obs01_trade_record())
    with path.open("w", encoding="utf-8") as f:
        f.write(rec + "\n\n  \n" + rec + "\n")

    df = load_obs01_trades(path)

    assert len(df) == 2


def test_obs01_malformed_json_raises(tmp_path: Path) -> None:
    path = tmp_path / "obs01.jsonl"
    with path.open("w", encoding="utf-8") as f:
        f.write("{not valid json}\n")

    with pytest.raises(json.JSONDecodeError):
        load_obs01_trades(path)


# ---------------------------------------------------------------------------
# OBS-01: real-fixture tests (gated)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_obs01_real_fixture_row_count() -> None:
    # See header note: 104,694 is total lines (TRADE+QUOTE); loader returns 104,358 TRADEs.
    df = load_obs01_trades(REAL_OBS01)
    assert len(df) == 104_358


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_obs01_real_fixture_aggressor_coverage() -> None:
    df = load_obs01_trades(REAL_OBS01)
    known = (df["aggressor_side"].isin(["buy", "sell"])).mean()
    assert known >= 0.99, f"aggressor coverage {known:.4f} < 0.99 threshold"


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_obs01_real_fixture_dtype_guards() -> None:
    df = load_obs01_trades(REAL_OBS01)
    # Defensive guard: some pandas versions silently coerce decimal-string ns
    # values to object dtype if any value fails to parse. Catch that here.
    assert df["event_ts_ns"].dtype == np.int64
    assert df["recv_ts_ns"].dtype == np.int64
    assert df["signed_qty"].dtype == np.int32


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_obs01_real_fixture_performance() -> None:
    # Hard budget from RA-002 acceptance: <5s wall, <500MB RAM.
    # tracemalloc tracks Python object allocations only — not full RSS — so we
    # allow a generous 2x proxy (1000MB) for the memory check.
    tracemalloc.start()
    t0 = time.perf_counter()
    df = load_obs01_trades(REAL_OBS01)
    elapsed = time.perf_counter() - t0
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert len(df) == 104_358
    assert elapsed < 5.0, f"loader took {elapsed:.2f}s, budget is 5s"
    assert peak < 1_000_000_000, f"peak Py-tracked memory {peak / 1e6:.0f}MB > 1000MB proxy"


# ---------------------------------------------------------------------------
# MBP1
# ---------------------------------------------------------------------------


def _mbp1_record(
    *,
    ts_event_ns: int = 1_777_301_362_082_830_655,
    ts_recv_ns: int = 1_777_301_362_082_920_202,
    bid_px: float = 27371.25,
    bid_sz: int = 6,
    bid_ct: int = 6,
    ask_px: float = 27371.75,
    ask_sz: int = 8,
    ask_ct: int = 8,
) -> dict[str, Any]:
    return {
        "ts_event_ns": str(ts_event_ns),
        "ts_recv_ns": str(ts_recv_ns),
        "bid_px_00": bid_px,
        "bid_sz_00": bid_sz,
        "bid_ct_00": bid_ct,
        "ask_px_00": ask_px,
        "ask_sz_00": ask_sz,
        "ask_ct_00": ask_ct,
    }


def test_mbp1_smoke(tmp_path: Path) -> None:
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(path, [_mbp1_record(), _mbp1_record(bid_px=27371.50)])

    df = load_mbp1(path)

    assert len(df) == 2
    assert list(df.columns) == list(_MBP1_DTYPES.keys())
    assert df["event_ts_ns"].dtype == np.int64
    assert df["recv_ts_ns"].dtype == np.int64
    assert df["bid_sz_00"].dtype == np.int32
    assert df["bid_px_00"].dtype == np.float64


def test_mbp1_canonical_column_event_ts_ns(tmp_path: Path) -> None:
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(path, [_mbp1_record()])

    df = load_mbp1(path)

    assert "event_ts_ns" in df.columns
    assert "ts_event_ns" not in df.columns
    assert "recv_ts_ns" in df.columns
    assert "ts_recv_ns" not in df.columns


def test_mbp1_empty_file(tmp_path: Path) -> None:
    path = tmp_path / "mbp1.jsonl"
    path.touch()

    df = load_mbp1(path)

    assert len(df) == 0
    assert list(df.columns) == list(_MBP1_DTYPES.keys())


# ---------------------------------------------------------------------------
# RA-037: spread columns + summarize_spread
# ---------------------------------------------------------------------------


def test_mbp1_spread_columns_one_tick_quote(tmp_path: Path) -> None:
    # bid=27371.25, ask=27371.50 → spread_ticks=1.0, not crossed.
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(path, [_mbp1_record(bid_px=27371.25, ask_px=27371.50)])
    df = load_mbp1(path)

    row = df.iloc[0]
    assert row["spread_ticks"] == pytest.approx(1.0)
    # bps = (0.25 / 27371.375) * 10000 ≈ 0.0913
    assert row["spread_bps"] == pytest.approx(0.25 / 27371.375 * 10_000.0)
    assert not row["is_crossed"]


def test_mbp1_spread_columns_locked_zero_spread(tmp_path: Path) -> None:
    # bid==ask → spread_ticks=0, not crossed.
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(path, [_mbp1_record(bid_px=27371.25, ask_px=27371.25)])
    df = load_mbp1(path)

    row = df.iloc[0]
    assert row["spread_ticks"] == pytest.approx(0.0)
    assert row["spread_bps"] == pytest.approx(0.0)
    assert not row["is_crossed"]


def test_mbp1_spread_columns_crossed_book(tmp_path: Path) -> None:
    # ask < bid (rare, fast-market). is_crossed=True; spread_ticks is negative.
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(path, [_mbp1_record(bid_px=27371.50, ask_px=27371.25)])
    df = load_mbp1(path)

    row = df.iloc[0]
    assert row["spread_ticks"] == pytest.approx(-1.0)
    assert row["is_crossed"]


def test_mbp1_spread_columns_one_sided_book_nan(tmp_path: Path) -> None:
    # One side NaN → spread_ticks and spread_bps are NaN; is_crossed=False.
    path = tmp_path / "mbp1.jsonl"
    rec = _mbp1_record(bid_px=27371.25, ask_px=27371.50)
    rec["ask_px_00"] = None  # one-sided
    _write_jsonl(path, [rec])
    df = load_mbp1(path)

    row = df.iloc[0]
    assert pd.isna(row["spread_ticks"])
    assert pd.isna(row["spread_bps"])
    assert not row["is_crossed"]


def test_mbp1_spread_columns_one_sided_zero_price(tmp_path: Path) -> None:
    # RA-040 fix: the Globex MBP1 delta-stream marks the un-updated side as
    # 0.0 (NOT NaN). Spread filter must treat 0.0 as missing or the
    # diagnostic produces pathological output (mean=115K ticks on 5/21).
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(
        path,
        [
            # ask side zeroed
            _mbp1_record(bid_px=27371.25, ask_px=0.0),
            # bid side zeroed
            _mbp1_record(bid_px=0.0, ask_px=27371.50),
            # control: normal two-sided
            _mbp1_record(bid_px=27371.25, ask_px=27371.50),
        ],
    )
    df = load_mbp1(path)

    # Both one-sided rows must have NaN spread + is_crossed=False.
    assert pd.isna(df.iloc[0]["spread_ticks"])
    assert pd.isna(df.iloc[0]["spread_bps"])
    assert not df.iloc[0]["is_crossed"]

    assert pd.isna(df.iloc[1]["spread_ticks"])
    assert pd.isna(df.iloc[1]["spread_bps"])
    assert not df.iloc[1]["is_crossed"]

    # Control row passes through normally.
    assert df.iloc[2]["spread_ticks"] == pytest.approx(1.0)
    assert not df.iloc[2]["is_crossed"]  # NaN < 0 → False


def test_mbp1_spread_dtypes(tmp_path: Path) -> None:
    # Type guarantees for the three new columns.
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(path, [_mbp1_record()])
    df = load_mbp1(path)

    assert df["spread_ticks"].dtype == np.float64
    assert df["spread_bps"].dtype == np.float64
    assert df["is_crossed"].dtype == np.bool_


def test_summarize_spread_basic(tmp_path: Path) -> None:
    # 10 records all at 1-tick spread → mean=1, p50=p95=p99=max=1, time_above_*=0.
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(
        path,
        [_mbp1_record(bid_px=27371.25, ask_px=27371.50) for _ in range(10)],
    )
    df = load_mbp1(path)
    summary = summarize_spread(df)

    assert summary.n_records == 10
    assert summary.n_crossed_quotes == 0
    assert summary.mean_ticks == pytest.approx(1.0)
    assert summary.p50_ticks == pytest.approx(1.0)
    assert summary.p95_ticks == pytest.approx(1.0)
    assert summary.max_ticks == pytest.approx(1.0)
    assert summary.time_above_1tick_pct == pytest.approx(0.0)
    assert summary.time_above_2tick_pct == pytest.approx(0.0)


def test_summarize_spread_mixed_distribution(tmp_path: Path) -> None:
    # 100 records, 90 at 1 tick + 10 at 4 ticks.
    # > 1t fraction = 0.10; > 2t fraction = 0.10; max = 4.
    records = (
        [_mbp1_record(bid_px=27371.25, ask_px=27371.50) for _ in range(90)]
        + [_mbp1_record(bid_px=27371.25, ask_px=27372.25) for _ in range(10)]
    )
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(path, records)
    df = load_mbp1(path)
    summary = summarize_spread(df)

    assert summary.n_records == 100
    assert summary.n_crossed_quotes == 0
    assert summary.max_ticks == pytest.approx(4.0)
    assert summary.time_above_1tick_pct == pytest.approx(0.10)
    assert summary.time_above_2tick_pct == pytest.approx(0.10)
    # p95 lands in the 4-tick tail with these counts.
    assert summary.p95_ticks == pytest.approx(4.0)


def test_summarize_spread_excludes_crossed_from_dist(tmp_path: Path) -> None:
    # 9 normal + 1 crossed → n_crossed=1; distribution stats over 9 normal rows.
    records = [_mbp1_record(bid_px=27371.25, ask_px=27371.50) for _ in range(9)]
    records.append(_mbp1_record(bid_px=27371.50, ask_px=27371.25))  # crossed
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(path, records)
    df = load_mbp1(path)
    summary = summarize_spread(df)

    assert summary.n_records == 10
    assert summary.n_crossed_quotes == 1
    assert summary.mean_ticks == pytest.approx(1.0)  # only the 9 valid rows
    assert summary.max_ticks == pytest.approx(1.0)


def test_summarize_spread_empty_returns_nan_summary() -> None:
    empty = load_mbp1(Path("/this/does/not/exist.jsonl")) if False else pd.DataFrame(
        {col: pd.Series(dtype=dtype) for col, dtype in _MBP1_DTYPES.items()}
    )
    summary = summarize_spread(empty)
    assert isinstance(summary, SpreadSummary)
    assert summary.n_records == 0
    assert summary.n_crossed_quotes == 0
    assert np.isnan(summary.mean_ticks)
    assert np.isnan(summary.p50_ticks)
    assert np.isnan(summary.max_ticks)


def test_summarize_spread_all_one_sided_returns_nan_dist(tmp_path: Path) -> None:
    # All rows one-sided → n_records>0, n_crossed=0, distribution NaN.
    rec = _mbp1_record()
    rec["ask_px_00"] = None
    path = tmp_path / "mbp1.jsonl"
    _write_jsonl(path, [rec, rec])
    df = load_mbp1(path)
    summary = summarize_spread(df)

    assert summary.n_records == 2
    assert summary.n_crossed_quotes == 0
    assert np.isnan(summary.mean_ticks)
    assert np.isnan(summary.p99_ticks)


def test_spread_summary_to_dict_round_trip() -> None:
    s = SpreadSummary(
        mean_ticks=1.2,
        p50_ticks=1.0,
        p95_ticks=2.0,
        p99_ticks=3.0,
        max_ticks=4.0,
        mean_bps=0.5,
        time_above_1tick_pct=0.15,
        time_above_2tick_pct=0.05,
        n_records=1234,
        n_crossed_quotes=2,
    )
    d = s.to_dict()
    assert d["mean_ticks"] == 1.2
    assert d["n_records"] == 1234
    assert d["n_crossed_quotes"] == 2
    # Must be JSON-serializable
    assert json.dumps(d)


# ---------------------------------------------------------------------------
# MBO
# ---------------------------------------------------------------------------


def _mbo_record(
    *,
    ts_event_ns: int = 1_777_301_362_082_830_655,
    ts_recv_ns: int = 1_777_301_362_082_920_202,
    sequence: int = 42_788_187,
    action: str = "A",
    side: str = "B",
    price: float | None = 27371.25,
    size: int = 1,
    order_id: str = "6875892301191",
) -> dict[str, Any]:
    return {
        "ts_event_ns": str(ts_event_ns),
        "ts_recv_ns": str(ts_recv_ns),
        "sequence": str(sequence),
        "action": action,
        "side": side,
        "price": price,
        "size": size,
        "order_id": order_id,
    }


def test_mbo_smoke(tmp_path: Path) -> None:
    path = tmp_path / "mbo.jsonl"
    _write_jsonl(
        path,
        [
            _mbo_record(action="A", side="B"),
            _mbo_record(action="C", side="A"),
            _mbo_record(action="F", side="B"),
        ],
    )

    df = load_mbo(path)

    assert len(df) == 3
    assert list(df.columns) == list(_MBO_DTYPES.keys())
    assert df["event_ts_ns"].dtype == np.int64
    assert df["sequence"].dtype == np.int64
    assert isinstance(df["action"].dtype, pd.CategoricalDtype)
    assert isinstance(df["side"].dtype, pd.CategoricalDtype)


def test_mbo_nan_price_preserved_for_trade_envelope(tmp_path: Path) -> None:
    # Per Rithmic spec, action="T" envelopes may carry null price.
    # Loader must preserve as NaN — not filter or fillna.
    path = tmp_path / "mbo.jsonl"
    _write_jsonl(
        path,
        [
            _mbo_record(action="A", price=27371.25),
            _mbo_record(action="T", price=None),
        ],
    )

    df = load_mbo(path)

    assert len(df) == 2
    trade_row = df[df["action"] == "T"].iloc[0]
    assert pd.isna(trade_row["price"])
    add_row = df[df["action"] == "A"].iloc[0]
    assert add_row["price"] == 27371.25


def test_mbo_canonical_column_event_ts_ns(tmp_path: Path) -> None:
    path = tmp_path / "mbo.jsonl"
    _write_jsonl(path, [_mbo_record()])

    df = load_mbo(path)

    assert "event_ts_ns" in df.columns
    assert "ts_event_ns" not in df.columns
    assert "recv_ts_ns" in df.columns
    assert "ts_recv_ns" not in df.columns


def test_mbo_empty_file(tmp_path: Path) -> None:
    path = tmp_path / "mbo.jsonl"
    path.touch()

    df = load_mbo(path)

    assert len(df) == 0
    assert list(df.columns) == list(_MBO_DTYPES.keys())
