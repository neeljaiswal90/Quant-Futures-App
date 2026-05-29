"""Tests for ``rithmic_analytics.viewer.vp_report``."""

from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.features.absorption import AbsorptionEvent
from rithmic_analytics.features.multi_session import MultiSessionHVN, MultiSessionVP
from rithmic_analytics.viewer.vp_report import (
    default_report_path,
    render_daily_report,
)

from .conftest import REAL_OBS01

_NS_PER_SEC = 1_000_000_000


def _synthetic_trades(n: int = 200, *, base_ts_ns: int = 1_777_301_400_000_000_000) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "event_ts_ns": np.array(
                [base_ts_ns + i * _NS_PER_SEC for i in range(n)], dtype="int64"
            ),
            "price": np.array([27380.0 + (i % 5) * 0.25 for i in range(n)], dtype="float64"),
            "quantity": np.array([1] * n, dtype="int32"),
            "signed_qty": np.array([1 if i % 2 == 0 else -1 for i in range(n)], dtype="int32"),
            "session_id": ["mnq-2026-05-17-rth"] * n,
        }
    )


# ---------------------------------------------------------------------------
# Happy path: file generates with expected sections
# ---------------------------------------------------------------------------


def test_render_daily_report_produces_file(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)

    result = render_daily_report(
        trades=df,
        contract=MNQ,
        output_path=out,
        trading_date=date(2026, 5, 17),
        include_plotlyjs="cdn",  # smaller for tests
    )

    assert result == out
    assert out.exists()
    assert out.stat().st_size > 0


