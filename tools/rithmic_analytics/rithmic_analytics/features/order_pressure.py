"""MBO add/cancel pressure detector — RA-035.

Consumes the MBO event lifecycle (A=Add, M=Modify, C=Cancel, F=Fill,
T=Trade) and produces per-(time-bucket, price-bin) diagnostics:

- **add_count / cancel_count / modify_count / fill_count** — raw event
  counts per bin.
- **n_adds** — same as ``add_count``, exposed as the dedupe key so
  consumers can apply their own minimum-sample filter (RA-027 pattern:
  surface `n_trials`, don't bake an n<5 threshold into the compute layer).
- **add_cancel_ratio** — `cancels / adds`. >1 = level is being pulled
  faster than offered; <1 = level is building. `None` when adds == 0.
- **depletion_velocity_per_sec** — `(cancels + fills) / window_seconds`.
  Pure outflow rate; how fast existing orders are leaving the queue.
  Combine with `add_count` to read "is this level building or thinning?".
- **spoof_score** ∈ [0, 1] — fraction of adds at this bin where the same
  order_id was cancelled within `spoof_cancel_window_ms` without ever
  filling. `None` when adds == 0. High values flag "level shown but
  withdrawn" — classic spoofing fingerprint.

This is the lean-stack alternative to MBP10 heatmap rendering. MBO is
Rithmic's per-order lifecycle stream (~13.8M events per overnight
Globex session); MBP10 would be ~28 GB/session. The order-level
information is preserved in MBO; we just don't render it as a heatmap
— we extract numeric signals.

Independence guarantee (Q-new-3 from the sweep): cross-source
attribution to absorption events is **NOT** done here. That's RA-028's
job once ≥5 paired sessions accumulate.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from rithmic_analytics.core.contracts import ContractSpec

_LOG = logging.getLogger("rithmic_analytics.order_pressure")

_NS_PER_SECOND: int = 10**9
_NS_PER_MS: int = 10**6


@dataclass(frozen=True, slots=True)
class OrderPressureConfig:
    """Tuning parameters. Defaults match the RA-035 ticket sweep.

    Attributes:
        window_seconds: Fixed-width time-bucket size. Default 30s.
            Matches absorption's bar grid for downstream join-ability.
        price_bin_ticks: Width of each price bin in contract ticks.
            Default 4 ticks (= 1 pt on MNQ). Sub-VP granularity needed
            for order-level activity.
        spoof_cancel_window_ms: Maximum (cancel_ts - add_ts) milliseconds
            for an add-then-cancel pair to count as spoofing. Default
            500 ms. Tunable; surface in output metadata.
    """

    window_seconds: int = 30
    price_bin_ticks: int = 4
    spoof_cancel_window_ms: int = 500


@dataclass(frozen=True, slots=True)
class OrderPressureRow:
    """One (time-bucket, price-bin) cell."""

    time_bin_ts_ns: int           # left edge of the time window
    price_bin: float              # left edge of the price bin
    n_adds: int
    n_cancels: int
    n_modifies: int
    n_fills: int
    add_cancel_ratio: float | None
    depletion_velocity_per_sec: float
    spoof_score: float | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "time_bin_ts_ns": self.time_bin_ts_ns,
            "price_bin": self.price_bin,
            "n_adds": self.n_adds,
            "n_cancels": self.n_cancels,
            "n_modifies": self.n_modifies,
            "n_fills": self.n_fills,
            "add_cancel_ratio": self.add_cancel_ratio,
            "depletion_velocity_per_sec": self.depletion_velocity_per_sec,
            "spoof_score": self.spoof_score,
        }


@dataclass(frozen=True, slots=True)
class OrderPressureSeries:
    """Result of :func:`compute_order_pressure` — list of cells + metadata.

    ``rows`` is sorted by ``(time_bin_ts_ns, price_bin)`` ascending; the
    grid is sparse (cells with no activity are omitted).
    """

    rows: list[OrderPressureRow]
    config: OrderPressureConfig
    n_input_events: int
    n_unique_order_ids: int
    sessions_covered: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rows": [r.to_dict() for r in self.rows],
            "metadata": {
                "window_seconds": self.config.window_seconds,
                "price_bin_ticks": self.config.price_bin_ticks,
                "spoof_cancel_window_ms": self.config.spoof_cancel_window_ms,
                "n_input_events": self.n_input_events,
                "n_unique_order_ids": self.n_unique_order_ids,
                "sessions_covered": list(self.sessions_covered),
            },
        }


# ---------------------------------------------------------------------------
# Lifecycle resolution
# ---------------------------------------------------------------------------


def _resolve_spoofy_adds(
    mbo: pd.DataFrame,
    *,
    spoof_window_ns: int,
) -> pd.Series:
    """Per-(order_id, add_event) → True if that add is spoofy.

    A spoofy add: same order_id cancelled within ``spoof_window_ns`` AND
    no fill ever observed for that order_id in [add_ts, cancel_ts].

    Returns a boolean Series aligned to ``mbo``'s row index, True on
    rows that are spoofy ADDs. Non-add rows are False.

    Vectorised: groups by ``order_id``, picks earliest A / earliest C /
    earliest F. Compares (C - A) against window + checks F < C OR F
    missing.
    """
    if len(mbo) == 0:
        return pd.Series([], dtype=bool)

    # Build per-order_id lifecycle summary (first A, first C, first F-or-T).
    adds = mbo[mbo["action"] == "A"][["order_id", "event_ts_ns"]].copy()
    cancels = mbo[mbo["action"] == "C"][["order_id", "event_ts_ns"]].copy()
    fills = mbo[mbo["action"].isin(["F", "T"])][["order_id", "event_ts_ns"]].copy()

    if len(adds) == 0:
        return pd.Series([False] * len(mbo), dtype=bool, index=mbo.index)

    add_ts = adds.groupby("order_id", observed=True)["event_ts_ns"].min()
    cancel_ts = (
        cancels.groupby("order_id", observed=True)["event_ts_ns"].min()
        if len(cancels) else pd.Series([], dtype="int64")
    )
    fill_ts = (
        fills.groupby("order_id", observed=True)["event_ts_ns"].min()
        if len(fills) else pd.Series([], dtype="int64")
    )

    # Build summary frame keyed by order_id
    summary = pd.DataFrame({"add_ts": add_ts})
    summary["cancel_ts"] = cancel_ts
    summary["fill_ts"] = fill_ts

    # Spoofy iff: has cancel + cancel within window AND (no fill OR fill after cancel)
    has_cancel = summary["cancel_ts"].notna()
    cancel_within_window = (
        (summary["cancel_ts"] - summary["add_ts"]) <= spoof_window_ns
    ) & (summary["cancel_ts"] >= summary["add_ts"])
    no_fill_or_fill_after_cancel = (
        summary["fill_ts"].isna() | (summary["fill_ts"] >= summary["cancel_ts"])
    )
    summary["is_spoofy"] = has_cancel & cancel_within_window & no_fill_or_fill_after_cancel

    spoofy_order_ids = set(summary.index[summary["is_spoofy"]].tolist())
    # Mark the ADD row itself as spoofy (a single add per order in production;
    # multiple A events for same order_id is degenerate but possible).
    mask = (mbo["action"] == "A") & mbo["order_id"].isin(spoofy_order_ids)
    return mask


# ---------------------------------------------------------------------------
# Binning + aggregation
# ---------------------------------------------------------------------------


def _bin_columns(
    mbo: pd.DataFrame,
    *,
    window_ns: int,
    price_bin_size: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Returns ``(time_bin_ts_ns, price_bin)`` arrays for each MBO row.

    Price bin = ``floor(price / bin_size) * bin_size``. NaN prices map to
    NaN bins (which groupby drops — acceptable, NaN-price events are
    typically T/C lifecycle events with no level info).
    """
    ts = mbo["event_ts_ns"].to_numpy(dtype="int64")
    time_bin = (ts // window_ns) * window_ns
    prices = mbo["price"].to_numpy(dtype="float64")
    price_bin = np.floor(prices / price_bin_size) * price_bin_size
    return time_bin, price_bin


def _safe_ratio(num: float, den: float) -> float | None:
    """``num / den`` with ``None`` when ``den == 0``."""
    if den == 0:
        return None
    return num / den


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def compute_order_pressure(
    mbo: pd.DataFrame,
    contract: ContractSpec,
    *,
    config: OrderPressureConfig | None = None,
) -> OrderPressureSeries:
    """Compute per-(time-bin, price-bin) order-flow pressure diagnostics.

    Args:
        mbo: MBO loader output. Required columns: ``event_ts_ns`` (int64
            sorted ascending), ``action`` (category: A/M/C/F/T),
            ``price`` (float64, NaN-tolerated), ``order_id`` (string).
            ``side`` is not consumed today but reserved for future
            side-aware aggregation.
        contract: :class:`ContractSpec` for tick-size based binning.
        config: Tuning parameters. Defaults to :class:`OrderPressureConfig()`.

    Returns:
        :class:`OrderPressureSeries`. Empty input → empty rows + metadata.

    Performance: vectorised pandas groupby; 13.8M events fits in well
    under 60s on modern hardware (benchmarked at ~30s).
    """
    config = config or OrderPressureConfig()

    if len(mbo) == 0:
        return OrderPressureSeries(
            rows=[], config=config, n_input_events=0, n_unique_order_ids=0,
        )

    window_ns = config.window_seconds * _NS_PER_SECOND
    spoof_window_ns = config.spoof_cancel_window_ms * _NS_PER_MS
    price_bin_size = config.price_bin_ticks * contract.tick_size

    # Per-row spoof flag (only ADD events can be spoofy)
    spoofy_mask = _resolve_spoofy_adds(mbo, spoof_window_ns=spoof_window_ns)

    time_bin_arr, price_bin_arr = _bin_columns(
        mbo, window_ns=window_ns, price_bin_size=price_bin_size,
    )

    # Build the aggregation frame
    agg = pd.DataFrame({
        "time_bin": time_bin_arr,
        "price_bin": price_bin_arr,
        "action": mbo["action"].astype("string").to_numpy(),
        "is_spoofy": spoofy_mask.to_numpy(),
    })

    # Drop NaN price bins (typically T/C lifecycle events without level info).
    agg = agg.dropna(subset=["price_bin"])
    if len(agg) == 0:
        return OrderPressureSeries(
            rows=[], config=config,
            n_input_events=len(mbo),
            n_unique_order_ids=int(mbo["order_id"].nunique()),
        )

    # Per-bin counts by action
    by_bin = (
        agg.groupby(["time_bin", "price_bin"], observed=True)
        .agg(
            n_adds=("action", lambda s: int((s == "A").sum())),
            n_cancels=("action", lambda s: int((s == "C").sum())),
            n_modifies=("action", lambda s: int((s == "M").sum())),
            n_fills=("action", lambda s: int(((s == "F") | (s == "T")).sum())),
            n_spoofy_adds=("is_spoofy", "sum"),
        )
        .reset_index()
        .sort_values(["time_bin", "price_bin"])
    )

    rows: list[OrderPressureRow] = []
    window_sec_f = float(config.window_seconds)
    for _, r in by_bin.iterrows():
        n_adds = int(r["n_adds"])
        n_cancels = int(r["n_cancels"])
        n_modifies = int(r["n_modifies"])
        n_fills = int(r["n_fills"])
        n_spoofy = int(r["n_spoofy_adds"])

        ratio = _safe_ratio(n_cancels, n_adds)
        depletion = (n_cancels + n_fills) / window_sec_f
        spoof = _safe_ratio(n_spoofy, n_adds)

        rows.append(OrderPressureRow(
            time_bin_ts_ns=int(r["time_bin"]),
            price_bin=float(r["price_bin"]),
            n_adds=n_adds,
            n_cancels=n_cancels,
            n_modifies=n_modifies,
            n_fills=n_fills,
            add_cancel_ratio=ratio,
            depletion_velocity_per_sec=depletion,
            spoof_score=spoof,
        ))

    sessions: list[str] = []
    if "session_id" in mbo.columns:
        sessions = sorted({str(s) for s in mbo["session_id"].dropna().unique()})

    return OrderPressureSeries(
        rows=rows,
        config=config,
        n_input_events=len(mbo),
        n_unique_order_ids=int(mbo["order_id"].nunique()),
        sessions_covered=sessions,
    )


def aggregate_to_session_summary(
    pressure: OrderPressureSeries,
) -> dict[str, dict[str, Any]]:
    """Collapse the (time, price) grid to per-price-bin session totals.

    For each price bin, sum the counts across all time windows and
    compute summary statistics (max spoof_score, max depletion_velocity,
    total n_adds). Useful for morning chart-prep: "which levels saw the
    most spoof activity overnight?"

    Returns:
        Dict keyed by ``str(price_bin)``: ``{n_adds_total, n_cancels_total,
        n_fills_total, max_depletion_velocity_per_sec, max_spoof_score,
        n_time_windows}``. Empty input → empty dict.
    """
    if not pressure.rows:
        return {}

    by_price: dict[float, list[OrderPressureRow]] = {}
    for row in pressure.rows:
        by_price.setdefault(row.price_bin, []).append(row)

    result: dict[str, dict[str, Any]] = {}
    for price_bin, bin_rows in sorted(by_price.items()):
        n_adds_total = sum(r.n_adds for r in bin_rows)
        n_cancels_total = sum(r.n_cancels for r in bin_rows)
        n_fills_total = sum(r.n_fills for r in bin_rows)

        max_depletion = max(r.depletion_velocity_per_sec for r in bin_rows)
        spoof_values = [
            r.spoof_score for r in bin_rows
            if r.spoof_score is not None and not math.isnan(r.spoof_score)
        ]
        max_spoof = max(spoof_values) if spoof_values else None

        result[f"{price_bin:.2f}"] = {
            "n_adds_total": n_adds_total,
            "n_cancels_total": n_cancels_total,
            "n_fills_total": n_fills_total,
            "max_depletion_velocity_per_sec": max_depletion,
            "max_spoof_score": max_spoof,
            "n_time_windows": len(bin_rows),
        }
    return result
