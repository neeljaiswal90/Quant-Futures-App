from __future__ import annotations

from .conftest import read_event, start_sidecar, write_command


def test_heartbeat_command_returns_pong(sidecar_env):
    process = start_sidecar(sidecar_env)
    try:
        assert read_event(process)["message_type"] == "boot_identity"
        write_command(process, "heartbeat", {})
        events = [read_event(process)["message_type"] for _ in range(3)]
        assert "heartbeat_pong" in events
    finally:
        write_command(process, "shutdown", {"reason": "test"})
        process.wait(timeout=2)
