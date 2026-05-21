from __future__ import annotations

import io
import json
import os
import sys
import types
import unittest
from unittest.mock import patch

from services.broker_session_sidecar.sidecar import SidecarConfig, broker_error, run

ENV = {
    "RITHMIC_TEST_USER": "u",
    "RITHMIC_TEST_PASSWORD": "p",
    "RITHMIC_TEST_WS_URL": "wss://g",
    "RITHMIC_TEST_SYSTEM": "s",
}


def run_commands(commands: list[dict[str, object] | str]) -> list[dict[str, object]]:
    module = types.SimpleNamespace(authenticate=lambda **_kwargs: {"ok": True, "session_id": "session-failure"})
    input_text = "".join((item if isinstance(item, str) else json.dumps(item)) + "\n" for item in commands)
    stdout = io.StringIO()
    with patch.dict(sys.modules, {"pyrithmic": module}), patch.dict(os.environ, ENV, clear=True):
        run(SidecarConfig(None, "info", "test"), stdin=io.StringIO(input_text), stdout=stdout)
    return [json.loads(line) for line in stdout.getvalue().splitlines()]


class FailureStateTests(unittest.TestCase):
    def test_schema_version_incompatible(self) -> None:
        events = run_commands([{"schema_version": 999, "type": "heartbeat", "command_id": "bad-schema"}])
        self.assertEqual(events[1]["failure_state"], "schema_version_incompatible")

    def test_order_path_not_yet_implemented_for_order_commands(self) -> None:
        for command_type in ("submit_order", "cancel_order", "query_order", "request_reconciliation_snapshot"):
            with self.subTest(command_type=command_type):
                events = run_commands([{"schema_version": 1, "type": command_type, "command_id": command_type}])
                self.assertEqual(events[1]["failure_state"], "order_path_not_yet_implemented")

    def test_duplicate_command_detected_stub_path(self) -> None:
        events = run_commands([
            {"schema_version": 1, "type": "heartbeat", "command_id": "dup"},
            {"schema_version": 1, "type": "heartbeat", "command_id": "dup"},
        ])
        self.assertEqual(events[3]["failure_state"], "duplicate_command_detected")

    def test_broker_disconnected_error_shape_exists_but_sidecar_unavailable_is_not_emitted(self) -> None:
        event = broker_error("broker_disconnected", "disconnected session-abc")
        self.assertEqual(event["failure_state"], "broker_disconnected")
        self.assertNotEqual(event["failure_state"], "sidecar_unavailable")
        self.assertNotIn("abc", event["rp_message_redacted"])


if __name__ == "__main__":
    unittest.main()
