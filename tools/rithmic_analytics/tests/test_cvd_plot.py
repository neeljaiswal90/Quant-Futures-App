"""Tests for ``rithmic_analytics.viewer.cvd_plot``."""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.viewer.cvd_plot import render_cvd_html

from .conftest import REAL_OBS01

_NS_PER_SEC = 1_000_000_000


def _synthetic_trades(n: int = 200, *, base_ts_ns: int = 1_777_301_400_000_000_000) -> pd.DataFrame:
    """Build a small trades DataFrame with the columns render_cvd_html needs."""
    return pd.DataFrame(
        {
            "event_ts_ns": np.array(
                [base_ts_ns + i * _NS_PER_SEC for i in range(n)], dtype="int64"
            ),
            "price": np.array(
                [27380.0 + (i % 5) * 0.25 for i in range(n)], dtype="float64"
            ),
            "quantity": np.array([1] * n, dtype="int32"),
            "signed_qty": np.array(
                [1 if i % 2 == 0 else -1 for i in range(n)], dtype="int32"
            ),
            "session_id": ["s1"] * n,
        }
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_render_cvd_html_produces_file(tmp_path: Path) -> None:
    out = tmp_path / "cvd.html"
    df = _synthetic_trades(n=200)

    result = render_cvd_html(df, out, title="Test chart")

    assert result == out
    assert out.exists()
    assert out.stat().st_size > 0


def test_render_cvd_html_contains_plotly_markers(tmp_path: Path) -> None:
    out = tmp_path / "cvd.html"
    df = _synthetic_trades(n=200)

    render_cvd_html(df, out, title="My CVD Chart")

    content = out.read_text(encoding="utf-8")
    assert "<html" in content.lower()
    assert "plotly" in content.lower()
    assert "My CVD Chart" in content
    # Plotly JSON includes "Candlestick" trace type
    assert "candlestick" in content.lower()


def test_render_cvd_html_default_title_includes_trade_count(tmp_path: Path) -> None:
    out = tmp_path / "cvd.html"
    df = _synthetic_trades(n=347)

    render_cvd_html(df, out)

    content = out.read_text(encoding="utf-8")
    assert "347 trades" in content


def test_render_cvd_html_creates_parent_dir(tmp_path: Path) -> None:
    out = tmp_path / "deep" / "nested" / "cvd.html"
    df = _synthetic_trades(n=200)

    render_cvd_html(df, out)

    assert out.exists()


def test_render_cvd_html_empty_trades_raises(tmp_path: Path) -> None:
    out = tmp_path / "cvd.html"
    empty = pd.DataFrame(
        {
            "event_ts_ns": pd.Series(dtype="int64"),
            "price": pd.Series(dtype="float64"),
            "quantity": pd.Series(dtype="int32"),
            "signed_qty": pd.Series(dtype="int32"),
            "session_id": pd.Series(dtype="string"),
        }
    )

    with pytest.raises(ValueError, match="empty"):
        render_cvd_html(empty, out)


# ---------------------------------------------------------------------------
# Kwarg behavior
# ---------------------------------------------------------------------------


def test_render_cvd_html_bar_size_kwarg_changes_output(tmp_path: Path) -> None:
    df = _synthetic_trades(n=300)
    out_60 = tmp_path / "60s.html"
    out_300 = tmp_path / "300s.html"

    render_cvd_html(df, out_60, bar_size_sec=60)
    render_cvd_html(df, out_300, bar_size_sec=300)

    # Different bar sizes → different content (different number of candlesticks)
    assert out_60.read_text(encoding="utf-8") != out_300.read_text(encoding="utf-8")


def test_render_cvd_html_show_divergence_false_omits_markers(tmp_path: Path) -> None:
    df = _synthetic_trades(n=200)
    out_with = tmp_path / "with.html"
    out_without = tmp_path / "without.html"

    render_cvd_html(df, out_with, show_divergence=True)
    render_cvd_html(df, out_without, show_divergence=False)

    # show_divergence=False omits the Divergences trace name
    assert "Divergences" not in out_without.read_text(encoding="utf-8")


def test_render_cvd_html_uses_cdn_by_default(tmp_path: Path) -> None:
    out = tmp_path / "cvd.html"
    df = _synthetic_trades(n=200)

    render_cvd_html(df, out)

    content = out.read_text(encoding="utf-8")
    # CDN mode loads Plotly via <script src="...cdn.plot.ly..."> or similar
    assert "plot.ly" in content or "plotly.com" in content


def test_render_cvd_html_inline_plotly_produces_larger_file(tmp_path: Path) -> None:
    df = _synthetic_trades(n=200)
    out_cdn = tmp_path / "cdn.html"
    out_inline = tmp_path / "inline.html"

    render_cvd_html(df, out_cdn, include_plotlyjs="cdn")
    render_cvd_html(df, out_inline, include_plotlyjs=True)

    # Inline embeds the ~3 MB Plotly bundle; CDN is ~5 KB
    assert out_inline.stat().st_size > out_cdn.stat().st_size * 10


# ---------------------------------------------------------------------------
# Real-fixture performance
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_render_cvd_html_real_fixture_perf(tmp_path: Path) -> None:
    trades = load_obs01_trades(REAL_OBS01)
    out = tmp_path / "real_cvd.html"

    t0 = time.perf_counter()
    render_cvd_html(trades, out, title="MNQM6 2026-04-27 RTH (real fixture)")
    elapsed = time.perf_counter() - t0

    assert elapsed < 10.0, f"render took {elapsed:.2f}s, budget is 10s"
    assert out.exists()
    # Sanity: file size is non-trivial (real Plotly JSON for 100K points)
    assert out.stat().st_size > 100_000


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_render_cvd_html_real_fixture_html_parseable(tmp_path: Path) -> None:
    """Confirm the output parses as HTML via the stdlib parser."""
    import html.parser

    trades = load_obs01_trades(REAL_OBS01)
    out = tmp_path / "real_cvd.html"
    render_cvd_html(trades, out)

    class _DivCounter(html.parser.HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.div_count = 0
            self.script_count = 0

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            if tag == "div":
                self.div_count += 1
            elif tag == "script":
                self.script_count += 1

    parser = _DivCounter()
    parser.feed(out.read_text(encoding="utf-8"))
    parser.close()

    # Plotly output has at least one <div> (the chart container) and at least
    # one <script> (the chart-rendering JS)
    assert parser.div_count >= 1
    assert parser.script_count >= 1
