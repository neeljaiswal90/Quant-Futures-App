"""RA-112e Phase 1 — append-only as-of zone-snapshot stream.

Persists every material change to the live zone state under
``data/zone_snapshots/<date>_<symbol>_<session>.jsonl`` so future research can
replay exactly the boundary state the trader saw at any moment. This is the
research-grade artifact; the dated ``daily_zones.json`` remains an end-of-day
chart convenience.

Schema is forward-compatible with v3 VWAP-anchored shelves (RA-112f, step 4):
``shelves`` and ``cap_bind_flags`` ship as empty containers in step 1 and get
populated when the shelf computation lands.

Decoupled in two layers:
  * :class:`SnapshotPolicy` — pure decide-emit logic. Fully unit-testable
    without disk I/O.
  * :class:`ZoneSnapshotStream` — owns disk I/O + monotonic sequence numbers
    + session rollover.

Locked operator defaults (2026-06-01):
    boundary_threshold_ticks=2, anchor_threshold_ticks=2, heartbeat_sec=30,
    min_emit_interval_sec=1, force_emit_on_touch=True.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import math
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, IO

# Operator-locked defaults (2026-06-01).
DEFAULT_BOUNDARY_THRESHOLD_TICKS: float = 2.0
DEFAULT_ANCHOR_THRESHOLD_TICKS: float = 2.0
DEFAULT_HEARTBEAT_SEC: float = 30.0
DEFAULT_MIN_EMIT_INTERVAL_SEC: float = 1.0
DEFAULT_TICK_SIZE: float = 0.25  # MNQ

SCHEMA_VERSION: int = 1


class EmitReason(str, Enum):
    SESSION_OPEN = "session_open"
    SESSION_CHANGE = "session_change"
    MATERIAL_CHANGE = "material_change"
    HEARTBEAT = "heartbeat"
    TOUCH_FORCED = "touch_forced"
    METHOD_VERSION_CHANGE = "method_version_change"
    PARAMS_HASH_CHANGE = "params_hash_change"
    CAP_BIND_CHANGE = "cap_bind_change"
    ANCHOR_VALUE_STATE_CHANGE = "anchor_value_state_change"
    BOUND_SOURCE_CHANGE = "bound_source_change"


class AnchorVsValueState(str, Enum):
    ABOVE = "above_value"
    INSIDE = "inside_value"
    BELOW = "below_value"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class TacticalAnchor:
    """The rolling tactical anchor (initially the 60-min VWAP)."""
    method: str  # "vwap_w_60m"; "ewma" / "session_anchored" reserved for variants.
    value: float
    window_start_ts_ns: int
    window_end_ts_ns: int


@dataclass(frozen=True, slots=True)
class SessionAnchors:
    """Full-session structural levels (the gold-line family)."""
    vah: float | None
    val: float | None
    vpoc: float | None
    atr_14_5m: float | None
    atr_14_60m: float | None
    atr_cap: float | None


@dataclass(frozen=True, slots=True)
class ReferenceLine:
    """A single horizontal reference level on the chart."""
    source: str
    price: float
    label: str


@dataclass(frozen=True, slots=True)
class Shelf:
    """A σ supply/demand shelf. Empty in step 1; populated in RA-112f step 4.

    ``family`` distinguishes shadow-mode coexistence:
      * ``sigma_v3_vwap_anchor`` — production v3 (post-fix).
      * ``sigma_v2_session_value_anchor`` — legacy v2 retained for comparison.
    """
    family: str
    name: str           # "SUP_1" / "DEM_2" / etc.
    low: float
    high: float
    tier: int           # 1, 2, 3
    bound_source: str   # "estimator" | "atr_cap"
    cap_bound: bool
    overlaps_vah: bool
    overlaps_val: bool
    nearest_structural_level: str | None
    distance_to_structural_level_ticks: float | None


@dataclass(frozen=True, slots=True)
class ZoneSnapshotParams:
    """All tunables that affect zone computation. Hashed -> params_hash.

    Conservative: any change to any field invalidates the snapshot series and
    forces a ``params_hash_change`` emit. Easier to narrow later if too noisy.
    """
    vwap_window_minutes: int
    cap_atr_fraction: float
    va_pct: float
    atr_period: int
    atr_bar_size_min_bin: int    # bar size used by VP bin sizing (RA-039).
    atr_bar_size_min_cap: int    # bar size used for the σ-zone ATR cap (RA-112b).
    bin_size_ticks: int
    bin_size_mode: str
    tick_size: float = DEFAULT_TICK_SIZE

    def hash(self) -> str:
        canonical = json.dumps(
            dataclasses.asdict(self), sort_keys=True, separators=(",", ":")
        )
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return f"sha256:{digest}"


@dataclass(frozen=True, slots=True)
class ZoneSnapshot:
    """Immutable as-of zone state. One record per emit on the JSONL stream."""
    schema_version: int
    zone_snapshot_seq: int
    as_of_ts_ns: int
    input_cutoff_ts_ns: int
    emit_reason: str
    symbol: str
    session: str
    method_versions: dict[str, str]
    params_hash: str
    session_anchors: SessionAnchors
    tactical_anchor: TacticalAnchor | None
    rolling_anchor_vs_session_value: str
    rolling_anchor_distance_ticks: float
    shelves: tuple[Shelf, ...]
    reference_lines: tuple[ReferenceLine, ...]
    cap_bind_flags: dict[str, bool]
    bound_source: dict[str, str]

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


@dataclass(frozen=True, slots=True)
class PolicyConfig:
    boundary_threshold_ticks: float = DEFAULT_BOUNDARY_THRESHOLD_TICKS
    anchor_threshold_ticks: float = DEFAULT_ANCHOR_THRESHOLD_TICKS
    heartbeat_sec: float = DEFAULT_HEARTBEAT_SEC
    min_emit_interval_sec: float = DEFAULT_MIN_EMIT_INTERVAL_SEC
    tick_size: float = DEFAULT_TICK_SIZE


@dataclass(frozen=True, slots=True)
class EmitDecision:
    should_emit: bool
    reason: str


class SnapshotPolicy:
    """Pure decide-emit logic. No I/O, no state beyond config."""

    def __init__(self, config: PolicyConfig | None = None):
        self._config = config or PolicyConfig()

    @property
    def config(self) -> PolicyConfig:
        return self._config

    def decide(
        self, prev: ZoneSnapshot | None, candidate: ZoneSnapshot
    ) -> EmitDecision:
        """Return (should_emit, reason) for the candidate vs the prev emit.

        The first call in a session (prev=None) always emits ``session_open``.
        Otherwise the highest-priority change reason wins; if no change is
        detected, returns ``no_change``. Throttling applies only when there
        IS a reason — a quiet stretch with no change just stays silent until
        the heartbeat fires.
        """
        if prev is None:
            return EmitDecision(True, EmitReason.SESSION_OPEN.value)

        reason = self._detect_reason(prev, candidate)
        if reason is None:
            return EmitDecision(False, "no_change")

        elapsed_sec = (candidate.as_of_ts_ns - prev.as_of_ts_ns) / 1e9
        # Clock-rewind safety: emit so the regression is visible in the stream.
        if elapsed_sec < 0:
            return EmitDecision(True, EmitReason.MATERIAL_CHANGE.value)

        if elapsed_sec < self._config.min_emit_interval_sec:
            # touch_forced reaches here only via force_emit, which bypasses
            # this method. Anything else under the throttle waits.
            return EmitDecision(False, "throttled")

        return EmitDecision(True, reason)

    def _detect_reason(
        self, prev: ZoneSnapshot, cand: ZoneSnapshot
    ) -> str | None:
        """Highest-priority change reason, or None if nothing material changed."""
        if cand.session != prev.session:
            return EmitReason.SESSION_CHANGE.value
        if cand.method_versions != prev.method_versions:
            return EmitReason.METHOD_VERSION_CHANGE.value
        if cand.params_hash != prev.params_hash:
            return EmitReason.PARAMS_HASH_CHANGE.value
        if (
            cand.rolling_anchor_vs_session_value
            != prev.rolling_anchor_vs_session_value
        ):
            return EmitReason.ANCHOR_VALUE_STATE_CHANGE.value
        if cand.cap_bind_flags != prev.cap_bind_flags:
            return EmitReason.CAP_BIND_CHANGE.value
        if cand.bound_source != prev.bound_source:
            return EmitReason.BOUND_SOURCE_CHANGE.value

        # Continuous-value thresholds (in ticks).
        if (
            self._anchor_delta_ticks(prev, cand)
            >= self._config.anchor_threshold_ticks
        ):
            return EmitReason.MATERIAL_CHANGE.value
        if (
            self._max_shelf_boundary_delta_ticks(prev, cand)
            >= self._config.boundary_threshold_ticks
        ):
            return EmitReason.MATERIAL_CHANGE.value
        if (
            self._max_reference_line_delta_ticks(prev, cand)
            >= self._config.boundary_threshold_ticks
        ):
            return EmitReason.MATERIAL_CHANGE.value

        # Heartbeat only if nothing else changed AND enough wall-clock elapsed.
        elapsed_sec = (cand.as_of_ts_ns - prev.as_of_ts_ns) / 1e9
        if elapsed_sec >= self._config.heartbeat_sec:
            return EmitReason.HEARTBEAT.value

        return None

    def _anchor_delta_ticks(
        self, prev: ZoneSnapshot, cand: ZoneSnapshot
    ) -> float:
        if prev.tactical_anchor is None and cand.tactical_anchor is None:
            return 0.0
        if prev.tactical_anchor is None or cand.tactical_anchor is None:
            return math.inf  # known -> unknown (or vice versa) is material.
        delta = abs(cand.tactical_anchor.value - prev.tactical_anchor.value)
        return delta / self._config.tick_size

    def _max_shelf_boundary_delta_ticks(
        self, prev: ZoneSnapshot, cand: ZoneSnapshot
    ) -> float:
        # Index by (family, name); shelf order is not stable.
        prev_idx = {(s.family, s.name): s for s in prev.shelves}
        cand_idx = {(s.family, s.name): s for s in cand.shelves}
        if prev_idx.keys() != cand_idx.keys():
            return math.inf  # any add/remove is material.
        max_delta = 0.0
        for key in cand_idx:
            p, c = prev_idx[key], cand_idx[key]
            d_low = abs(c.low - p.low) / self._config.tick_size
            d_high = abs(c.high - p.high) / self._config.tick_size
            if d_low > max_delta:
                max_delta = d_low
            if d_high > max_delta:
                max_delta = d_high
        return max_delta

    def _max_reference_line_delta_ticks(
        self, prev: ZoneSnapshot, cand: ZoneSnapshot
    ) -> float:
        prev_idx = {line.source: line for line in prev.reference_lines}
        cand_idx = {line.source: line for line in cand.reference_lines}
        if prev_idx.keys() != cand_idx.keys():
            return math.inf
        max_delta = 0.0
        for src in cand_idx:
            d = abs(cand_idx[src].price - prev_idx[src].price)
            d_ticks = d / self._config.tick_size
            if d_ticks > max_delta:
                max_delta = d_ticks
        return max_delta


class ZoneSnapshotStream:
    """Owns the JSONL writer + monotonic sequence numbers + session rollover.

    Thread-safety: callers must serialize ``maybe_emit`` / ``force_emit``
    invocations. The watcher's compute thread does this naturally.
    """

    def __init__(
        self,
        output_dir: Path,
        *,
        symbol: str,
        policy: SnapshotPolicy | None = None,
        clock: Callable[[], int] = time.time_ns,
    ):
        self._output_dir = output_dir
        self._symbol = symbol
        self._policy = policy or SnapshotPolicy()
        self._clock = clock
        self._prev_snapshot: ZoneSnapshot | None = None
        self._seq: int = 0
        self._current_session: str | None = None
        self._current_path: Path | None = None
        self._file_handle: IO[str] | None = None

    @property
    def policy(self) -> SnapshotPolicy:
        return self._policy

    @property
    def current_seq(self) -> int:
        return self._seq

    @property
    def current_path(self) -> Path | None:
        return self._current_path

    def maybe_emit(self, candidate: ZoneSnapshot) -> EmitDecision:
        """Apply the policy; emit if material. Returns the decision."""
        if candidate.session != self._current_session:
            # Session rollover always emits a fresh session_open record and
            # resets the per-session sequence counter.
            self._rollover_session(candidate.session)
            return self._emit(
                candidate, reason_override=EmitReason.SESSION_OPEN.value
            )

        decision = self._policy.decide(self._prev_snapshot, candidate)
        if not decision.should_emit:
            return decision
        return self._emit(candidate, reason_override=decision.reason)

    def force_emit(
        self,
        candidate: ZoneSnapshot,
        *,
        reason: str = EmitReason.TOUCH_FORCED.value,
    ) -> EmitDecision:
        """Bypass the policy and emit unconditionally. Touch logger entry point."""
        if candidate.session != self._current_session:
            self._rollover_session(candidate.session)
        return self._emit(candidate, reason_override=reason)

    def close(self) -> None:
        if self._file_handle is not None:
            self._file_handle.close()
            self._file_handle = None

    def _rollover_session(self, new_session: str) -> None:
        self.close()
        self._current_session = new_session
        self._seq = 0
        self._prev_snapshot = None

    def _ensure_file(self, session: str, as_of_ts_ns: int) -> None:
        if self._file_handle is not None:
            return
        # Trading-date in UTC keeps the file boundary aligned with
        # ``daily_zones.json``. The session name keeps globex/rth separate
        # even when they share a UTC date.
        date = time.strftime("%Y-%m-%d", time.gmtime(as_of_ts_ns / 1e9))
        filename = f"{date}_{self._symbol}_{session}.jsonl"
        path = self._output_dir / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        self._current_path = path
        # Append mode preserves history across restarts.
        self._file_handle = path.open("a", encoding="utf-8")

    def _emit(
        self, candidate: ZoneSnapshot, *, reason_override: str
    ) -> EmitDecision:
        self._seq += 1
        stamped = dataclasses.replace(
            candidate,
            zone_snapshot_seq=self._seq,
            emit_reason=reason_override,
            schema_version=SCHEMA_VERSION,
        )
        self._ensure_file(stamped.session, stamped.as_of_ts_ns)
        assert self._file_handle is not None
        line = json.dumps(
            stamped.to_dict(), separators=(",", ":"), default=_json_default
        )
        self._file_handle.write(line + "\n")
        self._file_handle.flush()
        self._prev_snapshot = stamped
        return EmitDecision(True, reason_override)


def _json_default(o: Any) -> Any:
    """JSON encoder fallback. Treats NaN/Inf as null per JSON strictness."""
    if isinstance(o, float):
        if math.isnan(o) or math.isinf(o):
            return None
        return o
    raise TypeError(f"unserializable: {type(o)!r}")


def classify_rolling_anchor_vs_value(
    anchor_value: float | None,
    *,
    vah: float | None,
    val: float | None,
    tick_size: float = DEFAULT_TICK_SIZE,
) -> tuple[str, float]:
    """Classify rolling-anchor position vs the full-session value area.

    Returns ``(state_label, distance_ticks_from_nearest_value_boundary)``.
    The distance is always non-negative; sign is implicit in the state label.
    Inside-value collapses to distance 0.
    """
    if anchor_value is None or vah is None or val is None:
        return AnchorVsValueState.UNKNOWN.value, 0.0
    if anchor_value > vah:
        return AnchorVsValueState.ABOVE.value, (anchor_value - vah) / tick_size
    if anchor_value < val:
        return AnchorVsValueState.BELOW.value, (val - anchor_value) / tick_size
    return AnchorVsValueState.INSIDE.value, 0.0


__all__ = [
    "AnchorVsValueState",
    "DEFAULT_ANCHOR_THRESHOLD_TICKS",
    "DEFAULT_BOUNDARY_THRESHOLD_TICKS",
    "DEFAULT_HEARTBEAT_SEC",
    "DEFAULT_MIN_EMIT_INTERVAL_SEC",
    "DEFAULT_TICK_SIZE",
    "EmitDecision",
    "EmitReason",
    "PolicyConfig",
    "ReferenceLine",
    "SCHEMA_VERSION",
    "SessionAnchors",
    "Shelf",
    "SnapshotPolicy",
    "TacticalAnchor",
    "ZoneSnapshot",
    "ZoneSnapshotParams",
    "ZoneSnapshotStream",
    "classify_rolling_anchor_vs_value",
]
