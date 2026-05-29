"""Gap-detection alerter — scans capture JSONL for time gaps, emits NDJSON.

Scans an OBS-01 or MBP1 JSONL file for gaps in the exchange-timestamp stream
exceeding configured thresholds, appends one structured line per gap to a
shared ``alerts.ndjson`` file (the dashboard in RA-012 reads from there), and
optionally fires a Discord webhook for operator-visible notification.

Threshold defaults mirror QFA's ``gap_detection.GapThresholds`` per
architecture.md D-001 — we vendor the values rather than import because QFA
has no installable package layout. Vendoring is restricted to the threshold
constants; the scanner is purpose-built for our OBS-01/MBP1 wire formats.

NDJSON line schema (per the v2 ticket spec)::

    {"ts_iso": "2026-05-15T19:30:00+00:00",
     "session_id": "mnq-2026-05-15-rth",
     "stream": "LAST_TRADE",
     "gap_type": "time",
     "gap_value_ns": 72_500_000_000,
     "threshold_ns": 60_000_000_000,
     "severity": "WARN"}

Two streams are scannable:
    - **LAST_TRADE** — OBS-01 TRADE envelopes (60s warn / 5min fail defaults)
    - **L1_QUOTE** — MBP1 top-of-book updates (1s warn / 5s fail defaults)

OBS-01 carries TRADE only; the L1_QUOTE thresholds apply only when scanning
MBP1 files. Both scanners append to the same ``alerts.ndjson``.
"""

from __future__ import annotations

import json
import logging
import os
import time as time_module
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Literal

_LOG = logging.getLogger("rithmic_analytics.alerts")

_NS_PER_MS: int = 1_000_000
_DEFAULT_ALERTS_PATH: Path = Path("data/alerts/alerts.ndjson")

Severity = Literal["WARN", "FAIL"]
# StreamName broadened to carry the HEARTBEAT operational alert category from
# RA-011. See architecture.md D-005 for the future refactor pointer.
StreamName = Literal["L1_QUOTE", "LAST_TRADE", "HEARTBEAT"]


@dataclass(frozen=True, slots=True)
class GapThresholds:
    """Per-stream warning + fail thresholds in milliseconds.

    Field names and defaults mirror QFA's ``gap_detection.GapThresholds`` so
    operators reading either project see consistent numbers. Drift between
    them is acceptable (different scopes, different streams) but worth
    flagging in code review.
    """

    l1_quote_warning_ms: int = 1_000
    l1_quote_fail_ms: int = 5_000
    last_trade_warning_ms: int = 60_000
    last_trade_fail_ms: int = 300_000


@dataclass(frozen=True, slots=True)
class Gap:
    """One detected gap exceeding a threshold."""

    stream: StreamName
    session_id: str
    prev_event_ts_ns: int
    curr_event_ts_ns: int
    gap_ms: float
    severity: Severity
    threshold_ms: int

    def to_alert_dict(self, *, ts_iso: str | None = None) -> dict[str, Any]:
        """Convert to the NDJSON wire-format dict.

        Args:
            ts_iso: Override emit-time stamp (used by tests for determinism).
                Defaults to ``datetime.now(UTC).isoformat()``.
        """
        return {
            "ts_iso": ts_iso or datetime.now(UTC).isoformat(),
            "session_id": self.session_id,
            "stream": self.stream,
            "gap_type": "time",
            "gap_value_ns": int(self.curr_event_ts_ns - self.prev_event_ts_ns),
            "threshold_ns": self.threshold_ms * _NS_PER_MS,
            "severity": self.severity,
        }


def _classify_trade_gap(
    gap_ms: float, thresholds: GapThresholds
) -> tuple[Severity, int] | None:
    """Return (severity, threshold_ms) if a LAST_TRADE gap exceeds threshold."""
    if gap_ms >= thresholds.last_trade_fail_ms:
        return "FAIL", thresholds.last_trade_fail_ms
    if gap_ms >= thresholds.last_trade_warning_ms:
        return "WARN", thresholds.last_trade_warning_ms
    return None


