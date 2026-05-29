"""Calibrate trade-size thresholds from recent OBS sessions."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from rithmic_dashboard.features.trade_size_calibration import (
    DEFAULT_LOOKBACK_SESSIONS,
    DEFAULT_SYMBOL,
    InsufficientTradeSizeCalibrationData,
    calibrate_trade_size_thresholds,
    write_trade_size_thresholds_atomic,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ANALYTICS_ROOT = PROJECT_ROOT.parent / "rithmic_analytics"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "live_analysis" / "trade_size_thresholds.json"


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""

    args = parse_args(argv)
    try:
        calibration = calibrate_trade_size_thresholds(
            args.analytics_root / "data" / "captures",
            symbol=args.symbol,
            lookback_sessions=args.lookback_sessions,
        )
    except InsufficientTradeSizeCalibrationData as exc:
        print(f"insufficient trade-size calibration data: {exc}", file=sys.stderr)
        return 2
    write_trade_size_thresholds_atomic(args.output_path, calibration)
    print(
        "calibrated trade sizes "
        f"symbol={calibration.symbol} "
        f"mixed_min={calibration.thresholds.mixed_min} "
        f"institutional_min={calibration.thresholds.institutional_min} "
        f"block_min={calibration.thresholds.block_min} "
        f"sessions={calibration.sessions_used} "
        f"trades={calibration.trade_count} "
        f"output={args.output_path}"
    )
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analytics-root", type=Path, default=DEFAULT_ANALYTICS_ROOT)
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL)
    parser.add_argument("--lookback-sessions", type=int, default=DEFAULT_LOOKBACK_SESSIONS)
    parser.add_argument("--output-path", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(main())
