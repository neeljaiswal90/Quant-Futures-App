#!/usr/bin/env python3
"""Sanity checks for the MOC-R1 event-day manifest."""

from __future__ import annotations

import json
import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPO_ROOT / "scratch/moc-research/event-day-manifest.json"
CORPUS_ROOT = REPO_ROOT / "data/databento/sim03_corpus"
DAY_CLASSES = {"full", "half", "holiday_observed"}
I0_DELTA_NS = 600_000_000_000


def main() -> int:
    manifest_text = MANIFEST_PATH.read_text(encoding="utf-8")
    if re.search(r"T[0-9]{2}:[0-9]{2}:[0-9]{2}", manifest_text):
        raise AssertionError("manifest contains a wall-clock timestamp shape")
    manifest = json.loads(manifest_text)
    sessions = manifest["sessions"]
    corpus_count = len([path for path in CORPUS_ROOT.iterdir() if path.is_dir() and path.name.endswith("-rth")])
    if manifest["corpus_session_count"] != corpus_count:
        raise AssertionError("corpus_session_count mismatch")
    data_present_count = sum(1 for row in sessions if row["data_present"] is True)
    if data_present_count != corpus_count:
        raise AssertionError("data_present row count mismatch")
    if manifest["manifest_session_count"] != len(sessions):
        raise AssertionError("manifest_session_count mismatch")
    for row in sessions:
        if row["day_class"] not in DAY_CLASSES:
            raise AssertionError(f"invalid day_class: {row['day_class']}")
        if row["c0_ts_ns"] - row["i0_ts_ns"] != I0_DELTA_NS:
            raise AssertionError(f"C0/I0 invariant failed for {row['session_date_et']}")
        if row["cash_close_ts_ns_c0"] != row["c0_ts_ns"]:
            raise AssertionError(f"C0 alias mismatch for {row['session_date_et']}")
        if row["imbalance_anchor_ts_ns_i0"] != row["i0_ts_ns"]:
            raise AssertionError(f"I0 alias mismatch for {row['session_date_et']}")
        if row["is_half_day"] is True and row["day_class"] != "half":
            raise AssertionError(f"half-day/day_class mismatch for {row['session_date_et']}")
        if row["day_class"] == "full" and row["is_half_day"] is True:
            raise AssertionError(f"full day marked half-day for {row['session_date_et']}")
        if row["day_class"] == "holiday_observed" and row["data_present"] is not False:
            raise AssertionError(f"holiday row has data_present=true for {row['session_date_et']}")
    good_friday = [row for row in sessions if row["session_date_et"] == "2026-04-03"]
    if len(good_friday) != 1 or good_friday[0]["day_class"] != "holiday_observed":
        raise AssertionError("Good Friday holiday row missing or misclassified")
    fomc = [row for row in sessions if row["session_date_et"] == "2026-03-18"]
    if len(fomc) != 1 or fomc[0]["macro_event_categories"] != ["fomc"]:
        raise AssertionError("FOMC row missing or misclassified")
    print("MOC-R1 manifest sanity checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