def _classify_quote_gap(
    gap_ms: float, thresholds: GapThresholds
) -> tuple[Severity, int] | None:
    """Return (severity, threshold_ms) if an L1_QUOTE gap exceeds threshold."""
    if gap_ms >= thresholds.l1_quote_fail_ms:
        return "FAIL", thresholds.l1_quote_fail_ms
    if gap_ms >= thresholds.l1_quote_warning_ms:
        return "WARN", thresholds.l1_quote_warning_ms
    return None


def analyze_obs01_trade_gaps(
    obs01_path: Path,
    *,
    thresholds: GapThresholds | None = None,
) -> list[Gap]:
    """Stream an OBS-01 JSONL file; return all TRADE-stream gaps over threshold.

    Session ID is taken from the envelope ``session_id`` field — if multiple
    sessions appear in the file (shouldn't, but defensive), each gap carries
    the session it was observed in.

    Args:
        obs01_path: Path to the OBS-01 ``.jsonl`` capture.
        thresholds: Override default trade thresholds (60s/300s).

    Returns:
        List of ``Gap`` objects, one per threshold-exceeding interval. Empty
        if no gaps or file empty/missing.
    """
    thresholds = thresholds or GapThresholds()
    gaps: list[Gap] = []
    if not obs01_path.exists() or obs01_path.stat().st_size == 0:
        return gaps

    prev_ts_ns: int | None = None
    session_id: str = "unknown"

    with obs01_path.open("r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get("type") != "TRADE":
                continue
            payload = rec.get("payload") or {}
            curr_ts_ns = int(payload["exchange_event_ts_ns"])
            session_id = rec.get("session_id", session_id)

            if prev_ts_ns is not None:
                gap_ms = (curr_ts_ns - prev_ts_ns) / _NS_PER_MS
                classification = _classify_trade_gap(gap_ms, thresholds)
                if classification is not None:
                    severity, threshold_ms = classification
                    gaps.append(
                        Gap(
                            stream="LAST_TRADE",
                            session_id=session_id,
                            prev_event_ts_ns=prev_ts_ns,
                            curr_event_ts_ns=curr_ts_ns,
                            gap_ms=gap_ms,
                            severity=severity,
                            threshold_ms=threshold_ms,
                        )
                    )
            prev_ts_ns = curr_ts_ns

    return gaps


def analyze_mbp1_quote_gaps(
    mbp1_path: Path,
    *,
    session_id: str,
    thresholds: GapThresholds | None = None,
) -> list[Gap]:
    """Stream an MBP1 JSONL file; return L1_QUOTE-stream gaps over threshold.

    MBP1 has no envelope-level ``session_id`` field (databento-flat schema),
    so the caller must supply it (typically derived from the capture path).

    Args:
        mbp1_path: Path to the MBP1 normalized ``.jsonl`` file.
        session_id: Session label to stamp on emitted alerts.
        thresholds: Override default quote thresholds (1s/5s).

    Returns:
        List of ``Gap`` objects. Empty if no gaps or file empty/missing.
    """
    thresholds = thresholds or GapThresholds()
    gaps: list[Gap] = []
    if not mbp1_path.exists() or mbp1_path.stat().st_size == 0:
        return gaps

    prev_ts_ns: int | None = None

    with mbp1_path.open("r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            rec = json.loads(line)
            curr_ts_ns = int(rec["ts_event_ns"])

            if prev_ts_ns is not None:
                gap_ms = (curr_ts_ns - prev_ts_ns) / _NS_PER_MS
                classification = _classify_quote_gap(gap_ms, thresholds)
                if classification is not None:
                    severity, threshold_ms = classification
                    gaps.append(
                        Gap(
                            stream="L1_QUOTE",
                            session_id=session_id,
                            prev_event_ts_ns=prev_ts_ns,
                            curr_event_ts_ns=curr_ts_ns,
                            gap_ms=gap_ms,
                            severity=severity,
                            threshold_ms=threshold_ms,
                        )
                    )
            prev_ts_ns = curr_ts_ns

    return gaps


def emit_alerts(
    gaps: list[Gap],
    alerts_path: Path | None = None,
    *,
    ts_iso: str | None = None,
) -> int:
    """Append one NDJSON line per gap to ``alerts_path`` (default
    ``data/alerts/alerts.ndjson``). Returns the number of lines written.

    Append mode preserves prior alerts — the dashboard in RA-012 expects a
    cumulative log. The parent directory is created on demand.

    Args:
        gaps: List of detected gaps.
        alerts_path: Override the default NDJSON path.
        ts_iso: Override emit-time stamp (deterministic-output tests use this).

    Returns:
        Number of lines appended. Zero if ``gaps`` is empty.
    """
    if not gaps:
        return 0
    path = alerts_path or _DEFAULT_ALERTS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for g in gaps:
            f.write(json.dumps(g.to_alert_dict(ts_iso=ts_iso)) + "\n")
    return len(gaps)


def emit_heartbeat_missing_alert(
    trading_date: date,
    alerts_path: Path | None = None,
    *,
    session_id: str | None = None,
    ts_iso: str | None = None,
) -> None:
    """Append a ``CAPTURE_HEARTBEAT_MISSING`` line to ``alerts.ndjson``.

    Used by ``ops.heartbeat_check.check_missing_heartbeats`` when a past trading
    day's heartbeat file is absent past its deadline. Shape mirrors :class:`Gap`
    for dashboard uniformity — nullable numeric fields signal "operational
    alert, not gap-stream measurement." See architecture.md D-005.

    Args:
        trading_date: The day whose heartbeat is missing.
        alerts_path: Override default ``data/alerts/alerts.ndjson``.
        session_id: Override the synthesized ``mnq-{date}`` session id (e.g.,
            for multi-symbol futures).
        ts_iso: Override emit-time stamp (deterministic tests).
    """
    path = alerts_path or _DEFAULT_ALERTS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ts_iso": ts_iso or datetime.now(UTC).isoformat(),
        "session_id": session_id or f"mnq-{trading_date.isoformat()}",
        "stream": "HEARTBEAT",
        "gap_type": "missing_capture",
        "gap_value_ns": None,
        "threshold_ns": None,
        "severity": "FAIL",
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def send_discord_webhook(webhook_url: str, gaps: list[Gap]) -> None:
    """POST a one-line summary of the gap batch to a Discord webhook.

    Failures are logged but never raised — alerting must not abort the host
    process. A network timeout of 10 seconds is hardcoded.

    Args:
        webhook_url: Discord webhook endpoint URL.
        gaps: Detected gaps. No-op if empty.
    """
    if not gaps:
        return
    n_fail = sum(1 for g in gaps if g.severity == "FAIL")
    n_warn = sum(1 for g in gaps if g.severity == "WARN")
    sessions = sorted({g.session_id for g in gaps})
    content = (
        f"Rithmic capture alerts: {n_fail} FAIL, {n_warn} WARN "
        f"across {len(sessions)} session(s): {', '.join(sessions)}"
    )
    _post_discord(webhook_url, content)


# ---------------------------------------------------------------------------
# RA-032: FAIL-severity push notifications (dedupe + state)
# ---------------------------------------------------------------------------


_DISCORD_ENV_VAR: str = "RITHMIC_DISCORD_WEBHOOK_URL"
_DEFAULT_DEDUPE_TTL_SEC: int = 30 * 60  # 30 min per ticket
_DEFAULT_STATE_PATH: Path = Path("data/alerts/.alerts_state.json")
_NO_WEBHOOK_WARNED: bool = False


def _post_discord(webhook_url: str, content: str) -> None:
    """Fire-and-forget POST to a Discord webhook. Never raises."""
    body = json.dumps({"content": content}).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        _LOG.error(f"discord webhook failed: {exc}")
    except OSError as exc:
        _LOG.error(f"discord webhook OS error: {exc}")


def _load_dedupe_state(state_path: Path) -> dict[str, float]:
    """Load ``{dedupe_key: last_post_unix_ts}`` from disk. Returns {} on any error."""
    if not state_path.exists():
        return {}
    try:
        raw = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {}
        return {str(k): float(v) for k, v in raw.items()}
    except (json.JSONDecodeError, ValueError, OSError):
        return {}


def _save_dedupe_state(state_path: Path, state: dict[str, float]) -> None:
    """Persist dedupe state. Best-effort — failures are logged but not raised."""
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state), encoding="utf-8")
    except OSError as exc:
        _LOG.error(f"could not persist alert dedupe state to {state_path}: {exc}")


