#!/usr/bin/env python
"""Fetch and normalize the FRED VIXCLS daily close series for QFA-110."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any


FRED_ENDPOINT = "https://api.stlouisfed.org/fred/series/observations"
MANIFEST_SCHEMA_VERSION = 1
SOURCE = "FRED"
SERIES_ID = "VIXCLS"
DEFAULT_START = "1990-01-02"
MISSING_SENTINELS = {".", "", " "}


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    out_path = Path(args.out)

    if out_path.exists() and not args.force:
        print(
            json.dumps(
                {
                    "status": "skipped",
                    "reason": "output exists; pass --force to refresh",
                    "out": str(out_path),
                },
                indent=2,
                sort_keys=True,
            ),
        )
        return 0

    api_key = read_fred_api_key()
    if api_key is None:
        print(
            "error: FRED_API_KEY is not set in the environment or repo-root .env",
            file=sys.stderr,
        )
        return 1

    fetch_timestamp_ns = time.time_ns()
    try:
        payload = fetch_fred_payload(
            api_key=api_key,
            start=args.start,
            end=args.end,
        )
        output = build_vix_series(
            payload=payload,
            fetch_timestamp_ns=fetch_timestamp_ns,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except urllib.error.HTTPError as exc:
        print(f"error: FRED HTTP {exc.code}: {safe_http_error(exc)}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"error: FRED request failed: {exc.reason}", file=sys.stderr)
        return 1

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "status": "fetched",
                "out": str(out_path),
                "record_count": output["record_count"],
                "start_date": output["start_date"],
                "end_date": output["end_date"],
                "missing_count": output["missing_count"],
                "sha256": output["sha256"],
            },
            indent=2,
            sort_keys=True,
        ),
    )
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch FRED VIXCLS into normalized JSON.")
    parser.add_argument("--start", default=DEFAULT_START, help="Observation start date, YYYY-MM-DD.")
    parser.add_argument("--end", default=date.today().isoformat(), help="Observation end date, YYYY-MM-DD.")
    parser.add_argument("--out", required=True, help="Output JSON path.")
    parser.add_argument("--force", action="store_true", help="Refresh even when --out already exists.")
    args = parser.parse_args(argv)
    validate_iso_date(args.start, "--start")
    validate_iso_date(args.end, "--end")
    if args.end < args.start:
        raise SystemExit("error: --end must be on or after --start")
    return args


def read_fred_api_key() -> str | None:
    value = os.environ.get("FRED_API_KEY")
    if value is not None and value.strip():
        return value.strip()

    env_path = Path.cwd() / ".env"
    if not env_path.exists():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].strip()
        if not stripped.startswith("FRED_API_KEY"):
            continue
        key, separator, raw_value = stripped.partition("=")
        if separator != "" and key.strip() == "FRED_API_KEY":
            unquoted = raw_value.strip().strip('"').strip("'")
            return unquoted or None
    return None


def fetch_fred_payload(*, api_key: str, start: str, end: str) -> dict[str, Any]:
    query = urllib.parse.urlencode(
        {
            "series_id": SERIES_ID,
            "api_key": api_key,
            "file_type": "json",
            "observation_start": start,
            "observation_end": end,
        },
    )
    request = urllib.request.Request(f"{FRED_ENDPOINT}?{query}", headers={"User-Agent": "qfa-vix-fetcher/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read().decode("utf-8")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError(f"FRED returned malformed JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("FRED response must be a JSON object")
    if "error_code" in payload:
        raise ValueError(f"FRED error {payload.get('error_code')}: {payload.get('error_message')}")
    return payload


def build_vix_series(*, payload: dict[str, Any], fetch_timestamp_ns: int) -> dict[str, Any]:
    raw_observations = payload.get("observations")
    if not isinstance(raw_observations, list) or len(raw_observations) == 0:
        raise ValueError("FRED response missing non-empty observations array")

    observations = [normalize_observation(item, index) for index, item in enumerate(raw_observations)]
    observations.sort(key=lambda item: item["date"])
    missing_count = sum(1 for item in observations if item["value"] is None)
    series_hash = hash_observations(observations)

    return {
        "manifest_schema_version": MANIFEST_SCHEMA_VERSION,
        "source": SOURCE,
        "series_id": SERIES_ID,
        "fetch_timestamp_ns": fetch_timestamp_ns,
        "start_date": observations[0]["date"],
        "end_date": observations[-1]["date"],
        "record_count": len(observations),
        "has_missing": missing_count > 0,
        "missing_count": missing_count,
        "sha256": series_hash,
        "observations": observations,
    }


def normalize_observation(value: Any, index: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"observations[{index}] must be an object")
    raw_date = value.get("date")
    if not isinstance(raw_date, str):
        raise ValueError(f"observations[{index}].date is missing or invalid")
    validate_iso_date(raw_date, f"observations[{index}].date")

    raw_value = value.get("value")
    if not isinstance(raw_value, str):
        raise ValueError(f"observations[{index}].value is missing or invalid")
    stripped_value = raw_value.strip()
    if stripped_value in MISSING_SENTINELS:
        normalized_value: float | int | None = None
    else:
        try:
            parsed = float(stripped_value)
        except ValueError as exc:
            raise ValueError(f"observations[{index}].value is not numeric or missing sentinel") from exc
        normalized_value = int(parsed) if parsed.is_integer() else parsed
    return {"date": raw_date, "value": normalized_value}


def hash_observations(observations: list[dict[str, Any]]) -> str:
    canonical = json.dumps(
        observations,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def validate_iso_date(value: str, label: str) -> None:
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{label} must be YYYY-MM-DD") from exc


def safe_http_error(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8").strip()
    except Exception:  # noqa: BLE001 - best-effort provider error context.
        return exc.reason


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
