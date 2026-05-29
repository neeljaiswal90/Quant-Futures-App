from __future__ import annotations

from pathlib import Path

import pandas as pd

from rithmic_analytics.cli.calibrate_ewma import calibrate_from_stats
from rithmic_analytics.data_loader.databento_loader import CorpusDiscovery, CorpusSession


def test_calibrate_from_stats_uses_temporal_split_and_records_provenance(tmp_path: Path) -> None:
    sessions = tuple(
        CorpusSession(
            f"2026-03-{day:02d}",
            "rth",
            tmp_path / f"2026-03-{day:02d}-rth",
            tmp_path / f"2026-03-{day:02d}-rth" / "trades.dbn.zst",
        )
        for day in range(1, 41)
    )
    stats = pd.DataFrame(
        {
            "trading_date": [session.trading_date for session in sessions],
            "session": ["rth"] * len(sessions),
            "sigma_pts": [20.0 + (idx % 5) * 1.5 for idx in range(len(sessions))],
        }
    )
    discovery = CorpusDiscovery(sessions=sessions, total_directories=42)

    calibration = calibrate_from_stats(
        stats,
        discovery=discovery,
        symbol="MNQ",
        stats_path=tmp_path / "stats.parquet",
        min_sessions=30,
    )

    assert 0.85 <= calibration.lambda_value <= 0.99
    assert calibration.train_sessions == 32
    assert calibration.validation_sessions == 8
    assert str(calibration.corpus_provenance["summary_line"]).startswith("corpus_loaded: 40")
