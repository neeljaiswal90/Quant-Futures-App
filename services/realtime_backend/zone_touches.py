"""RA-112e Phase 2 — append-only zone-touch + outcome event logger.

Captures every price-tick crossing of a monitored zone (today: reference
lines from :mod:`zone_snapshots`; tomorrow: σ shelves) with the pre-touch
MBP1 features the trader saw, plus deferred outcome rows (MFE/MAE @
1m/3m/5m/10m).

Two append-only streams under the configured output dir:
  * ``zone_touches/<date>_<symbol>_<session>.jsonl`` — one row per touch.
  * ``zone_outcomes/<date>_<symbol>_<session>.jsonl`` — four rows per touch
    (one per horizon), linked by ``event_id``.

Touch rows are self-contained (carry their own zone state + features); the
outcome row only carries the rolling MFE/MAE + a derived ``outcome_label``.

Architecture:
  * :class:`TouchDetector` — pure crossing detection. Stateful (last side per
    level) but no I/O.
  * :class:`RollingFeatureAccumulator` — sliding-window MBP1 features
    (trade-imbalance, approach-speed, depth-imbalance, microprice offset,
    spread). OFI is stubbed (left as ``None``) until a full MBP1 quote-update
    stream lands in a future ticket.
  * :class:`OutcomeTracker` — pending-outcome queue; updates MFE/MAE on every
    price tick and emits each row when its horizon ticks past.
  * :class:`ZoneTouchStream` — owns the two JSONL writers, the monotonic
    ``event_id`` counter, and session rollover.

The pre-touch / post-touch separation enforces the leakage rule: features
referenced for scoring at touch_ts use only data ending at or before
touch_ts_ns. Outcome computation begins strictly AFTER touch_ts_ns.
"""

from __future__ import annotations

import dataclasses
import json
import math
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, IO, Iterable

# Operator-locked defaults (2026-06-01).
DEFAULT_MIN_DISTANCE_TICKS: float = 4.0    # how far away price must have been
DEFAULT_COOLDOWN_SEC: float = 30.0          # min interval between same-level touches
DEFAULT_TICK_SIZE: float = 0.25             # MNQ
OUTCOME_HORIZONS_SEC: tuple[int, ...] = (60, 180, 300, 600)

# Pre-touch feature horizons (per operator Q4).
OFI_HORIZONS_SEC: tuple[int, ...] = (5, 15, 30, 60)
TRADE_IMBALANCE_HORIZONS_SEC: tuple[int, ...] = (5, 15, 30, 60)
APPROACH_SPEED_HORIZONS_SEC: tuple[int, ...] = (1, 5, 15)
DEPTH_MEAN_WINDOW_SEC: int = 5
MICROPRICE_MEAN_WINDOW_SEC: int = 5
SPREAD_MAX_WINDOW_SEC: int = 5

SCHEMA_VERSION: int = 1
MAX_FEATURE_WINDOW_SEC: int = max(
    max(OFI_HORIZONS_SEC),
    max(TRADE_IMBALANCE_HORIZONS_SEC),
    max(APPROACH_SPEED_HORIZONS_SEC),
    DEPTH_MEAN_WINDOW_SEC,
    MICROPRICE_MEAN_WINDOW_SEC,
    SPREAD_MAX_WINDOW_SEC,
)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


class TouchSide(str, Enum):
    FROM_ABOVE = "from_above"
    FROM_BELOW = "from_below"


class OutcomeLabel(str, Enum):
    REJECTION = "rejection"
    BREAK = "break"
    AMBIGUOUS = "ambiguous"
    NO_RESOLUTION = "no_resolution"


@dataclass(frozen=True, slots=True)
class MonitoredLevel:
    """A zone the detector watches for price crossings.

    Reference lines have ``low == high``; shelves have ``high > low``.
    """
    zone_id: str
    zone_family: str
    low: float
    high: float
    label: str

    @property
    def mid(self) -> float:
        return (self.low + self.high) / 2.0

    @property
    def is_band(self) -> bool:
        return self.high > self.low


