"""RA-108 persistent-levels detector.

Aggregates evidence across the existing live-signal families (iceberg,
absorption, sweep) to identify structural price levels that have been
defended over the session. Emits ``PersistentLevelPayload`` events when
a level's evidence crosses promotion thresholds, transitions between
active and deteriorating, or expires.

Scope (v1):
    - Tracks levels per ``(snapped_price, side)`` pair.
    - Observes iceberg, absorption, sweep payloads. Each contributes
      typed evidence via :class:`EvidenceSource`.
    - Promotion to high/medium/low confidence based on evidence type
      diversity, observation count, and time-spanning.
    - Active → deteriorating transition when no new evidence for the
      configured window.

Out of scope (deferred to follow-up tickets per the RA-108 dispatch):
    - Resting-size evidence source (depth-frame tracking)
    - Broken status detection (requires price-through-with-volume
      tracking; operators currently see it visually on the chart)
    - Multi-day persistence across session boundaries

Read-only on upstream detectors — RA-059 (iceberg), RA-015 (absorption),
RA-090a (sweep) are untouched. This module consumes their emitted
payloads.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from contracts.realtime.events import (
    AbsorptionPayload,
    Confidence,
    IcebergPayload,
    PersistentLevelEvidence,
    PersistentLevelPayload,
    SweepPayload,
)

EvidenceSourceName = Literal[
    "resting_size",
    "iceberg_refill",
    "absorption",
    "sweep_anchor",
]

DEFAULT_TICK_SIZE = 0.25
DEFAULT_MIN_PERSISTENCE_SECONDS = 60.0
DEFAULT_DETERIORATE_AFTER_SECONDS = 300.0

# Promotion thresholds. Tuned conservatively for ~5-30 levels per RTH
# session at typical MNQ data volume; operator can tune via constructor.
DEFAULT_HIGH_MIN_DISTINCT_SOURCES = 3
DEFAULT_HIGH_MIN_SAME_SOURCE_COUNT = 5
DEFAULT_HIGH_MIN_SAME_SOURCE_SPAN_SECONDS = 300.0
DEFAULT_HIGH_MIN_ICEBERG_REFILLS = 4

DEFAULT_MEDIUM_MIN_DISTINCT_SOURCES = 2
DEFAULT_MEDIUM_MIN_OBSERVATIONS = 3
DEFAULT_MEDIUM_MIN_SPAN_SECONDS = 180.0

DEFAULT_LOW_MIN_OBSERVATIONS = 2
DEFAULT_LOW_MIN_SPAN_SECONDS = 60.0

LevelStatus = Literal["active", "deteriorating", "broken"]
LevelSide = Literal["bid", "ask", "unknown"]


@dataclass
class EvidenceSource:
    """Running aggregates for one evidence source at one level."""

    count: int = 0
    first_seen_ts_ns: int = 0
    last_seen_ts_ns: int = 0
    cumulative_size: float = 0.0

    def observe(self, ts_ns: int, size: float) -> None:
        if self.count == 0:
            self.first_seen_ts_ns = ts_ns
        self.count += 1
        self.last_seen_ts_ns = ts_ns
        self.cumulative_size += max(0.0, size)


@dataclass
class LevelState:
    """Internal per-level memory tracking all evidence sources."""

    level_id: str
    price: float
    side: LevelSide
    first_seen_ts_ns: int
    last_active_ts_ns: int
    evidence: dict[EvidenceSourceName, EvidenceSource] = field(default_factory=dict)
    last_emitted_confidence: Confidence | None = None
    last_emitted_status: LevelStatus = "active"

    def record(
        self,
        source: EvidenceSourceName,
        ts_ns: int,
        size: float,
    ) -> None:
        entry = self.evidence.get(source)
        if entry is None:
            entry = EvidenceSource()
            self.evidence[source] = entry
        entry.observe(ts_ns, size)
        if ts_ns > self.last_active_ts_ns:
            self.last_active_ts_ns = ts_ns

    def observations_total(self) -> int:
        return sum(entry.count for entry in self.evidence.values())

    def distinct_sources(self) -> int:
        return sum(1 for entry in self.evidence.values() if entry.count > 0)

    def overall_span_seconds(self) -> float:
        if not self.evidence:
            return 0.0
        first = min(
            entry.first_seen_ts_ns for entry in self.evidence.values() if entry.count > 0
        )
        last = max(
            entry.last_seen_ts_ns for entry in self.evidence.values() if entry.count > 0
        )
        return max(0.0, (last - first) / 1_000_000_000)

    def evidence_payload(self) -> list[PersistentLevelEvidence]:
        rows: list[PersistentLevelEvidence] = []
        for source_name, entry in sorted(self.evidence.items()):
            if entry.count == 0:
                continue
            rows.append(
                PersistentLevelEvidence(
                    source=source_name,
                    count=entry.count,
                    last_seen_ts_ns=entry.last_seen_ts_ns,
                    cumulative_size=entry.cumulative_size,
                )
            )
        return rows


@dataclass
class PersistentLevelConfig:
    """Tunable promotion thresholds + lifecycle windows."""

    tick_size: float = DEFAULT_TICK_SIZE
    min_persistence_seconds: float = DEFAULT_MIN_PERSISTENCE_SECONDS
    deteriorate_after_seconds: float = DEFAULT_DETERIORATE_AFTER_SECONDS

    high_min_distinct_sources: int = DEFAULT_HIGH_MIN_DISTINCT_SOURCES
    high_min_same_source_count: int = DEFAULT_HIGH_MIN_SAME_SOURCE_COUNT
    high_min_same_source_span_seconds: float = DEFAULT_HIGH_MIN_SAME_SOURCE_SPAN_SECONDS
    high_min_iceberg_refills: int = DEFAULT_HIGH_MIN_ICEBERG_REFILLS

    medium_min_distinct_sources: int = DEFAULT_MEDIUM_MIN_DISTINCT_SOURCES
    medium_min_observations: int = DEFAULT_MEDIUM_MIN_OBSERVATIONS
    medium_min_span_seconds: float = DEFAULT_MEDIUM_MIN_SPAN_SECONDS

    low_min_observations: int = DEFAULT_LOW_MIN_OBSERVATIONS
    low_min_span_seconds: float = DEFAULT_LOW_MIN_SPAN_SECONDS


def _snap_price(price: float, tick_size: float) -> float:
    if tick_size <= 0:
        return price
    return round(round(price / tick_size) * tick_size, 6)


def _level_id(price: float, side: LevelSide) -> str:
    return f"{price:.4f}_{side}"


def _classify_side(side_hint: str | None) -> LevelSide:
    """Map upstream-detector side strings to our LevelSide enum."""
    if side_hint is None:
        return "unknown"
    lowered = side_hint.lower()
    if "bid" in lowered or "buy" in lowered or "long" in lowered:
        return "bid"
    if "ask" in lowered or "sell" in lowered or "short" in lowered:
        return "ask"
    if "down" in lowered:
        return "ask"  # sweep down = sellers absorbing buys (ceiling held weakly)
    if "up" in lowered:
        return "bid"
    return "unknown"


class PersistentLevelDetector:
    """Aggregates evidence across signal families; emits persistent-level events."""

    def __init__(self, config: PersistentLevelConfig | None = None) -> None:
        self._config = config or PersistentLevelConfig()
        self._levels: dict[str, LevelState] = {}

    # -- observation entry points ---------------------------------------------

    def observe_iceberg(
        self,
        payload: IcebergPayload,
        ts_ns: int,
    ) -> PersistentLevelPayload | None:
        side = _classify_side(payload.side)
        price = _snap_price(payload.price, self._config.tick_size)
        level = self._ensure_level(price=price, side=side, ts_ns=ts_ns)
        # IcebergPayload.refills is the running refill count for this iceberg
        # detection chain; treat each detection as adding `refills` to the
        # iceberg_refill source's count (so a 5-refill iceberg counts as 5).
        refill_count = max(1, int(payload.refills or 1))
        size = float(payload.total_consumed or 0)
        for _ in range(refill_count):
            level.record("iceberg_refill", ts_ns, size / refill_count)
        return self._maybe_emit(level, ts_ns)

    def observe_absorption(
        self,
        payload: AbsorptionPayload,
        ts_ns: int,
    ) -> PersistentLevelPayload | None:
        side = _classify_side(payload.side)
        price = _snap_price(payload.price, self._config.tick_size)
        level = self._ensure_level(price=price, side=side, ts_ns=ts_ns)
        # AbsorptionPayload.score is in [0, 1]; map to a cumulative-size
        # weight so high-score absorptions weigh more than low-score ones.
        size_weight = max(1.0, float(payload.score or 0) * 100.0)
        level.record("absorption", ts_ns, size_weight)
        return self._maybe_emit(level, ts_ns)

    def observe_sweep(
        self,
        payload: SweepPayload,
        ts_ns: int,
    ) -> PersistentLevelPayload | None:
        # SweepPayload.direction = "up" | "down" — the side this sweep
        # broke INTO. A sweep "up" broke through an ask-side ceiling
        # (so that level was previously defending). A sweep "down" broke
        # a bid-side floor. We anchor evidence to the level that HELD until
        # the sweep, because that's what the operator should care about.
        side: LevelSide = "ask" if payload.direction == "up" else "bid"
        price = _snap_price(float(payload.price), self._config.tick_size)
        level = self._ensure_level(price=price, side=side, ts_ns=ts_ns)
        # ticks_cleared is a proxy for sweep intensity / commitment size.
        size_weight = max(1.0, float(payload.ticks_cleared or 0) * 5.0)
        level.record("sweep_anchor", ts_ns, size_weight)
        return self._maybe_emit(level, ts_ns)

    def tick(self, now_ts_ns: int) -> list[PersistentLevelPayload]:
        """Run periodic lifecycle checks; emit any deteriorating transitions."""
        emissions: list[PersistentLevelPayload] = []
        deteriorate_ns = int(self._config.deteriorate_after_seconds * 1_000_000_000)
        for level in self._levels.values():
            if level.last_emitted_confidence is None:
                continue
            if (
                level.last_emitted_status == "active"
                and now_ts_ns - level.last_active_ts_ns >= deteriorate_ns
            ):
                level.last_emitted_status = "deteriorating"
                emissions.append(self._build_payload(level, now_ts_ns))
        return emissions

    def clear(self) -> None:
        """Reset session state (called on session boundary rollover)."""
        self._levels.clear()

    # -- testing accessors ----------------------------------------------------

    def levels_for_test(self) -> dict[str, LevelState]:
        return dict(self._levels)

    # -- R12.1 snapshot exposure --------------------------------------------
    def active_levels_for_snapshot(self, now_ts_ns: int) -> list[PersistentLevelPayload]:
        """R12.1: emit all currently-active levels as PersistentLevelPayloads.

        Used by the snapshot builder so cold-start clients see the composite
        S/D zones immediately (vs waiting for the next emission window).
        Skips levels that haven't reached promotion thresholds (no confidence
        assigned yet) and "broken" levels per the existing lifecycle rules.
        """
        out: list[PersistentLevelPayload] = []
        for level in self._levels.values():
            confidence = self._classify_confidence(level)
            if confidence is None:
                continue
            status = self._status_for(level, now_ts_ns)
            if status == "broken":
                continue
            persistence = max(0.0, (now_ts_ns - level.first_seen_ts_ns) / 1_000_000_000)
            out.append(
                PersistentLevelPayload(
                    level_id=level.level_id,
                    price=level.price,
                    side=level.side,
                    persistence_seconds=persistence,
                    confidence=confidence,
                    evidence=level.evidence_payload(),
                    last_active_ts_ns=level.last_active_ts_ns,
                    status=status,
                )
            )
        # Sort by composite "strength": confidence weight + observation count.
        weight = {"high": 3, "medium": 2, "low": 1}
        out.sort(
            key=lambda p: (weight.get(p.confidence, 0), len(p.evidence)),
            reverse=True,
        )
        return out

    # -- internals ------------------------------------------------------------

    def _ensure_level(
        self,
        *,
        price: float,
        side: LevelSide,
        ts_ns: int,
    ) -> LevelState:
        level_id = _level_id(price, side)
        existing = self._levels.get(level_id)
        if existing is not None:
            return existing
        state = LevelState(
            level_id=level_id,
            price=price,
            side=side,
            first_seen_ts_ns=ts_ns,
            last_active_ts_ns=ts_ns,
        )
        self._levels[level_id] = state
        return state

    def _classify_confidence(self, level: LevelState) -> Confidence | None:
        config = self._config

        # HIGH gate: any of three sufficient signals.
        if level.distinct_sources() >= config.high_min_distinct_sources:
            return "high"
        for source_name, entry in level.evidence.items():
            if (
                entry.count >= config.high_min_same_source_count
                and (entry.last_seen_ts_ns - entry.first_seen_ts_ns) / 1_000_000_000
                >= config.high_min_same_source_span_seconds
            ):
                return "high"
            if (
                source_name == "iceberg_refill"
                and entry.count >= config.high_min_iceberg_refills
            ):
                return "high"

        # MEDIUM gate.
        if (
            level.distinct_sources() >= config.medium_min_distinct_sources
            or (
                level.observations_total() >= config.medium_min_observations
                and level.overall_span_seconds() >= config.medium_min_span_seconds
            )
        ):
            return "medium"

        # LOW gate.
        if (
            level.observations_total() >= config.low_min_observations
            and level.overall_span_seconds() >= config.low_min_span_seconds
        ):
            return "low"

        return None

    def _maybe_emit(
        self,
        level: LevelState,
        now_ts_ns: int,
    ) -> PersistentLevelPayload | None:
        confidence = self._classify_confidence(level)
        if confidence is None:
            return None
        if level.last_emitted_confidence == confidence and level.last_emitted_status == "active":
            # Same tier, still active — no need to re-emit on every observation.
            return None
        level.last_emitted_confidence = confidence
        level.last_emitted_status = "active"
        return self._build_payload(level, now_ts_ns)

    def _build_payload(
        self,
        level: LevelState,
        now_ts_ns: int,
    ) -> PersistentLevelPayload:
        persistence_seconds = max(
            0.0, (now_ts_ns - level.first_seen_ts_ns) / 1_000_000_000
        )
        return PersistentLevelPayload(
            level_id=level.level_id,
            price=level.price,
            side=level.side,
            persistence_seconds=persistence_seconds,
            confidence=level.last_emitted_confidence or "low",
            evidence=level.evidence_payload(),
            last_active_ts_ns=level.last_active_ts_ns,
            status=level.last_emitted_status,
        )


__all__ = [
    "EvidenceSource",
    "EvidenceSourceName",
    "LevelSide",
    "LevelState",
    "LevelStatus",
    "PersistentLevelConfig",
    "PersistentLevelDetector",
]
