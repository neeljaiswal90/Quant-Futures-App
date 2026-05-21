from __future__ import annotations

import unittest

from services.broker_session_sidecar.ipc.redactor import redact_text


class RedactorParityTests(unittest.TestCase):
    def test_preflight_redactor_fixture_matches_ts_output_byte_for_byte(self) -> None:
        raw = "\n".join((
            'RITHMIC_TEST_USERNAME="paper.user@example.com"',
            'RITHMIC_TEST_USER="paper.alias@example.com"',
            'RITHMIC_TEST_PASSWORD="secret-password-123"',
            'RITHMIC_TEST_WS_URL="wss://example.test:443"',
            'RITHMIC_CONNECT_POINT="wss://fallback.example.test:443"',
            "Authorization: Bearer eyJhbGciOi.fake.token",
            "session-abc123 broker_order_id=order-xyz789 accountId=ABC12345",
            "gateway=203.0.113.17 localhost=127.0.0.1",
        ))
        expected = "\n".join((
            'RITHMIC_TEST_USERNAME="[REDACTED:credential]"',
            'RITHMIC_TEST_USER="[REDACTED:credential]"',
            'RITHMIC_TEST_PASSWORD="[REDACTED:credential]"',
            'RITHMIC_TEST_WS_URL="[REDACTED:credential]"',
            'RITHMIC_CONNECT_POINT="[REDACTED:credential]"',
            "Authorization: Bearer [REDACTED:credential]",
            "[REDACTED:session-id-1] broker_order_id=[REDACTED:[REDACTED:order-id-1]] accountId=[REDACTED:account-id]",
            "gateway=[REDACTED:ip] localhost=127.0.0.1",
        ))
        self.assertEqual(redact_text(raw, ["secret-password-123"]), expected)

    def test_preflight_category_edges_match_ts_output_byte_for_byte(self) -> None:
        raw = (
            "mock-session-123 session-xyz rithmic-session:abc order-xyz789 "
            "accountId=ABC12345 0.0.0.0 127.0.0.1 198.51.100.2 "
            "Bearer token abc@example.com"
        )
        expected = (
            "[REDACTED:session-id-1] [REDACTED:session-id-1] [REDACTED:session-id-1] "
            "[REDACTED:order-id-1] accountId=[REDACTED:account-id] "
            "0.0.0.0 127.0.0.1 [REDACTED:ip] Bearer [REDACTED:credential] "
            "[REDACTED:credential]"
        )
        self.assertEqual(redact_text(raw), expected)


if __name__ == "__main__":
    unittest.main()
