"""RA-112e step 4 — v3 VWAP-anchored σ shelves (production geometry).

The legacy v2 anchors shelves at session VAH/VAL; on a session with the
rolling-60-min VWAP far from value, the σ math places "supply above" tiers
*below* the anchor (the shelf-crosses-anchor pathology that the audit flagged).
v3 anchors directly at the rolling VWAP — the same horizon as the dispersion
estimate — so the geometry contradiction cannot occur.

Math (locked by the operator, 2026-06-01):

    a_t        = rolling 60-min volume-weighted average price
    σ_above    = one-sided RMS of positive residuals (volume-weighted)
    σ_below    = one-sided RMS of |negative residuals| (volume-weighted)
    ATR_cap    = cap_atr_fraction · ATR(14, 60-min bars)
    upper_w_n  = σ_above · n          (RMS estimator — step 4a baseline)
    lower_w_n  = σ_below · n
    cap_n      = (n / 2) · ATR_cap    (tier-scaled outer guardrail)

    U_n = a_t + min(upper_w_n, cap_n)
    D_n = a_t - min(lower_w_n, cap_n)
    SUP_1..3 = [a_t, U_1] / [U_1, U_2] / [U_2, U_3]
    DEM_1..3 = [D_1, a_t] / [D_2, D_1] / [D_3, D_2]

Shadow mode (the only mode for this commit): v2 legacy shelves are computed
alongside v3 with the same σ values but anchored at VAH/VAL, and emitted with
``family="sigma_v2_session_value_anchor"`` so the operator can compare them on
chart and the touch logger captures crossings of BOTH against the same tape.

Estimator: RMS (one-sided RMS-about-zero of residuals). Stays as the baseline
through step 4a per the operator's plan to "isolate the anchor fix from the
estimator change." Step 6 swaps in local volume-weighted quantiles and
measures the difference against the same touch corpus.

ATR_cap basis is 60-min ATR(14) per RA-112b. When the live tape is too young
for 14 hours of bars (early session), the caller passes a prior-session
fallback so the cap stays sensible at session start.
"""

from __future__ import annotations

import io
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

from rithmic_analytics.features.atr import NS_1H, compute_atr_from_ticks
from rithmic_analytics.features.sigma_zones_v2 import (
    DEFAULT_CAP_ATR_FRACTION,
    DEFAULT_TICK_SIZE,
    DEFAULT_WINDOW_MINUTES,
    _trailing_window_residuals,
    compute_sigma_zones_v2,
)

# Operator-locked families. v3 (RMS) is primary visual, v2 is shadow
# subordinate, v3-quantile is a sibling estimator (step 6) we run alongside
# v3-RMS so the touch corpus can adjudicate which one ships as production.
FAMILY_V3 = "sigma_v3_vwap_anchor"                 # RMS one-sided dispersion
FAMILY_V3_QUANTILE = "sigma_v3_vwap_anchor_quantile"  # local nonparametric
FAMILY_V2 = "sigma_v2_session_value_anchor"

# Method version stamped on snapshots so future replays can disambiguate.
METHOD_VERSION_V3 = "v3.0.0"

# RA-112e step 6: per-tier quantiles for the local volume-weighted excursion
# estimator. Tuned per the operator's design (2026-06-01): Q70/Q85/Q95 of
# one-sided residuals — slightly less aggressive than Q68/Q90/Q97 so the
# inner tier holds more touches and the outer tier stays comparable to the
# RMS-based σ3 width on a normally-distributed window.
QUANTILE_TIERS: tuple[float, float, float] = (0.70, 0.85, 0.95)

# Last-known-good fallback when the live tape is too young for ATR(14, 60-min).
# Tuned against recent globex sessions (RA-112b empirical: 60m ATR ~= 62-66pt).
DEFAULT_PRIOR_ATR_60M: float = 65.0

# How much of the obs01 tail to read per compute pass. 150MB covers > 1 hour
# of trades on a busy session — well above the 60-min trailing window.
DEFAULT_TAIL_BYTES: int = 150_000_000

