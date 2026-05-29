"""Volume Profile compute: POC / VAH / VAL / HVN / LVN.

Bin convention: prices are bucketed by ``bin_low = floor(price / bin_size) * bin_size``,
so the bin labeled 27380 covers ``[27380, 27380 + bin_size)``. VPOC, VAL, and HVN
prices are reported as bin lows (multiples of bin_size). VAH is the upper edge of
the highest value-area bin, so the invariant ``VAH >= VPOC >= VAL`` holds.

Algorithm summary:
    1. Aggregate ``quantity`` by bin low.
    2. VPOC = bin low with max volume (ties → lowest price for determinism).
    3. VAH/VAL: expand outward from VPOC, at each step pick whichever neighbor
       (above or below the current selection) has the greater volume, until
       cumulative selected volume ≥ ``va_pct × total``.
    4. HVN: bins ordered by volume desc; greedy pick, skipping any bin within
       ``hvn_dedup_ticks × tick_size`` of an already-selected HVN. Top ``top_n``.
    5. LVN: bottom ``top_n`` bins with volume > 0 (no dedup; LVNs are
       low-volume by definition and rarely cluster).

Example:
    >>> from rithmic_analytics.core.contracts import MNQ
    >>> from rithmic_analytics.core.loader import load_obs01_trades
    >>> from rithmic_analytics.features.volume_profile import compute_vp
    >>> trades = load_obs01_trades(Path("l1-trade.jsonl"))
    >>> vp = compute_vp(trades, MNQ)
    >>> vp.vpoc, vp.vah, vp.val
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import pandas as pd

from rithmic_analytics.core.contracts import ContractSpec

_LOG = logging.getLogger("rithmic_analytics.volume_profile")

# RA-039: adaptive bin_size_ticks per ATR regime.
# Formula: round(atr_14 / 4)   (ATR is in price units / points; ÷4 yields ticks
# at MNQ's 0.25 tick_size). Clamped to [_ADAPTIVE_MIN, _ADAPTIVE_MAX] so a
# pathological ATR can't blow up bin width.
_ADAPTIVE_MIN_BIN_TICKS: int = 4
_ADAPTIVE_MAX_BIN_TICKS: int = 40
_ADAPTIVE_FALLBACK_BIN_TICKS: int = 20  # mirrors the legacy fixed default

BinSizeMode = Literal["fixed", "adaptive", "adaptive_fallback"]


def _resolve_bin_size_ticks(
    *,
    bin_size_ticks: int,
    bin_size_mode: BinSizeMode,
    atr_14: float | None,
) -> tuple[int, BinSizeMode]:
    """Return ``(effective_ticks, effective_mode)`` per RA-039 rules.

    - ``mode == "fixed"`` → return ``(bin_size_ticks, "fixed")``.
    - ``mode == "adaptive"`` and ``atr_14`` is finite → compute
      ``round(atr_14 / 4)`` clamped to ``[4, 40]``.
    - ``mode == "adaptive"`` and ``atr_14`` is NaN/None → fall back to
      ``_ADAPTIVE_FALLBACK_BIN_TICKS`` (20) with a WARN log and mode
      ``"adaptive_fallback"`` surfaced on the profile.
    - ``mode == "adaptive_fallback"`` → caller is requesting the fallback
      explicitly; honor without ATR consultation.
    """
    if bin_size_mode == "fixed":
        return int(bin_size_ticks), "fixed"
    if bin_size_mode == "adaptive_fallback":
        return _ADAPTIVE_FALLBACK_BIN_TICKS, "adaptive_fallback"
    # mode == "adaptive"
    if atr_14 is None or not math.isfinite(atr_14):
        _LOG.warning(
            f"compute_vp(bin_size_mode='adaptive') called with non-finite "
            f"atr_14={atr_14!r}; falling back to "
            f"bin_size_ticks={_ADAPTIVE_FALLBACK_BIN_TICKS} "
            f"(mode reported as 'adaptive_fallback')."
        )
        return _ADAPTIVE_FALLBACK_BIN_TICKS, "adaptive_fallback"
    raw = int(round(atr_14 / 4.0))
    clamped = max(_ADAPTIVE_MIN_BIN_TICKS, min(_ADAPTIVE_MAX_BIN_TICKS, raw))
    return clamped, "adaptive"


@dataclass(frozen=True, slots=True)
class HVNBin:
    """A High-Volume Node — a bin singled out as a structural support level.

    Attributes:
        price_low: Bin's lower edge.
        price_high: Bin's upper edge (= ``price_low + bin_size``).
        volume: Contract count traded in this bin.
        volume_pct: Fraction of session total volume (0–1).
    """

    price_low: float
    price_high: float
    volume: int
    volume_pct: float


@dataclass(frozen=True, slots=True)
class LVNBin:
    """A Low-Volume Node — a bin with light trading interest, useful for breakout targets.

    Attributes:
        price_low: Bin's lower edge.
        price_high: Bin's upper edge.
        volume: Contract count traded in this bin.
    """

    price_low: float
    price_high: float
    volume: int


@dataclass(frozen=True, slots=True)
class VolumeProfile:
    """Result of a Volume Profile computation over a slice of trades.

    Attributes:
        vpoc: Volume Point of Control — bin low of the highest-volume bin.
            ``NaN`` if input was empty.
        vah: Value Area High — upper edge of the highest bin inside the
            value area. ``NaN`` if input was empty.
        val: Value Area Low — lower edge of the lowest bin inside the value
            area. ``NaN`` if input was empty.
        total_volume: Sum of contract quantities in input.
        bins: Series indexed by ``bin_low`` (float64) with ``volume`` values
            (int64). Sorted ascending by bin_low. Empty if no trades.
        hvn_list: Up to ``top_n`` HVNs, ordered by volume descending.
        lvn_list: Up to ``top_n`` LVNs, ordered by volume ascending.
        bin_size: Price width of each bin (= ``effective_bin_size_ticks × tick_size``).
        va_pct: Value-area target fraction used to compute VAH/VAL.
        effective_bin_size_ticks: Resolved bin width in ticks (RA-039). For
            ``bin_size_mode="fixed"`` this matches the kwarg; for
            ``"adaptive"`` it's the ATR-derived value (or the fallback when
            ATR was NaN). Default 0 keeps backward compatibility with code
            that constructs ``VolumeProfile`` directly without RA-039.
        bin_size_mode: Which RA-039 path produced ``effective_bin_size_ticks``.
            One of ``"fixed"``, ``"adaptive"``, ``"adaptive_fallback"``.
            Default ``"fixed"``.
    """

    vpoc: float
    vah: float
    val: float
    total_volume: int
    bins: pd.Series
    hvn_list: list[HVNBin] = field(default_factory=list)
    lvn_list: list[LVNBin] = field(default_factory=list)
    bin_size: float = 0.0
    va_pct: float = 0.70
    # RA-039: provenance — what bin_size was actually used and why.
    effective_bin_size_ticks: int = 0
    bin_size_mode: BinSizeMode = "fixed"


def _empty_profile(
    bin_size: float,
    va_pct: float,
    *,
    effective_bin_size_ticks: int,
    bin_size_mode: BinSizeMode,
) -> VolumeProfile:
    return VolumeProfile(
        vpoc=math.nan,
        vah=math.nan,
        val=math.nan,
        total_volume=0,
        bins=pd.Series(dtype="int64", name="volume"),
        hvn_list=[],
        lvn_list=[],
        bin_size=bin_size,
        va_pct=va_pct,
        effective_bin_size_ticks=effective_bin_size_ticks,
        bin_size_mode=bin_size_mode,
    )


def compute_vp(
    trades: pd.DataFrame,
    contract: ContractSpec,
    *,
    bin_size_ticks: int = 20,
    va_pct: float = 0.70,
    hvn_dedup_ticks: int = 60,
    top_n: int = 6,
    bin_size_mode: BinSizeMode = "fixed",
    atr_14: float | None = None,
) -> VolumeProfile:
    """Compute a Volume Profile over a trades DataFrame.

    Args:
        trades: DataFrame with at least ``price`` (float) and ``quantity`` (int)
            columns — i.e. the output of ``load_obs01_trades``.
        contract: ``ContractSpec`` — provides ``tick_size`` for tick→points
            conversion of ``bin_size_ticks`` and ``hvn_dedup_ticks``.
        bin_size_ticks: Bin width in ticks (used when ``bin_size_mode="fixed"``).
            Default 20 ticks = 5 points for MNQ.
        va_pct: Value-area target fraction. Default 0.70.
        hvn_dedup_ticks: Minimum tick distance between HVNs. Default 60 ticks =
            15 points for MNQ (one HVN per ~15-point cluster).
        top_n: Max HVN / LVN count to return.
        bin_size_mode: RA-039 — ``"fixed"`` (default; honors ``bin_size_ticks``)
            or ``"adaptive"`` (derive bin width from ATR via ``round(atr_14/4)``
            clamped to ``[4, 40]``). ``"adaptive_fallback"`` is a caller-driven
            opt-in to the 20-tick fallback without ATR consultation. Adaptive
            with NaN ATR transparently downgrades to ``"adaptive_fallback"``
            and emits a WARN log.
        atr_14: Required for ``bin_size_mode="adaptive"``. Price-unit ATR (points),
            same units as ``compute_atr_from_ticks`` returns. NaN/None → fallback.

    Returns:
        ``VolumeProfile`` with VPOC/VAH/VAL, full bin Series, top HVNs/LVNs,
        and the resolved ``effective_bin_size_ticks`` / ``bin_size_mode``.
        For empty input, fields are NaN/empty but the dataclass is still
        constructable (so downstream zone-JSON emit doesn't have to special-case).

    Example:
        >>> from rithmic_analytics.core.contracts import MNQ
        >>> trades = pd.DataFrame({"price": [27380.5]*90 + [27400.5]*10,
        ...                       "quantity": [1]*100})
        >>> vp = compute_vp(trades, MNQ)
        >>> vp.vpoc
        27380.0
    """
    effective_ticks, effective_mode = _resolve_bin_size_ticks(
        bin_size_ticks=bin_size_ticks,
        bin_size_mode=bin_size_mode,
        atr_14=atr_14,
    )
    bin_size = effective_ticks * contract.tick_size
    dedup_pts = hvn_dedup_ticks * contract.tick_size

    if len(trades) == 0:
        return _empty_profile(
            bin_size, va_pct,
            effective_bin_size_ticks=effective_ticks,
            bin_size_mode=effective_mode,
        )

    prices = trades["price"].to_numpy(dtype="float64")
    quantities = trades["quantity"].to_numpy(dtype="int64")
    bin_lows = np.floor(prices / bin_size) * bin_size

    # Aggregate volume per bin. groupby on a NumPy array is fastest via pandas.
    agg = pd.DataFrame({"bin_low": bin_lows, "qty": quantities})
    bins = agg.groupby("bin_low", sort=True)["qty"].sum().astype("int64")
    bins.name = "volume"

    total_volume = int(bins.sum())
    if total_volume == 0:
        return _empty_profile(
            bin_size, va_pct,
            effective_bin_size_ticks=effective_ticks,
            bin_size_mode=effective_mode,
        )

    # ---- VPOC ----
    # idxmax on a sorted-index Series returns the first (lowest-price) tied bin.
    vpoc_bin_low = float(bins.idxmax())
    vpoc = vpoc_bin_low

    # ---- VAH / VAL (greedy outward expansion) ----
    bin_lows_sorted = bins.index.to_numpy()
    bin_vols = bins.to_numpy()
    vpoc_idx = int(np.searchsorted(bin_lows_sorted, vpoc_bin_low))

    target = va_pct * total_volume
    cumulative = int(bin_vols[vpoc_idx])
    upper_idx = vpoc_idx + 1
    lower_idx = vpoc_idx - 1
    max_idx = len(bin_lows_sorted) - 1
    lowest_selected = vpoc_idx
    highest_selected = vpoc_idx

    while cumulative < target:
        upper_vol = int(bin_vols[upper_idx]) if upper_idx <= max_idx else -1
        lower_vol = int(bin_vols[lower_idx]) if lower_idx >= 0 else -1
        if upper_vol < 0 and lower_vol < 0:
            break  # all bins exhausted; VA target unreachable (shouldn't happen for va_pct ≤ 1)
        # Tie or upper wins → take upper (deterministic direction choice).
        if upper_vol >= lower_vol:
            cumulative += upper_vol
            highest_selected = upper_idx
            upper_idx += 1
        else:
            cumulative += lower_vol
            lowest_selected = lower_idx
            lower_idx -= 1

    val = float(bin_lows_sorted[lowest_selected])
    vah = float(bin_lows_sorted[highest_selected]) + bin_size

    # ---- HVNs (top-N by volume, deduped by price distance) ----
    sorted_by_vol = bins.sort_values(ascending=False, kind="stable")
    hvn_list: list[HVNBin] = []
    for bin_low, vol in sorted_by_vol.items():
        bin_low_f = float(bin_low)  # type: ignore[arg-type]  # idx may be Hashable
        too_close = any(abs(bin_low_f - h.price_low) < dedup_pts for h in hvn_list)
        if too_close:
            continue
        hvn_list.append(
            HVNBin(
                price_low=bin_low_f,
                price_high=bin_low_f + bin_size,
                volume=int(vol),
                volume_pct=float(vol) / total_volume,
            )
        )
        if len(hvn_list) >= top_n:
            break

    # ---- LVNs (bottom-N by volume, no dedup) ----
    sorted_by_vol_asc = bins.sort_values(ascending=True, kind="stable")
    lvn_list: list[LVNBin] = []
    for bin_low, vol in sorted_by_vol_asc.head(top_n).items():
        bin_low_f = float(bin_low)  # type: ignore[arg-type]
        lvn_list.append(
            LVNBin(
                price_low=bin_low_f,
                price_high=bin_low_f + bin_size,
                volume=int(vol),
            )
        )

    return VolumeProfile(
        vpoc=vpoc,
        vah=vah,
        val=val,
        total_volume=total_volume,
        bins=bins,
        hvn_list=hvn_list,
        lvn_list=lvn_list,
        bin_size=bin_size,
        va_pct=va_pct,
        effective_bin_size_ticks=effective_ticks,
        bin_size_mode=effective_mode,
    )
