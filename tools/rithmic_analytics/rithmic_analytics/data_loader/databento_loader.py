"""Streaming Databento corpus loader for EWMA volatility calibration."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

PRICE_SCALE = 1_000_000_000.0
BAR_MINUTES = 5
DEFAULT_CORPUS_ROOTS = (
    Path(r"D:\qfa-cache\databento"),
    Path(r"D:\Quant-futures-app\data\databento\sim03_corpus"),
)

_SESSION_RE = re.compile(r"(?P<date>20\d{2}-\d{2}-\d{2})(?:[-_](?P<session>rth|globex))?", re.I)


@dataclass(frozen=True)
class CorpusSession:
    """One verified Databento session directory."""

    trading_date: str
    session: str
    path: Path
    trades_path: Path

    @property
    def key(self) -> str:
        return f"{self.trading_date}_{self.session}"


@dataclass(frozen=True)
class RejectedCorpusPath:
    """Corpus path rejected during discovery with a compact reason."""

    path: Path
    reason: str


@dataclass(frozen=True)
class CorpusDiscovery:
    """Accepted corpus sessions plus rejection provenance."""

    sessions: tuple[CorpusSession, ...]
    total_directories: int
    rejected: tuple[RejectedCorpusPath, ...] = field(default_factory=tuple)

    @property
    def rejected_count(self) -> int:
        return len(self.rejected)

    @property
    def rejection_summary(self) -> str:
        counts: dict[str, int] = {}
        for rejected in self.rejected:
            counts[rejected.reason] = counts.get(rejected.reason, 0) + 1
        if not counts:
            return "none"
        return ", ".join(f"{reason}={count}" for reason, count in sorted(counts.items()))

    @property
    def summary_line(self) -> str:
        return (
            f"corpus_loaded: {len(self.sessions)} verified sessions from "
            f"{self.total_directories} total directories "
            f"(rejected {self.rejected_count}: {self.rejection_summary})"
        )


@dataclass(frozen=True)
class TradeSessionStats:
    """Streaming stats needed for one calibration observation."""

    trading_date: str
    session: str
    path: Path
    trade_count: int
    volume: int
    vwap: float
    high: float
    low: float
    open: float
    close: float
    ib_high: float | None
    ib_low: float | None
    sigma_log: float
    sigma_pts: float


def discover_corpus_sessions(roots: list[Path] | tuple[Path, ...]) -> CorpusDiscovery:
    """Discover verified Databento sessions, deduping by trading date/session."""

    accepted: list[CorpusSession] = []
    rejected: list[RejectedCorpusPath] = []
    seen: dict[str, CorpusSession] = {}
    total_directories = 0

    for root in roots:
        if not root.exists():
            rejected.append(RejectedCorpusPath(root, "missing_root"))
            continue
        candidate_dirs = sorted({path.parent for path in root.rglob("trades.dbn.zst")})
        total_directories += len(candidate_dirs)
        for session_dir in candidate_dirs:
            parsed = _parse_session_dir(session_dir)
            if parsed is None:
                rejected.append(RejectedCorpusPath(session_dir, "unparseable_session"))
                continue
            trading_date, session = parsed
            trades_path = session_dir / "trades.dbn.zst"
            key = f"{trading_date}_{session}"
            candidate = CorpusSession(trading_date, session, session_dir, trades_path)
            previous = seen.get(key)
            if previous is not None:
                preferred = _preferred_session(previous, candidate)
                seen[key] = preferred
                dropped = candidate if preferred is previous else previous
                rejected.append(RejectedCorpusPath(dropped.path, "duplicate_session"))
                continue
            seen[key] = candidate

    accepted.extend(seen.values())
    return CorpusDiscovery(
        sessions=tuple(sorted(accepted, key=lambda item: (item.trading_date, item.session))),
        total_directories=total_directories,
        rejected=tuple(rejected),
    )


def load_or_build_session_stats(
    *,
    roots: list[Path] | tuple[Path, ...],
    output_path: Path,
    force: bool = False,
    chunk_size: int = 250_000,
) -> tuple[pd.DataFrame, CorpusDiscovery]:
    """Load cached per-session stats or stream DBN trades to build them."""

    discovery = discover_corpus_sessions(roots)
    if output_path.exists() and not force:
        data = pd.read_parquet(output_path)
        return data, discovery

    rows: list[dict[str, Any]] = []
    for session in discovery.sessions:
        stats = compute_trade_session_stats(session, chunk_size=chunk_size)
        if stats is None:
            continue
        rows.append(
            {
                "trading_date": stats.trading_date,
                "session": stats.session,
                "path": str(stats.path),
                "trade_count": stats.trade_count,
                "volume": stats.volume,
                "vwap": stats.vwap,
                "high": stats.high,
                "low": stats.low,
                "open": stats.open,
                "close": stats.close,
                "ib_high": stats.ib_high,
                "ib_low": stats.ib_low,
                "sigma_log": stats.sigma_log,
                "sigma_pts": stats.sigma_pts,
            }
        )
    data = pd.DataFrame(rows).sort_values(["trading_date", "session"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    data.to_parquet(output_path, index=False)
    return data, discovery


def compute_trade_session_stats(
    session: CorpusSession,
    *,
    chunk_size: int = 250_000,
) -> TradeSessionStats | None:
    """Stream one Databento trades file into session and Parkinson volatility stats."""

    import databento as db

    store = db.DBNStore.from_file(session.trades_path)
    total_qty = 0
    trade_count = 0
    sum_px_qty = 0.0
    first_ts: int | None = None
    open_px: float | None = None
    close_px: float | None = None
    high_px: float | None = None
    low_px: float | None = None
    ib_cutoff_ns: int | None = None
    ib_high: float | None = None
    ib_low: float | None = None
    bars: dict[int, tuple[float, float]] = {}

    for chunk in store.to_ndarray(count=chunk_size):
        if len(chunk) == 0:
            continue
        fields = set(chunk.dtype.names or ())
        if not {"ts_event", "price", "size"}.issubset(fields):
            continue

        ts_values = _timestamp_ns(chunk["ts_event"])
        prices = chunk["price"].astype("float64") / PRICE_SCALE
        sizes = chunk["size"].astype("int64")
        valid = (ts_values > 0) & (prices > 0.0) & (sizes > 0)
        if not np.any(valid):
            continue

        valid_ts = ts_values[valid]
        valid_prices = prices[valid]
        valid_sizes = sizes[valid]
        order = np.argsort(valid_ts, kind="stable")
        valid_ts = valid_ts[order]
        valid_prices = valid_prices[order]
        valid_sizes = valid_sizes[order]

        if first_ts is None:
            first_ts = int(valid_ts[0])
            ib_cutoff_ns = first_ts + 60 * 60 * 1_000_000_000
            open_px = float(valid_prices[0])
        close_px = float(valid_prices[-1])
        chunk_high = float(np.max(valid_prices))
        chunk_low = float(np.min(valid_prices))
        high_px = chunk_high if high_px is None else max(high_px, chunk_high)
        low_px = chunk_low if low_px is None else min(low_px, chunk_low)
        total_qty += int(np.sum(valid_sizes))
        trade_count += int(valid_prices.size)
        sum_px_qty += float(np.sum(valid_prices * valid_sizes))

        if ib_cutoff_ns is not None:
            ib_mask = valid_ts <= ib_cutoff_ns
            if np.any(ib_mask):
                ib_prices = valid_prices[ib_mask]
                chunk_ib_high = float(np.max(ib_prices))
                chunk_ib_low = float(np.min(ib_prices))
                ib_high = chunk_ib_high if ib_high is None else max(ib_high, chunk_ib_high)
                ib_low = chunk_ib_low if ib_low is None else min(ib_low, chunk_ib_low)

        bar_ids = valid_ts // (BAR_MINUTES * 60 * 1_000_000_000)
        for bar_id in np.unique(bar_ids):
            mask = bar_ids == bar_id
            bar_high = float(np.max(valid_prices[mask]))
            bar_low = float(np.min(valid_prices[mask]))
            previous = bars.get(int(bar_id))
            if previous is None:
                bars[int(bar_id)] = (bar_high, bar_low)
            else:
                bars[int(bar_id)] = (max(previous[0], bar_high), min(previous[1], bar_low))

    if (
        trade_count <= 0
        or total_qty <= 0
        or open_px is None
        or close_px is None
        or high_px is None
        or low_px is None
    ):
        return None

    vwap = sum_px_qty / total_qty
    bar_highs = [high for high, _ in bars.values()]
    bar_lows = [low for _, low in bars.values()]
    sigma_log = parkinson_sigma_log(bar_highs, bar_lows)
    sigma_pts = sigma_log * vwap
    return TradeSessionStats(
        trading_date=session.trading_date,
        session=session.session,
        path=session.path,
        trade_count=trade_count,
        volume=total_qty,
        vwap=vwap,
        high=high_px,
        low=low_px,
        open=open_px,
        close=close_px,
        ib_high=ib_high,
        ib_low=ib_low,
        sigma_log=sigma_log,
        sigma_pts=sigma_pts,
    )


def parkinson_sigma_log(highs: list[float], lows: list[float]) -> float:
    """Return Parkinson volatility in log-return units."""

    values: list[float] = []
    for high, low in zip(highs, lows, strict=False):
        if high <= 0.0 or low <= 0.0 or high < low:
            continue
        values.append(math.log(high / low) ** 2)
    if not values:
        return 0.0
    sigma_log_squared = sum(values) / len(values)
    return math.sqrt(sigma_log_squared / (4.0 * math.log(2.0)))


def parkinson_sigma_points(highs: list[float], lows: list[float], vwap: float) -> float:
    """Return Parkinson volatility converted from log units into price points."""

    if vwap <= 0.0:
        return 0.0
    return parkinson_sigma_log(highs, lows) * vwap


def _parse_session_dir(path: Path) -> tuple[str, str] | None:
    match = _SESSION_RE.search(path.name)
    if match is None:
        return None
    return match.group("date"), (match.group("session") or "rth").lower()


def _preferred_session(left: CorpusSession, right: CorpusSession) -> CorpusSession:
    if "sim03_corpus" in str(right.path).lower() and "sim03_corpus" not in str(left.path).lower():
        return right
    return min((left, right), key=lambda item: str(item.path).lower())


def _timestamp_ns(values: Any) -> np.ndarray:
    array = np.asarray(values)
    if array.dtype.kind == "M":
        return array.astype("datetime64[ns]").astype("int64")
    return array.astype("int64")
