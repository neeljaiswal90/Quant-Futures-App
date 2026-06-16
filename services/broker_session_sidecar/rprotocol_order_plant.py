"""Rithmic RProtocol ORDER_PLANT client for the broker sidecar.

This module intentionally reuses the proven QFA-612 ORDER_PLANT preflight
framing instead of the async-rithmic auth path. It is scoped to Rithmic Test
order placement and does not touch capture credentials.
"""

from __future__ import annotations

import contextlib
import importlib.util
import os
import pathlib
import sys
import uuid
from types import ModuleType
from typing import Any

from services.broker_session_sidecar.credential_resolver import RithmicCredentials


class RProtocolOrderPlantError(RuntimeError):
    """Raised when the RProtocol ORDER_PLANT sidecar path fails closed."""


class RProtocolOrderPlantClient:
    def __init__(self, preflight: ModuleType, context: Any, exchange: str) -> None:
        self._preflight = preflight
        self._context = context
        self._exchange = exchange
        self.accounts = [dict(context.account)] if context.account is not None else []
        self.fcm_id = str((context.account or {}).get("fcm_id", ""))
        self.ib_id = str((context.account or {}).get("ib_id", ""))
        self.account_id = str((context.account or {}).get("account_id", ""))
        self.trade_route = dict(context.trade_route) if context.trade_route is not None else {}
        self.sdk_version = "rithmic-rprotocol-order-plant"

    @classmethod
    async def connect(cls, credentials: RithmicCredentials, *, exchange: str = "CME") -> "RProtocolOrderPlantClient":
        preflight = _load_order_plant_preflight()
        paths = preflight.resolve_sdk_paths()
        modules = preflight.load_modules(paths)
        system = _rprotocol_system_name(credentials.system)
        context = await preflight.open_order_session(
            credentials.ws_url,
            paths,
            modules,
            system,
            credentials.user,
            credentials.password,
            "broker-sidecar",
        )
        try:
            await preflight.bootstrap_order_session(context, exchange)
        except Exception:
            with contextlib.suppress(Exception):
                await preflight.logout(context.ws, modules)
            with contextlib.suppress(Exception):
                await context.ws.close(1000, "qfa-612-sidecar-bootstrap-failed")
            raise
        return cls(preflight, context, exchange)

    async def disconnect(self) -> None:
        with contextlib.suppress(Exception):
            await self._preflight.logout(self._context.ws, self._context.modules)
        with contextlib.suppress(Exception):
            await self._context.ws.close(1000, "qfa-612-sidecar-disconnect")

    async def list_accounts(self) -> list[dict[str, Any]]:
        return list(self.accounts)

    async def submit_order(
        self,
        order_id: str,
        symbol: str,
        exchange: str,
        *,
        qty: int,
        order_type: Any,
        transaction_type: Any,
        account_id: str,
        price: float | None = None,
    ) -> dict[str, Any]:
        self._require_account(account_id)
        self._preflight.SYMBOL = symbol
        self._preflight.EXCHANGE = exchange or self._exchange
        submit = await self._preflight.submit_order(
            self._context,
            user_tag=order_id,
            side=_transaction_side(transaction_type),
            price_type=_price_type(order_type),
            price=price,
            quantity=qty,
            duration="DAY",
        )
        events = await self._preflight.collect_until(
            self._context,
            lambda event, all_events: event.get("message_type") == "response_new_order"
            or any(str(e.get("message_type")) in {"rithmic_order_notification", "exchange_order_notification"} for e in all_events),
            20,
        )
        response = _first_event(events, "response_new_order") or (events[0] if events else {})
        basket_id = str(response.get("basket_id") or submit.get("user_tag") or order_id)
        return {
            **submit,
            "basket_id": basket_id,
            "broker_order_id": basket_id,
            "order_id": order_id,
            "account_id": account_id,
            "events": events,
            "rq_handler_rp_code": response.get("rq_handler_rp_code"),
            "rp_code": response.get("rp_code"),
        }

    async def cancel_order(self, *, order_id: str, account_id: str | None = None) -> dict[str, Any]:
        if account_id is not None and account_id != "":
            self._require_account(account_id)
        cancel = await self._preflight.cancel_order(self._context, order_id)
        events = await self._preflight.collect_until(
            self._context,
            lambda event, all_events: event.get("message_type") == "response_cancel_order"
            or any(str(e.get("status", "")).lower() in {"complete", "cancelled", "canceled"} for e in all_events),
            30,
        )
        response = _first_event(events, "response_cancel_order") or (events[0] if events else {})
        return {
            **cancel,
            "basket_id": order_id,
            "broker_order_id": order_id,
            "account_id": account_id or self.account_id,
            "events": events,
            "rq_handler_rp_code": response.get("rq_handler_rp_code"),
            "rp_code": response.get("rp_code"),
        }

    def _require_account(self, account_id: str) -> None:
        if self.account_id != "" and account_id != self.account_id:
            raise RProtocolOrderPlantError("ORDER_PLANT command account_id does not match authenticated account")


def _load_order_plant_preflight() -> ModuleType:
    repo_root = pathlib.Path(__file__).resolve().parents[2]
    path = repo_root / "scripts" / "preflight" / "qfa-612-paper-01b" / "order_plant_client.py"
    spec = importlib.util.spec_from_file_location("qfa612_order_plant_client", path)
    if spec is None or spec.loader is None:
        raise RProtocolOrderPlantError(f"unable to load ORDER_PLANT preflight module from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _rprotocol_system_name(normalized_system: str) -> str:
    raw = _first_env(
        "RITHMIC_LUCID_SYSTEM_NAME",
        "RITHMIC_TEST_SYSTEM",
        "RITHMIC_TEST_SYSTEM_NAME",
        "RITHMIC_SYSTEM_NAME",
        "RITHMIC_SYSTEM",
    )
    candidate = raw or normalized_system
    if candidate.strip().lower() == "tradeify" or normalized_system == "Rithmic Paper Trading":
        return "Tradeify"
    return candidate.strip()


def _first_env(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value is not None and value.strip() != "":
            return value
    return None


def _transaction_side(value: Any) -> str:
    text = _enum_text(value)
    return "BUY" if text.endswith("BUY") or text == "BUY" else "SELL"


def _price_type(value: Any) -> str:
    text = _enum_text(value)
    if text.endswith("MARKET") and "STOP" not in text:
        return "MARKET"
    if text.endswith("LIMIT"):
        return "LIMIT"
    return text


def _enum_text(value: Any) -> str:
    name = getattr(value, "name", None)
    if isinstance(name, str) and name != "":
        return name.upper()
    text = str(value).upper()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text


def _first_event(events: list[dict[str, Any]], message_type: str) -> dict[str, Any] | None:
    return next((event for event in events if event.get("message_type") == message_type), None)


def broker_session_id() -> str:
    return f"rprotocol-order-plant-{uuid.uuid4()}"
