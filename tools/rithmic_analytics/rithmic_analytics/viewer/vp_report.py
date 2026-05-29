"""Daily HTML report — composes VP, CVD, footprint, absorption, multi-session, gaps.

Single-file output with inlined Plotly bundle by default (~3 MB per report,
portable to environments without internet). Sections rendered top-to-bottom:

    1. Header with summary stats + optional gap-alert callout
    2. Zone & reference-line table from a fresh ZoneEnvelope
    3. CVD + price chart fragment (from _build_cvd_figure)
    4. Footprint heatmap fragment (from _build_footprint_figure)
    5. Absorption events table (optional — empty-state if no events)
    6. Multi-session HVN status (optional — omit if multi_session=None)
    7. Gap warnings filtered to the trading date from alerts.ndjson

Dark theme (matches Neel's TradingView setup). Vanilla CSS, no framework.
Pure f-string templating; no Jinja2 dep.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path

import pandas as pd

from rithmic_analytics.core.contracts import ContractSpec
from rithmic_analytics.core.schema import ZoneEnvelope
from rithmic_analytics.features.absorption import AbsorptionEvent
from rithmic_analytics.features.atr import compute_atr_from_ticks
from rithmic_analytics.features.multi_session import MultiSessionVP
from rithmic_analytics.features.volume_profile import compute_vp
from rithmic_analytics.viewer.cvd_plot import _build_cvd_figure
from rithmic_analytics.viewer.footprint_html import _build_footprint_figure

_DEFAULT_ALERTS_PATH = Path("data/alerts/alerts.ndjson")
_DEFAULT_REPORTS_ROOT = Path("data/reports")


# ---------------------------------------------------------------------------
# CSS (dark theme, vanilla)
# ---------------------------------------------------------------------------

_CSS = """
:root {
  --bg: #0d1117; --panel: #161b22; --border: #30363d;
  --text: #c9d1d9; --muted: #8b949e; --accent: #58a6ff;
  --warn: #d29922; --fail: #f85149;
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg); color: var(--text); margin: 0; padding: 16px;
  font-size: 14px;
}
.container { max-width: 1200px; margin: 0 auto; }
header { padding: 16px 0; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
header h1 { margin: 0 0 6px 0; font-size: 22px; color: var(--accent); }
.summary-stats { color: var(--muted); font-family: ui-monospace, monospace; }
.header-alert {
  margin-top: 10px; padding: 8px 12px; background: var(--warn);
  color: #1a1300; border-radius: 4px; font-weight: 500;
}
.header-alert a { color: #1a1300; text-decoration: underline; }
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
.conv-SUPER { color: #56d364; font-weight: 600; }
.conv-HIGH { color: var(--accent); font-weight: 500; }
.conv-MED { color: var(--text); }
.conv-LOW { color: var(--muted); }
.sev-WARN { color: var(--warn); }
.sev-FAIL { color: var(--fail); font-weight: 600; }
.chart-container { width: 100%; overflow-x: auto; }
footer { text-align: center; color: var(--muted); font-size: 12px; padding: 24px 0; }
"""


# ---------------------------------------------------------------------------
# Section helpers
# ---------------------------------------------------------------------------


def _render_header(
    *,
    symbol: str,
    trading_date: date,
    title: str,
    computed_at: str,
    envelope: ZoneEnvelope,
    n_trades: int,
    gap_count: int,
) -> str:
    """Header with summary line and optional gap-alert callout."""
    def _fmt(v: float, dp: int = 2) -> str:
        return "nan" if v != v else f"{v:,.{dp}f}"  # NaN check via self-inequality

    summary = (
        f"VPOC={_fmt(envelope.vpoc)} · "
        f"VAH={_fmt(envelope.vah)} · "
        f"VAL={_fmt(envelope.val)} · "
        f"ATR14={_fmt(envelope.atr_14, 1)} · "
        f"{n_trades:,} trades · "
        f"{len(envelope.zones)} zones"
    )

    if gap_count > 0:
        plural = "" if gap_count == 1 else "s"
        callout = (
            f'<div class="header-alert">⚠ '
            f'<a href="#gap-warnings">{gap_count} gap alert{plural} detected</a>'
            f"</div>"
        )
    else:
        callout = ""

    return (
        f"<header>"
        f"<h1>{title}</h1>"
        f"<div class='summary-stats'>{symbol} · {trading_date.isoformat()} · "
        f"computed {computed_at}</div>"
        f"<div class='summary-stats'>{summary}</div>"
        f"{callout}"
        f"</header>"
    )


def _render_zones_table(envelope: ZoneEnvelope) -> str:
    if not envelope.zones:
        return (
            "<section><h2>Zones</h2>"
            "<p class='empty-state'>No zones produced (empty VP).</p>"
            "</section>"
        )
    # Sort by conviction priority, then by zone center desc
    _PRIORITY = {"SUPER": 0, "HIGH": 1, "MED": 2, "LOW": 3}
    ordered = sorted(
        envelope.zones,
        key=lambda z: (_PRIORITY.get(z.conviction, 99), -(z.top + z.bot) / 2),
    )
    rows = []
    for z in ordered:
        vol_pct = "" if z.volume_pct is None else f"{z.volume_pct * 100:.1f}%"
        rows.append(
            f"<tr><td>{z.id}</td><td>{z.type}</td>"
            f"<td>{z.bot:,.2f}</td><td>{z.top:,.2f}</td>"
            f"<td class='conv-{z.conviction}'>{z.conviction}</td>"
            f"<td>{', '.join(z.sources)}</td><td>{vol_pct}</td></tr>"
        )
    return (
        "<section><h2>Zones</h2><table>"
        "<thead><tr><th>ID</th><th>Type</th><th>Bot</th><th>Top</th>"
        "<th>Conviction</th><th>Sources</th><th>Vol %</th></tr></thead>"
        "<tbody>" + "\n".join(rows) + "</tbody></table></section>"
    )


def _render_absorption_table(events: list[AbsorptionEvent]) -> str:
    if not events:
        return (
            "<section><h2>Absorption events</h2>"
            "<p class='empty-state'>No absorption events for this session.</p>"
            "</section>"
        )
    ordered = sorted(events, key=lambda e: -e.score)
    rows = []
    for e in ordered:
        ts = datetime.fromtimestamp(e.start_ts_ns // 10**9, tz=UTC).isoformat()
        factors = " ".join(f"{k}={v:.2f}" for k, v in e.factors.items())
        confirmed = "✓" if e.confirmed else "—"
        rows.append(
            f"<tr><td>{ts}</td><td>{e.side}</td>"
            f"<td>{e.dominant_price:,.2f}</td><td>{e.volume:,}</td>"
            f"<td>{e.score:.3f}</td><td>{confirmed}</td>"
            f"<td><small>{factors}</small></td></tr>"
        )
    return (
        "<section><h2>Absorption events</h2><table>"
        "<thead><tr><th>Time (UTC)</th><th>Side</th><th>Dominant price</th>"
        "<th>Volume</th><th>Score</th><th>Confirmed</th><th>Factors</th></tr></thead>"
        "<tbody>" + "\n".join(rows) + "</tbody></table></section>"
    )


def _render_multi_session_table(multi: MultiSessionVP | None) -> str:
    """Returns empty string when ``multi`` is None (section omitted entirely)."""
    if multi is None:
        return ""
    if not multi.hvns:
        return (
            "<section><h2>Multi-session HVN status</h2>"
            f"<p class='empty-state'>0 structural clusters identified across "
            f"{multi.rolling_window} session(s).</p></section>"
        )
    rows = []
    for h in multi.hvns:
        rows.append(
            f"<tr><td>{h.price_low:,.2f} – {h.price_high:,.2f}</td>"
            f"<td>{h.multi_session_count}</td>"
            f"<td><small>{', '.join(h.member_sessions)}</small></td>"
            f"<td class='conv-{h.conviction}'>{h.conviction}</td>"
            f"<td>{h.total_volume:,}</td></tr>"
        )
    return (
        "<section><h2>Multi-session HVN status</h2><table>"
        "<thead><tr><th>Price band</th><th>Count</th><th>Sessions</th>"
        "<th>Conviction</th><th>Total vol</th></tr></thead>"
        "<tbody>" + "\n".join(rows) + "</tbody></table></section>"
    )


def _render_gap_warnings(alerts_path: Path | None, trading_date: date) -> tuple[str, int]:
    """Return (section_html, gap_count) for the trading date.

    Distinguishes two empty states:
        - "No alerts file configured" → file doesn't exist
        - "No gaps detected" → file exists but no matching entries
    """
    path = alerts_path or _DEFAULT_ALERTS_PATH
    if not path.exists():
        return (
            "<section id='gap-warnings'><h2>Gap warnings</h2>"
            f"<p class='empty-state'>No alerts file configured (looked at {path}).</p>"
            "</section>",
            0,
        )

    date_str = trading_date.isoformat()
    matching: list[dict[str, object]] = []
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            session_id = rec.get("session_id", "")
            if isinstance(session_id, str) and date_str in session_id:
                matching.append(rec)

    if not matching:
        return (
            "<section id='gap-warnings'><h2>Gap warnings</h2>"
            "<p class='empty-state'>No gaps detected for this trading date.</p>"
            "</section>",
            0,
        )

    rows = []
    for r in matching:
        ts = str(r.get("ts_iso", ""))
        sid = str(r.get("session_id", ""))
        stream = str(r.get("stream", ""))
        gtype = str(r.get("gap_type", ""))
        gval = r.get("gap_value_ns")
        gval_str = "—" if not isinstance(gval, int | float) else f"{int(gval):,}"
        sev = str(r.get("severity", ""))
        rows.append(
            f"<tr><td>{ts}</td><td>{sid}</td><td>{stream}</td>"
            f"<td>{gtype}</td><td>{gval_str}</td>"
            f"<td class='sev-{sev}'>{sev}</td></tr>"
        )
    return (
        "<section id='gap-warnings'><h2>Gap warnings</h2><table>"
        "<thead><tr><th>Time (UTC)</th><th>Session</th><th>Stream</th>"
        "<th>Type</th><th>Gap (ns)</th><th>Severity</th></tr></thead>"
        "<tbody>" + "\n".join(rows) + "</tbody></table></section>",
        len(matching),
    )


def default_report_path(
    trading_date: date, symbol: str, *, reports_root: Path = _DEFAULT_REPORTS_ROOT
) -> Path:
    """Conventional location: ``data/reports/daily_report_YYYY-MM-DD_SYMBOL.html``."""
    return reports_root / f"daily_report_{trading_date.isoformat()}_{symbol}.html"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def render_daily_report(
    *,
    trades: pd.DataFrame,
    contract: ContractSpec,
    output_path: Path,
    trading_date: date,
    symbol: str = "MNQ",
    title: str | None = None,
    absorption_events: list[AbsorptionEvent] | None = None,
    multi_session: MultiSessionVP | None = None,
    alerts_path: Path | None = None,
    bar_size_sec: int = 60,
    footprint_time_bin_sec: int = 30,
    footprint_price_bin_ticks: int = 1,
    include_plotlyjs: str | bool = True,
) -> Path:
    """Compose a self-contained daily HTML report.

    Args:
        trades: DataFrame from ``load_obs01_trades``.
        contract: ``ContractSpec`` for tick-aware pricing.
        output_path: Where to write the HTML file.
        trading_date: Trading date for the session (drives the gap-warning
            filter + header label).
        symbol: Root symbol. Default ``"MNQ"``.
        title: Header title. Defaults to ``"{symbol} Daily Report —
            {trading_date.isoformat()}"`` when ``None``.
        absorption_events: Optional. ``None`` and ``[]`` both render an
            empty-state placeholder (operator chose to include the section).
            To omit the section entirely is currently not supported — the
            empty state is operationally informative ("we looked, found
            nothing").
        multi_session: ``None`` → section omitted entirely. Empty ``hvns``
            list → section rendered with "0 structural clusters" placeholder.
        alerts_path: NDJSON alerts file. ``None`` falls back to
            ``data/alerts/alerts.ndjson`` (conventional location). Missing
            file → "no alerts file configured" placeholder.
        bar_size_sec: CVD chart candlestick bar size. Default 60.
        footprint_time_bin_sec: Footprint x-axis bin width. Default 30.
        footprint_price_bin_ticks: Footprint y-axis bin width in ticks. Default 1.
        include_plotlyjs: ``True`` (default) inlines the ~3 MB Plotly bundle
            for offline viewing. ``"cdn"`` references the CDN script (~5 KB
            file, internet required).

    Returns:
        Resolved ``output_path``.

    Raises:
        ValueError: If ``trades`` is empty.

    Example:
        >>> from datetime import date
        >>> from rithmic_analytics.core.contracts import MNQ
        >>> render_daily_report(
        ...     trades=df, contract=MNQ,
        ...     output_path=Path("daily.html"),
        ...     trading_date=date(2026, 5, 17),
        ... )
    """
    if len(trades) == 0:
        raise ValueError("cannot render daily report from empty trades DataFrame")

    final_title = title or f"{symbol} Daily Report — {trading_date.isoformat()}"
    computed_at = datetime.now(UTC).isoformat()

    # ---- Compute zone envelope from trades ----
    vp = compute_vp(trades, contract)
    atr_14 = compute_atr_from_ticks(trades)
    envelope = ZoneEnvelope.from_volume_profile(
        vp,
        symbol=symbol,
        timeframe="rth",
        atr_14=atr_14,
        data_source="rithmic",
        bin_size_ticks=20,
        bars_used=len(trades),
        computed_at=computed_at,
    )

    # ---- Build chart figures ----
    cvd_fig = _build_cvd_figure(trades, bar_size_sec=bar_size_sec)
    fp_fig, _price_bin = _build_footprint_figure(
        trades,
        contract,
        time_bin_sec=footprint_time_bin_sec,
        price_bin_ticks=footprint_price_bin_ticks,
    )

    # First chart carries the Plotly bundle; subsequent ones reuse it.
    cvd_html = cvd_fig.to_html(full_html=False, include_plotlyjs=include_plotlyjs)
    fp_html = fp_fig.to_html(full_html=False, include_plotlyjs=False)

    # ---- Sections that depend on gap_count first (header needs it) ----
    gap_section_html, gap_count = _render_gap_warnings(alerts_path, trading_date)

    header_html = _render_header(
        symbol=symbol,
        trading_date=trading_date,
        title=final_title,
        computed_at=computed_at,
        envelope=envelope,
        n_trades=len(trades),
        gap_count=gap_count,
    )
    zones_html = _render_zones_table(envelope)
    absorption_html = _render_absorption_table(absorption_events or [])
    multi_html = _render_multi_session_table(multi_session)  # "" when None

    full_html = (
        "<!DOCTYPE html>\n"
        f"<html lang='en'><head><meta charset='utf-8'>"
        f"<title>{final_title}</title>"
        f"<style>{_CSS}</style>"
        f"</head><body><div class='container'>"
        f"{header_html}"
        f"{zones_html}"
        f"<section><h2>CVD + Price</h2><div class='chart-container'>{cvd_html}</div></section>"
        f"<section><h2>Footprint</h2><div class='chart-container'>{fp_html}</div></section>"
        f"{absorption_html}"
        f"{multi_html}"
        f"{gap_section_html}"
        f"<footer>Generated by rithmic_analytics · see docs/architecture.md</footer>"
        f"</div></body></html>"
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(full_html, encoding="utf-8")
    return output_path