def test_report_contains_all_section_headers(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    # Required sections (multi-session omitted since not passed)
    assert "<h2>Zones</h2>" in content
    assert "<h2>CVD + Price</h2>" in content
    assert "<h2>Footprint</h2>" in content
    assert "<h2>Absorption events</h2>" in content
    assert "<h2>Gap warnings</h2>" in content
    # Multi-session section NOT present when multi_session=None
    assert "<h2>Multi-session HVN status</h2>" not in content


# ---------------------------------------------------------------------------
# Title default
# ---------------------------------------------------------------------------


def test_title_default_format(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        symbol="MNQ", title=None,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "MNQ Daily Report — 2026-05-17" in content


def test_title_override(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        title="Custom Test Title",
        include_plotlyjs="cdn",
    )

    assert "Custom Test Title" in out.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Empty input
# ---------------------------------------------------------------------------


def test_empty_trades_raises(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
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
        render_daily_report(
            trades=empty, contract=MNQ, output_path=out,
            trading_date=date(2026, 5, 17),
        )


# ---------------------------------------------------------------------------
# Absorption events section
# ---------------------------------------------------------------------------


def test_absorption_events_none_renders_empty_state(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        absorption_events=None,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "No absorption events for this session" in content


def test_absorption_events_present_in_table(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)
    events = [
        AbsorptionEvent(
            start_ts_ns=1_777_301_450_000_000_000,
            end_ts_ns=1_777_301_455_000_000_000,
            side="buy_absorbed",
            price_center=27380.375,
            dominant_price=27380.25,
            volume=500,
            net_delta=500,
            range_ticks=1,
            score=0.94,
            confirmed=True,
            mbp1_stale=False,
            factors={"volume": 1.0, "range": 0.75, "onesidedness": 1.0, "displacement": 1.0},
        )
    ]

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        absorption_events=events,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "buy_absorbed" in content
    assert "0.940" in content  # score formatted to 3 dp
    assert "27,380.25" in content  # dominant price


# ---------------------------------------------------------------------------
# Multi-session section omitted vs empty-state
# ---------------------------------------------------------------------------


def test_multi_session_none_omits_section(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        multi_session=None,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "<h2>Multi-session HVN status</h2>" not in content


def test_multi_session_empty_renders_placeholder(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)
    empty_multi = MultiSessionVP(
        sessions_used=["mnq-2026-05-15-rth", "mnq-2026-05-16-rth"],
        rolling_window=2,
        hvns=[],
    )

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        multi_session=empty_multi,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "<h2>Multi-session HVN status</h2>" in content
    assert "0 structural clusters identified across 2 session(s)" in content


def test_multi_session_populated_renders_table(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)
    multi = MultiSessionVP(
        sessions_used=["s1", "s2", "s3"],
        rolling_window=3,
        hvns=[
            MultiSessionHVN(
                price_low=27380.0,
                price_high=27385.0,
                center=27382.5,
                member_sessions=["s1", "s2", "s3"],
                multi_session_count=3,
                conviction="STRUCTURAL",
                total_volume=330,
            )
        ],
    )

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        multi_session=multi,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "STRUCTURAL" in content
    assert "27,380.00" in content


# ---------------------------------------------------------------------------
# Gap warnings: empty states + populated table + header callout
# ---------------------------------------------------------------------------


def test_gap_warnings_no_alerts_file_configured(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)
    nonexistent = tmp_path / "missing-alerts.ndjson"

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        alerts_path=nonexistent,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "No alerts file configured" in content
    # No callout div when no gaps — the CSS class itself is always declared
    # in the <style> block, so check for the actual element opening.
    assert '<div class="header-alert">' not in content


def test_gap_warnings_empty_file_renders_no_gaps_detected(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)
    empty_alerts = tmp_path / "alerts.ndjson"
    empty_alerts.write_text("", encoding="utf-8")

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        alerts_path=empty_alerts,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "No gaps detected" in content
    assert '<div class="header-alert">' not in content


def test_gap_warnings_non_matching_date_no_gaps_detected(tmp_path: Path) -> None:
    """Alerts file has entries — but for a different trading date."""
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)
    alerts = tmp_path / "alerts.ndjson"
    # Alert for 5/15, but report is for 5/17
    alerts.write_text(
        json.dumps({
            "ts_iso": "2026-05-15T15:00:00+00:00",
            "session_id": "mnq-2026-05-15-rth",
            "stream": "LAST_TRADE", "gap_type": "time",
            "gap_value_ns": 70_000_000_000, "threshold_ns": 60_000_000_000,
            "severity": "WARN",
        }) + "\n",
        encoding="utf-8",
    )

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        alerts_path=alerts,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "No gaps detected" in content


def test_gap_warnings_matching_entries_appear_in_table_and_header_callout(
    tmp_path: Path,
) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)
    alerts = tmp_path / "alerts.ndjson"
    alerts.write_text(
        json.dumps({
            "ts_iso": "2026-05-17T15:00:00+00:00",
            "session_id": "mnq-2026-05-17-rth",
            "stream": "LAST_TRADE", "gap_type": "time",
            "gap_value_ns": 70_000_000_000, "threshold_ns": 60_000_000_000,
            "severity": "WARN",
        }) + "\n"
        + json.dumps({
            "ts_iso": "2026-05-17T15:05:00+00:00",
            "session_id": "mnq-2026-05-17-rth",
            "stream": "HEARTBEAT", "gap_type": "missing_capture",
            "gap_value_ns": None, "threshold_ns": None,
            "severity": "FAIL",
        }) + "\n",
        encoding="utf-8",
    )

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        alerts_path=alerts,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    # Both alerts present in the table
    assert "LAST_TRADE" in content
    assert "HEARTBEAT" in content
    # Header callout with anchor link to the section (check actual element,
    # not the class name which is always present in the <style> block).
    assert '<div class="header-alert">' in content
    assert "2 gap alerts detected" in content
    assert 'href="#gap-warnings"' in content
    # Gap section has the anchor id for the link to land on
    assert "id='gap-warnings'" in content or 'id="gap-warnings"' in content


def test_gap_warning_singular_when_one_alert(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)
    alerts = tmp_path / "alerts.ndjson"
    alerts.write_text(
        json.dumps({
            "ts_iso": "2026-05-17T15:00:00+00:00",
            "session_id": "mnq-2026-05-17-rth",
            "stream": "LAST_TRADE", "gap_type": "time",
            "gap_value_ns": 70_000_000_000, "threshold_ns": 60_000_000_000,
            "severity": "WARN",
        }) + "\n",
        encoding="utf-8",
    )

    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        alerts_path=alerts,
        include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "1 gap alert detected" in content  # singular form, no trailing 's'


# ---------------------------------------------------------------------------
# default_report_path helper
# ---------------------------------------------------------------------------


def test_default_report_path_format(tmp_path: Path) -> None:
    p = default_report_path(date(2026, 5, 17), "MNQ", reports_root=tmp_path)
    assert p == tmp_path / "daily_report_2026-05-17_MNQ.html"


# ---------------------------------------------------------------------------
# Plotly inlining
# ---------------------------------------------------------------------------


def test_inline_plotly_default_produces_self_contained_file(tmp_path: Path) -> None:
    out = tmp_path / "report.html"
    df = _synthetic_trades(n=200)

    # include_plotlyjs=True is the documented default for the daily report
    render_daily_report(
        trades=df, contract=MNQ, output_path=out,
        trading_date=date(2026, 5, 17),
        # don't pass include_plotlyjs — verify the default
    )

    size = out.stat().st_size
    # Inlined Plotly bundle is ~3 MB; file size should comfortably exceed 1 MB.
    assert size > 1_000_000, f"expected inlined Plotly (~3 MB), got {size:,} bytes"


# ---------------------------------------------------------------------------
# Real-fixture performance
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real OBS-01 fixture not present")
def test_real_fixture_render_perf(tmp_path: Path) -> None:
    trades = load_obs01_trades(REAL_OBS01)
    out = tmp_path / "real_report.html"

    t0 = time.perf_counter()
    render_daily_report(
        trades=trades,
        contract=MNQ,
        output_path=out,
        trading_date=date(2026, 4, 27),
        include_plotlyjs="cdn",  # smaller, faster — separate test verifies inline
    )
    elapsed = time.perf_counter() - t0

    assert elapsed < 30.0, f"render took {elapsed:.2f}s, budget is 30s"
    assert out.exists()