# RA-112e step 5: warmup threshold. When the trailing window has less than
# this many minutes of trades, the one-sided σ estimators are too noisy to
# trust — the shelves are still computed (so the operator sees the rough
# location) but tagged is_warmup=true and the UI marks them as such.
WARMUP_MIN_TAPE_MINUTES: float = 30.0


@dataclass(frozen=True, slots=True)
class ShelfDescriptor:
    """One shelf as a wire-ready record. Mirrors the Shelf dataclass shape on
    the zone-snapshot stream so the caller can spread directly into it."""
    family: str
    name: str
    low: float
    high: float
    tier: int
    bound_source: str
    cap_bound: bool
    overlaps_vah: bool
    overlaps_val: bool
    nearest_structural_level: str | None
    distance_to_structural_level_ticks: float | None


@dataclass(frozen=True, slots=True)
class ZoneShelvesResult:
    """All shelves produced by one compute pass, plus the audit-trail inputs.

    ``shelves`` packs v3 first (the primary) then v2 (legacy shadow). Both
    families share the σ values (so any visual divergence is purely the anchor
    difference) and the same ATR cap.
    """
    shelves: tuple[ShelfDescriptor, ...]
    cap_bind_flags: dict[str, bool]
    bound_source: dict[str, str]
    # Audit-trail inputs (same across v3 and v2; they share one compute).
    anchor: float
    sigma_above: float
    sigma_below: float
    atr_14_60m: float
    atr_cap: float
    atr_cap_source: str  # "computed" | "fallback_constant" | "fallback_prior_session"
    # RA-112e step 5: Globex/RTH split. tape_minutes is how much wall-clock
    # the live trade window covers (max_ts - min_ts) — a session that just
    # opened has a small value here. is_warmup is true when tape_minutes is
    # below the operator-locked warmup threshold; the shelves are still
    # returned but the UI marks them as "warming up".
    tape_minutes: float
    is_warmup: bool


