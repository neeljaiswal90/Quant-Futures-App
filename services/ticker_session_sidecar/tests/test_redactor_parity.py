from __future__ import annotations

from services.broker_session_sidecar.ipc.redactor import redact_text as broker_redact
from services.ticker_session_sidecar.ipc.redactor import redact_text as ticker_redact


CANNED = [
    'user joannajaiswal90@gmail.com password HBTHvR8W',
    'Bearer abc.def.ghi from 203.0.113.42 but localhost 127.0.0.1 survives',
    'session mock-session-123 session_id=rithmic-session-abc',
    'orderId=ABC-123 broker_order_id=XYZ-999 account=12345678',
]


def test_ticker_redactor_reuses_broker_redactor_rules():
    for value in CANNED:
        assert ticker_redact(value) == broker_redact(value)