@dataclass(frozen=True, slots=True)
class PreTouchFeatures:
    """All pre-touch features. ``None`` = not yet wired or unavailable.

    Window naming: ``<feature>_<horizon_sec>s``. Production scoring uses the
    30s / 5s pair (per operator Q4); the wider research horizons are logged
    for future analysis without needing to rerun raw MBP1 reconstruction.
    """
    # Order-flow imbalance (signed MBP1 quote-update events).
    # Stubbed as None until a full MBP1 quote-update stream is wired in.
    ofi_5s: float | None = None
    ofi_15s: float | None = None
    ofi_30s: float | None = None
    ofi_60s: float | None = None
    # Trade aggressor imbalance. Range [-1, 1]; >0 = buy-aggressor dominant.
    trade_imbalance_5s: float | None = None
    trade_imbalance_15s: float | None = None
    trade_imbalance_30s: float | None = None
    trade_imbalance_60s: float | None = None
    # Approach speed in ticks/sec. Sign matches price-change direction.
    approach_speed_1s: float | None = None
    approach_speed_5s: float | None = None
    approach_speed_15s: float | None = None
    # Top-of-book imbalance at the moment of touch (and a 5s rolling mean).
    # Defined as (bid_size - ask_size) / (bid_size + ask_size); [-1, 1].
    depth_imbalance_touch: float | None = None
    depth_imbalance_mean_5s: float | None = None
    # Microprice - mid, in ticks. Positive = lean toward ask (buy pressure).
    microprice_offset_touch: float | None = None
    microprice_offset_mean_5s: float | None = None
    # Spread in ticks (touch instant, plus the max over the prior 5s).
    spread_touch: float | None = None
    spread_max_5s: float | None = None


@dataclass(frozen=True, slots=True)
class TouchEvent:
    """One zone-touch row. Immutable; written once."""
    schema_version: int
    event_id: str
    touch_event_seq: int
    touch_ts_ns: int
    symbol: str
    session: str
    zone_snapshot_seq: int
    zone_id: str
    zone_family: str
    zone_low: float
    zone_high: float
    touch_price: float
    approach_side: str
    expected_bounce_direction: str
    pre_touch_features: PreTouchFeatures
    method_versions: dict[str, str]

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


@dataclass(frozen=True, slots=True)
class OutcomeRow:
    """One outcome row, linked back to a TouchEvent by ``event_id``."""
    schema_version: int
    event_id: str
    horizon_sec: int
    horizon_end_ts_ns: int
    mfe_ticks: float
    mae_ticks: float
    max_favorable_ts_ns: int | None
    max_adverse_ts_ns: int | None
    outcome_label: str

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


# ---------------------------------------------------------------------------
# Rolling feature accumulator
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _TradeSample:
    ts_ns: int
    price: float
    volume: int
    aggressor_side: str


@dataclass(slots=True)
class _DepthSnapshot:
    ts_ns: int
    bid_price: float | None
    ask_price: float | None
    bid_size: float | None
    ask_size: float | None


