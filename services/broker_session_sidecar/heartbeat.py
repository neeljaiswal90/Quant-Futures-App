"""Heartbeat command handling."""

from __future__ import annotations

from typing import Any

from services.broker_session_sidecar.ipc.envelope import make_event


def heartbeat_pong(command: dict[str, Any], broker_session_id: str) -> dict[str, Any]:
    return make_event(
        "heartbeat_pong",
        command_id=command.get("command_id"),
        broker_session_id=broker_session_id,
    )
