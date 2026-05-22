"""Broker sidecar boot and shutdown tests for the async-rithmic substrate."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _write_mock_async_rithmic(module_dir: Path, *, fail: bool = False) -> None:
    body = """
__version__ = '1.6.1'

class AuthDenied(Exception):
    rp_code = 'RP_AUTH_DENIED'

async def authenticate(user, password, url, system_name):
    if FAIL_AUTH:
        raise AuthDenied('permission denied for account user@example.com')
    return {
        'ok': True,
        'session_id': 'mock-session-123',
        'account_ref_redacted': 'mock-account',
    }
""".replace("FAIL_AUTH", "True" if fail else "False")
    (module_dir / "async_rithmic.py").write_text(textwrap.dedent(body), encoding="utf8")


def _env_with_mock_async_rithmic(module_dir: Path) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "RITHMIC_TEST_USER": "test-user@example.com",
            "RITHMIC_TEST_PASSWORD": "test-password",
            "RITHMIC_TEST_WS_URL": "wss://test.gateway.invalid",
            "RITHMIC_TEST_SYSTEM": "Rithmic Test",
        }
    )
    existing_path = env.get("PYTHONPATH")
    env["PYTHONPATH"] = os.pathsep.join(
        part for part in (str(module_dir), str(ROOT), existing_path) if part
    )
    return env


def _event_type(event: dict[str, object]) -> object:
    return event.get("message_type") or event.get("type")


def _payload(event: dict[str, object]) -> dict[str, object]:
    payload = event.get("payload")
    return payload if isinstance(payload, dict) else event


def _json_events(stdout: str) -> list[dict[str, object]]:
    return [json.loads(line) for line in stdout.splitlines() if line.strip()]


def test_sidecar_boot_emits_async_rithmic_boot_identity() -> None:
    with tempfile.TemporaryDirectory(prefix="qfa-mock-async-rithmic-") as tmp:
        module_dir = Path(tmp)
        _write_mock_async_rithmic(module_dir)
        proc = subprocess.run(
            [sys.executable, "-m", "broker_session_sidecar"],
            input="",
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=ROOT,
            env=_env_with_mock_async_rithmic(module_dir),
            timeout=5,
            check=False,
        )
    assert proc.returncode == 0, proc.stderr
    events = _json_events(proc.stdout)
    boot_event = next(event for event in events if _event_type(event) == "boot_identity")
    boot_payload = _payload(boot_event)
    assert boot_payload["sdk_name"] == "async-rithmic"
    assert boot_payload["sdk_version"] == "1.6.1"


def test_sigterm_interrupts_idle_stdin_with_shutdown_complete() -> None:
    with tempfile.TemporaryDirectory(prefix="qfa-mock-async-rithmic-") as tmp:
        module_dir = Path(tmp)
        _write_mock_async_rithmic(module_dir)
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        proc = subprocess.Popen(
            [sys.executable, "-m", "broker_session_sidecar"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=ROOT,
            env=_env_with_mock_async_rithmic(module_dir),
            creationflags=creationflags,
        )
        try:
            assert proc.stdout is not None
            boot_line = proc.stdout.readline()
            assert "boot_identity" in boot_line
            if os.name == "nt":
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                proc.send_signal(signal.SIGTERM)
            stdout_tail, stderr = proc.communicate(timeout=2)
        finally:
            if proc.poll() is None:
                proc.kill()
    assert proc.returncode == 0, stderr
    events = _json_events(boot_line + stdout_tail)
    assert _event_type(events[-1]) == "shutdown_complete"
    assert _payload(events[-1]).get("reason") == "signal"
