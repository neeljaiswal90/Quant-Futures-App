"""JSONL loaders for Rithmic stream outputs (OBS-01, MBP1, MBO).

All loaders return pandas DataFrames whose timestamp column is named
``event_ts_ns`` and is dtype ``int64`` — this is the canonical exchange-emitted
timestamp the rest of the analytics layer buckets on (per the architectural
plan's Decisions block). The host-side receipt timestamp is exposed as
``recv_ts_ns`` for QA / latency analysis only; never use it for binning.

On-disk schemas are documented in ``docs/jsonl-inspection-report.md``.

Example:
    >>> from pathlib import Path
    >>> from rithmic_analytics.core.loader import load_obs01_trades
    >>> df = load_obs01_trades(Path("data/probes/infra01/full/l1-trade-post04d.obs01.jsonl"))
    >>> df.shape[0]
    104358
    >>> df["event_ts_ns"].dtype
    dtype('int64')
"""

from __future__ import annotations

import json
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from rithmic_analytics.core.contracts import MNQ, ContractSpec

# Column → dtype map for each stream. Used both for return-value casts and to
# construct empty-DataFrame returns with the correct schema. dtype strings are
# pandas-accepted aliases ("int64", "category", "string").
_OBS01_DTYPES: dict[str, str] = {
    "event_ts_ns": "int64",
    "recv_ts_ns": "int64",
    "session_id": "string",
    "price": "float64",
    "quantity": "int32",
    "aggressor_side": "category",
    "trade_id": "string",
    "signed_qty": "int32",
}

_MBP1_DTYPES: dict[str, str] = {
    "event_ts_ns": "int64",
    "recv_ts_ns": "int64",
    "bid_px_00": "float64",
    "bid_sz_00": "int32",
    "bid_ct_00": "int32",
    "ask_px_00": "float64",
    "ask_sz_00": "int32",
    "ask_ct_00": "int32",
    # RA-037: derived spread columns. spread_ticks/spread_bps are NaN
    # whenever either side is NaN (one-sided book); is_crossed is True
    # when ask < bid (ticks-rounded < 0). NaN spread → is_crossed=False.
    "spread_ticks": "float64",
    "spread_bps": "float64",
    "is_crossed": "bool",
}

_MBO_DTYPES: dict[str, str] = {
    "event_ts_ns": "int64",
    "recv_ts_ns": "int64",
    "sequence": "int64",
    "action": "category",
    "side": "category",
    "price": "float64",
    "size": "int32",
    "order_id": "string",
}


def _build_mbp10_dtypes() -> dict[str, str]:
    """Programmatically construct the 62-column dtype map for MBP10."""
    out: dict[str, str] = {"event_ts_ns": "int64", "recv_ts_ns": "int64"}
    for n in range(10):
        for side in ("bid", "ask"):
            out[f"{side}_px_{n:02d}"] = "float64"
            out[f"{side}_sz_{n:02d}"] = "int32"
            out[f"{side}_ct_{n:02d}"] = "int32"
    return out


_MBP10_DTYPES: dict[str, str] = _build_mbp10_dtypes()


def _empty_frame(schema: dict[str, str]) -> pd.DataFrame:
    """Return an empty DataFrame whose columns/dtypes match ``schema``."""
    return pd.DataFrame({col: pd.Series(dtype=dtype) for col, dtype in schema.items()})


