"""Phase 4: equivalence of the incremental RollingConsumeState vs the fresh
per-window MboOrderTracker.process().

The replay rewrite feeds ONE persistent tracker only new events per step instead
of rebuilding the book from the whole bounded tail every step. This MUST stay
byte-identical to the fresh path or it silently shifts training labels. These
tests slide a window over an adversarial synthetic stream and assert the two
paths return the same consumed set at EVERY step — covering both regimes:

* quiet  — window spans >> the 120s order TTL, so the TTL evicts first and the
  window-back path is exercised only lightly;
* busy   — window spans << TTL, so orders' ADD scrolls out of the byte-window
  while still within TTL: the window-back eviction (evict_before) is the ONLY
  thing keeping incremental == fresh. This is the path the real golden fixture
  (a quiet session) cannot reach.
"""

from __future__ import annotations

import pytest

from rithmic_dashboard.features.mbo_order_tracker import (
    MboOrderTracker,
    new_rolling_consume_state,
)
from rithmic_dashboard.models import MboOrderEvent, TradeTick

_MS = 1_000_000


def _mbo(ts: int, action: str, side: str, price: float, size: int, oid: str, seq: int) -> MboOrderEvent:
    return MboOrderEvent(
        timestamp_ns=ts,
        recv_ts_ns=ts,
        sequence=seq,
        action=action,  # type: ignore[arg-type]
        side=side,  # type: ignore[arg-type]
        price=price,
        size=size,
        order_id=oid,
        priority=None,
    )


def _trade(ts: int, price: float, qty: int, aggr: str) -> TradeTick:
    return TradeTick(timestamp_ns=ts, price=price, quantity=qty, aggressor_side=aggr)  # type: ignore[arg-type]


def _norm(consumed: tuple) -> list:
    """Order-independent normalized view of a consumed set."""
    return sorted(
        (c.order_id, c.add_ts_ns, c.consume_ts_ns, c.consumed_qty, round(c.price, 4), c.side)
        for c in consumed
    )


def _build_adversarial_stream() -> tuple[list[MboOrderEvent], list[TradeTick]]:
    """A/C order pairs + matching trades, deliberately stressing:
    - long-lived orders (ADD early, CONSUME late → ADD scrolls out under a small window),
    - two orders at the SAME price consumed ~together (trade-depletion competition),
    - ts ties (multiple events sharing a timestamp).
    """
    mbo: list[MboOrderEvent] = []
    trades: list[TradeTick] = []
    seq = 0

    def add(ts, action, side, price, size, oid):
        nonlocal seq
        mbo.append(_mbo(ts, action, side, price, size, oid, seq))
        seq += 1

    base = 1_000 * _MS
    price0 = 20000.0
    # 40 short-lived orders: add then consume ~5ms later, bid side (B) → sell trades.
    for i in range(40):
        t = base + i * 10 * _MS
        px = price0 + (i % 8) * 0.25
        add(t, "A", "B", px, 10, f"s{i}")
        add(t + 5 * _MS, "C", "B", px, 10, f"s{i}")
        # matching aggressor-sell trade at the consume time/price
        trades.append(_trade(t + 5 * _MS, px, 7, "sell"))

    # 6 LONG-lived orders: add early, consume ~300ms later (their ADD will scroll
    # out of a small window before their C → exercises window-back eviction).
    for j in range(6):
        t_add = base + (j * 7) * _MS
        t_con = t_add + 300 * _MS
        px = price0 + 1.0 + j * 0.25
        add(t_add, "A", "A", px, 12, f"L{j}")  # ask side → buy trades
        add(t_con, "C", "A", px, 12, f"L{j}")
        trades.append(_trade(t_con, px, 9, "buy"))

    # 3 PAIRS at the same price consumed within tolerance (depletion competition):
    # two bid orders at one price, one matching sell trade with limited volume.
    for k in range(3):
        t = base + 500 * _MS + k * 40 * _MS
        px = price0 + 5.0 + k * 0.25
        add(t, "A", "B", px, 20, f"p{k}a")
        add(t + 1 * _MS, "A", "B", px, 20, f"p{k}b")
        add(t + 20 * _MS, "C", "B", px, 20, f"p{k}a")
        add(t + 21 * _MS, "C", "B", px, 20, f"p{k}b")
        # one sell trade with only enough volume for ~one order (forces depletion)
        trades.append(_trade(t + 20 * _MS, px, 22, "sell"))

    # ts ties: two events sharing an identical timestamp.
    tie_t = base + 900 * _MS
    add(tie_t, "A", "B", price0 + 8.0, 15, "tieA")
    add(tie_t, "A", "B", price0 + 8.0, 15, "tieB")
    add(tie_t + 30 * _MS, "C", "B", price0 + 8.0, 15, "tieA")
    trades.append(_trade(tie_t + 30 * _MS, price0 + 8.0, 11, "sell"))

    mbo.sort(key=lambda e: (e.timestamp_ns, e.sequence or 0))
    trades.sort(key=lambda t: t.timestamp_ns or 0)
    return mbo, trades


