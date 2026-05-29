"""Pre/post-fill orderflow snapshots — RA-026.

For each :class:`TradeFill`, joins the fill timestamp against the captured
tick tape and computes an orderflow snapshot showing **what was happening
60 seconds before and after** the fill:

- Volume / delta / aggressor ratio / VWAP / price-change in pre + post windows.
- Cumulative CVD at the fill, and CVD 60 seconds after.
- Realised PnL at configurable horizons (default 60s / 300s / 900s).
- Zone proximity dict — zones within 1×ATR(14) of the fill price, capped at
  the 5 nearest. Falls back to top-5 nearest regardless of distance when
  ``atr_14 is None`` (per the documented null edge case).

Vectorised via ``np.searchsorted`` on the sorted ``event_ts_ns`` array —
50 fills against a 100K-trade session runs sub-second.

Cross-symbol fills (a fill whose symbol doesn't match ``contract.root``) are
**skipped with a WARNING** per Q3E. The skip count is exposed in the
returned :class:`ReplaySession`.metadata so the report can surface it.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from rithmic_analytics.core.contracts import ContractSpec
from rithmic_analytics.core.schema import Zone
from rithmic_analytics.core.trade_log import CancelledOrder, TradeFill

_LOG = logging.getLogger("rithmic_analytics.trade_replay")

_NS_PER_SECOND: int = 10**9
DEFAULT_PNL_HORIZONS_SEC: tuple[int, ...] = (60, 300, 900)
_DEFAULT_ZONE_PROXIMITY_CAP: int = 5


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FillSnapshot:
    """Orderflow snapshot around a single fill.

    Window stats: ``[fill_ts - window, fill_ts]`` pre, ``[fill_ts, fill_ts +
    window]`` post. Boundary semantics: pre is left-inclusive, right-inclusive;
    post is left-inclusive, right-inclusive. A trade exactly at the fill_ts
    appears in both windows — which is correct: it's contextual to both.

    Attributes:
        fill: The :class:`TradeFill` this snapshot describes.
        pre_volume: Total ``quantity`` in the pre window (``int``, may be 0).
        pre_delta: Sum of ``signed_qty`` in the pre window.
        pre_aggressor_ratio: ``|pre_delta| / pre_volume``, ``None`` when
            ``pre_volume == 0`` (per the empty-window convention).
        pre_vwap: VWAP in the pre window; ``None`` when ``pre_volume == 0``.
        pre_price_change: ``last_price - first_price`` in window; ``None``
            when empty.
        post_volume / post_delta / post_aggressor_ratio / post_vwap /
        post_price_change: Mirrors of the pre fields.
        pre_cvd: Cumulative ``signed_qty`` from session start through
            ``fill.fill_ts_ns`` (inclusive).
        post_cvd_60s: Cumulative through ``fill.fill_ts_ns + 60s``;
            ``None`` if the session ends before then.
        pre_zone_proximity: Mapping ``{zone_id: distance_pts}`` — zones with
            ``|fill.price - zone_center| <= atr_14`` (1×ATR), capped at the
            5 nearest. When ``atr_14`` is unavailable, falls back to top-5
            nearest regardless of distance (and ``atr_fallback=True``).
            Empty when no zones were supplied.
        atr_fallback: ``True`` when the ATR null edge case forced the
            top-5-nearest fallback.
        realized_pnl: Mapping ``{horizon_seconds: pnl_dollars_or_None}``.
            Gross dollars (``× qty × dollars_per_point``). ``None`` for a
            horizon when the session ends before ``fill_ts + horizon``.
            Always ``nan`` for quarantined fills (``fill.quarantined``).
    """

    fill: TradeFill
    pre_volume: int
    pre_delta: int
    pre_aggressor_ratio: float | None
    pre_vwap: float | None
    pre_price_change: float | None
    post_volume: int
    post_delta: int
    post_aggressor_ratio: float | None
    post_vwap: float | None
    post_price_change: float | None
    pre_cvd: int
    post_cvd_60s: int | None
    pre_zone_proximity: dict[str, float]
    atr_fallback: bool
    realized_pnl: dict[int, float | None]

    def to_dict(self) -> dict[str, Any]:
        """Plain-dict view for JSON serialisation."""
        return {
            "fill": {
                "fill_ts_ns": self.fill.fill_ts_ns,
                "symbol": self.fill.symbol,
                "side": self.fill.side,
                "price": self.fill.price,
                "quantity": self.fill.quantity,
                "order_type": self.fill.order_type,
                "fill_id": self.fill.fill_id,
                "notes": self.fill.notes,
                "quarantined": self.fill.quarantined,
            },
            "pre_volume": self.pre_volume,
            "pre_delta": self.pre_delta,
            "pre_aggressor_ratio": self.pre_aggressor_ratio,
            "pre_vwap": self.pre_vwap,
            "pre_price_change": self.pre_price_change,
            "post_volume": self.post_volume,
            "post_delta": self.post_delta,
            "post_aggressor_ratio": self.post_aggressor_ratio,
            "post_vwap": self.post_vwap,
            "post_price_change": self.post_price_change,
            "pre_cvd": self.pre_cvd,
            "post_cvd_60s": self.post_cvd_60s,
            "pre_zone_proximity": dict(self.pre_zone_proximity),
            "atr_fallback": self.atr_fallback,
            "realized_pnl": dict(self.realized_pnl),
        }


@dataclass(frozen=True, slots=True)
class ReplaySession:
    """Top-level result of :func:`replay_session` for one capture session."""

    snapshots: list[FillSnapshot]
    cancelled: list[CancelledOrder]
    target_symbol: str
    fills_skipped_symbol_mismatch: int
    fills_skipped_outside_window: int
    window_seconds: int
    pnl_horizons_seconds: tuple[int, ...] = field(default=DEFAULT_PNL_HORIZONS_SEC)


# ---------------------------------------------------------------------------
# Window stats
# ---------------------------------------------------------------------------


def _window_stats(
    prices: np.ndarray,
    quantities: np.ndarray,
    signed: np.ndarray,
) -> tuple[int, int, float | None, float | None, float | None]:
    """Compute (volume, delta, ratio, vwap, price_change) for a window slice."""
    if len(prices) == 0:
        return 0, 0, None, None, None
    volume = int(quantities.sum())
    delta = int(signed.sum())
    if volume == 0:
        # Defensive — quantities all zero (shouldn't happen on OBS-01 but
        # an empty-input contract guarantee should hold).
        return 0, delta, None, None, None
    ratio = abs(delta) / volume
    vwap = float((prices * quantities).sum() / volume)
    price_change = float(prices[-1] - prices[0])
    return volume, delta, ratio, vwap, price_change


def _zone_proximity(
    fill_price: float,
    zones: list[Zone],
    atr_14: float | None,
) -> tuple[dict[str, float], bool]:
    """Return ``({zone_id: distance_pts}, atr_fallback_flag)``.

    Distance is ``|fill_price - zone_center|`` where ``zone_center = (top + bot) / 2``.
    """
    if not zones:
        return {}, False
    distances = sorted(
        ((z.id, abs(fill_price - (z.top + z.bot) / 2.0)) for z in zones),
        key=lambda x: x[1],
    )
    atr_unavailable = atr_14 is None or (isinstance(atr_14, float) and math.isnan(atr_14))
    if atr_unavailable:
        return (
            dict(distances[:_DEFAULT_ZONE_PROXIMITY_CAP]),
            True,
        )
    # 1×ATR filter, then cap at top 5 nearest
    in_range = [(zid, d) for zid, d in distances if d <= atr_14]  # type: ignore[operator]
    return dict(in_range[:_DEFAULT_ZONE_PROXIMITY_CAP]), False


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def compute_fill_snapshot(
    fill: TradeFill,
    trades: pd.DataFrame,
    contract: ContractSpec,
    *,
    zones: list[Zone] | None = None,
    atr_14: float | None = None,
    window_seconds: int = 60,
    pnl_horizons_seconds: tuple[int, ...] = DEFAULT_PNL_HORIZONS_SEC,
) -> FillSnapshot:
    """Compute a single fill's orderflow snapshot.

    Args:
        fill: The trade fill to snapshot.
        trades: OBS-01 loader output (``event_ts_ns`` ascending sorted).
            **Must be sorted ascending** — caller responsibility; the loader
            guarantees this for normal use.
        contract: :class:`ContractSpec` for PnL dollar conversion.
        zones: Optional list of :class:`Zone` for proximity computation.
        atr_14: ATR(14) in price points, used as the 1×ATR proximity
            filter. Pass ``None`` (or NaN) to skip the filter and use
            top-5-nearest fallback.
        window_seconds: Pre + post window width. Default 60.
        pnl_horizons_seconds: PnL horizons in seconds. Default ``(60, 300, 900)``.

    Returns:
        :class:`FillSnapshot`.

    Example:
        >>> from rithmic_analytics.core.contracts import MNQ
        >>> from rithmic_analytics.core.loader import load_obs01_trades
        >>> trades = load_obs01_trades(Path("MNQ_rth.jsonl"))
        >>> snap = compute_fill_snapshot(my_fill, trades, MNQ)
        >>> snap.realized_pnl[60]
    """
    ts_arr = trades["event_ts_ns"].to_numpy(dtype="int64")
    price_arr = trades["price"].to_numpy(dtype="float64")
    qty_arr = trades["quantity"].to_numpy(dtype="int64")
    signed_arr = trades["signed_qty"].to_numpy(dtype="int64")

    window_ns = window_seconds * _NS_PER_SECOND
    pre_start = fill.fill_ts_ns - window_ns
    pre_end = fill.fill_ts_ns
    post_start = fill.fill_ts_ns
    post_end = fill.fill_ts_ns + window_ns

    # Inclusive bounds via side="left" for lower, side="right" for upper.
    pre_lo = int(np.searchsorted(ts_arr, pre_start, side="left"))
    pre_hi = int(np.searchsorted(ts_arr, pre_end, side="right"))
    post_lo = int(np.searchsorted(ts_arr, post_start, side="left"))
    post_hi = int(np.searchsorted(ts_arr, post_end, side="right"))

    pre_v, pre_d, pre_r, pre_w, pre_pc = _window_stats(
        price_arr[pre_lo:pre_hi], qty_arr[pre_lo:pre_hi], signed_arr[pre_lo:pre_hi]
    )
    post_v, post_d, post_r, post_w, post_pc = _window_stats(
        price_arr[post_lo:post_hi], qty_arr[post_lo:post_hi], signed_arr[post_lo:post_hi]
    )

    # CVD at fill — cumsum over [0, fill_ts] inclusive
    cvd_hi = int(np.searchsorted(ts_arr, fill.fill_ts_ns, side="right"))
    pre_cvd = int(signed_arr[:cvd_hi].sum())

    # CVD 60s after — None if session ends before fill+60s
    sixty_s_target = fill.fill_ts_ns + 60 * _NS_PER_SECOND
    post_cvd_60s: int | None
    if len(ts_arr) == 0 or sixty_s_target > int(ts_arr[-1]):
        post_cvd_60s = None
    else:
        post_idx = int(np.searchsorted(ts_arr, sixty_s_target, side="right"))
        post_cvd_60s = int(signed_arr[:post_idx].sum())

    # PnL at each horizon. Quarantined fills get nan across the board so
    # callers can detect-and-skip without nuisance computation.
    realized_pnl: dict[int, float | None] = {}
    sign = 1 if fill.side == "buy" else -1
    if fill.quarantined or math.isnan(fill.price):
        for h in pnl_horizons_seconds:
            realized_pnl[h] = math.nan
    else:
        for h in pnl_horizons_seconds:
            target_ts = fill.fill_ts_ns + h * _NS_PER_SECOND
            if len(ts_arr) == 0 or target_ts > int(ts_arr[-1]):
                realized_pnl[h] = None
                continue
            idx = int(np.searchsorted(ts_arr, target_ts, side="right")) - 1
            if idx < 0:
                realized_pnl[h] = None
                continue
            future_price = float(price_arr[idx])
            realized_pnl[h] = (
                sign
                * (future_price - fill.price)
                * contract.dollars_per_point
                * fill.quantity
            )

    proximity, atr_fb = _zone_proximity(fill.price, zones or [], atr_14)

    return FillSnapshot(
        fill=fill,
        pre_volume=pre_v,
        pre_delta=pre_d,
        pre_aggressor_ratio=pre_r,
        pre_vwap=pre_w,
        pre_price_change=pre_pc,
        post_volume=post_v,
        post_delta=post_d,
        post_aggressor_ratio=post_r,
        post_vwap=post_w,
        post_price_change=post_pc,
        pre_cvd=pre_cvd,
        post_cvd_60s=post_cvd_60s,
        pre_zone_proximity=proximity,
        atr_fallback=atr_fb,
        realized_pnl=realized_pnl,
    )


def replay_session(
    fills: list[TradeFill],
    trades: pd.DataFrame,
    contract: ContractSpec,
    *,
    zones: list[Zone] | None = None,
    atr_14: float | None = None,
    cancelled: list[CancelledOrder] | None = None,
    window_seconds: int = 60,
    pnl_horizons_seconds: tuple[int, ...] = DEFAULT_PNL_HORIZONS_SEC,
) -> ReplaySession:
    """Replay all fills against one capture session.

    Args:
        fills: List of :class:`TradeFill`. Need not be pre-sorted.
        trades: Output of ``load_obs01_trades`` for the session.
        contract: :class:`ContractSpec` — also defines the target symbol
            for cross-symbol filtering (``fill.symbol == contract.root``).
        zones: Optional zones for proximity (typically
            ``envelope.zones`` from the most recent daily zone JSON).
        atr_14: Optional ATR(14) for the proximity 1×ATR filter.
        cancelled: Optional :class:`CancelledOrder` list, passed through
            into the returned :class:`ReplaySession` for the report.
        window_seconds: Pre + post window width. Default 60.
        pnl_horizons_seconds: PnL horizons. Default ``(60, 300, 900)``.

    Returns:
        :class:`ReplaySession` with sorted snapshots and skip-counter
        metadata.

    Skips (logged WARN, counted in metadata):
        - ``fill.symbol != contract.root`` → ``fills_skipped_symbol_mismatch``
        - ``fill.fill_ts_ns`` outside ``[trades.event_ts_ns.min(), .max()]``
          → ``fills_skipped_outside_window``
    """
    target_symbol = contract.root

    if len(trades) == 0:
        # Whole-session edge case — every fill is "outside window"
        skipped_outside = len(
            [f for f in fills if f.symbol == target_symbol]
        )
        skipped_sym = len(fills) - skipped_outside
        if skipped_outside:
            _LOG.warning(
                f"replay_session: trades DataFrame is empty; "
                f"skipping {skipped_outside} fills as outside-window"
            )
        return ReplaySession(
            snapshots=[],
            cancelled=cancelled or [],
            target_symbol=target_symbol,
            fills_skipped_symbol_mismatch=skipped_sym,
            fills_skipped_outside_window=skipped_outside,
            window_seconds=window_seconds,
            pnl_horizons_seconds=pnl_horizons_seconds,
        )

    ts_min = int(trades["event_ts_ns"].iloc[0])
    ts_max = int(trades["event_ts_ns"].iloc[-1])

    snapshots: list[FillSnapshot] = []
    skipped_sym = 0
    skipped_outside = 0

    for fill in sorted(fills, key=lambda f: f.fill_ts_ns):
        if fill.symbol != target_symbol:
            _LOG.warning(
                f"replay_session: skipping fill {fill.fill_id} "
                f"(symbol={fill.symbol!r} ≠ target {target_symbol!r})"
            )
            skipped_sym += 1
            continue
        if fill.fill_ts_ns < ts_min or fill.fill_ts_ns > ts_max:
            _LOG.warning(
                f"replay_session: skipping fill {fill.fill_id} "
                f"(fill_ts outside session window [{ts_min}, {ts_max}])"
            )
            skipped_outside += 1
            continue
        snapshots.append(
            compute_fill_snapshot(
                fill,
                trades,
                contract,
                zones=zones,
                atr_14=atr_14,
                window_seconds=window_seconds,
                pnl_horizons_seconds=pnl_horizons_seconds,
            )
        )

    return ReplaySession(
        snapshots=snapshots,
        cancelled=cancelled or [],
        target_symbol=target_symbol,
        fills_skipped_symbol_mismatch=skipped_sym,
        fills_skipped_outside_window=skipped_outside,
        window_seconds=window_seconds,
        pnl_horizons_seconds=pnl_horizons_seconds,
    )