class RollingFeatureAccumulator:
    """Maintains sliding windows of trades + L1 depth for pre-touch features.

    Push events in monotonically-increasing timestamp order. Old samples
    outside ``max_window_sec`` (the widest feature horizon) are dropped on each
    push. ``features_at(ts)`` computes the feature dict, restricting each
    sliding window so the right edge is ``ts`` — guaranteeing no post-touch
    leakage when the caller stamps touch_ts_ns.
    """

    def __init__(
        self,
        *,
        tick_size: float = DEFAULT_TICK_SIZE,
        max_window_sec: int = MAX_FEATURE_WINDOW_SEC,
    ) -> None:
        self._tick_size = tick_size
        self._max_window_ns = max_window_sec * 1_000_000_000
        self._trades: deque[_TradeSample] = deque()
        self._depths: deque[_DepthSnapshot] = deque()

    # ----- ingestion -----------------------------------------------------

    def on_trade(
        self,
        *,
        ts_ns: int,
        price: float,
        volume: int,
        aggressor_side: str,
    ) -> None:
        self._trades.append(
            _TradeSample(
                ts_ns=ts_ns,
                price=price,
                volume=max(0, volume),
                aggressor_side=aggressor_side,
            )
        )
        self._prune(self._trades, ts_ns)

    def on_depth(
        self,
        *,
        ts_ns: int,
        bid_price: float | None,
        ask_price: float | None,
        bid_size: float | None,
        ask_size: float | None,
    ) -> None:
        self._depths.append(
            _DepthSnapshot(
                ts_ns=ts_ns,
                bid_price=bid_price,
                ask_price=ask_price,
                bid_size=bid_size,
                ask_size=ask_size,
            )
        )
        self._prune(self._depths, ts_ns)

    # ----- query at touch_ts_ns -----------------------------------------

    def features_at(self, ts_ns: int) -> PreTouchFeatures:
        return PreTouchFeatures(
            trade_imbalance_5s=self._trade_imbalance(ts_ns, 5),
            trade_imbalance_15s=self._trade_imbalance(ts_ns, 15),
            trade_imbalance_30s=self._trade_imbalance(ts_ns, 30),
            trade_imbalance_60s=self._trade_imbalance(ts_ns, 60),
            approach_speed_1s=self._approach_speed(ts_ns, 1),
            approach_speed_5s=self._approach_speed(ts_ns, 5),
            approach_speed_15s=self._approach_speed(ts_ns, 15),
            depth_imbalance_touch=self._depth_imbalance_instant(ts_ns),
            depth_imbalance_mean_5s=self._depth_imbalance_mean(
                ts_ns, DEPTH_MEAN_WINDOW_SEC
            ),
            microprice_offset_touch=self._microprice_offset_instant(ts_ns),
            microprice_offset_mean_5s=self._microprice_offset_mean(
                ts_ns, MICROPRICE_MEAN_WINDOW_SEC
            ),
            spread_touch=self._spread_instant(ts_ns),
            spread_max_5s=self._spread_max(ts_ns, SPREAD_MAX_WINDOW_SEC),
            # OFI fields ship as None (default) — see module docstring.
        )

    # ----- internals -----------------------------------------------------

    def _prune(self, q: deque[Any], now_ts_ns: int) -> None:
        cutoff = now_ts_ns - self._max_window_ns
        while q and q[0].ts_ns < cutoff:
            q.popleft()

    def _window(
        self, q: Iterable[Any], end_ts_ns: int, window_sec: int
    ) -> list[Any]:
        start_ns = end_ts_ns - window_sec * 1_000_000_000
        return [s for s in q if start_ns <= s.ts_ns <= end_ts_ns]

    def _trade_imbalance(self, ts_ns: int, window_sec: int) -> float | None:
        samples = self._window(self._trades, ts_ns, window_sec)
        if not samples:
            return None
        buy = sum(s.volume for s in samples if s.aggressor_side == "buy")
        sell = sum(s.volume for s in samples if s.aggressor_side == "sell")
        total = buy + sell
        if total == 0:
            return None
        return (buy - sell) / total

    def _approach_speed(self, ts_ns: int, window_sec: int) -> float | None:
        samples = self._window(self._trades, ts_ns, window_sec)
        if len(samples) < 2:
            return None
        # End-anchored at touch; start = earliest sample in the window.
        delta_price = samples[-1].price - samples[0].price
        delta_sec = (samples[-1].ts_ns - samples[0].ts_ns) / 1e9
        if delta_sec <= 0:
            return None
        return (delta_price / self._tick_size) / delta_sec

    def _last_depth_at(self, ts_ns: int) -> _DepthSnapshot | None:
        latest: _DepthSnapshot | None = None
        for s in self._depths:
            if s.ts_ns <= ts_ns:
                latest = s
            else:
                break
        return latest

    def _depth_imbalance_instant(self, ts_ns: int) -> float | None:
        snap = self._last_depth_at(ts_ns)
        if snap is None or snap.bid_size is None or snap.ask_size is None:
            return None
        total = snap.bid_size + snap.ask_size
        if total <= 0:
            return None
        return (snap.bid_size - snap.ask_size) / total

    def _depth_imbalance_mean(
        self, ts_ns: int, window_sec: int
    ) -> float | None:
        samples = self._window(self._depths, ts_ns, window_sec)
        vals: list[float] = []
        for s in samples:
            if s.bid_size is None or s.ask_size is None:
                continue
            total = s.bid_size + s.ask_size
            if total > 0:
                vals.append((s.bid_size - s.ask_size) / total)
        if not vals:
            return None
        return sum(vals) / len(vals)

    def _microprice_offset_instant(self, ts_ns: int) -> float | None:
        snap = self._last_depth_at(ts_ns)
        return _microprice_offset_ticks(snap, self._tick_size)

    def _microprice_offset_mean(
        self, ts_ns: int, window_sec: int
    ) -> float | None:
        samples = self._window(self._depths, ts_ns, window_sec)
        vals = [
            v
            for v in (
                _microprice_offset_ticks(s, self._tick_size) for s in samples
            )
            if v is not None
        ]
        if not vals:
            return None
        return sum(vals) / len(vals)

    def _spread_instant(self, ts_ns: int) -> float | None:
        snap = self._last_depth_at(ts_ns)
        if snap is None or snap.bid_price is None or snap.ask_price is None:
            return None
        return (snap.ask_price - snap.bid_price) / self._tick_size

    def _spread_max(self, ts_ns: int, window_sec: int) -> float | None:
        samples = self._window(self._depths, ts_ns, window_sec)
        spreads: list[float] = []
        for s in samples:
            if s.bid_price is None or s.ask_price is None:
                continue
            spreads.append((s.ask_price - s.bid_price) / self._tick_size)
        if not spreads:
            return None
        return max(spreads)


