"""CVD + price candlestick HTML viewer.

Single-file Plotly chart with:
    - Candlestick price track (primary y-axis), OHLC resampled from trades on
      a configurable bar size (default 60s).
    - CVD line (secondary y-axis) rendered via WebGL ``Scattergl`` so the
      100K-point real-fixture case stays responsive.
    - Divergence markers from :func:`detect_divergence` plotted as triangles
      on the price track, with hover showing divergence magnitude.

Time axis is derived from the input ``event_ts_ns`` range; no operator-facing
filter controls (callers filter by passing different input).

Output is a self-contained HTML file. Plotly JS is loaded via CDN by default
(~5 KB file, requires internet on first render). Pass ``include_plotlyjs=True``
to inline the ~3 MB bundle for fully-offline viewing.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from rithmic_analytics.features.cvd import compute_cvd, detect_divergence

_NS_PER_SECOND: int = 10**9


def _build_cvd_figure(
    trades: pd.DataFrame,
    *,
    title: str | None = None,
    bar_size_sec: int = 60,
    show_divergence: bool = True,
    divergence_window: int = 500,
    min_divergence: float = 0.5,
) -> go.Figure:
    """Build the CVD + price Plotly figure (no HTML write).

    Factored out of :func:`render_cvd_html` so callers (notably the daily
    report in :mod:`rithmic_analytics.viewer.vp_report`) can embed the figure
    fragment without writing a standalone HTML file.

    Raises:
        ValueError: If ``trades`` is empty.
    """
    if len(trades) == 0:
        raise ValueError("cannot render CVD chart from empty trades DataFrame")

    trades_with_cvd = compute_cvd(trades)

    # ---- OHLC candlestick ----
    bar_ns = bar_size_sec * _NS_PER_SECOND
    bar_keys = (trades["event_ts_ns"].to_numpy(dtype="int64") // bar_ns) * bar_ns
    ohlc_df = pd.DataFrame(
        {
            "bar_ns": bar_keys,
            "price": trades["price"].to_numpy(dtype="float64"),
        }
    )
    ohlc = ohlc_df.groupby("bar_ns", sort=True)["price"].agg(["first", "max", "min", "last"])
    ohlc.columns = ["open", "high", "low", "close"]
    ohlc_dt = pd.to_datetime(np.asarray(ohlc.index, dtype="int64"), unit="ns", utc=True)

    # ---- Figure ----
    fig = make_subplots(specs=[[{"secondary_y": True}]])

    fig.add_trace(
        go.Candlestick(
            x=ohlc_dt,
            open=ohlc["open"],
            high=ohlc["high"],
            low=ohlc["low"],
            close=ohlc["close"],
            name="Price",
            showlegend=True,
        ),
        secondary_y=False,
    )

    # CVD: WebGL for 100K-point responsiveness
    cvd_dt = pd.to_datetime(
        trades_with_cvd["event_ts_ns"].to_numpy(dtype="int64"), unit="ns", utc=True
    )
    fig.add_trace(
        go.Scattergl(
            x=cvd_dt,
            y=trades_with_cvd["cvd_rth"],
            name="CVD (RTH)",
            mode="lines",
            line={"color": "#1f77b4", "width": 1.5},
            hovertemplate="CVD: %{y:,}<extra></extra>",
        ),
        secondary_y=True,
    )

    # Divergence markers
    if show_divergence:
        divs = detect_divergence(
            trades_with_cvd,
            price_window=divergence_window,
            cvd_window=divergence_window,
            min_divergence=min_divergence,
        )
        if len(divs) > 0:
            div_dt = pd.to_datetime(
                divs["event_ts_ns"].to_numpy(dtype="int64"), unit="ns", utc=True
            )
            fig.add_trace(
                go.Scatter(
                    x=div_dt,
                    y=divs["price"],
                    mode="markers",
                    marker={"symbol": "triangle-down", "size": 12, "color": "orange"},
                    text=[f"div {d:.2f}" for d in divs["divergence"]],
                    name=f"Divergences (≥{min_divergence})",
                    hovertemplate=(
                        "%{x}<br>Price: %{y:.2f}<br>Divergence: %{text}<extra></extra>"
                    ),
                ),
                secondary_y=False,
            )

    # ---- Layout ----
    final_title = title or f"CVD + Price ({len(trades):,} trades, {bar_size_sec}s bars)"
    fig.update_layout(
        title=final_title,
        xaxis_title="Time (UTC)",
        xaxis_rangeslider_visible=False,
        hovermode="x unified",
        template="plotly_white",
        height=600,
    )
    fig.update_yaxes(title_text="Price", secondary_y=False)
    fig.update_yaxes(title_text="CVD (signed contracts)", secondary_y=True)

    return fig


def render_cvd_html(
    trades: pd.DataFrame,
    output_path: Path,
    *,
    title: str | None = None,
    bar_size_sec: int = 60,
    show_divergence: bool = True,
    divergence_window: int = 500,
    min_divergence: float = 0.5,
    include_plotlyjs: str | bool = "cdn",
) -> Path:
    """Render a CVD + price candlestick HTML page.

    Args:
        trades: DataFrame with ``event_ts_ns`` (int64), ``price`` (float64),
            ``signed_qty`` (int) — the output of ``load_obs01_trades``.
        output_path: Destination ``.html`` file path. Parent dir created on demand.
        title: Optional chart title. Defaults to a generated label including
            trade count.
        bar_size_sec: Time-bucket width for OHLC candlestick. Default 60.
        show_divergence: When ``True``, computes divergence events via
            :func:`detect_divergence` and plots them as triangle markers.
        divergence_window: Rolling-window size for the rank computation.
            Default 500.
        min_divergence: Threshold for flagging divergences. Default 0.5.
        include_plotlyjs: Passed through to ``plotly.io.write_html``.
            ``"cdn"`` (default) keeps the file small. ``True`` inlines for
            offline viewing. ``False`` writes no Plotly script (rarely useful).

    Returns:
        Resolved ``output_path``.

    Raises:
        ValueError: If ``trades`` is empty.

    Example:
        >>> from rithmic_analytics.core.loader import load_obs01_trades
        >>> df = load_obs01_trades(Path("l1-trade.jsonl"))
        >>> render_cvd_html(df, Path("cvd.html"), title="MNQM6 2026-04-27 RTH")
    """
    fig = _build_cvd_figure(
        trades,
        title=title,
        bar_size_sec=bar_size_sec,
        show_divergence=show_divergence,
        divergence_window=divergence_window,
        min_divergence=min_divergence,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.write_html(output_path, include_plotlyjs=include_plotlyjs, full_html=True)
    return output_path
