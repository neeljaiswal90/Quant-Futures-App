from __future__ import annotations

import json
import os
import pathlib
import queue
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Dict

import pytest


def make_mock_pythonpath(tmp_path: pathlib.Path) -> str:
    module = tmp_path / "pyrithmic.py"
    module.write_text(
        """
__version__ = 'mock-1.0.0'

class MockClient:
    def __init__(self):
        self.subscriptions = []
        self._ticks = [{
            'type': 'quote',
            'symbol': 'MNQM6',
            'exchange': 'CME',
            'tick_ts_ns': '1776965227000001000',
            'sidecar_recv_ts_ns': '1776965227000002000',
            'bid_px': 18000.25,
            'bid_qty': 2,
            'ask_px': 18000.5,
            'ask_qty': 3,
        }]

    def subscribe_symbol(self, symbol, exchange):
        self.subscriptions.append((symbol, exchange))

    def unsubscribe_symbol(self, symbol, exchange):
        self.subscriptions = [item for item in self.subscriptions if item != (symbol, exchange)]

    def drain_ticks(self):
        ticks = self._ticks
        self._ticks = []
        return ticks


def authenticate(**kwargs):
    if kwargs.get('username') == 'fail':
        raise RuntimeError('auth denied for user fail')
    return MockClient()
""".strip(),
        encoding="utf8",
    )
    existing = os.environ.get("PYTHONPATH", "")
    return str(tmp_path) + (os.pathsep + existing if existing else "")


@pytest.fixture()
def sidecar_env() -> Dict[str, str]:
    temp_dir = pathlib.Path(tempfile.mkdtemp(prefix="qfa-633-pyrithmic-"))
    env = os.environ.copy()
    env.update({
        "PYTHONPATH": make_mock_pythonpath(temp_dir),
        "RITHMIC_USER": "mock-user@example.com",
        "RITHMIC_PASSWORD": "mock-password",
        "RITHMIC_CONNECT_POINT": "wss://mock.rithmic.local:443",
        "RITHMIC_SYSTEM_NAME": "Rithmic Live",
    })
    return env


def start_sidecar(env: Dict[str, str]) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-m", "ticker_session_sidecar"],
        cwd=pathlib.Path(__file__).resolve().parents[3],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
    )


def read_event(process: subprocess.Popen[str], timeout_s: float = 2.0) -> Dict[str, Any]:
    assert process.stdout is not None
    result_queue: queue.Queue[str] = queue.Queue(maxsize=1)

    def read_line() -> None:
        result_queue.put(process.stdout.readline())

    threading.Thread(target=read_line, daemon=True).start()
    try:
        line = result_queue.get(timeout=timeout_s)
    except queue.Empty as exc:
        stderr = ""
        if process.stderr is not None and process.poll() is not None:
            stderr = process.stderr.read()
        raise AssertionError(f"timed out waiting for sidecar event; stderr={stderr}") from exc
    if not line:
        stderr = process.stderr.read() if process.stderr is not None else ""
        raise AssertionError(f"sidecar stdout closed; stderr={stderr}")
    return json.loads(line)


def write_command(process: subprocess.Popen[str], message_type: str, payload: Dict[str, Any] | None = None) -> None:
    assert process.stdin is not None
    command = {
        "schema_version": 1,
        "message_type": message_type,
        "direction": "command",
        "run_id": "run-test",
        "session_id": "session-test",
        "correlation_id": message_type,
        "causation_id": message_type,
        "event_ts_ns": "1776965227000000000",
        "adapter_version": "pytest",
        "payload": payload or {},
    }
    process.stdin.write(json.dumps(command) + "\n")
    process.stdin.flush()