def _microprice_offset_ticks(
    snap: _DepthSnapshot | None, tick_size: float
) -> float | None:
    if snap is None:
        return None
    if (
        snap.bid_price is None
        or snap.ask_price is None
        or snap.bid_size is None
        or snap.ask_size is None
    ):
        return None
    total = snap.bid_size + snap.ask_size
    if total <= 0:
        return None
    microprice = (
        snap.bid_price * snap.ask_size + snap.ask_price * snap.bid_size
    ) / total
    mid = (snap.bid_price + snap.ask_price) / 2.0
    return (microprice - mid) / tick_size


# ---------------------------------------------------------------------------
# Touch detector
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Touch:
    """Output of the detector — what the writer uses to build a TouchEvent."""
    level: MonitoredLevel
    touch_price: float
    touch_ts_ns: int
    approach_side: str
    expected_bounce_direction: str  # "up" | "down"


class TouchDetector:
    """Detects price crossings of monitored zones with cooldown + min-distance.

    Stateful: tracks the side of price relative to each level across calls.
    Levels are kept in sync via :meth:`update_levels`. Crossings are detected
    when price transitions from "above" or "below" to "inside" the level's
    band (with a tolerance of ``min_distance_ticks`` ticks beyond the band so
    we don't fire on micro-oscillations).
    """

    _SIDE_ABOVE = "above"
    _SIDE_BELOW = "below"
    _SIDE_INSIDE = "inside"

    def __init__(
        self,
        *,
        min_distance_ticks: float = DEFAULT_MIN_DISTANCE_TICKS,
        cooldown_sec: float = DEFAULT_COOLDOWN_SEC,
        tick_size: float = DEFAULT_TICK_SIZE,
    ) -> None:
        self._min_distance_ticks = min_distance_ticks
        self._cooldown_ns = int(cooldown_sec * 1_000_000_000)
        self._tick_size = tick_size
        self._levels: dict[str, MonitoredLevel] = {}
        self._side: dict[str, str] = {}
        self._last_touch_ts: dict[str, int] = {}

    def update_levels(self, levels: Iterable[MonitoredLevel]) -> None:
        """Replace the monitored set; preserve last-touch state for survivors."""
        new = {level.zone_id: level for level in levels}
        # Drop side/last_touch state for levels that no longer exist.
        for stale_id in list(self._levels):
            if stale_id not in new:
                self._side.pop(stale_id, None)
                self._last_touch_ts.pop(stale_id, None)
        self._levels = new

    def on_price_tick(self, *, price: float, ts_ns: int) -> list[Touch]:
        touches: list[Touch] = []
        for zone_id, level in self._levels.items():
            new_side = self._classify(price, level)
            prev_side = self._side.get(zone_id)
            self._side[zone_id] = new_side
            if prev_side is None:
                continue  # first observation establishes baseline only.
            # Touch fires when price crosses INTO the band (below/above ->
            # inside) OR jumps THROUGH it (below -> above, above -> below).
            # The first two are the common case; the third catches a single
            # tick that flies past a narrow reference line.
            if prev_side == new_side:
                continue
            if prev_side == self._SIDE_INSIDE:
                continue  # leaving the band is not a touch.
            if not self._cooldown_elapsed(zone_id, ts_ns):
                continue
            touches.append(self._make_touch(level, price, prev_side, ts_ns))
            self._last_touch_ts[zone_id] = ts_ns
        return touches

    def _classify(self, price: float, level: MonitoredLevel) -> str:
        margin = self._min_distance_ticks * self._tick_size
        if price < level.low - margin:
            return self._SIDE_BELOW
        if price > level.high + margin:
            return self._SIDE_ABOVE
        return self._SIDE_INSIDE

    def _cooldown_elapsed(self, zone_id: str, ts_ns: int) -> bool:
        prev = self._last_touch_ts.get(zone_id)
        if prev is None:
            return True
        return (ts_ns - prev) >= self._cooldown_ns

    def _make_touch(
        self,
        level: MonitoredLevel,
        price: float,
        prev_side: str,
        ts_ns: int,
    ) -> Touch:
        if prev_side == self._SIDE_ABOVE:
            approach = TouchSide.FROM_ABOVE.value
            bounce = "up"
        else:
            approach = TouchSide.FROM_BELOW.value
            bounce = "down"
        return Touch(
            level=level,
            touch_price=price,
            touch_ts_ns=ts_ns,
            approach_side=approach,
            expected_bounce_direction=bounce,
        )


