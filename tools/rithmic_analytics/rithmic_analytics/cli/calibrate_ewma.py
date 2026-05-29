"""Calibrate EWMA volatility decay from the Databento session corpus."""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd

from rithmic_analytics.data_loader.databento_loader import (
    DEFAULT_CORPUS_ROOTS,
    CorpusDiscovery,
    load_or_build_session_stats,
)


@dataclass(frozen=True)
class EwmaCalibration:
    """Chosen EWMA calibration plus walk-forward diagnostics."""

    symbol: str
    lambda_value: float
    corpus_median_sigma_pts: float
    train_rmse: float
    validation_rmse: float
    validation_rmse_ratio: float
    sessions_used: int
    train_sessions: int
    validation_sessions: int
    generated_at_utc: str
    stats_path: str
    corpus_provenance: dict[str, object]


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""

    args = parse_args(argv)
    roots = (
        tuple(Path(root) for root in args.corpus_root)
        if args.corpus_root
        else DEFAULT_CORPUS_ROOTS
    )
    stats_path = args.output_dir / "per_session_stats.parquet"
    stats, discovery = load_or_build_session_stats(
        roots=roots,
        output_path=stats_path,
        force=args.force_rebuild_stats,
        chunk_size=args.chunk_size,
    )
    print(discovery.summary_line)
    calibration = calibrate_from_stats(
        stats,
        discovery=discovery,
        symbol=args.symbol,
        stats_path=stats_path,
        roots=roots,
        lambda_min=args.lambda_min,
        lambda_max=args.lambda_max,
        lambda_step=args.lambda_step,
        min_sessions=args.min_sessions,
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    output_path = args.output_dir / "ewma_decay.json"
    output_path.write_text(
        json.dumps(asdict(calibration), indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(
        "ewma_calibrated: "
        f"lambda={calibration.lambda_value:.3f}, "
        f"median_sigma_pts={calibration.corpus_median_sigma_pts:.2f}, "
        f"train_rmse={calibration.train_rmse:.2f}, "
        f"validation_rmse={calibration.validation_rmse:.2f}"
    )
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbol", default="MNQ")
    parser.add_argument("--corpus-root", action="append", default=[])
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data") / "calibration_corpus",
    )
    parser.add_argument("--lambda-min", type=float, default=0.85)
    parser.add_argument("--lambda-max", type=float, default=0.99)
    parser.add_argument("--lambda-step", type=float, default=0.01)
    parser.add_argument("--min-sessions", type=int, default=30)
    parser.add_argument("--chunk-size", type=int, default=250_000)
    parser.add_argument("--force-rebuild-stats", action="store_true")
    return parser.parse_args(argv)


def calibrate_from_stats(
    stats: pd.DataFrame,
    *,
    discovery: CorpusDiscovery,
    symbol: str,
    stats_path: Path,
    roots: tuple[Path, ...] | None = None,
    lambda_min: float = 0.85,
    lambda_max: float = 0.99,
    lambda_step: float = 0.01,
    min_sessions: int = 30,
) -> EwmaCalibration:
    """Pick lambda by temporal walk-forward validation over per-session sigma observations."""

    clean = (
        stats[["trading_date", "session", "sigma_pts"]]
        .dropna()
        .query("sigma_pts > 0")
        .sort_values(["trading_date", "session"])
        .reset_index(drop=True)
    )
    observations = [float(value) for value in clean["sigma_pts"].tolist()]
    if len(observations) < min_sessions:
        raise SystemExit(
            f"Need at least {min_sessions} verified sessions for calibration; "
            f"got {len(observations)}."
        )
    split = max(1, int(len(observations) * 0.8))
    split = min(split, len(observations) - 1)
    train = observations[:split]
    validation = observations[split:]
    median_sigma = float(clean["sigma_pts"].median())

    best_lambda = lambda_min
    best_train_rmse = math.inf
    best_validation_rmse = math.inf
    for lambda_value in _lambda_grid(lambda_min, lambda_max, lambda_step):
        train_rmse, state = _walk_forward_rmse(train, lambda_value, initial_sigma=median_sigma)
        validation_rmse, _ = _walk_forward_rmse(validation, lambda_value, initial_variance=state)
        if validation_rmse < best_validation_rmse:
            best_lambda = lambda_value
            best_train_rmse = train_rmse
            best_validation_rmse = validation_rmse

    ratio = best_validation_rmse / best_train_rmse if best_train_rmse > 0 else 0.0
    return EwmaCalibration(
        symbol=symbol,
        lambda_value=round(best_lambda, 4),
        corpus_median_sigma_pts=median_sigma,
        train_rmse=best_train_rmse,
        validation_rmse=best_validation_rmse,
        validation_rmse_ratio=ratio,
        sessions_used=len(observations),
        train_sessions=len(train),
        validation_sessions=len(validation),
        generated_at_utc=datetime.now(tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        stats_path=str(stats_path),
        corpus_provenance={
            "summary_line": discovery.summary_line,
            "verified_sessions": len(discovery.sessions),
            "total_directories": discovery.total_directories,
            "rejected_count": discovery.rejected_count,
            "rejected_reasons": discovery.rejection_summary,
            "roots": [str(root) for root in roots] if roots is not None else [],
        },
    )


def _walk_forward_rmse(
    observations: list[float],
    lambda_value: float,
    *,
    initial_sigma: float | None = None,
    initial_variance: float | None = None,
) -> tuple[float, float]:
    if initial_variance is None:
        if initial_sigma is None:
            raise ValueError("initial_sigma or initial_variance is required")
        state = initial_sigma**2
    else:
        state = initial_variance
    squared_errors: list[float] = []
    for observation in observations:
        prediction = math.sqrt(max(0.0, state))
        squared_errors.append((prediction - observation) ** 2)
        state = lambda_value * state + (1.0 - lambda_value) * observation**2
    rmse = math.sqrt(sum(squared_errors) / len(squared_errors)) if squared_errors else 0.0
    return rmse, state


def _lambda_grid(lambda_min: float, lambda_max: float, lambda_step: float) -> list[float]:
    if not (0.0 < lambda_min <= lambda_max < 1.0):
        raise ValueError("lambda range must satisfy 0 < min <= max < 1")
    if lambda_step <= 0.0:
        raise ValueError("lambda_step must be positive")
    values: list[float] = []
    current = lambda_min
    while current <= lambda_max + 1e-9:
        values.append(round(current, 4))
        current += lambda_step
    return values


if __name__ == "__main__":
    raise SystemExit(main())
