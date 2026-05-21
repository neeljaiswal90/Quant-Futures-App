from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

from services.broker_session_sidecar.auth import AuthDeniedError, authenticate
from services.broker_session_sidecar.credential_resolver import RithmicCredentials
from services.broker_session_sidecar.sidecar import broker_error


class AuthHandshakeTests(unittest.TestCase):
    def test_authenticate_uses_pyrithmic_gateway_shape(self) -> None:
        module = types.SimpleNamespace()

        def fake_authenticate(user: str, password: str, ws_url: str, system: str) -> dict[str, object]:
            self.assertEqual(user, "user")
            self.assertEqual(password, "secret")
            self.assertEqual(ws_url, "wss://gateway")
            self.assertEqual(system, "test-system")
            return {"authenticated": True, "broker_session_id": "session-a"}

        module.authenticate = fake_authenticate
        with patch.dict(sys.modules, {"pyrithmic": module}):
            result = authenticate(RithmicCredentials("user", "secret", "wss://gateway", "test-system"))
        self.assertEqual(result.broker_session_id, "session-a")

    def test_auth_failure_redacts_rp_message(self) -> None:
        module = types.SimpleNamespace()

        def fake_authenticate(user: str, password: str, ws_url: str, system: str) -> dict[str, object]:
            return {"ok": False, "rp_code": "13", "rp_message": f"password={password} user@example.com 10.0.0.5"}

        module.authenticate = fake_authenticate
        with patch.dict(sys.modules, {"pyrithmic": module}):
            with self.assertRaises(AuthDeniedError) as ctx:
                authenticate(RithmicCredentials("user", "secret", "wss://gateway", "test-system"))
        self.assertEqual(ctx.exception.rp_code, "13")
        self.assertNotIn("secret", ctx.exception.rp_message_redacted)
        self.assertIn("[REDACTED:credential]", ctx.exception.rp_message_redacted)
        self.assertIn("[REDACTED:ip]", ctx.exception.rp_message_redacted)

    def test_auth_denied_broker_error_uses_shared_failure_payload_fields(self) -> None:
        event = broker_error("auth_denied", "Rithmic authentication denied", rp_code="13", rp_message="password=secret")
        self.assertEqual(event["payload"]["failure_state"], "auth_denied")
        self.assertEqual(event["payload"]["reason"], "Rithmic authentication denied")
        self.assertFalse(event["payload"]["recoverable"])
        self.assertEqual(event["payload"]["rp_code"], "13")
        self.assertEqual(event["payload"]["rp_message_redacted"], "password=[REDACTED:credential]")


if __name__ == "__main__":
    unittest.main()