def _resolve_webhook_url() -> str | None:
    """Read ``RITHMIC_DISCORD_WEBHOOK_URL`` from env. Log INFO once if missing.

    The global ``_NO_WEBHOOK_WARNED`` flag means the "missing env var"
    log line fires only on the FIRST attempt per process lifetime — no
    log spam on repeated calls.
    """
    global _NO_WEBHOOK_WARNED
    url = os.getenv(_DISCORD_ENV_VAR)
    if url:
        return url
    if not _NO_WEBHOOK_WARNED:
        _LOG.info(
            f"{_DISCORD_ENV_VAR} not set; FAIL alert push disabled. "
            f"Set it in your .env to enable Discord notifications."
        )
        _NO_WEBHOOK_WARNED = True
    return None


def post_fail(
    *,
    source_name: str,
    message: str,
    state_path: Path | None = None,
    now_ts: float | None = None,
    dedupe_ttl_sec: int = _DEFAULT_DEDUPE_TTL_SEC,
) -> bool:
    """Post a FAIL-severity Discord alert with 30-min dedupe by source_name.

    Dedupe key is ``(severity="FAIL", source_name)``. The second identical
    FAIL within ``dedupe_ttl_sec`` is suppressed (counted, not posted).
    State is persisted to ``state_path`` so dedupe survives process restart.

    Args:
        source_name: Logical alert source (e.g. ``"heartbeat_watchdog"``,
            ``"normalize_unrecoverable"``). Used as the dedupe key.
        message: Human-readable alert body posted to Discord.
        state_path: Override the dedupe state file (test injection).
            Default: ``data/alerts/.alerts_state.json``.
        now_ts: Override "now" unix timestamp (test injection).
        dedupe_ttl_sec: Suppress identical FAIL within this many seconds.

    Returns:
        True if the alert was posted, False if suppressed or no webhook.

    Idempotent under restart: dedupe state file means a restart inside
    the 30-min window still respects the suppression.
    """
    webhook_url = _resolve_webhook_url()
    if webhook_url is None:
        return False  # no webhook configured — silent

    sp = state_path or _DEFAULT_STATE_PATH
    state = _load_dedupe_state(sp)
    key = f"FAIL:{source_name}"
    now = now_ts if now_ts is not None else time_module.time()

    last_posted = state.get(key)
    if last_posted is not None and (now - last_posted) < dedupe_ttl_sec:
        _LOG.info(
            f"alerts.post_fail: suppressing duplicate FAIL for source_name="
            f"{source_name!r} (last posted {now - last_posted:.0f}s ago, "
            f"ttl={dedupe_ttl_sec}s)"
        )
        return False

    content = f"🔴 FAIL [{source_name}]: {message}"
    _post_discord(webhook_url, content)
    state[key] = now
    _save_dedupe_state(sp, state)
    return True


def post_digest(
    summary: str,
    *,
    state_path: Path | None = None,
) -> bool:
    """Post a once-per-day digest line. No dedupe — fires once per call.

    Used by ``daily_zones`` at end of run to emit a one-line summary.
    Returns True if posted, False if no webhook configured.
    """
    _ = state_path  # accepted for API symmetry; digest doesn't dedupe
    webhook_url = _resolve_webhook_url()
    if webhook_url is None:
        return False
    _post_discord(webhook_url, f"📋 Daily digest: {summary}")
    return True
