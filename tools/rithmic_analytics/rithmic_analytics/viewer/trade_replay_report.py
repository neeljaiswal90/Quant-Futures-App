"""Trade-replay HTML report — one row per fill + summary header.

Renders a :class:`ReplaySession` to a self-contained HTML page:

1. **Header** — total fills, gross PnL, hit-rate @ 60s, best entry hour-of-day
   window (when ≥3 fills in the bucket).
2. **Fills table** — time, side, price, qty, pre-delta, post-delta,
   pnl@60s/300s/900s, nearest zone. PnL@60s cells are green/red coded.
3. **Cancellations summary** — count + cancellation-rate (when cancellations
   were supplied by the loader).
4. **Skip-counter callout** — surfaces ``fills_skipped_symbol_mismatch`` and
   ``fills_skipped_outside_window`` so import issues are visible.

Static, no JS. Dark theme vendored from the other viewers (see
``capture_dashboard.py`` for the shared-CSS extract follow-up).
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from rithmic_analytics.features.trade_replay import FillSnapshot, ReplaySession

_ET: ZoneInfo = ZoneInfo("America/New_York")
_NS_PER_SECOND: int = 10**9
_MIN_FILLS_FOR_TOD_BUCKET: int = 3  # ≥3 fills in a bucket to qualify for "best window"

# Vendored from capture_dashboard.py + extended with PnL classes; see the
# shared-CSS extract follow-up.
_CSS = """
:root {
  --bg: #0d1117; --panel: #161b22; --border: #30363d;
  --text: #c9d1d9; --muted: #8b949e; --accent: #58a6ff;
  --warn: #d29922; --fail: #f85149; --ok: #56d364;
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg); color: var(--text); margin: 0; padding: 16px;
  font-size: 14px;
}
.container { max-width: 1280px; margin: 0 auto; }
header { padding: 16px 0; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
header h1 { margin: 0 0 6px 0; font-size: 22px; color: var(--accent); }
.summary-stats { color: var(--muted); font-family: ui-monospace, monospace; }
section {
  margin: 24px 0; padding: 16px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 6px;
}
section h2 { margin-top: 0; font-size: 18px; color: var(--accent); }
table { width: 100%; border-collapse: collapse;
        font-family: ui-monospace, monospace; font-size: 13px; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 500; }
tr:hover td { background: rgba(88, 166, 255, 0.05); }
.empty-state { color: var(--muted); font-style: italic; }
.pnl-positive { color: var(--ok); font-weight: 600; }
.pnl-negative { color: var(--fail); font-weight: 600; }
.pnl-zero { color: var(--muted); }
.pnl-na { color: var(--muted); font-style: italic; }
.side-buy { color: var(--ok); }
.side-sell { color: var(--fail); }
.delta-positive { color: var(--ok); }
.delta-negative { color: var(--fail); }
.warn-callout {
  background: rgba(210, 153, 34, 0.1); border-left: 3px solid var(--warn);
  padding: 8px 12px; margin: 12px 0; color: var(--text);
}
.quarantined { background: rgba(248, 81, 73, 0.08); }
.quarantined td { color: var(--muted); }
footer { text-align: center; color: var(--muted); font-size: 12px; padding: 24px 0; }
"""


def _fmt_ts_et(ns: int) -> str:
    """UTC ns → ET HH:MM:SS string."""
    dt_utc = datetime.fromtimestamp(ns / _NS_PER_SECOND, tz=UTC)
    return dt_utc.astimezone(_ET).strftime("%H:%M:%S")


def _fmt_dollar(v: float | None) -> str:
    """Format a PnL value with green/red CSS class. ``None`` → italic em-dash."""
    if v is None:
        return "<span class='pnl-na'>—</span>"
    if isinstance(v, float) and math.isnan(v):
        return "<span class='pnl-na'>nan</span>"
    cls = "pnl-positive" if v > 0 else ("pnl-negative" if v < 0 else "pnl-zero")
    sign = "+" if v > 0 else ""
    return f"<span class='{cls}'>{sign}${v:,.2f}</span>"


def _fmt_int(v: int) -> str:
    if v == 0:
        return "<span class='pnl-zero'>0</span>"
    cls = "delta-positive" if v > 0 else "delta-negative"
    sign = "+" if v > 0 else ""
    return f"<span class='{cls}'>{sign}{v:,}</span>"


def _nearest_zone_cell(snap: FillSnapshot) -> str:
    if not snap.pre_zone_proximity:
        return "<span class='pnl-na'>—</span>"
    zid, dist = min(snap.pre_zone_proximity.items(), key=lambda kv: kv[1])
    suffix = " (atr-fb)" if snap.atr_fallback else ""
    return f"{zid} ({dist:.2f}pt){suffix}"


# ---------------------------------------------------------------------------
# Summary stats
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _BestWindow:
    """The hour-of-day bucket with the strongest hit-rate (ties → highest PnL)."""

    et_hour_start: int
    et_hour_end: int
    fills: int
    wins: int
    hit_rate: float
    total_pnl: float


@dataclass(frozen=True, slots=True)
class _SummaryStats:
    """Header summary computed once per render."""

    total_fills: int
    total_pnl_60s: float
    hit_rate_60s: float | None
    best_window: _BestWindow | None
    cancellation_count: int


def _summary_stats(session: ReplaySession) -> _SummaryStats:
    """Compute header summary: total PnL, hit-rate, best ET hour window."""
    snapshots = session.snapshots
    if not snapshots:
        return _SummaryStats(
            total_fills=0,
            total_pnl_60s=0.0,
            hit_rate_60s=None,
            best_window=None,
            cancellation_count=len(session.cancelled),
        )

    valid_pnls: list[float] = []
    for s in snapshots:
        p = s.realized_pnl.get(60)
        if p is None:
            continue
        if isinstance(p, float) and math.isnan(p):
            continue
        valid_pnls.append(float(p))

    total = sum(valid_pnls)
    wins = sum(1 for p in valid_pnls if p > 0)
    hit_rate = (wins / len(valid_pnls)) if valid_pnls else None

    # Best entry hour-of-day window (ET buckets)
    buckets: dict[int, list[float]] = defaultdict(list)
    for s in snapshots:
        p = s.realized_pnl.get(60)
        if p is None or (isinstance(p, float) and math.isnan(p)):
            continue
        et_hour = datetime.fromtimestamp(
            s.fill.fill_ts_ns / _NS_PER_SECOND, tz=UTC
        ).astimezone(_ET).hour
        buckets[et_hour].append(float(p))

    qualified = {
        h: pnls for h, pnls in buckets.items() if len(pnls) >= _MIN_FILLS_FOR_TOD_BUCKET
    }
    best_window: _BestWindow | None = None
    if qualified:
        # Best = highest hit rate; tie-break on total PnL
        def _score(item: tuple[int, list[float]]) -> tuple[float, float]:
            _, pnls = item
            hit = sum(1 for p in pnls if p > 0) / len(pnls)
            return hit, sum(pnls)

        h, pnls = max(qualified.items(), key=_score)
        wins_in_h = sum(1 for p in pnls if p > 0)
        best_window = _BestWindow(
            et_hour_start=h,
            et_hour_end=h + 1,
            fills=len(pnls),
            wins=wins_in_h,
            hit_rate=wins_in_h / len(pnls),
            total_pnl=sum(pnls),
        )

    return _SummaryStats(
        total_fills=len(snapshots),
        total_pnl_60s=total,
        hit_rate_60s=hit_rate,
        best_window=best_window,
        cancellation_count=len(session.cancelled),
    )


# ---------------------------------------------------------------------------
# HTML sections
# ---------------------------------------------------------------------------


def _render_header(session: ReplaySession, title: str, stats: _SummaryStats) -> str:
    pieces = [
        f"{stats.total_fills} fills",
        f"PnL@60s: {_fmt_dollar(stats.total_pnl_60s)}",
    ]
    if stats.hit_rate_60s is not None:
        pieces.append(f"hit-rate {stats.hit_rate_60s * 100:.1f}%")
    if stats.cancellation_count:
        pieces.append(f"{stats.cancellation_count} cancelled")

    bw = stats.best_window
    if bw is not None:
        pieces.append(
            f"best window {bw.et_hour_start:02d}:00–{bw.et_hour_end:02d}:00 ET "
            f"({bw.wins}/{bw.fills} = {bw.hit_rate * 100:.0f}%, "
            f"{_fmt_dollar(bw.total_pnl)})"
        )

    summary = " · ".join(pieces)
    computed_at = datetime.now(UTC).isoformat()

    return (
        f"<header><h1>{title}</h1>"
        f"<div class='summary-stats'>{session.target_symbol} · "
        f"window={session.window_seconds}s · pnl horizons="
        f"{','.join(str(h) for h in session.pnl_horizons_seconds)}s · "
        f"computed {computed_at}</div>"
        f"<div class='summary-stats'>{summary}</div></header>"
    )


def _render_skip_callouts(session: ReplaySession) -> str:
    """Surface skip counts if non-zero so import issues are visible."""
    callouts: list[str] = []
    if session.fills_skipped_symbol_mismatch:
        callouts.append(
            f"<div class='warn-callout'>"
            f"⚠ {session.fills_skipped_symbol_mismatch} fill(s) skipped — "
            f"symbol doesn't match target {session.target_symbol!r}. "
            f"Check the trade log for cross-symbol entries."
            f"</div>"
        )
    if session.fills_skipped_outside_window:
        callouts.append(
            f"<div class='warn-callout'>"
            f"⚠ {session.fills_skipped_outside_window} fill(s) skipped — "
            f"timestamp outside the JSONL capture window. "
            f"Trade log may span a date the capture doesn't cover."
            f"</div>"
        )
    return "\n".join(callouts)


def _render_fills_table(session: ReplaySession) -> str:
    snapshots = session.snapshots
    if not snapshots:
        return (
            "<section><h2>Fills</h2>"
            "<p class='empty-state'>No fills in this replay session.</p>"
            "</section>"
        )

    horizons = session.pnl_horizons_seconds
    pnl_th = "".join(f"<th>PnL @ {h}s</th>" for h in horizons)
    header = (
        "<thead><tr>"
        "<th>Time (ET)</th><th>Side</th><th>Price</th><th>Qty</th>"
        "<th>Pre Δ</th><th>Post Δ</th>"
        f"{pnl_th}"
        "<th>Nearest zone</th>"
        "</tr></thead>"
    )

    rows: list[str] = []
    for snap in snapshots:
        f = snap.fill
        side_cls = "side-buy" if f.side == "buy" else "side-sell"
        row_cls = " class='quarantined'" if f.quarantined else ""
        pnl_cells = "".join(
            f"<td>{_fmt_dollar(snap.realized_pnl.get(h))}</td>" for h in horizons
        )
        rows.append(
            f"<tr{row_cls}>"
            f"<td>{_fmt_ts_et(f.fill_ts_ns)}</td>"
            f"<td class='{side_cls}'>{f.side}</td>"
            f"<td>{f.price:,.2f}</td>"
            f"<td>{f.quantity}</td>"
            f"<td>{_fmt_int(snap.pre_delta)}</td>"
            f"<td>{_fmt_int(snap.post_delta)}</td>"
            f"{pnl_cells}"
            f"<td>{_nearest_zone_cell(snap)}</td>"
            f"</tr>"
        )

    return (
        f"<section><h2>Fills ({len(snapshots)})</h2><table>"
        f"{header}<tbody>{''.join(rows)}</tbody></table></section>"
    )


def _render_cancellations(session: ReplaySession) -> str:
    if not session.cancelled:
        return ""
    total = len(session.cancelled) + len(session.snapshots)
    cancel_rate = (
        len(session.cancelled) / total if total > 0 else 0.0
    )
    rows: list[str] = []
    for c in session.cancelled:
        side_cls = "side-buy" if c.side == "buy" else "side-sell"
        intent = (
            f"limit {c.limit_price:,.2f}" if c.limit_price is not None
            else f"stop {c.stop_price:,.2f}" if c.stop_price is not None
            else "—"
        )
        rows.append(
            f"<tr>"
            f"<td>{_fmt_ts_et(c.cancel_ts_ns)}</td>"
            f"<td class='{side_cls}'>{c.side}</td>"
            f"<td>{c.order_type}</td>"
            f"<td>{intent}</td>"
            f"<td>{c.quantity}</td>"
            f"<td>{c.status}</td>"
            f"</tr>"
        )
    return (
        f"<section><h2>Cancellations ({len(session.cancelled)} of {total} = "
        f"{cancel_rate * 100:.0f}%)</h2><table>"
        "<thead><tr><th>Time (ET)</th><th>Side</th><th>Type</th>"
        "<th>Intent</th><th>Qty</th><th>Status</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table></section>"
    )


# ---------------------------------------------------------------------------
# Cancellation outcomes (RA-036)
# ---------------------------------------------------------------------------


def _render_cancellation_outcomes(report: object | None) -> str:
    """Render the RA-036 cancellation-outcomes section.

    ``report`` is a :class:`CancellationAnalysisReport` (imported
    lazily / typed as ``object`` to avoid a viewer-feature import
    coupling). Returns empty string if ``report`` is None or carries no
    outcomes — section is omitted entirely in that case.
    """
    if report is None:
        return ""
    # Lazy import for type checks
    from rithmic_analytics.features.cancellation_analysis import (
        CancellationAnalysisReport,
    )
    if not isinstance(report, CancellationAnalysisReport):
        return ""
    if not report.per_cancel_outcomes:
        return ""

    s = report.session_summary
    rate_str = (
        f"{s.regret_cancel_rate * 100:.1f}%"
        if s.regret_cancel_rate is not None else "n/a"
    )
    avg_str = (
        f"+{s.avg_regret_pts:.2f}pt"
        if s.avg_regret_pts is not None else "n/a"
    )
    rate_class = (
        "pnl-negative" if s.regret_cancel_rate is not None
        and s.regret_cancel_rate > 0.20 else "pnl-zero"
    )

    callout = (
        "<div class='summary-stats' style='margin-bottom:12px'>"
        f"<span class='{rate_class}'>regret_cancel_rate: {rate_str}</span> · "
        f"avg_regret: {avg_str} · "
        f"{s.n_reached_limit}/{s.n_cancels_analyzed} reached limit · "
        f"{s.n_regret_rebuys} regret rebuys"
    )
    if s.regret_cancel_rate is not None and s.regret_cancel_rate > 0.20:
        callout += (
            " <span class='pnl-negative'>⚠ Rule 7 alarm (>20%)</span>"
        )
    callout += "</div>"

    rows: list[str] = []
    for o in report.per_cancel_outcomes:
        ts_et = _fmt_ts_et(o.cancel_ts_ns)
        side_cls = "side-buy" if o.side == "buy" else "side-sell"
        limit_str = f"{o.limit_price:,.2f}" if o.limit_price is not None else "—"
        reached_cell = (
            "<span class='pnl-positive'>✓</span>" if o.reached_limit
            else "<span class='pnl-zero'>·</span>"
        )
        dir_cls = {
            "favorable": "pnl-negative",  # regret = bad for trader
            "unfavorable": "pnl-positive",  # cancel was correct
            "neutral": "pnl-zero",
        }[o.direction]
        max_fav = (
            f"<span class='{dir_cls}'>{o.max_favorable_pts:+.2f}pt</span>"
            if o.max_favorable_pts is not None else "—"
        )
        rebuy_cell = (
            "<span class='pnl-negative'>✓</span>" if o.regret_rebuy_at_worse_price
            else "<span class='pnl-zero'>·</span>"
        )
        notes_parts: list[str] = []
        if o.window_truncated:
            notes_parts.append("trunc")
        if not o.has_sufficient_tape:
            notes_parts.append("low-tape")
        if o.unanalyzable_reason:
            notes_parts.append(o.unanalyzable_reason)
        notes = ", ".join(notes_parts) or "—"
        rows.append(
            f"<tr>"
            f"<td>{ts_et}</td>"
            f"<td class='{side_cls}'>{o.side}</td>"
            f"<td>{limit_str}</td>"
            f"<td>{reached_cell}</td>"
            f"<td class='{dir_cls}'>{o.direction}</td>"
            f"<td>{max_fav}</td>"
            f"<td>{rebuy_cell}</td>"
            f"<td><span class='pnl-na'>{notes}</span></td>"
            f"</tr>"
        )

    return (
        f"<section><h2>Cancellation Outcomes ({len(report.per_cancel_outcomes)})</h2>"
        f"{callout}"
        "<table><thead><tr>"
        "<th>Time (ET)</th><th>Side</th><th>Limit</th><th>Reached?</th>"
        "<th>Direction</th><th>Max favorable</th><th>Rebuy?</th><th>Notes</th>"
        "</tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table></section>"
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def render_trade_replay_html(
    session: ReplaySession,
    output_path: Path,
    *,
    title: str | None = None,
    cancellation_report: object | None = None,
) -> Path:
    """Render a :class:`ReplaySession` to a self-contained HTML file.

    Args:
        session: Output of :func:`replay_session`.
        output_path: Destination ``.html`` path. Parent dir created on demand.
        title: Optional report title. Defaults to ``"Trade Replay — <symbol>"``.
        cancellation_report: Optional :class:`CancellationAnalysisReport`
            (RA-036). When supplied, a "Cancellation Outcomes" section is
            inserted between the Cancellations count and the footer. Typed
            as ``object`` to avoid a hard import dependency on the
            features module at the viewer layer.

    Returns:
        Resolved ``output_path``.

    Example:
        >>> from pathlib import Path
        >>> from rithmic_analytics.viewer.trade_replay_report import render_trade_replay_html
        >>> render_trade_replay_html(session, Path("data/reports/replay.html"))
    """
    final_title = title or f"Trade Replay — {session.target_symbol}"
    stats = _summary_stats(session)

    full_html = (
        "<!DOCTYPE html>\n"
        f"<html lang='en'><head><meta charset='utf-8'>"
        f"<title>{final_title}</title>"
        f"<style>{_CSS}</style></head><body><div class='container'>"
        f"{_render_header(session, final_title, stats)}"
        f"{_render_skip_callouts(session)}"
        f"{_render_fills_table(session)}"
        f"{_render_cancellations(session)}"
        f"{_render_cancellation_outcomes(cancellation_report)}"
        f"<footer>Generated by rithmic_analytics · see docs/feature_reference.md</footer>"
        f"</div></body></html>"
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(full_html, encoding="utf-8")
    return output_path
