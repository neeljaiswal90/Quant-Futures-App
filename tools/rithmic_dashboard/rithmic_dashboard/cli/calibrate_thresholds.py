"""Calibrate delta-dislocation CVD thresholds from prior OBS sessions."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from rithmic_dashboard.features.threshold_calibration import (
    DEFAULT_LOOKBACK_SESSIONS,
    DEFAULT_SYMBOL,
    DEFAULT_THRESHOLD_MULTIPLIER,
    InsufficientCalibrationData,
    calibrate_dislocation_threshold,
    write_thresholds_atomic,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ANALYTICS_ROOT = PROJECT_ROOT.parent / "rithmic_analytics"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "live_analysis" / "dislocation_thresholds.json"


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""

    args = parse_args(argv)
    try:
        calibration = calibrate_dislocation_threshold(
            args.analytics_root / "data" / "captures",
            symbol=args.symbol,
            lookback_sessions=args.lookback_sessions,
            threshold_multiplier=args.threshold_multiplier,
        )
    except InsufficientCalibrationData as exc:
        print(f"insufficient calibration data: {exc}", file=sys.stderr)
        return 2
    write_thresholds_atomic(args.output_path, calibration)
    print(
        "calibrated "
        f"symbol={calibration.symbol} threshold={calibration.threshold:.2f} "
        f"median_hourly_abs_cvd={calibration.median_hourly_abs_cvd:.2f} "
        f"sessions={calibration.sessions_used} output={args.output_path}"
    )
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analytics-root", type=Path, default=DEFAULT_ANALYTICS_ROOT)
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL)
    parser.add_argument("--lookback-sessions", type=int, default=DEFAULT_LOOKBACK_SESSIONS)
    parser.add_argument(
        "--threshold-multiplier",
        type=float,
        default=DEFAULT_THRESHOLD_MULTIPLIER,
    )
    parser.add_argument("--output-path", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(main())
