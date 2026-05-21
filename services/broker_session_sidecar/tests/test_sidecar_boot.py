from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def env_with_mock_pyrithmic(ok: bool = True, extra_message: str = "") -> dict[str, str]:
    temp = tempfile.mkdtemp(prefix="qfa-mock-pyrithmic-")
    module = Path(temp) / "pyrithmic.py"
    if ok:
        module.write_text(
            "def authenticate(user, password, ws_url, system):\n"
            "    assert password == 'test-password'\n"
            "    return {'ok': True, 'session_id': 'mock-session-123', 'account_ref_redacted': 'mock-account'}\n",
            encoding="utf8",
        )
    else:
        module.write_text(
            "class Denied(Exception):\n"
            "    rp_code = 'RP_AUTH_DENIED'\n"
            "def authenticate(user, password, ws_url, system):\n"
            f"    raise Denied('denied for password=' + password + ' {extra_message}')\n",
            encoding="utf8",
        )
    env = os.environ.copy()
    env.update({
        "PYTHONPATH": f"{temp}{os.pathsep}{ROOT}{os.pathsep}{env.get('PYTHONPATH', '')}",
        "RITHMIC_TEST_USER": "test-user",
        "RITHMIC_TEST_PASSWORD": "test-password",
        "RITHMIC_TEST_WS_URL": "wss://test.gateway.invalid",
        "RITHMIC_TEST_SYSTEM": "Rithmic Test",
    })
    return env


def run_sidecar(input_text: str = "", env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "broker_session_sidecar"],
        cwd=ROOT,
        input=input_text,
        text=True,
        capture_output=True,
        env=env,
        timeout=5,
        check=False,
    )


def json_lines(stdout: str) -> list[dict[str, object]]:
    return [json.loads(line) for line in stdout.splitlines() if line.strip()]


class SidecarBootTests(unittest.TestCase):
    def test_boot_emits_identity_under_five_seconds_with_mock_pyrithmic(self) -> None:
        start = time.monotonic()
        result = run_sidecar(env=env_with_mock_pyrithmic())
        elapsed = time.monotonic() - start
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(elapsed, 5)
        events = json_lines(result.stdout)
        self.assertEqual(events[0]["type"], "boot_identity")
        self.assertEqual(events[0]["broker_session_id"], "mock-session-123")
        self.assertEqual(events[0]["account_ref_redacted"], "mock-account")
        self.assertEqual(events[-1]["type"], "shutdown_complete")
        self.assertEqual(result.stderr, "")

    def test_missing_env_fails_auth_denied_without_secret_values(self) -> None:
        env = os.environ.copy()
        for name in ("RITHMIC_TEST_USER", "RITHMIC_TEST_PASSWORD", "RITHMIC_TEST_WS_URL", "RITHMIC_TEST_SYSTEM"):
            env.pop(name, None)
        env["PYTHONPATH"] = f"{ROOT}{os.pathsep}{env.get('PYTHONPATH', '')}"
        result = run_sidecar(env=env)
        events = json_lines(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[0]["type"], "broker_error")
        self.assertEqual(events[0]["failure_state"], "auth_denied")
        self.assertIn("RITHMIC_TEST_USER", events[0]["rp_message_redacted"])
        self.assertNotIn("test-password", result.stdout + result.stderr)

    def test_sigterm_interrupts_idle_stdin_within_two_seconds(self) -> None:
        process = subprocess.Popen(
            [sys.executable, "-m", "broker_session_sidecar"],
            cwd=ROOT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env_with_mock_pyrithmic(),
        )
        try:
            boot_line = process.stdout.readline() if process.stdout is not None else ""
            self.assertEqual(json.loads(boot_line)["type"], "boot_identity")
            time.sleep(0.1)
            if os.name == "nt":
                process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=2)
        finally:
            if process.poll() is None:
                process.kill()
        self.assertEqual(process.returncode, 0, stderr)
        events = json_lines(boot_line + stdout)
        self.assertEqual(events[-1]["type"], "shutdown_complete")
        self.assertEqual(events[-1]["reason"], "signal")


if __name__ == "__main__":
    unittest.main()
