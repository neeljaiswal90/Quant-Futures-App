"""Tests for ``rithmic_analytics.viewer.trade_replay_report`` (RA-026)."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.trade_log import CancelledOrder, TradeFill
from rithmic_analytics.features.trade_replay import (
    ReplaySession,
    compute_fill_snapshot,
    replay_session,
)
from rithmic_analytics.viewer.trade_replay_report import render_trade_replay_html

_NS_PER_SECOND = 10**9
# Use a base timestamp aligned with a known ET hour to make hour-bucket
# tests deterministic across DST transitions. 2026-05-19 14:30 UTC =
# 10:30 ET in May (PDT/EDT season).
_BASE_TS = int(
    pd.Timestamp("2026-05-19T14:30:00", tz="UTC").value
)


def _make_trades(rows: list[tuple[int, float, int, int]]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["event_ts_ns", "price", "quantity", "signed_qty"])
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["price"] = df["price"].astype("float64")
    df["quantity"] = df["quantity"].astype("int64")
    df["signed_qty"] = df["signed_qty"].astype("int64")
    df["session_id"] = "mnq-2026-05-19-rth"
    return df.sort_values("event_ts_ns").reset_index(drop=True)


def _make_fill(*, fill_ts_ns: int, side: str = "buy", price: float = 27000.0,
               fill_id: str = "f-1") -> TradeFill:
    return TradeFill(
        fill_ts_ns=fill_ts_ns, symbol="MNQ", side=side,  # type: ignore[arg-type]
        price=price, quantity=1, order_type="market", fill_id=fill_id,
    )


# ---------------------------------------------------------------------------
# Happy path + empty
# ---------------------------------------------------------------------------


def test_render_writes_file(tmp_path: Path) -> None:
    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0, 1, 1) for i in range(120)]
    )
    fills = [_make_fill(fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND)]
    session = replay_session(fills, trades, MNQ)
    out = tmp_path / "replay.html"

    result = render_trade_replay_html(session, out)

    assert result == out
    assert out.exists()
    content = out.read_text(encoding="utf-8")
    assert "<title>" in content
    assert "Trade Replay" in content


def test_render_no_fills_shows_empty_state(tmp_path: Path) -> None:
    trades = _make_trades([(_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1)])
    session = replay_session([], trades, MNQ)
    out = tmp_path / "replay.html"

    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "No fills in this replay session" in content


def test_render_includes_header_summary_total_pnl_and_hit_rate(tmp_path: Path) -> None:
    """1 winning fill + 1 losing fill → 50% hit rate; gross pnl reported."""
    trades = _make_trades(
        [
            # session start
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1),
            # fill 1 at +50s (buy 27000), +60s later price = 27005 → +$10
            (_BASE_TS + 110 * _NS_PER_SECOND, 27005.0, 1, 1),
            # fill 2 at +200s (buy 27010), +60s later price = 27005 → -$10
            (_BASE_TS + 200 * _NS_PER_SECOND, 27010.0, 1, 1),
            (_BASE_TS + 260 * _NS_PER_SECOND, 27005.0, 1, 1),
        ]
    )
    fills = [
        _make_fill(
            fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND, price=27000.0, fill_id="win"
        ),
        _make_fill(
            fill_ts_ns=_BASE_TS + 200 * _NS_PER_SECOND, price=27010.0, fill_id="loss"
        ),
    ]
    session = replay_session(fills, trades, MNQ)
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)

    content = out.read_text(encoding="utf-8")
    assert "2 fills" in content
    # 50% hit rate
    assert "hit-rate 50.0%" in content


def test_render_pnl_color_coded_classes_present(tmp_path: Path) -> None:
    """Green positive, red negative, both class names present."""
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1),
            (_BASE_TS + 110 * _NS_PER_SECOND, 27005.0, 1, 1),  # winner
            (_BASE_TS + 200 * _NS_PER_SECOND, 27010.0, 1, 1),
            (_BASE_TS + 260 * _NS_PER_SECOND, 27005.0, 1, 1),  # loser
        ]
    )
    fills = [
        _make_fill(fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND, price=27000.0),
        _make_fill(fill_ts_ns=_BASE_TS + 200 * _NS_PER_SECOND, price=27010.0),
    ]
    session = replay_session(fills, trades, MNQ)
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "pnl-positive" in content
    assert "pnl-negative" in content


def test_render_pnl_na_for_late_session_horizon(tmp_path: Path) -> None:
    """Late-session fill renders em-dash for 300s and 900s columns."""
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1),
            (_BASE_TS + 110 * _NS_PER_SECOND, 27005.0, 1, 1),  # only +60s of buffer
        ]
    )
    fill = _make_fill(fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND, price=27000.0)
    session = replay_session([fill], trades, MNQ)
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "—" in content  # em-dash for the N/A horizons


# ---------------------------------------------------------------------------
# Skip-counter callouts
# ---------------------------------------------------------------------------


def test_render_symbol_mismatch_callout(tmp_path: Path) -> None:
    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0, 1, 1) for i in range(120)]
    )
    fills = [
        TradeFill(
            fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND, symbol="ES",
            side="buy", price=27000.0, quantity=1, order_type="market", fill_id="x",
        ),
    ]
    session = replay_session(fills, trades, MNQ)
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "symbol doesn't match" in content
    assert "warn-callout" in content


def test_render_outside_window_callout(tmp_path: Path) -> None:
    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0, 1, 1) for i in range(120)]
    )
    fills = [
        _make_fill(fill_ts_ns=_BASE_TS + 500 * _NS_PER_SECOND, fill_id="out"),
    ]
    session = replay_session(fills, trades, MNQ)
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "outside the JSONL capture window" in content


# ---------------------------------------------------------------------------
# Cancellations section
# ---------------------------------------------------------------------------


def test_render_cancellations_section_when_provided(tmp_path: Path) -> None:
    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0, 1, 1) for i in range(120)]
    )
    fill = _make_fill(fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND)
    cancelled = [
        CancelledOrder(
            cancel_ts_ns=_BASE_TS + 80 * _NS_PER_SECOND, symbol="MNQ",
            side="sell", order_type="limit", limit_price=27050.0, stop_price=None,
            quantity=1, status="Cancelled (by trader)",
        ),
    ]
    session = replay_session([fill], trades, MNQ, cancelled=cancelled)
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "Cancellations" in content
    assert "27,050.00" in content
    assert "Cancelled (by trader)" in content


def test_render_no_cancellations_section_when_empty(tmp_path: Path) -> None:
    """When cancelled list is empty, the section is omitted entirely."""
    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0, 1, 1) for i in range(120)]
    )
    fill = _make_fill(fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND)
    session = replay_session([fill], trades, MNQ)  # no cancelled
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "<h2>Cancellations" not in content


# ---------------------------------------------------------------------------
# Quarantined fill rendering
# ---------------------------------------------------------------------------


def test_render_quarantined_fill_gets_visual_marker(tmp_path: Path) -> None:
    trades = _make_trades(
        [(_BASE_TS + i * _NS_PER_SECOND, 27000.0, 1, 1) for i in range(120)]
    )
    fill = TradeFill(
        fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND, symbol="MNQ", side="buy",
        price=float("nan"), quantity=1, order_type="market", fill_id="q-1",
        quarantined=True,
    )
    session = ReplaySession(
        snapshots=[compute_fill_snapshot(fill, trades, MNQ)],
        cancelled=[], target_symbol="MNQ",
        fills_skipped_symbol_mismatch=0, fills_skipped_outside_window=0,
        window_seconds=60,
    )
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "class='quarantined'" in content


# ---------------------------------------------------------------------------
# Best-window analysis
# ---------------------------------------------------------------------------


def test_render_best_window_when_enough_fills(tmp_path: Path) -> None:
    """Three winners in one hour-bucket triggers best-window stat."""
    # 3 fills all within the same ET hour (10:31, 10:32, 10:33 ET)
    fill_offsets = [60, 120, 180]  # seconds after _BASE_TS
    trades_rows = []
    fills = []
    for i, off in enumerate(fill_offsets):
        fill_ts = _BASE_TS + off * _NS_PER_SECOND
        # Trade at fill_ts and at fill_ts + 60s with +5pt move
        trades_rows.append((fill_ts, 27000.0, 1, 1))
        trades_rows.append((fill_ts + 60 * _NS_PER_SECOND, 27005.0, 1, 1))
        fills.append(_make_fill(fill_ts_ns=fill_ts, price=27000.0, fill_id=f"f-{i}"))

    trades = _make_trades(trades_rows)
    session = replay_session(fills, trades, MNQ)
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "best window" in content


def test_render_no_best_window_when_too_few_fills(tmp_path: Path) -> None:
    """Single fill → no best-window in header."""
    trades = _make_trades(
        [
            (_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1),
            (_BASE_TS + 110 * _NS_PER_SECOND, 27005.0, 1, 1),
        ]
    )
    fill = _make_fill(fill_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND, price=27000.0)
    session = replay_session([fill], trades, MNQ)
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "best window" not in content


# ---------------------------------------------------------------------------
# Custom title
# ---------------------------------------------------------------------------


def test_render_custom_title(tmp_path: Path) -> None:
    trades = _make_trades([(_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1)])
    session = replay_session([], trades, MNQ)
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out, title="My Custom Title")
    content = out.read_text(encoding="utf-8")

    assert "My Custom Title" in content


# ---------------------------------------------------------------------------
# RA-036: Cancellation Outcomes section
# ---------------------------------------------------------------------------


def test_render_cancellation_outcomes_section_when_supplied(tmp_path: Path) -> None:
    """When a CancellationAnalysisReport is passed in, the HTML carries a
    'Cancellation Outcomes' section between the existing tables and the footer."""
    from rithmic_analytics.core.trade_log import CancelledOrder
    from rithmic_analytics.features.cancellation_analysis import (
        analyze_cancellations,
    )

    trades = _make_trades([
        (_BASE_TS + i * _NS_PER_SECOND, 27000.0 + i, 1, 1) for i in range(700)
    ])
    cancel = CancelledOrder(
        cancel_ts_ns=_BASE_TS + 50 * _NS_PER_SECOND,
        symbol="MNQ", side="buy", order_type="limit",
        limit_price=27050.0, stop_price=None, quantity=1,
        status="Cancelled (by trader)",
    )
    cancel_report = analyze_cancellations([cancel], trades, MNQ)
    session = replay_session([], trades, MNQ, cancelled=[cancel])

    out = tmp_path / "replay.html"
    render_trade_replay_html(
        session, out, cancellation_report=cancel_report,
    )
    content = out.read_text(encoding="utf-8")

    assert "Cancellation Outcomes" in content
    assert "regret_cancel_rate" in content


def test_render_cancellation_outcomes_section_omitted_when_no_report(tmp_path: Path) -> None:
    """No cancellation_report → section omitted entirely (no empty headings)."""
    trades = _make_trades([(_BASE_TS + 10 * _NS_PER_SECOND, 27000.0, 1, 1)])
    session = replay_session([], trades, MNQ)
    out = tmp_path / "replay.html"
    render_trade_replay_html(session, out)
    content = out.read_text(encoding="utf-8")

    assert "Cancellation Outcomes" not in content


def test_render_cancellation_outcomes_high_rate_shows_rule7_alarm(
    tmp_path: Path,
) -> None:
    """regret_cancel_rate > 20% → ⚠ Rule 7 alarm marker rendered."""
    from rithmic_analytics.core.trade_log import CancelledOrder
    from rithmic_analytics.features.cancellation_analysis import (
        analyze_cancellations,
    )

    # 3 cancels all reaching their limits = 100% rate
    trades_rows: list[tuple[int, float, int, int]] = []
    cancels: list[CancelledOrder] = []
    for i in range(3):
        cancel_ts = _BASE_TS + i * 600 * _NS_PER_SECOND
        cancels.append(CancelledOrder(
            cancel_ts_ns=cancel_ts, symbol="MNQ", side="buy",
            order_type="limit", limit_price=27000.0 + i * 100,
            stop_price=None, quantity=1, status="Cancelled (by trader)",
        ))
        # Add tape that reaches each limit after cancel
        for j in range(8):
            trades_rows.append((
                cancel_ts + (j + 1) * 60 * _NS_PER_SECOND,
                27000.0 + i * 100 - 5,  # well below limit (favorable)
                1, 1,
            ))

    trades = _make_trades(trades_rows)
    cancel_report = analyze_cancellations(cancels, trades, MNQ)
    session = replay_session([], trades, MNQ, cancelled=cancels)

    out = tmp_path / "replay.html"
    render_trade_replay_html(
        session, out, cancellation_report=cancel_report,
    )
    content = out.read_text(encoding="utf-8")

    assert "Rule 7 alarm" in content
