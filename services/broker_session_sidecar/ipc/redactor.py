"""Redaction utilities shared by sidecar logs and broker_error payloads."""

from __future__ import annotations

import re

REDACTED_CREDENTIAL = "[REDACTED:CREDENTIAL]"
REDACTED_EMAIL = "[REDACTED:EMAIL]"
REDACTED_IP = "[REDACTED:IP]"
REDACTED_BEARER = "Bearer [REDACTED:TOKEN]"
REDACTED_SESSION = "[REDACTED:SESSION_ID]"
REDACTED_ORDER = "[REDACTED:ORDER_ID]"
REDACTED_ACCOUNT = "[REDACTED:ACCOUNT_ID]"

EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
IP_RE = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
KEY_VALUE_RE = re.compile(
    r"\b(password|passwd|pwd|secret|token|api[_-]?key|credential)\s*[:=]\s*([^\s,;]+)",
    re.IGNORECASE,
)
SESSION_RE = re.compile(r"\b(session[_-]?id|broker[_-]?session[_-]?id|sid)\s*[:=]\s*([A-Za-z0-9_.:-]+)", re.IGNORECASE)
ORDER_RE = re.compile(r"\b(order[_-]?id|broker[_-]?order[_-]?id|client[_-]?order[_-]?id)\s*[:=]\s*([A-Za-z0-9_.:-]+)", re.IGNORECASE)
ACCOUNT_RE = re.compile(r"\b(account[_-]?id|broker[_-]?account[_-]?id|account)\s*[:=]\s*([A-Za-z0-9_.:-]+)", re.IGNORECASE)


def redact_text(value: object) -> str:
    text = str(value)
    text = BEARER_RE.sub(REDACTED_BEARER, text)
    text = KEY_VALUE_RE.sub(lambda match: f"{match.group(1)}={REDACTED_CREDENTIAL}", text)
    text = SESSION_RE.sub(lambda match: f"{match.group(1)}={REDACTED_SESSION}", text)
    text = ORDER_RE.sub(lambda match: f"{match.group(1)}={REDACTED_ORDER}", text)
    text = ACCOUNT_RE.sub(lambda match: f"{match.group(1)}={REDACTED_ACCOUNT}", text)
    text = EMAIL_RE.sub(REDACTED_EMAIL, text)
    text = IP_RE.sub(REDACTED_IP, text)
    return text
