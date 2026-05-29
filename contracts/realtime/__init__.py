"""Realtime wire contract package (RA-067).

Single interface every v2 realtime component binds to:

- :mod:`contracts.realtime.events` — Pydantic envelope + payload families
  (source of truth), mirrored by ``events.ts``.
- :mod:`contracts.realtime.config` — alert-config type stub (RA-063 fills
  in serving), mirrored by ``config.ts``.
- :mod:`contracts.realtime.mock_emitter` — FastAPI WS mock the parallel
  agents develop against.

The TS ⇄ Pydantic parity test (``tests/test_parity.py``) is the
integration tripwire: a drift reds every worktree's CI.
"""

from contracts.realtime.events import (
    KNOWN_FAMILIES,
    MESSAGE_TYPES,
    SCHEMA_VERSION,
    TIERS,
    RealtimeMessage,
    RealtimePayload,
    make_message,
    parse_payload,
)

__all__ = [
    "SCHEMA_VERSION",
    "MESSAGE_TYPES",
    "TIERS",
    "KNOWN_FAMILIES",
    "RealtimeMessage",
    "RealtimePayload",
    "make_message",
    "parse_payload",
]
