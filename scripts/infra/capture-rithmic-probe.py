#!/usr/bin/env python3
"""INFRA-01 Rithmic RProtocol timestamp-evidence collector.

This utility is intentionally not a runtime sidecar. It captures timestamp
evidence from TICKER_PLANT market-data streams into JSONL for
scripts/infra/evaluate-infra-01-probe.ts.
"""

from __future__ import annotations

import os

# RProtocolAPI 0.89 sample pb2 files are old descriptor-style protobuf outputs.
# The pure-Python protobuf implementation is required unless the SDK pb2 files are regenerated.
os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")

import argparse
import asyncio
import base64
import contextlib
import importlib
import json
import pathlib
import shutil
import ssl
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass
from types import ModuleType
from typing import Any


PROBE_SCHEMA_VERSION = 1
APP_NAME = "QuantFuturesInfra01Probe"
APP_VERSION = "0.1.0"
TICKER_PLANT_NAME = "TICKER_PLANT"

REQUEST_LOGIN_TEMPLATE_ID = 10
REQUEST_LOGOUT_TEMPLATE_ID = 12
RESPONSE_LOGOUT_TEMPLATE_ID = 13
REQUEST_RITHMIC_SYSTEM_INFO_TEMPLATE_ID = 16
REQUEST_HEARTBEAT_TEMPLATE_ID = 18
RESPONSE_HEARTBEAT_TEMPLATE_ID = 19
REQUEST_MARKET_DATA_UPDATE_TEMPLATE_ID = 100
RESPONSE_MARKET_DATA_UPDATE_TEMPLATE_ID = 101
LAST_TRADE_TEMPLATE_ID = 150
BEST_BID_OFFER_TEMPLATE_ID = 151
ORDER_BOOK_TEMPLATE_ID = 156
REQUEST_DEPTH_BY_ORDER_UPDATES_TEMPLATE_ID = 117
RESPONSE_DEPTH_BY_ORDER_UPDATES_TEMPLATE_ID = 118
DEPTH_BY_ORDER_TEMPLATE_ID = 160
DEPTH_BY_ORDER_END_EVENT_TEMPLATE_ID = 161

VALID_STREAMS = ("LAST_TRADE", "L1_QUOTE", "MBP10", "MBO")
DEFAULT_STREAMS = ",".join(VALID_STREAMS)

MBP10_GENERATED_PROTO_MODULES = {
    "order_book_pb2": "order_book.proto",
}

MBO_GENERATED_PROTO_MODULES = {
    "request_depth_by_order_updates_pb2": "request_depth_by_order_updates.proto",
    "response_depth_by_order_updates_pb2": "response_depth_by_order_updates.proto",
    "depth_by_order_pb2": "depth_by_order.proto",
}

OPTIONAL_MBO_GENERATED_PROTO_MODULES = {
    "depth_by_order_end_event_pb2": "depth_by_order_end_event.proto",
}


class ProbeConfigError(RuntimeError):
    """Raised for actionable operator/setup errors."""


@dataclass(frozen=True)
class SdkPaths:
    home: pathlib.Path
    proto_dir: pathlib.Path
    sample_py_dir: pathlib.Path
    cert_path: pathlib.Path
    cache_dir: pathlib.Path


@dataclass(frozen=True)
class RProtocolModules:
    base: ModuleType
    request_heartbeat: ModuleType
    response_heartbeat: ModuleType
    request_rithmic_system_info: ModuleType
    response_rithmic_system_info: ModuleType
    request_login: ModuleType
    response_login: ModuleType
    request_logout: ModuleType
    response_logout: ModuleType
    request_market_data_update: ModuleType
    response_market_data_update: ModuleType
    last_trade: ModuleType
    best_bid_offer: ModuleType
    request_depth_by_order_updates: ModuleType | None
    response_depth_by_order_updates: ModuleType | None
    order_book: ModuleType | None
    depth_by_order: ModuleType | None
    depth_by_order_end_event: ModuleType | None


@dataclass
class ProbeSummary:
    records_by_stream: Counter[str]
    unknown_template_ids: Counter[int]
    first_sidecar_recv_ts_ns: str | None = None
    last_sidecar_recv_ts_ns: str | None = None
    error_count: int = 0

    def observe_record(self, stream: str, sidecar_recv_ts_ns: str) -> None:
        self.records_by_stream[stream] += 1
        if self.first_sidecar_recv_ts_ns is None:
            self.first_sidecar_recv_ts_ns = sidecar_recv_ts_ns
        self.last_sidecar_recv_ts_ns = sidecar_recv_ts_ns


