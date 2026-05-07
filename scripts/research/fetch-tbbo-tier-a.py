"""Fetch TBBO schema for the Tier A Feb-Mar 2026 archive.

Reads existing manifest JSON files for the session list, symbols, and RTH
windows. Fetches TBBO via the Databento Python SDK and writes one
tbbo.dbn.zst file per session into the existing session directory.

Idempotent: skips sessions that already have tbbo.dbn.zst.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import databento as db
import zstandard as zstd


ARCHIVE_ROOT = Path(r"D:/qfa-cache/databento/tier-a-feb-mar-2026")
MANIFEST_PATHS = [
    ARCHIVE_ROOT / "manifest-feb-2026.json",
    ARCHIVE_ROOT / "manifest-mar-2026.json",
]


def ts_ns_to_iso(ts_ns: str | int) -> str:
    if isinstance(ts_ns, str):
        ts_ns = int(ts_ns)
    seconds = ts_ns / 1_000_000_000
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def fetch_session_tbbo(
    client: db.Historical,
    dataset: str,
    session: dict,
) -> Path | None:
    session_id = session["session_id"]
    session_dir = ARCHIVE_ROOT / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    out_path = session_dir / "tbbo.dbn.zst"

    if out_path.exists():
        size = out_path.stat().st_size
        print(f"SKIP existing {session_id}: tbbo.dbn.zst ({size:,} bytes)")
        return out_path

    symbol = session["symbol"]
    rth = session["rth_window"]
    start = ts_ns_to_iso(rth["start_ts_ns"])
    end = ts_ns_to_iso(rth["end_ts_ns"])

    print(f"FETCH {session_id} {symbol}: {start} -> {end}")

    data = client.timeseries.get_range(
        dataset=dataset,
        symbols=[symbol],
        schema="tbbo",
        start=start,
        end=end,
        stype_in="raw_symbol",
    )

    # Materialize raw DBN bytes, then compress with zstd to match
    # the existing archive's .dbn.zst convention.
    raw_path = session_dir / "tbbo.dbn"
    data.to_file(str(raw_path))

    with raw_path.open("rb") as fin:
        raw_bytes = fin.read()

    compressor = zstd.ZstdCompressor(level=3)
    compressed_bytes = compressor.compress(raw_bytes)

    with out_path.open("wb") as fout:
        fout.write(compressed_bytes)

    raw_path.unlink()  # remove uncompressed intermediate

    print(f"  wrote {out_path} ({out_path.stat().st_size:,} bytes)")
    return out_path


def main() -> int:
    api_key = os.environ.get("DATABENTO_API_KEY")
    if not api_key:
        print("ERROR: DATABENTO_API_KEY not set", file=sys.stderr)
        return 1

    client = db.Historical(api_key)
    fetched = 0
    skipped = 0
    failed = 0

    for manifest_path in MANIFEST_PATHS:
        if not manifest_path.exists():
            print(f"MISSING manifest: {manifest_path}", file=sys.stderr)
            return 1

        with manifest_path.open("r", encoding="utf-8") as f:
            manifest = json.load(f)

        dataset = manifest["dataset"]

        for session in manifest["sessions"]:
            if session.get("status") != "complete":
                continue

            try:
                out_path = fetch_session_tbbo(client, dataset, session)
                if out_path is not None:
                    if out_path.stat().st_size > 0:
                        fetched += 1
                    else:
                        skipped += 1
            except Exception as exc:
                print(f"FAIL {session['session_id']}: {exc}", file=sys.stderr)
                failed += 1

    print()
    print(f"Total: fetched_or_present={fetched}, skipped_or_empty={skipped}, failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
