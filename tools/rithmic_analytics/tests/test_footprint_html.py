"""Tests for ``rithmic_analytics.viewer.footprint_html``."""

from __future__ import annotations

import base64
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.viewer.footprint_html import render_footprint_html

from .conftest import REAL_OBS01

_NS_PER_SEC = 1_000_000_000


def _synthetic_trades(n: int = 200, *, base_ts_ns: int = 1_777_301_400_000_000_000) -> pd.DataFrame:
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
        }
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_render_footprint_html_produces_file(tmp_path: Path) -> None:
    out = tmp_path / "fp.html"
    df = _synthetic_trades(n=200)

    result = render_footprint_html(df, MNQ, out, title="Test Footprint")

    assert result == out
    assert out.exists()
    assert out.stat().st_size > 0


def test_render_footprint_html_contains_plotly_and_heatmap(tmp_path: Path) -> None:
    out = tmp_path / "fp.html"
    df = _synthetic_trades(n=200)

    render_footprint_html(df, MNQ, out, title="My Footprint")

    content = out.read_text(encoding="utf-8")
    assert "<html" in content.lower()
    assert "plotly" in content.lower()
    assert "My Footprint" in content
    # go.Heatmap trace marker
    assert "heatmap" in content.lower()


def test_render_footprint_html_default_title_includes_trade_count(tmp_path: Path) -> None:
    out = tmp_path / "fp.html"
    df = _synthetic_trades(n=240)

    render_footprint_html(df, MNQ, out)

    content = out.read_text(encoding="utf-8")
    assert "240 trades" in content


def test_render_footprint_html_creates_parent_dir(tmp_path: Path) -> None:
    out = tmp_path / "deep" / "nested" / "fp.html"
    df = _synthetic_trades(n=200)

    render_footprint_html(df, MNQ, out)

    assert out.exists()


def test_render_footprint_html_empty_trades_raises(tmp_path: Path) -> None:
    out = tmp_path / "fp.html"
    empty = pd.DataFrame(
        {
            "event_ts_ns": pd.Series(dtype="int64"),
            "price": pd.Series(dtype="float64"),
            "quantity": pd.Series(dtype="int32"),
            "signed_qty": pd.Series(dtype="int32"),
        }
    )

    with pytest.raises(ValueError, match="empty"):
        render_footprint_html(empty, MNQ, out)


# ---------------------------------------------------------------------------
# Cell labels + color scale
# ---------------------------------------------------------------------------


def test_cell_labels_use_signed_net_format(tmp_path: Path) -> None:
    # All trades in a single bin: 50 buys at one price in a 5-second window.
    # 30-second default bin → all 50 land in bin 0 → expected cell label "+50".
    df = pd.DataFrame(
        {
            "event_ts_ns": np.array(
                # 0, 100ms, 200ms, ..., 4.9s — all inside the first 30s bin
                [int(i * 1e8) for i in range(50)], dtype="int64"
            ),
            "price": np.array([27380.0] * 50, dtype="float64"),
            "quantity": np.array([1] * 50, dtype="int32"),
            "signed_qty": np.array([1] * 50, dtype="int32"),
        }
    )
    out = tmp_path / "fp.html"

    render_footprint_html(df, MNQ, out)

    content = out.read_text(encoding="utf-8")
    # +50 should appear in the cell text array (Plotly serializes as part of the trace JSON)
    assert "+50" in content


def test_color_scale_is_diverging_rdylgn(tmp_path: Path) -> None:
    out = tmp_path / "fp.html"
    df = _synthetic_trades(n=200)

    render_footprint_html(df, MNQ, out)

    content = out.read_text(encoding="utf-8")
    assert "RdYlGn" in content
    assert '"zmid":0' in content or "'zmid':0" in content


# ---------------------------------------------------------------------------
# TV screenshot panel
# ---------------------------------------------------------------------------