def parse_streams(raw_streams: str) -> frozenset[str]:
    streams = [stream.strip().upper() for stream in raw_streams.split(",") if stream.strip()]
    if not streams:
        raise argparse.ArgumentTypeError("--streams must include at least one stream")

    invalid_streams = sorted({stream for stream in streams if stream not in VALID_STREAMS})
    if invalid_streams:
        raise argparse.ArgumentTypeError(
            "Unsupported --streams value(s): "
            f"{', '.join(invalid_streams)}. Allowed values: {', '.join(VALID_STREAMS)}",
        )

    return frozenset(streams)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture INFRA-01 Rithmic TICKER_PLANT timestamp evidence.",
    )
    parser.add_argument("--connect-point", default=os.getenv("RITHMIC_CONNECT_POINT"))
    parser.add_argument("--system-name", default=os.getenv("RITHMIC_SYSTEM_NAME"))
    parser.add_argument("--user", default=os.getenv("RITHMIC_USER"))
    parser.add_argument("--password", default=os.getenv("RITHMIC_PASSWORD"))
    parser.add_argument("--symbol", default="MNQM6")
    parser.add_argument("--exchange", default="CME")
    parser.add_argument("--duration-sec", type=int, default=2100)
    parser.add_argument("--out")
    parser.add_argument("--rprotocol-home", default=os.getenv("RITHMIC_RPROTOCOL_HOME"))
    parser.add_argument("--raw", action="store_true", default=False)
    parser.add_argument("--list-systems", action="store_true")
    parser.add_argument(
        "--streams",
        type=parse_streams,
        default=parse_streams(DEFAULT_STREAMS),
        help=(
            "Comma-separated market-data streams to subscribe/parse. "
            f"Allowed: {','.join(VALID_STREAMS)}. Default: {DEFAULT_STREAMS}."
        ),
    )
    parser.add_argument("--order-book-template-id", type=int, default=ORDER_BOOK_TEMPLATE_ID)
    parser.add_argument("--depth-by-order-template-id", type=int, default=DEPTH_BY_ORDER_TEMPLATE_ID)
    parser.add_argument(
        "--request-depth-by-order-template-id",
        type=int,
        default=REQUEST_DEPTH_BY_ORDER_UPDATES_TEMPLATE_ID,
    )
    parser.add_argument(
        "--response-depth-by-order-template-id",
        type=int,
        default=RESPONSE_DEPTH_BY_ORDER_UPDATES_TEMPLATE_ID,
    )
    parser.add_argument(
        "--depth-by-order-end-event-template-id",
        type=int,
        default=DEPTH_BY_ORDER_END_EVENT_TEMPLATE_ID,
    )
    return parser.parse_args()


def fail(message: str) -> None:
    raise ProbeConfigError(message)


def require_value(value: str | None, label: str, env_name: str | None = None) -> str:
    if value:
        return value
    suffix = f" or set {env_name}" if env_name else ""
    fail(f"{label} is required{suffix}")


def resolve_sdk_home(raw_home: str | None) -> pathlib.Path:
    home_text = require_value(raw_home, "--rprotocol-home", "RITHMIC_RPROTOCOL_HOME")
    home = pathlib.Path(home_text).expanduser().resolve()
    if home.suffix.lower() == ".zip":
        fail(
            "RITHMIC_RPROTOCOL_HOME must point to an extracted RProtocol API directory, "
            "not the zip file.",
        )
    if not home.exists():
        fail(f"RITHMIC_RPROTOCOL_HOME does not exist: {home}")
    if (home / "proto").is_dir() and (home / "samples" / "samples.py").is_dir():
        return home

    candidates = [
        child
        for child in home.iterdir()
        if child.is_dir()
        and (child / "proto").is_dir()
        and (child / "samples" / "samples.py").is_dir()
    ]
    if len(candidates) == 1:
        return candidates[0]

    fail(
        "RITHMIC_RPROTOCOL_HOME must contain proto/ and samples/samples.py/ "
        "or a single child directory with that layout.",
    )


