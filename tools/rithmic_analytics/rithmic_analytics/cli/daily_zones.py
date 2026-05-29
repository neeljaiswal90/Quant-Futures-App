"""``python -m rithmic_analytics.cli.daily_zones`` — nightly zone JSON orchestrator.

Runs the Phase 1 pipeline (load OBS-01 → compute VP + ATR → build zone envelope
→ validate → write) for the most recent **complete** trading day in
``data/captures/`` and emits one zone JSON per session present:

    data/captures/2026-05-15/MNQ_rth.jsonl     → data/zones/2026-05-15_MNQ_rth.json
    data/captures/2026-05-15/MNQ_globex.jsonl  → data/zones/2026-05-15_MNQ_globex.json

A trading day is **complete** when current ET wall-clock is at or past 16:05 ET
on that date (RTH close). This is what Task Scheduler's 17:30 ET nightly run
sees: today's data is complete, processed once. An operator-initiated mid-RTH
run (`--trading-date 2026-05-15` at 14:00 ET) bypasses the completeness check
and processes the in-progress capture with a warning logged.

Exit codes:
    0 — success, OR no eligible trading day found (logged as warning, not error)
    1 — bad config (unreadable captures dir, invalid --trading-date, etc.)

`--drop-to` copy failures are **best-effort**: the zone JSON is still
generated, the copy failure is logged, and the run exits 0.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import math
import shutil
import sys
import time
from datetime import date, datetime, timedelta
from datetime import time as dtime
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

import jsonschema
import pandas as pd

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_mbp1, load_obs01_trades, summarize_spread
from rithmic_analytics.core.schema import ReferenceLine, ZoneEnvelope, validate_envelope
from rithmic_analytics.features.absorption import (
    apply_next_bar_confirmation,
    compute_absorption_events,
)
from rithmic_analytics.features.atr import compute_atr_from_ticks
from rithmic_analytics.features.cancellation_analysis import (
    analyze_cancellations,
)
from rithmic_analytics.features.order_pressure import compute_order_pressure
from rithmic_analytics.features.volume_profile import compute_vp
from rithmic_analytics.features.vwap import VwapAnchor, compute_vwap
from rithmic_analytics.ops.normalize_probe import (
    UnrecoverableCaptureError,
    normalize_probe_to_obs01,
)

EXIT_OK: int = 0
EXIT_BAD_CONFIG: int = 1
DailyZonesMode = Literal["light", "full"]

_ET: ZoneInfo = ZoneInfo("America/New_York")
_NS_PER_MINUTE: int = 60 * 10**9
_RTH_CLOSE: dtime = dtime(16, 5)
_DEFAULT_PARTIAL_CAPTURE_THRESHOLD: int = 50_000  # trades; below = log warning

_LOG = logging.getLogger("rithmic_analytics.daily_zones")


# ---------------------------------------------------------------------------
# Clock + date helpers (factored for monkeypatching in tests)
# ---------------------------------------------------------------------------


def _now_et() -> datetime:
    return datetime.now(_ET)


def is_trading_day_complete(trading_date: date, now_et: datetime) -> bool:
    """A trading day is complete once ET wall-clock is at or past 16:05 ET on that date.

    Example:
        >>> from datetime import datetime
        >>> from zoneinfo import ZoneInfo
        >>> et = ZoneInfo("America/New_York")
        >>> is_trading_day_complete(date(2026, 5, 15), datetime(2026, 5, 15, 14, 0, tzinfo=et))
        False
        >>> is_trading_day_complete(date(2026, 5, 15), datetime(2026, 5, 15, 17, 30, tzinfo=et))
        True
    """
    rth_close = datetime.combine(trading_date, _RTH_CLOSE, tzinfo=_ET)
    return now_et >= rth_close


_TRADING_DAY_NAME_LEN = 10  # "YYYY-MM-DD"


def _scan_capture_dirs(captures_root: Path) -> list[date]:
    """Return trading-dates (parsed from dir names) that contain at least one capture file."""
    if not captures_root.exists():
        return []
    out: list[date] = []
    for day_dir in captures_root.iterdir():
        if not day_dir.is_dir() or len(day_dir.name) != _TRADING_DAY_NAME_LEN:
            continue
        try:
            d = date.fromisoformat(day_dir.name)
        except ValueError:
            continue
        has_capture = any(
            f.is_file() and f.suffix == ".jsonl" and ("_rth." in f.name or "_globex." in f.name)
            for f in day_dir.iterdir()
        )
        if has_capture:
            out.append(d)
    return out


def _select_target_date(
    captures_root: Path,
    *,
    explicit: date | None,
    now_et: datetime,
) -> date | None:
    """Operator override wins; otherwise most-recent complete trading day."""
    if explicit is not None:
        return explicit
    candidates = [
        d for d in _scan_capture_dirs(captures_root) if is_trading_day_complete(d, now_et)
    ]
    return max(candidates) if candidates else None


def _build_vwap_reference_lines(
    trades: pd.DataFrame, session: str,
) -> list[ReferenceLine]:
    """Compute session-anchored VWAP + ±1σ bands + weekly VWAP and emit as
    reference lines. ±2σ omitted (noise floor).

    The session-anchor name is chosen from ``session``:
        - ``"rth"`` → anchor=``"rth"``
        - ``"globex"`` → anchor=``"globex"``
        - anything else → no session-anchored line, only weekly.

    Lines emitted, each with source ``vwap_<anchor>[_band_<dir><sd>]``:
        - ``vwap_<session>``
        - ``vwap_<session>_band_p1sd`` / ``vwap_<session>_band_m1sd``
        - ``vwap_weekly``  (cross-anchor reference)
    """
    if len(trades) == 0:
        return []

    lines: list[ReferenceLine] = []
    session_anchor: VwapAnchor | None = None
    if session == "rth":
        session_anchor = "rth"
    elif session == "globex":
        session_anchor = "globex"

    if session_anchor is not None:
        vwap = compute_vwap(trades, anchor=session_anchor)
        if len(vwap.event_ts_ns) > 0:
            bands = vwap.final_bands()
            if not math.isnan(bands["vwap"]):
                lines.append(ReferenceLine(
                    price=bands["vwap"],
                    text=f"VWAP {session_anchor.upper()} {bands['vwap']:.2f}",
                    source=f"vwap_{session_anchor}",
                ))
            if not math.isnan(bands["p1"]):
                lines.append(ReferenceLine(
                    price=bands["p1"],
                    text=f"VWAP {session_anchor.upper()} +1σ",
                    source=f"vwap_{session_anchor}_band_p1sd",
                ))
            if not math.isnan(bands["m1"]):
                lines.append(ReferenceLine(
                    price=bands["m1"],
                    text=f"VWAP {session_anchor.upper()} -1σ",
                    source=f"vwap_{session_anchor}_band_m1sd",
                ))

    # Weekly VWAP — same data, different anchor
    weekly = compute_vwap(trades, anchor="weekly")
    if len(weekly.event_ts_ns) > 0:
        w_bands = weekly.final_bands()
        if not math.isnan(w_bands["vwap"]):
            lines.append(ReferenceLine(
                price=w_bands["vwap"],
                text=f"VWAP Weekly {w_bands['vwap']:.2f}",
                source="vwap_weekly",
            ))

    return lines


# ---------------------------------------------------------------------------
# RA-030.1: optional absorption-events emit
# ---------------------------------------------------------------------------


def _mbp1_sibling_for(capture_path: Path) -> Path:
    """Derive ``<root>_<session>.mbp1.jsonl`` from a capture path.

    Works for both raw parity input (``.jsonl``) and the cached OBS-01
    sibling (``.obs01.jsonl``) — both live in the same directory with the
    same root_session stem.
    """
    if capture_path.name.endswith(".obs01.jsonl"):
        stem = capture_path.name[: -len(".obs01.jsonl")]
    else:
        stem = capture_path.stem
    return capture_path.with_name(f"{stem}.mbp1.jsonl")


def _emit_pressure_json(
    *,
    capture_path: Path,
    pressure_root: Path,
    trading_date: date,
    root_symbol: str,
    session: str,
) -> Path | None:
    """Optional emit: load MBO sibling, compute order pressure, write JSON.

    Defensive design (RA-030.1 pattern): never re-raises. Zones JSON is
    the load-bearing artifact for daily_zones; order pressure is
    valuable-but-not-critical, so failures here are logged and swallowed.

    Returns the output path on success, ``None`` on any failure.
    """
    from rithmic_analytics.core.loader import load_mbo

    mbo_path = _mbo_sibling_for(capture_path)
    if not mbo_path.exists():
        _LOG.warning(
            f"pressure emit: skipped for {trading_date} {session} — "
            f"no MBO sibling at {mbo_path.name}. Pre-RA-035 capture or "
            f"cached .obs01 without .mbo — delete the .obs01 sibling and "
            f"rerun to regenerate."
        )
        return None

    start = time.perf_counter()
    try:
        mbo = load_mbo(mbo_path)
        series = compute_order_pressure(mbo, MNQ)
    except Exception as exc:  # never let pressure emit kill daily_zones
        elapsed = time.perf_counter() - start
        _LOG.warning(
            f"pressure emit failed for {trading_date} {session} after "
            f"{elapsed:.1f}s (zones still produced): {exc}"
        )
        return None

    pressure_root.mkdir(parents=True, exist_ok=True)
    out_path = pressure_root / (
        f"{trading_date.isoformat()}_{root_symbol}_{session}.json"
    )
    try:
        out_path.write_text(
            json.dumps(series.to_dict(), indent=2), encoding="utf-8"
        )
    except OSError as exc:
        _LOG.warning(
            f"pressure emit: failed to write {out_path.name} (zones still "
            f"produced): {exc}"
        )
        return None

    elapsed = time.perf_counter() - start
    _LOG.info(
        f"pressure emit: wrote {len(series.rows):,} bins from "
        f"{series.n_input_events:,} MBO events "
        f"({series.n_unique_order_ids:,} unique order_ids) → "
        f"{out_path.name} in {elapsed:.1f}s"
    )
    return out_path


def _emit_cancellation_analysis(
    *,
    trades: pd.DataFrame,
    orders_csv: Path,
    cancellations_root: Path,
    trading_date: date,
    root_symbol: str,
    session: str,
) -> Path | None:
    """Optional emit: load Tradesea CSV, run analysis against trades, persist.

    Defensive (RA-030.1 / RA-035 pattern): never re-raises. Zones JSON
    is the load-bearing artifact; cancellation analysis is
    valuable-but-not-critical, so failures are logged and swallowed.

    Returns the output path on success, ``None`` on any failure
    (missing CSV, parse error, write error).
    """
    from rithmic_analytics.core.trade_log import load_tradesea_csv

    if not orders_csv.exists():
        _LOG.info(
            f"cancellation emit: skipped for {trading_date} {session} — "
            f"no Tradesea CSV at {orders_csv}. Drop today's orders.csv "
            f"into data/trades/{trading_date.isoformat()}/ to enable."
        )
        return None

    start = time.perf_counter()
    try:
        fills, cancellations = load_tradesea_csv(orders_csv)
        report = analyze_cancellations(
            cancellations, trades, MNQ,
            fills=fills, trading_date=trading_date,
        )
    except Exception as exc:  # never let cancel analysis kill daily_zones
        elapsed = time.perf_counter() - start
        _LOG.warning(
            f"cancellation emit failed for {trading_date} {session} after "
            f"{elapsed:.1f}s (zones still produced): {exc}"
        )
        return None

    cancellations_root.mkdir(parents=True, exist_ok=True)
    out_path = cancellations_root / (
        f"{trading_date.isoformat()}_{root_symbol}_{session}.json"
    )
    try:
        out_path.write_text(
            json.dumps(report.to_dict(), indent=2, default=str),
            encoding="utf-8",
        )
    except OSError as exc:
        _LOG.warning(
            f"cancellation emit: failed to write {out_path.name} (zones "
            f"still produced): {exc}"
        )
        return None

    elapsed = time.perf_counter() - start
    s = report.session_summary
    rate_str = (
        f"{s.regret_cancel_rate * 100:.1f}%"
        if s.regret_cancel_rate is not None else "n/a"
    )
    _LOG.info(
        f"cancellation emit: {s.n_cancels_analyzed}/{s.n_cancels_total} analyzed, "
        f"{s.n_reached_limit} reached, regret_rate={rate_str}, "
        f"{s.n_regret_rebuys} rebuys → {out_path.name} in {elapsed:.1f}s"
    )
    return out_path


def _emit_probability_card(
    *,
    envelope: ZoneEnvelope,
    history_report_path: Path,
    probability_root: Path,
    trading_date: date,
    root_symbol: str,
    session: str,
) -> Path | None:
    """RA-038: load history report, annotate zones, write {.md, .json}.

    Defensive — never re-raises. Missing history report → bootstrap-mode
    card (no usable history) rather than skipped output, so the operator
    always gets visible feedback.

    Returns the markdown output path on success, ``None`` on any I/O failure.
    """
    from rithmic_analytics.features.zone_probability import (
        annotate_zones_with_probability,
    )
    from rithmic_analytics.features.zone_quality import (
        BinomialEstimate,
        HistoryReport,
    )
    from rithmic_analytics.viewer.probability_card import render_probability_card

    history: HistoryReport | None = None
    if history_report_path.exists():
        try:
            payload = json.loads(history_report_path.read_text(encoding="utf-8"))
            hit_rate_by_conviction = {
                k: BinomialEstimate(
                    n_trials=int(v["n_trials"]),
                    n_success=int(v["n_success"]),
                    rate=v.get("rate"),
                    ci_low=float(v["ci_low"]),
                    ci_high=float(v["ci_high"]),
                    insufficient_data=bool(v["insufficient_data"]),
                )
                for k, v in payload.get("hit_rate_by_conviction", {}).items()
            }
            history = HistoryReport(
                sessions_analyzed=int(payload["sessions_analyzed"]),
                window_sessions=int(payload["window_sessions"]),
                pairing=payload["pairing"],
                hit_rate_by_conviction=hit_rate_by_conviction,
                avg_bounce_distance_by_conviction=payload.get(
                    "avg_bounce_distance_by_conviction", {}
                ),
                avg_continuation_distance_by_conviction=payload.get(
                    "avg_continuation_distance_by_conviction", {}
                ),
                insufficient_data_tiers=payload.get("insufficient_data_tiers", []),
            )
        except Exception as exc:  # never let history-parse take down emit
            _LOG.warning(
                f"probability card: failed to parse history "
                f"{history_report_path.name} for {trading_date} {session} — "
                f"falling back to bootstrap mode: {exc}"
            )
            history = None
    else:
        _LOG.info(
            f"probability card: no history report at "
            f"{history_report_path.name} for {trading_date} {session} — "
            f"emitting bootstrap-mode card."
        )

    try:
        annotated = annotate_zones_with_probability(
            envelope, history, trading_date_iso=trading_date.isoformat(),
        )
        rendered = render_probability_card(annotated)
    except Exception as exc:
        _LOG.warning(
            f"probability card: render failed for {trading_date} {session} "
            f"(zones still produced): {exc}"
        )
        return None

    probability_root.mkdir(parents=True, exist_ok=True)
    stem = f"{trading_date.isoformat()}_{root_symbol}_{session}"
    md_path = probability_root / f"{stem}.md"
    json_path = probability_root / f"{stem}.json"
    try:
        md_path.write_text(rendered, encoding="utf-8")
        json_path.write_text(
            json.dumps(annotated.to_dict(), indent=2, default=str),
            encoding="utf-8",
        )
    except OSError as exc:
        _LOG.warning(
            f"probability card: write failed for {md_path.name} (zones "
            f"still produced): {exc}"
        )
        return None

    _LOG.info(
        f"probability card: wrote {md_path.name} + {json_path.name} "
        f"({len(annotated.zone_annotations)} zones, "
        f"bootstrap_mode={annotated.bootstrap_mode})"
    )
    return md_path


def _mbo_sibling_for(capture_path: Path) -> Path:
    """Derive ``<root>_<session>.mbo.jsonl`` from a capture path.

    Works for both raw parity input (``.jsonl``) and the cached OBS-01
    sibling (``.obs01.jsonl``).
    """
    if capture_path.name.endswith(".obs01.jsonl"):
        stem = capture_path.name[: -len(".obs01.jsonl")]
    else:
        stem = capture_path.stem
    return capture_path.with_name(f"{stem}.mbo.jsonl")


def _log_spread_summary(
    *,
    capture_path: Path,
    trading_date: date,
    session: str,
) -> None:
    """RA-037: Load MBP1 sibling (if present), summarize spread, emit one
    INFO log line. Defensive — never raises, never gates zones output.

    No-op (silent) when the MBP1 sibling is missing (pre-RA-030 captures
    or cached .obs01 without .mbp1).
    """
    mbp1_path = _mbp1_sibling_for(capture_path)
    if not mbp1_path.exists():
        return

    try:
        mbp1 = load_mbp1(mbp1_path)
        summary = summarize_spread(mbp1)
    except Exception as exc:  # never let spread summary kill daily_zones
        _LOG.warning(
            f"spread summary failed for {trading_date} {session} "
            f"(zones still produced): {exc}"
        )
        return

    if summary.n_records == 0:
        _LOG.info(
            f"spread summary {trading_date} {session}: "
            f"n_records=0 (empty MBP1 sibling)"
        )
        return

    if math.isnan(summary.mean_ticks):
        _LOG.info(
            f"spread summary {trading_date} {session}: "
            f"n_records={summary.n_records} "
            f"n_crossed={summary.n_crossed_quotes} "
            f"(no valid two-sided quotes)"
        )
        return

    _LOG.info(
        f"spread summary {trading_date} {session}: "
        f"mean={summary.mean_ticks:.2f}t ({summary.mean_bps:.2f}bps) "
        f"p50={summary.p50_ticks:.2f}t p95={summary.p95_ticks:.2f}t "
        f"p99={summary.p99_ticks:.2f}t max={summary.max_ticks:.2f}t "
        f">1t={summary.time_above_1tick_pct * 100:.1f}% "
        f">2t={summary.time_above_2tick_pct * 100:.1f}% "
        f"n={summary.n_records:,} crossed={summary.n_crossed_quotes}"
    )


def _emit_absorption_events(
    *,
    trades: pd.DataFrame,
    capture_path: Path,
    absorption_root: Path,
    trading_date: date,
    root_symbol: str,
    session: str,
) -> Path | None:
    """Optional emit: load MBP1 sibling, compute absorption events, write JSON.

    Defensive design — never re-raises. Zones JSON is the load-bearing
    artifact for daily_zones; absorption is valuable-but-not-critical, so
    failures here are logged and swallowed (see RA-030.1 ticket guidance).

    Returns the output path on success, ``None`` on any failure or when
    the MBP1 sibling doesn't exist.
    """
    mbp1_path = _mbp1_sibling_for(capture_path)
    if not mbp1_path.exists():
        _LOG.warning(
            f"absorption emit: skipped for {trading_date} {session} — "
            f"no MBP1 sibling at {mbp1_path.name}. Pre-RA-030 capture or "
            f"cached .obs01 without .mbp1 — delete the .obs01 sibling and "
            f"rerun to regenerate both."
        )
        return None

    start = time.perf_counter()
    try:
        mbp1 = load_mbp1(mbp1_path)
        raw_events = compute_absorption_events(trades, mbp1, MNQ)
        events = apply_next_bar_confirmation(raw_events, trades, MNQ)
    except Exception as exc:  # never let absorption emit kill daily_zones
        elapsed = time.perf_counter() - start
        _LOG.warning(
            f"absorption emit failed for {trading_date} {session} after "
            f"{elapsed:.1f}s (zones still produced): {exc}"
        )
        return None

    absorption_root.mkdir(parents=True, exist_ok=True)
    out_path = absorption_root / (
        f"{trading_date.isoformat()}_{root_symbol}_{session}.json"
    )
    try:
        out_path.write_text(
            json.dumps([e.to_dict() for e in events], indent=2),
            encoding="utf-8",
        )
    except OSError as exc:
        _LOG.warning(
            f"absorption emit: failed to write {out_path.name} (zones still "
            f"produced): {exc}"
        )
        return None

    elapsed = time.perf_counter() - start
    n_confirmed = sum(1 for e in events if e.confirmed)
    n_stale = sum(1 for e in events if e.mbp1_stale)
    _LOG.info(
        f"absorption emit: wrote {len(events)} events "
        f"({n_confirmed} confirmed, {n_stale} mbp1-stale) → {out_path.name} "
        f"from {len(mbp1):,} MBP1 records in {elapsed:.1f}s"
    )
    return out_path


# ---------------------------------------------------------------------------
# Per-session processing
# ---------------------------------------------------------------------------


def _sniff_first_record(path: Path) -> dict[str, object] | None:
    """Return the first parsed JSON object in ``path``, or ``None`` if empty."""
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            try:
                rec: dict[str, object] = json.loads(line)
            except json.JSONDecodeError:
                return None
            return rec
    return None


def _resolve_capture_for_load(
    capture_path: Path,
    *,
    allow_normalize: bool = True,
) -> Path | None:
    """Return the path ``load_obs01_trades`` should read.

    - ``*.obs01.jsonl`` → as-is (already normalized).
    - First record has ``type == "TRADE"`` → as-is.
    - First record looks like probe-parity → normalize to siblings
      ``<root>_<session>.obs01.jsonl`` AND ``<root>_<session>.mbp1.jsonl``
      and return the OBS-01 path. Cached: if the OBS-01 sibling already
      exists, return it without re-normalizing.
    - Otherwise → ``None`` (caller logs and skips).

    The MBP1 sibling is produced as a side-effect for downstream
    absorption / VWAP consumers — daily_zones itself only needs OBS-01.
    Per RA-029 / D-006 + RA-030 / D-007: the capture pipeline is
    ``probe (parity-payload) → raw JSONL → normalize_probe → {obs01, mbp1} JSONL → analytics``.
    """
    if capture_path.name.endswith(".obs01.jsonl"):
        return capture_path

    obs01_sibling = capture_path.with_name(capture_path.stem + ".obs01.jsonl")
    mbp1_sibling = capture_path.with_name(capture_path.stem + ".mbp1.jsonl")
    mbo_sibling = capture_path.with_name(capture_path.stem + ".mbo.jsonl")

    if obs01_sibling.exists():
        _LOG.info(f"using cached normalized capture: {obs01_sibling.name}")
        if not mbp1_sibling.exists():
            _LOG.warning(
                f"cached OBS-01 present but MBP1 sibling missing for "
                f"{capture_path.name}; absorption will run degraded 3-factor. "
                f"Delete {obs01_sibling.name} and rerun to regenerate."
            )
        if not mbo_sibling.exists():
            _LOG.warning(
                f"cached OBS-01 present but MBO sibling missing for "
                f"{capture_path.name}; order_pressure (RA-035) has no input. "
                f"Delete {obs01_sibling.name} and rerun to regenerate."
            )
        return obs01_sibling

    first = _sniff_first_record(capture_path)
    if first is None:
        _LOG.error(f"empty / unparseable first record in {capture_path}")
        return None

    if first.get("type") == "TRADE":
        # Already OBS-01-shaped; load directly. No siblings produced.
        return capture_path

    if not allow_normalize:
        _LOG.error(
            f"light mode requires a normalized OBS-01 sibling for {capture_path.name}; "
            f"expected {obs01_sibling.name}. Run normalize_probe_incremental first "
            f"or rerun daily_zones with --mode full for a full normalize path."
        )
        return None

    # Probe-parity path — produce all three siblings in a single pass
    try:
        report = normalize_probe_to_obs01(
            capture_path, obs01_sibling,
            mbp1_out_path=mbp1_sibling,
            mbo_out_path=mbo_sibling,
            overwrite=False,
        )
    except UnrecoverableCaptureError as exc:
        _LOG.error(
            f"capture {capture_path.name} is unrecoverable for analytics: {exc}"
        )
        return None
    except (FileExistsError, ValueError) as exc:
        _LOG.error(f"normalization of {capture_path} failed: {exc}")
        return None

    _LOG.info(
        f"normalized {capture_path.name} → {obs01_sibling.name} + "
        f"{mbp1_sibling.name} + {mbo_sibling.name}: "
        f"{report.trades_emitted} trades + "
        f"{report.mbp1_records_emitted} mbp1 quotes + "
        f"{report.mbo_records_emitted} mbo events "
        f"from {report.records_read} records"
    )
    return obs01_sibling


def _process_session(
    *,
    capture_path: Path,
    zones_root: Path,
    trading_date: date,
    root_symbol: str,
    session: str,
    bin_size_ticks: int,
    va_pct: float,
    hvn_dedup_ticks: int,
    top_n: int,
    atr_bar_size_min: int,
    atr_period: int,
    partial_capture_warn_threshold: int,
    drop_to: Path | None,
    bin_size_mode: str = "fixed",
    emit_absorption_json: bool = False,
    absorption_root: Path | None = None,
    emit_pressure_json: bool = False,
    pressure_root: Path | None = None,
    emit_cancellation_analysis: bool = False,
    cancellations_root: Path | None = None,
    orders_root: Path | None = None,
    emit_probability_card: bool = False,
    probability_card_root: Path | None = None,
    history_report_path: Path | None = None,
    allow_normalize: bool = True,
) -> Path | None:
    """Produce one zone JSON for a session. Returns the written path or None on parse error."""
    resolved = _resolve_capture_for_load(capture_path, allow_normalize=allow_normalize)
    if resolved is None:
        return None

    try:
        trades = load_obs01_trades(resolved)
    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        _LOG.error(f"failed to load {resolved}: {exc}")
        return None

    n_trades = len(trades)
    if 0 < n_trades < partial_capture_warn_threshold:
        _LOG.warning(
            f"partial capture for {trading_date} {session}: "
            f"{n_trades} trades < {partial_capture_warn_threshold} threshold "
            f"(check for late wrapper launch, mid-session disconnect, or holiday half-day)"
        )

    # RA-039: ATR must be computed before compute_vp so adaptive mode can use it.
    atr_14 = compute_atr_from_ticks(
        trades,
        period=atr_period,
        bar_size_ns=atr_bar_size_min * _NS_PER_MINUTE,
    )

    vp = compute_vp(
        trades,
        MNQ,
        bin_size_ticks=bin_size_ticks,
        va_pct=va_pct,
        hvn_dedup_ticks=hvn_dedup_ticks,
        top_n=top_n,
        bin_size_mode=bin_size_mode,  # type: ignore[arg-type]
        atr_14=atr_14,
    )
    if vp.bin_size_mode != "fixed":
        _LOG.info(
            f"RA-039 adaptive bins {trading_date} {session}: "
            f"mode={vp.bin_size_mode} atr_14={atr_14:.2f} "
            f"effective_bin_size_ticks={vp.effective_bin_size_ticks} "
            f"(fixed default would have been {bin_size_ticks})"
        )

    envelope = ZoneEnvelope.from_volume_profile(
        vp,
        symbol=root_symbol,
        timeframe=session,
        atr_14=atr_14,
        data_source="rithmic",
        # RA-039: when adaptive resolves, surface the effective ticks in the envelope.
        bin_size_ticks=vp.effective_bin_size_ticks or bin_size_ticks,
        bars_used=n_trades,
    )

    # RA-031: append VWAP (anchor matches session) + ±1σ bands as reference
    # lines. The ±2σ bands are intentionally omitted from the main output
    # to keep morning chart-prep noise low; available via direct
    # compute_vwap() if needed.
    vwap_lines = _build_vwap_reference_lines(trades, session)
    if vwap_lines:
        envelope = dataclasses.replace(
            envelope,
            reference_lines=envelope.reference_lines + vwap_lines,
        )

    payload = envelope.to_dict()
    try:
        validate_envelope(payload)
    except jsonschema.ValidationError as exc:
        _LOG.error(
            f"emitted envelope for {trading_date} {session} failed schema validation: {exc.message}"
        )
        return None

    out_path = zones_root / f"{trading_date.isoformat()}_{root_symbol}_{session}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(envelope.to_json(), encoding="utf-8")
    _LOG.info(f"wrote {out_path} — {envelope.summary_line()}")

    # RA-037: spread summary INFO log per session (defensive — silent if
    # MBP1 sibling is missing). Single one-liner consumable by ops eyeballs
    # and downstream alert tooling.
    _log_spread_summary(
        capture_path=capture_path,
        trading_date=trading_date,
        session=session,
    )

    if drop_to is not None:
        try:
            drop_to.mkdir(parents=True, exist_ok=True)
            shutil.copy2(out_path, drop_to / out_path.name)
            _LOG.info(f"dropped copy to {drop_to / out_path.name}")
        except OSError as exc:
            # Best-effort: zone JSON is already generated; drop-copy failure
            # doesn't gate the run.
            _LOG.error(f"drop-to copy failed for {out_path.name}: {exc}")

    # RA-030.1: optional absorption-events emit. Off by default; flip ON
    # in production after smoke-testing. Zones JSON is the load-bearing
    # artifact, so this step never raises — failures are logged and
    # swallowed.
    if emit_absorption_json and absorption_root is not None:
        _emit_absorption_events(
            trades=trades,
            capture_path=capture_path,
            absorption_root=absorption_root,
            trading_date=trading_date,
            root_symbol=root_symbol,
            session=session,
        )

    # RA-035: optional order-pressure emit. Same defensive pattern.
    if emit_pressure_json and pressure_root is not None:
        _emit_pressure_json(
            capture_path=capture_path,
            pressure_root=pressure_root,
            trading_date=trading_date,
            root_symbol=root_symbol,
            session=session,
        )

    # RA-036: optional cancellation-analysis emit. Same defensive pattern.
    if (
        emit_cancellation_analysis
        and cancellations_root is not None
        and orders_root is not None
    ):
        orders_csv = orders_root / trading_date.isoformat() / "orders.csv"
        _emit_cancellation_analysis(
            trades=trades,
            orders_csv=orders_csv,
            cancellations_root=cancellations_root,
            trading_date=trading_date,
            root_symbol=root_symbol,
            session=session,
        )

    # RA-038: optional conviction-conditioned probability card. Same
    # defensive pattern — missing history → bootstrap-mode card, not skip.
    if (
        emit_probability_card
        and probability_card_root is not None
        and history_report_path is not None
    ):
        _emit_probability_card(
            envelope=envelope,
            history_report_path=history_report_path,
            probability_root=probability_card_root,
            trading_date=trading_date,
            root_symbol=root_symbol,
            session=session,
        )

    return out_path


# ---------------------------------------------------------------------------
# RA-033: heartbeat-of-heartbeat watchdog
# ---------------------------------------------------------------------------


def _prior_business_day(d: date) -> date:
    """Return the previous business day (skipping Sat/Sun)."""
    candidate = d - timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= timedelta(days=1)
    return candidate


def _check_prior_heartbeat(heartbeat_dir: Path, target_date: date) -> None:
    """Watchdog: if a heartbeat dir exists and contains other heartbeats but
    yesterday's is missing, log WARNING (and emit FAIL alert if alerts module
    grows a ``post_fail`` shipper per RA-032).

    Bootstrap case (empty/missing heartbeat dir) → silent.
    """
    if not heartbeat_dir.exists():
        return
    existing_files = [p for p in heartbeat_dir.iterdir() if p.is_file() and p.suffix == ".txt"]
    if not existing_files:
        return  # bootstrap

    prior = _prior_business_day(target_date)
    expected = heartbeat_dir / f"{prior.isoformat()}.txt"
    if expected.exists():
        return  # all good

    msg = (
        f"heartbeat-watchdog: expected {expected.name} not found. "
        f"Task Scheduler may have dropped the RithmicHeartbeat entry "
        f"(Windows Update edge case — see future_work.md item 6)."
    )
    _LOG.warning(msg)

    # RA-032 hook: alerts.post_fail handles the env-var check and dedupe.
    # Wrapped in hasattr to stay resilient if someone strips post_fail later.
    from rithmic_analytics.ops import alerts as alerts_mod
    if hasattr(alerts_mod, "post_fail"):
        try:
            alerts_mod.post_fail(
                source_name="heartbeat_watchdog",
                message=msg,
            )
        except Exception as exc:  # never let alerter take down daily_zones
            _LOG.error(f"heartbeat-watchdog: failed to post FAIL alert: {exc}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.daily_zones",
        description=(
            "Nightly orchestrator: emit one zone JSON per session for the most "
            "recent complete trading day."
        ),
    )
    parser.add_argument(
        "--captures-root",
        type=Path,
        default=Path("data/captures"),
        help="Root dir of trading-day capture folders. Default: data/captures.",
    )
    parser.add_argument(
        "--zones-root",
        type=Path,
        default=Path("data/zones"),
        help="Where to write {date}_{root}_{session}.json files. Default: data/zones.",
    )
    parser.add_argument(
        "--logs-root",
        type=Path,
        default=Path("logs"),
        help="Where to write daily_zones_{date}.log. Default: logs.",
    )
    parser.add_argument(
        "--heartbeat-dir",
        type=Path,
        default=Path("data/heartbeat"),
        help=(
            "Heartbeat directory checked for the prior trading day's file "
            "(RA-033 watchdog). Missing prior-day heartbeat → WARNING. "
            "Default: data/heartbeat."
        ),
    )
    parser.add_argument(
        "--mode",
        choices=("light", "full"),
        default=None,
        help=(
            "Operational mode. light is the intraday-safe path and rejects "
            "--emit-pressure-json / --emit-cancellation-analysis when explicit. "
            "full enables EOD-heavy analytics. If omitted, heavy flags imply "
            "full mode with a deprecation warning; otherwise light mode is used."
        ),
    )
    # RA-030.1: optional absorption-events emit (default OFF)
    parser.add_argument(
        "--emit-absorption-json",
        action="store_true",
        default=False,
        help=(
            "After zones JSON is written, also load the MBP1 sibling, "
            "compute absorption events, and persist to "
            "{absorption_root}/{YYYY-MM-DD}_{ROOT}_{session}.json. "
            "Defensive: failure here does NOT gate zones output. Default: OFF. "
            "Flip ON in production after smoke-testing one session."
        ),
    )
    parser.add_argument(
        "--absorption-root",
        type=Path,
        default=Path("data/absorption"),
        help=(
            "Where to write absorption JSON when --emit-absorption-json is set. "
            "Default: data/absorption."
        ),
    )
    # RA-035: optional order-pressure emit (default OFF)
    parser.add_argument(
        "--emit-pressure-json",
        action="store_true",
        default=False,
        help=(
            "After zones JSON is written, also load the MBO sibling, "
            "compute order_pressure diagnostics, and persist to "
            "{pressure_root}/{YYYY-MM-DD}_{ROOT}_{session}.json. "
            "Defensive: failure here does NOT gate zones output. Default: OFF. "
            "Flip ON in production after smoke-testing one session."
        ),
    )
    parser.add_argument(
        "--pressure-root",
        type=Path,
        default=Path("data/order_pressure"),
        help=(
            "Where to write pressure JSON when --emit-pressure-json is set. "
            "Default: data/order_pressure."
        ),
    )
    # RA-036: optional cancellation-analysis emit (default OFF)
    parser.add_argument(
        "--emit-cancellation-analysis",
        action="store_true",
        default=False,
        help=(
            "After zones JSON is written, if today's Tradesea orders CSV "
            "exists at data/trades/{date}/orders.csv, load it and run "
            "cancellation analysis (RA-036, Rule 7 measurement). Persists "
            "to {cancellations_root}/{date}_{ROOT}_{session}.json. "
            "Defensive: failure does NOT gate zones output. Default: OFF."
        ),
    )
    parser.add_argument(
        "--cancellations-root",
        type=Path,
        default=Path("data/cancellations"),
        help=(
            "Where to write cancellation-analysis JSON when "
            "--emit-cancellation-analysis is set. Default: data/cancellations."
        ),
    )
    parser.add_argument(
        "--orders-root",
        type=Path,
        default=Path("data/trades"),
        help=(
            "Root dir for Tradesea orders CSVs. The orchestrator looks at "
            "{orders_root}/{date}/orders.csv. Default: data/trades."
        ),
    )
    # RA-038: optional probability-card emit (default OFF)
    parser.add_argument(
        "--emit-probability-card",
        action="store_true",
        default=False,
        help=(
            "After zones JSON is written, also annotate each zone with a "
            "conviction-conditioned P(hold) + expected R + sizing decision "
            "using the trailing-window HistoryReport. Emits both .md and "
            ".json to {probability_card_root}. Bootstrap-safe: missing "
            "history → bootstrap-mode card, not skip. Default: OFF."
        ),
    )
    parser.add_argument(
        "--probability-card-root",
        type=Path,
        default=Path("data/probability_cards"),
        help=(
            "Where to write probability cards when --emit-probability-card "
            "is set. Default: data/probability_cards."
        ),
    )
    parser.add_argument(
        "--history-report-path",
        type=Path,
        default=Path("data/reports/history_30session.json"),
        help=(
            "Path to the trailing-N-session HistoryReport JSON consumed by "
            "the probability card. Default: data/reports/history_30session.json."
        ),
    )
    parser.add_argument(
        "--trading-date",
        type=date.fromisoformat,
        default=None,
        help=(
            "YYYY-MM-DD override. Operator-initiated runs use this to process a "
            "partial / in-progress capture (warning logged). Skips completeness check."
        ),
    )
    parser.add_argument(
        "--root-symbol",
        default="MNQ",
        help="Root symbol. Default: MNQ.",
    )
    parser.add_argument(
        "--sessions",
        default="rth,globex",
        help="Comma-separated sessions to process. Default: rth,globex.",
    )
    parser.add_argument(
        "--drop-to",
        type=Path,
        default=None,
        help="Optional dir to receive a copy of each zone JSON (best-effort).",
    )
    parser.add_argument(
        "--bin-size-ticks", type=int, default=20, help="VP bin width in ticks. Default: 20."
    )
    parser.add_argument(
        "--adaptive-bins",
        action="store_true",
        default=False,
        help=(
            "RA-039: derive VP bin width from ATR via round(atr_14/4) clamped "
            "to [4, 40] ticks. NaN ATR transparently falls back to 20 ticks "
            "with a WARN log. When OFF (default), --bin-size-ticks is honored "
            "verbatim and the volume_profile output is byte-for-byte identical "
            "to pre-RA-039 builds."
        ),
    )
    parser.add_argument(
        "--va-pct", type=float, default=0.70, help="Value area target. Default: 0.70."
    )
    parser.add_argument(
        "--hvn-dedup-ticks", type=int, default=60, help="HVN min distance. Default: 60."
    )
    parser.add_argument("--top-n", type=int, default=6, help="HVN/LVN count. Default: 6.")
    parser.add_argument(
        "--atr-bar-size-min", type=int, default=5, help="ATR bar size in minutes. Default: 5."
    )
    parser.add_argument("--atr-period", type=int, default=14, help="ATR period. Default: 14.")
    parser.add_argument(
        "--partial-capture-warn-threshold",
        type=int,
        default=_DEFAULT_PARTIAL_CAPTURE_THRESHOLD,
        help=(
            "If a session JSONL has fewer trades than this, log a 'partial "
            f"capture' warning but still process. Default: {_DEFAULT_PARTIAL_CAPTURE_THRESHOLD}."
        ),
    )
    return parser


def _resolve_mode(args: argparse.Namespace) -> DailyZonesMode:
    """Resolve the operational mode and apply compatibility routing.

    The RA-052 contract is intentionally strict for explicit light mode:
    expensive MBO/order-lifecycle analytics must not run in the 5-minute
    intraday path. Legacy callers that pass heavy flags without ``--mode``
    still work, but they are routed to full mode with a warning.
    """
    heavy_requested = bool(args.emit_pressure_json or args.emit_cancellation_analysis)
    mode = args.mode
    if mode == "light":
        if heavy_requested:
            raise ValueError(
                "--mode light rejects --emit-pressure-json and "
                "--emit-cancellation-analysis; use --mode full for EOD-heavy analytics"
            )
        return "light"
    if mode == "full":
        args.emit_pressure_json = True
        args.emit_cancellation_analysis = True
        return "full"
    if heavy_requested:
        _LOG.warning(
            "deprecated daily_zones invocation: heavy analytics flags were passed "
            "without --mode; routing to --mode full for backward compatibility"
        )
        return "full"
    return "light"


def _configure_logfile(logs_root: Path, trading_date: date | None) -> None:
    """Add a FileHandler so the daily run leaves an audit trail per the ticket spec."""
    logs_root.mkdir(parents=True, exist_ok=True)
    stamp = trading_date.isoformat() if trading_date else _now_et().date().isoformat()
    handler = logging.FileHandler(logs_root / f"daily_zones_{stamp}.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    handler.setLevel(logging.INFO)
    logging.getLogger("rithmic_analytics").addHandler(handler)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. See module docstring for exit-code semantics."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args(argv)

    try:
        mode = _resolve_mode(args)
    except ValueError as exc:
        _LOG.error(str(exc))
        return EXIT_BAD_CONFIG

    _configure_logfile(args.logs_root, args.trading_date)

    if not args.captures_root.exists():
        _LOG.warning(f"captures root {args.captures_root} does not exist; nothing to do")
        return EXIT_OK

    target = _select_target_date(
        args.captures_root,
        explicit=args.trading_date,
        now_et=_now_et(),
    )

    if target is None:
        _LOG.warning(
            f"no complete trading day found under {args.captures_root}; nothing to do"
        )
        return EXIT_OK

    if args.trading_date is not None and not is_trading_day_complete(target, _now_et()):
        _LOG.warning(
            f"--trading-date {target} is operator override of an INCOMPLETE day; "
            f"processing partial capture"
        )

    sessions = [s.strip() for s in args.sessions.split(",") if s.strip()]
    _LOG.info(
        f"target trading_date={target} sessions={sessions} root={args.root_symbol} "
        f"mode={mode}"
    )

    any_processed = False
    for session in sessions:
        cap_path = (
            args.captures_root / target.isoformat() / f"{args.root_symbol}_{session}.jsonl"
        )
        if not cap_path.exists():
            _LOG.warning(f"no capture for {target} {session} at {cap_path}; skipping")
            continue
        result = _process_session(
            capture_path=cap_path,
            zones_root=args.zones_root,
            trading_date=target,
            root_symbol=args.root_symbol,
            session=session,
            bin_size_ticks=args.bin_size_ticks,
            va_pct=args.va_pct,
            hvn_dedup_ticks=args.hvn_dedup_ticks,
            top_n=args.top_n,
            atr_bar_size_min=args.atr_bar_size_min,
            atr_period=args.atr_period,
            partial_capture_warn_threshold=args.partial_capture_warn_threshold,
            drop_to=args.drop_to,
            bin_size_mode="adaptive" if args.adaptive_bins else "fixed",
            emit_absorption_json=args.emit_absorption_json,
            absorption_root=args.absorption_root,
            emit_pressure_json=args.emit_pressure_json,
            pressure_root=args.pressure_root,
            emit_cancellation_analysis=args.emit_cancellation_analysis,
            cancellations_root=args.cancellations_root,
            orders_root=args.orders_root,
            emit_probability_card=args.emit_probability_card,
            probability_card_root=args.probability_card_root,
            history_report_path=args.history_report_path,
            allow_normalize=(mode == "full"),
        )
        if result is not None:
            any_processed = True

    if not any_processed:
        _LOG.warning(f"no sessions produced output for {target}")

    # RA-033: heartbeat-of-heartbeat watchdog (silent on bootstrap)
    _check_prior_heartbeat(args.heartbeat_dir, target)

    # RA-032: end-of-run digest (silent no-op when webhook unconfigured)
    try:
        from rithmic_analytics.ops.alerts import post_digest
        digest_msg = (
            f"{args.root_symbol} {target.isoformat()}: "
            f"{'sessions processed' if any_processed else 'no sessions produced output'}"
        )
        post_digest(digest_msg)
    except Exception as exc:  # never let alerter take down daily_zones
        _LOG.error(f"daily digest post failed: {exc}")

    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
