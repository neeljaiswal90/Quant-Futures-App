#!/usr/bin/env python
"""SIM-03A-1 Databento corpus fetch and manifest writer.

This script performs data acquisition only. It does not fit SIM-02 constants,
score residuals, or advance REL gates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol


MANIFEST_SCHEMA_VERSION = 1
TICKET_ID = "SIM-03A-1"
DEFAULT_DATASET = "GLBX.MDP3"
DEFAULT_SYMBOL = "MNQM6"
EVENT_SCHEMAS = ("trades", "mbp-1", "mbp-10", "mbo")
DEFINITION_SCHEMA = "definition"
ALL_SCHEMAS = (*EVENT_SCHEMAS, DEFINITION_SCHEMA)
DEFAULT_MIN_COMPLETE_SESSIONS = 20
DEFAULT_VALIDATION_FRACTION = 0.2
DEFAULT_MIN_RTH_HOURS = 6.0
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_RETRY_BASE_SECONDS = 1.0


class DatabentoFetchClientLike(Protocol):
    def metadata_get_dataset_range(self, dataset: str) -> dict[str, Any]:
        ...

    def timeseries_get_range_to_file(
        self,
        *,
        dataset: str,
        schema: str,
        symbol: str,
        start_ts_ns: int,
        end_ts_ns: int,
        path: Path,
    ) -> int | None:
        ...


@dataclass(frozen=True)
class SessionWindow:
    session_id: str
    start_ts_ns: int
    end_ts_ns: int
    symbol: str


@dataclass(frozen=True)
class FetchRequest:
    dataset: str
    default_symbol: str
    out_dir: Path
    manifest_path: Path
    sessions: tuple[SessionWindow, ...]
    min_complete_sessions: int
    validation_fraction: float
    min_rth_hours: float
    retry_attempts: int
    retry_base_seconds: float


class RealDatabentoFetchClient:
    def __init__(self, api_key: str) -> None:
        import databento as db  # type: ignore[import-not-found]

        self._client = db.Historical(api_key)

    def metadata_get_dataset_range(self, dataset: str) -> dict[str, Any]:
        return dict(self._client.metadata.get_dataset_range(dataset=dataset))

    def timeseries_get_range_to_file(
        self,
        *,
        dataset: str,
        schema: str,
        symbol: str,
        start_ts_ns: int,
        end_ts_ns: int,
        path: Path,
    ) -> int | None:
        self._client.timeseries.get_range(
            dataset=dataset,
            symbols=symbol,
            schema=schema,
            stype_in="raw_symbol",
            start=start_ts_ns,
            end=end_ts_ns,
            path=path,
        )
        return None


class FixtureDatabentoFetchClient:
    def __init__(self, fixture: dict[str, Any]) -> None:
        self._fixture = fixture
        self._attempts: dict[tuple[str, str], int] = {}

    def metadata_get_dataset_range(self, dataset: str) -> dict[str, Any]:
        del dataset
        error = self._fixture.get("dataset_range_error")
        if error is not None:
            raise RuntimeError(str(error))
        dataset_range = self._fixture.get("dataset_range")
        if isinstance(dataset_range, dict):
            return dict(dataset_range)
        return {"start": "2010-06-06T00:00:00.000000000Z", "end": "2026-04-28T00:00:00.000000000Z"}

    def timeseries_get_range_to_file(
        self,
        *,
        dataset: str,
        schema: str,
        symbol: str,
        start_ts_ns: int,
        end_ts_ns: int,
        path: Path,
    ) -> int | None:
        del dataset, symbol
        session_id = path.parent.name
        key = (session_id, schema)
        self._attempts[key] = self._attempts.get(key, 0) + 1
        schema_fixture = _fixture_schema(self._fixture, session_id, schema)
        failures_before_success = int(schema_fixture.get("failures_before_success", 0))
        if self._attempts[key] <= failures_before_success:
            raise RuntimeError(str(schema_fixture.get("transient_error", "transient fixture error")))
        error = schema_fixture.get("error")
        if error is not None:
            raise RuntimeError(str(error))
        payload = {
            "schema": schema,
            "session_id": session_id,
            "start_ts_ns": str(start_ts_ns),
            "end_ts_ns": str(end_ts_ns),
            "records": int(schema_fixture.get("record_count", 100)),
        }
        path.write_bytes(json.dumps(payload, sort_keys=True).encode("utf-8"))
        return int(schema_fixture.get("record_count", 100))


def fetch_corpus(
    *,
    client: DatabentoFetchClientLike | None,
    request: FetchRequest,
    databento_api_key_present: bool,
) -> dict[str, Any]:
    dataset_range: dict[str, Any] | None = None
    dataset_range_error: str | None = None
    if client is not None:
        try:
            dataset_range = client.metadata_get_dataset_range(request.dataset)
        except Exception as exc:  # noqa: BLE001 - provider error belongs in manifest, redacted.
            dataset_range_error = _safe_error_message(exc)

    session_entries: list[dict[str, Any]] = []
    completed_session_ids: list[str] = []
    for session in request.sessions:
        session_entry = _fetch_session(
            client=client,
            request=request,
            session=session,
            api_key_present=databento_api_key_present,
            dataset_range_error=dataset_range_error,
        )
        session_entries.append(session_entry)
        if session_entry["status"] == "complete":
            completed_session_ids.append(session.session_id)

    split_by_session = _deterministic_split(
        completed_session_ids,
        validation_fraction=request.validation_fraction,
    )
    for entry in session_entries:
        session_id = entry["session_id"]
        entry["split"] = split_by_session.get(session_id)

    complete_count = len(completed_session_ids)
    excluded_count = sum(1 for entry in session_entries if entry["status"] == "excluded")
    partial_count = sum(1 for entry in session_entries if entry["status"] == "partial")
    status = "complete" if complete_count >= request.min_complete_sessions and partial_count == 0 else "partial"
    blocked_reason = _manifest_blocked_reason(
        api_key_present=databento_api_key_present,
        dataset_range_error=dataset_range_error,
        complete_count=complete_count,
        min_complete_sessions=request.min_complete_sessions,
        partial_count=partial_count,
    )

    manifest: dict[str, Any] = {
        "manifest_schema_version": MANIFEST_SCHEMA_VERSION,
        "ticket_id": TICKET_ID,
        "status": status,
        "dataset": request.dataset,
        "symbol": request.default_symbol,
        "databento_api_key_present": databento_api_key_present,
        "dataset_range": dataset_range,
        "dataset_range_error": dataset_range_error,
        "out_dir": str(request.out_dir),
        "event_schemas": list(EVENT_SCHEMAS),
        "definition_schema": DEFINITION_SCHEMA,
        "min_complete_sessions": request.min_complete_sessions,
        "validation_fraction": request.validation_fraction,
        "retry_policy": {
            "attempts": request.retry_attempts,
            "base_seconds": request.retry_base_seconds,
            "backoff": "exponential",
        },
        "corpus_summary": {
            "requested_sessions": len(request.sessions),
            "complete_sessions": complete_count,
            "excluded_sessions": excluded_count,
            "partial_sessions": partial_count,
            "calibration_sessions": sum(1 for split in split_by_session.values() if split == "calibration"),
            "validation_sessions": sum(1 for split in split_by_session.values() if split == "validation"),
            "total_bytes": sum(
                int(schema_entry.get("byte_count", 0))
                for session_entry in session_entries
                for schema_entry in session_entry["schemas"].values()
            ),
        },
        "sessions": session_entries,
        "ready_for_sim03_model_fitting": status == "complete",
        "blocked_reason": blocked_reason,
        "scope_note": "SIM-03A-1 fetches corpus files and writes a manifest only; no model fitting is performed.",
    }
    request.manifest_path.parent.mkdir(parents=True, exist_ok=True)
    request.manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def _fetch_session(
    *,
    client: DatabentoFetchClientLike | None,
    request: FetchRequest,
    session: SessionWindow,
    api_key_present: bool,
    dataset_range_error: str | None,
) -> dict[str, Any]:
    exclusion_reason = _session_exclusion_reason(session, min_rth_hours=request.min_rth_hours)
    session_dir = request.out_dir / session.session_id
    schema_entries: dict[str, dict[str, Any]] = {}
    if exclusion_reason is not None:
        return _session_manifest_entry(
            session=session,
            status="excluded",
            exclusion_reason=exclusion_reason,
            schemas={schema: _skipped_schema_entry(schema, "session_excluded") for schema in ALL_SCHEMAS},
        )
    if not api_key_present:
        return _session_manifest_entry(
            session=session,
            status="partial",
            exclusion_reason=None,
            schemas={schema: _skipped_schema_entry(schema, "DATABENTO_API_KEY is not set") for schema in ALL_SCHEMAS},
        )
    if client is None:
        return _session_manifest_entry(
            session=session,
            status="partial",
            exclusion_reason=None,
            schemas={schema: _skipped_schema_entry(schema, "Databento client unavailable") for schema in ALL_SCHEMAS},
        )
    if dataset_range_error is not None:
        return _session_manifest_entry(
            session=session,
            status="partial",
            exclusion_reason=None,
            schemas={schema: _skipped_schema_entry(schema, f"dataset range unavailable: {dataset_range_error}") for schema in ALL_SCHEMAS},
        )

    for schema in EVENT_SCHEMAS:
        schema_entries[schema] = _fetch_schema_with_resume(
            client=client,
            request=request,
            session=session,
            schema=schema,
            start_ts_ns=session.start_ts_ns,
            end_ts_ns=session.end_ts_ns,
            path=session_dir / f"{schema}.dbn.zst",
        )

    definition_start_ns, definition_end_ns = _definition_window_ns(session)
    schema_entries[DEFINITION_SCHEMA] = _fetch_schema_with_resume(
        client=client,
        request=request,
        session=session,
        schema=DEFINITION_SCHEMA,
        start_ts_ns=definition_start_ns,
        end_ts_ns=definition_end_ns,
        path=session_dir / f"{DEFINITION_SCHEMA}.dbn.zst",
    )

    status = "complete" if all(entry["status"] == "available" for entry in schema_entries.values()) else "partial"
    return _session_manifest_entry(
        session=session,
        status=status,
        exclusion_reason=None,
        schemas=schema_entries,
    )


def _fetch_schema_with_resume(
    *,
    client: DatabentoFetchClientLike,
    request: FetchRequest,
    session: SessionWindow,
    schema: str,
    start_ts_ns: int,
    end_ts_ns: int,
    path: Path,
) -> dict[str, Any]:
    if path.exists() and path.stat().st_size > 0:
        return _schema_entry(
            schema=schema,
            status="available",
            path=path,
            start_ts_ns=start_ts_ns,
            end_ts_ns=end_ts_ns,
            attempts=0,
            reused_existing=True,
            record_count=None,
        )
    if path.exists() and path.stat().st_size == 0:
        path.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)

    error: str | None = None
    attempts = 0
    for attempt in range(1, request.retry_attempts + 1):
        attempts = attempt
        tmp_path = path.with_name(f"{path.stem}.tmp{path.suffix}")
        if tmp_path.exists():
            tmp_path.unlink()
        try:
            record_count = client.timeseries_get_range_to_file(
                dataset=request.dataset,
                schema=schema,
                symbol=session.symbol,
                start_ts_ns=start_ts_ns,
                end_ts_ns=end_ts_ns,
                path=tmp_path,
            )
            if not tmp_path.exists() or tmp_path.stat().st_size <= 0:
                raise RuntimeError("fetch returned no bytes")
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(tmp_path), str(path))
            return _schema_entry(
                schema=schema,
                status="available",
                path=path,
                start_ts_ns=start_ts_ns,
                end_ts_ns=end_ts_ns,
                attempts=attempts,
                reused_existing=False,
                record_count=record_count,
            )
        except Exception as exc:  # noqa: BLE001 - provider/retry details belong in manifest.
            error = _safe_error_message(exc)
            if tmp_path.exists():
                tmp_path.unlink()
            if attempt < request.retry_attempts and request.retry_base_seconds > 0:
                time.sleep(request.retry_base_seconds * (2 ** (attempt - 1)))

    return {
        "schema": schema,
        "status": "failed",
        "path": str(path),
        "byte_count": path.stat().st_size if path.exists() else 0,
        "record_count": None,
        "start_ts_ns": str(start_ts_ns),
        "end_ts_ns": str(end_ts_ns),
        "attempts": attempts,
        "reused_existing": False,
        "error": error or "fetch failed",
    }


def _schema_entry(
    *,
    schema: str,
    status: str,
    path: Path,
    start_ts_ns: int,
    end_ts_ns: int,
    attempts: int,
    reused_existing: bool,
    record_count: int | None,
) -> dict[str, Any]:
    return {
        "schema": schema,
        "status": status,
        "path": str(path),
        "byte_count": path.stat().st_size,
        "record_count": record_count,
        "start_ts_ns": str(start_ts_ns),
        "end_ts_ns": str(end_ts_ns),
        "attempts": attempts,
        "reused_existing": reused_existing,
    }


def _skipped_schema_entry(schema: str, reason: str) -> dict[str, Any]:
    return {
        "schema": schema,
        "status": "skipped",
        "path": None,
        "byte_count": 0,
        "record_count": None,
        "start_ts_ns": None,
        "end_ts_ns": None,
        "attempts": 0,
        "reused_existing": False,
        "error": reason,
    }


def _session_manifest_entry(
    *,
    session: SessionWindow,
    status: str,
    exclusion_reason: str | None,
    schemas: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    return {
        "session_id": session.session_id,
        "symbol": session.symbol,
        "status": status,
        "split": None,
        "rth_window": {
            "start_ts_ns": str(session.start_ts_ns),
            "end_ts_ns": str(session.end_ts_ns),
        },
        "definition_snapshot_window": {
            "start_ts_ns": str(_definition_window_ns(session)[0]),
            "end_ts_ns": str(_definition_window_ns(session)[1]),
        },
        "exclusion_reason": exclusion_reason,
        "schemas": schemas,
    }


def _session_exclusion_reason(session: SessionWindow, *, min_rth_hours: float) -> str | None:
    start = datetime_from_ns(session.start_ts_ns)
    end = datetime_from_ns(session.end_ts_ns)
    if not session.session_id.endswith("-rth"):
        return "non_rth_session_id"
    if start.weekday() >= 5:
        return "weekend_session"
    duration_hours = (session.end_ts_ns - session.start_ts_ns) / 3_600_000_000_000
    if duration_hours < min_rth_hours:
        return "short_or_half_day_session"
    if start.date() != end.date():
        return "maintenance_spanning_window"
    return None


def _definition_window_ns(session: SessionWindow) -> tuple[int, int]:
    start = datetime_from_ns(session.start_ts_ns)
    midnight = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    return timestamp_ns(midnight), timestamp_ns(midnight + timedelta(seconds=1))


def _deterministic_split(session_ids: list[str], *, validation_fraction: float) -> dict[str, str]:
    if not session_ids:
        return {}
    validation_count = max(1, int(len(session_ids) * validation_fraction + 0.999999))
    ranked = sorted(session_ids, key=lambda session_id: hashlib.sha256(session_id.encode("utf-8")).hexdigest())
    validation = set(ranked[:validation_count])
    return {
        session_id: "validation" if session_id in validation else "calibration"
        for session_id in session_ids
    }


def _manifest_blocked_reason(
    *,
    api_key_present: bool,
    dataset_range_error: str | None,
    complete_count: int,
    min_complete_sessions: int,
    partial_count: int,
) -> str | None:
    if not api_key_present:
        return "DATABENTO_API_KEY is not set"
    if dataset_range_error is not None:
        return f"dataset range unavailable: {dataset_range_error}"
    if partial_count > 0:
        return "one or more requested sessions are partial; inspect session schema errors"
    if complete_count < min_complete_sessions:
        return f"complete session count {complete_count} is below required minimum {min_complete_sessions}"
    return None


def parse_session_list(path: Path, *, default_symbol: str) -> tuple[SessionWindow, ...]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        raw = json.loads(text)
        items = raw.get("sessions", raw) if isinstance(raw, dict) else raw
    else:
        items = parse_simple_yaml_sessions(text)
    if not isinstance(items, list):
        raise ValueError("session list must be a list or object with sessions")
    sessions: list[SessionWindow] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("each session entry must be an object")
        session_id = _required_str(item, "session_id")
        start = _required_str(item, "start")
        end = _required_str(item, "end")
        symbol = str(item.get("symbol") or default_symbol)
        sessions.append(
            SessionWindow(
                session_id=session_id,
                start_ts_ns=parse_timestamp_ns(start),
                end_ts_ns=parse_timestamp_ns(end),
                symbol=symbol,
            )
        )
    return tuple(sessions)


def parse_simple_yaml_sessions(text: str) -> list[dict[str, str]]:
    sessions: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if line.strip() == "" or line.strip() == "sessions:":
            continue
        stripped = line.strip()
        if stripped.startswith("- "):
            if current is not None:
                sessions.append(current)
            current = {}
            remainder = stripped[2:].strip()
            if remainder:
                key, value = _split_yaml_key_value(remainder)
                current[key] = value
            continue
        if current is None:
            raise ValueError("unsupported YAML session list format")
        key, value = _split_yaml_key_value(stripped)
        current[key] = value
    if current is not None:
        sessions.append(current)
    return sessions


def _split_yaml_key_value(line: str) -> tuple[str, str]:
    if ":" not in line:
        raise ValueError(f"unsupported YAML line: {line}")
    key, value = line.split(":", 1)
    return key.strip(), value.strip().strip("\"'")


def _required_str(item: dict[str, Any], field: str) -> str:
    value = item.get(field)
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"session entry missing {field}")
    return value.strip()


def _fixture_schema(fixture: dict[str, Any], session_id: str, schema: str) -> dict[str, Any]:
    sessions = fixture.get("sessions")
    if isinstance(sessions, dict):
        session_fixture = sessions.get(session_id)
        if isinstance(session_fixture, dict):
            schemas = session_fixture.get("schemas")
            if isinstance(schemas, dict) and isinstance(schemas.get(schema), dict):
                return schemas[schema]
    schemas = fixture.get("schemas")
    if isinstance(schemas, dict) and isinstance(schemas.get(schema), dict):
        return schemas[schema]
    return {}


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
    return timestamp_ns(parsed_dt.astimezone(timezone.utc))


def datetime_from_ns(value: int) -> datetime:
    seconds, nanos = divmod(value, 1_000_000_000)
    return datetime.fromtimestamp(seconds, tz=timezone.utc).replace(microsecond=nanos // 1_000)


def timestamp_ns(value: datetime) -> int:
    utc = value.astimezone(timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = utc - epoch
    return (
        delta.days * 86_400_000_000_000
        + delta.seconds * 1_000_000_000
        + delta.microseconds * 1_000
    )


def load_fixture_client(path: Path) -> FixtureDatabentoFetchClient:
    return FixtureDatabentoFetchClient(json.loads(path.read_text(encoding="utf-8")))


class StrictArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(message)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = StrictArgumentParser(description="Fetch a Databento MNQ SIM-03 calibration corpus manifest.")
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL)
    parser.add_argument("--session-list", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--min-complete-sessions", type=int, default=DEFAULT_MIN_COMPLETE_SESSIONS)
    parser.add_argument("--validation-fraction", type=float, default=DEFAULT_VALIDATION_FRACTION)
    parser.add_argument("--min-rth-hours", type=float, default=DEFAULT_MIN_RTH_HOURS)
    parser.add_argument("--retry-attempts", type=int, default=DEFAULT_RETRY_ATTEMPTS)
    parser.add_argument("--retry-base-sec", type=float, default=DEFAULT_RETRY_BASE_SECONDS)
    parser.add_argument("--fixture", type=Path, help="Test-only fixture JSON; disables Databento network use")
    return parser.parse_args(argv)


def request_from_args(args: argparse.Namespace) -> FetchRequest:
    if args.min_complete_sessions <= 0:
        raise ValueError("--min-complete-sessions must be positive")
    if args.retry_attempts <= 0:
        raise ValueError("--retry-attempts must be positive")
    if args.retry_base_sec < 0:
        raise ValueError("--retry-base-sec must be non-negative")
    if not (0 < args.validation_fraction < 1):
        raise ValueError("--validation-fraction must be between 0 and 1")
    sessions = parse_session_list(args.session_list, default_symbol=str(args.symbol))
    if not sessions:
        raise ValueError("--session-list must contain at least one session")
    return FetchRequest(
        dataset=str(args.dataset),
        default_symbol=str(args.symbol),
        out_dir=args.out_dir,
        manifest_path=args.manifest,
        sessions=sessions,
        min_complete_sessions=int(args.min_complete_sessions),
        validation_fraction=float(args.validation_fraction),
        min_rth_hours=float(args.min_rth_hours),
        retry_attempts=int(args.retry_attempts),
        retry_base_seconds=float(args.retry_base_sec),
    )


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    request = request_from_args(args)
    api_key = os.environ.get("DATABENTO_API_KEY")
    api_key_present = bool(api_key)
    if args.fixture is not None:
        client: DatabentoFetchClientLike | None = load_fixture_client(args.fixture)
        api_key_present = bool(api_key) or bool(os.environ.get("SIM03A_FIXTURE_API_KEY_PRESENT", "1"))
    elif api_key_present:
        client = RealDatabentoFetchClient(str(api_key))
    else:
        client = None

    manifest = fetch_corpus(
        client=client,
        request=request,
        databento_api_key_present=api_key_present,
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0 if manifest["ready_for_sim03_model_fitting"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
