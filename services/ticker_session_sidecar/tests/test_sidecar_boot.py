from __future__ import annotations

import signal
import subprocess
import sys

from .conftest import read_event, start_sidecar, write_command


def test_sidecar_boot_emits_boot_identity(sidecar_env):
    process = start_sidecar(sidecar_env)
    try:
        event = read_event(process)
        assert event["message_type"] == "boot_identity"
        assert event["payload"]["sdk_name"] == "pyrithmic"
        assert event["payload"]["protocol_environment"] == "rithmic_live"
    finally:
        write_command(process, "shutdown", {"reason": "test"})
        process.wait(timeout=2)


def test_sigterm_interrupts_idle_stdin(sidecar_env):
    process = start_sidecar(sidecar_env)
    try:
        assert read_event(process)["message_type"] == "boot_identity"
        if sys.platform == "win32":
            process.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            process.terminate()
        process.wait(timeout=2)
        assert process.returncode == 0
    finally:
        if process.poll() is None:
            process.kill()
