from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HeartbeatReply:
    pong: bool = True


def handle_heartbeat() -> HeartbeatReply:
    return HeartbeatReply()
