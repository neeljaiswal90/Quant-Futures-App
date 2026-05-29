"""Deferred operational validation: 5 spot checks against external reference data.

These tests are intentionally **skipped** by default. They require Bookmap
screenshots (or R|Trader replay) timestamped to specific moments in the captured
JSONL. Once Neel captures and annotates those reference points, the tuples
below get filled in and the skip marker removed.

See ``docs/future_work.md`` — "Deferred validation passes" (item #1).
"""

from __future__ import annotations

from typing import NamedTuple

import pytest

from rithmic_analytics.core.loader import load_obs01_trades

from .conftest import REAL_OBS01


class SpotCheck(NamedTuple):
    event_ts_ns: int  # canonical exchange timestamp
    expected_price: float
    expected_signed_qty: int  # signed by aggressor direction
    note: str  # source: Bookmap timestamp / R|Trader replay annotation


SPOT_CHECKS: list[SpotCheck] = [
    # SpotCheck(event_ts_ns=..., expected_price=..., expected_signed_qty=..., note="..."),
    # SpotCheck(event_ts_ns=..., expected_price=..., expected_signed_qty=..., note="..."),
    # SpotCheck(event_ts_ns=..., expected_price=..., expected_signed_qty=..., note="..."),
    # SpotCheck(event_ts_ns=..., expected_price=..., expected_signed_qty=..., note="..."),
    # SpotCheck(event_ts_ns=..., expected_price=..., expected_signed_qty=..., note="..."),
]


@pytest.mark.skip(reason="Deferred: requires Bookmap reference captures. See docs/future_work.md")
@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_obs01_spot_checks_against_external_reference() -> None:
    assert len(SPOT_CHECKS) == 5, "fill in the 5 spot-check tuples before un-skipping"

    df = load_obs01_trades(REAL_OBS01)

    for check in SPOT_CHECKS:
        rows = df[df["event_ts_ns"] == check.event_ts_ns]
        assert len(rows) >= 1, f"no row at {check.event_ts_ns} ({check.note})"
        row = rows.iloc[0]
        assert row["price"] == pytest.approx(check.expected_price), check.note
        assert row["signed_qty"] == check.expected_signed_qty, check.note
