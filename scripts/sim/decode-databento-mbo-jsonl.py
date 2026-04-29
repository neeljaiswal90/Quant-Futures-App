#!/usr/bin/env python
"""SIM-03J Databento MBO DBN decoder.

This narrow helper reuses the same Databento DBNStore reader path and chunk
size used by the SIM-03 calibrator, then emits only the MBO fields consumed by
SIM-03I's targeted limit_queue:front observation exporter.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable


DBN_CHUNK_RECORDS = 100_000
SUPPORTED_SCHEMA = "mbo"
OUTPUT_FIELDS = ("ts_event", "order_id", "action", "price", "size", "side")


def decode_mbo_dbn_to_jsonl(
    *,
    input_path: Path,
    out_path: Path,
    schema: str = SUPPORTED_SCHEMA,
    max_records: int | None = None,
    progress_every_records: int = 1_000_000,
) -> dict[str, Any]:
    if schema != SUPPORTED_SCHEMA:
        raise ValueError("--schema must be mbo")
    if max_records is not None and max_records <= 0:
        raise ValueError("--max-records must be positive")
    if progress_every_records <= 0:
        raise ValueError("--progress-every-records must be positive")

    try:
        import databento as db  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001 - operator-facing setup guidance belongs in stderr.
        raise RuntimeError(
            "databento Python package is required to decode DBN/ZST MBO files; "
            "install the project runtime dependencies before running SIM-03J"
        ) from exc

    out_path.parent.mkdir(parents=True, exist_ok=True)
    decoded_count = 0
    store = db.DBNStore.from_file(input_path)
    with out_path.open("w", encoding="utf-8") as handle:
        for chunk in store.to_ndarray(schema=schema, count=DBN_CHUNK_RECORDS):
            names = set(chunk.dtype.names or ())
            for row in chunk:
                if max_records is not None and decoded_count >= max_records:
                    return _summary(input_path, out_path, decoded_count)
                payload = _normalize_row(row, names)
                if payload is None:
                    continue
                handle.write(json.dumps(payload, sort_keys=True) + "\n")
                decoded_count += 1
                if progress_every_records > 0 and decoded_count % progress_every_records == 0:
                    print(
                        json.dumps(
                            {
                                "event_type": "dbn_records_decoded",
                                "input": str(input_path),
                                "records_decoded": decoded_count,
                            },
                            sort_keys=True,
                        ),
                        file=sys.stderr,
                    )
    return _summary(input_path, out_path, decoded_count)


def _normalize_row(row: Any, names: set[str]) -> dict[str, Any] | None:
    payload: dict[str, Any] = {}
    for field in OUTPUT_FIELDS:
        if field not in names:
            return None
        payload[field] = _json_safe(row[field])
    return payload


def _json_safe(value: Any) -> Any:
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, bytes):
        return value.decode("ascii")
    if isinstance(value, bytearray):
        return bytes(value).decode("ascii")
    return value


def _summary(input_path: Path, out_path: Path, decoded_count: int) -> dict[str, Any]:
    return {
        "decoder_schema_version": 1,
        "ticket_id": "SIM-03J",
        "status": "decoded",
        "schema": SUPPORTED_SCHEMA,
        "input": str(input_path),
        "out": str(out_path),
        "records_decoded": decoded_count,
        "scope_note": (
            "SIM-03J decodes local Databento MBO DBN files to the compact JSONL "
            "shape consumed by SIM-03I. It performs no network calls and does not "
            "change calibration thresholds or REL gates."
        ),
    }


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Decode Databento MBO DBN/ZST to SIM-03I JSONL rows.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--schema", default=SUPPORTED_SCHEMA)
    parser.add_argument("--max-records", type=int)
    parser.add_argument("--progress-every-records", type=int, default=1_000_000)
    return parser.parse_args(list(argv))


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    summary = decode_mbo_dbn_to_jsonl(
        input_path=args.input,
        out_path=args.out,
        schema=str(args.schema),
        max_records=args.max_records,
        progress_every_records=int(args.progress_every_records),
    )
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
