"""RA-112e step 8 — methodology health accumulator.

Tracks rolling rates over the last ``window_seconds`` of v3 shelf compute
passes so the dashboard can render a small diagnostics panel showing whether
the methodology is behaving as intended. The metrics here are exactly the
ones the audit reviewer asked for in 2026-06-01:

* **cap-bind rate** — fraction of recent v3 shelves bound by ATR_cap (vs the
  σ/quantile estimator). Always-1.0 means the cap dominates the geometry
  (the bug RA-112b fixed). Always-0.0 means the cap never bites.
* **shelf-cross-anchor rate** — should be 0 for v3 by construction. Non-zero
  is a regression. v2 legacy is reported too so the reviewer sees the fix.
* **anchor-vs-value distribution** — share of recent snapshots in each
  auction state (above/inside/below). Tells the operator which regime has
  been dominant.
* **warmup share** — share of recent snapshots with tactical_status="warmup".
* **estimator width divergence** — mean SUP_1 width delta between v3
  quantile and v3 RMS — the diagnostic that adjudicates step-6 estimator
  choice over time.

The accumulator is in-memory only. Persistence + cross-session analysis
should consume the on-disk zone_snapshot stream (a future ticket).
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Iterable

DEFAULT_WINDOW_SECONDS: int = 600  # rolling 10-minute window


@dataclass(slots=True)
class _Observation:
    """Compact projection of one ZoneSnapshot pass for rolling rate compute.

    Storing the full snapshot would balloon memory; we keep just the fields
    the metrics consume.
    """
    ts_ns: int
    emitted: bool
    auction_state: str
    tactical_status: str | None
    # Per-shelf summaries indexed by "<family>:<name>" — keys match cap_bind_flags.
    cap_bind: dict[str, bool]
    shelf_lows: dict[str, float]
    shelf_highs: dict[str, float]
    anchor: float | None


class MethodologyHealthAccumulator:
    """Rolling accumulator. Append observations on every compute pass; pull
    metrics() on demand for broadcast or `/snapshot`.

    Thread-safety: the caller is expected to serialize observe/metrics; the
    realtime backend's compute loop already does this naturally.
    """

    def __init__(
        self,
        *,
        window_seconds: int = DEFAULT_WINDOW_SECONDS,
        clock: Callable[[], int] = time.time_ns,
    ) -> None:
        self._window_ns = window_seconds * 1_000_000_000
        self._clock = clock
        self._obs: deque[_Observation] = deque()

    @property
    def window_seconds(self) -> int:
        return self._window_ns // 1_000_000_000

    def observe(
        self,
        *,
        ts_ns: int,
        emitted: bool,
        auction_state: str,
        tactical_status: str | None,
        shelves: Iterable[dict[str, Any]],
        cap_bind_flags: dict[str, bool] | None,
        anchor: float | None,
    ) -> None:
        cap_bind: dict[str, bool] = dict(cap_bind_flags or {})
        lows: dict[str, float] = {}
        highs: dict[str, float] = {}
        for s in shelves:
            family = s.get("family")
            name = s.get("name")
            low = s.get("low")
            high = s.get("high")
            if family is None or name is None or low is None or high is None:
                continue
            key = f"{family}:{name}"
            try:
                lows[key] = float(low)
                highs[key] = float(high)
            except (TypeError, ValueError):
                continue
        self._obs.append(
            _Observation(
                ts_ns=ts_ns,
                emitted=emitted,
                auction_state=auction_state,
                tactical_status=tactical_status,
                cap_bind=cap_bind,
                shelf_lows=lows,
                shelf_highs=highs,
                anchor=anchor,
            )
        )
        self._prune(ts_ns)

    def metrics(self, now_ts_ns: int | None = None) -> dict[str, Any]:
        ts_ns = self._clock() if now_ts_ns is None else now_ts_ns
        self._prune(ts_ns)
        total = len(self._obs)
        if total == 0:
            return {
                "window_seconds": self.window_seconds,
                "observation_count": 0,
                "emit_count": 0,
                "emit_rate_per_minute": 0.0,
                "v3_cap_bind_rate": None,
                "v3_quantile_cap_bind_rate": None,
                "v3_shelf_cross_anchor_failure_rate": 0.0,
                "v2_shelf_cross_anchor_failure_rate": 0.0,
                "anchor_vs_value_distribution": {
                    "above_value": 0.0, "inside_value": 0.0,
                    "below_value": 0.0, "unknown": 0.0,
                },
                "warmup_share": 0.0,
                "estimator_width_divergence_sup_1_ticks": None,
            }
        emit_count = sum(1 for o in self._obs if o.emitted)
        elapsed_min = max(self._window_ns, 1) / 1e9 / 60.0
        return {
            "window_seconds": self.window_seconds,
            "observation_count": total,
            "emit_count": emit_count,
            "emit_rate_per_minute": emit_count / elapsed_min,
            "v3_cap_bind_rate": self._cap_bind_rate("sigma_v3_vwap_anchor:"),
            "v3_quantile_cap_bind_rate": self._cap_bind_rate(
                "sigma_v3_vwap_anchor_quantile:"
            ),
            "v3_shelf_cross_anchor_failure_rate": self._cross_anchor_rate(
                "sigma_v3_vwap_anchor"
            ),
            "v2_shelf_cross_anchor_failure_rate": self._cross_anchor_rate(
                "sigma_v2_session_value_anchor"
            ),
            "anchor_vs_value_distribution": self._anchor_state_distribution(),
            "warmup_share": self._warmup_share(),
            "estimator_width_divergence_sup_1_ticks": (
                self._estimator_width_divergence_ticks("SUP_1")
            ),
        }

    # ----- internals -----------------------------------------------------

    def _prune(self, now_ts_ns: int) -> None:
        cutoff = now_ts_ns - self._window_ns
        while self._obs and self._obs[0].ts_ns < cutoff:
            self._obs.popleft()

    def _cap_bind_rate(self, family_prefix: str) -> float | None:
        """Mean cap_bound flag value across all shelves whose id starts with
        the given family prefix, averaged across observations."""
        total = 0
        bound = 0
        for o in self._obs:
            for shelf_id, is_bound in o.cap_bind.items():
                if shelf_id.startswith(family_prefix):
                    total += 1
                    if is_bound:
                        bound += 1
        return None if total == 0 else bound / total

    def _cross_anchor_rate(self, family: str) -> float:
        """Fraction of observations where the family's SUP_1.low != anchor
        OR DEM_1.high != anchor. v3 should be 0 by construction; v2 legacy
        is commonly degenerate (collapsed to VAH/VAL)."""
        relevant = 0
        failures = 0
        for o in self._obs:
            if o.anchor is None:
                continue
            sup_low = o.shelf_lows.get(f"{family}:SUP_1")
            dem_high = o.shelf_highs.get(f"{family}:DEM_1")
            if sup_low is None and dem_high is None:
                continue
            relevant += 1
            # For v3 the anchor IS SUP_1.low / DEM_1.high. For v2 we apply
            # the same check; the v2 anchor is VAH/VAL and the math hasn't
            # been re-anchored, so failures here surface the v2 pathology
            # exactly as the audit reviewer described.
            if sup_low is not None and abs(sup_low - o.anchor) > 1e-6:
                failures += 1
                continue
            if dem_high is not None and abs(dem_high - o.anchor) > 1e-6:
                failures += 1
        return 0.0 if relevant == 0 else failures / relevant

    def _anchor_state_distribution(self) -> dict[str, float]:
        counts = {"above_value": 0, "inside_value": 0, "below_value": 0, "unknown": 0}
        for o in self._obs:
            key = o.auction_state if o.auction_state in counts else "unknown"
            counts[key] += 1
        total = sum(counts.values()) or 1
        return {k: v / total for k, v in counts.items()}

    def _warmup_share(self) -> float:
        if not self._obs:
            return 0.0
        return sum(1 for o in self._obs if o.tactical_status == "warmup") / len(self._obs)

    def _estimator_width_divergence_ticks(
        self, tier_name: str, tick_size: float = 0.25
    ) -> float | None:
        """Mean (quantile_width - RMS_width) in ticks for the given tier.

        Positive = quantile shelves are wider; negative = RMS shelves are wider.
        Returns None when no observation has both families' tier present.
        """
        rms_family = "sigma_v3_vwap_anchor"
        q_family = "sigma_v3_vwap_anchor_quantile"
        deltas: list[float] = []
        for o in self._obs:
            rms_low = o.shelf_lows.get(f"{rms_family}:{tier_name}")
            rms_high = o.shelf_highs.get(f"{rms_family}:{tier_name}")
            q_low = o.shelf_lows.get(f"{q_family}:{tier_name}")
            q_high = o.shelf_highs.get(f"{q_family}:{tier_name}")
            if rms_low is None or rms_high is None or q_low is None or q_high is None:
                continue
            rms_width = abs(rms_high - rms_low)
            q_width = abs(q_high - q_low)
            deltas.append((q_width - rms_width) / tick_size)
        if not deltas:
            return None
        return sum(deltas) / len(deltas)


__all__ = ["DEFAULT_WINDOW_SECONDS", "MethodologyHealthAccumulator"]
