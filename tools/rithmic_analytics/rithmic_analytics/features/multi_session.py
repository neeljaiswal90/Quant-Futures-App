"""Multi-session VP aggregator — find HVN clusters that persist across days.

Operational use: given N most-recent session VPs (each computed by
:func:`rithmic_analytics.features.volume_profile.compute_vp`), find price
levels where HVNs appear in **≥ structural_threshold** of those N sessions.
Those are institutional accumulation zones: levels the market repeatedly
returns to and trades heavily, across many days.

Clustering rule: two HVNs at prices ``p1, p2`` from different sessions belong
to the same cluster if ``|p1 - p2| <= cluster_tolerance_pts``. The cluster's
``multi_session_count`` is the number of *distinct sessions* contributing
(deduped — two HVNs from the same session at adjacent bins count as one
session).

A cluster reaching the ``structural_threshold`` is tagged ``conviction =
"STRUCTURAL"``. Lower-count clusters carry their natural conviction (no
upgrade).

Example::

    >>> from rithmic_analytics.features.volume_profile import compute_vp
    >>> from rithmic_analytics.features.multi_session import aggregate_multi_session
    >>> session_vps = [
    ...     ("mnq-2026-05-13-rth", compute_vp(trades_day1, MNQ)),
    ...     ("mnq-2026-05-14-rth", compute_vp(trades_day2, MNQ)),
    ...     ("mnq-2026-05-15-rth", compute_vp(trades_day3, MNQ)),
    ... ]
    >>> multi = aggregate_multi_session(session_vps, structural_threshold=3)
    >>> structural = [h for h in multi.hvns if h.conviction == "STRUCTURAL"]
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from rithmic_analytics.features.volume_profile import VolumeProfile


@dataclass(frozen=True, slots=True)
class MultiSessionHVN:
    """An HVN cluster spanning one or more sessions.

    Attributes:
        price_low: Lower edge of the cluster's price band.
        price_high: Upper edge of the cluster's price band.
        center: Volume-weighted mean of member-HVN prices.
        member_sessions: Distinct session IDs contributing to this cluster.
        multi_session_count: ``len(member_sessions)``.
        conviction: ``"STRUCTURAL"`` if count >= threshold; else
            ``"PERSISTENT"`` (2+ sessions) or ``"SINGLE"`` (1 session).
        total_volume: Sum of HVN volumes across all member sessions.
    """

    price_low: float
    price_high: float
    center: float
    member_sessions: list[str]
    multi_session_count: int
    conviction: str
    total_volume: int


@dataclass(frozen=True, slots=True)
class MultiSessionVP:
    """Result of :func:`aggregate_multi_session`."""

    sessions_used: list[str]
    rolling_window: int
    hvns: list[MultiSessionHVN] = field(default_factory=list)
    aggregate_vpoc: float = math.nan
    aggregate_vah: float = math.nan
    aggregate_val: float = math.nan


def aggregate_multi_session(
    session_vps: list[tuple[str, VolumeProfile]],
    *,
    structural_threshold: int = 3,
    cluster_tolerance_pts: float = 5.0,
    top_n: int = 8,
) -> MultiSessionVP:
    """Aggregate per-session VPs into a rolling multi-session profile.

    Args:
        session_vps: List of ``(session_id, VolumeProfile)`` tuples, one per
            session. Order doesn't matter; ``sessions_used`` preserves input
            order in the result.
        structural_threshold: Number of distinct sessions an HVN cluster must
            appear in to be tagged STRUCTURAL. Default 3 (matches the v2
            backlog: "≥3 of 5 days").
        cluster_tolerance_pts: Max price distance between HVN centers for
            them to be considered the same cluster. Default 5.0 points
            (= 1 bin at MNQ's default 20-tick bin size).
        top_n: Return at most this many top HVN clusters (sorted by count
            then total volume desc). Default 8.

    Returns:
        ``MultiSessionVP`` with ``hvns`` sorted by descending
        ``multi_session_count`` then descending ``total_volume``. Aggregate
        VPOC/VAH/VAL are mean of session-level values (skipping NaN).
        Empty input yields empty result with NaN aggregates.

    Example:
        >>> multi = aggregate_multi_session(session_vps, structural_threshold=3)
        >>> for h in multi.hvns:
        ...     print(h.center, h.multi_session_count, h.conviction)
    """
    sessions_used = [sid for sid, _ in session_vps]
    if not session_vps:
        return MultiSessionVP(sessions_used=[], rolling_window=0)

    # ---- Aggregate scalars: mean of finite per-session values ----
    finite_vpoc = [vp.vpoc for _, vp in session_vps if not math.isnan(vp.vpoc)]
    finite_vah = [vp.vah for _, vp in session_vps if not math.isnan(vp.vah)]
    finite_val = [vp.val for _, vp in session_vps if not math.isnan(vp.val)]
    agg_vpoc = sum(finite_vpoc) / len(finite_vpoc) if finite_vpoc else math.nan
    agg_vah = sum(finite_vah) / len(finite_vah) if finite_vah else math.nan
    agg_val = sum(finite_val) / len(finite_val) if finite_val else math.nan

    # ---- Cluster HVNs across sessions ----
    # Flatten: (session_id, price_low, price_high, volume) tuples.
    flat: list[tuple[str, float, float, int]] = []
    for sid, vp in session_vps:
        for h in vp.hvn_list:
            flat.append((sid, float(h.price_low), float(h.price_high), int(h.volume)))

    # Greedy clustering: sort by price, scan, merge adjacent within tolerance.
    flat.sort(key=lambda t: t[1])

    @dataclass
    class _ClusterAccum:
        center: float
        # Each member tuple: (session_id, price_low, price_high, volume, mid)
        members: list[tuple[str, float, float, int, float]] = field(default_factory=list)

    clusters: list[_ClusterAccum] = []
    for sid, plo, phi, vol in flat:
        mid = (plo + phi) / 2
        merged = False
        for cl in clusters:
            if abs(mid - cl.center) <= cluster_tolerance_pts:
                cl.members.append((sid, plo, phi, vol, mid))
                merged = True
                break
        if not merged:
            clusters.append(_ClusterAccum(center=mid, members=[(sid, plo, phi, vol, mid)]))

    # ---- Per-cluster: dedup sessions, compute conviction, build dataclass ----
    hvns: list[MultiSessionHVN] = []
    for cl in clusters:
        members = cl.members
        sessions_in_cluster = list({m[0] for m in members})
        total_vol = sum(m[3] for m in members)
        # Volume-weighted center (more stable than midpoint as cluster widens)
        wcenter = (
            sum(m[4] * m[3] for m in members) / total_vol if total_vol > 0 else cl.center
        )
        lo = min(m[1] for m in members)
        hi = max(m[2] for m in members)

        count = len(sessions_in_cluster)
        if count >= structural_threshold:
            conviction = "STRUCTURAL"
        elif count >= 2:
            conviction = "PERSISTENT"
        else:
            conviction = "SINGLE"

        hvns.append(
            MultiSessionHVN(
                price_low=lo,
                price_high=hi,
                center=wcenter,
                member_sessions=sorted(sessions_in_cluster),
                multi_session_count=count,
                conviction=conviction,
                total_volume=total_vol,
            )
        )

    # Sort by multi_session_count desc, then total_volume desc
    hvns.sort(key=lambda h: (-h.multi_session_count, -h.total_volume))
    hvns = hvns[:top_n]

    return MultiSessionVP(
        sessions_used=sessions_used,
        rolling_window=len(session_vps),
        hvns=hvns,
        aggregate_vpoc=agg_vpoc,
        aggregate_vah=agg_vah,
        aggregate_val=agg_val,
    )
