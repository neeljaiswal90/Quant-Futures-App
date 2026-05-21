from __future__ import annotations

import unittest

from services.broker_session_sidecar.ipc.redactor import redact_text


class RedactorParityTests(unittest.TestCase):
    def test_preflight_fixture_parity_strings(self) -> None:
        # Fixture parity note: BROKER-01 cannot import the TS preflight redactor from Python.
        # These canned strings mirror the TS preflight categories and assert byte-identical
        # expected Python output for credentials, emails, IPs, Bearer tokens, sessions,
        # order IDs, and account IDs.
        raw = (
            "password=hunter2 token=abc123 user trader@example.com ip 192.168.1.10 "
            "Bearer eyJhbGciOiJIUzI1NiJ9 session_id=sess-123 order_id=ord-456 account_id=acct-789"
        )
        expected = (
            "password=[REDACTED:CREDENTIAL] token=[REDACTED:CREDENTIAL] user [REDACTED:EMAIL] ip [REDACTED:IP] "
            "Bearer [REDACTED:TOKEN] session_id=[REDACTED:SESSION_ID] order_id=[REDACTED:ORDER_ID] account_id=[REDACTED:ACCOUNT_ID]"
        )
        self.assertEqual(redact_text(raw), expected)

    def test_order_and_account_aliases(self) -> None:
        self.assertEqual(
            redact_text("broker_order_id=ABC broker_account_id=XYZ"),
            "broker_order_id=[REDACTED:ORDER_ID] broker_account_id=[REDACTED:ACCOUNT_ID]",
        )


if __name__ == "__main__":
    unittest.main()
