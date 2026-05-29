"""Hidden-liquidity inference — detect levels where traded volume exceeded visible.

For each aggressive trade in OBS-01, look up the MBP10 snapshot just before
the trade and compare the traded quantity against the **visible size at the
traded price level** on the aggressed side. If ``traded / visible >= N``, the
level had hidden liquidity (iceberg, queue refill, or off-book interest).

Aggregation: per ``(session_id, price)`` — tick-aligned, no banding. The
detector's output is precision-tier; consumers band for visualization.

Storage cost: requires MBP10 capture (~28 GB / RTH session at full fidelity).
Out of the lean stack by default; opt-in for institutional-flow studies.

Noise caveat (documented in the threshold rationale): between MBP10 snapshots,
orders can be added AND consumed. A trade of 300 against visible 100 doesn't
strictly mean 200 hidden — it could mean 100 visible consumed, 200 new visible
added mid-trade, then those consumed too. The default N=3 threshold provides
margin against this aliasing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import pandas as pd

from rithmic_analytics.core.contracts import ContractSpec

_NS_PER_MS: int = 10**6
_PX_PREC: float = 1e-9  # equality tolerance for tick-aligned price comparison

_ASK_PX_COLS: list[str] = [f"ask_px_{n:02d}" for n in range(10)]
_ASK_SZ_COLS: list[str] = [f"ask_sz_{n:02d}" for n in range(10)]
_BID_PX_COLS: list[str] = [f"bid_px_{n:02d}" for n in range(10)]
_BID_SZ_COLS: list[str] = [f"bid_sz_{n:02d}" for n in range(10)]


@dataclass(frozen=True, slots=True)
class HiddenLiquidityConfig:
    """Tunable parameters for the hidden-liquidity detector.

    Default thresholds calibrated for MNQ (0.25 tick). Tune
    ``hidden_threshold_n`` for different volatility regimes — higher = more
    conservative, fewer false positives but misses subtle icebergs.

    Attributes:
        hidden_threshold_n: ``traded / visible`` ratio required to flag
            hidden liquidity. Default 3.0 (moderate). 2× catches normal
            queue-refill noise; 5× only catches obvious icebergs.
        mbp10_pre_lookback_ms: MBP10 snapshot offset before the trade.
            Default 1.0 ms. MBP10 runs ~900 updates/sec on MNQ — 1ms is
            almost always within one update. Increase if data has gaps;
            decrease to 0.5ms for stricter freshness.
        mbp10_tolerance_ms: Max staleness for the merge_asof lookup. Beyond
            this, the visible_size is treated as unavailable and the trade
            is counted in ``trades_outside_mbp10_depth``. Default 100 ms.
    """

    hidden_threshold_n: float = 3.0
    mbp10_pre_lookback_ms: float = 1.0
    mbp10_tolerance_ms: float = 100.0


@dataclass(frozen=True, slots=True)
class HiddenLiquidityRecord:
    """Per-(session, price) aggregate."""

    session_id: str
    price: float
    side: Literal["buy", "sell"]
    total_traded: int
    total_visible_pre: int
    hidden_estimate: int  # max(0, total_traded - total_visible_pre × N)
    trade_count: int
    ratio: float  # total_traded / max(total_visible_pre, 1)

    def to_dict(self) -> dict[str, object]:
        return {
            "session_id": self.session_id,
            "price": self.price,
            "side": self.side,
            "total_traded": self.total_traded,
            "total_visible_pre": self.total_visible_pre,
            "hidden_estimate": self.hidden_estimate,
            "trade_count": self.trade_count,
            "ratio": self.ratio,
        }


@dataclass(frozen=True, slots=True)
class HiddenLiquiditySummary:
    """Top-level result of :func:`infer_hidden_liquidity`."""

    records: list[HiddenLiquidityRecord]
    trades_processed: int
    trades_skipped_unknown_aggressor: int
    trades_outside_mbp10_depth: int
    sessions_covered: list[str] = field(default_factory=list)


def _find_matching_depth_vectorized(
    prices: np.ndarray, px_matrix: np.ndarray, sz_matrix: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Vectorized per-row search for matching price across the 10 depth levels.

    Returns:
        (visible_size, depth_level, found_mask) — same length as ``prices``.
        ``depth_level`` is -1 where no match; ``visible_size`` is 0 there.
    """
    match_matrix = np.abs(px_matrix - prices[:, None]) < _PX_PREC
    found_mask = match_matrix.any(axis=1)
    # argmax returns 0 for all-False rows, which we mask out below
    raw_idx = match_matrix.argmax(axis=1)
    depth_level = np.where(found_mask, raw_idx, -1)
    visible_size = np.where(
        found_mask,
        np.take_along_axis(sz_matrix, np.maximum(raw_idx, 0)[:, None], axis=1)[:, 0],
        0,
    )
    return visible_size.astype("int64"), depth_level.astype("int64"), found_mask