def compute_zone_shelves(
    *,
    capture_path: Path,
    vah: float | None,
    val: float | None,
    vpoc: float | None,
    bin_size_ticks: int,
    prior_atr_60m: float | None = None,
    tail_bytes: int = DEFAULT_TAIL_BYTES,
    window_minutes: int = DEFAULT_WINDOW_MINUTES,
    cap_atr_fraction: float = DEFAULT_CAP_ATR_FRACTION,
    tick_size: float = DEFAULT_TICK_SIZE,
    reference_lines: Iterable[dict[str, Any]] = (),
) -> ZoneShelvesResult | None:
    """Compute v3 + v2 shelves from the current capture tail.

    Returns None when essential inputs are missing (no VAH/VAL, empty tape,
    σ values undefined). Caller should treat None as "shelves not available
    this cycle" — the zone-snapshot record then carries an empty ``shelves``
    list, matching the step-1 baseline.
    """
    if vah is None or val is None or vpoc is None:
        return None

    df = _load_tape_tail(capture_path, tail_bytes=tail_bytes)
    if df is None or len(df) < 2:
        return None

    # RA-112e step 5: wall-clock span of the loaded window. After a session
    # boundary (e.g. RTH open) this is small until enough trades accumulate.
    tape_minutes = float(
        (int(df["event_ts_ns"].iloc[-1]) - int(df["event_ts_ns"].iloc[0]))
        / (60.0 * 1_000_000_000)
    )
    is_warmup = tape_minutes < WARMUP_MIN_TAPE_MINUTES

    # 60-min ATR(14) for the cap (RA-112b). Falls back to prior session's
    # value when this session is too young for 14h of bars, then to a tuned
    # constant when neither is available — keeps the cap sane on cold start.
    atr_60m, atr_source = _resolve_atr_60m(df, prior_atr_60m)
    if atr_60m <= 0:
        return None

    # Run v2 once to get σ_above / σ_below / VWAP_w / cap from one compute.
    v2 = compute_sigma_zones_v2(
        df,
        vah=float(vah),
        val=float(val),
        vpoc=float(vpoc),
        bin_size_ticks=int(bin_size_ticks),
        atr_14=atr_60m,
        tick_size=tick_size,
        window_minutes=window_minutes,
        cap_atr_fraction=cap_atr_fraction,
    )
    if math.isnan(v2.vwap_window) or v2.vwap_window <= 0:
        return None

    anchor = float(v2.vwap_window)
    sigma_above = float(v2.sigma_above)
    sigma_below = float(v2.sigma_below)
    atr_cap = float(v2.atr_cap)
    refs = list(reference_lines)

    # ---- v3 (primary, VWAP_w-anchored) -------------------------------------
    v3_shelves, v3_caps, v3_sources = _v3_shelves(
        anchor=anchor,
        sigma_above=sigma_above,
        sigma_below=sigma_below,
        atr_cap=atr_cap,
        vah=float(vah),
        val=float(val),
        tick_size=tick_size,
        reference_lines=refs,
    )

    # ---- v3 quantile (shadow estimator, RA-112e step 6) -------------------
    # Re-derive residuals + weights for the same trailing window the v2
    # compute used internally, then build the quantile-driven shelves so
    # the touch corpus can adjudicate which estimator predicts better
    # reactions over time. Both estimators share the same anchor + cap.
    _, residuals_w, weights_w = _trailing_window_residuals(
        df, window_minutes=window_minutes
    )
    v3q_shelves, v3q_caps, v3q_sources = _v3_quantile_shelves(
        anchor=anchor, residuals=residuals_w, weights=weights_w,
        atr_cap=atr_cap, vah=float(vah), val=float(val),
        tick_size=tick_size, reference_lines=refs,
    )

    # ---- v2 legacy (shadow, VAH/VAL-anchored) — only ±1σ and ±2σ tiers,
    # mirroring the sigma_zones_v2 module's existing four-zone output -------
    v2_shelves, v2_caps, v2_sources = _v2_legacy_shelves_from_v2(
        v2=v2, vah=float(vah), val=float(val), tick_size=tick_size,
        reference_lines=refs,
    )

    return ZoneShelvesResult(
        shelves=tuple(v3_shelves + v3q_shelves + v2_shelves),
        cap_bind_flags={**v3_caps, **v3q_caps, **v2_caps},
        bound_source={**v3_sources, **v3q_sources, **v2_sources},
        anchor=anchor,
        sigma_above=sigma_above,
        sigma_below=sigma_below,
        atr_14_60m=atr_60m,
        atr_cap=atr_cap,
        atr_cap_source=atr_source,
        tape_minutes=tape_minutes,
        is_warmup=is_warmup,
    )


# ---------------------------------------------------------------------------
# Local volume-weighted quantile estimator (RA-112e step 6)
# ---------------------------------------------------------------------------


def _volume_weighted_quantile(
    values: np.ndarray, weights: np.ndarray, q: float
) -> float:
    """Return the volume-weighted ``q``-quantile of ``values``.

    Sorts values ascending, walks the cumulative weight to find the index
    whose cumulative weight first crosses ``q × total_weight``. Returns the
    value at that index. Returns 0.0 on empty input.

    Notes:
      * ``q`` is clamped to [0, 1].
      * If total_weight ≤ 0, returns 0.0.
      * Larger weights pull the quantile toward heavier trades — a 5-lot
        trade at price+10 has 5× the impact of a 1-lot trade at price+10
        on the resulting quantile.
    """
    if len(values) == 0 or len(weights) == 0:
        return 0.0
    qc = max(0.0, min(1.0, q))
    order = np.argsort(values)
    sorted_values = values[order]
    sorted_weights = weights[order]
    cum_w = np.cumsum(sorted_weights)
    total = float(cum_w[-1])
    if total <= 0:
        return 0.0
    target = qc * total
    idx = int(np.searchsorted(cum_w, target))
    idx = min(idx, len(sorted_values) - 1)
    return float(sorted_values[idx])


