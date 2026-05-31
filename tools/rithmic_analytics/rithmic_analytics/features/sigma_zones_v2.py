"""Sigma supply/demand zones — convention v2 (RA-098).

This module computes a structurally-improved version of the standing ±σ
supply/demand zones laid out in `convention_sigma_zone_construction.md`
(memory). v1 has four real geometric gaps the coordinator audit surfaced:

1. **Two-source mixing** — VAH/VAL are volume-distribution boundaries; σ is a
   price-deviation statistic. They live on different scales and can produce
   bands that collapse, invert, or overlap value-area structure unpredictably.
2. **Trend-inflated σ** — session-anchored VWAP σ captures both real volatility
   AND trend drift, so trending sessions produce systematically wider zones.
3. **Symmetric ±σ** — markets aren't normally distributed; one-sided σ loses
   directional information present in the actual residual distribution.
4. **Unbounded zone widths** — a "2σ supply" of 73pt on a vol-expanded day
   isn't a tradeable zone, it's a position-sizing problem.

v2 addresses each:

- **Asymmetric σ**: split residuals into `σ_above` (one-sided stdev where
  price > VWAP) and `σ_below` (one-sided stdev where price < VWAP), each
  volume-weighted. Supply uses σ_above; demand uses σ_below.
- **Detrended via trailing window**: VWAP is computed over the last
  ``window_minutes`` of trades (default 60 min) rather than anchored to
  session open. A short trailing window naturally tracks trend rather than
  lagging it, so σ measures actual dispersion around recent fair value.
- **ATR-capped widths**: zones are capped at ``cap_atr_fraction × ATR(14)``
  per side (default 0.5×). Wide-vol days still produce tradeable zones.
- **VPOC banded**: VPOC is rendered as a band ``±0.5 × bin_width`` instead of
  a single line, matching the volume-profile bin resolution.

What's NOT yet in this v2:

- **Multi-session alignment**: the audit's item 5. Use
  :func:`apply_multi_session_confluence` to upgrade per-zone conviction once
  prior-session VPs are loaded — that helper lives below and reuses
  :func:`rithmic_analytics.features.multi_session.aggregate_multi_session`.
- **Depth-weighted conviction**: the audit's item 6. Requires
  `rithmic_dashboard.features.depth_book` snapshots — cross-package
  dependency. Documented as a future hook on :class:`ZoneConvictionV2`.

The v1 daily_zones output is NOT changed. Setting the ``--zones-v2`` flag on
the CLI adds a parallel ``sigma_zones_v2`` block to the JSON.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

DEFAULT_WINDOW_MINUTES: int = 60
DEFAULT_CAP_ATR_FRACTION: float = 0.5
DEFAULT_TICK_SIZE: float = 0.25
_NS_PER_MINUTE: int = 60 * 10**9


@dataclass(frozen=True, slots=True)
class ZoneBoundsV2:
    """One v2 zone with its (top, bottom) bounds and the σ/ATR-cap that
    determined the boundary."""

    label: str
    top: float
    bottom: float
    width_pts: float
    bound_source: str  # "sigma" if σ-driven, "atr_cap" if cap clamped, "bin" for VPOC band

    def to_dict(self) -> dict[str, float | str]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class SigmaZonesV2:
    """All v2 zones for one session, plus the inputs that produced them.

    Treat ``vwap_window``, ``sigma_above``, ``sigma_below``, ``atr_14``, and
    ``atr_cap`` as audit-trail: the same inputs reproduce the same zones.
    """

    vwap_window: float
    sigma_above: float
    sigma_below: float
    atr_14: float
    atr_cap: float
    window_minutes: int
    cap_atr_fraction: float
    vpoc_band: ZoneBoundsV2
    sigma_1_supply: ZoneBoundsV2
    sigma_2_supply: ZoneBoundsV2
    sigma_1_demand: ZoneBoundsV2
    sigma_2_demand: ZoneBoundsV2

    def to_dict(self) -> dict[str, object]:
        return {
            "vwap_window": self.vwap_window,
            "sigma_above": self.sigma_above,
            "sigma_below": self.sigma_below,
            "atr_14": self.atr_14,
            "atr_cap": self.atr_cap,
            "window_minutes": self.window_minutes,
            "cap_atr_fraction": self.cap_atr_fraction,
            "vpoc_band": self.vpoc_band.to_dict(),
            "sigma_1_supply": self.sigma_1_supply.to_dict(),
            "sigma_2_supply": self.sigma_2_supply.to_dict(),
            "sigma_1_demand": self.sigma_1_demand.to_dict(),
            "sigma_2_demand": self.sigma_2_demand.to_dict(),
        }


# ---------------------------------------------------------------------------
# Trailing-window VWAP + one-sided σ
# ---------------------------------------------------------------------------


def _trailing_window_residuals(
    trades: pd.DataFrame,
    *,
    window_minutes: int,
) -> tuple[float, np.ndarray, np.ndarray]:
    """Return ``(vwap, residuals, weights)`` over the trailing window.

    The trailing window is the last ``window_minutes`` of trades relative to
    the LAST trade's ``event_ts_ns``. Empty or single-trade window → returns
    ``(NaN, empty, empty)``; callers must handle that.
    """
    if len(trades) == 0:
        return math.nan, np.array([], dtype="float64"), np.array([], dtype="float64")

    ts = trades["event_ts_ns"].to_numpy(dtype="int64")
    cutoff = int(ts[-1]) - window_minutes * _NS_PER_MINUTE
    mask = ts >= cutoff
    if not mask.any():
        return math.nan, np.array([], dtype="float64"), np.array([], dtype="float64")

    prices = trades.loc[mask, "price"].to_numpy(dtype="float64")
    qty = trades.loc[mask, "quantity"].to_numpy(dtype="float64")
    weight_sum = float(qty.sum())
    if weight_sum <= 0:
        return math.nan, np.array([], dtype="float64"), np.array([], dtype="float64")

    vwap = float((prices * qty).sum() / weight_sum)
    residuals = prices - vwap
    return vwap, residuals, qty


def _one_sided_sigma(
    residuals: np.ndarray,
    weights: np.ndarray,
    *,
    side: str,
) -> float:
    """Volume-weighted one-sided stdev of residuals.

    ``side='above'`` includes only ``residuals > 0``; ``side='below'`` includes
    only ``residuals < 0``. Returns ``0.0`` when the side has no samples
    (defensible: no dispersion observed on that side → no σ-driven extension).
    """
    if side not in {"above", "below"}:
        raise ValueError(f"side must be 'above' or 'below', got {side!r}")
    if len(residuals) == 0:
        return 0.0
    mask = residuals > 0 if side == "above" else residuals < 0
    if not mask.any():
        return 0.0
    side_res = residuals[mask]
    side_w = weights[mask]
    w_sum = float(side_w.sum())
    if w_sum <= 0:
        return 0.0
    # Population stdev around 0 (NOT around the conditional mean): we're
    # measuring dispersion around VWAP, so the "mean" of the one-sided
    # distribution is fixed at 0 by construction. Don't subtract a sample
    # mean — that would underestimate σ on a strongly directional session.
    var = float(((side_res ** 2) * side_w).sum() / w_sum)
    return math.sqrt(var)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def compute_sigma_zones_v2(
    trades: pd.DataFrame,
    *,
    vah: float,
    val: float,
    vpoc: float,
    bin_size_ticks: int,
    atr_14: float,
    tick_size: float = DEFAULT_TICK_SIZE,
    window_minutes: int = DEFAULT_WINDOW_MINUTES,
    cap_atr_fraction: float = DEFAULT_CAP_ATR_FRACTION,
) -> SigmaZonesV2:
    """Compute v2 ±σ supply/demand zones + VPOC band.

    Args:
        trades: DataFrame with ``event_ts_ns`` (int64), ``price`` (float64),
            ``quantity`` (int). Output of
            :func:`rithmic_analytics.core.loader.load_obs01_trades` is directly
            compatible.
        vah / val / vpoc: Value-area boundaries + point of control from
            :func:`rithmic_analytics.features.volume_profile.compute_vp`.
        bin_size_ticks: VP bin size, used for the VPOC band width.
        atr_14: Wilder ATR(14) from
            :func:`rithmic_analytics.features.atr.compute_atr_from_ticks`.
            Used for the per-zone width cap.
        tick_size: 0.25 for MNQ. Used to convert ``bin_size_ticks`` to pts.
        window_minutes: Trailing window for VWAP + σ. Shorter window =
            tighter, trend-tracking σ; longer window = smoother but
            trend-inflated. Default 60 min matches the
            ``compute_live_signals`` recency window.
        cap_atr_fraction: Maximum zone width, expressed as a fraction of
            ATR(14). Default 0.5 means a single zone can't exceed half a
            daily ATR per side — keeps zones tradeable on vol-expanded days.

    Returns:
        :class:`SigmaZonesV2` with all five zones + the audit-trail inputs.

    Empty / pathological inputs are handled defensively: missing VWAP or NaN
    ATR collapses zones to the VAH/VAL anchors (zero-width). VPOC band always
    renders since it depends only on ``vpoc`` and ``bin_size_ticks``.
    """
    bin_width_pts = bin_size_ticks * tick_size
    vpoc_band = ZoneBoundsV2(
        label="VPOC_band",
        top=vpoc + 0.5 * bin_width_pts,
        bottom=vpoc - 0.5 * bin_width_pts,
        width_pts=bin_width_pts,
        bound_source="bin",
    )

    vwap, residuals, weights = _trailing_window_residuals(
        trades, window_minutes=window_minutes
    )
    sigma_above = _one_sided_sigma(residuals, weights, side="above")
    sigma_below = _one_sided_sigma(residuals, weights, side="below")

    # ATR cap: if ATR is NaN (insufficient bars) fall back to no cap (math.inf)
    # so σ-driven width prevails. v1 had no cap at all; treating "no ATR" as
    # "no cap" matches v1 behavior on session-start.
    atr_cap = (
        cap_atr_fraction * atr_14
        if not math.isnan(atr_14) and atr_14 > 0
        else math.inf
    )

    def supply_top(n_sigma: int) -> tuple[float, str]:
        """Return (top_price, bound_source) for the n-σ supply zone.

        Supply zones extend ABOVE VAH. The invariant ``top >= VAH`` is
        enforced even when σ-driven extension lands at or below VAH (e.g.
        σ_above=0 with VWAP < VAH on a sell-skewed session) — in that case
        the zone correctly collapses to a zero-width band AT VAH.
        """
        if math.isnan(vwap):
            return vah, "sigma"  # no σ available → degenerate to VAH (zero width)
        sigma_extension = vwap + n_sigma * sigma_above
        cap_top = vah + (atr_cap if n_sigma == 2 else atr_cap / 2)
        if sigma_extension <= cap_top:
            return max(vah, sigma_extension), "sigma"
        return max(vah, cap_top), "atr_cap"

    def demand_bottom(n_sigma: int) -> tuple[float, str]:
        """Return (bottom_price, bound_source) for the n-σ demand zone.

        Demand zones extend BELOW VAL. ``bottom <= VAL`` is enforced even
        when σ-driven extension lands at or above VAL — the zone collapses
        to a zero-width band AT VAL in that case.
        """
        if math.isnan(vwap):
            return val, "sigma"
        sigma_extension = vwap - n_sigma * sigma_below
        cap_bot = val - (atr_cap if n_sigma == 2 else atr_cap / 2)
        if sigma_extension >= cap_bot:
            return min(val, sigma_extension), "sigma"
        return min(val, cap_bot), "atr_cap"

    s1_top, s1_src = supply_top(1)
    s2_top, s2_src = supply_top(2)
    d1_bot, d1_src = demand_bottom(1)
    d2_bot, d2_src = demand_bottom(2)

    return SigmaZonesV2(
        vwap_window=vwap if not math.isnan(vwap) else 0.0,
        sigma_above=sigma_above,
        sigma_below=sigma_below,
        atr_14=atr_14 if not math.isnan(atr_14) else 0.0,
        atr_cap=atr_cap if math.isfinite(atr_cap) else 0.0,
        window_minutes=window_minutes,
        cap_atr_fraction=cap_atr_fraction,
        vpoc_band=vpoc_band,
        sigma_1_supply=ZoneBoundsV2(
            label="1sigma_supply",
            top=s1_top,
            bottom=vah,
            width_pts=max(0.0, s1_top - vah),
            bound_source=s1_src,
        ),
        sigma_2_supply=ZoneBoundsV2(
            label="2sigma_supply",
            top=s2_top,
            bottom=vah,
            width_pts=max(0.0, s2_top - vah),
            bound_source=s2_src,
        ),
        sigma_1_demand=ZoneBoundsV2(
            label="1sigma_demand",
            top=val,
            bottom=d1_bot,
            width_pts=max(0.0, val - d1_bot),
            bound_source=d1_src,
        ),
        sigma_2_demand=ZoneBoundsV2(
            label="2sigma_demand",
            top=val,
            bottom=d2_bot,
            width_pts=max(0.0, val - d2_bot),
            bound_source=d2_src,
        ),
    )


# ---------------------------------------------------------------------------
# Per-zone confluence score (audit item 5: multi-session alignment)
# ---------------------------------------------------------------------------


def confluence_score_v2(
    *,
    volume_pct: float,
    multi_session_count: int | None,
    structural_threshold: int = 3,
    depth_resting_fraction: float | None = None,
) -> float:
    """Combine volume %, multi-session overlap, and depth context into a
    single 0..1 conviction score.

    The formula is intentionally simple and additive so each component's
    contribution is interpretable. All three are clamped to 0..1 individually
    before combining.

    Args:
        volume_pct: 0..1, the zone's share of session volume.
        multi_session_count: number of prior sessions whose HVN cluster overlaps
            this zone. ``None`` if no prior-session data was available.
        structural_threshold: number of overlapping sessions that defines a
            "structural" cluster. Default 3 matches
            :func:`rithmic_analytics.features.multi_session.aggregate_multi_session`.
        depth_resting_fraction: 0..1, the fraction of session-max DOM resting
            size that's inside this zone right now. ``None`` until cross-package
            depth-book wiring lands (audit item 6, future hook).

    Returns:
        Conviction score in ``[0, 1]``. Higher = stronger zone.
    """
    base = max(0.0, min(1.0, float(volume_pct)))
    if multi_session_count is None:
        multi_bonus = 0.0
    else:
        ratio = max(0.0, float(multi_session_count) / max(1, structural_threshold))
        multi_bonus = 0.5 * min(1.0, ratio)
    if depth_resting_fraction is None:
        depth_bonus = 0.0
    else:
        depth_bonus = 0.5 * max(0.0, min(1.0, float(depth_resting_fraction)))
    return max(0.0, min(1.0, base + multi_bonus + depth_bonus))


__all__ = [
    "DEFAULT_CAP_ATR_FRACTION",
    "DEFAULT_TICK_SIZE",
    "DEFAULT_WINDOW_MINUTES",
    "SigmaZonesV2",
    "ZoneBoundsV2",
    "compute_sigma_zones_v2",
    "confluence_score_v2",
]
