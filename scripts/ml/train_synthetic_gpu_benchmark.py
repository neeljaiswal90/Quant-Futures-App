#!/usr/bin/env python
"""ML-GPU-00 synthetic training benchmark.

This script is an opt-in local benchmark for future ML training work. It uses
synthetic data only, never reads trading data, and does not wire any model into
runtime execution or strategy decisions.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


SYNTHETIC_BENCHMARK_REPORT_SCHEMA_VERSION = 1
TICKET_ID = "ML-GPU-00"
FrameworkName = Literal["auto", "torch", "xgboost"]


@dataclass(frozen=True)
class SyntheticBenchmarkRequest:
    out_path: Path | None
    framework: FrameworkName
    samples: int
    features: int
    epochs: int
    dry_run: bool


def run_benchmark(request: SyntheticBenchmarkRequest) -> dict[str, Any]:
    framework_reports: dict[str, Any] = {}
    if request.dry_run:
        report = _base_report(request)
        report.update(
            {
                "status": "dry_run",
                "frameworks": framework_reports,
                "scope_note": _scope_note(),
            }
        )
        _write_or_print_json(report, request.out_path)
        return report

    if request.framework in {"auto", "torch"}:
        framework_reports["torch"] = _torch_training_report(request)
    if request.framework in {"auto", "xgboost"}:
        framework_reports["xgboost"] = _xgboost_training_report(request)

    ran_any = any(report.get("status") in {"completed", "partial"} for report in framework_reports.values())
    report = _base_report(request)
    report.update(
        {
            "status": "completed" if ran_any else "skipped",
            "frameworks": framework_reports,
            "scope_note": _scope_note(),
        }
    )
    _write_or_print_json(report, request.out_path)
    return report


def _base_report(request: SyntheticBenchmarkRequest) -> dict[str, Any]:
    return {
        "synthetic_gpu_benchmark_report_schema_version": SYNTHETIC_BENCHMARK_REPORT_SCHEMA_VERSION,
        "ticket_id": TICKET_ID,
        "framework": request.framework,
        "samples": request.samples,
        "features": request.features,
        "epochs": request.epochs,
        "python": {
            "version": sys.version,
            "executable": sys.executable,
        },
    }


def _torch_training_report(request: SyntheticBenchmarkRequest) -> dict[str, Any]:
    if importlib.util.find_spec("torch") is None:
        return {
            "installed": False,
            "status": "skipped",
            "instructions": "Install a CUDA-enabled PyTorch build for GPU training benchmarks.",
        }
    try:
        import torch
    except Exception as exc:  # noqa: BLE001 - optional dependency import failure is report data.
        return {"installed": False, "status": "skipped", "import_error": _short_error(exc)}

    devices = ["cpu"]
    if torch.cuda.is_available():
        devices.append("cuda")
    results = [_run_torch_device_benchmark(torch, request, device) for device in devices]
    speedup = _speedup(results, baseline_device="cpu", comparison_device="cuda")
    return {
        "installed": True,
        "status": "completed",
        "version": str(torch.__version__),
        "cuda_available": bool(torch.cuda.is_available()),
        "device_results": results,
        "gpu_vs_cpu_speedup": speedup,
    }


def _run_torch_device_benchmark(torch: Any, request: SyntheticBenchmarkRequest, device: str) -> dict[str, Any]:
    try:
        torch.manual_seed(0)
        x_train = torch.randn((request.samples, request.features), device=device)
        weights = torch.linspace(-1.0, 1.0, request.features, device=device)
        y_train = ((x_train @ weights) > 0).float().unsqueeze(1)
        model = torch.nn.Sequential(
            torch.nn.Linear(request.features, 16),
            torch.nn.ReLU(),
            torch.nn.Linear(16, 1),
        ).to(device)
        optimizer = torch.optim.SGD(model.parameters(), lr=0.05)
        loss_fn = torch.nn.BCEWithLogitsLoss()
        if device == "cuda":
            torch.cuda.synchronize()
        started = time.perf_counter()
        final_loss = 0.0
        for _ in range(request.epochs):
            optimizer.zero_grad(set_to_none=True)
            logits = model(x_train)
            loss = loss_fn(logits, y_train)
            loss.backward()
            optimizer.step()
            final_loss = float(loss.detach().cpu())
        if device == "cuda":
            torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        return {
            "device": device,
            "status": "completed",
            "elapsed_seconds": _round6(elapsed),
            "final_loss": _round6(final_loss),
        }
    except Exception as exc:  # noqa: BLE001 - benchmark failures should not fail the whole script.
        return {
            "device": device,
            "status": "failed",
            "error": _short_error(exc),
        }


def _xgboost_training_report(request: SyntheticBenchmarkRequest) -> dict[str, Any]:
    if importlib.util.find_spec("xgboost") is None:
        return {
            "installed": False,
            "status": "skipped",
            "instructions": "Install XGBoost with CUDA support for GPU tree-training benchmarks.",
        }
    try:
        import numpy as np
        import xgboost as xgb
    except Exception as exc:  # noqa: BLE001 - optional dependency import failure is report data.
        return {"installed": False, "status": "skipped", "import_error": _short_error(exc)}

    rng = np.random.default_rng(0)
    features = rng.normal(size=(request.samples, request.features)).astype("float32")
    labels = (features[:, 0] + 0.5 * features[:, 1] - 0.25 * features[:, 2] > 0).astype("int32")
    dtrain = xgb.DMatrix(features, label=labels)
    results = [
        _run_xgboost_device_benchmark(
            xgb,
            dtrain,
            {"tree_method": "hist", "device": "cpu"},
            "cpu",
            request.epochs,
        ),
        _run_xgboost_device_benchmark(
            xgb,
            dtrain,
            {"tree_method": "hist", "device": "cuda"},
            "cuda",
            request.epochs,
        ),
    ]
    speedup = _speedup(results, baseline_device="cpu", comparison_device="cuda")
    completed_count = sum(1 for result in results if result.get("status") == "completed")
    return {
        "installed": True,
        "status": "completed" if completed_count else "skipped",
        "version": str(getattr(xgb, "__version__", "unknown")),
        "device_results": results,
        "gpu_vs_cpu_speedup": speedup,
    }


def _run_xgboost_device_benchmark(
    xgb: Any,
    dtrain: Any,
    device_params: dict[str, Any],
    device: str,
    rounds: int,
) -> dict[str, Any]:
    try:
        started = time.perf_counter()
        xgb.train(
            {
                "objective": "binary:logistic",
                "eval_metric": "logloss",
                "max_depth": 2,
                "eta": 0.2,
                "verbosity": 0,
                **device_params,
            },
            dtrain,
            num_boost_round=rounds,
        )
        elapsed = time.perf_counter() - started
        return {
            "device": device,
            "status": "completed",
            "elapsed_seconds": _round6(elapsed),
        }
    except Exception as exc:  # noqa: BLE001 - GPU runtime failures are benchmark results.
        return {
            "device": device,
            "status": "failed",
            "error": _short_error(exc),
        }


def _speedup(
    results: list[dict[str, Any]],
    *,
    baseline_device: str,
    comparison_device: str,
) -> float | None:
    baseline = _elapsed_for_device(results, baseline_device)
    comparison = _elapsed_for_device(results, comparison_device)
    if baseline is None or comparison is None or comparison <= 0:
        return None
    return _round6(baseline / comparison)


def _elapsed_for_device(results: list[dict[str, Any]], device: str) -> float | None:
    for result in results:
        if result.get("device") == device and result.get("status") == "completed":
            return float(result["elapsed_seconds"])
    return None


def _write_or_print_json(report: dict[str, Any], out_path: Path | None) -> None:
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if out_path is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(payload, encoding="utf-8")
    print(payload, end="")


def _scope_note() -> str:
    return (
        "ML-GPU-00 uses synthetic data only. It does not add model inference to ORCH, "
        "change strategy decisions, alter DATA gates, or use GPU for production parity tools."
    )


def _short_error(exc: BaseException) -> str:
    return " ".join(str(exc).split())[:500]


def _round6(value: float) -> float:
    return round(float(value), 6)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="Optional path for the JSON benchmark report.")
    parser.add_argument("--framework", choices=["auto", "torch", "xgboost"], default="auto")
    parser.add_argument("--samples", type=int, default=2048)
    parser.add_argument("--features", type=int, default=32)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate CLI/report plumbing without importing PyTorch or XGBoost.",
    )
    return parser.parse_args(argv)


def request_from_args(args: argparse.Namespace) -> SyntheticBenchmarkRequest:
    if int(args.samples) <= 0:
        raise ValueError("--samples must be positive")
    if int(args.features) < 3:
        raise ValueError("--features must be at least 3")
    if int(args.epochs) <= 0:
        raise ValueError("--epochs must be positive")
    return SyntheticBenchmarkRequest(
        out_path=args.out,
        framework=args.framework,
        samples=int(args.samples),
        features=int(args.features),
        epochs=int(args.epochs),
        dry_run=bool(args.dry_run),
    )


def main(argv: list[str]) -> int:
    request = request_from_args(parse_args(argv))
    run_benchmark(request)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001 - CLI should surface script errors distinctly.
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
