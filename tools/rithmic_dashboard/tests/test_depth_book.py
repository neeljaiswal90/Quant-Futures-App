from __future__ import annotations

import json
from pathlib import Path
from typing import Literal, cast

import pytest

from rithmic_dashboard.features.depth_book import (
    DepthBook,
    DepthBookTailer,
    build_depth_book_from_tail,
)
from rithmic_dashboard.models import MboOrderEvent

MboAction = Literal["A", "M", "C", "F", "T"]


def _mbo(
    *,
    action: str,
    side: str = "A",
    ts: int,
    order_id: str = "ord-1",
    price: float = 30220.0,
    size: int = 30,
    sequence: int | None = None,
) -> MboOrderEvent:
    return MboOrderEvent(
        timestamp_ns=ts,
        recv_ts_ns=None,
        sequence=sequence,
        action=cast(MboAction, action if action in {"A", "M", "C", "F", "T"} else "C"),
        side="B" if side == "B" else "A",
        price=price,
        size=size,
        order_id=order_id,
        priority=None,
    )


def _write_mbo(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def _mbo_row(
    *,
    ts: int,
    action: str,
    order_id: str,
    side: str = "A",
    price: float = 30220.0,
    size: int = 30,
    sequence: int = 1,
) -> dict[str, object]:
    return {
        "event_ts_ns": ts,
        "sequence": sequence,
        "action": action,
        "side": side,
        "price": price,
        "size": size,
        "order_id": order_id,
    }


def test_depth_book_tracks_add_modify_cancel_and_snapshot() -> None:
    book = DepthBook(order_ttl_seconds=1_000, max_ticks_from_mid=None)

    book.apply_many(
        [
            _mbo(action="A", side="B", ts=1, order_id="bid-1", price=30219.75, size=10),
            _mbo(action="A", side="B", ts=2, order_id="bid-2", price=30219.75, size=7),
            _mbo(action="M", side="B", ts=3, order_id="bid-1", price=30219.50, size=12),
            _mbo(action="C", side="B", ts=4, order_id="bid-2", price=30219.75, size=7),
            _mbo(action="A", side="A", ts=5, order_id="ask-1", price=30220.25, size=9),
        ]
    )

    snapshot = book.snapshot(mid=30220.0, n_ticks=4)

    assert [(level.price, level.size) for level in snapshot.bid_levels] == [(30219.5, 12)]
    assert [(level.price, level.size) for level in snapshot.ask_levels] == [(30220.25, 9)]
    assert book.total_depth == 21


def test_depth_book_orphan_modify_adds_order() -> None:
    book = DepthBook(order_ttl_seconds=1_000, max_ticks_from_mid=None)

    book.apply(_mbo(action="M", ts=1, order_id="orphan", price=30220.25, size=11))

    snapshot = book.snapshot(mid=30220.0, n_ticks=3)
    assert [(level.price, level.size) for level in snapshot.ask_levels] == [(30220.25, 11)]


def test_depth_book_fill_and_trade_actions_remove_order() -> None:
    for action in ("F", "T"):
        book = DepthBook(order_ttl_seconds=1_000, max_ticks_from_mid=None)
        book.apply(_mbo(action="A", side="B", ts=1, order_id="bid", price=30219.75, size=10))
        book.apply(_mbo(action=action, side="B", ts=2, order_id="bid", price=30219.75, size=10))

        assert book.active_order_count == 0
        assert book.level_size == {}


def test_depth_book_ignores_non_positive_size_updates() -> None:
    book = DepthBook(order_ttl_seconds=1_000, max_ticks_from_mid=None)
    book.apply(_mbo(action="A", side="A", ts=1, order_id="ask", price=30220.25, size=10))
    book.apply(_mbo(action="M", side="A", ts=2, order_id="ask", price=30220.25, size=0))

    assert [(level.price, level.size) for level in book.snapshot(mid=30220.0, n_ticks=3).ask_levels] == [
        (30220.25, 10)
    ]


def test_depth_book_eviction_preserves_non_negative_level_size() -> None:
    book = DepthBook(max_active_orders=2, order_ttl_seconds=1_000, max_ticks_from_mid=None)
    for idx in range(10):
        book.apply(
            _mbo(
                action="A",
                side="A",
                ts=idx + 1,
                order_id=f"ask-{idx}",
                price=30220.0 + idx * 0.25,
                size=idx + 1,
            )
        )

    assert book.active_order_count <= 2
    assert all(size > 0 for size in book.level_size.values())
    assert sum(book.level_size.values()) == sum(order.size for order in book.orders.values())


def test_depth_book_prunes_zero_levels_and_outside_mid_window() -> None:
    book = DepthBook(order_ttl_seconds=1_000, max_ticks_from_mid=4)
    book.apply(_mbo(action="A", side="B", ts=1, order_id="inside", price=30219.75, size=10))
    book.apply(_mbo(action="A", side="B", ts=2, order_id="outside", price=30100.0, size=10))
    book.apply(_mbo(action="C", side="B", ts=3, order_id="inside", price=30219.75, size=10))

    snapshot = book.snapshot(mid=30220.0, n_ticks=4)

    assert snapshot.bid_levels == ()
    assert book.level_size == {}
    assert book.active_order_count == 0


def test_depth_book_processes_events_by_timestamp_and_sequence() -> None:
    book = DepthBook(order_ttl_seconds=1_000, max_ticks_from_mid=None)
    book.apply_many(
        [
            _mbo(action="C", side="A", ts=2, sequence=2, order_id="ask", price=30220.25, size=9),
            _mbo(action="A", side="A", ts=1, sequence=1, order_id="ask", price=30220.25, size=9),
        ]
    )

    assert book.active_order_count == 0
    assert book.level_size == {}


def test_depth_book_tailer_seeds_and_polls_new_complete_rows(tmp_path: Path) -> None:
    path = tmp_path / "MNQ_rth.mbo.jsonl"
    _write_mbo(
        path,
        [_mbo_row(ts=1, action="A", side="B", order_id="bid-1", price=30219.75, size=5)],
    )
    tailer = DepthBookTailer(path, seed_tail_bytes=10_000)
    result = tailer.seed_from_tail()

    assert len(result.events) == 1
    assert tailer.book.active_order_count == 1

    with path.open("ab") as f:
        f.write(
            json.dumps(
                _mbo_row(ts=2, action="A", side="A", order_id="ask-1", price=30220.25, size=7)
            ).encode("utf-8")
        )
    assert tailer.poll() == 0

    with path.open("ab") as f:
        f.write(b"\n")
    assert tailer.poll() == 1
    assert [(level.price, level.size) for level in tailer.book.snapshot(mid=30220.0, n_ticks=3).ask_levels] == [
        (30220.25, 7)
    ]


def test_depth_book_real_capture_replay_keeps_sums_bounded_and_non_negative() -> None:
    tools_root = Path(__file__).resolve().parents[2]
    capture = (
        tools_root
        / "rithmic_analytics"
        / "data"
        / "captures"
        / "2026-05-29"
        / "MNQ_rth.mbo.jsonl"
    )
    if not capture.exists():
        pytest.skip("real MBO capture fixture is not present in this checkout")

    book, result = build_depth_book_from_tail(capture, tail_bytes=2_000_000)
    snapshot = book.snapshot(mid=30350.0, n_ticks=20)

    assert result.events
    assert book.active_order_count <= book.max_active_orders
    assert all(size > 0 for size in book.level_size.values())
    assert sum(book.level_size.values()) == sum(order.size for order in book.orders.values())
    assert len(snapshot.bid_levels) <= 20
    assert len(snapshot.ask_levels) <= 20
