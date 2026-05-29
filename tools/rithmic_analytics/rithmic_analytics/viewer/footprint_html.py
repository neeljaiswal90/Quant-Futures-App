"""Footprint heatmap HTML viewer.

Renders the (time × price) net-delta grid as a Plotly heatmap with:
    - Diverging RdYlGn colorscale centered at 0 (green = net buy, red = net sell)
    - Cell text = signed net delta (``+336`` / ``-184`` / blank for NaN)
    - Hover = time bin, price level, net delta value
    - Default Plotly zoom/pan/modebar
    - Optional side-by-side TradingView screenshot panel for visual cross-check

Output is a single self-contained HTML file. Plotly JS via CDN by default;
``include_plotlyjs=True`` inlines for offline viewing.
"""

from __future__ import annotations

import base64
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go

from rithmic_analytics.core.contracts import ContractSpec
from rithmic_analytics.features.footprint import Footprint, compute_footprint


def _format_cell(v: float) -> str:
    """Cell label format: ``+336``, ``-184``, ``""`` for NaN."""
    if pd.isna(v):
        return ""
    return f"{int(v):+d}"


def _build_text_grid(deltas: pd.DataFrame) -> list[list[str]]:
    """Per-cell text labels matching the (rows, cols) shape of ``deltas``."""
    return [[_format_cell(v) for v in row] for row in deltas.to_numpy()]


def _tv_screenshot_panel(tv_screenshot_path: Path | None) -> str:
    """Right-pane HTML: embedded screenshot if provided, else placeholder instructions."""
    if tv_screenshot_path is None:
        return (
            '<div class="tv-placeholder">'
            "<h3>TradingView cross-check</h3>"
            "<p>To compare against your TradingView chart for the same window, "
            "save a screenshot and pass <code>--tv-screenshot &lt;path&gt;</code> "
            "(CLI) or <code>tv_screenshot_path=Path(...)</code> (library).</p>"
            "</div>"
        )
    image_bytes = tv_screenshot_path.read_bytes()
    encoded = base64.b64encode(image_bytes).decode("ascii")
    suffix = tv_screenshot_path.suffix.lower().lstrip(".") or "png"
    return (
        '<div class="tv-image">'
        "<h3>TradingView reference</h3>"
        f'<img src="data:image/{suffix};base64,{encoded}" '
        f'alt="TradingView screenshot ({tv_screenshot_path.name})">'
        "</div>"
    )


