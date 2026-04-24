"""
cvd.py — DATA-15 native CVD and trade-flow fields (v3.1 Phase 2).

Cumulative Volume Delta (CVD) computed from Databento trade records
(TradeMsg kind in the DATA-09 provider stream). Native, not synthetic:
every update comes from a real aggressor-tagged trade. DATA-15 lives
on the Databento historical/replay path and does not alter runtime
authority. DATA-16 is where orderflow-state promotion is negotiated.

Fields published on the sidecar snapshot (via CvdAccumulator.snapshot()):

    cvd_session        lifetime cumulative signed volume since session start
    cvd_delta_250ms    signed volume delta over the last 250 ms window
    cvd_delta_1s       1 s window
    cvd_delta_3s       3 s window
    cvd_delta_10s      10 s window
    cvd_delta_30s      30 s window

Aggressor sign convention:
    side == 'buy'  / 'B' / 'A' (aggressor lifts offer) →  +size
    side == 'sell' / 'S'       (aggressor hits bid)    →  -size
    unknown / 'N'                                       →  0 (no CVD update,
                                                            trade_count still
                                                            increments)

Session boundaries (v3.1 §1.3 requires resets at session edges):
    reset_session(now_ns) — clears lifetime cumulative and all rolling
    windows. Rolling windows reset to the new session's t0, so an old
    trade cannot contribute to the post-reset 30s window.

Timebase:
    All timestamps are nanoseconds since epoch. Rolling windows are
    evaluated at apply-time (the sidecar calls `apply(trade_ts_ns, ...)`
    per record) and at snapshot-time (caller supplies `now_ns`).
    snapshot() evicts expired entries from the rolling buffer before
    reporting, so a long quiet interval produces a 0-delta window
    rather than a stale non-zero value.

Performance:
    Single deque of (ts_ns, signed_size) tuples. Eviction is O(k) per
    call where k is the number of entries older than the longest
    window (30s). For the expected live trade rate on MNQ/MES this is
    negligible; if a dense-flow symbol stresses it, a ring buffer can
    drop in without changing the public API.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Optional

# Window durations in nanoseconds. Kept as module constants so tests
# and snapshot rendering both read the exact same values.
_NS_PER_MS = 1_000_000
_NS_PER_SEC = 1_000_000_000

CVD_WINDOWS_NS: dict[str, int] = {
    "250ms": 250 * _NS_PER_MS,
    "1s":   1   * _NS_PER_SEC,
    "3s":   3   * _NS_PER_SEC,
    "10s":  10  * _NS_PER_SEC,
    "30s":  30  * _NS_PER_SEC,
}

# Longest window; governs deque-eviction horizon.
_MAX_WINDOW_NS = max(CVD_WINDOWS_NS.values())


def _signed_size_from_side(side: object, size: object) -> int:
    """
    Map a trade record's side + size into a signed CVD contribution.

    Buy-aggressor (+size) — 'buy' | 'B' | 'A' (Databento MBO frequently
    tags ask-side activity as the aggressor on a lift-offer).
    Sell-aggressor (-size) — 'sell' | 'S'.
    Anything else — 0 (no CVD update). None-aggressor trades still
    count as trades (the caller increments trade_count separately).

    Returns 0 on malformed size (non-int or non-positive).
    """
    if not isinstance(size, int) or size <= 0:
        return 0
    s = str(side).strip().lower() if side is not None else ""
    if s in ("buy", "b", "a"):
        return size
    if s in ("sell", "s"):
        return -size
    return 0


@dataclass(frozen=True)
class CvdSnapshot:
    """Frozen point-in-time CVD view. Consumers embed the dict shape
    via asdict() when publishing to snapshot/health endpoints."""
    cvd_session: int
    cvd_delta_250ms: int
    cvd_delta_1s: int
    cvd_delta_3s: int
    cvd_delta_10s: int
    cvd_delta_30s: int
    # Audit metadata
    trade_count: int
    last_trade_ts_ns: Optional[int]
    session_start_ts_ns: Optional[int]


class CvdAccumulator:
    """
    Single-instrument CVD accumulator. For multi-symbol subscriptions,
    hold one CvdAccumulator per instrument_id (matches the
    OrderBookKernel registry pattern from DATA-11).

    All methods are single-writer from the record-dispatch coroutine;
    no locking required.
    """

    def __init__(self, session_start_ts_ns: Optional[int] = None) -> None:
        self._session_cvd: int = 0
        self._trade_count: int = 0
        self._last_trade_ts_ns: Optional[int] = None
        self._session_start_ts_ns: Optional[int] = session_start_ts_ns
        # Rolling buffer of (ts_ns, signed_size) tuples, oldest-first.
        self._buf: deque[tuple[int, int]] = deque()

    # ─── Apply ──────────────────────────────────────────────────────────────

    def apply(self, ts_ns: Optional[int], side: object, size: object) -> None:
        """
        Apply one trade. ts_ns is the record's ts_recv_ns (preferred)
        or ts_event_ns. Malformed ts or size is counted as a trade but
        does not mutate CVD.
        """
        # Count every trade the sidecar saw, even if the CVD contribution
        # is zero — downstream telemetry is interested in both.
        self._trade_count += 1

        signed = _signed_size_from_side(side, size)
        if signed == 0:
            return
        if not isinstance(ts_ns, int) or ts_ns <= 0:
            return

        self._session_cvd += signed
        self._last_trade_ts_ns = ts_ns
        self._buf.append((ts_ns, signed))
        # Cheap eviction: drop entries older than the longest window
        # relative to this trade's ts. Keeps the deque bounded in
        # steady state.
        cutoff = ts_ns - _MAX_WINDOW_NS
        while self._buf and self._buf[0][0] < cutoff:
            self._buf.popleft()

    # ─── Session boundary ───────────────────────────────────────────────────

    def reset_session(self, now_ns: Optional[int]) -> None:
        """
        Reset lifetime CVD and all rolling windows at a session edge.
        v3.1 §1.3 requires session resets; DATA-15 honors that so the
        post-reset 30s window cannot include trades from the previous
        session.
        """
        self._session_cvd = 0
        self._trade_count = 0
        self._last_trade_ts_ns = None
        self._session_start_ts_ns = now_ns if isinstance(now_ns, int) and now_ns > 0 else None
        self._buf.clear()

    # ─── Snapshot ───────────────────────────────────────────────────────────

    def snapshot(self, now_ns: Optional[int] = None) -> CvdSnapshot:
        """
        Compute windowed deltas as of `now_ns`. When `now_ns` is None,
        uses the last observed trade ts (or 0 when no trades). Evicts
        expired entries as a side effect so a long quiet interval
        produces 0-delta windows rather than stale non-zero values.
        """
        if isinstance(now_ns, int) and now_ns > 0:
            t = now_ns
        elif self._last_trade_ts_ns is not None:
            t = self._last_trade_ts_ns
        else:
            # No data yet: all deltas are 0, session cumulative is 0.
            return CvdSnapshot(
                cvd_session=0,
                cvd_delta_250ms=0, cvd_delta_1s=0, cvd_delta_3s=0,
                cvd_delta_10s=0, cvd_delta_30s=0,
                trade_count=self._trade_count,
                last_trade_ts_ns=None,
                session_start_ts_ns=self._session_start_ts_ns,
            )

        # Evict entries older than the longest window relative to `t`
        # before summing, so a reported snapshot never includes stale
        # entries even if apply() hasn't been called recently.
        cutoff = t - _MAX_WINDOW_NS
        while self._buf and self._buf[0][0] < cutoff:
            self._buf.popleft()

        # One pass, tracking which windows each entry still falls in.
        sums: dict[str, int] = {k: 0 for k in CVD_WINDOWS_NS}
        for ts_ns, signed in self._buf:
            age = t - ts_ns
            for name, window_ns in CVD_WINDOWS_NS.items():
                if age <= window_ns:
                    sums[name] += signed

        return CvdSnapshot(
            cvd_session=self._session_cvd,
            cvd_delta_250ms=sums["250ms"],
            cvd_delta_1s=sums["1s"],
            cvd_delta_3s=sums["3s"],
            cvd_delta_10s=sums["10s"],
            cvd_delta_30s=sums["30s"],
            trade_count=self._trade_count,
            last_trade_ts_ns=self._last_trade_ts_ns,
            session_start_ts_ns=self._session_start_ts_ns,
        )

    # ─── Debug / read API ───────────────────────────────────────────────────

    @property
    def session_cvd(self) -> int:
        return self._session_cvd

    @property
    def trade_count(self) -> int:
        return self._trade_count

    @property
    def buffer_size(self) -> int:
        return len(self._buf)
