#!/usr/bin/env python
"""SIM-03A-0 Databento MNQ availability preflight.

This is an operational preflight, not a replay-stable analysis report. The real
Databento dataset range advances over time, so production output is a snapshot of
availability at run time. Unit tests use the fixture client and never call Databento.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol


AVAILABILITY_REPORT_SCHEMA_VERSION = 1
DEFAULT_DATASET = "GLBX.MDP3"
DEFAULT_SYMBOL = "MNQM6"
DEFAULT_SCHEMAS = ("trades", "mbp-1", "mbp-10", "mbo", "definition")
DEFAULT_SAMPLE_RECORD_LIMIT = 100


class DatabentoClientLike(Protocol):
    def metadata_get_dataset_range(self, dataset: str) -> dict[str, Any]:
        ...

    def timeseries_get_range(
        self,
        *,
        dataset: str,
        schema: str,
        symbol: str,
        start_ts_ns: int,
        end_ts_ns: int,
        limit: int,
    ) -> int:
        ...


@dataclass(frozen=True)
class AvailabilityRequest:
    dataset: str
    symbol: str
    session_id: str
    start_ts_ns: int
    end_ts_ns: int
    schemas: tuple[str, ...]
    sample_record_limit: int


class RealDatabentoClient:
    def __init__(self, api_key: str) -> None:
        import databento as db  # type: ignore[import-not-found]

        self._client = db.Historical(api_key)

    def metadata_get_dataset_range(self, dataset: str) -> dict[str, Any]:
        return dict(self._client.metadata.get_dataset_range(dataset=dataset))

    def timeseries_get_range(
        self,
        *,
        dataset: str,
        schema: str,
        symbol: str,
        start_ts_ns: int,
        end_ts_ns: int,
        limit: int,
    ) -> int:
        store = self._client.timeseries.get_range(
            dataset=dataset,
            symbols=symbol,
            schema=schema,
            stype_in="raw_symbol",
            start=start_ts_ns,
            end=end_ts_ns,
            limit=limit,
        )
        return _count_records(store)


class FixtureDatabentoClient:
    def __init__(self, fixture: dict[str, Any]) -> None:
        self._fixture = fixture

    def metadata_get_dataset_range(self, dataset: str) -> dict[str, Any]:
        metadata_error = self._fixture.get("dataset_range_error")
        if metadata_error is not None:
            raise RuntimeError(str(metadata_error))
        dataset_range = self._fixture.get("dataset_range")
        if not isinstance(dataset_range, dict):
            raise RuntimeError("fixture missing dataset_range")
        return dict(dataset_range)

    def timeseries_get_range(
        self,
        *,
        dataset: str,
        schema: str,
        symbol: str,
        start_ts_ns: int,
        end_ts_ns: int,
        limit: int,
    ) -> int:
        del dataset, symbol, start_ts_ns, end_ts_ns, limit
        schemas = self._fixture.get("schemas")
        if not isinstance(schemas, dict):
            raise RuntimeError("fixture missing schemas")
        schema_fixture = schemas.get(schema)
        if not isinstance(schema_fixture, dict):
            raise RuntimeError(f"fixture missing schema {schema}")
        error = schema_fixture.get("error")
        if error is not None:
            raise RuntimeError(str(error))
        return int(schema_fixture.get("sample_record_count", 0))


def build_availability_report(
    *,
    client: DatabentoClientLike | None,
    request: AvailabilityRequest,
    databento_api_key_present: bool,
) -> dict[str, Any]:
    dataset_range: dict[str, Any] | None = None
    dataset_range_error: str | None = None
    if client is not None:
        try:
            dataset_range = client.metadata_get_dataset_range(request.dataset)
        except Exception as exc:  # noqa: BLE001 - report provider error verbatim, without secrets.
            dataset_range_error = _safe_error_message(exc)

    schema_reports: dict[str, dict[str, Any]] = {}
    for schema in request.schemas:
        schema_reports[schema] = _probe_schema(client=client, request=request, schema=schema)

    unavailable = [
        schema
        for schema, schema_report in schema_reports.items()
        if not schema_report["available"]
    ]
    ready = (
        databento_api_key_present
        and dataset_range_error is None
        and len(unavailable) == 0
    )
    blocked_reason = _blocked_reason(
        api_key_present=databento_api_key_present,
        dataset_range_error=dataset_range_error,
        unavailable=unavailable,
        schema_reports=schema_reports,
    )

    report: dict[str, Any] = {
        "availability_report_schema_version": AVAILABILITY_REPORT_SCHEMA_VERSION,
        "ticket_id": "SIM-03A-0",
        "status": "ready" if ready else "blocked",
        "dataset": request.dataset,
        "symbol": request.symbol,
        "databento_api_key_present": databento_api_key_present,
        "dataset_range": dataset_range,
        "dataset_range_error": dataset_range_error,
        "probed_window": {
            "session_id": request.session_id,
            "start_ts_ns": str(request.start_ts_ns),
            "end_ts_ns": str(request.end_ts_ns),
        },
        "sample_record_limit": request.sample_record_limit,
        "schemas": schema_reports,
        "ready_for_sim03_calibration_corpus": ready,
        "blocked_reason": blocked_reason,
        "determinism_note": (
            "Production output is a snapshot-in-time Databento availability report; "
            "fixture tests are deterministic and perform no network calls."
        ),
    }
    return report


def _probe_schema(
    *,
    client: DatabentoClientLike | None,
    request: AvailabilityRequest,
    schema: str,
) -> dict[str, Any]:
    if client is None:
        return {
            "available": False,
            "sample_record_count": 0,
            "error": "DATABENTO_API_KEY is not set",
        }
    try:
        count = client.timeseries_get_range(
            dataset=request.dataset,
            schema=schema,
            symbol=request.symbol,
            start_ts_ns=request.start_ts_ns,
            end_ts_ns=request.end_ts_ns,
            limit=request.sample_record_limit,
        )
    except Exception as exc:  # noqa: BLE001 - Databento availability detail belongs in report.
        return {
            "available": False,
            "sample_record_count": 0,
            "error": _safe_error_message(exc),
        }
    if count <= 0:
        return {
            "available": False,
            "sample_record_count": count,
            "error": "no records returned",
        }
    return {
        "available": True,
        "sample_record_count": count,
    }


def _blocked_reason(
    *,
    api_key_present: bool,
    dataset_range_error: str | None,
    unavailable: list[str],
    schema_reports: dict[str, dict[str, Any]],
) -> str | None:
    if not api_key_present:
        return "DATABENTO_API_KEY is not set"
    if dataset_range_error is not None:
        return f"dataset range unavailable: {dataset_range_error}"
    if unavailable:
        details = ", ".join(
            f"{schema}: {schema_reports[schema].get('error', 'unavailable')}"
            for schema in unavailable
        )
        return f"schemas unavailable for selected RTH window: {details}"
    return None


def _count_records(store: Any) -> int:
    if isinstance(store, int):
        return store
    if hasattr(store, "to_ndarray"):
        return len(store.to_ndarray())
    if hasattr(store, "to_df"):
        return len(store.to_df())
    if hasattr(store, "__len__"):
        return len(store)
    return 0


def _safe_error_message(exc: Exception) -> str:
    message = str(exc)
    api_key = os.environ.get("DATABENTO_API_KEY")
    if api_key:
        message = message.replace(api_key, "[REDACTED_DATABENTO_API_KEY]")
    return re.sub(r"db-[A-Za-z0-9_-]+", "db-[REDACTED]", message)


def parse_timestamp_ns(value: str) -> int:
    stripped = value.strip()
    if stripped.isdecimal():
        parsed = int(stripped)
        if parsed < 0:
            raise ValueError("timestamp nanoseconds must be non-negative")
        return parsed

    iso_value = stripped.replace("Z", "+00:00")
    try:
        parsed_dt = datetime.fromisoformat(iso_value)
    except ValueError as exc:
        raise ValueError(f"invalid timestamp: {value}") from exc
    if parsed_dt.tzinfo is None:
        raise ValueError("timestamp must include timezone or use nanoseconds")
    utc = parsed_dt.astimezone(timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = utc - epoch
    return (
        delta.days * 86_400_000_000_000
        + delta.seconds * 1_000_000_000
        + delta.microseconds * 1_000
    )


def load_fixture_client(path: Path) -> FixtureDatabentoClient:
    return FixtureDatabentoClient(json.loads(path.read_text(encoding="utf-8")))


class StrictArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(message)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = StrictArgumentParser(
        description="Check Databento MNQ schema availability for SIM-03A corpus readiness.",
    )
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--start", required=True, help="RTH window start, ISO-8601 or ns")
    parser.add_argument("--end", required=True, help="RTH window end, ISO-8601 or ns")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--sample-record-limit", type=int, default=DEFAULT_SAMPLE_RECORD_LIMIT)
    parser.add_argument("--schemas", default=",".join(DEFAULT_SCHEMAS))
    parser.add_argument("--fixture", type=Path, help="Test-only fixture JSON; disables Databento network use")
    return parser.parse_args(argv)


def request_from_args(args: argparse.Namespace) -> AvailabilityRequest:
    start_ns = parse_timestamp_ns(args.start)
    end_ns = parse_timestamp_ns(args.end)
    if end_ns <= start_ns:
        raise ValueError("--end must be after --start")
    if args.sample_record_limit <= 0:
        raise ValueError("--sample-record-limit must be positive")
    schemas = tuple(
        schema.strip()
        for schema in str(args.schemas).split(",")
        if schema.strip()
    )
    if not schemas:
        raise ValueError("--schemas must include at least one schema")
    return AvailabilityRequest(
        dataset=str(args.dataset),
        symbol=str(args.symbol),
        session_id=str(args.session_id),
        start_ts_ns=start_ns,
        end_ts_ns=end_ns,
        schemas=schemas,
        sample_record_limit=int(args.sample_record_limit),
    )


def write_report(report: dict[str, Any], path: Path | None) -> None:
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    request = request_from_args(args)

    api_key = os.environ.get("DATABENTO_API_KEY")
    api_key_present = bool(api_key)
    if args.fixture is not None:
        client: DatabentoClientLike | None = load_fixture_client(args.fixture)
        api_key_present = bool(api_key) or bool(os.environ.get("SIM03A_FIXTURE_API_KEY_PRESENT", "1"))
    elif api_key_present:
        client = RealDatabentoClient(str(api_key))
    else:
        client = None

    report = build_availability_report(
        client=client,
        request=request,
        databento_api_key_present=api_key_present,
    )
    write_report(report, args.out)
    return 0 if report["ready_for_sim03_calibration_corpus"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
