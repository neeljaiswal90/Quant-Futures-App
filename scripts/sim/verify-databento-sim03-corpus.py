#!/usr/bin/env python
"""SIM-03A-2 Databento corpus integrity verifier.

This script is filesystem-only. It does not call Databento, fit SIM-02
constants, score residuals, or advance REL gates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


VERIFIED_REPORT_SCHEMA_VERSION = 1
SUPPORTED_THRESHOLDS_SCHEMA_VERSION = 1
SUPPORTED_MANIFEST_SCHEMA_VERSION = 1
TICKET_ID = "SIM-03A-2"
SHA256_HEX_PATTERN = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class VerifyRequest:
    manifest_path: Path
    thresholds_path: Path
    report_path: Path
    verified_at_ts_ns: str


def verify_corpus(request: VerifyRequest) -> dict[str, Any]:
    manifest = _read_json(request.manifest_path)
    thresholds = _read_json(request.thresholds_path)
    manifest_hash = _sha256_file(request.manifest_path)
    thresholds_hash = _sha256_file(request.thresholds_path)

    _validate_manifest_shape(manifest)
    _validate_thresholds_shape(thresholds)

    threshold_schemas: dict[str, Any] = thresholds["schemas"]
    min_verified_sessions = int(thresholds.get("min_verified_sessions", 20))
    quality_exclusions = _quality_exclusions(thresholds)

    sessions: list[dict[str, Any]] = []
    verified_session_count = 0
    quality_excluded_count = 0
    failed_session_count = 0
    source_excluded_count = 0
    source_partial_count = 0
    verified_bytes = 0
    failure_reasons: list[str] = []

    for source_session in manifest.get("sessions", []):
        session = _verify_session(
            source_session=source_session,
            threshold_schemas=threshold_schemas,
            quality_exclusions=quality_exclusions,
        )
        sessions.append(session)
        status = session["status"]
        if status == "verified":
            verified_session_count += 1
            verified_bytes += int(session["verified_byte_count"])
        elif status == "quality_excluded":
            quality_excluded_count += 1
        elif status == "source_excluded":
            source_excluded_count += 1
        elif status == "source_partial":
            source_partial_count += 1
            failed_session_count += 1
            failure_reasons.append(f"{session['session_id']}: source session is partial")
        else:
            failed_session_count += 1
            failure_reasons.extend(f"{session['session_id']}: {reason}" for reason in session["failure_reasons"])

    if verified_session_count < min_verified_sessions:
        failure_reasons.append(
            f"verified session count {verified_session_count} is below required minimum {min_verified_sessions}"
        )

    ready = failed_session_count == 0 and verified_session_count >= min_verified_sessions
    report: dict[str, Any] = {
        "verified_report_schema_version": VERIFIED_REPORT_SCHEMA_VERSION,
        "ticket_id": TICKET_ID,
        "status": "verified" if ready else "failed",
        "ready_for_sim03_model_fitting": ready,
        "verified_at_ts_ns": request.verified_at_ts_ns,
        "source_manifest_path": str(request.manifest_path),
        "source_manifest_hash": manifest_hash,
        "source_manifest_schema_version": manifest.get("manifest_schema_version"),
        "thresholds_config_path": str(request.thresholds_path),
        "thresholds_config_hash": thresholds_hash,
        "thresholds_schema_version": thresholds.get("thresholds_schema_version"),
        "dataset": manifest.get("dataset"),
        "symbol": manifest.get("symbol"),
        "min_verified_sessions": min_verified_sessions,
        "quality_exclusions": quality_exclusions,
        "corpus_summary": {
            "source_requested_sessions": int(manifest.get("corpus_summary", {}).get("requested_sessions", 0)),
            "source_complete_sessions": int(manifest.get("corpus_summary", {}).get("complete_sessions", 0)),
            "verified_sessions": verified_session_count,
            "quality_excluded_sessions": quality_excluded_count,
            "source_excluded_sessions": source_excluded_count,
            "source_partial_sessions": source_partial_count,
            "failed_sessions": failed_session_count,
            "verified_bytes": verified_bytes,
            "source_total_bytes": int(manifest.get("corpus_summary", {}).get("total_bytes", 0)),
        },
        "sessions": sessions,
        "failure_reasons": failure_reasons,
        "scope_note": "SIM-03A-2 verifies file integrity only; no Databento network calls or model fitting are performed.",
    }
    request.report_path.parent.mkdir(parents=True, exist_ok=True)
    request.report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def _verify_session(
    *,
    source_session: dict[str, Any],
    threshold_schemas: dict[str, Any],
    quality_exclusions: dict[str, str],
) -> dict[str, Any]:
    session_id = str(source_session.get("session_id"))
    source_status = str(source_session.get("status"))
    schemas: dict[str, dict[str, Any]] = {}
    failure_reasons: list[str] = []
    verified_byte_count = 0

    if source_status == "excluded":
        return _session_report(
            source_session=source_session,
            status="source_excluded",
            quality_exclusion_reason=None,
            schemas={},
            failure_reasons=[],
            verified_byte_count=0,
        )
    if source_status != "complete":
        return _session_report(
            source_session=source_session,
            status="source_partial",
            quality_exclusion_reason=None,
            schemas={},
            failure_reasons=[f"source status is {source_status}"],
            verified_byte_count=0,
        )

    source_schemas = source_session.get("schemas")
    if not isinstance(source_schemas, dict):
        return _session_report(
            source_session=source_session,
            status="failed",
            quality_exclusion_reason=quality_exclusions.get(session_id),
            schemas={},
            failure_reasons=["source session has no schemas object"],
            verified_byte_count=0,
        )

    for schema, schema_threshold in threshold_schemas.items():
        source_schema = source_schemas.get(schema)
        if not isinstance(source_schema, dict):
            schemas[schema] = _failed_schema_report(schema=schema, reason="schema missing from source manifest")
            failure_reasons.append(f"{schema}: schema missing from source manifest")
            continue
        schema_report = _verify_schema(source_schema=source_schema, schema_threshold=schema_threshold)
        schemas[schema] = schema_report
        if schema_report["status"] == "verified":
            verified_byte_count += int(schema_report["actual_byte_count"])
        else:
            failure_reasons.extend(f"{schema}: {reason}" for reason in schema_report["failure_reasons"])

    quality_reason = quality_exclusions.get(session_id)
    if failure_reasons:
        status = "failed"
    elif quality_reason is not None:
        status = "quality_excluded"
    else:
        status = "verified"
    return _session_report(
        source_session=source_session,
        status=status,
        quality_exclusion_reason=quality_reason,
        schemas=schemas,
        failure_reasons=failure_reasons,
        verified_byte_count=verified_byte_count if status == "verified" else 0,
    )


def _verify_schema(*, source_schema: dict[str, Any], schema_threshold: dict[str, Any]) -> dict[str, Any]:
    schema = str(source_schema.get("schema"))
    path = source_schema.get("path")
    manifest_byte_count = int(source_schema.get("byte_count") or 0)
    min_byte_count = int(schema_threshold.get("min_byte_count") or 0)
    failure_reasons: list[str] = []

    if source_schema.get("status") != "available":
        failure_reasons.append(f"source schema status is {source_schema.get('status')}")
    if not isinstance(path, str) or path == "":
        return _failed_schema_report(schema=schema, reason="schema path is missing")

    file_path = Path(path)
    if not file_path.exists():
        return _failed_schema_report(schema=schema, reason="schema file is missing", path=file_path)
    actual_byte_count = file_path.stat().st_size
    if actual_byte_count != manifest_byte_count:
        failure_reasons.append(
            f"actual byte count {actual_byte_count} does not match manifest byte count {manifest_byte_count}"
        )
    if actual_byte_count < min_byte_count:
        failure_reasons.append(
            f"actual byte count {actual_byte_count} is below minimum {min_byte_count}"
        )
    sha256 = _sha256_file(file_path)
    if not SHA256_HEX_PATTERN.fullmatch(sha256):
        failure_reasons.append("sha256 is not lowercase 64-character hex")

    return {
        "schema": schema,
        "status": "verified" if not failure_reasons else "failed",
        "path": str(file_path),
        "manifest_byte_count": manifest_byte_count,
        "actual_byte_count": actual_byte_count,
        "min_byte_count": min_byte_count,
        "byte_count_matches_manifest": actual_byte_count == manifest_byte_count,
        "byte_count_floor_pass": actual_byte_count >= min_byte_count,
        "sha256": sha256,
        "sha256_valid": bool(SHA256_HEX_PATTERN.fullmatch(sha256)),
        "failure_reasons": failure_reasons,
    }


def _session_report(
    *,
    source_session: dict[str, Any],
    status: str,
    quality_exclusion_reason: str | None,
    schemas: dict[str, dict[str, Any]],
    failure_reasons: list[str],
    verified_byte_count: int,
) -> dict[str, Any]:
    return {
        "session_id": source_session.get("session_id"),
        "source_status": source_session.get("status"),
        "status": status,
        "split": source_session.get("split"),
        "quality_exclusion_reason": quality_exclusion_reason,
        "rth_window": source_session.get("rth_window"),
        "definition_snapshot_window": source_session.get("definition_snapshot_window"),
        "schemas": schemas,
        "verified_byte_count": verified_byte_count,
        "failure_reasons": failure_reasons,
    }


def _failed_schema_report(*, schema: str, reason: str, path: Path | None = None) -> dict[str, Any]:
    return {
        "schema": schema,
        "status": "failed",
        "path": str(path) if path is not None else None,
        "manifest_byte_count": None,
        "actual_byte_count": path.stat().st_size if path is not None and path.exists() else 0,
        "min_byte_count": None,
        "byte_count_matches_manifest": False,
        "byte_count_floor_pass": False,
        "sha256": None,
        "sha256_valid": False,
        "failure_reasons": [reason],
    }


def _validate_manifest_shape(manifest: dict[str, Any]) -> None:
    if manifest.get("manifest_schema_version") != SUPPORTED_MANIFEST_SCHEMA_VERSION:
        raise ValueError("unsupported manifest_schema_version")
    if not isinstance(manifest.get("sessions"), list):
        raise ValueError("manifest sessions must be a list")
    if not isinstance(manifest.get("corpus_summary"), dict):
        raise ValueError("manifest corpus_summary must be an object")


def _validate_thresholds_shape(thresholds: dict[str, Any]) -> None:
    if thresholds.get("thresholds_schema_version") != SUPPORTED_THRESHOLDS_SCHEMA_VERSION:
        raise ValueError("unsupported thresholds_schema_version")
    schemas = thresholds.get("schemas")
    if not isinstance(schemas, dict) or not schemas:
        raise ValueError("thresholds schemas must be a non-empty object")
    for schema, config in schemas.items():
        if not isinstance(config, dict):
            raise ValueError(f"threshold for {schema} must be an object")
        min_byte_count = config.get("min_byte_count")
        if not isinstance(min_byte_count, int) or min_byte_count <= 0:
            raise ValueError(f"threshold for {schema} must define positive min_byte_count")


def _quality_exclusions(thresholds: dict[str, Any]) -> dict[str, str]:
    raw = thresholds.get("quality_exclusions", {})
    if not isinstance(raw, dict):
        raise ValueError("quality_exclusions must be an object when provided")
    exclusions: dict[str, str] = {}
    for session_id, value in raw.items():
        if isinstance(value, str):
            exclusions[str(session_id)] = value
        elif isinstance(value, dict):
            reason = value.get("reason")
            if not isinstance(reason, str) or reason == "":
                raise ValueError(f"quality exclusion for {session_id} must include reason")
            exclusions[str(session_id)] = reason
        else:
            raise ValueError(f"quality exclusion for {session_id} must be a string or object")
    return exclusions


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return raw


def _validate_timestamp_ns(value: str) -> str:
    if not value.isdecimal():
        raise ValueError("--verified-at-ts-ns must be a non-negative integer string")
    return value


class StrictArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(message)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = StrictArgumentParser(description="Verify SIM-03 Databento corpus files with sha256 and byte floors.")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--thresholds", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--verified-at-ts-ns", required=True)
    return parser.parse_args(argv)


def request_from_args(args: argparse.Namespace) -> VerifyRequest:
    return VerifyRequest(
        manifest_path=args.manifest,
        thresholds_path=args.thresholds,
        report_path=args.out,
        verified_at_ts_ns=_validate_timestamp_ns(str(args.verified_at_ts_ns)),
    )


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    report = verify_corpus(request_from_args(args))
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ready_for_sim03_model_fitting"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
