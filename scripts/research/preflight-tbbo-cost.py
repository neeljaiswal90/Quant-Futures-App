"""Cost preview for adding TBBO schema to the Tier A Feb-Mar 2026 archive.

Reads existing manifest JSON files to determine the exact session list, symbols,
and RTH windows. Calls Databento metadata.get_cost() per session to estimate
spend. Does NOT fetch any data.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import databento as db


ARCHIVE_ROOT = Path(r"D:/qfa-cache/databento/tier-a-feb-mar-2026")
MANIFEST_PATHS = [
    ARCHIVE_ROOT / "manifest-feb-2026.json",
    ARCHIVE_ROOT / "manifest-mar-2026.json",
]


def ts_ns_to_iso(ts_ns: str | int) -> str:
    """Convert a nanosecond integer string to ISO 8601 UTC."""
    if isinstance(ts_ns, str):
        ts_ns = int(ts_ns)
    seconds = ts_ns / 1_000_000_000
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> int:
    api_key = os.environ.get("DATABENTO_API_KEY")
    if not api_key:
        print("ERROR: DATABENTO_API_KEY not set", file=sys.stderr)
        return 1

    client = db.Historical(api_key)
    total_cost = 0.0
    session_count = 0

    for manifest_path in MANIFEST_PATHS:
        if not manifest_path.exists():
            print(f"MISSING manifest: {manifest_path}", file=sys.stderr)
            return 1

        with manifest_path.open("r", encoding="utf-8") as f:
            manifest = json.load(f)

        for session in manifest["sessions"]:
            if session.get("status") != "complete":
                continue
            symbol = session["symbol"]
            rth = session["rth_window"]
            start = ts_ns_to_iso(rth["start_ts_ns"])
            end = ts_ns_to_iso(rth["end_ts_ns"])

            try:
                cost = client.metadata.get_cost(
                    dataset=manifest["dataset"],
                    symbols=[symbol],
                    schema="tbbo",
                    start=start,
                    end=end,
                    stype_in="raw_symbol",
                )
            except Exception as exc:
                print(f"FAIL {session['session_id']} {symbol}: {exc}", file=sys.stderr)
                return 1

            total_cost += float(cost)
            session_count += 1
            print(f"  {session['session_id']:<20} {symbol:<6} ${float(cost):.4f}")

    print()
    print(f"Sessions previewed: {session_count}")
    print(f"TOTAL ESTIMATED COST: ${total_cost:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
