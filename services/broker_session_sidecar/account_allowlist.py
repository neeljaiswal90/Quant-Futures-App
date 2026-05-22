"""Broker account allowlist parsing and command checks."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class LiveAccountAllowlistEntry:
    fcm_id: str
    ib_id: str
    account_id: str
    label: str
    max_position_contracts: int
    daily_loss_cap_usd: float
    max_session_duration_ms: int
    time_of_day_restriction: str


class AllowlistConfigError(RuntimeError):
    pass


def load_allowlist_from_env(environ: Mapping[str, str]) -> tuple[LiveAccountAllowlistEntry, ...]:
    raw = environ.get("QFA_BROKER_ALLOWLIST_JSON")
    if raw is None or raw.strip() == "":
        return ()
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AllowlistConfigError(f"QFA_BROKER_ALLOWLIST_JSON is not valid JSON: {exc}") from exc
    return parse_allowlist(loaded)


def parse_allowlist(value: Any) -> tuple[LiveAccountAllowlistEntry, ...]:
    if not isinstance(value, list):
        raise AllowlistConfigError("QFA_BROKER_ALLOWLIST_JSON must be a JSON array")
    entries: list[LiveAccountAllowlistEntry] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise AllowlistConfigError(f"allowlist entry {index} must be an object")
        entries.append(_entry(item, index))
    return tuple(entries)


def command_account_id(command: Mapping[str, Any]) -> str | None:
    payload = command.get("payload")
    if isinstance(payload, dict):
        direct = payload.get("account_id")
        if isinstance(direct, str) and direct.strip() != "":
            return direct
        intent = payload.get("intent")
        if isinstance(intent, dict):
            intent_payload = intent.get("payload")
            if isinstance(intent_payload, dict):
                value = intent_payload.get("account_id")
                if isinstance(value, str) and value.strip() != "":
                    return value
        request = payload.get("request")
        if isinstance(request, dict):
            value = request.get("account_id")
            if isinstance(value, str) and value.strip() != "":
                return value
    value = command.get("account_id")
    return value if isinstance(value, str) and value.strip() != "" else None


def account_id_allowed(allowlist: tuple[LiveAccountAllowlistEntry, ...], account_id: str) -> bool:
    return any(entry.account_id == account_id for entry in allowlist)


def redacted_account_id(account_id: str) -> str:
    if len(account_id) <= 10:
        return f"{account_id[:2]}...{account_id[-2:]}"
    return f"{account_id[:6]}...{account_id[-4:]}"


def _entry(item: Mapping[str, Any], index: int) -> LiveAccountAllowlistEntry:
    return LiveAccountAllowlistEntry(
        fcm_id=_string(item, "fcm_id", index),
        ib_id=_string(item, "ib_id", index),
        account_id=_string(item, "account_id", index),
        label=_string(item, "label", index),
        max_position_contracts=_positive_int(item, "max_position_contracts", index),
        daily_loss_cap_usd=_positive_number(item, "daily_loss_cap_usd", index),
        max_session_duration_ms=_positive_int(item, "max_session_duration_ms", index),
        time_of_day_restriction=_time_restriction(item, index),
    )


def _string(item: Mapping[str, Any], field: str, index: int) -> str:
    value = item.get(field)
    if not isinstance(value, str) or value.strip() == "":
        raise AllowlistConfigError(f"allowlist entry {index}.{field} must be a non-empty string")
    return value


def _positive_int(item: Mapping[str, Any], field: str, index: int) -> int:
    value = item.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise AllowlistConfigError(f"allowlist entry {index}.{field} must be a positive integer")
    return value


def _positive_number(item: Mapping[str, Any], field: str, index: int) -> float:
    value = item.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise AllowlistConfigError(f"allowlist entry {index}.{field} must be a positive number")
    return float(value)


def _time_restriction(item: Mapping[str, Any], index: int) -> str:
    value = item.get("time_of_day_restriction")
    allowed = {"rth_only", "globex_extended", "unrestricted"}
    if value not in allowed:
        raise AllowlistConfigError(
            f"allowlist entry {index}.time_of_day_restriction must be one of: globex_extended, rth_only, unrestricted"
        )
    return str(value)