_OUTER_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            margin: 0; padding: 16px; background: #fafafa; }}
    .header {{ font-size: 18px; font-weight: 600; margin-bottom: 12px; }}
    .container {{ display: flex; gap: 16px; flex-wrap: wrap; }}
    .footprint-panel {{ flex: 2 1 720px; background: #fff;
                         box-shadow: 0 1px 4px rgba(0,0,0,0.05); padding: 12px;
                         border-radius: 4px; }}
    .tv-panel {{ flex: 1 1 360px; background: #fff;
                  box-shadow: 0 1px 4px rgba(0,0,0,0.05); padding: 12px;
                  border-radius: 4px; }}
    .tv-placeholder {{ color: #666; font-size: 14px; }}
    .tv-placeholder code {{ background: #eee; padding: 2px 4px; border-radius: 2px; }}
    .tv-image img {{ max-width: 100%; height: auto; }}
    .footer {{ font-size: 12px; color: #999; margin-top: 16px; }}
  </style>
</head>
<body>
  <div class="header">{title}</div>
  <div class="container">
    <div class="footprint-panel">{chart_html}</div>
    <div class="tv-panel">{tv_panel}</div>
  </div>
  <div class="footer">
    Diverging colorscale RdYlGn centered at 0. Green = net buy aggression,
    red = net sell aggression. Cell text = signed net delta.
    Time bin {time_bin_sec}s · price bin {price_bin} pt.
  </div>
</body>
</html>
"""


def _build_footprint_figure(
    trades: pd.DataFrame,
    contract: ContractSpec,
    *,
    title: str | None = None,
    time_bin_sec: int = 30,
    price_bin_ticks: int = 1,
) -> tuple[go.Figure, float]:
    """Build the footprint heatmap figure and return it with resolved ``price_bin``.

    Factored out of :func:`render_footprint_html` so the daily report can embed
    the figure fragment without the TV-comparison panel wrapping.

    Raises:
        ValueError: If ``trades`` is empty or computed deltas grid is empty.
    """
    if len(trades) == 0:
        raise ValueError("cannot render footprint chart from empty trades DataFrame")

    fp: Footprint = compute_footprint(
        trades, contract, time_bin_sec=time_bin_sec, price_bin_ticks=price_bin_ticks
    )
    if fp.deltas.empty:
        raise ValueError("footprint compute produced empty deltas — no time × price cells")

    time_dt = pd.to_datetime(np.asarray(fp.deltas.index, dtype="int64"), unit="ns", utc=True)
    price_levels = list(fp.deltas.columns)
    deltas_np = fp.deltas.to_numpy(dtype="float64")
    finite = deltas_np[~np.isnan(deltas_np)]
    z_abs_max = float(np.max(np.abs(finite))) if finite.size > 0 else 1.0

    heatmap = go.Heatmap(
        x=time_dt,
        y=price_levels,
        z=deltas_np.T,
        text=np.array(_build_text_grid(fp.deltas)).T,
        texttemplate="%{text}",
        colorscale="RdYlGn",
        zmin=-z_abs_max,
        zmid=0,
        zmax=z_abs_max,
        hovertemplate=(
            "Time: %{x}<br>Price: %{y}<br>Net delta: %{z:+,.0f}<extra></extra>"
        ),
        colorbar={"title": "Net delta"},
    )

    fig = go.Figure(data=[heatmap])
    final_title = title or (
        f"Footprint ({len(trades):,} trades, {time_bin_sec}s × {fp.price_bin}pt cells)"
    )
    fig.update_layout(
        title=final_title,
        xaxis_title="Time (UTC)",
        yaxis_title="Price",
        template="plotly_white",
        height=700,
        yaxis={"autorange": "reversed"},
    )
    return fig, fp.price_bin


def render_footprint_html(
    trades: pd.DataFrame,
    contract: ContractSpec,
    output_path: Path,
    *,
    title: str | None = None,
    time_bin_sec: int = 30,
    price_bin_ticks: int = 1,
    tv_screenshot_path: Path | None = None,
    include_plotlyjs: str | bool = "cdn",
) -> Path:
    """Render a footprint heatmap to a self-contained HTML file.

    Args:
        trades: DataFrame with ``event_ts_ns``, ``price``, ``quantity``,
            ``signed_qty`` — loader output.
        contract: ``ContractSpec`` for tick-size-aware price bucketing.
        output_path: Destination ``.html`` path. Parent dir created on demand.
        title: Chart title. Defaults to a generated label.
        time_bin_sec: Time bucket width. Default 30s.
        price_bin_ticks: Price bucket width in ticks. Default 1.
        tv_screenshot_path: Optional path to a TradingView screenshot. If
            given, embedded as base64. If ``None``, a placeholder text panel
            is shown.
        include_plotlyjs: Passed to Plotly's HTML writer. Default ``"cdn"``.

    Returns:
        Resolved ``output_path``.

    Raises:
        ValueError: If ``trades`` is empty.

    Example:
        >>> from rithmic_analytics.core.contracts import MNQ
        >>> from rithmic_analytics.core.loader import load_obs01_trades
        >>> df = load_obs01_trades(Path("l1-trade.jsonl"))
        >>> render_footprint_html(
        ...     df, MNQ, Path("fp.html"),
        ...     title="MNQM6 2026-04-27 RTH",
        ...     tv_screenshot_path=Path("tv.png"),
        ... )
    """
    fig, price_bin = _build_footprint_figure(
        trades,
        contract,
        title=title,
        time_bin_sec=time_bin_sec,
        price_bin_ticks=price_bin_ticks,
    )
    final_title = str(fig.layout.title.text)

    chart_html = fig.to_html(full_html=False, include_plotlyjs=include_plotlyjs)
    tv_panel = _tv_screenshot_panel(tv_screenshot_path)

    full_html = _OUTER_TEMPLATE.format(
        title=final_title,
        chart_html=chart_html,
        tv_panel=tv_panel,
        time_bin_sec=time_bin_sec,
        price_bin=price_bin,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(full_html, encoding="utf-8")
    return output_path
