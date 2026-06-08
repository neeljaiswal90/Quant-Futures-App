"""BROKER-03 paper ORDER_PLANT lifecycle tests with a mock async-rithmic client."""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
from types import ModuleType
from unittest.mock import patch

from services.broker_session_sidecar.sidecar import SidecarConfig, run


def _env() -> dict[str, str]:
    return {
        "RITHMIC_TEST_USER": "test-user@example.com",
        "RITHMIC_TEST_PASSWORD": "test-password",
        "RITHMIC_TEST_WS_URL": "wss://gateway.example.invalid",
        "RITHMIC_TEST_SYSTEM": "Rithmic Test",
        "QFA_BROKER_ADAPTER_KIND": "rithmic",
        "QFA_BROKER_ALLOWLIST_JSON": json.dumps(_allowlist()),
    }


def _allowlist() -> list[dict[str, object]]:
    return [
        {
            "fcm_id": "TEST_FCM",
            "ib_id": "TEST_IB",
            "account_id": "TEST_ACCT_001",
            "label": "Synthetic account",
            "max_position_contracts": 2,
            "daily_loss_cap_usd": 100,
            "max_session_duration_ms": 60_000,
            "time_of_day_restriction": "unrestricted",
        }
    ]


def _module() -> ModuleType:
    module = ModuleType("async_rithmic")
    module.__version__ = "1.6.1"

    class FakeSysInfraType:
        TICKER_PLANT = "ticker"
        ORDER_PLANT = "order"

    class FakeClient:
        session_id = "mock-session-123"
        fcm_id = "TEST_FCM"
        ib_id = "TEST_IB"

        def __init__(self, **kwargs: object) -> None:
            self.kwargs = kwargs
            self.orders: dict[str, dict[str, object]] = {}

        async def connect(self, **kwargs: object) -> None:
            self.connect_kwargs = kwargs

        async def list_accounts(self) -> list[dict[str, object]]:
            return _allowlist()

        async def submit_order(self, order_id: str, symbol: str, exchange: str, **kwargs: object) -> dict[str, object]:
            order = {
                "order_id": order_id,
                "broker_order_id": f"broker-{order_id}",
                "account_id": kwargs["account_id"],
                "symbol": symbol,
                "exchange": exchange,
            }
            self.orders[order_id] = order
            return order

        async def cancel_order(self, **kwargs: object) -> dict[str, object]:
            return {"broker_order_id": kwargs["order_id"], "account_id": kwargs.get("account_id", "TEST_ACCT_001")}

        async def get_order(self, **kwargs: object) -> dict[str, object]:
            return {"broker_order_id": kwargs["order_id"], "account_id": kwargs.get("account_id", "TEST_ACCT_001"), "symbol": "MNQM6"}

        async def disconnect(self) -> None:
            self.disconnected = True

    module.SysInfraType = FakeSysInfraType  # type: ignore[attr-defined]
    module.RithmicClient = FakeClient  # type: ignore[attr-defined]
    return module


def _command(message_type: str, correlation_id: str, payload: dict[str, object], idempotency_key: str | None = None) -> dict[str, object]:
    command: dict[str, object] = {
        "schema_version": 1,
        "message_type": message_type,
        "direction": "command",
        "run_id": "run-1",
        "session_id": "session-1",
        "correlation_id": correlation_id,
        "causation_id": "operator",
        "event_ts_ns": "1",
        "adapter_version": "test",
        "payload": payload,
    }
    if idempotency_key is not None:
        command["idempotency_key"] = idempotency_key
    return command


def _submit(account_id: str = "TEST_ACCT_001") -> dict[str, object]:
    return _command(
        "submit_order",
        "submit-1",
        {
            "intent": {
                "event_id": "intent-1",
                "payload": {
                    "account_id": account_id,
                    "order_intent_id": "intent-1",
                    "instrument_symbol": "MNQM6",
                    "exchange": "CME",
                    "quantity": 1,
                    "side": "buy",
                    "order_type": "LIMIT",
                    "limit_price": 100.0,
                },
            }
        },
        "intent-1",
    )


def _events(stdout: str) -> list[dict[str, object]]:
    return [json.loads(line) for line in stdout.splitlines() if line.strip()]


def _payload(event: dict[str, object]) -> dict[str, object]:
    payload = event.get("payload")
    return payload if isinstance(payload, dict) else event


def _run(commands: list[dict[str, object]]) -> list[dict[str, object]]:
    stdout = io.StringIO()
    stdin = io.StringIO("".join(json.dumps(command) + "\n" for command in commands))
    with patch.dict(os.environ, _env(), clear=True), patch.dict(sys.modules, {"async_rithmic": _module()}):
        code = asyncio.run(run(SidecarConfig(config_path=None, log_level="info", mode="test"), stdin, stdout))
    assert code == 0
    return _events(stdout.getvalue())


def test_submit_cancel_query_account_list_and_query_order_lifecycle() -> None:
    events = _run(
        [
            _command("query_account_list", "accounts-1", {}, None),
            _submit(),
            _command(
                "cancel_order",
                "cancel-1",
                {"request": {"intent_id": "intent-1", "broker_order_id": "broker-intent-1", "account_id": "TEST_ACCT_001"}},
                "cancel-1",
            ),
            _command("query_order", "query-1", {"order_id": "broker-intent-1", "account_id": "TEST_ACCT_001"}, "query-1"),
        ]
    )
    by_type = {event.get("message_type") or event.get("type"): _payload(event) for event in events}
    assert by_type["account_list_snapshot"]["accounts"][0]["account_id"] == "TEST_ACCT_001"
    assert by_type["order_accepted"]["broker_account_id"] == "TEST_ACCT_001"
    assert by_type["order_cancelled"]["broker_account_id"] == "TEST_ACCT_001"
    assert by_type["order_acknowledged"]["broker_account_id"] == "TEST_ACCT_001"


def test_submit_wrong_account_is_rejected_before_sdk_call() -> None:
    events = _run([_submit("OTHER_ACCT")])
    broker_errors = [_payload(event) for event in events if (event.get("message_type") or event.get("type")) == "broker_error"]
    assert broker_errors[0]["failure_state"] == "account_id_not_in_allowlist"
