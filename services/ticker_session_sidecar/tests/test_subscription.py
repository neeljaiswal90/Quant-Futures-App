from __future__ import annotations

from .conftest import read_event, start_sidecar, write_command


def test_subscribe_accepts_and_emits_quote(sidecar_env):
    process = start_sidecar(sidecar_env)
    try:
        assert read_event(process)["message_type"] == "boot_identity"
        accepted = read_event(process)
        assert accepted["message_type"] == "subscription_accepted"
        observed = [read_event(process)["message_type"] for _ in range(1)]
        assert "tick_quote" in observed
    finally:
        write_command(process, "shutdown", {"reason": "test"})
        process.wait(timeout=2)


def test_unsubscribe_returns_snapshot(sidecar_env):
    process = start_sidecar(sidecar_env)
    try:
        assert read_event(process)["message_type"] == "boot_identity"
        write_command(process, "unsubscribe_symbol", {"symbol": "MNQM6", "exchange": "CME"})
        events = [read_event(process)["message_type"] for _ in range(3)]
        assert "subscription_snapshot" in events
    finally:
        write_command(process, "shutdown", {"reason": "test"})
        process.wait(timeout=2)