def test_tv_screenshot_path_none_shows_placeholder(tmp_path: Path) -> None:
    out = tmp_path / "fp.html"
    df = _synthetic_trades(n=200)

    render_footprint_html(df, MNQ, out, tv_screenshot_path=None)

    content = out.read_text(encoding="utf-8")
    assert "TradingView cross-check" in content
    assert "--tv-screenshot" in content


def test_tv_screenshot_path_embeds_image_as_base64(tmp_path: Path) -> None:
    # Tiny 1x1 PNG (red pixel) — valid PNG bytes the renderer can base64-encode.
    png_bytes = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108020000"
        "00907753de0000000c4944415478da6364f8cf00000003000178d1cd8e"
        "0000000049454e44ae426082"
    )
    screenshot = tmp_path / "tv.png"
    screenshot.write_bytes(png_bytes)
    out = tmp_path / "fp.html"
    df = _synthetic_trades(n=200)

    render_footprint_html(df, MNQ, out, tv_screenshot_path=screenshot)

    content = out.read_text(encoding="utf-8")
    expected_encoded = base64.b64encode(png_bytes).decode("ascii")
    assert "TradingView reference" in content
    assert f"data:image/png;base64,{expected_encoded}" in content
    # The placeholder should NOT be present when the screenshot is embedded
    assert "TradingView cross-check" not in content


# ---------------------------------------------------------------------------
# Kwarg behavior
# ---------------------------------------------------------------------------


def test_time_bin_kwarg_changes_output(tmp_path: Path) -> None:
    df = _synthetic_trades(n=300)
    out_30 = tmp_path / "30s.html"
    out_300 = tmp_path / "300s.html"

    render_footprint_html(df, MNQ, out_30, time_bin_sec=30)
    render_footprint_html(df, MNQ, out_300, time_bin_sec=300)

    # Different time bins → different number of cells → different content
    assert out_30.read_text(encoding="utf-8") != out_300.read_text(encoding="utf-8")


def test_price_bin_ticks_kwarg_changes_output(tmp_path: Path) -> None:
    df = _synthetic_trades(n=300)
    out_1 = tmp_path / "1tick.html"
    out_4 = tmp_path / "4tick.html"

    render_footprint_html(df, MNQ, out_1, price_bin_ticks=1)
    render_footprint_html(df, MNQ, out_4, price_bin_ticks=4)

    assert out_1.read_text(encoding="utf-8") != out_4.read_text(encoding="utf-8")


def test_inline_plotly_produces_larger_file(tmp_path: Path) -> None:
    df = _synthetic_trades(n=200)
    out_cdn = tmp_path / "cdn.html"
    out_inline = tmp_path / "inline.html"

    render_footprint_html(df, MNQ, out_cdn, include_plotlyjs="cdn")
    render_footprint_html(df, MNQ, out_inline, include_plotlyjs=True)

    # Inline embeds ~3 MB; CDN includes a small script tag (~5 KB output)
    assert out_inline.stat().st_size > out_cdn.stat().st_size * 10


# ---------------------------------------------------------------------------
# Real-fixture performance
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_render_footprint_html_real_fixture_perf(tmp_path: Path) -> None:
    trades = load_obs01_trades(REAL_OBS01)
    out = tmp_path / "real_fp.html"

    t0 = time.perf_counter()
    render_footprint_html(trades, MNQ, out, title="MNQM6 2026-04-27 RTH")
    elapsed = time.perf_counter() - t0

    assert elapsed < 10.0, f"render took {elapsed:.2f}s, budget is 10s"
    assert out.exists()
    assert out.stat().st_size > 50_000


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_render_footprint_html_real_fixture_parseable(tmp_path: Path) -> None:
    import html.parser

    trades = load_obs01_trades(REAL_OBS01)
    out = tmp_path / "real_fp.html"
    render_footprint_html(trades, MNQ, out)

    parser = html.parser.HTMLParser()
    parser.feed(out.read_text(encoding="utf-8"))
    parser.close()
    # No exception → HTML is well-formed enough for the stdlib parser