def load_obs01_trades(
    path: Path,
    *,
    unknown_aggressor_warn_threshold: float = 0.01,
) -> pd.DataFrame:
    """Load OBS-01 normalized trades from a JSONL file.

    The on-disk envelope nests trade fields inside ``payload``. This loader
    streams the file, filters to ``type == "TRADE"`` (drops QUOTE envelopes),
    flattens payload, renames the canonical timestamp
    (``payload.exchange_event_ts_ns -> event_ts_ns``, ``sidecar_recv_ts_ns ->
    recv_ts_ns``), casts ns strings to int64, computes ``signed_qty`` as int32,
    and casts ``aggressor_side`` to a pandas Categorical.

    Missing/null ``aggressor_side`` values are coerced to ``"unknown"``
    (``signed_qty=0``). If the fraction of unknown aggressors exceeds
    ``unknown_aggressor_warn_threshold``, a ``UserWarning`` is emitted — per the
    JSONL schema reference Rithmic populates aggressor_side ≥99% of the time, so
    elevated unknowns usually indicate a feed-quality issue.

    Args:
        path: Path to the OBS-01 ``.jsonl`` file.
        unknown_aggressor_warn_threshold: Fraction (0–1) of unknown aggressors
            above which to emit a warning. Defaults to 0.01 (1%).

    Returns:
        DataFrame with columns (in this order):

        - ``event_ts_ns`` (int64) — canonical exchange-emitted timestamp.
          **Use this for all time-bucket binning** (per plan Decisions block).
        - ``recv_ts_ns`` (int64) — host receipt timestamp; QA use only.
        - ``session_id`` (string) — session identifier from the envelope.
        - ``price`` (float64) — tick-aligned trade price.
        - ``quantity`` (int32) — contract count.
        - ``aggressor_side`` (category) — ``"buy"`` / ``"sell"`` / ``"unknown"``.
        - ``trade_id`` (string) — exchange trade identifier.
        - ``signed_qty`` (int32) — ``quantity`` signed by aggressor direction
          (buy → +qty, sell → -qty, unknown → 0).

        Returns an empty DataFrame (with the correct dtypes) for a 0-byte file
        or when no TRADE envelopes are present. The empty case emits a
        ``UserWarning`` *unless* the file was zero bytes.

    Example:
        >>> from pathlib import Path
        >>> df = load_obs01_trades(Path("l1-trade.jsonl"))
        >>> df["event_ts_ns"].dtype.name
        'int64'
        >>> df["signed_qty"].dtype.name
        'int32'
    """
    file_size = path.stat().st_size
    rows: list[dict[str, Any]] = []

    if file_size > 0:
        with path.open("r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line:
                    continue
                rec: dict[str, Any] = json.loads(line)
                if rec.get("type") != "TRADE":
                    continue
                payload: dict[str, Any] = rec.get("payload") or {}
                aggressor = payload.get("aggressor_side") or "unknown"
                rows.append(
                    {
                        "event_ts_ns": int(payload["exchange_event_ts_ns"]),
                        "recv_ts_ns": int(payload["sidecar_recv_ts_ns"]),
                        "session_id": rec["session_id"],
                        "price": float(payload["price"]),
                        "quantity": int(payload["quantity"]),
                        "aggressor_side": aggressor,
                        "trade_id": payload["trade_id"],
                    }
                )

    if not rows:
        if file_size > 0:
            warnings.warn(
                "No TRADE envelopes found in non-empty OBS-01 file. Check that "
                "the `type` field is populated.",
                UserWarning,
                stacklevel=2,
            )
        return _empty_frame(_OBS01_DTYPES)

    df = pd.DataFrame(rows)
    df["session_id"] = df["session_id"].astype("string")
    df["trade_id"] = df["trade_id"].astype("string")
    df["quantity"] = df["quantity"].astype("int32")
    df["aggressor_side"] = df["aggressor_side"].astype("category")

    sign = (
        df["aggressor_side"]
        .map({"buy": 1, "sell": -1, "unknown": 0})
        .fillna(0)
        .astype("int32")
    )
    df["signed_qty"] = (df["quantity"] * sign).astype("int32")

    unknown_count = int((df["aggressor_side"] == "unknown").sum())
    unknown_frac = unknown_count / len(df)
    if unknown_frac > unknown_aggressor_warn_threshold:
        warnings.warn(
            f"OBS-01 unknown-aggressor fraction {unknown_frac:.4f} exceeds "
            f"threshold {unknown_aggressor_warn_threshold:.4f} "
            f"({unknown_count}/{len(df)} rows). signed_qty=0 for these rows.",
            UserWarning,
            stacklevel=2,
        )

    return df[list(_OBS01_DTYPES.keys())]


def _compute_spread_columns(
    df: pd.DataFrame, contract: ContractSpec,
) -> pd.DataFrame:
    """Append RA-037 derived spread columns to a flat MBP1 DataFrame.

    Operates in-place on a copy: callers receive ``df`` with three new
    columns (``spread_ticks``, ``spread_bps``, ``is_crossed``).

    Semantics:
        - ``spread_ticks``: ``(ask_px_00 - bid_px_00) / tick_size``, float64.
          NaN when either side is NaN OR ``0.0`` (one-sided book — empirically
          ~99.8% of MNQ Globex MBP1 records, where the on-disk stream is delta-
          shaped: each record updates one side and zeros the other. The
          structural fix lives in ``ops/normalize_probe.py`` forward-filling
          the unchanged side; tracked as RA-041).
        - ``spread_bps``: ``(ask - bid) / mid * 10_000``, float64. NaN when
          either side is NaN/zero or mid is non-positive.
        - ``is_crossed``: ``spread_ticks < 0`` (strict). bool. False when NaN.

    Crossed books (genuine ``0 < ask < bid``) are preserved as-is rather than
    filtered — they signal feed anomalies during fast-market bursts and
    downstream consumers may want to flag them in QA reports.
    """
    bid = df["bid_px_00"]
    ask = df["ask_px_00"]
    # RA-040 fix: treat 0.0 as missing on either side. The on-disk MBP1 stream
    # uses 0.0 (not NaN) to mark the un-updated side of a delta record.
    one_sided = (bid <= 0) | (ask <= 0) | bid.isna() | ask.isna()

    raw_spread_pts = ask - bid
    spread_ticks = raw_spread_pts / contract.tick_size
    df["spread_ticks"] = spread_ticks.where(~one_sided, np.nan).astype("float64")

    mid = (bid + ask) / 2.0
    with np.errstate(divide="ignore", invalid="ignore"):
        bps = np.where(
            (~one_sided) & (mid > 0) & np.isfinite(mid),
            raw_spread_pts / mid * 10_000.0,
            np.nan,
        )
    df["spread_bps"] = pd.Series(bps, index=df.index, dtype="float64")
    # NaN < 0 is False — gives us the desired "False when one-sided" behavior.
    df["is_crossed"] = (df["spread_ticks"] < 0).astype("bool")
    return df


def load_mbp1(path: Path, *, contract: ContractSpec = MNQ) -> pd.DataFrame:
    """Load MBP1 (top-of-book) updates from a databento-flat JSONL file.

    The on-disk schema is already flat (no payload nesting). This loader renames
    ``ts_event_ns -> event_ts_ns`` and ``ts_recv_ns -> recv_ts_ns`` for
    cross-stream consistency, then casts ns-strings to int64 and size/count
    columns to int32. RA-037: derived spread columns are appended.

    Args:
        path: Path to the MBP1 normalized ``.jsonl`` file.
        contract: Contract metadata (drives ``tick_size`` for spread_ticks).
            Defaults to ``MNQ``.

    Returns:
        DataFrame with columns: ``event_ts_ns`` (int64), ``recv_ts_ns`` (int64),
        ``bid_px_00`` / ``ask_px_00`` (float64), ``bid_sz_00`` / ``ask_sz_00`` /
        ``bid_ct_00`` / ``ask_ct_00`` (int32), plus RA-037 derived:
        ``spread_ticks`` (float64), ``spread_bps`` (float64), ``is_crossed`` (bool).

        Empty DataFrame with correct dtypes if the file is 0 bytes or empty.

    Example:
        >>> df = load_mbp1(Path("mbp1.jsonl"))
        >>> df["event_ts_ns"].dtype.name
        'int64'
        >>> df["spread_ticks"].dtype.name
        'float64'
    """
    if path.stat().st_size == 0:
        return _empty_frame(_MBP1_DTYPES)

    df = pd.read_json(path, lines=True)
    if df.empty:
        return _empty_frame(_MBP1_DTYPES)

    df = df.rename(columns={"ts_event_ns": "event_ts_ns", "ts_recv_ns": "recv_ts_ns"})
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["recv_ts_ns"] = df["recv_ts_ns"].astype("int64")
    for col in ("bid_sz_00", "bid_ct_00", "ask_sz_00", "ask_ct_00"):
        df[col] = df[col].astype("int32")
    df = _compute_spread_columns(df, contract)
    return df[list(_MBP1_DTYPES.keys())]


# ---------------------------------------------------------------------------
# RA-037: spread summary aggregation
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SpreadSummary:
    """Aggregate liquidity-quality summary for one MBP1 capture session.

    All ``*_ticks`` fields are in contract ticks (MNQ tick = 0.25 index points).
    All ``*_bps`` fields are basis points relative to mid.
    Counts are exact integers; percentiles use linear interpolation
    (pandas default).

    Attributes:
        mean_ticks: Time-unweighted mean of ``spread_ticks`` across rows where
            the spread was defined. Light/fast aggregate; for time-weighted
            see daily reports.
        p50_ticks: 50th-percentile spread in ticks (median).
        p95_ticks: 95th-percentile spread in ticks.
        p99_ticks: 99th-percentile spread in ticks.
        max_ticks: Max observed spread (NaN-safe; excludes crossed books).
        mean_bps: Mean spread in basis points.
        time_above_1tick_pct: Fraction (0-1) of rows where spread > 1 tick.
        time_above_2tick_pct: Fraction (0-1) of rows where spread > 2 ticks.
        n_records: Total MBP1 rows fed in (incl. NaN/crossed).
        n_crossed_quotes: Count of ``is_crossed`` rows.
    """

    mean_ticks: float
    p50_ticks: float
    p95_ticks: float
    p99_ticks: float
    max_ticks: float
    mean_bps: float
    time_above_1tick_pct: float
    time_above_2tick_pct: float
    n_records: int
    n_crossed_quotes: int

    def to_dict(self) -> dict[str, float | int]:
        """Plain-dict view for JSON serialization."""
        return {
            "mean_ticks": self.mean_ticks,
            "p50_ticks": self.p50_ticks,
            "p95_ticks": self.p95_ticks,
            "p99_ticks": self.p99_ticks,
            "max_ticks": self.max_ticks,
            "mean_bps": self.mean_bps,
            "time_above_1tick_pct": self.time_above_1tick_pct,
            "time_above_2tick_pct": self.time_above_2tick_pct,
            "n_records": self.n_records,
            "n_crossed_quotes": self.n_crossed_quotes,
        }


def _nan_summary(n_records: int, n_crossed: int) -> SpreadSummary:
    return SpreadSummary(
        mean_ticks=float("nan"),
        p50_ticks=float("nan"),
        p95_ticks=float("nan"),
        p99_ticks=float("nan"),
        max_ticks=float("nan"),
        mean_bps=float("nan"),
        time_above_1tick_pct=float("nan"),
        time_above_2tick_pct=float("nan"),
        n_records=n_records,
        n_crossed_quotes=n_crossed,
    )


def summarize_spread(mbp1_df: pd.DataFrame) -> SpreadSummary:
    """Aggregate per-row spread columns into a single ``SpreadSummary``.

    Excludes NaN spreads (one-sided books) and crossed quotes from the
    distribution stats; both are still surfaced via ``n_records`` and
    ``n_crossed_quotes`` so the consumer can compute coverage.

    Args:
        mbp1_df: DataFrame returned by ``load_mbp1`` (must carry the RA-037
            derived columns ``spread_ticks``, ``spread_bps``, ``is_crossed``).

    Returns:
        ``SpreadSummary``. All distribution fields are NaN when the input is
        empty or fully one-sided/crossed (n_records still reflects input length).
    """
    n_records = int(len(mbp1_df))
    if n_records == 0:
        return _nan_summary(0, 0)

    n_crossed = int(mbp1_df["is_crossed"].sum())
    # Distribution stats from finite, non-crossed rows only.
    ticks = mbp1_df["spread_ticks"]
    bps = mbp1_df["spread_bps"]
    mask = ticks.notna() & (~mbp1_df["is_crossed"])
    valid_ticks = ticks[mask]
    valid_bps = bps[mask]

    if len(valid_ticks) == 0:
        return _nan_summary(n_records, n_crossed)

    quantiles = valid_ticks.quantile([0.50, 0.95, 0.99]).to_list()
    return SpreadSummary(
        mean_ticks=float(valid_ticks.mean()),
        p50_ticks=float(quantiles[0]),
        p95_ticks=float(quantiles[1]),
        p99_ticks=float(quantiles[2]),
        max_ticks=float(valid_ticks.max()),
        mean_bps=float(valid_bps.mean()),
        time_above_1tick_pct=float((valid_ticks > 1).mean()),
        time_above_2tick_pct=float((valid_ticks > 2).mean()),
        n_records=n_records,
        n_crossed_quotes=n_crossed,
    )


def load_mbo(path: Path) -> pd.DataFrame:
    """Load MBO (per-order lifecycle) events from a databento-flat JSONL file.

    Loader is intentionally faithful to source data: ``action="T"`` (trade) and
    clear envelopes may carry NaN ``price`` per Rithmic spec — these are
    preserved as ``NaN`` rather than filtered or imputed. Downstream consumers
    must handle NaN before using price in computations. Roughly 2% of rows in
    the validated test fixture carry NaN price.

    Args:
        path: Path to the MBO normalized ``.jsonl`` file.

    Returns:
        DataFrame with columns: ``event_ts_ns`` (int64), ``recv_ts_ns`` (int64),
        ``sequence`` (int64), ``action`` (category: A/M/C/F/T), ``side``
        (category: B/A), ``price`` (float64, NaN allowed), ``size`` (int32),
        ``order_id`` (string).

        Empty DataFrame with correct dtypes if the file is 0 bytes or empty.

    Example:
        >>> df = load_mbo(Path("mbo.jsonl"))
        >>> df["action"].cat.categories.tolist()  # may be subset of full set
        ['A', 'C', 'F', 'M', 'T']
    """
    if path.stat().st_size == 0:
        return _empty_frame(_MBO_DTYPES)

    df = pd.read_json(path, lines=True)
    if df.empty:
        return _empty_frame(_MBO_DTYPES)

    df = df.rename(columns={"ts_event_ns": "event_ts_ns", "ts_recv_ns": "recv_ts_ns"})
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["recv_ts_ns"] = df["recv_ts_ns"].astype("int64")
    df["sequence"] = df["sequence"].astype("int64")
    df["action"] = df["action"].astype("category")
    df["side"] = df["side"].astype("category")
    df["price"] = df["price"].astype("float64")
    df["size"] = df["size"].astype("int32")
    df["order_id"] = df["order_id"].astype("string")
    return df[list(_MBO_DTYPES.keys())]


def load_mbp10(path: Path, *, chunksize: int = 100_000) -> pd.DataFrame:
    """Load MBP10 (10-level depth-of-book) from a databento-flat JSONL file.

    MBP10 is the heaviest of the rithmic stream outputs (2.69 GB / 37-min RTH
    fixture). To bound peak memory during parse, this loader streams the file
    in chunks of ``chunksize`` rows and concatenates at the end. Peak parse
    memory ≈ chunk size × per-row JSON dict overhead (~500 MB at default).

    The resulting DataFrame is still large in memory (~5 GB for the full
    fixture). Future work item 13 in ``docs/future_work.md`` tracks a fully
    incremental design that processes MBP10 chunk-by-chunk without ever
    holding the full set — out of scope here because the asof-join across
    chunk boundaries is non-trivial.

    Args:
        path: Path to the MBP10 normalized ``.jsonl`` file.
        chunksize: Rows per parse chunk. Default 100,000.

    Returns:
        DataFrame with 62 columns: ``event_ts_ns`` (int64), ``recv_ts_ns``
        (int64), and for each level 00–09 on each side bid/ask: ``{side}_px_NN``
        (float64), ``{side}_sz_NN`` (int32), ``{side}_ct_NN`` (int32).

        Empty DataFrame with full schema if the file is 0 bytes.

    Example:
        >>> df = load_mbp10(Path("MNQM6_mbp10.jsonl"))
        >>> df["ask_sz_00"].dtype
        dtype('int32')
    """
    if path.stat().st_size == 0:
        return _empty_frame(_MBP10_DTYPES)

    chunks: list[pd.DataFrame] = []
    reader = pd.read_json(path, lines=True, chunksize=chunksize)
    for chunk in reader:
        chunks.append(chunk)
    if not chunks:
        return _empty_frame(_MBP10_DTYPES)

    df = pd.concat(chunks, ignore_index=True)
    df = df.rename(columns={"ts_event_ns": "event_ts_ns", "ts_recv_ns": "recv_ts_ns"})
    # Empirical: the validated MBP10 capture has ``ts_event_ns`` only, no
    # ``ts_recv_ns`` — the inspection report was off. Fall back to event_ts
    # so the schema stays consistent; recv_ts isn't used for inference anyway.
    if "recv_ts_ns" not in df.columns:
        df["recv_ts_ns"] = df["event_ts_ns"]
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["recv_ts_ns"] = df["recv_ts_ns"].astype("int64")
    for n in range(10):
        for side in ("bid", "ask"):
            df[f"{side}_px_{n:02d}"] = df[f"{side}_px_{n:02d}"].astype("float64")
            df[f"{side}_sz_{n:02d}"] = df[f"{side}_sz_{n:02d}"].astype("int32")
            df[f"{side}_ct_{n:02d}"] = df[f"{side}_ct_{n:02d}"].astype("int32")
    return df[list(_MBP10_DTYPES.keys())]
