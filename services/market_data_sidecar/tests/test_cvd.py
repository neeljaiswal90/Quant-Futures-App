"""
DATA-15 — native CVD tests (v3.1 Phase 2 §3.1).

Covers:
  - side-sign convention (buy +, sell -, unknown 0; case- and
    Databento-alias-tolerant)
  - session CVD accumulation
  - rolling windows at 250ms / 1s / 3s / 10s / 30s evaluated relative
    to a supplied now_ns
  - eviction on both apply and snapshot (quiet interval → 0-delta)
  - session reset clears cumulative AND rolling buffer
  - trade_count increments for every trade including unknown-aggressor
    (so downstream telemetry can see the full flow even when CVD can't)
  - malformed size / ts_ns are counted as trades but do not mutate CVD
  - snapshot before any trades is the zero struct
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lob_features.cvd import (  # noqa: E402
    CVD_WINDOWS_NS,
    CvdAccumulator,
    CvdSnapshot,
    _signed_size_from_side,
)


_NS_PER_MS = 1_000_000
_NS_PER_SEC = 1_000_000_000


# ─── Sign convention ────────────────────────────────────────────────────────


class TestSidedSign:
    @pytest.mark.parametrize(
        "side, size, expected",
        [
            ("buy",  5, 5),
            ("Buy",  5, 5),
            ("b",    3, 3),
            ("B",    3, 3),
            ("A",    7, 7),    # Databento MBO aggressor on ask → buy-side
            ("a",    7, 7),
            ("sell", 4, -4),
            ("Sell", 4, -4),
            ("s",    2, -2),
            ("S",    2, -2),
            ("N",    9, 0),    # aggressor not identified
            ("",     1, 0),
            ("???",  1, 0),
            (None,   1, 0),
        ],
    )
    def test_sign_mapping(self, side, size, expected):
        assert _signed_size_from_side(side, size) == expected

    @pytest.mark.parametrize(
        "size",
        [0, -1, None, "5", 1.5],
    )
    def test_rejects_malformed_size(self, size):
        assert _signed_size_from_side("buy", size) == 0


# ─── Session accumulation ───────────────────────────────────────────────────


class TestSessionAccumulation:
    def test_empty_state(self):
        c = CvdAccumulator()
        s = c.snapshot()
        assert s == CvdSnapshot(
            cvd_session=0,
            cvd_delta_250ms=0, cvd_delta_1s=0, cvd_delta_3s=0,
            cvd_delta_10s=0, cvd_delta_30s=0,
            trade_count=0, last_trade_ts_ns=None, session_start_ts_ns=None,
        )

    def test_buy_then_sell_net(self):
        c = CvdAccumulator()
        c.apply(1_000, "buy", 10)
        c.apply(2_000, "sell", 3)
        assert c.session_cvd == 7
        assert c.trade_count == 2

    def test_unknown_side_counted_as_trade_but_not_cvd(self):
        c = CvdAccumulator()
        c.apply(1_000, "N", 5)
        assert c.session_cvd == 0
        assert c.trade_count == 1

    def test_malformed_ts_counted_as_trade_but_not_cvd(self):
        c = CvdAccumulator()
        c.apply(None, "buy", 5)   # bad ts
        c.apply(-1, "buy", 5)     # bad ts
        assert c.session_cvd == 0
        assert c.trade_count == 2

    def test_malformed_size_counted_as_trade_but_not_cvd(self):
        c = CvdAccumulator()
        c.apply(1_000, "buy", 0)
        c.apply(1_000, "buy", -1)
        assert c.session_cvd == 0
        assert c.trade_count == 2


# ─── Rolling windows ────────────────────────────────────────────────────────


class TestRollingWindows:
    def test_single_trade_in_all_windows_at_t0(self):
        c = CvdAccumulator()
        c.apply(1_000_000_000, "buy", 5)
        s = c.snapshot(now_ns=1_000_000_000)
        assert s.cvd_delta_250ms == 5
        assert s.cvd_delta_1s == 5
        assert s.cvd_delta_3s == 5
        assert s.cvd_delta_10s == 5
        assert s.cvd_delta_30s == 5

    def test_windows_age_out_correctly(self):
        c = CvdAccumulator()
        # Trade at t0
        c.apply(10_000_000_000, "buy", 5)
        # 500ms later — outside 250ms, inside 1s/3s/10s/30s
        s = c.snapshot(now_ns=10_500_000_000)
        assert s.cvd_delta_250ms == 0
        assert s.cvd_delta_1s == 5
        assert s.cvd_delta_3s == 5
        assert s.cvd_delta_10s == 5
        assert s.cvd_delta_30s == 5
        # 2s later — outside 1s, inside 3s
        s2 = c.snapshot(now_ns=10_000_000_000 + 2 * _NS_PER_SEC)
        assert s2.cvd_delta_1s == 0
        assert s2.cvd_delta_3s == 5
        # 5s later — outside 3s, inside 10s
        s3 = c.snapshot(now_ns=10_000_000_000 + 5 * _NS_PER_SEC)
        assert s3.cvd_delta_3s == 0
        assert s3.cvd_delta_10s == 5
        # 15s later — outside 10s, inside 30s
        s4 = c.snapshot(now_ns=10_000_000_000 + 15 * _NS_PER_SEC)
        assert s4.cvd_delta_10s == 0
        assert s4.cvd_delta_30s == 5
        # 40s later — outside every window
        s5 = c.snapshot(now_ns=10_000_000_000 + 40 * _NS_PER_SEC)
        assert s5.cvd_delta_30s == 0
        # Session cumulative is unaffected by windowing
        assert s5.cvd_session == 5

    def test_mixed_signs_sum_correctly_per_window(self):
        c = CvdAccumulator()
        t0 = 100_000_000_000
        c.apply(t0 + 0, "buy", 10)                # +10 in all
        c.apply(t0 + 500 * _NS_PER_MS, "sell", 4) # outside 250ms; inside 1s+
        c.apply(t0 + 2 * _NS_PER_SEC, "buy", 3)   # outside 1s; inside 3s+
        c.apply(t0 + 8 * _NS_PER_SEC, "sell", 7)  # outside 3s; inside 10s+
        c.apply(t0 + 20 * _NS_PER_SEC, "buy", 2)  # outside 10s; inside 30s
        now = t0 + 25 * _NS_PER_SEC
        s = c.snapshot(now_ns=now)
        # At now (+25s): only the 20s trade is inside 10s? No, 5s ago.
        # Let me re-check: now - 20s = 5s ago → inside 10s and 30s.
        # The +8s trade is 17s ago → outside 10s, inside 30s.
        # The +2s trade is 23s ago → outside 10s, inside 30s.
        # The +0.5s trade is 24.5s ago → outside 10s, inside 30s.
        # The +0 trade is 25s ago → outside 10s, inside 30s.
        assert s.cvd_delta_250ms == 0
        assert s.cvd_delta_1s == 0
        assert s.cvd_delta_3s == 0
        # 10s window: only the most recent buy (+2)
        assert s.cvd_delta_10s == 2
        # 30s window: all trades: +10 -4 +3 -7 +2 = +4
        assert s.cvd_delta_30s == 4
        # Session CVD same sum
        assert s.cvd_session == 4

    def test_snapshot_without_now_uses_last_trade_ts(self):
        c = CvdAccumulator()
        c.apply(1_000_000_000, "buy", 5)
        s = c.snapshot()
        # Evaluated at the trade's own ts — all windows contain it.
        assert s.cvd_delta_250ms == 5
        assert s.cvd_delta_30s == 5

    def test_quiet_interval_snapshot_evicts_stale(self):
        """30s after the last trade, snapshot() should report 0 in every window
        even though apply() was never called to trigger eviction."""
        c = CvdAccumulator()
        c.apply(10_000_000_000, "buy", 5)
        now = 10_000_000_000 + 60 * _NS_PER_SEC
        s = c.snapshot(now_ns=now)
        assert s.cvd_delta_250ms == 0
        assert s.cvd_delta_30s == 0
        # session cumulative persists
        assert s.cvd_session == 5


# ─── Session reset ──────────────────────────────────────────────────────────


class TestSessionReset:
    def test_reset_clears_cumulative_and_windows(self):
        c = CvdAccumulator()
        c.apply(1_000_000_000, "buy", 10)
        c.apply(2_000_000_000, "sell", 3)
        assert c.session_cvd == 7
        assert c.trade_count == 2

        c.reset_session(now_ns=5_000_000_000)

        s = c.snapshot(now_ns=5_000_000_000)
        assert s.cvd_session == 0
        assert s.cvd_delta_30s == 0
        assert s.trade_count == 0
        assert s.last_trade_ts_ns is None
        assert s.session_start_ts_ns == 5_000_000_000

    def test_post_reset_trades_do_not_include_pre_reset_volume(self):
        c = CvdAccumulator()
        # Pre-reset: +100 buy
        c.apply(1_000_000_000, "buy", 100)
        c.reset_session(now_ns=1_500_000_000)
        # Post-reset: -20 sell 500ms later
        c.apply(2_000_000_000, "sell", 20)
        s = c.snapshot(now_ns=2_000_000_000)
        # Windows contain only the -20 sell.
        assert s.cvd_session == -20
        assert s.cvd_delta_1s == -20
        # The buy trade must NOT be in the 30s window even though it is
        # only 1s before the sell.
        assert s.cvd_delta_30s == -20

    def test_session_start_ts_set_on_reset(self):
        c = CvdAccumulator()
        c.reset_session(now_ns=7_777_777_777)
        s = c.snapshot()
        assert s.session_start_ts_ns == 7_777_777_777

    def test_reset_with_invalid_ts_clears_to_none(self):
        c = CvdAccumulator(session_start_ts_ns=1_000)
        c.reset_session(now_ns=None)
        s = c.snapshot()
        assert s.session_start_ts_ns is None


# ─── Buffer hygiene ─────────────────────────────────────────────────────────


class TestBufferHygiene:
    def test_apply_evicts_entries_older_than_max_window(self):
        c = CvdAccumulator()
        # Seed 100 trades inside a 1-minute span
        t0 = 1_000_000_000
        for i in range(100):
            c.apply(t0 + i * 100 * _NS_PER_MS, "buy", 1)  # 100ms apart
        # A new trade 60s later should evict everything outside the 30s window.
        c.apply(t0 + 70 * _NS_PER_SEC, "sell", 1)
        # Buffer should now hold only the latest trade.
        assert c.buffer_size == 1
        # Session cumulative unchanged by eviction.
        assert c.session_cvd == 99  # 100 buys - 1 sell

    def test_longest_window_matches_constant(self):
        assert max(CVD_WINDOWS_NS.values()) == 30 * _NS_PER_SEC
        assert set(CVD_WINDOWS_NS.keys()) == {"250ms", "1s", "3s", "10s", "30s"}
