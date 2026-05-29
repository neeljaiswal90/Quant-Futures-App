"""Tests for ``rithmic_analytics.ops.rollover_calendar``."""

from __future__ import annotations

import dataclasses
from datetime import date

import pytest

from rithmic_analytics.ops.rollover_calendar import (
    RolloverCalendarMiss,
    RolloverEntry,
    resolve_front_month,
)


def test_today_2026_05_15_resolves_mnqm6() -> None:
    # Today (project kickoff date). MNQM6 is the active front-month between
    # 2026-03-13 and 2026-06-11.
    assert resolve_front_month("MNQ", date(2026, 5, 15)) == "MNQM6"


def test_day_after_rollover_resolves_new_contract() -> None:
    assert resolve_front_month("MNQ", date(2026, 6, 13)) == "MNQU6"


def test_rollover_date_itself_inclusive() -> None:
    # The rollover date is the FIRST date the new contract is front-month —
    # inclusive boundary, not exclusive.
    assert resolve_front_month("MNQ", date(2026, 6, 12)) == "MNQU6"


def test_one_day_before_rollover_still_prev() -> None:
    assert resolve_front_month("MNQ", date(2026, 6, 11)) == "MNQM6"


def test_late_2026_resolves_mnqz6() -> None:
    assert resolve_front_month("MNQ", date(2026, 10, 1)) == "MNQZ6"


def test_2027_resolves_correctly_across_year_boundary() -> None:
    assert resolve_front_month("MNQ", date(2027, 1, 15)) == "MNQH7"
    assert resolve_front_month("MNQ", date(2027, 5, 1)) == "MNQM7"


def test_unsupported_root_raises_value_error() -> None:
    with pytest.raises(ValueError, match="unsupported root symbol"):
        resolve_front_month("ES", date(2026, 5, 15))


def test_before_calendar_start_raises_with_helpful_message() -> None:
    with pytest.raises(RolloverCalendarMiss) as excinfo:
        resolve_front_month("MNQ", date(2025, 1, 1))
    msg = str(excinfo.value)
    # Operator-friendly diagnostics: which way to extend.
    assert "2026-03-13" in msg  # the first entry's date
    assert "MNQM6" in msg
    assert "extend" in msg.lower()


def test_after_calendar_end_raises_with_helpful_message() -> None:
    # Past 2028-03-17 (MNQH8's expiry) the calendar is exhausted.
    with pytest.raises(RolloverCalendarMiss) as excinfo:
        resolve_front_month("MNQ", date(2030, 1, 1))
    msg = str(excinfo.value)
    assert "MNQH8" in msg  # the last entry
    assert "expired" in msg.lower()
    assert "extend" in msg.lower()


def test_rollover_entry_is_frozen() -> None:
    entry = RolloverEntry(date(2026, 3, 13), "MNQM6", date(2026, 6, 19))
    with pytest.raises(dataclasses.FrozenInstanceError):
        entry.contract = "MNQU6"  # type: ignore[misc]