def _one_sided_quantiles(
    residuals: np.ndarray, weights: np.ndarray, *, side: str, quantiles: tuple[float, ...]
) -> tuple[float, ...]:
    """Compute one-sided volume-weighted quantiles of residual magnitudes.

    ``side='above'`` keeps positive residuals; ``side='below'`` keeps
    negative residuals and takes their absolute value. Each returned value
    is the magnitude of the residual at that quantile — meant to be added to
    (above) or subtracted from (below) the anchor to produce the shelf top
    or bottom.
    """
    if side not in {"above", "below"}:
        raise ValueError(f"side must be 'above' or 'below', got {side!r}")
    if len(residuals) == 0:
        return tuple(0.0 for _ in quantiles)
    mask = residuals > 0 if side == "above" else residuals < 0
    if not mask.any():
        return tuple(0.0 for _ in quantiles)
    side_values = np.abs(residuals[mask])
    side_weights = weights[mask]
    return tuple(
        _volume_weighted_quantile(side_values, side_weights, q) for q in quantiles
    )


def _v3_quantile_shelves(
    *,
    anchor: float,
    residuals: np.ndarray,
    weights: np.ndarray,
    atr_cap: float,
    vah: float,
    val: float,
    tick_size: float,
    reference_lines: list[dict[str, Any]],
    quantile_tiers: tuple[float, float, float] = QUANTILE_TIERS,
) -> tuple[list[ShelfDescriptor], dict[str, bool], dict[str, str]]:
    """Build six shelves whose widths come from one-sided quantiles of
    residuals, with the same ATR-cap guardrail as the RMS estimator.

    SUP_n top = anchor + min(quantile_above[n-1], (n/2)·ATR_cap)
    DEM_n bot = anchor − min(quantile_below[n-1], (n/2)·ATR_cap)

    Non-overlapping shelves; identical bookkeeping (bound_source, cap_bound,
    confluence) to ``_v3_shelves`` so downstream consumers don't need to
    distinguish — only the ``family`` differs.
    """
    above_widths = _one_sided_quantiles(
        residuals, weights, side="above", quantiles=quantile_tiers
    )
    below_widths = _one_sided_quantiles(
        residuals, weights, side="below", quantiles=quantile_tiers
    )

    shelves: list[ShelfDescriptor] = []
    caps: dict[str, bool] = {}
    sources: dict[str, str] = {}

    # Supply: walk up from anchor.
    prev_top = anchor
    for n, raw_width in enumerate(above_widths, start=1):
        cap_n = (n / 2.0) * atr_cap
        if raw_width <= cap_n:
            top = anchor + raw_width
            src = "estimator"
        else:
            top = anchor + cap_n
            src = "atr_cap"
        top = max(anchor, top)
        name = f"SUP_{n}"
        # Sort low/high before building so we don't pass low > high when
        # quantiles return a SMALLER value at a HIGHER tier (degenerate /
        # quiet window). _build_shelf normalizes anyway.
        shelves.append(
            _build_shelf(
                family=FAMILY_V3_QUANTILE, name=name, tier=n,
                low=min(prev_top, top), high=max(prev_top, top),
                bound_source=src,
                vah=vah, val=val, tick_size=tick_size,
                reference_lines=reference_lines,
            )
        )
        caps[f"{FAMILY_V3_QUANTILE}:{name}"] = src == "atr_cap"
        sources[f"{FAMILY_V3_QUANTILE}:{name}"] = src
        prev_top = max(prev_top, top)

    # Demand: walk down from anchor.
    prev_bot = anchor
    for n, raw_width in enumerate(below_widths, start=1):
        cap_n = (n / 2.0) * atr_cap
        if raw_width <= cap_n:
            bot = anchor - raw_width
            src = "estimator"
        else:
            bot = anchor - cap_n
            src = "atr_cap"
        bot = min(anchor, bot)
        name = f"DEM_{n}"
        shelves.append(
            _build_shelf(
                family=FAMILY_V3_QUANTILE, name=name, tier=n,
                low=min(prev_bot, bot), high=max(prev_bot, bot),
                bound_source=src,
                vah=vah, val=val, tick_size=tick_size,
                reference_lines=reference_lines,
            )
        )
        caps[f"{FAMILY_V3_QUANTILE}:{name}"] = src == "atr_cap"
        sources[f"{FAMILY_V3_QUANTILE}:{name}"] = src
        prev_bot = min(prev_bot, bot)

    return shelves, caps, sources