def resolve_sdk_paths(raw_home: str | None) -> SdkPaths:
    home = resolve_sdk_home(raw_home)
    proto_dir = home / "proto"
    sample_py_dir = home / "samples" / "samples.py"
    cert_candidates = [
        sample_py_dir / "rithmic_ssl_cert_auth_params",
        home / "etc" / "rithmic_ssl_cert_auth_params",
    ]
    cert_path = next((candidate for candidate in cert_candidates if candidate.exists()), None)
    if cert_path is None:
        fail(
            "Missing rithmic_ssl_cert_auth_params. Expected it in samples/samples.py/ "
            "or etc/ under RITHMIC_RPROTOCOL_HOME.",
        )

    required_proto_files = [
        "request_market_data_update.proto",
        "request_depth_by_order_updates.proto",
        "response_depth_by_order_updates.proto",
        "order_book.proto",
        "depth_by_order.proto",
        "last_trade.proto",
        "best_bid_offer.proto",
    ]
    missing_proto = [name for name in required_proto_files if not (proto_dir / name).exists()]
    if missing_proto:
        fail(f"Missing required RProtocol proto files: {', '.join(missing_proto)}")

    required_sample_pb2 = [
        "base_pb2.py",
        "request_heartbeat_pb2.py",
        "response_heartbeat_pb2.py",
        "request_rithmic_system_info_pb2.py",
        "response_rithmic_system_info_pb2.py",
        "request_login_pb2.py",
        "response_login_pb2.py",
        "request_logout_pb2.py",
        "response_logout_pb2.py",
        "request_market_data_update_pb2.py",
        "response_market_data_update_pb2.py",
        "last_trade_pb2.py",
        "best_bid_offer_pb2.py",
    ]
    missing_pb2 = [name for name in required_sample_pb2 if not (sample_py_dir / name).exists()]
    if missing_pb2:
        fail(f"Missing required generated sample pb2 files: {', '.join(missing_pb2)}")

    paths = SdkPaths(
        home=home,
        proto_dir=proto_dir,
        sample_py_dir=sample_py_dir,
        cert_path=cert_path,
        cache_dir=(pathlib.Path(".cache") / "rprotocol_pb2").resolve(),
    )
    paths.cache_dir.mkdir(parents=True, exist_ok=True)
    return paths


def require_python_dependency(module_name: str, install_hint: str) -> None:
    try:
        importlib.import_module(module_name)
    except ImportError as exc:
        fail(f"Missing Python dependency {module_name}. Install with: {install_hint}. ({exc})")


def insert_module_paths(paths: SdkPaths) -> None:
    for search_path in [paths.sample_py_dir, paths.cache_dir]:
        text_path = str(search_path.resolve())
        if text_path not in sys.path:
            sys.path.insert(0, text_path)


def print_startup_diagnostic(paths: SdkPaths) -> None:
    protobuf = importlib.import_module("google.protobuf")
    payload = {
        "diagnostic": "rprotocol_probe_startup",
        "protobuf_version": str(getattr(protobuf, "__version__", "unknown")),
        "PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION": os.getenv(
            "PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION",
            "",
        ),
        "RITHMIC_RPROTOCOL_HOME": str(paths.home),
        "sample_pb2_path": str(paths.sample_py_dir),
    }
    print(json.dumps(payload, sort_keys=True), file=sys.stderr)


def grpc_tools_protoc_command(proto_dir: pathlib.Path, cache_dir: pathlib.Path, proto_file: str) -> list[str]:
    return [
        "grpc_tools.protoc",
        f"-I{proto_dir}",
        f"--python_out={cache_dir}",
        str(proto_dir / proto_file),
    ]


def standalone_protoc_command(proto_dir: pathlib.Path, cache_dir: pathlib.Path, proto_file: str) -> list[str] | None:
    protoc_path = shutil.which("protoc")
    if protoc_path is None:
        return None
    return [protoc_path, f"-I{proto_dir}", f"--python_out={cache_dir}", str(proto_dir / proto_file)]


def format_command(command: list[str] | None) -> str:
    if command is None:
        return "not run"
    return " ".join(f'"{part}"' if " " in part else part for part in command)


def protobuf_actionable_context(
    *,
    paths: SdkPaths,
    command_used: list[str] | None,
    expected_path: pathlib.Path,
) -> str:
    return "\n".join(
        [
            f"RITHMIC_RPROTOCOL_HOME: {paths.home}",
            f"proto_dir: {paths.proto_dir}",
            f"cache_dir: {paths.cache_dir}",
            f"protoc command used: {format_command(command_used)}",
            f"expected generated file path: {expected_path}",
        ],
    )


