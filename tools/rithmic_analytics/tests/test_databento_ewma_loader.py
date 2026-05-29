from __future__ import annotations

import math
from pathlib import Path

import pytest

from rithmic_analytics.data_loader.databento_loader import (
    CorpusSession,
    discover_corpus_sessions,
    parkinson_sigma_points,
)


def test_parkinson_sigma_points_uses_log_formula_and_vwap_conversion() -> None:
    highs = [101.0, 102.0, 103.0]
    lows = [99.0, 100.0, 101.0]
    vwap = 100.5

    expected_log_sq = (
        sum(math.log(high / low) ** 2 for high, low in zip(highs, lows, strict=False)) / 3
    )
    expected = math.sqrt(expected_log_sq / (4 * math.log(2))) * vwap

    assert parkinson_sigma_points(highs, lows, vwap) == pytest.approx(expected)


def test_discover_corpus_sessions_dedupes_by_date_and_session(tmp_path: Path) -> None:
    root_a = tmp_path / "cache"
    root_b = tmp_path / "sim03_corpus"
    session_a = root_a / "2026-03-16-rth"
    session_b = root_b / "2026-03-16-rth"
    for session in (session_a, session_b):
        session.mkdir(parents=True)
        (session / "trades.dbn.zst").write_bytes(b"fake")

    discovery = discover_corpus_sessions((root_a, root_b))

    assert len(discovery.sessions) == 1
    assert discovery.sessions[0] == CorpusSession(
        "2026-03-16",
        "rth",
        session_b,
        session_b / "trades.dbn.zst",
    )
    assert discovery.rejected_count == 1
    assert "duplicate_session=1" in discovery.summary_line
