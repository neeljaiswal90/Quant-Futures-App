"""Redaction utilities shared by sidecar logs and broker_error payloads.

Mirrors scripts/preflight/qfa-612-paper-01b/redactor.ts tag vocabulary and
replacement ordering for BROKER-01 parity.
"""

from __future__ import annotations

import re

REDACTED_CREDENTIAL = "[REDACTED:credential]"
REDACTED_IP = "[REDACTED:ip]"
REDACTED_SESSION = "[REDACTED:session-id-1]"
REDACTED_ORDER = "[REDACTED:order-id-1]"
REDACTED_ACCOUNT = "[REDACTED:account-id]"

CREDENTIAL_KEYS = (
    "RITHMIC_TEST_USERNAME",
    "RITHMIC_TEST_USER",
    "RITHMIC_TEST_PASSWORD",
    "RITHMIC_TEST_WS_URL",
    "RITHMIC_TEST_GATEWAY_URL",
    "RITHMIC_USERNAME",
    "RITHMIC_USER",
    "RITHMIC_PASSWORD",
    "RITHMIC_WS_URL",
    "RITHMIC_CONNECT_POINT",
    "username",
    "password",
    "gateway_url",
)

EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
IP_RE = re.compile(r"\b(?!(?:127\.0\.0\.1|0\.0\.0\.0)\b)(?:\d{1,3}\.){3}\d{1,3}\b")
BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*")
SESSION_ID_RE = re.compile(r"\b(?:rithmic-|mock-)?session[-_:][A-Za-z0-9._-]+\b", re.IGNORECASE)
ORDER_VALUE_RE = re.compile(r"(\b(?:broker[_-])?order(?:Id|_id)?[\"':=]+)([A-Za-z0-9._-]{4,})\b", re.IGNORECASE)
ORDER_ID_RE = re.compile(r"\border[-_:](?!plant\b)[A-Za-z0-9._-]*\d[A-Za-z0-9._-]*\b", re.IGNORECASE)
ACCOUNT_ID_RE = re.compile(r"(\b(?:account(?:Id|_id)?[\"'\s:=]+))([A-Za-z0-9._-]{4,})\b", re.IGNORECASE)


def redact_text(value: object, explicit_secrets: tuple[str, ...] | list[str] = ()) -> str:
    text = str(value)
    for secret in explicit_secrets:
        if secret.strip() != "":
            text = re.sub(re.escape(secret), REDACTED_CREDENTIAL, text)
    for key in CREDENTIAL_KEYS:
        pattern = re.compile(rf"({re.escape(key)}[\"'\s:=]+)([^,\"'\s}}]+)", re.IGNORECASE)
        text = pattern.sub(lambda match: f"{match.group(1)}{REDACTED_CREDENTIAL}", text)
    text = BEARER_RE.sub(f"Bearer {REDACTED_CREDENTIAL}", text)
    text = EMAIL_RE.sub(REDACTED_CREDENTIAL, text)
    text = SESSION_ID_RE.sub(REDACTED_SESSION, text)
    text = ORDER_VALUE_RE.sub(lambda match: f"{match.group(1)}{REDACTED_ORDER}", text)
    text = ORDER_ID_RE.sub(REDACTED_ORDER, text)
    text = ACCOUNT_ID_RE.sub(lambda match: f"{match.group(1)}{REDACTED_ACCOUNT}", text)
    text = IP_RE.sub(REDACTED_IP, text)
    return text
