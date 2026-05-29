"""Trading-session resolution for MNQ dashboard generation."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from rithmic_dashboard.models import DashboardSession

PT = ZoneInfo("America/Los_Angeles")

RTH_START = time(6, 30)
RTH_END = time(13, 5)
GLOBEX_START = time(14, 55)


def _combine(day: date, clock: time) -> datetime:
    return datetime.combine(day, clock, tzinfo=PT)


def determine_session_state(
    *,
    now_pt: datetime | None = None,
    analytics_root: Path = Path("../rithmic_analytics"),
    trading_date_override: str | None = None,
    session_override: str | None = None,
) -> DashboardSession:
    """Resolve the current session, trading date, and expected artifact paths."""

    now = now_pt.astimezone(PT) if now_pt is not None else datetime.now(PT)
    today = now.date()
    rth_start = _combine(today, RTH_START)
    rth_end = _combine(today, RTH_END)
    globex_start_today = _combine(today, GLOBEX_START)

    if session_override is not None:
        session = session_override.lower()
        trading_date = trading_date_override or today.isoformat()
        state = "between_sessions"
        if session == "rth":
            state = "rth_active"
            start = rth_start
            end = rth_end
        elif session == "globex":
            state = "globex_active"
            start = globex_start_today
            end = rth_start + timedelta(days=1)
        else:
            session = "between"
            start = None
            end = None
        return _build_session(
            analytics_root=analytics_root,
            state=state,
            session=session,
            trading_date=trading_date,
            now_pt=now,
            start=start,
            end=end,
        )

    if rth_start <= now < rth_end:
        return _build_session(
            analytics_root=analytics_root,
            state="rth_active",
            session="rth",
            trading_date=trading_date_override or today.isoformat(),
            now_pt=now,
            start=rth_start,
            end=rth_end,
        )

    if now >= globex_start_today:
        trading_date = trading_date_override or (today + timedelta(days=1)).isoformat()
        return _build_session(
            analytics_root=analytics_root,
            state="globex_active",
            session="globex",
            trading_date=trading_date,
            now_pt=now,
            start=globex_start_today,
            end=rth_start + timedelta(days=1),
        )

    if now < rth_start:
        trading_date = trading_date_override or today.isoformat()
        return _build_session(
            analytics_root=analytics_root,
            state="globex_active",
            session="globex",
            trading_date=trading_date,
            now_pt=now,
            start=globex_start_today - timedelta(days=1),
            end=rth_start,
        )

    return _build_session(
        analytics_root=analytics_root,
        state="between_sessions",
        session="rth",
        trading_date=trading_date_override or today.isoformat(),
        now_pt=now,
        start=None,
        end=globex_start_today,
    )


def _build_session(
    *,
    analytics_root: Path,
    state: str,
    session: str,
    trading_date: str,
    now_pt: datetime,
    start: datetime | None,
    end: datetime | None,
) -> DashboardSession:
    zones_path = analytics_root / "data" / "zones" / f"{trading_date}_MNQ_{session}.json"
    capture_path = analytics_root / "data" / "captures" / trading_date / f"MNQ_{session}.jsonl"
    first_30min = start is not None and start <= now_pt < start + timedelta(minutes=30)
    return DashboardSession(
        state=state,  # type: ignore[arg-type]
        session=session,  # type: ignore[arg-type]
        trading_date=trading_date,
        now_pt=now_pt,
        session_start_pt=start,
        session_end_pt=end,
        zones_path=zones_path,
        capture_path=capture_path,
        first_30min=first_30min,
    )
