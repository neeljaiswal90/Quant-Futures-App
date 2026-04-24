"""
DATA-11 retrofit (v3.2.1 §2.1) — Mbp10BookState unit tests.

Covers the new L2-canonical book state:
  - empty book + None-safe
  - A/M/C/T actions snapshot levels
  - R clears + records last_clear_ts_ns
  - snapshot(depth) respects depth bound and ordering contract
  - top-of-book accessors
  - Mbp10BookRegistry per-instrument isolation
  - ApplyResult contract (FSM inputs for DATA-12)
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lob_features.mbp10_book_state import (  # noqa: E402
    ApplyResult,
    Mbp10BookRegistry,
    Mbp10BookState,
)


def _lvl(bid_px=None, bid_sz=None, ask_px=None, ask_sz=None):
    return SimpleNamespace(bid_px=bid_px, bid_sz=bid_sz,
                           ask_px=ask_px, ask_sz=ask_sz)


def _mbp10_payload(*, action="A", levels=None):
    return SimpleNamespace(action=action, levels=levels or [])


class TestEmptyBook:
    def test_snapshot_on_fresh_state_is_empty(self):
        st = Mbp10BookState(instrument_id=42)
        snap = st.snapshot()
        assert snap.bids == []
        assert snap.asks == []
        assert snap.best_bid() is None
        assert snap.best_ask() is None
        assert snap.best_bid_qty() is None
        assert snap.best_ask_qty() is None
        assert snap.mid() is None
        assert snap.spread() is None
        assert snap.instrument_id == 42

    def test_apply_without_payload_is_noop(self):
        st = Mbp10BookState()
        rec = SimpleNamespace(payload=None, ts_recv_ns=1)
        r = st.apply_provider_record(rec)
        assert r.applied is False
        assert r.levels_present is False


class TestApplyActions:
    def test_add_action_snapshots_levels(self):
        st = Mbp10BookState(instrument_id=1)
        payload = _mbp10_payload(action="A", levels=[
            _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
            _lvl(bid_px=99, bid_sz=10, ask_px=102, ask_sz=7),
        ])
        r = st.apply(payload, ts_recv_ns=1_000)
        assert r.applied is True
        assert r.action == "A"
        assert r.cleared is False
        assert r.top_of_book_populated is True
        snap = st.snapshot()
        assert snap.bids == [(100, 5), (99, 10)]
        assert snap.asks == [(101, 3), (102, 7)]
        assert snap.best_bid() == 100 and snap.best_ask() == 101
        assert snap.best_bid_qty() == 5 and snap.best_ask_qty() == 3

    def test_modify_action_updates_levels_to_carried_snapshot(self):
        """MBP-10 re-emits the full top-10 on every event — a modify
        is just a new snapshot. The book state must replace, not merge."""
        st = Mbp10BookState()
        st.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
        ]))
        st.apply(_mbp10_payload(action="M", levels=[
            _lvl(bid_px=100, bid_sz=99, ask_px=101, ask_sz=99),
        ]))
        snap = st.snapshot()
        assert snap.bids == [(100, 99)]
        assert snap.asks == [(101, 99)]

    def test_trade_action_is_treated_as_level_update(self):
        st = Mbp10BookState()
        r = st.apply(_mbp10_payload(action="T", levels=[
            _lvl(bid_px=100, bid_sz=4, ask_px=101, ask_sz=3),
        ]))
        assert r.applied is True and r.action == "T"
        assert st.snapshot().best_bid() == 100

    def test_unknown_action_leaves_state_unchanged(self):
        st = Mbp10BookState()
        st.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
        ]))
        before = st.snapshot()
        r = st.apply(_mbp10_payload(action="Z", levels=[
            _lvl(bid_px=999, bid_sz=999, ask_px=1000, ask_sz=1000),
        ]))
        assert r.applied is False
        after = st.snapshot()
        assert after.bids == before.bids
        assert after.asks == before.asks

    def test_zero_sized_levels_are_dropped(self):
        """MBP-10 shows empty slots as size=0 when the book has fewer
        than 10 levels. Those must be dropped, not kept as zero-qty
        rows — otherwise best_bid_qty() would falsely read 0."""
        st = Mbp10BookState()
        st.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
            _lvl(bid_px=0, bid_sz=0, ask_px=0, ask_sz=0),
        ]))
        snap = st.snapshot()
        assert snap.bids == [(100, 5)]
        assert snap.asks == [(101, 3)]


class TestClearAction:
    def test_r_action_clears_book_and_records_boundary(self):
        st = Mbp10BookState()
        st.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
        ]), ts_recv_ns=500)
        assert st.snapshot().best_bid() == 100
        r = st.apply(_mbp10_payload(action="R", levels=[]), ts_recv_ns=1_000)
        assert r.cleared is True
        assert r.levels_present is False
        assert st.snapshot().best_bid() is None
        assert st.last_clear_ts_ns == 1_000
        # FSM input: apply_count_since_clear resets on R.
        assert st.apply_count_since_clear == 0

    def test_post_reset_counter_advances_only_on_applied_updates(self):
        """DATA-12 reconvergence FSM (next slice) counts consecutive
        post-reset updates. Only A/M/C/T should advance that counter;
        unknown-action records must not."""
        st = Mbp10BookState()
        st.apply(_mbp10_payload(action="R"), ts_recv_ns=1_000)
        assert st.apply_count_since_clear == 0
        st.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
        ]))
        st.apply(_mbp10_payload(action="Z", levels=[]))  # unknown
        st.apply(_mbp10_payload(action="M", levels=[
            _lvl(bid_px=100, bid_sz=7, ask_px=101, ask_sz=3),
        ]))
        assert st.apply_count_since_clear == 2


class TestSnapshotDepth:
    def test_depth_bound_respected(self):
        st = Mbp10BookState()
        st.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=100 - i, bid_sz=i + 1, ask_px=101 + i, ask_sz=i + 1)
            for i in range(10)
        ]))
        snap5 = st.snapshot(depth=5)
        assert len(snap5.bids) == 5 and len(snap5.asks) == 5
        # bids descending, asks ascending.
        assert snap5.bids == sorted(snap5.bids, key=lambda t: t[0], reverse=True)
        assert snap5.asks == sorted(snap5.asks, key=lambda t: t[0])

    def test_out_of_order_levels_are_sorted(self):
        """Defensive: even if a feed glitch hands us levels out of
        order, the snapshot must preserve the ordering contract."""
        st = Mbp10BookState()
        st.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=99, bid_sz=10, ask_px=102, ask_sz=7),
            _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
        ]))
        snap = st.snapshot()
        assert snap.best_bid() == 100
        assert snap.best_ask() == 101


class TestRegistry:
    def test_per_instrument_isolation(self):
        reg = Mbp10BookRegistry()
        a = reg.get_or_create(1)
        b = reg.get_or_create(2)
        assert a is not b
        a.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
        ]))
        b.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=200, bid_sz=5, ask_px=201, ask_sz=3),
        ]))
        assert reg.get(1).snapshot().best_bid() == 100
        assert reg.get(2).snapshot().best_bid() == 200

    def test_apply_provider_record_dispatches_by_instrument_id(self):
        reg = Mbp10BookRegistry()
        rec = SimpleNamespace(
            instrument_id=42, ts_recv_ns=1,
            payload=_mbp10_payload(action="A", levels=[
                _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
            ]),
        )
        r = reg.apply_provider_record(rec)
        assert r is not None and r.applied is True
        assert reg.get(42).snapshot().best_bid() == 100

    def test_apply_provider_record_without_instrument_id_is_noop(self):
        reg = Mbp10BookRegistry()
        rec = SimpleNamespace(instrument_id=None, ts_recv_ns=1,
                              payload=_mbp10_payload(action="A"))
        assert reg.apply_provider_record(rec) is None

    def test_clear_all_drops_every_instrument(self):
        reg = Mbp10BookRegistry()
        reg.get_or_create(1).apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
        ]))
        reg.get_or_create(2).apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=200, bid_sz=5, ask_px=201, ask_sz=3),
        ]))
        reg.clear_all()
        assert reg.get(1) is None
        assert reg.get(2) is None


class TestApplyResultContract:
    """The ApplyResult fields are the inputs the DATA-12 FSM will
    consume in the next slice. Locking the contract now prevents a
    downstream slice from silently changing the shape."""

    def test_apply_result_populates_all_fields(self):
        st = Mbp10BookState()
        r = st.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=100, bid_sz=5, ask_px=101, ask_sz=3),
        ]), ts_recv_ns=555)
        assert isinstance(r, ApplyResult)
        assert r.applied is True
        assert r.action == "A"
        assert r.cleared is False
        assert r.levels_present is True
        assert r.top_of_book_populated is True
        assert r.ts_recv_ns == 555

    def test_apply_result_flags_one_sided_book(self):
        """Post-reset, ASK may arrive before BID (or vice versa).
        top_of_book_populated must be False in that window — DATA-12
        will read this directly to gate quote_authoritative."""
        st = Mbp10BookState()
        r = st.apply(_mbp10_payload(action="A", levels=[
            _lvl(bid_px=100, bid_sz=5, ask_px=None, ask_sz=None),
        ]))
        assert r.levels_present is True
        assert r.top_of_book_populated is False
