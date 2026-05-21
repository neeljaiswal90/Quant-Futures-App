#!/usr/bin/env python3
"""QFA-612-PREFLIGHT-02 minimal real ORDER_PLANT probe.

This is not production adapter code. It is a bounded evidence collector for the
Rithmic test environment. Raw output is intended for gitignored raw-local paths;
committed evidence is produced by order-plant-client.ts after redaction.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import importlib
import json
import os
import pathlib
import random
import shutil
import ssl
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from types import ModuleType
from typing import Any

os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")

REQUEST_LOGIN_TEMPLATE_ID = 10
REQUEST_LOGOUT_TEMPLATE_ID = 12
RESPONSE_LOGOUT_TEMPLATE_ID = 13
REQUEST_HEARTBEAT_TEMPLATE_ID = 18
REQUEST_MARKET_DATA_UPDATE_TEMPLATE_ID = 100
BEST_BID_OFFER_TEMPLATE_ID = 151
REQUEST_LOGIN_INFO_TEMPLATE_ID = 300
RESPONSE_ACCOUNT_LIST_TEMPLATE_ID = 303
REQUEST_ACCOUNT_LIST_TEMPLATE_ID = 302
REQUEST_SUBSCRIBE_ORDER_UPDATES_TEMPLATE_ID = 308
RESPONSE_SUBSCRIBE_ORDER_UPDATES_TEMPLATE_ID = 309
REQUEST_TRADE_ROUTES_TEMPLATE_ID = 310
RESPONSE_TRADE_ROUTES_TEMPLATE_ID = 311
REQUEST_NEW_ORDER_TEMPLATE_ID = 312
RESPONSE_NEW_ORDER_TEMPLATE_ID = 313
# RProtocol sample order ids expose 312/313 only. The SDK proto pool order places
# cancel after modify + modify-reference-data, making 318/319 the observed slot.
REQUEST_CANCEL_ORDER_TEMPLATE_ID = 318
RESPONSE_CANCEL_ORDER_TEMPLATE_ID = 319
RITHMIC_ORDER_NOTIFICATION_TEMPLATE_ID = 351
EXCHANGE_ORDER_NOTIFICATION_TEMPLATE_ID = 352

APP_NAME = "QuantFuturesPreflight02"
APP_VERSION = "0.2.0"
SYMBOL = "MNQM6"
EXCHANGE = "CME"
TICK_SIZE = 0.25
MAX_RECONNECT_ATTEMPTS = 5
BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]
JITTER_MAX_MS = 1000


class PreflightError(RuntimeError):
    pass


@dataclass(frozen=True)
class SdkPaths:
    home: pathlib.Path
    proto_dir: pathlib.Path
    sample_py_dir: pathlib.Path
    cert_path: pathlib.Path
    cache_dir: pathlib.Path


@dataclass
class SessionContext:
    ws: Any
    modules: dict[str, ModuleType]
    tls: dict[str, Any]
    login: dict[str, Any]
    account: dict[str, Any] | None = None
    trade_route: dict[str, Any] | None = None


def env_first(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return None


def require_env(*names: str) -> str:
    value = env_first(*names)
    if value:
        return value
    raise PreflightError(f"Missing required environment variable; expected one of: {', '.join(names)}")


def resolve_sdk_home(raw_home: str | None) -> pathlib.Path:
    if not raw_home:
        raise PreflightError("RITHMIC_RPROTOCOL_HOME is required")
    home = pathlib.Path(raw_home).expanduser().resolve()
    if (home / "proto").is_dir() and (home / "samples" / "samples.py").is_dir():
        return home
    candidates = [
        child
        for child in home.iterdir()
        if child.is_dir() and (child / "proto").is_dir() and (child / "samples" / "samples.py").is_dir()
    ]
    if len(candidates) == 1:
        return candidates[0]
    raise PreflightError("RITHMIC_RPROTOCOL_HOME must contain proto/ and samples/samples.py/")


def resolve_sdk_paths() -> SdkPaths:
    home = resolve_sdk_home(env_first("RITHMIC_RPROTOCOL_HOME"))
    cert_candidates = [
        home / "samples" / "samples.py" / "rithmic_ssl_cert_auth_params",
        home / "etc" / "rithmic_ssl_cert_auth_params",
    ]
    cert_path = next((path for path in cert_candidates if path.exists()), None)
    if cert_path is None:
        raise PreflightError("Missing rithmic_ssl_cert_auth_params in SDK")
    cache_dir = pathlib.Path(".cache/rprotocol_pb2").resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    return SdkPaths(home, home / "proto", home / "samples" / "samples.py", cert_path, cache_dir)


def insert_module_paths(paths: SdkPaths) -> None:
    for path in [paths.sample_py_dir, paths.cache_dir]:
        text = str(path)
        if text not in sys.path:
            sys.path.insert(0, text)


def compile_proto(paths: SdkPaths, proto_file: str) -> None:
    try:
        from grpc_tools import protoc  # type: ignore[import-not-found]

        result = protoc.main(
            ["grpc_tools.protoc", f"-I{paths.proto_dir}", f"--python_out={paths.cache_dir}", str(paths.proto_dir / proto_file)]
        )
        if result != 0:
            raise PreflightError(f"grpc_tools.protoc failed for {proto_file} with exit code {result}")
        return
    except ImportError:
        pass
    protoc_path = shutil.which("protoc")
    if protoc_path is None:
        raise PreflightError(f"No protobuf compiler available for {proto_file}; install grpcio-tools or protoc")
    result = subprocess.run(
        [protoc_path, f"-I{paths.proto_dir}", f"--python_out={paths.cache_dir}", str(paths.proto_dir / proto_file)],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise PreflightError(f"protoc failed for {proto_file}: {result.stderr.strip()}")


def import_or_compile(paths: SdkPaths, module_name: str, proto_file: str | None = None) -> ModuleType:
    insert_module_paths(paths)
    try:
        return importlib.import_module(module_name)
    except ImportError:
        if proto_file is None:
            raise
    compile_proto(paths, proto_file)
    importlib.invalidate_caches()
    return importlib.import_module(module_name)


def load_modules(paths: SdkPaths) -> dict[str, ModuleType]:
    import_or_compile(paths, "websockets")
    import_or_compile(paths, "google.protobuf.message")
    module_specs = {
        "base": ("base_pb2", None),
        "request_login": ("request_login_pb2", None),
        "response_login": ("response_login_pb2", None),
        "request_logout": ("request_logout_pb2", None),
        "response_logout": ("response_logout_pb2", None),
        "request_heartbeat": ("request_heartbeat_pb2", None),
        "request_login_info": ("request_login_info_pb2", None),
        "response_login_info": ("response_login_info_pb2", None),
        "request_account_list": ("request_account_list_pb2", None),
        "response_account_list": ("response_account_list_pb2", None),
        "request_trade_routes": ("request_trade_routes_pb2", None),
        "response_trade_routes": ("response_trade_routes_pb2", None),
        "request_subscribe_order_updates": ("request_subscribe_for_order_updates_pb2", None),
        "response_subscribe_order_updates": ("response_subscribe_for_order_updates_pb2", None),
        "request_new_order": ("request_new_order_pb2", None),
        "response_new_order": ("response_new_order_pb2", None),
        "rithmic_order_notification": ("rithmic_order_notification_pb2", None),
        "exchange_order_notification": ("exchange_order_notification_pb2", None),
        "request_cancel_order": ("request_cancel_order_pb2", "request_cancel_order.proto"),
        "response_cancel_order": ("response_cancel_order_pb2", "response_cancel_order.proto"),
        "request_market_data_update": ("request_market_data_update_pb2", None),
        "best_bid_offer": ("best_bid_offer_pb2", None),
    }
    return {key: import_or_compile(paths, module, proto_file) for key, (module, proto_file) in module_specs.items()}


def ssl_context(paths: SdkPaths) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(paths.cert_path)
    return context


def tls_details(ws: Any) -> dict[str, Any]:
    ssl_object = ws.transport.get_extra_info("ssl_object") if getattr(ws, "transport", None) else None
    if ssl_object is None:
        return {"available": False}
    peer_cert = ssl_object.getpeercert(binary_form=True)
    return {
        "available": True,
        "version": ssl_object.version(),
        "cipher": list(ssl_object.cipher() or []),
        "peer_cert_sha256": hashlib.sha256(peer_cert or b"").hexdigest() if peer_cert else None,
    }


async def connect(uri: str, context: ssl.SSLContext) -> Any:
    websockets = importlib.import_module("websockets")
    return await websockets.connect(uri, ssl=context, ping_interval=3)


async def send(ws: Any, message: Any) -> bytes:
    payload = message.SerializeToString()
    await ws.send(payload)
    return payload


def template_id(modules: dict[str, ModuleType], payload: bytes) -> int:
    base = modules["base"].Base()
    base.ParseFromString(payload)
    return int(base.template_id)


def repeated_strings(message: Any, field: str) -> list[str]:
    value = getattr(message, field, [])
    if isinstance(value, str):
        return [value]
    try:
        return [str(item) for item in value]
    except TypeError:
        return [str(value)]


def response_ok(message: Any) -> bool:
    codes = repeated_strings(message, "rp_code")
    handler = repeated_strings(message, "rq_handler_rp_code")
    return (not codes or codes[-1] == "0") and (not handler or handler[-1] == "0")


def msg_dict(message: Any, fields: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {"template_id": getattr(message, "template_id", None)}
    for field_name in fields:
        value = getattr(message, field_name, None)
        if value is None:
            continue
        if hasattr(value, "__iter__") and not isinstance(value, (str, bytes)):
            out[field_name] = [str(item) for item in value]
        else:
            out[field_name] = value
    return out


async def login(
    ws: Any,
    modules: dict[str, ModuleType],
    system: str,
    user: str,
    password: str,
    infra_type: int,
    user_msg: str,
) -> tuple[dict[str, Any], bytes, bytes]:
    request = modules["request_login"].RequestLogin()
    request.template_id = REQUEST_LOGIN_TEMPLATE_ID
    request.template_version = "3.9"
    request.user_msg.append(user_msg)
    request.user = user
    request.password = password
    request.app_name = APP_NAME
    request.app_version = APP_VERSION
    request.system_name = system
    request.infra_type = infra_type
    request_bytes = await send(ws, request)
    response_bytes = await asyncio.wait_for(ws.recv(), timeout=15)
    response = modules["response_login"].ResponseLogin()
    response.ParseFromString(response_bytes)
    parsed = msg_dict(response, ["user_msg", "rp_code", "fcm_id", "ib_id", "country_code", "state_code", "unique_user_id", "heartbeat_interval"])
    if not response_ok(response):
        raise PreflightError(f"ORDER_PLANT login failed: rp_code={parsed.get('rp_code')}")
    parsed["request_sha256"] = hashlib.sha256(request_bytes).hexdigest()
    parsed["response_sha256"] = hashlib.sha256(response_bytes).hexdigest()
    parsed["response_template_id"] = REQUEST_LOGIN_TEMPLATE_ID + 1
    return parsed, request_bytes, response_bytes


async def logout(ws: Any, modules: dict[str, ModuleType]) -> dict[str, Any]:
    request = modules["request_logout"].RequestLogout()
    request.template_id = REQUEST_LOGOUT_TEMPLATE_ID
    request.user_msg.append("qfa-612-preflight-02-logout")
    request_bytes = await send(ws, request)
    parsed: dict[str, Any] = {"request_template_id": REQUEST_LOGOUT_TEMPLATE_ID, "request_sha256": hashlib.sha256(request_bytes).hexdigest()}
    try:
        response_bytes = await asyncio.wait_for(ws.recv(), timeout=10)
        tid = template_id(modules, response_bytes)
        parsed["response_template_id"] = tid
        parsed["response_sha256"] = hashlib.sha256(response_bytes).hexdigest()
        if tid == RESPONSE_LOGOUT_TEMPLATE_ID:
            response = modules["response_logout"].ResponseLogout()
            response.ParseFromString(response_bytes)
            parsed.update(msg_dict(response, ["user_msg", "rp_code"]))
    except Exception as exc:
        parsed["response_error"] = str(exc)
    return parsed


async def open_order_session(
    uri: str,
    paths: SdkPaths,
    modules: dict[str, ModuleType],
    system: str,
    user: str,
    password: str,
    label: str,
) -> SessionContext:
    ws = await connect(uri, ssl_context(paths))
    tls = tls_details(ws)
    infra_type = modules["request_login"].RequestLogin.SysInfraType.ORDER_PLANT
    login_payload, _, _ = await login(ws, modules, system, user, password, infra_type, f"qfa-612-preflight-02-{label}")
    return SessionContext(ws=ws, modules=modules, tls=tls, login=login_payload)


async def login_info(ctx: SessionContext) -> dict[str, Any]:
    request = ctx.modules["request_login_info"].RequestLoginInfo()
    request.template_id = REQUEST_LOGIN_INFO_TEMPLATE_ID
    request.user_msg.append("qfa-612-preflight-02-login-info")
    await send(ctx.ws, request)
    response_bytes = await asyncio.wait_for(ctx.ws.recv(), timeout=10)
    response = ctx.modules["response_login_info"].ResponseLoginInfo()
    response.ParseFromString(response_bytes)
    parsed = msg_dict(response, ["user_msg", "rp_code", "fcm_id", "ib_id", "first_name", "last_name", "user_type"])
    if not response_ok(response):
        raise PreflightError(f"login_info failed: {parsed}")
    return parsed


async def list_accounts(ctx: SessionContext, login_info_payload: dict[str, Any]) -> dict[str, Any]:
    request = ctx.modules["request_account_list"].RequestAccountList()
    request.template_id = REQUEST_ACCOUNT_LIST_TEMPLATE_ID
    request.user_msg.append("qfa-612-preflight-02-account-list")
    request.fcm_id = str(login_info_payload.get("fcm_id") or "")
    request.ib_id = str(login_info_payload.get("ib_id") or "")
    request.user_type = int(login_info_payload.get("user_type") or 3)
    await send(ctx.ws, request)
    selected: dict[str, Any] | None = None
    observed = 0
    while True:
        response_bytes = await asyncio.wait_for(ctx.ws.recv(), timeout=15)
        if template_id(ctx.modules, response_bytes) != RESPONSE_ACCOUNT_LIST_TEMPLATE_ID:
            continue
        observed += 1
        response = ctx.modules["response_account_list"].ResponseAccountList()
        response.ParseFromString(response_bytes)
        if selected is None and repeated_strings(response, "rq_handler_rp_code")[-1:] == ["0"] and getattr(response, "account_id", ""):
            selected = {"fcm_id": response.fcm_id, "ib_id": response.ib_id, "account_id": response.account_id}
        if repeated_strings(response, "rp_code"):
            break
    if selected is None:
        raise PreflightError("No tradeable account returned by ORDER_PLANT account list")
    selected["observed_response_count"] = observed
    return selected


async def list_trade_routes(ctx: SessionContext, exchange: str) -> dict[str, Any]:
    if ctx.account is None:
        raise PreflightError("account context required before trade routes")
    request = ctx.modules["request_trade_routes"].RequestTradeRoutes()
    request.template_id = REQUEST_TRADE_ROUTES_TEMPLATE_ID
    request.user_msg.append("qfa-612-preflight-02-trade-routes")
    request.subscribe_for_updates = False
    await send(ctx.ws, request)
    selected: dict[str, Any] | None = None
    observed = 0
    while True:
        response_bytes = await asyncio.wait_for(ctx.ws.recv(), timeout=15)
        if template_id(ctx.modules, response_bytes) != RESPONSE_TRADE_ROUTES_TEMPLATE_ID:
            continue
        observed += 1
        response = ctx.modules["response_trade_routes"].ResponseTradeRoutes()
        response.ParseFromString(response_bytes)
        if (
            repeated_strings(response, "rq_handler_rp_code")[-1:] == ["0"]
            and response.exchange == exchange
            and response.fcm_id == ctx.account["fcm_id"]
            and response.ib_id == ctx.account["ib_id"]
            and response.trade_route
        ):
            selected = {"trade_route": response.trade_route, "exchange": response.exchange, "status": response.status, "is_default": bool(response.is_default)}
        if repeated_strings(response, "rp_code"):
            break
    if selected is None:
        raise PreflightError(f"No trade route returned for {exchange}")
    selected["observed_response_count"] = observed
    return selected


async def subscribe_order_updates(ctx: SessionContext) -> dict[str, Any]:
    if ctx.account is None:
        raise PreflightError("account context required before order-update subscribe")
    request = ctx.modules["request_subscribe_order_updates"].RequestSubscribeForOrderUpdates()
    request.template_id = REQUEST_SUBSCRIBE_ORDER_UPDATES_TEMPLATE_ID
    request.user_msg.append("qfa-612-preflight-02-order-updates")
    request.fcm_id = ctx.account["fcm_id"]
    request.ib_id = ctx.account["ib_id"]
    request.account_id = ctx.account["account_id"]
    await send(ctx.ws, request)
    response_bytes = await asyncio.wait_for(ctx.ws.recv(), timeout=15)
    response = ctx.modules["response_subscribe_order_updates"].ResponseSubscribeForOrderUpdates()
    response.ParseFromString(response_bytes)
    parsed = msg_dict(response, ["user_msg", "rp_code"])
    if not response_ok(response):
        raise PreflightError(f"order update subscription failed: {parsed}")
    return parsed


async def bootstrap_order_session(ctx: SessionContext, exchange: str) -> dict[str, Any]:
    info = await login_info(ctx)
    ctx.account = await list_accounts(ctx, info)
    ctx.trade_route = await list_trade_routes(ctx, exchange)
    subscribe = await subscribe_order_updates(ctx)
    return {"login_info": info, "account": ctx.account, "trade_route": ctx.trade_route, "subscribe_order_updates": subscribe}


async def fetch_bbo(uri: str, paths: SdkPaths, modules: dict[str, ModuleType], system: str, user: str, password: str) -> dict[str, Any]:
    ws = await connect(uri, ssl_context(paths))
    try:
        infra_type = modules["request_login"].RequestLogin.SysInfraType.TICKER_PLANT
        await login(ws, modules, system, user, password, infra_type, "qfa-612-preflight-02-bbo")
        bits = modules["request_market_data_update"].RequestMarketDataUpdate.UpdateBits
        request = modules["request_market_data_update"].RequestMarketDataUpdate()
        request.template_id = REQUEST_MARKET_DATA_UPDATE_TEMPLATE_ID
        request.user_msg.append("qfa-612-preflight-02-bbo")
        request.symbol = SYMBOL
        request.exchange = EXCHANGE
        request.request = modules["request_market_data_update"].RequestMarketDataUpdate.Request.SUBSCRIBE
        request.update_bits = bits.BBO
        await send(ws, request)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            payload = await asyncio.wait_for(ws.recv(), timeout=5)
            if template_id(modules, payload) != BEST_BID_OFFER_TEMPLATE_ID:
                continue
            bbo = modules["best_bid_offer"].BestBidOffer()
            bbo.ParseFromString(payload)
            fields = {field.name: getattr(bbo, field.name) for field in bbo.DESCRIPTOR.fields if hasattr(bbo, field.name)}
            bid = float(fields.get("bid_price") or fields.get("best_bid_price") or fields.get("bid") or fields.get("buy_price") or 0)
            ask = float(fields.get("ask_price") or fields.get("best_ask_price") or fields.get("ask") or fields.get("sell_price") or fields.get("offer_price") or 0)
            if bid > 0 and ask > 0:
                return {"bid": bid, "ask": ask, "spread": ask - bid, "template_id": BEST_BID_OFFER_TEMPLATE_ID}
        raise PreflightError("No BBO received within 20s")
    finally:
        with contextlib.suppress(Exception):
            await logout(ws, modules)
        with contextlib.suppress(Exception):
            await ws.close(1000, "qfa-612-preflight-02-bbo-complete")


async def submit_order(
    ctx: SessionContext,
    *,
    user_tag: str,
    side: str,
    price_type: str,
    price: float | None,
    quantity: int,
    duration: str = "DAY",
    cancel_after_secs: int | None = None,
) -> dict[str, Any]:
    if ctx.account is None or ctx.trade_route is None:
        raise PreflightError("account and trade-route context required before submit")
    req_mod = ctx.modules["request_new_order"].RequestNewOrder
    request = req_mod()
    request.template_id = REQUEST_NEW_ORDER_TEMPLATE_ID
    request.user_msg.append(user_tag)
    request.user_tag = user_tag
    request.fcm_id = ctx.account["fcm_id"]
    request.ib_id = ctx.account["ib_id"]
    request.account_id = ctx.account["account_id"]
    request.exchange = EXCHANGE
    request.symbol = SYMBOL
    request.quantity = quantity
    request.transaction_type = req_mod.TransactionType.BUY if side == "BUY" else req_mod.TransactionType.SELL
    request.duration = getattr(req_mod.Duration, duration)
    request.price_type = getattr(req_mod.PriceType, price_type)
    request.manual_or_auto = req_mod.OrderPlacement.MANUAL
    request.trade_route = ctx.trade_route["trade_route"]
    if price is not None:
        request.price = float(price)
    if cancel_after_secs is not None:
        request.cancel_after_secs = int(cancel_after_secs)
    request_bytes = await send(ctx.ws, request)
    return {"user_tag": user_tag, "request_sha256": hashlib.sha256(request_bytes).hexdigest(), "side": side, "price_type": price_type, "price": price, "quantity": quantity, "duration": duration}


async def cancel_order(ctx: SessionContext, basket_id: str) -> dict[str, Any]:
    if ctx.account is None:
        raise PreflightError("account context required before cancel")
    req_mod = ctx.modules["request_cancel_order"].RequestCancelOrder
    request = req_mod()
    request.template_id = REQUEST_CANCEL_ORDER_TEMPLATE_ID
    request.user_msg.append("qfa-612-preflight-02-cancel")
    request.fcm_id = ctx.account["fcm_id"]
    request.ib_id = ctx.account["ib_id"]
    request.account_id = ctx.account["account_id"]
    request.basket_id = basket_id
    request.manual_or_auto = req_mod.OrderPlacement.MANUAL
    request_bytes = await send(ctx.ws, request)
    return {"basket_id": basket_id, "request_template_id": REQUEST_CANCEL_ORDER_TEMPLATE_ID, "request_sha256": hashlib.sha256(request_bytes).hexdigest()}


def parse_order_message(modules: dict[str, ModuleType], payload: bytes) -> dict[str, Any]:
    tid = template_id(modules, payload)
    parsed: dict[str, Any] = {"template_id": tid, "wire_sha256": hashlib.sha256(payload).hexdigest(), "wire_size": len(payload)}
    if tid == RESPONSE_NEW_ORDER_TEMPLATE_ID:
        msg = modules["response_new_order"].ResponseNewOrder()
        msg.ParseFromString(payload)
        parsed.update({"message_type": "response_new_order", **msg_dict(msg, ["user_msg", "user_tag", "rq_handler_rp_code", "rp_code", "basket_id", "ssboe", "usecs"])})
    elif tid == RESPONSE_CANCEL_ORDER_TEMPLATE_ID:
        msg = modules["response_cancel_order"].ResponseCancelOrder()
        msg.ParseFromString(payload)
        parsed.update({"message_type": "response_cancel_order", **msg_dict(msg, ["user_msg", "rq_handler_rp_code", "rp_code", "basket_id", "ssboe", "usecs"])})
    elif tid == RITHMIC_ORDER_NOTIFICATION_TEMPLATE_ID:
        msg = modules["rithmic_order_notification"].RithmicOrderNotification()
        msg.ParseFromString(payload)
        parsed.update({"message_type": "rithmic_order_notification", **msg_dict(msg, ["user_tag", "notify_type", "is_snapshot", "status", "basket_id", "original_basket_id", "fcm_id", "ib_id", "account_id", "symbol", "exchange", "trade_route", "exchange_order_id", "quantity", "price", "transaction_type", "duration", "price_type", "avg_fill_price", "total_fill_size", "total_unfilled_size", "sequence_number", "orig_sequence_number", "cor_sequence_number", "text", "report_text", "remarks", "ssboe", "usecs"])})
    elif tid == EXCHANGE_ORDER_NOTIFICATION_TEMPLATE_ID:
        msg = modules["exchange_order_notification"].ExchangeOrderNotification()
        msg.ParseFromString(payload)
        parsed.update({"message_type": "exchange_order_notification", **msg_dict(msg, ["user_tag", "notify_type", "is_snapshot", "report_type", "status", "basket_id", "original_basket_id", "fcm_id", "ib_id", "account_id", "symbol", "exchange", "trade_route", "exchange_order_id", "quantity", "price", "transaction_type", "duration", "price_type", "confirmed_size", "confirmed_id", "cancelled_size", "cancelled_id", "fill_price", "fill_size", "fill_id", "avg_fill_price", "total_fill_size", "total_unfilled_size", "sequence_number", "orig_sequence_number", "cor_sequence_number", "text", "report_text", "remarks", "ssboe", "usecs", "exch_receipt_ssboe", "exch_receipt_nsecs"])})
    else:
        parsed["message_type"] = "other"
    return parsed


async def collect_until(ctx: SessionContext, predicate: Any, timeout_sec: float, max_messages: int = 40) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline and len(events) < max_messages:
        try:
            payload = await asyncio.wait_for(ctx.ws.recv(), timeout=min(5, max(0.1, deadline - time.monotonic())))
        except asyncio.TimeoutError:
            heartbeat = ctx.modules["request_heartbeat"].RequestHeartbeat()
            heartbeat.template_id = REQUEST_HEARTBEAT_TEMPLATE_ID
            await send(ctx.ws, heartbeat)
            continue
        event = parse_order_message(ctx.modules, payload)
        events.append(event)
        if predicate(event, events):
            break
    return events


async def run_reconnect_checks(uri: str, paths: SdkPaths, modules: dict[str, ModuleType], system: str, user: str, password: str) -> dict[str, Any]:
    ctx = await open_order_session(uri, paths, modules, system, user, password, "orderly-reconnect-start")
    started = time.monotonic()
    logout_payload = await logout(ctx.ws, modules)
    await ctx.ws.close(1000, "qfa-612-preflight-02-orderly")
    close_code = getattr(ctx.ws, "close_code", None)
    reconnect_started = time.monotonic()
    ctx2 = await open_order_session(uri, paths, modules, system, user, password, "orderly-reconnect-finish")
    orderly = {
        "status": "PASS",
        "logout": logout_payload,
        "close_code": close_code,
        "reauth_duration_ms": round((time.monotonic() - reconnect_started) * 1000, 3),
        "total_duration_ms": round((time.monotonic() - started) * 1000, 3),
        "tls_after_reconnect": ctx2.tls,
    }
    await logout(ctx2.ws, modules)
    await ctx2.ws.close(1000, "qfa-612-preflight-02-orderly-complete")

    disorderly_attempts: list[dict[str, Any]] = []
    ctx3 = await open_order_session(uri, paths, modules, system, user, password, "disorderly-reconnect-start")
    with contextlib.suppress(Exception):
        ctx3.ws.transport.abort()
    rng = random.Random(61202)
    success = False
    total_start = time.monotonic()
    for attempt in range(1, MAX_RECONNECT_ATTEMPTS + 1):
        backoff_ms = BACKOFF_MS[min(attempt - 1, len(BACKOFF_MS) - 1)]
        jitter_ms = int(rng.random() * JITTER_MAX_MS)
        await asyncio.sleep((backoff_ms + jitter_ms) / 1000.0)
        attempt_start = time.monotonic()
        try:
            ctx4 = await open_order_session(uri, paths, modules, system, user, password, f"disorderly-reconnect-attempt-{attempt}")
            disorderly_attempts.append({"attempt": attempt, "backoff_ms": backoff_ms, "jitter_ms": jitter_ms, "result": "success", "reauth_duration_ms": round((time.monotonic() - attempt_start) * 1000, 3)})
            await logout(ctx4.ws, modules)
            await ctx4.ws.close(1000, "qfa-612-preflight-02-disorderly-complete")
            success = True
            break
        except Exception as exc:
            disorderly_attempts.append({"attempt": attempt, "backoff_ms": backoff_ms, "jitter_ms": jitter_ms, "result": "failure", "error": str(exc)})
    return {
        "orderly": orderly,
        "disorderly": {
            "status": "PASS" if success else "FAIL",
            "attempts": disorderly_attempts,
            "total_duration_ms": round((time.monotonic() - total_start) * 1000, 3),
            "configured_worst_case_ms": 91000,
        },
    }


async def run_order_checks(uri: str, paths: SdkPaths, modules: dict[str, ModuleType], system: str, user: str, password: str) -> dict[str, Any]:
    ctx = await open_order_session(uri, paths, modules, system, user, password, "order-lifecycle")
    lifecycle: dict[str, Any] = {"net_position_delta": 0, "flatten_attempted": False, "flatten_result": "not_needed"}
    try:
        lifecycle["bootstrap"] = await bootstrap_order_session(ctx, EXCHANGE)
        bbo = await fetch_bbo(uri, paths, modules, system, user, password)
        lifecycle["bbo"] = bbo

        far_buy = round(float(bbo["bid"]) - (50 * TICK_SIZE), 2)
        submit = await submit_order(ctx, user_tag="qfa612pf02-cancelable", side="BUY", price_type="LIMIT", price=far_buy, quantity=1, duration="DAY", cancel_after_secs=30)
        events = await collect_until(ctx, lambda event, _: event.get("message_type") == "response_new_order", 20)
        basket_id = next((str(event.get("basket_id")) for event in events if event.get("basket_id")), "")
        cancel_payload: dict[str, Any] | None = None
        if basket_id:
            cancel_payload = await cancel_order(ctx, basket_id)
        cancel_events = await collect_until(
            ctx,
            lambda _event, all_events: any(e.get("message_type") == "response_cancel_order" for e in all_events)
            or any(str(e.get("status", "")).lower() in {"complete", "cancelled", "canceled"} for e in all_events),
            45,
        )
        lifecycle["cancelable_limit"] = {"status": "PASS" if basket_id and cancel_events else "HOLD", "submit": submit, "basket_id": basket_id, "cancel_request": cancel_payload, "events": events + cancel_events}

        reject_submit = await submit_order(ctx, user_tag="qfa612pf02-reject", side="BUY", price_type="LIMIT", price=far_buy, quantity=0, duration="DAY")
        reject_events = await collect_until(
            ctx,
            lambda _event, all_events: any(e.get("message_type") == "response_new_order" and (e.get("rp_code") or e.get("rq_handler_rp_code")) for e in all_events)
            or any(str(e.get("message_type")) in {"exchange_order_notification", "rithmic_order_notification"} and ("reject" in str(e.get("status", "")).lower() or "reject" in str(e.get("report_text", "")).lower()) for e in all_events),
            20,
        )
        lifecycle["broker_reject"] = {"status": "PASS" if reject_events else "HOLD", "submit": reject_submit, "events": reject_events, "failure_taxonomy_mapping": {"category": "unknown", "subreason": "unrecognized", "note": "Concrete mapping must be selected from broker reject text in QFA-612-PAPER-01b."}}

        lifecycle["fillable_marketable_limit"] = {
            "status": "HOLD",
            "reason": "Pre-submit external flat-position query is not available through the minimal ORDER_PLANT-only preflight path. The script refused to place a fillable order rather than violate the safety invariant.",
            "position_invariant": "not_executed_no_position_change",
        }
        return lifecycle
    finally:
        with contextlib.suppress(Exception):
            await logout(ctx.ws, modules)
        with contextlib.suppress(Exception):
            await ctx.ws.close(1000, "qfa-612-preflight-02-order-checks-complete")


async def run(_args: argparse.Namespace) -> dict[str, Any]:
    uri = require_env("RITHMIC_TEST_WS_URL", "RITHMIC_WS_URL", "RITHMIC_TEST_GATEWAY_URL", "RITHMIC_CONNECT_POINT")
    system = require_env("RITHMIC_TEST_SYSTEM", "RITHMIC_SYSTEM", "RITHMIC_TEST_SYSTEM_NAME", "RITHMIC_SYSTEM_NAME")
    user = require_env("RITHMIC_TEST_USER", "RITHMIC_USER", "RITHMIC_TEST_USERNAME")
    password = require_env("RITHMIC_TEST_PASSWORD", "RITHMIC_PASSWORD")
    paths = resolve_sdk_paths()
    modules = load_modules(paths)
    result: dict[str, Any] = {
        "ticket": "QFA-612-PREFLIGHT-02",
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "environment": {"system_name": system, "gateway_url": uri, "symbol": SYMBOL, "exchange": EXCHANGE},
        "checks": {},
        "final_disposition": "HOLD",
    }
    try:
        ctx = await open_order_session(uri, paths, modules, system, user, password, "tls-auth-upgrade")
        result["checks"]["check_01_tls_auth"] = {"status": "PASS", "tls": ctx.tls, "auth_ack": ctx.login}
        logout_payload = await logout(ctx.ws, modules)
        await ctx.ws.close(1000, "qfa-612-preflight-02-check-01")
        result["checks"]["check_06_logout_close"] = {"status": "PASS_PARTIAL", "logout": logout_payload, "close_code": getattr(ctx.ws, "close_code", None), "note": "websockets exposes close code/reason, not raw RFC6455 close-frame bytes."}
    except Exception as exc:
        result["checks"]["check_01_tls_auth"] = {"status": "FAIL", "error": str(exc)}
        result["checks"]["check_06_logout_close"] = {"status": "FAIL", "error": str(exc)}
        return result

    try:
        result["checks"]["check_04_reconnect"] = await run_reconnect_checks(uri, paths, modules, system, user, password)
    except Exception as exc:
        result["checks"]["check_04_reconnect"] = {"status": "FAIL", "error": str(exc)}

    try:
        order_checks = await run_order_checks(uri, paths, modules, system, user, password)
        result["checks"]["check_05_order_lifecycle"] = order_checks
        decoded_types: list[str] = []
        for section in ["cancelable_limit", "broker_reject"]:
            for event in order_checks.get(section, {}).get("events", []):
                message_type = str(event.get("message_type"))
                if message_type != "other" and message_type not in decoded_types:
                    decoded_types.append(message_type)
        result["checks"]["check_02_order_framing"] = {"status": "PASS_PARTIAL" if len(decoded_types) < 3 else "PASS", "decoded_message_types": decoded_types, "required_representative_types": 3}
    except Exception as exc:
        result["checks"]["check_05_order_lifecycle"] = {"status": "FAIL", "error": str(exc), "net_position_delta": 0}
        result["checks"]["check_02_order_framing"] = {"status": "FAIL", "error": str(exc)}

    statuses = json.dumps(result["checks"])
    if '"HOLD"' not in statuses and '"FAIL"' not in statuses and "PASS_PARTIAL" not in statuses:
        result["final_disposition"] = "PROCEED"
    result["completed_at_utc"] = datetime.now(timezone.utc).isoformat()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Run QFA-612-PREFLIGHT-02 ORDER_PLANT evidence capture")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        payload = asyncio.run(run(args))
    except Exception as exc:
        payload = {"ticket": "QFA-612-PREFLIGHT-02", "final_disposition": "HOLD", "fatal_error": str(exc), "completed_at_utc": datetime.now(timezone.utc).isoformat()}
    out_path = pathlib.Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf8")
    print(json.dumps({"out": str(out_path), "final_disposition": payload.get("final_disposition")}, sort_keys=True))
    return 0 if payload.get("final_disposition") == "PROCEED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