# ---------------------------------------------------------------------------
# v3 (VWAP-anchored) shelf construction
# ---------------------------------------------------------------------------


def _v3_shelves(
    *,
    anchor: float,
    sigma_above: float,
    sigma_below: float,
    atr_cap: float,
    vah: float,
    val: float,
    tick_size: float,
    reference_lines: list[dict[str, Any]],
) -> tuple[list[ShelfDescriptor], dict[str, bool], dict[str, str]]:
    """Build six shelves around the rolling VWAP anchor (tiers 1, 2, 3)."""
    shelves: list[ShelfDescriptor] = []
    caps: dict[str, bool] = {}
    sources: dict[str, str] = {}

    # Supply tops: anchor + min(n·σ_above, (n/2)·ATR_cap)
    sup_tops: list[tuple[int, float, str]] = []
    for n in (1, 2, 3):
        sigma_ext = anchor + n * sigma_above
        cap_top = anchor + (n / 2.0) * atr_cap
        top = min(sigma_ext, cap_top)
        src = "atr_cap" if sigma_ext > cap_top else "estimator"
        sup_tops.append((n, max(anchor, top), src))

    # Demand bottoms: anchor - min(n·σ_below, (n/2)·ATR_cap)
    dem_bots: list[tuple[int, float, str]] = []
    for n in (1, 2, 3):
        sigma_ext = anchor - n * sigma_below
        cap_bot = anchor - (n / 2.0) * atr_cap
        bot = max(sigma_ext, cap_bot)
        src = "atr_cap" if sigma_ext < cap_bot else "estimator"
        dem_bots.append((n, min(anchor, bot), src))

    # Render non-overlapping shelves (the band between consecutive tops/bots).
    prev_top = anchor
    for n, top, src in sup_tops:
        name = f"SUP_{n}"
        shelves.append(
            _build_shelf(
                family=FAMILY_V3, name=name, tier=n,
                low=prev_top, high=top, bound_source=src,
                vah=vah, val=val, tick_size=tick_size,
                reference_lines=reference_lines,
            )
        )
        caps[f"{FAMILY_V3}:{name}"] = src == "atr_cap"
        sources[f"{FAMILY_V3}:{name}"] = src
        prev_top = top

    prev_bot = anchor
    for n, bot, src in dem_bots:
        name = f"DEM_{n}"
        shelves.append(
            _build_shelf(
                family=FAMILY_V3, name=name, tier=n,
                low=bot, high=prev_bot, bound_source=src,
                vah=vah, val=val, tick_size=tick_size,
                reference_lines=reference_lines,
            )
        )
        caps[f"{FAMILY_V3}:{name}"] = src == "atr_cap"
        sources[f"{FAMILY_V3}:{name}"] = src
        prev_bot = bot

    return shelves, caps, sources


# ---------------------------------------------------------------------------
# v2 legacy shadow shelves
# ---------------------------------------------------------------------------


