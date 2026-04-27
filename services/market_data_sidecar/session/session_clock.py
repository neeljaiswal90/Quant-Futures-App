"""Deterministic MNQ session clock helpers for DATA-01A/DATA-06A.

All decisions are derived from caller-provided ``exchange_event_ts_ns`` values. This
module does not read wall-clock time.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

from services.market_data_sidecar.config import DATA01A_PARTIAL_PARITY_STATUS

SessionPhase = Literal["rth", "eth", "maintenance", "closed"]
SessionBlockReason = Literal["outside_rth", "maintenance_halt", "session_closed", "warmup_suppression"]

NS_PER_SECOND = 1_000_000_000
DEFAULT_SESSION_CALENDAR_PATH = Path("config/session/mnq-session-calendar.yaml")
DEFAULT_WARMUP_SECONDS = 60


@dataclass(frozen=True)
class MnqSessionCalendar:
    instrument_root: str
    exchange: str
    timezone_name: str
    rth_start: time
    rth_end: time
    eth_start: time
    eth_end: time
    maintenance_start: time
    maintenance_end: time
    trading_day_roll_time: time
    overrides: dict[str, dict[str, str]]


@dataclass(frozen=True)
class WarmupPolicy:
    warmup_seconds: int = DEFAULT_WARMUP_SECONDS


@dataclass(frozen=True)
class SessionEvaluation:
    exchange_event_ts_ns: str
    session_phase: SessionPhase
    journal_phase: SessionPhase
    trading_date: str
    session_id: str
    candidate_eligible: bool
    warmup_suppressed: bool
    block_reason: SessionBlockReason | None
    warmup_until_ts_ns: str | None
    partial_parity_status: str


def validate_session_id(session_id: str) -> str:
    cleaned = session_id.strip()
    if cleaned == "":
        raise ValueError("session_id must be non-empty")
    return cleaned


def load_mnq_session_calendar(path: Path = DEFAULT_SESSION_CALENDAR_PATH) -> MnqSessionCalendar:
    """Load the strict-subset MNQ session calendar YAML used by MNQ-01."""

    raw = _parse_simple_yaml(path)
    overrides_raw = raw.get("overrides", {})
    if not isinstance(overrides_raw, dict):
        overrides_raw = {}
    return MnqSessionCalendar(
        instrument_root=_required_string(raw, "instrument_root"),
        exchange=_required_string(raw, "exchange"),
        timezone_name=_required_string(raw, "timezone"),
        rth_start=_parse_clock(_required_nested_string(raw, "rth", "start_time")),
        rth_end=_parse_clock(_required_nested_string(raw, "rth", "end_time")),
        eth_start=_parse_clock(_required_nested_string(raw, "eth", "start_time")),
        eth_end=_parse_clock(_required_nested_string(raw, "eth", "end_time")),
        maintenance_start=_parse_clock(_required_nested_string(raw, "maintenance", "start_time")),
        maintenance_end=_parse_clock(_required_nested_string(raw, "maintenance", "end_time")),
        trading_day_roll_time=_parse_clock(_required_nested_string(raw, "eth", "trading_day_roll_time")),
        overrides={
            str(key): {str(inner_key): str(inner_value) for inner_key, inner_value in value.items()}
            for key, value in overrides_raw.items()
            if isinstance(value, dict)
        },
    )


def evaluate_mnq_session(
    exchange_event_ts_ns: str,
    *,
    calendar: MnqSessionCalendar | None = None,
    warmup_policy: WarmupPolicy | None = None,
) -> SessionEvaluation:
    """Classify one exchange timestamp for V1 RTH-only candidate eligibility."""

    active_calendar = calendar or load_mnq_session_calendar()
    active_policy = warmup_policy or WarmupPolicy()
    timestamp_ns = _parse_decimal_ns(exchange_event_ts_ns)
    local_dt = _ns_to_local_datetime(timestamp_ns, active_calendar.timezone_name)
    phase = _phase_for_local_datetime(active_calendar, local_dt)
    trading_date = _trading_date_for_local_datetime(active_calendar, local_dt, phase)
    warmup_until_ts_ns: str | None = None
    warmup_suppressed = False
    block_reason: SessionBlockReason | None = None
    candidate_eligible = phase == "rth"

    if phase == "rth":
        rth_open_ns = _local_datetime_to_ns(
            datetime.combine(local_dt.date(), active_calendar.rth_start, tzinfo=local_dt.tzinfo)
        )
        warmup_until = rth_open_ns + active_policy.warmup_seconds * NS_PER_SECOND
        warmup_until_ts_ns = str(warmup_until)
        if timestamp_ns < warmup_until:
            warmup_suppressed = True
            candidate_eligible = False
            block_reason = "warmup_suppression"
    elif phase == "eth":
        block_reason = "outside_rth"
    elif phase == "maintenance":
        block_reason = "maintenance_halt"
    else:
        block_reason = "session_closed"

    return SessionEvaluation(
        exchange_event_ts_ns=str(timestamp_ns),
        session_phase=phase,
        journal_phase=phase,
        trading_date=trading_date,
        session_id=f"{trading_date}-{'rth' if phase == 'rth' else 'eth'}",
        candidate_eligible=candidate_eligible,
        warmup_suppressed=warmup_suppressed,
        block_reason=block_reason,
        warmup_until_ts_ns=warmup_until_ts_ns,
        partial_parity_status=DATA01A_PARTIAL_PARITY_STATUS,
    )


def _phase_for_local_datetime(calendar: MnqSessionCalendar, local_dt: datetime) -> SessionPhase:
    override_phase = _override_phase(calendar, local_dt.date().isoformat(), local_dt.time())
    if override_phase is not None:
        return override_phase

    local_time = local_dt.time().replace(tzinfo=None)
    weekday = local_dt.weekday()
    if weekday == 5:
        return "closed"
    if weekday == 6 and local_time < calendar.eth_start:
        return "closed"
    if weekday == 4 and local_time >= calendar.maintenance_start:
        return "closed"

    if _time_in_window(local_time, calendar.maintenance_start, calendar.maintenance_end):
        return "maintenance"
    if _time_in_window(local_time, calendar.rth_start, calendar.rth_end):
        return "rth"
    return "eth"


def _trading_date_for_local_datetime(calendar: MnqSessionCalendar, local_dt: datetime, phase: SessionPhase) -> str:
    local_time = local_dt.time().replace(tzinfo=None)
    if local_time >= calendar.trading_day_roll_time:
        return (local_dt.date() + timedelta(days=1)).isoformat()
    return local_dt.date().isoformat()


def _override_phase(calendar: MnqSessionCalendar, date_value: str, local_time: time) -> SessionPhase | None:
    for override in calendar.overrides.values():
        if override.get("date") != date_value:
            continue
        phase = override.get("phase")
        if phase == "closed":
            return "closed"
        if phase == "rth":
            start_value = override.get("start_time")
            end_value = override.get("end_time")
            if start_value is None or end_value is None:
                return "closed"
            start = _parse_clock(start_value)
            end = _parse_clock(end_value)
            return "rth" if _time_in_window(local_time, start, end) else "closed"
    return None


def _time_in_window(value: time, start: time, end: time) -> bool:
    if start <= end:
        return start <= value < end
    return value >= start or value < end


def _ns_to_local_datetime(timestamp_ns: int, timezone_name: str) -> datetime:
    seconds = timestamp_ns // NS_PER_SECOND
    micros = (timestamp_ns % NS_PER_SECOND) // 1_000
    utc_dt = datetime.fromtimestamp(seconds, tz=timezone.utc).replace(microsecond=micros)
    return utc_dt.astimezone(ZoneInfo(timezone_name))


def _local_datetime_to_ns(local_dt: datetime) -> int:
    utc_dt = local_dt.astimezone(timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = utc_dt - epoch
    return (delta.days * 86_400 + delta.seconds) * NS_PER_SECOND + delta.microseconds * 1_000


def _parse_clock(value: str) -> time:
    hour, minute = value.split(":", 1)
    return time(int(hour), int(minute))


def _parse_decimal_ns(value: str) -> int:
    cleaned = str(value)
    if not cleaned.isdecimal():
        raise ValueError("exchange_event_ts_ns must be a decimal nanosecond string")
    return int(cleaned)


def _parse_simple_yaml(path: Path) -> dict[str, Any]:
    root: dict[str, Any] = {}
    parents: list[dict[str, Any]] = [root]
    with path.open("r", encoding="utf-8") as source:
        for raw_line in source:
            if raw_line.strip() == "" or raw_line.lstrip().startswith("#"):
                continue
            indent = len(raw_line) - len(raw_line.lstrip(" "))
            if indent % 2 != 0:
                raise ValueError(f"invalid indentation in {path}: {raw_line.rstrip()}")
            level = indent // 2
            key, separator, value = raw_line.strip().partition(":")
            if separator == "":
                raise ValueError(f"invalid yaml line in {path}: {raw_line.rstrip()}")
            while len(parents) > level + 1:
                parents.pop()
            parent = parents[-1]
            if value.strip() == "":
                child: dict[str, Any] = {}
                parent[key] = child
                parents.append(child)
            else:
                parent[key] = _parse_scalar(value.strip())
    return root


def _parse_scalar(value: str) -> str | int:
    if value.startswith('"') and value.endswith('"'):
        return value[1:-1]
    if value.isdecimal():
        return int(value)
    return value


def _required_string(record: dict[str, Any], key: str) -> str:
    value = record.get(key)
    if not isinstance(value, str):
        raise ValueError(f"missing string field: {key}")
    return value


def _required_nested_string(record: dict[str, Any], section: str, key: str) -> str:
    nested = record.get(section)
    if not isinstance(nested, dict):
        raise ValueError(f"missing section: {section}")
    value = nested.get(key)
    if not isinstance(value, str):
        raise ValueError(f"missing string field: {section}.{key}")
    return value
