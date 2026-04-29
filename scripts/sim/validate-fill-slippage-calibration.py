#!/usr/bin/env python
"""SIM-03D calibration report gate.

This script is filesystem-only. It reads a completed SIM-03 calibration report,
rechecks the plan 11.1 residual thresholds encoded in that report, and writes a
small gate report that REL automation can consume.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


GATE_REPORT_SCHEMA_VERSION = 1
SUPPORTED_CALIBRATION_REPORT_SCHEMA_VERSION = 1
TICKET_ID = "SIM-03D"


@dataclass(frozen=True)
class GateRequest:
    report_path: Path
    out_path: Path
    checked_at_ts_ns: str


def validate_report(request: GateRequest) -> dict[str, Any]:
    source_report = _read_json(request.report_path)
    source_report_hash = _sha256_file(request.report_path)

    _validate_source_shape(source_report)

    gate_checks: list[dict[str, Any]] = []
    residual_checks: dict[str, list[dict[str, Any]]] = {
        "marketable_slippage": [],
        "limit_queue": [],
        "strategy_level_cost": [],
    }

    gate_checks.extend(_top_level_checks(source_report))
    gate_checks.extend(_lineage_checks(source_report))
    residual_checks["marketable_slippage"] = _marketable_checks(source_report)
    residual_checks["limit_queue"] = _limit_queue_checks(source_report)
    residual_checks["strategy_level_cost"] = _strategy_cost_checks(source_report)

    failure_reasons = _failure_reasons(gate_checks, residual_checks)
    status = "pass" if not failure_reasons else "fail"
    report: dict[str, Any] = {
        "calibration_gate_report_schema_version": GATE_REPORT_SCHEMA_VERSION,
        "ticket_id": TICKET_ID,
        "status": status,
        "ready_for_rel01_execution_simulation": status == "pass",
        "checked_at_ts_ns": request.checked_at_ts_ns,
        "source_report_path": str(request.report_path),
        "source_report_hash": source_report_hash,
        "source_report_schema_version": source_report.get("calibration_report_schema_version"),
        "source_report_status": source_report.get("status"),
        "source_report_ready_for_rel01_execution_simulation": source_report.get(
            "ready_for_rel01_execution_simulation"
        ),
        "source_inputs": source_report.get("inputs", {}),
        "gate_checks": gate_checks,
        "residual_checks": residual_checks,
        "failure_reasons": failure_reasons,
        "scope_note": (
            "SIM-03D validates a completed SIM-03 report only. It performs no Databento "
            "network calls, no corpus scanning, and no model fitting."
        ),
    }
    _write_json(request.out_path, report)
    return report


def _top_level_checks(report: dict[str, Any]) -> list[dict[str, Any]]:
    source_failure_reasons = report.get("failure_reasons")
    failure_reason_count = len(source_failure_reasons) if isinstance(source_failure_reasons, list) else None
    return [
        _boolean_check(
            name="source_status_pass",
            passed=report.get("status") == "pass",
            detail=f"source status is {report.get('status')}",
        ),
        _boolean_check(
            name="source_ready_for_rel01_execution_simulation",
            passed=report.get("ready_for_rel01_execution_simulation") is True,
            detail=f"source ready flag is {report.get('ready_for_rel01_execution_simulation')}",
        ),
        _boolean_check(
            name="source_failure_reasons_empty",
            passed=failure_reason_count == 0,
            detail=f"source failure reason count is {failure_reason_count}",
        ),
    ]


def _lineage_checks(report: dict[str, Any]) -> list[dict[str, Any]]:
    inputs = report.get("inputs", {})
    if not isinstance(inputs, dict):
        inputs = {}
    return [
        _hex_check("manifest_hash_present", inputs.get("manifest_hash")),
        _hex_check("verified_report_hash_present", inputs.get("verified_report_hash")),
        _hex_check("thresholds_config_hash_present", inputs.get("thresholds_config_hash")),
        _boolean_check(
            name="verified_report_ready",
            passed=inputs.get("verified_report_ready") is True,
            detail=f"verified_report_ready is {inputs.get('verified_report_ready')}",
        ),
    ]


def _marketable_checks(report: dict[str, Any]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for residual in _residuals(report, "marketable_slippage"):
        bucket_id = str(residual.get("bucket_id", "unknown"))
        bucket_checks = [
            _residual_status_check(residual),
            _numeric_threshold_check(residual, "ks_statistic", "ks_threshold"),
            _numeric_threshold_check(residual, "p50_residual", "p50_threshold"),
            _numeric_threshold_check(residual, "p90_residual", "p90_threshold"),
            _numeric_threshold_check(residual, "adverse_p95_residual", "adverse_p95_threshold"),
        ]
        checks.append(_residual_check("marketable_slippage", bucket_id, bucket_checks, residual))
    if not checks:
        checks.append(_missing_residual_group_check("marketable_slippage"))
    return checks


def _limit_queue_checks(report: dict[str, Any]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for residual in _residuals(report, "limit_queue"):
        bucket_id = str(residual.get("bucket_id", "unknown"))
        bucket_checks = [
            _residual_status_check(residual),
            _numeric_threshold_check(residual, "fill_probability_residual", "fill_probability_threshold"),
            _numeric_threshold_check(
                residual,
                "time_to_fill_relative_error",
                "time_to_fill_relative_threshold",
            ),
            _numeric_threshold_check(residual, "no_fill_rate_residual", "no_fill_rate_threshold"),
        ]
        checks.append(_residual_check("limit_queue", bucket_id, bucket_checks, residual))
    if not checks:
        checks.append(_missing_residual_group_check("limit_queue"))
    return checks


def _strategy_cost_checks(report: dict[str, Any]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for residual in _residuals(report, "strategy_level_cost"):
        strategy_id = str(residual.get("strategy_id", "unknown"))
        strategy_checks = [
            _residual_status_check(residual),
            _numeric_threshold_check(residual, "mean_residual", "threshold"),
        ]
        checks.append(_residual_check("strategy_level_cost", strategy_id, strategy_checks, residual))
    if not checks:
        checks.append(_missing_residual_group_check("strategy_level_cost"))
    return checks


def _residual_check(
    group: str,
    check_id: str,
    checks: list[dict[str, Any]],
    residual: dict[str, Any],
) -> dict[str, Any]:
    failures = [check["name"] for check in checks if check["status"] != "pass"]
    return {
        "group": group,
        "id": check_id,
        "status": "pass" if not failures else "fail",
        "checks": checks,
        "failure_reasons": failures,
        "source_status": residual.get("status"),
        "calibration_sample_count": residual.get("calibration_sample_count"),
        "validation_sample_count": residual.get("validation_sample_count"),
    }


def _residual_status_check(residual: dict[str, Any]) -> dict[str, Any]:
    return _boolean_check(
        name="source_residual_status_pass",
        passed=residual.get("status") == "pass",
        detail=f"source residual status is {residual.get('status')}",
    )


def _numeric_threshold_check(residual: dict[str, Any], value_field: str, threshold_field: str) -> dict[str, Any]:
    value = _number(residual.get(value_field))
    threshold = _number(residual.get(threshold_field))
    passed = value is not None and threshold is not None and value <= threshold
    return {
        "name": f"{value_field}_within_{threshold_field}",
        "status": "pass" if passed else "fail",
        "value": value,
        "threshold": threshold,
        "detail": f"{value_field}={value}, {threshold_field}={threshold}",
    }


def _boolean_check(name: str, passed: bool, detail: str) -> dict[str, Any]:
    return {
        "name": name,
        "status": "pass" if passed else "fail",
        "detail": detail,
    }


def _hex_check(name: str, value: Any) -> dict[str, Any]:
    value_str = value if isinstance(value, str) else ""
    passed = len(value_str) == 64 and all(char in "0123456789abcdef" for char in value_str)
    return {
        "name": name,
        "status": "pass" if passed else "fail",
        "value": value,
        "detail": "value is lowercase sha256 hex" if passed else "value is not lowercase 64-character hex",
    }


def _missing_residual_group_check(group: str) -> dict[str, Any]:
    return {
        "group": group,
        "id": "__missing__",
        "status": "fail",
        "checks": [
            _boolean_check(
                name="residual_group_present",
                passed=False,
                detail=f"residual group {group} is missing or empty",
            )
        ],
        "failure_reasons": ["residual_group_present"],
    }


def _failure_reasons(
    gate_checks: list[dict[str, Any]],
    residual_checks: dict[str, list[dict[str, Any]]],
) -> list[str]:
    failures: list[str] = []
    for check in gate_checks:
        if check["status"] != "pass":
            failures.append(f"gate:{check['name']}")
    for group, checks in residual_checks.items():
        for check in checks:
            if check["status"] != "pass":
                failures.append(f"{group}:{check['id']}:failed")
    return failures


def _residuals(report: dict[str, Any], group: str) -> list[dict[str, Any]]:
    residuals = report.get("residuals", {})
    if not isinstance(residuals, dict):
        return []
    values = residuals.get(group, [])
    if not isinstance(values, list):
        return []
    return [value for value in values if isinstance(value, dict)]


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _validate_source_shape(report: dict[str, Any]) -> None:
    if report.get("calibration_report_schema_version") != SUPPORTED_CALIBRATION_REPORT_SCHEMA_VERSION:
        raise ValueError("unsupported calibration_report_schema_version")
    if report.get("ticket_id") != "SIM-03":
        raise ValueError("source report ticket_id is not SIM-03")


def _read_json(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return raw


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path, help="Path to fill_slippage_calibration.json")
    parser.add_argument(
        "--out",
        default=Path("reports/sim/fill_slippage_calibration_gate.json"),
        type=Path,
        help="Path to write the SIM-03D gate report",
    )
    parser.add_argument(
        "--checked-at-ts-ns",
        help="Caller-provided verification timestamp in nanoseconds",
    )
    return parser.parse_args(argv)


def request_from_args(args: argparse.Namespace) -> GateRequest:
    if args.checked_at_ts_ns is None or str(args.checked_at_ts_ns) == "":
        raise ValueError("--checked-at-ts-ns is required")
    return GateRequest(
        report_path=args.report,
        out_path=args.out,
        checked_at_ts_ns=str(args.checked_at_ts_ns),
    )


def main(argv: list[str]) -> int:
    try:
        report = validate_report(request_from_args(parse_args(argv)))
    except Exception as exc:  # noqa: BLE001 - CLI surfaces validation errors to operators.
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