def _v2_legacy_shelves_from_v2(
    *,
    v2,
    vah: float,
    val: float,
    tick_size: float,
    reference_lines: list[dict[str, Any]],
) -> tuple[list[ShelfDescriptor], dict[str, bool], dict[str, str]]:
    """Lift v2's session-value-anchored zones into the shelf schema.

    Renders them as non-overlapping bands so the visual matches v3 in style
    even though the math anchors differently.
    """
    shelves: list[ShelfDescriptor] = []
    caps: dict[str, bool] = {}
    sources: dict[str, str] = {}

    # σ_1_supply: VAH -> sigma_1_supply.top ; σ_2_supply: σ_1_top -> σ_2_top
    s1 = v2.sigma_1_supply
    s2 = v2.sigma_2_supply
    sup_pairs = [
        ("SUP_1", 1, vah, s1.top, s1.bound_source),
        ("SUP_2", 2, s1.top, s2.top, s2.bound_source),
    ]
    for name, n, lo, hi, src in sup_pairs:
        shelves.append(_build_shelf(
            family=FAMILY_V2, name=name, tier=n, low=lo, high=hi,
            bound_source=src, vah=vah, val=val, tick_size=tick_size,
            reference_lines=reference_lines,
        ))
        caps[f"{FAMILY_V2}:{name}"] = src == "atr_cap"
        sources[f"{FAMILY_V2}:{name}"] = src

    d1 = v2.sigma_1_demand
    d2 = v2.sigma_2_demand
    dem_pairs = [
        ("DEM_1", 1, d1.bottom, val, d1.bound_source),
        ("DEM_2", 2, d2.bottom, d1.bottom, d2.bound_source),
    ]
    for name, n, lo, hi, src in dem_pairs:
        shelves.append(_build_shelf(
            family=FAMILY_V2, name=name, tier=n, low=lo, high=hi,
            bound_source=src, vah=vah, val=val, tick_size=tick_size,
            reference_lines=reference_lines,
        ))
        caps[f"{FAMILY_V2}:{name}"] = src == "atr_cap"
        sources[f"{FAMILY_V2}:{name}"] = src

    return shelves, caps, sources


# ---------------------------------------------------------------------------
# Shelf-construction helpers
# ---------------------------------------------------------------------------


def _build_shelf(
    *,
    family: str,
    name: str,
    tier: int,
    low: float,
    high: float,
    bound_source: str,
    vah: float,
    val: float,
    tick_size: float,
    reference_lines: list[dict[str, Any]],
) -> ShelfDescriptor:
    """Construct a single shelf with confluence metadata.

    ``nearest_structural_level`` + ``distance_to_structural_level_ticks`` scan
    the supplied reference-lines list for the closest VAH/VAL/VPOC/HVN/LVN to
    the shelf's mid. Distance is non-negative.
    """
    low, high = sorted([low, high])
    overlaps_vah = low <= vah <= high
    overlaps_val = low <= val <= high
    mid = (low + high) / 2.0
    nearest, distance = _nearest_structural(mid, reference_lines, tick_size)
    return ShelfDescriptor(
        family=family,
        name=name,
        low=float(low),
        high=float(high),
        tier=int(tier),
        bound_source=bound_source,
        cap_bound=(bound_source == "atr_cap"),
        overlaps_vah=overlaps_vah,
        overlaps_val=overlaps_val,
        nearest_structural_level=nearest,
        distance_to_structural_level_ticks=distance,
    )


def _nearest_structural(
    mid: float,
    reference_lines: list[dict[str, Any]],
    tick_size: float,
) -> tuple[str | None, float | None]:
    best_source: str | None = None
    best_distance: float | None = None
    for line in reference_lines:
        price = line.get("price")
        source = line.get("source")
        if price is None or source is None:
            continue
        try:
            price_f = float(price)
        except (TypeError, ValueError):
            continue
        distance_ticks = abs(price_f - mid) / tick_size
        if best_distance is None or distance_ticks < best_distance:
            best_distance = distance_ticks
            best_source = str(source)
    return best_source, best_distance


# ---------------------------------------------------------------------------
# Tape + ATR helpers
# ---------------------------------------------------------------------------