def compile_proto_with_grpc_tools(
    proto_dir: pathlib.Path,
    cache_dir: pathlib.Path,
    proto_file: str,
) -> list[str] | None:
    try:
        from grpc_tools import protoc  # type: ignore[import-not-found]
    except ImportError:
        return None

    command = grpc_tools_protoc_command(proto_dir, cache_dir, proto_file)
    result = protoc.main(command)
    if result != 0:
        fail(f"grpc_tools.protoc failed for {proto_file} with exit code {result}")
    return command


def compile_proto_with_protoc(
    proto_dir: pathlib.Path,
    cache_dir: pathlib.Path,
    proto_file: str,
) -> list[str] | None:
    command = standalone_protoc_command(proto_dir, cache_dir, proto_file)
    if command is None:
        return None
    result = subprocess.run(
        command,
        check=False,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        fail(
            f"protoc failed for {proto_file} with exit code {result.returncode}: "
            f"{result.stderr.strip()}",
        )
    return command


def ensure_generated_pb2_module(module_name: str, proto_file: str, paths: SdkPaths) -> ModuleType:
    insert_module_paths(paths)
    try:
        return importlib.import_module(module_name)
    except ImportError:
        pass

    paths.cache_dir.mkdir(parents=True, exist_ok=True)
    generated_path = paths.cache_dir / f"{module_name}.py"
    command_used: list[str] | None = None
    if not generated_path.exists():
        command_used = compile_proto_with_grpc_tools(paths.proto_dir, paths.cache_dir, proto_file)
        if command_used is None:
            command_used = compile_proto_with_protoc(paths.proto_dir, paths.cache_dir, proto_file)
        if command_used is None:
            fail(
                "Missing generated protobuf module and no protobuf compiler was available. "
                "Install grpcio-tools or protoc, then rerun the probe.\n"
                + protobuf_actionable_context(
                    paths=paths,
                    command_used=grpc_tools_protoc_command(paths.proto_dir, paths.cache_dir, proto_file),
                    expected_path=generated_path,
                ),
            )
        importlib.invalidate_caches()

    if not generated_path.exists():
        fail(
            f"Protobuf generation completed but {module_name} was not produced.\n"
            + protobuf_actionable_context(paths=paths, command_used=command_used, expected_path=generated_path),
        )

    try:
        return importlib.import_module(module_name)
    except ImportError as exc:
        fail(
            f"Unable to import generated {module_name}: {exc}\n"
            + protobuf_actionable_context(paths=paths, command_used=command_used, expected_path=generated_path),
        )


def generated_proto_modules_for_streams(streams: frozenset[str]) -> dict[str, str]:
    modules: dict[str, str] = {}
    if "MBP10" in streams:
        modules.update(MBP10_GENERATED_PROTO_MODULES)
    if "MBO" in streams:
        modules.update(MBO_GENERATED_PROTO_MODULES)
    return modules


def optional_generated_proto_modules_for_streams(streams: frozenset[str]) -> dict[str, str]:
    if "MBO" not in streams:
        return {}
    return OPTIONAL_MBO_GENERATED_PROTO_MODULES


def load_rprotocol_modules(paths: SdkPaths, streams: frozenset[str]) -> RProtocolModules:
    require_python_dependency("websockets", "python -m pip install websockets")
    require_python_dependency("google.protobuf.message", "python -m pip install protobuf")

    insert_module_paths(paths)
    print_startup_diagnostic(paths)

    def import_pb2(module_name: str) -> ModuleType:
        try:
            return importlib.import_module(module_name)
        except Exception as exc:
            fail(
                f"Unable to import {module_name}. Check protobuf compatibility and SDK layout. "
                f"Original error: {exc}",
            )

    generated = {
        module_name: ensure_generated_pb2_module(module_name, proto_file, paths)
        for module_name, proto_file in generated_proto_modules_for_streams(streams).items()
    }
    optional_generated: dict[str, ModuleType] = {}
    for module_name, proto_file in optional_generated_proto_modules_for_streams(streams).items():
        if not (paths.proto_dir / proto_file).exists():
            continue
        try:
            optional_generated[module_name] = ensure_generated_pb2_module(module_name, proto_file, paths)
        except ProbeConfigError as exc:
            print(f"Optional protobuf parser unavailable for {module_name}: {exc}", file=sys.stderr)

    return RProtocolModules(
        base=import_pb2("base_pb2"),
        request_heartbeat=import_pb2("request_heartbeat_pb2"),
        response_heartbeat=import_pb2("response_heartbeat_pb2"),
        request_rithmic_system_info=import_pb2("request_rithmic_system_info_pb2"),
        response_rithmic_system_info=import_pb2("response_rithmic_system_info_pb2"),
        request_login=import_pb2("request_login_pb2"),
        response_login=import_pb2("response_login_pb2"),
        request_logout=import_pb2("request_logout_pb2"),
        response_logout=import_pb2("response_logout_pb2"),
        request_market_data_update=import_pb2("request_market_data_update_pb2"),
        response_market_data_update=import_pb2("response_market_data_update_pb2"),
        last_trade=import_pb2("last_trade_pb2"),
        best_bid_offer=import_pb2("best_bid_offer_pb2"),
        request_depth_by_order_updates=generated.get("request_depth_by_order_updates_pb2"),
        response_depth_by_order_updates=generated.get("response_depth_by_order_updates_pb2"),
        order_book=generated.get("order_book_pb2"),
        depth_by_order=generated.get("depth_by_order_pb2"),
        depth_by_order_end_event=optional_generated.get("depth_by_order_end_event_pb2"),
    )


def make_ssl_context(connect_point: str, cert_path: pathlib.Path) -> ssl.SSLContext | None:
    if not connect_point.startswith("wss://"):
        return None
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cert_path)
    return context


