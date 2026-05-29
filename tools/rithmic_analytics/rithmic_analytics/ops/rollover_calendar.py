"""CME E-mini Micro Nasdaq quarterly rollover calendar.

The calendar is a hardcoded module-level list because:
    - We only handle one root (MNQ) per the kickoff scope decision (Q4).
    - There are ~4 rollovers/year × project lifetime ≈ a handful of entries.
    - YAML I/O and a parser add zero value over a typed dataclass + a list of
      eight constructor calls.

Conventions:
    - ``rollover_date``: the first calendar date on which the new contract is
      treated as front-month for this analytics layer. Empirically this is the
      Friday that is 7 days before the outgoing contract's expiry (i.e. the
      2nd Friday of the outgoing contract's expiry month).
    - ``expiry_date``: the outgoing contract's expiry — third Friday of its
      expiry month. Stored here primarily so the ``RolloverCalendarMiss``
      message can tell the operator which contract's calendar entry to extend.

CME E-mini contract codes used:
    H = March, M = June, U = September, Z = December.
    Two-digit year: M6 = June 2026, U6 = September 2026, etc.

Extending the calendar:
    Compute the third Friday of the expiry month, subtract 7 days to get the
    rollover Friday, append a new ``RolloverEntry``. Order is enforced by
    ``_validate_calendar()`` at import time so a mis-ordered entry fails fast.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date


class RolloverCalendarMiss(Exception):
    """Raised when no calendar entry covers the requested date."""


@dataclass(frozen=True, slots=True)
class RolloverEntry:
    """One front-month transition in the quarterly rollover calendar.

    Attributes:
        rollover_date: First date on which ``contract`` is treated as front-month.
        contract: Exchange ticker for the new front-month (e.g. ``"MNQM6"``).
        expiry_date: Third-Friday expiry of the *outgoing* contract — included so
            ``RolloverCalendarMiss`` messages can guide calendar maintenance.
    """

    rollover_date: date
    contract: str
    expiry_date: date


# Calendar runs through 2027 Q4. Extend before late 2027 (the last entry's
# expiry sets the operational deadline).
_MNQ_ROLLOVERS: list[RolloverEntry] = [
    RolloverEntry(date(2026, 3, 13), "MNQM6", date(2026, 6, 19)),
    RolloverEntry(date(2026, 6, 12), "MNQU6", date(2026, 9, 18)),
    RolloverEntry(date(2026, 9, 11), "MNQZ6", date(2026, 12, 18)),
    RolloverEntry(date(2026, 12, 11), "MNQH7", date(2027, 3, 19)),
    RolloverEntry(date(2027, 3, 12), "MNQM7", date(2027, 6, 18)),
    RolloverEntry(date(2027, 6, 11), "MNQU7", date(2027, 9, 17)),
    RolloverEntry(date(2027, 9, 10), "MNQZ7", date(2027, 12, 17)),
    RolloverEntry(date(2027, 12, 10), "MNQH8", date(2028, 3, 17)),
]


def _validate_calendar() -> None:
    """Sanity-check at import: entries are ordered and have plausible expiries."""
    for i in range(1, len(_MNQ_ROLLOVERS)):
        prev, curr = _MNQ_ROLLOVERS[i - 1], _MNQ_ROLLOVERS[i]
        if curr.rollover_date <= prev.rollover_date:
            raise ValueError(
                f"calendar out of order: {curr.rollover_date} <= {prev.rollover_date}"
            )
    for entry in _MNQ_ROLLOVERS:
        if entry.expiry_date <= entry.rollover_date:
            raise ValueError(
                f"entry has expiry {entry.expiry_date} <= rollover {entry.rollover_date}"
            )


_validate_calendar()


def resolve_front_month(root: str, today: date) -> str:
    """Resolve the active front-month contract for a root symbol on a given date.

    Args:
        root: Root symbol. Only ``"MNQ"`` is configured (tight scope per kickoff Q4).
        today: Date on which to resolve. Inclusive — if ``today`` equals a
            ``rollover_date``, the entry's contract wins.

    Returns:
        The exchange ticker for the active front-month (e.g. ``"MNQM6"``).

    Raises:
        ValueError: If ``root`` is anything other than ``"MNQ"``.
        RolloverCalendarMiss: If ``today`` is before the earliest configured
            ``rollover_date``, or after the latest ``expiry_date``. Message
            includes the boundary entry so the operator knows which way to
            extend the calendar.

    Example:
        >>> from datetime import date
        >>> resolve_front_month("MNQ", date(2026, 5, 15))
        'MNQM6'
        >>> resolve_front_month("MNQ", date(2026, 6, 12))  # rollover day itself
        'MNQU6'
    """
    if root != "MNQ":
        raise ValueError(f"unsupported root symbol: {root!r}; only MNQ is configured")

    eligible = [e for e in _MNQ_ROLLOVERS if e.rollover_date <= today]
    if not eligible:
        first = _MNQ_ROLLOVERS[0]
        raise RolloverCalendarMiss(
            f"no calendar entry for {root} on {today.isoformat()}; earliest "
            f"entry is {first.rollover_date.isoformat()} → {first.contract} "
            f"(expires {first.expiry_date.isoformat()}). Extend "
            f"_MNQ_ROLLOVERS to add prior entries."
        )

    latest = eligible[-1]
    if today > latest.expiry_date:
        raise RolloverCalendarMiss(
            f"calendar exhausted for {root} on {today.isoformat()}; latest "
            f"entry {latest.contract} expired {latest.expiry_date.isoformat()}. "
            f"Extend _MNQ_ROLLOVERS to add future entries."
        )

    return latest.contract