def _load_tape_tail(
    capture_path: Path, *, tail_bytes: int
) -> pd.DataFrame | None:
    """Read the trailing ``tail_bytes`` of a capture into a trades DataFrame.

    Tolerant of two schemas seen in this codebase:

    * **obs01 nested**: ``{"type": "TRADE", "payload": {"exchange_event_ts_ns":
      ..., "price": ..., "quantity": ...}}`` — what the production normalizer
      writes and the live realtime backend reads via ``signals.source_path``.
    * **raw flat**: ``{"stream": "LAST_TRADE", "exchange_event_ts_ns": ...,
      "price": ..., "size": ...}`` — what the raw capture writer emits and
      what the realtime_backend test fixture uses.

    Both shapes converge to ``(event_ts_ns, price, quantity)`` rows. Uses a
    byte-tail scan rather than the full ``load_obs01_trades`` so a 100MB+
    capture doesn't dominate the compute pass. Drops the partial first line.
    """
    if not capture_path.exists():
        return None
    rows: list[tuple[int, float, int]] = []
    try:
        with capture_path.open("rb") as fh:
            fh.seek(0, io.SEEK_END)
            end = fh.tell()
            fh.seek(max(0, end - tail_bytes))
            fh.readline()  # discard partial first line
            for raw in fh:
                try:
                    o = json.loads(raw)
                except Exception:
                    continue
                row = _trade_from_record(o)
                if row is not None:
                    rows.append(row)
    except OSError:
        return None
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["event_ts_ns", "price", "quantity"])
    df = df.sort_values("event_ts_ns").reset_index(drop=True)
    return df


def _trade_from_record(o: dict[str, Any]) -> tuple[int, float, int] | None:
    """Extract (ts_ns, price, qty) from either an obs01 or a raw capture row.

    Returns None on any malformed shape so the caller can continue past it.
    """
    # obs01 nested.
    payload = o.get("payload")
    if isinstance(payload, dict):
        ts = payload.get("exchange_event_ts_ns")
        price = payload.get("price")
        qty = payload.get("quantity")
        if ts is not None and price is not None and qty is not None:
            try:
                return int(ts), float(price), int(qty)
            except (TypeError, ValueError):
                return None
        return None
    # raw flat (the realtime_backend test fixture uses this; the field is
    # ``size`` rather than ``quantity``).
    ts = o.get("exchange_event_ts_ns")
    price = o.get("price")
    qty = o.get("size") if "size" in o else o.get("quantity")
    if ts is not None and price is not None and qty is not None:
        try:
            return int(ts), float(price), int(qty)
        except (TypeError, ValueError):
            return None
    return None


def _resolve_atr_60m(
    df: pd.DataFrame, prior_atr_60m: float | None
) -> tuple[float, str]:
    """Compute the 60-min ATR(14) from the live tape, with fallback chain.

    Fallback order:
      1. Live tape's 60-min ATR(14) if the tape is mature enough (>= 14h
         of bars). Returns ``(value, "computed")``.
      2. Caller-supplied prior session value if non-None. Returns
         ``(value, "fallback_prior_session")``.
      3. DEFAULT_PRIOR_ATR_60M constant. Returns
         ``(value, "fallback_constant")``.
    """
    try:
        atr = compute_atr_from_ticks(df, period=14, bar_size_ns=NS_1H)
    except Exception:
        atr = float("nan")
    if not math.isnan(atr) and atr > 0:
        return float(atr), "computed"
    if prior_atr_60m is not None and prior_atr_60m > 0:
        return float(prior_atr_60m), "fallback_prior_session"
    return DEFAULT_PRIOR_ATR_60M, "fallback_constant"


__all__ = [
    "DEFAULT_PRIOR_ATR_60M",
    "DEFAULT_TAIL_BYTES",
    "FAMILY_V2",
    "FAMILY_V3",
    "FAMILY_V3_QUANTILE",
    "METHOD_VERSION_V3",
    "QUANTILE_TIERS",
    "WARMUP_MIN_TAPE_MINUTES",
    "ShelfDescriptor",
    "ZoneShelvesResult",
    "compute_zone_shelves",
]