async def connect_to_rithmic(connect_point: str, ssl_context: ssl.SSLContext | None) -> Any:
    websockets = importlib.import_module("websockets")
    try:
        return await websockets.connect(connect_point, ssl=ssl_context, ping_interval=3)
    except Exception as exc:
        fail(f"Unable to connect to Rithmic TICKER_PLANT endpoint {connect_point}: {exc}")


async def send_message(ws: Any, message: Any) -> None:
    await ws.send(message.SerializeToString())


def first_response_code(response: Any) -> str:
    rp_code = getattr(response, "rp_code", [])
    if len(rp_code) == 0:
        return ""
    return str(rp_code[0])


def repeated_strings(message: Any, field_name: str) -> list[str]:
    values = getattr(message, field_name, [])
    if values is None:
        return []
    if isinstance(values, str):
        return [values]
    try:
        return [str(value) for value in values]
    except TypeError:
        return [str(values)]


def log_depth_by_order_subscription_response(
    modules: RProtocolModules,
    template_id: int,
    msg_buffer: bytes,
) -> None:
    if modules.response_depth_by_order_updates is None:
        print(
            json.dumps(
                {
                    "event": "depth_by_order_subscription_response_unparsed",
                    "reason": "response_depth_by_order_updates_pb2 unavailable",
                    "template_id": template_id,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return

    try:
        response = modules.response_depth_by_order_updates.ResponseDepthByOrderUpdates()
        response.ParseFromString(msg_buffer)
    except Exception as exc:
        print(
            json.dumps(
                {
                    "event": "depth_by_order_subscription_response_unparsed",
                    "reason": str(exc),
                    "template_id": template_id,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return
    print(
        json.dumps(
            {
                "event": "depth_by_order_subscription_response",
                "rp_code": repeated_strings(response, "rp_code"),
                "template_id": template_id,
                "user_msg": repeated_strings(response, "user_msg"),
            },
            sort_keys=True,
        ),
        file=sys.stderr,
    )


async def send_heartbeat(ws: Any, modules: RProtocolModules) -> None:
    request = modules.request_heartbeat.RequestHeartbeat()
    request.template_id = REQUEST_HEARTBEAT_TEMPLATE_ID
    await send_message(ws, request)


async def list_systems(ws: Any, modules: RProtocolModules) -> None:
    request = modules.request_rithmic_system_info.RequestRithmicSystemInfo()
    request.template_id = REQUEST_RITHMIC_SYSTEM_INFO_TEMPLATE_ID
    request.user_msg.append("infra-01-list-systems")
    await send_message(ws, request)
    response_buffer = await ws.recv()
    response = modules.response_rithmic_system_info.ResponseRithmicSystemInfo()
    response.ParseFromString(response_buffer)
    if first_response_code(response) != "0":
        fail(f"Rithmic system list request failed: rp_code={response.rp_code} user_msg={response.user_msg}")
    for system_name in response.system_name:
        print(system_name)


async def login(
    ws: Any,
    modules: RProtocolModules,
    system_name: str,
    user: str,
    password: str,
) -> None:
    request = modules.request_login.RequestLogin()
    request.template_id = REQUEST_LOGIN_TEMPLATE_ID
    request.template_version = "3.9"
    request.user_msg.append("infra-01-login")
    request.user = user
    request.password = password
    request.app_name = APP_NAME
    request.app_version = APP_VERSION
    request.system_name = system_name
    request.infra_type = modules.request_login.RequestLogin.SysInfraType.TICKER_PLANT
    await send_message(ws, request)

    response_buffer = await ws.recv()
    response = modules.response_login.ResponseLogin()
    response.ParseFromString(response_buffer)
    if first_response_code(response) != "0":
        fail(f"Rithmic TICKER_PLANT login failed: rp_code={response.rp_code} user_msg={response.user_msg}")


async def logout(ws: Any, modules: RProtocolModules) -> None:
    request = modules.request_logout.RequestLogout()
    request.template_id = REQUEST_LOGOUT_TEMPLATE_ID
    request.user_msg.append("infra-01-logout")
    await send_message(ws, request)


async def subscribe_market_data(
    ws: Any,
    modules: RProtocolModules,
    exchange: str,
    symbol: str,
    streams: frozenset[str],
    subscribe: bool,
) -> None:
    update_bits = modules.request_market_data_update.RequestMarketDataUpdate.UpdateBits
    selected_bits = 0
    if "LAST_TRADE" in streams:
        selected_bits |= update_bits.LAST_TRADE
    if "L1_QUOTE" in streams:
        selected_bits |= update_bits.BBO
    if "MBP10" in streams:
        selected_bits |= update_bits.ORDER_BOOK
    if selected_bits == 0:
        return

    request = modules.request_market_data_update.RequestMarketDataUpdate()
    request.template_id = REQUEST_MARKET_DATA_UPDATE_TEMPLATE_ID
    request.user_msg.append("infra-01-market-data")
    request.symbol = symbol
    request.exchange = exchange
    request.request = (
        modules.request_market_data_update.RequestMarketDataUpdate.Request.SUBSCRIBE
        if subscribe
        else modules.request_market_data_update.RequestMarketDataUpdate.Request.UNSUBSCRIBE
    )
    request.update_bits = selected_bits
    await send_message(ws, request)


async def subscribe_depth_by_order(
    ws: Any,
    modules: RProtocolModules,
    exchange: str,
    symbol: str,
    subscribe: bool,
    request_template_id: int | None,
) -> bool:
    if request_template_id is None:
        print(
            "MBO subscription skipped: --request-depth-by-order-template-id is required "
            "until the RProtocol request template ID is confirmed.",
            file=sys.stderr,
        )
        return False
    if modules.request_depth_by_order_updates is None:
        print("MBO subscription skipped: request_depth_by_order_updates_pb2 unavailable.", file=sys.stderr)
        return False

    request = modules.request_depth_by_order_updates.RequestDepthByOrderUpdates()
    request.template_id = request_template_id
    request.user_msg.append("infra-01-depth-by-order")
    request.request = (
        modules.request_depth_by_order_updates.RequestDepthByOrderUpdates.Request.SUBSCRIBE
        if subscribe
        else modules.request_depth_by_order_updates.RequestDepthByOrderUpdates.Request.UNSUBSCRIBE
    )
    request.symbol = symbol
    request.exchange = exchange
    await send_message(ws, request)
    return True


def message_has_field(message: Any, field_name: str) -> bool:
    if not hasattr(message, field_name):
        return False
    try:
        return bool(message.HasField(field_name))
    except (ValueError, AttributeError):
        value = getattr(message, field_name, None)
        return value not in (None, 0, "", [])


def extract_exchange_timestamp(message: Any) -> tuple[str | None, str]:
    if message_has_field(message, "source_ssboe") and message_has_field(message, "source_nsecs"):
        value = int(getattr(message, "source_ssboe")) * 1_000_000_000 + int(
            getattr(message, "source_nsecs"),
        )
        return str(value), "source_nsecs"
    if message_has_field(message, "source_ssboe") and message_has_field(message, "source_usecs"):
        value = int(getattr(message, "source_ssboe")) * 1_000_000_000 + int(
            getattr(message, "source_usecs"),
        ) * 1_000
        return str(value), "source_usecs"
    if message_has_field(message, "ssboe") and message_has_field(message, "usecs"):
        value = int(getattr(message, "ssboe")) * 1_000_000_000 + int(getattr(message, "usecs")) * 1_000
        return str(value), "ssboe_usecs"
    return None, "unavailable"


def optional_sequence(message: Any) -> str | None:
    for field_name in ["sequence_number", "sequence", "exchange_order_id"]:
        if message_has_field(message, field_name):
            return str(getattr(message, field_name))
    return None


def make_probe_record(
    *,
    probe_id: str,
    symbol: str,
    exchange: str,
    stream: str,
    template_id: int,
    payload_kind: str,
    message: Any,
    raw: bool,
    raw_buffer: bytes,
) -> dict[str, Any]:
    sidecar_recv_ts_ns = str(time.time_ns())
    recv_monotonic_ns = str(time.perf_counter_ns())
    exchange_event_ts_ns, timestamp_source = extract_exchange_timestamp(message)
    sequence = optional_sequence(message)
    record: dict[str, Any] = {
        "schema_version": PROBE_SCHEMA_VERSION,
        "probe_id": probe_id,
        "symbol": symbol,
        "exchange": exchange,
        "stream": stream,
        "exchange_event_ts_ns": exchange_event_ts_ns,
        "rithmic_publish_ts_ns": None,
        "sidecar_recv_ts_ns": sidecar_recv_ts_ns,
        "recv_monotonic_ns": recv_monotonic_ns,
        "timestamp_source": timestamp_source,
        "template_id": template_id,
        "sequence": sequence,
        "payload_kind": payload_kind,
        "raw_present": raw,
    }
    if raw:
        record["raw_b64"] = base64.b64encode(raw_buffer).decode("ascii")
    return record


def json_line(record: dict[str, Any]) -> str:
    return json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n"


def parse_base_template_id(modules: RProtocolModules, msg_buffer: bytes) -> int:
    base = modules.base.Base()
    base.ParseFromString(msg_buffer)
    return int(base.template_id)


def parse_payload(
    modules: RProtocolModules,
    template_id: int,
    msg_buffer: bytes,
    args: argparse.Namespace,
) -> tuple[str, str, Any] | None:
    if "LAST_TRADE" in args.streams and template_id == LAST_TRADE_TEMPLATE_ID:
        message = modules.last_trade.LastTrade()
        message.ParseFromString(msg_buffer)
        return "LAST_TRADE", "LastTrade", message
    if "L1_QUOTE" in args.streams and template_id == BEST_BID_OFFER_TEMPLATE_ID:
        message = modules.best_bid_offer.BestBidOffer()
        message.ParseFromString(msg_buffer)
        return "L1_QUOTE", "BestBidOffer", message
    if "MBP10" in args.streams and args.order_book_template_id is not None and template_id == args.order_book_template_id:
        if modules.order_book is None:
            return None
        message = modules.order_book.OrderBook()
        message.ParseFromString(msg_buffer)
        return "MBP10", "OrderBook", message
    if (
        "MBO" in args.streams
        and args.depth_by_order_template_id is not None
        and template_id == args.depth_by_order_template_id
    ):
        if modules.depth_by_order is None:
            return None
        message = modules.depth_by_order.DepthByOrder()
        message.ParseFromString(msg_buffer)
        return "MBO", "DepthByOrder", message
    if (
        "MBO" in args.streams
        and args.depth_by_order_end_event_template_id is not None
        and template_id == args.depth_by_order_end_event_template_id
    ):
        if modules.depth_by_order_end_event is None:
            return None
        message_class = getattr(modules.depth_by_order_end_event, "DepthByOrderEndEvent", None)
        if message_class is None:
            return None
        message = message_class()
        message.ParseFromString(msg_buffer)
        return "MBO", "DepthByOrderEndEvent", message
    return None


async def consume_probe(
    ws: Any,
    modules: RProtocolModules,
    args: argparse.Namespace,
    output_path: pathlib.Path,
    probe_id: str,
) -> ProbeSummary:
    summary = ProbeSummary(records_by_stream=Counter(), unknown_template_ids=Counter())
    deadline = time.monotonic() + args.duration_sec
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("a", encoding="utf-8") as handle:
        await send_heartbeat(ws, modules)
        while time.monotonic() < deadline:
            try:
                msg_buffer = await asyncio.wait_for(ws.recv(), timeout=5)
            except asyncio.TimeoutError:
                await send_heartbeat(ws, modules)
                continue
            except KeyboardInterrupt:
                break
            except Exception as exc:
                summary.error_count += 1
                print(f"receive error: {exc}", file=sys.stderr)
                break

            if isinstance(msg_buffer, str):
                msg_buffer = msg_buffer.encode("utf-8")
            msg_bytes = bytes(msg_buffer)
            recv_template_id = parse_base_template_id(modules, msg_bytes)

            if recv_template_id in {
                RESPONSE_LOGOUT_TEMPLATE_ID,
                RESPONSE_HEARTBEAT_TEMPLATE_ID,
                RESPONSE_MARKET_DATA_UPDATE_TEMPLATE_ID,
            }:
                continue
            if "MBO" in args.streams and recv_template_id == args.response_depth_by_order_template_id:
                log_depth_by_order_subscription_response(modules, recv_template_id, msg_bytes)
                continue

            parsed = parse_payload(modules, recv_template_id, msg_bytes, args)
            if parsed is None:
                summary.unknown_template_ids[recv_template_id] += 1
                continue

            stream, payload_kind, message = parsed
            record = make_probe_record(
                probe_id=probe_id,
                symbol=args.symbol,
                exchange=args.exchange,
                stream=stream,
                template_id=recv_template_id,
                payload_kind=payload_kind,
                message=message,
                raw=args.raw,
                raw_buffer=msg_bytes,
            )
            handle.write(json_line(record))
            handle.flush()
            summary.observe_record(stream, str(record["sidecar_recv_ts_ns"]))

    return summary


def print_summary(summary: ProbeSummary, output_path: pathlib.Path, duration_sec: int) -> None:
    payload = {
        "records_by_stream": dict(sorted(summary.records_by_stream.items())),
        "unknown_template_ids": {str(key): value for key, value in sorted(summary.unknown_template_ids.items())},
        "first_sidecar_recv_ts_ns": summary.first_sidecar_recv_ts_ns,
        "last_sidecar_recv_ts_ns": summary.last_sidecar_recv_ts_ns,
        "duration_seconds": duration_sec,
        "output_path": str(output_path),
        "error_count": summary.error_count,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))


async def run_probe(args: argparse.Namespace) -> int:
    paths = resolve_sdk_paths(args.rprotocol_home)
    module_streams = frozenset() if args.list_systems else args.streams
    modules = load_rprotocol_modules(paths, module_streams)
    connect_point = require_value(args.connect_point, "--connect-point", "RITHMIC_CONNECT_POINT")
    ssl_context = make_ssl_context(connect_point, paths.cert_path)
    ws = await connect_to_rithmic(connect_point, ssl_context)

    if args.list_systems:
        try:
            await list_systems(ws, modules)
        finally:
            with contextlib.suppress(Exception):
                await ws.close(1000, "infra-01 list systems complete")
        return 0

    system_name = require_value(args.system_name, "--system-name", "RITHMIC_SYSTEM_NAME")
    user = require_value(args.user, "--user", "RITHMIC_USER")
    password = require_value(args.password, "--password", "RITHMIC_PASSWORD")
    out = require_value(args.out, "--out")
    if args.duration_sec <= 0:
        fail("--duration-sec must be positive")

    output_path = pathlib.Path(out).expanduser().resolve()
    probe_id = f"rithmic-{args.symbol}-{int(time.time())}"
    subscribed_mbo = False

    try:
        await login(ws, modules, system_name, user, password)
        await subscribe_market_data(ws, modules, args.exchange, args.symbol, args.streams, True)
        if "MBO" in args.streams:
            subscribed_mbo = await subscribe_depth_by_order(
                ws,
                modules,
                args.exchange,
                args.symbol,
                True,
                args.request_depth_by_order_template_id,
            )
        summary = await consume_probe(ws, modules, args, output_path, probe_id)
    except KeyboardInterrupt:
        print("Ctrl+C received; shutting down cleanly.", file=sys.stderr)
        summary = ProbeSummary(records_by_stream=Counter(), unknown_template_ids=Counter(), error_count=1)
    finally:
        with contextlib.suppress(Exception):
            await subscribe_market_data(ws, modules, args.exchange, args.symbol, args.streams, False)
        if subscribed_mbo:
            with contextlib.suppress(Exception):
                await subscribe_depth_by_order(
                    ws,
                    modules,
                    args.exchange,
                    args.symbol,
                    False,
                    args.request_depth_by_order_template_id,
                )
        with contextlib.suppress(Exception):
            await logout(ws, modules)
        with contextlib.suppress(Exception):
            await ws.close(1000, "infra-01 probe complete")

    print_summary(summary, output_path, args.duration_sec)
    return 0 if summary.error_count == 0 else 1


def main() -> int:
    args = parse_args()
    try:
        return asyncio.run(run_probe(args))
    except ProbeConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Ctrl+C received before startup completed.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