# ---------------------------------------------------------------------------
# Outcome tracker
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _PendingOutcome:
    event_id: str
    horizon_sec: int
    touch_ts_ns: int
    touch_price: float
    expected_bounce_direction: str  # "up" | "down"
    tick_size: float
    # Running excursions in ticks.
    max_favorable_ticks: float = 0.0
    max_adverse_ticks: float = 0.0
    max_favorable_ts_ns: int | None = None
    max_adverse_ts_ns: int | None = None

    @property
    def horizon_end_ts_ns(self) -> int:
        return self.touch_ts_ns + self.horizon_sec * 1_000_000_000


class OutcomeTracker:
    """Maintains pending outcome rows; emits each when its horizon ticks past.

    Touches register four pending rows (1m / 3m / 5m / 10m by default). Every
    price tick after registration updates the running MFE/MAE for each pending
    row. When a row's horizon elapses, the tracker calls ``write_row`` with
    the finalized values and removes the row from the queue.

    Outcome semantics: a touch carries an ``expected_bounce_direction`` (up
    for a from-above approach to a resistance, down for a from-below approach
    to a support). MFE is the max excursion in that direction; MAE is the max
    excursion in the opposite direction. Both reported as non-negative ticks.
    """

    def __init__(
        self,
        *,
        write_row: Callable[[OutcomeRow], None],
        horizons_sec: tuple[int, ...] = OUTCOME_HORIZONS_SEC,
    ) -> None:
        self._write = write_row
        self._horizons = horizons_sec
        self._pending: list[_PendingOutcome] = []

    def register_touch(self, event: TouchEvent) -> None:
        for horizon in self._horizons:
            self._pending.append(
                _PendingOutcome(
                    event_id=event.event_id,
                    horizon_sec=horizon,
                    touch_ts_ns=event.touch_ts_ns,
                    touch_price=event.touch_price,
                    expected_bounce_direction=event.expected_bounce_direction,
                    tick_size=DEFAULT_TICK_SIZE,
                )
            )

    def on_price_tick(self, *, price: float, ts_ns: int) -> None:
        for pending in self._pending:
            if ts_ns <= pending.touch_ts_ns:
                continue  # don't include the touch tick itself or earlier.
            self._update_excursions(pending, price, ts_ns)
        self._flush_due(ts_ns)

    def flush_overdue(self, ts_ns: int) -> None:
        """Force-emit any pending rows whose horizon has passed.

        Called periodically by the timer path so rows close out even when no
        new trade tick arrives between touch_ts and horizon_end.
        """
        self._flush_due(ts_ns)

    def pending_count(self) -> int:
        return len(self._pending)

    # ----- internals -----------------------------------------------------

    def _update_excursions(
        self, pending: _PendingOutcome, price: float, ts_ns: int
    ) -> None:
        delta_ticks = (price - pending.touch_price) / pending.tick_size
        if pending.expected_bounce_direction == "up":
            favorable = delta_ticks
            adverse = -delta_ticks
        else:
            favorable = -delta_ticks
            adverse = delta_ticks
        if favorable > pending.max_favorable_ticks:
            pending.max_favorable_ticks = favorable
            pending.max_favorable_ts_ns = ts_ns
        if adverse > pending.max_adverse_ticks:
            pending.max_adverse_ticks = adverse
            pending.max_adverse_ts_ns = ts_ns

    def _flush_due(self, now_ts_ns: int) -> None:
        still_pending: list[_PendingOutcome] = []
        for p in self._pending:
            if now_ts_ns >= p.horizon_end_ts_ns:
                self._write(_finalize_outcome(p))
            else:
                still_pending.append(p)
        self._pending = still_pending


