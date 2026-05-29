from __future__ import annotations

import json
from pathlib import Path

from rithmic_dashboard.features.trade_size_classifier import (
    TradeSizeThresholds,
    classify_trade_size,
    load_trade_size_thresholds,
)


def test_default_trade_size_boundaries() -> None:
    assert classify_trade_size(1) == "retail"
    assert classify_trade_size(9) == "retail"
    assert classify_trade_size(10) == "mixed"
    assert classify_trade_size(49) == "mixed"
    assert classify_trade_size(50) == "institutional"
    assert classify_trade_size(99) == "institutional"
    assert classify_trade_size(100) == "block"


def test_custom_thresholds_load_from_calibration_payload(tmp_path: Path) -> None:
    path = tmp_path / "trade_size_thresholds.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "thresholds": {
                    "MNQ": {"mixed_min": 4, "institutional_min": 12, "block_min": 33}
                },
            }
        ),
        encoding="utf-8",
    )

    thresholds = load_trade_size_thresholds(path, symbol="MNQ")

    assert thresholds == TradeSizeThresholds("MNQ", 4, 12, 33, str(path))
    assert classify_trade_size(33, thresholds) == "block"
