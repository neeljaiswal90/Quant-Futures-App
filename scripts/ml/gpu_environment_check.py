#!/usr/bin/env python
"""ML-GPU-00 local GPU environment check.

This script is an operational preflight for future ML training. It does not
change runtime trading behavior, does not read live data, and treats PyTorch,
XGBoost, CUDA, and GPUs as optional local capabilities.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


GPU_ENVIRONMENT_REPORT_SCHEMA_VERSION = 1
TICKET_ID = "ML-GPU-00"
DEFAULT_BENCHMARK_SIZE = 512
DEFAULT_BENCHMARK_ITERATIONS = 20


@dataclass(frozen=True)
class EnvironmentCheckRequest:
    out_path: Path | None
    skip_benchmarks: bool
    benchmark_size: int
    benchmark_iterations: int


def check_environment(request: EnvironmentCheckRequest) -> dict[str, Any]:
    report = {
        "gpu_environment_report_schema_version": GPU_ENVIRONMENT_REPORT_SCHEMA_VERSION,
        "ticket_id": TICKET_ID,
        "status": "completed",
        "python": {
            "version": sys.version,
            "version_info": list(sys.version_info[:3]),
            "executable": sys.executable,
            "platform": platform.platform(),
        },
        "torch": _torch_report(request),
        "xgboost": _xgboost_report(request),
        "scope_note": (
            "ML-GPU-00 checks local training capability only. It does not change live runtime, "
            "strategy decisions, ORCH inference, DATA gates, or production parity tooling."
        ),
    }
    _write_or_print_json(report, request.out_path)
    return report


def _torch_report(request: EnvironmentCheckRequest) -> dict[str, Any]:
    if importlib.util.find_spec("torch") is None:
        return {
            "installed": False,
            "cuda_available": False,
            "instructions": (
                "Install a CUDA-enabled PyTorch build in the local training environment, "
                "then rerun npm run ml:gpu:check."
            ),
        }

    try:
        import torch
    except Exception as exc:  # noqa: BLE001 - optional dependency import failure is report data.
        return {
            "installed": False,
            "cuda_available": False,
            "import_error": _short_error(exc),
            "instructions": "PyTorch is present but failed to import; repair the local Python ML environment.",
        }

    cuda_available = bool(torch.cuda.is_available())
    devices = []
    if cuda_available:
        for index in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(index)
            devices.append(
                {
                    "index": index,
                    "name": props.name,
                    "total_memory_bytes": int(props.total_memory),
                    "compute_capability": f"{props.major}.{props.minor}",
                }
            )

    report: dict[str, Any] = {
        "installed": True,
        "version": str(torch.__version__),
        "cuda_available": cuda_available,
        "cuda_version": str(torch.version.cuda) if torch.version.cuda is not None else None,
        "device_count": len(devices),
        "devices": devices,
    }
    if request.skip_benchmarks:
        report["tensor_benchmark"] = {"status": "skipped", "reason": "skip_benchmarks"}
    else:
        report["tensor_benchmark"] = _torch_tensor_benchmark(torch, request)
    return report


def _torch_tensor_benchmark(torch: Any, request: EnvironmentCheckRequest) -> dict[str, Any]:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        torch.manual_seed(0)
        matrix_a = torch.randn((request.benchmark_size, request.benchmark_size), device=device)
        matrix_b = torch.randn((request.benchmark_size, request.benchmark_size), device=device)
        if device == "cuda":
            torch.cuda.synchronize()
        started = time.perf_counter()
        checksum = 0.0
        for _ in range(request.benchmark_iterations):
            product = matrix_a @ matrix_b
            checksum = float(product[0, 0].detach().cpu())
        if device == "cuda":
            torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        return {
            "status": "ran",
            "device": device,
            "matrix_size": request.benchmark_size,
            "iterations": request.benchmark_iterations,
            "elapsed_seconds": _round6(elapsed),
            "checksum": _round6(checksum),
        }
    except Exception as exc:  # noqa: BLE001 - benchmark failures should not fail environment checks.
        return {
            "status": "failed",
            "device": device,
            "error": _short_error(exc),
        }


def _xgboost_report(request: EnvironmentCheckRequest) -> dict[str, Any]:
    if importlib.util.find_spec("xgboost") is None:
        return {
            "installed": False,
            "gpu_support_available": False,
            "instructions": (
                "Install XGBoost with CUDA support in the local training environment if future "
                "tree-based GPU experiments need it."
            ),
        }

    try:
        import xgboost as xgb
    except Exception as exc:  # noqa: BLE001 - optional dependency import failure is report data.
        return {
            "installed": False,
            "gpu_support_available": False,
            "import_error": _short_error(exc),
            "instructions": "XGBoost is present but failed to import; repair the local Python ML environment.",
        }

    build_info = _xgboost_build_info(xgb)
    report: dict[str, Any] = {
        "installed": True,
        "version": str(getattr(xgb, "__version__", "unknown")),
        "build_info": build_info,
        "cuda_build_enabled": _xgboost_cuda_build_enabled(build_info),
    }
    if request.skip_benchmarks:
        report["gpu_runtime_probe"] = {"status": "skipped", "reason": "skip_benchmarks"}
        report["gpu_support_available"] = bool(report["cuda_build_enabled"])
    else:
        probe = _xgboost_gpu_runtime_probe(xgb)
        report["gpu_runtime_probe"] = probe
        report["gpu_support_available"] = probe.get("status") == "passed"
    return report


def _xgboost_build_info(xgb: Any) -> dict[str, Any]:
    if not hasattr(xgb, "build_info"):
        return {}
    try:
        info = xgb.build_info()
        return info if isinstance(info, dict) else {}
    except Exception:  # noqa: BLE001 - build metadata is best-effort optional telemetry.
        return {}


def _xgboost_cuda_build_enabled(build_info: dict[str, Any]) -> bool | None:
    for key, value in build_info.items():
        key_text = str(key).lower()
        if "cuda" not in key_text and "gpu" not in key_text:
            continue
        value_text = str(value).lower()
        if value_text in {"on", "true", "1", "yes"}:
            return True
        if value_text in {"off", "false", "0", "no"}:
            return False
    return None


def _xgboost_gpu_runtime_probe(xgb: Any) -> dict[str, Any]:
    try:
        import numpy as np
    except Exception as exc:  # noqa: BLE001 - optional dependency import failure is report data.
        return {"status": "failed", "error": f"numpy unavailable: {_short_error(exc)}"}

    rng = np.random.default_rng(0)
    features = rng.normal(size=(64, 4)).astype("float32")
    labels = (features[:, 0] + 0.5 * features[:, 1] > 0).astype("int32")
    dtrain = xgb.DMatrix(features, label=labels)
    attempts = [
        {"tree_method": "hist", "device": "cuda"},
        {"tree_method": "gpu_hist"},
    ]
    errors = []
    for params in attempts:
        try:
            xgb.train(
                {
                    "objective": "binary:logistic",
                    "eval_metric": "logloss",
                    "max_depth": 1,
                    "eta": 1.0,
                    "verbosity": 0,
                    **params,
                },
                dtrain,
                num_boost_round=1,
            )
            return {"status": "passed", "params": params}
        except Exception as exc:  # noqa: BLE001 - probe should collect candidate failures.
            errors.append({"params": params, "error": _short_error(exc)})
    return {
        "status": "failed",
        "attempts": errors,
    }


def _write_or_print_json(report: dict[str, Any], out_path: Path | None) -> None:
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if out_path is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(payload, encoding="utf-8")
    print(payload, end="")


def _short_error(exc: BaseException) -> str:
    return " ".join(str(exc).split())[:500]


def _round6(value: float) -> float:
    return round(float(value), 6)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="Optional path for the JSON environment report.")
    parser.add_argument(
        "--skip-benchmarks",
        action="store_true",
        help="Skip tensor/runtime probes and only report import/build metadata.",
    )
    parser.add_argument("--benchmark-size", type=int, default=DEFAULT_BENCHMARK_SIZE)
    parser.add_argument("--benchmark-iterations", type=int, default=DEFAULT_BENCHMARK_ITERATIONS)
    return parser.parse_args(argv)


def request_from_args(args: argparse.Namespace) -> EnvironmentCheckRequest:
    if int(args.benchmark_size) <= 0:
        raise ValueError("--benchmark-size must be positive")
    if int(args.benchmark_iterations) <= 0:
        raise ValueError("--benchmark-iterations must be positive")
    return EnvironmentCheckRequest(
        out_path=args.out,
        skip_benchmarks=bool(args.skip_benchmarks),
        benchmark_size=int(args.benchmark_size),
        benchmark_iterations=int(args.benchmark_iterations),
    )


def main(argv: list[str]) -> int:
    request = request_from_args(parse_args(argv))
    check_environment(request)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001 - CLI should surface script errors distinctly.
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