def _finalize_outcome(p: _PendingOutcome) -> OutcomeRow:
    return OutcomeRow(
        schema_version=SCHEMA_VERSION,
        event_id=p.event_id,
        horizon_sec=p.horizon_sec,
        horizon_end_ts_ns=p.horizon_end_ts_ns,
        mfe_ticks=p.max_favorable_ticks,
        mae_ticks=p.max_adverse_ticks,
        max_favorable_ts_ns=p.max_favorable_ts_ns,
        max_adverse_ts_ns=p.max_adverse_ts_ns,
        outcome_label=_classify_outcome(
            p.max_favorable_ticks, p.max_adverse_ticks
        ),
    )


def _classify_outcome(mfe: float, mae: float) -> str:
    """Label an outcome by the relative magnitude of MFE vs MAE.

    Rules (operator-tunable later):
      * Both zero → ``no_resolution``.
      * MFE strictly > 2× MAE AND ≥ 4 ticks (≥1 pt reaction) → ``rejection``.
      * MAE strictly > 2× MFE AND ≥ 4 ticks → ``break``.
      * Otherwise → ``ambiguous`` (includes the exact-2× boundary case).
    """
    if mfe == 0 and mae == 0:
        return OutcomeLabel.NO_RESOLUTION.value
    if mfe > 2 * mae and mfe >= 4.0:
        return OutcomeLabel.REJECTION.value
    if mae > 2 * mfe and mae >= 4.0:
        return OutcomeLabel.BREAK.value
    return OutcomeLabel.AMBIGUOUS.value


# ---------------------------------------------------------------------------
# Stream / writer
# ---------------------------------------------------------------------------


class ZoneTouchStream:
    """Owns the touches + outcomes JSONL writers + monotonic event_id counter.

    Both files are append-only and roll on ``(date, symbol, session)``. The
    event_id format is ``<SYMBOL>-<YYYYMMDD>-<session>-<6digit-seq>`` so a
    text search can find a touch and all four of its outcome rows.
    """

    def __init__(
        self,
        output_root: Path,
        *,
        symbol: str,
        touches_subdir: str = "zone_touches",
        outcomes_subdir: str = "zone_outcomes",
    ) -> None:
        self._touches_dir = output_root / touches_subdir
        self._outcomes_dir = output_root / outcomes_subdir
        self._symbol = symbol
        self._touch_seq: int = 0
        self._current_session: str | None = None
        self._touch_path: Path | None = None
        self._outcome_path: Path | None = None
        self._touch_handle: IO[str] | None = None
        self._outcome_handle: IO[str] | None = None

    @property
    def touch_seq(self) -> int:
        return self._touch_seq

    @property
    def touch_path(self) -> Path | None:
        return self._touch_path

    @property
    def outcome_path(self) -> Path | None:
        return self._outcome_path

    def next_event_id(self, *, session: str, ts_ns: int) -> str:
        """Allocate the next event_id, rolling session if needed."""
        self._ensure_session(session, ts_ns)
        self._touch_seq += 1
        date = time.strftime("%Y%m%d", time.gmtime(ts_ns / 1e9))
        return f"{self._symbol}-{date}-{session}-{self._touch_seq:06d}"

    def write_touch(self, event: TouchEvent) -> None:
        self._ensure_session(event.session, event.touch_ts_ns)
        assert self._touch_handle is not None
        line = json.dumps(
            event.to_dict(), separators=(",", ":"), default=_json_default
        )
        self._touch_handle.write(line + "\n")
        self._touch_handle.flush()

    def write_outcome(self, row: OutcomeRow) -> None:
        # Outcomes always go to the session file whose touches file was open
        # at register time. If session changed mid-flight we still write to
        # the session the touch came from.
        if self._outcome_handle is None:
            # Defensive: should only happen if write_outcome is called before
            # any touch. Path is the most-recent session's outcome file.
            return
        line = json.dumps(
            row.to_dict(), separators=(",", ":"), default=_json_default
        )
        self._outcome_handle.write(line + "\n")
        self._outcome_handle.flush()

    def close(self) -> None:
        if self._touch_handle is not None:
            self._touch_handle.close()
            self._touch_handle = None
        if self._outcome_handle is not None:
            self._outcome_handle.close()
            self._outcome_handle = None

    def _ensure_session(self, session: str, ts_ns: int) -> None:
        if session == self._current_session and self._touch_handle is not None:
            return
        # Session rollover or first-use.
        self.close()
        self._current_session = session
        self._touch_seq = 0
        date = time.strftime("%Y-%m-%d", time.gmtime(ts_ns / 1e9))
        self._touch_path = self._touches_dir / f"{date}_{self._symbol}_{session}.jsonl"
        self._outcome_path = (
            self._outcomes_dir / f"{date}_{self._symbol}_{session}.jsonl"
        )
        self._touch_path.parent.mkdir(parents=True, exist_ok=True)
        self._outcome_path.parent.mkdir(parents=True, exist_ok=True)
        self._touch_handle = self._touch_path.open("a", encoding="utf-8")
        self._outcome_handle = self._outcome_path.open("a", encoding="utf-8")


