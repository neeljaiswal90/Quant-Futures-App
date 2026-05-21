from __future__ import annotations

import io
import json
import os
import sys
import types
import unittest
from unittest.mock import patch

from services.broker_session_sidecar.sidecar import SidecarConfig, run


class HeartbeatTests(unittest.TestCase):
    def test_heartbeat_returns_pong_and_latency_measurement(self) -> None:
        module = types.SimpleNamespace(authenticate=lambda **_kwargs: {"ok": True, "session_id": "session-hb"})
        env = {
            "RITHMIC_TEST_USER": "u",
            "RITHMIC_TEST_PASSWORD": "p",
            "RITHMIC_TEST_WS_URL": "wss://g",
            "RITHMIC_TEST_SYSTEM": "s",
        }
        command = json.dumps({"schema_version": 1, "type": "heartbeat", "command_id": "cmd-1"}) + "\n"
        stdout = io.StringIO()
        with patch.dict(sys.modules, {"pyrithmic": module}), patch.dict(os.environ, env, clear=True):
            code = run(SidecarConfig(None, "info", "test"), stdin=io.StringIO(command), stdout=stdout)
        self.assertEqual(code, 0)
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(events[0]["type"], "boot_identity")
        self.assertEqual(events[1]["type"], "heartbeat_pong")
        self.assertEqual(events[1]["command_id"], "cmd-1")
        self.assertEqual(events[2]["type"], "qfa_broker_sidecar_ipc_ms")
        self.assertEqual(events[2]["command_id"], "cmd-1")
        self.assertGreaterEqual(events[2]["value_ms"], 0)


if __name__ == "__main__":
    unittest.main()
