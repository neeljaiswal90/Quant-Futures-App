#!/usr/bin/env python3
"""Build the MOC-R1 event-anchor calendar and day-classification manifest.

This is a research-tier scratch artifact builder. It reads the local
Databento SIM-03 corpus and committed research context, then writes only under
scratch/moc-research/.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
import json
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_ROOT = Path("data/databento/sim03_corpus")
OUTPUT_PATH = Path("scratch/moc-research/event-day-manifest.json")
NY = ZoneInfo("America/New_York")

NS_PER_SECOND = 1_000_000_000
NS_PER_MINUTE = 60 * NS_PER_SECOND
I0_OFFSET_NS = 10 * NS_PER_MINUTE
EVENT_WINDOW_SECONDS = 300

GENERATED_AT_NOTE = "Deterministic MOC-R1 manifest; no wall-clock timestamp emitted."
DAY_CLASS_VALUES = ("full", "half", "holiday_observed")


@dataclass(frozen=True)
class CatalogDay:
    day_class: str
    is_half_day: bool
    cash_close_et: str
    data_present_expected: bool
    notes: tuple[str, ...]


@dataclass(frozen=True)
class MacroEvent:
    category: str
    event_time_et: str
    note: str


# Operator-authority catalog from the MOC-R1 PRE-FLIGHT MATERIALS.
HALF_DAY_CATALOG: dict[str, CatalogDay] = {}
HOLIDAY_OBSERVED_CATALOG: dict[str, CatalogDay] = {
    "2026-02-16": CatalogDay(
        day_class="holiday_observed",
        is_half_day=False,
        cash_close_et="16:00",
        data_present_expected=False,
        notes=("Presidents Day full closure; outside current sim03_corpus range.",),
    ),
    "2026-04-03": CatalogDay(
        day_class="holiday_observed",
        is_half_day=False,
        cash_close_et="16:00",
        data_present_expected=False,
        notes=(
            "Good Friday full closure; corpus is expected to omit the RTH session.",
            "Nominal C0/I0 anchors are retained for calendar alignment only.",
        ),
    ),
}
OPERATOR_MACRO_CATALOG: dict[str, tuple[MacroEvent, ...]] = {
    "2026-02-06": (MacroEvent("nfp", "08:30", "NFP release; outside current sim03_corpus range."),),
    "2026-03-06": (MacroEvent("nfp", "08:30", "NFP release; outside current sim03_corpus range."),),
    "2026-03-18": (MacroEvent("fomc", "14:00", "FOMC decision day."),),
    "2026-04-03": (MacroEvent("nfp", "08:30", "NFP release on Good Friday full-closure day."),),
    "2026-04-29": (MacroEvent("fomc", "14:00", "FOMC decision day if present in corpus range."),),
}


def main() -> int:
    manifest = build_manifest()
    write_canonical_json(manifest, REPO_ROOT / OUTPUT_PATH)
    return 0


def build_manifest() -> dict[str, Any]:
    corpus_path = REPO_ROOT / CORPUS_ROOT
    if not corpus_path.exists():
        raise FileNotFoundError(f"missing corpus root: {corpus_path}")
    corpus_dates = corpus_session_dates(corpus_path)
    if not corpus_dates:
        raise RuntimeError(f"no corpus sessions found under {corpus_path}")
    labels_by_session = load_regime_labels(REPO_ROOT / "artifacts/regime/regime-labels.json")

    start = min(corpus_dates)
    end = max(corpus_dates)
    calendar_dates = sorted(set(corpus_dates) | observed_holidays_in_range(start, end))
    sessions = [
        build_session_record(session_date, corpus_path, labels_by_session)
        for session_date in calendar_dates
    ]

    data_present_count = sum(1 for session in sessions if session["data_present"] is True)
    if data_present_count != len(corpus_dates):
        raise RuntimeError(f"corpus count mismatch: manifest={data_present_count} corpus={len(corpus_dates)}")

    return {
        "calendar_policy": {
            "day_class_values": list(DAY_CLASS_VALUES),
            "half_day_catalog": [],
            "holiday_observed_catalog": sorted(HOLIDAY_OBSERVED_CATALOG),
            "macro_policy": (
                "day_class is reserved for market-session classification; macro annotations live in "
                "is_macro_day, macro_event_categories, macro_event_offset_minutes, and event_notes."
            ),
            "schema_note": (
                "day_class MUST be one of full, half, holiday_observed; no macro categories are encoded "
                "in day_class."
            ),
        },
        "corpus_root": "data/databento/sim03_corpus/",
        "corpus_session_count": len(corpus_dates),
        "generated_at_note": GENERATED_AT_NOTE,
        "manifest_session_count": len(sessions),
        "schema_version": 1,
        "sessions": sessions,
    }


def build_session_record(
    session_date: date,
    corpus_path: Path,
    labels_by_session: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    session_date_text = session_date.isoformat()
    session_dir = corpus_path / f"{session_date_text}-rth"
    data_present = session_has_data(session_dir)
    holiday = HOLIDAY_OBSERVED_CATALOG.get(session_date_text)
    half_day = HALF_DAY_CATALOG.get(session_date_text)
    if holiday is not None:
        catalog = holiday
    elif half_day is not None:
        catalog = half_day
    else:
        catalog = CatalogDay(
            day_class="full",
            is_half_day=False,
            cash_close_et="16:00",
            data_present_expected=True,
            notes=(),
        )
    if catalog.day_class not in DAY_CLASS_VALUES:
        raise ValueError(f"invalid day_class {catalog.day_class} for {session_date_text}")
    if catalog.day_class == "holiday_observed" and data_present:
        raise RuntimeError(f"holiday-observed date has data present: {session_date_text}")

    c0 = datetime.combine(session_date, parse_hhmm(catalog.cash_close_et), NY)
    c0_ns = unix_ns(c0)
    i0_ns = c0_ns - I0_OFFSET_NS
    event_window_end_ns = i0_ns + EVENT_WINDOW_SECONDS * NS_PER_SECOND

    macro_events = OPERATOR_MACRO_CATALOG.get(session_date_text, ())
    macro_categories = sorted({event.category for event in macro_events})
    macro_offsets = [
        offset_minutes_from_i0(session_date, event.event_time_et, i0_ns)
        for event in macro_events
    ]
    macro_event_offset_minutes: int | None
    if len(macro_offsets) == 0:
        macro_event_offset_minutes = None
    elif len(macro_offsets) == 1:
        macro_event_offset_minutes = macro_offsets[0]
    else:
        macro_event_offset_minutes = min(macro_offsets, key=abs)

    session_id = f"{session_date_text}-rth"
    label = labels_by_session.get(session_id, {})
    primary_percentile = label.get("primary_percentile")
    event_notes = list(catalog.notes)
    for event, offset in zip(macro_events, macro_offsets):
        event_notes.append(f"{event.note} Offset from I0: {offset} minutes.")

    return {
        "cash_close_et": catalog.cash_close_et,
        "cash_close_ts_ns_c0": c0_ns,
        "cash_open_et": None if catalog.day_class == "holiday_observed" else "09:30",
        "c0_ts_ns": c0_ns,
        "data_present": data_present,
        "day_class": catalog.day_class,
        "day_of_week": day_name(session_date),
        "early_close_reason": "operator_catalog_half_day" if catalog.is_half_day else None,
        "event_notes": event_notes,
        "event_window_end_ts_ns": event_window_end_ns,
        "front_month_contract": active_contract_for_date(session_date),
        "i0_ts_ns": i0_ns,
        "imbalance_anchor_ts_ns_i0": i0_ns,
        "is_friday": session_date.weekday() == 4,
        "is_half_day": catalog.is_half_day,
        "is_macro_day": len(macro_events) > 0,
        "is_month_end": is_last_business_day_of_month(session_date),
        "is_quarter_end": is_last_business_day_of_quarter(session_date),
        "is_roll_block": False,
        "is_roll_week": False,
        "is_rth": catalog.day_class != "holiday_observed",
        "is_triple_witching": is_triple_witching(session_date),
        "macro_event_categories": macro_categories,
        "macro_event_offset_minutes": macro_event_offset_minutes,
        "regime_label": label.get("confirmed_label"),
        "session_date": session_date_text,
        "session_date_et": session_date_text,
        "vix_quartile": vix_quartile(primary_percentile),
    }


def corpus_session_dates(corpus_path: Path) -> list[date]:
    dates: list[date] = []
    for child in corpus_path.iterdir():
        if not child.is_dir() or not child.name.endswith("-rth"):
            continue
        dates.append(date.fromisoformat(child.name.removesuffix("-rth")))
    return sorted(dates)


def observed_holidays_in_range(start: date, end: date) -> set[date]:
    holidays = {date.fromisoformat(value) for value in HOLIDAY_OBSERVED_CATALOG}
    return {value for value in holidays if start <= value <= end}


def session_has_data(session_dir: Path) -> bool:
    if not session_dir.exists() or not session_dir.is_dir():
        return False
    return any(child.is_file() and child.stat().st_size > 0 for child in session_dir.iterdir())


def load_regime_labels(path: Path) -> dict[str, dict[str, Any]]:
    artifact = json.loads(path.read_text(encoding="utf-8"))
    labels = artifact.get("labels")
    if not isinstance(labels, list):
        return {}
    return {
        str(row["session_id"]): row
        for row in labels
        if isinstance(row, dict) and "session_id" in row
    }


def active_contract_for_date(session_date: date) -> str:
    # The committed roll calendar's first configured cutover is June 12, 2026
    # (MNQM6 -> MNQU6). All current sim03_corpus sessions are before that.
    if session_date < date(2026, 6, 12):
        return "MNQM6"
    if session_date < date(2026, 9, 11):
        return "MNQU6"
    return "MNQZ6"


def parse_hhmm(value: str) -> time:
    hour, minute = value.split(":", 1)
    return time(int(hour), int(minute))


def unix_ns(value: datetime) -> int:
    return int(value.astimezone(timezone.utc).timestamp() * NS_PER_SECOND)


def offset_minutes_from_i0(session_date: date, event_time_et: str, i0_ns: int) -> int:
    event_dt = datetime.combine(session_date, parse_hhmm(event_time_et), NY)
    return int((unix_ns(event_dt) - i0_ns) // NS_PER_MINUTE)


def day_name(value: date) -> str:
    return ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[value.weekday()]


def is_last_business_day_of_month(value: date) -> bool:
    probe = value + timedelta(days=1)
    while probe.month == value.month:
        if probe.weekday() < 5 and probe.isoformat() not in HOLIDAY_OBSERVED_CATALOG:
            return False
        probe += timedelta(days=1)
    return value.weekday() < 5


def is_last_business_day_of_quarter(value: date) -> bool:
    return value.month in (3, 6, 9, 12) and is_last_business_day_of_month(value)


def is_triple_witching(value: date) -> bool:
    if value.month not in (3, 6, 9, 12) or value.weekday() != 4:
        return False
    first = value.replace(day=1)
    first_friday_offset = (4 - first.weekday()) % 7
    third_friday = first + timedelta(days=first_friday_offset + 14)
    return value == third_friday


def vix_quartile(primary_percentile: Any) -> str | None:
    if not isinstance(primary_percentile, (int, float)):
        return None
    if primary_percentile <= 0.25:
        return "Q1_low"
    if primary_percentile <= 0.5:
        return "Q2"
    if primary_percentile <= 0.75:
        return "Q3"
    return "Q4_high"


def write_canonical_json(value: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    path.write_bytes((payload + "\n").encode("utf-8"))


if __name__ == "__main__":
    raise SystemExit(main())