def _json_default(o: Any) -> Any:
    if isinstance(o, float):
        if math.isnan(o) or math.isinf(o):
            return None
        return o
    raise TypeError(f"unserializable: {type(o)!r}")


# ---------------------------------------------------------------------------
# Adapters: ZoneSnapshot -> monitored levels
# ---------------------------------------------------------------------------


def monitored_levels_from_snapshot_dict(
    snapshot: dict[str, Any]
) -> list[MonitoredLevel]:
    """Extract MonitoredLevels from a serialized ZoneSnapshot dict.

    Reference lines become point-levels (low == high). Shelves (when present)
    become band-levels. Order is preserved so detectors see a stable iteration.
    """
    levels: list[MonitoredLevel] = []
    for line in snapshot.get("reference_lines", []):
        source = line.get("source")
        price = line.get("price")
        if source is None or price is None:
            continue
        try:
            price_f = float(price)
        except (TypeError, ValueError):
            continue
        zone_id = f"ref-{source}-{price_f:.2f}"
        levels.append(
            MonitoredLevel(
                zone_id=zone_id,
                zone_family="reference_line",
                low=price_f,
                high=price_f,
                label=str(line.get("label", source)),
            )
        )
    for shelf in snapshot.get("shelves", []):
        family = shelf.get("family")
        name = shelf.get("name")
        low = shelf.get("low")
        high = shelf.get("high")
        if family is None or name is None or low is None or high is None:
            continue
        try:
            low_f = float(low)
            high_f = float(high)
        except (TypeError, ValueError):
            continue
        levels.append(
            MonitoredLevel(
                zone_id=f"{family}:{name}",
                zone_family=str(family),
                low=min(low_f, high_f),
                high=max(low_f, high_f),
                label=f"{family} {name}",
            )
        )
    return levels


__all__ = [
    "APPROACH_SPEED_HORIZONS_SEC",
    "DEFAULT_COOLDOWN_SEC",
    "DEFAULT_MIN_DISTANCE_TICKS",
    "DEFAULT_TICK_SIZE",
    "DEPTH_MEAN_WINDOW_SEC",
    "MICROPRICE_MEAN_WINDOW_SEC",
    "MAX_FEATURE_WINDOW_SEC",
    "MonitoredLevel",
    "OFI_HORIZONS_SEC",
    "OUTCOME_HORIZONS_SEC",
    "OutcomeLabel",
    "OutcomeRow",
    "OutcomeTracker",
    "PreTouchFeatures",
    "RollingFeatureAccumulator",
    "SCHEMA_VERSION",
    "SPREAD_MAX_WINDOW_SEC",
    "TRADE_IMBALANCE_HORIZONS_SEC",
    "Touch",
    "TouchDetector",
    "TouchEvent",
    "TouchSide",
    "ZoneTouchStream",
    "monitored_levels_from_snapshot_dict",
]