def _assert_sliding_equivalence(w_mbo: int, w_trade: int) -> int:
    """Slide count-based windows over the stream; assert fresh == incremental at
    each step. Returns the number of steps where the consumed set was non-empty
    (so the test proves it actually exercised consumption, not just empties)."""
    mbo, trades = _build_adversarial_stream()
    state = new_rolling_consume_state()
    nonempty = 0
    for i in range(1, len(mbo) + 1):
        now_ts = mbo[i - 1].timestamp_ns
        window_mbo = mbo[max(0, i - w_mbo) : i]
        revealed_trades = [t for t in trades if (t.timestamp_ns or 0) <= now_ts]
        window_trades = revealed_trades[max(0, len(revealed_trades) - w_trade) :]

        fresh = MboOrderTracker().process(window_mbo, window_trades)
        incremental = state.step(window_mbo, window_trades)

        assert _norm(fresh) == _norm(incremental), (
            f"step {i} (now={now_ts}) mismatch:\n"
            f"  fresh={_norm(fresh)}\n  incr ={_norm(incremental)}"
        )
        if fresh:
            nonempty += 1
    return nonempty


def test_incremental_equivalence_quiet_regime() -> None:
    """Large window: the whole stream fits, TTL binds. Window-back rarely fires."""
    nonempty = _assert_sliding_equivalence(w_mbo=10_000, w_trade=10_000)
    assert nonempty > 0  # proves consumption actually happened


def test_incremental_equivalence_busy_regime() -> None:
    """Small window: long-lived orders' ADD scrolls out before their C, so
    evict_before(window_back) is the only thing keeping incremental == fresh."""
    nonempty = _assert_sliding_equivalence(w_mbo=25, w_trade=25)
    assert nonempty > 0


@pytest.mark.xfail(
    reason=(
        "KNOWN LIMITATION (Phase 4): the pure-incremental RollingConsumeState is "
        "byte-exact for the ORDER BOOK but not for TRADE-INDEX DEPLETION when "
        "same-price consumptions compete for the same trade AND the window-back "
        "slides between them. The fresh path rebuilds the trade index every step, "
        "so it 'un-depletes' a trade when the depleting consumption scrolls out — "
        "a re-computation that a persistent depleting index can't reproduce. The "
        "byte-exact fix is the 'incremental book + re-match the coupled trade "
        "matching each step' redesign in docs/perf/replay-incremental-tracker-design.md. "
        "A tiny (6-event) window triggers this reliably; the 25/10000 windows above "
        "happen not to align the boundary with a competing group, but that's luck, "
        "NOT a guarantee — do not rely on the pure-incremental path until the "
        "re-match redesign lands and this xfail is removed.",
    ),
    strict=True,
)
def test_incremental_equivalence_tiny_window() -> None:
    """Extreme slide (window of a few events) — maximal window-back churn. Triggers
    the trade-depletion-competition limitation; see xfail reason."""
    _assert_sliding_equivalence(w_mbo=6, w_trade=6)


def test_incremental_matches_fresh_full_batch() -> None:
    """Degenerate single-step: feeding the whole stream once == fresh process()."""
    mbo, trades = _build_adversarial_stream()
    fresh = MboOrderTracker().process(mbo, trades)
    state = new_rolling_consume_state()
    incremental = state.step(mbo, trades)
    assert _norm(fresh) == _norm(incremental)
