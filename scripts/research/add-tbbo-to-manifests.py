"""Update the Tier A archive manifests to include TBBO entries.

Reads the existing manifest-feb-2026.json and manifest-mar-2026.json files,
adds a `tbbo` entry to each complete session's `schemas` map (mirroring the
shape of the existing `trades` entry), and ensures `event_schemas` includes
`tbbo`. Writes back in-place.

Idempotent: re-running has no effect if tbbo entries already exist.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


ARCHIVE_ROOT = Path(r"D:/qfa-cache/databento/tier-a-feb-mar-2026")
MANIFEST_PATHS = [
    ARCHIVE_ROOT / "manifest-feb-2026.json",
    ARCHIVE_ROOT / "manifest-mar-2026.json",
]


def update_manifest(manifest_path: Path) -> int:
    with manifest_path.open("r", encoding="utf-8") as f:
        manifest = json.load(f)

    updated_sessions = 0
    skipped_missing_file = 0

    for session in manifest["sessions"]:
        if session.get("status") != "complete":
            continue

        session_id = session["session_id"]
        if "tbbo" in session["schemas"]:
            continue  # already added; idempotent

        tbbo_path = ARCHIVE_ROOT / session_id / "tbbo.dbn.zst"
        if not tbbo_path.exists():
            print(f"  MISSING tbbo for {session_id} (skipping)")
            skipped_missing_file += 1
            continue

        # Mirror the trades entry shape.
        trades_entry = session["schemas"].get("trades")
        if trades_entry is None:
            print(f"  WARN: no trades entry to mirror for {session_id}", file=sys.stderr)
            continue

        byte_count = tbbo_path.stat().st_size
        relative_path = str(tbbo_path).replace("\\", "/")

        session["schemas"]["tbbo"] = {
            "schema": "tbbo",
            "status": "available",
            "path": relative_path,
            "start_ts_ns": trades_entry.get("start_ts_ns"),
            "end_ts_ns": trades_entry.get("end_ts_ns"),
            "byte_count": byte_count,
            "record_count": None,
            "reused_existing": False,
            "attempts": 1,
        }
        updated_sessions += 1

    if "tbbo" not in manifest["event_schemas"]:
        manifest["event_schemas"].append("tbbo")
        manifest["event_schemas"].sort()

    with manifest_path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"{manifest_path.name}: updated {updated_sessions} sessions, {skipped_missing_file} missing files")
    return updated_sessions


def main() -> int:
    total_updated = 0
    for manifest_path in MANIFEST_PATHS:
        if not manifest_path.exists():
            print(f"MISSING manifest: {manifest_path}", file=sys.stderr)
            return 1
        total_updated += update_manifest(manifest_path)

    print()
    print(f"Total sessions updated: {total_updated}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
