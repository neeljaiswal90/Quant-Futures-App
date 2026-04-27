"""Deterministic session identifiers for DATA-01A.

DATA-01A does not infer trading calendars. Callers provide session_id explicitly so the
sidecar does not read wall-clock time.
"""

from __future__ import annotations


def validate_session_id(session_id: str) -> str:
    cleaned = session_id.strip()
    if cleaned == "":
        raise ValueError("session_id must be non-empty")
    return cleaned