def infer_hidden_liquidity(
    trades: pd.DataFrame,
    mbp10: pd.DataFrame,
    contract: ContractSpec,
    *,
    config: HiddenLiquidityConfig | None = None,
    return_per_trade: bool = False,
) -> HiddenLiquiditySummary | tuple[HiddenLiquiditySummary, pd.DataFrame]:
    """Infer hidden liquidity from trades + MBP10.

    Args:
        trades: OBS-01 loader output (``event_ts_ns``, ``price``,
            ``quantity``, ``aggressor_side``, ``session_id``).
        mbp10: MBP10 loader output (``event_ts_ns`` + 60 depth columns).
        contract: ``ContractSpec``. Unused for inference itself but accepted
            for API symmetry with other detectors.
        config: Tuning parameters. Defaults to ``HiddenLiquidityConfig()``.
        return_per_trade: When ``True``, returns ``(summary, per_trade_df)``
            tuple. The per-trade DataFrame columns: ``event_ts_ns``, ``price``,
            ``side``, ``traded_qty``, ``visible_size_pre``, ``ratio``,
            ``depth_level``, ``session_id``. Default ``False`` returns just
            the summary.

    Returns:
        ``HiddenLiquiditySummary`` by default. If ``return_per_trade=True``,
        a tuple of (summary, per-trade DataFrame) for ad-hoc inspection.

    Example:
        >>> from rithmic_analytics.core.contracts import MNQ
        >>> from rithmic_analytics.core.loader import load_obs01_trades, load_mbp10
        >>> trades = load_obs01_trades(Path("obs01.jsonl"))
        >>> mbp10 = load_mbp10(Path("mbp10.jsonl"))
        >>> summary = infer_hidden_liquidity(trades, mbp10, MNQ)
        >>> top_hidden = sorted(summary.records, key=lambda r: -r.hidden_estimate)[:5]
    """
    config = config or HiddenLiquidityConfig()
    # Reference contract to silence unused-argument warning; kept in API for
    # symmetry with other detectors.
    _ = contract

    # ---- Filter to known-aggressor trades ----
    known_mask = trades["aggressor_side"].isin(["buy", "sell"])
    known = trades[known_mask].sort_values("event_ts_ns").reset_index(drop=True)
    skipped_unknown = int((~known_mask).sum())

    if len(known) == 0 or len(mbp10) == 0:
        return _empty_summary(
            trades_processed=len(known),
            skipped_unknown=skipped_unknown,
            outside_depth=len(known),
            sessions=sorted(set(known.get("session_id", pd.Series(dtype="string"))))
            if "session_id" in known.columns
            else [],
            return_per_trade=return_per_trade,
        )

    # ---- Asof-join: trade time - 1ms → most recent MBP10 snapshot ----
    pre_offset_ns = int(config.mbp10_pre_lookback_ms * _NS_PER_MS)
    tol_ns = int(config.mbp10_tolerance_ms * _NS_PER_MS)
    known["_lookup_ts_ns"] = known["event_ts_ns"] - pre_offset_ns

    mbp10_sorted = mbp10.sort_values("event_ts_ns").reset_index(drop=True)
    mbp10_renamed = mbp10_sorted.rename(columns={"event_ts_ns": "mbp10_event_ts_ns"})

    merged = pd.merge_asof(
        known.sort_values("_lookup_ts_ns"),
        mbp10_renamed,
        left_on="_lookup_ts_ns",
        right_on="mbp10_event_ts_ns",
        direction="backward",
        tolerance=tol_ns,
    )

    # Rows with no MBP10 snapshot inside tolerance: ask_px_00 is NaN.
    stale_mask = merged["ask_px_00"].isna()
    fresh = merged[~stale_mask].copy()

    # ---- Per-side depth match ----
    buy_mask = fresh["aggressor_side"] == "buy"
    sell_mask = fresh["aggressor_side"] == "sell"

    visible = np.zeros(len(fresh), dtype="int64")
    depth_level = np.full(len(fresh), -1, dtype="int64")
    found = np.zeros(len(fresh), dtype=bool)

    if buy_mask.any():
        prices = fresh.loc[buy_mask, "price"].to_numpy(dtype="float64")
        px = fresh.loc[buy_mask, _ASK_PX_COLS].to_numpy(dtype="float64")
        sz = fresh.loc[buy_mask, _ASK_SZ_COLS].to_numpy(dtype="int32")
        vis, lvl, fnd = _find_matching_depth_vectorized(prices, px, sz)
        idx = np.where(buy_mask.to_numpy())[0]
        visible[idx] = vis
        depth_level[idx] = lvl
        found[idx] = fnd

    if sell_mask.any():
        prices = fresh.loc[sell_mask, "price"].to_numpy(dtype="float64")
        px = fresh.loc[sell_mask, _BID_PX_COLS].to_numpy(dtype="float64")
        sz = fresh.loc[sell_mask, _BID_SZ_COLS].to_numpy(dtype="int32")
        vis, lvl, fnd = _find_matching_depth_vectorized(prices, px, sz)
        idx = np.where(sell_mask.to_numpy())[0]
        visible[idx] = vis
        depth_level[idx] = lvl
        found[idx] = fnd

    fresh["visible_size_pre"] = visible
    fresh["depth_level"] = depth_level
    fresh["ratio"] = fresh["quantity"] / np.maximum(visible, 1)

    # Count "outside-depth" trades: either stale MBP10 OR price not in any level.
    outside_depth = int(stale_mask.sum()) + int((~found).sum())

    # ---- Aggregate per (session, price, side) ----
    in_depth = fresh[found]

    if len(in_depth) == 0:
        records: list[HiddenLiquidityRecord] = []
    else:
        agg = (
            in_depth.groupby(["session_id", "price", "aggressor_side"], observed=True)
            .agg(
                total_traded=("quantity", "sum"),
                total_visible_pre=("visible_size_pre", "sum"),
                trade_count=("quantity", "size"),
            )
            .reset_index()
        )
        agg["hidden_estimate"] = np.maximum(
            0, agg["total_traded"] - agg["total_visible_pre"] * config.hidden_threshold_n
        ).astype("int64")
        agg["ratio"] = agg["total_traded"] / np.maximum(agg["total_visible_pre"], 1)
        agg = agg.sort_values("hidden_estimate", ascending=False).reset_index(drop=True)

        records = [
            HiddenLiquidityRecord(
                session_id=str(row["session_id"]),
                price=float(row["price"]),
                side=str(row["aggressor_side"]),  # type: ignore[arg-type]
                total_traded=int(row["total_traded"]),
                total_visible_pre=int(row["total_visible_pre"]),
                hidden_estimate=int(row["hidden_estimate"]),
                trade_count=int(row["trade_count"]),
                ratio=float(row["ratio"]),
            )
            for _, row in agg.iterrows()
        ]

    sessions = sorted({str(s) for s in known["session_id"].unique() if isinstance(s, str)})

    summary = HiddenLiquiditySummary(
        records=records,
        trades_processed=len(known),
        trades_skipped_unknown_aggressor=skipped_unknown,
        trades_outside_mbp10_depth=outside_depth,
        sessions_covered=sessions,
    )

    if not return_per_trade:
        return summary

    per_trade = fresh[
        [
            "event_ts_ns",
            "price",
            "aggressor_side",
            "quantity",
            "visible_size_pre",
            "ratio",
            "depth_level",
            "session_id",
        ]
    ].rename(columns={"aggressor_side": "side", "quantity": "traded_qty"})
    return summary, per_trade.reset_index(drop=True)


def _empty_summary(
    *,
    trades_processed: int,
    skipped_unknown: int,
    outside_depth: int,
    sessions: list[str],
    return_per_trade: bool,
) -> HiddenLiquiditySummary | tuple[HiddenLiquiditySummary, pd.DataFrame]:
    summary = HiddenLiquiditySummary(
        records=[],
        trades_processed=trades_processed,
        trades_skipped_unknown_aggressor=skipped_unknown,
        trades_outside_mbp10_depth=outside_depth,
        sessions_covered=sessions,
    )
    if return_per_trade:
        empty_df = pd.DataFrame(
            columns=[
                "event_ts_ns", "price", "side", "traded_qty",
                "visible_size_pre", "ratio", "depth_level", "session_id",
            ]
        )
        return summary, empty_df
    return summary
