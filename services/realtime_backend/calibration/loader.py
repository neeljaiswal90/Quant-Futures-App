"""RA-112e step 10 / Move 3 — tail-cap calibration loader (runtime side).

Loads ``tail_cap.{SYMBOL}_{session_kind}.v1.json`` artifacts produced by
:mod:`realtime_backend.calibration.compute_tail_cap`, validates the schema
version, and exposes a typed snapshot to the runtime. Keeps a last-valid
copy in memory so a transient refresh failure does NOT change the
methodology midstream — per the operator's spec, the fallback chain is:

    current_valid_calibration  →  last_valid_calibration  →  legacy_atr_cap

The runtime is the consumer; this module is read-only.
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


EXPECTED_SCHEMA_VERSION = "tail_cap_calibration.v1"


@dataclass(frozen=True, slots=True)
class TailCapCalibration:
    """Typed snapshot of a tail_cap calibration file. Only the fields the
    runtime actually consumes are exposed strongly — the rest of the JSON
    is preserved on ``raw`` for audit / methodology-health display."""
    schema_version: str
    symbol: str
    session_kind: str
    as_of_date: str
    valid_from_session_date: str
    lookback_sessions_requested: int
    lookback_sessions_used: int
    range_horizon_minutes: int
    p99_range_points: float
    p95_range_points: float
    max_range_points: float
    tail_concentration_health: str | None  # "concentrated" | "diversified" | None
    raw: dict[str, Any]                    # full body for downstream display
    source_path: Path
    is_low_sample: bool                    # lookback_sessions_used < 15

    @classmethod
    def from_dict(cls, body: dict[str, Any], *, source_path: Path) -> "TailCapCalibration":
        if body.get("schema_version") != EXPECTED_SCHEMA_VERSION:
            raise ValueError(
                f"calibration schema mismatch: expected {EXPECTED_SCHEMA_VERSION!r}, "
                f"got {body.get('schema_version')!r} at {source_path}"
            )
        stats = body.get("range_stats_points") or {}
        used = int(body.get("lookback_sessions_used") or 0)
        # tail_concentration is optional (v1 forward-compat per spec).
        tc = body.get("tail_concentration") or None
        tc_health = (tc or {}).get("health") if tc else None
        return cls(
            schema_version=str(body["schema_version"]),
            symbol=str(body["symbol"]),
            session_kind=str(body["session_kind"]),
            as_of_date=str(body["as_of_date"]),
            valid_from_session_date=str(body["valid_from_session_date"]),
            lookback_sessions_requested=int(body["lookback_sessions_requested"]),
            lookback_sessions_used=used,
            range_horizon_minutes=int(body["range_horizon_minutes"]),
            p99_range_points=float(stats["p99"]),
            p95_range_points=float(stats["p95"]),
            max_range_points=float(stats["max"]),
            tail_concentration_health=tc_health,
            raw=dict(body),
            source_path=source_path,
            is_low_sample=used < 15,
        )


class CalibrationLoader:
    """Loads + caches the tail-cap calibration per session-kind.

    Public API:
      * ``refresh()`` — try to load the current file; remember it as
        last-valid on success; do NOT clobber last-valid on failure.
      * ``current()`` — best available calibration: current if valid,
        else last-valid, else None (caller falls back to legacy ATR).
      * ``status()`` — whether the latest refresh succeeded and a short
        reason if not, for methodology-health surfacing.
    """

    def __init__(self, calibration_dir: Path, *, symbol: str, session_kind: str) -> None:
        self._dir = calibration_dir
        self._symbol = symbol
        self._session_kind = session_kind
        self._lock = threading.Lock()
        self._current: TailCapCalibration | None = None
        self._last_valid: TailCapCalibration | None = None
        self._last_refresh_ok: bool = False
        self._last_refresh_error: str | None = None
        self._last_mtime_ns: int | None = None

    @property
    def expected_path(self) -> Path:
        return self._dir / f"tail_cap.{self._symbol}_{self._session_kind}.v1.json"

    def refresh(self) -> TailCapCalibration | None:
        """Re-read the on-disk file. Updates ``current`` and ``last_valid``
        only on success. Returns the loaded calibration or None.

        Idempotent + safe to call from multiple threads. mtime-cached:
        if the file hasn't changed since the last successful load, returns
        the cached calibration without re-parsing.
        """
        path = self.expected_path
        with self._lock:
            try:
                if not path.is_file():
                    raise FileNotFoundError(f"calibration not found: {path}")
                mtime_ns = path.stat().st_mtime_ns
                if (
                    self._current is not None
                    and self._last_mtime_ns is not None
                    and mtime_ns == self._last_mtime_ns
                ):
                    return self._current
                with path.open("r", encoding="utf-8") as f:
                    body = json.load(f)
                cal = TailCapCalibration.from_dict(body, source_path=path)
            except Exception as e:
                self._last_refresh_ok = False
                self._last_refresh_error = f"{type(e).__name__}: {e}"
                logger.warning("calibration refresh failed: %s", e)
                # Do NOT clobber _last_valid; runtime keeps using it.
                return self._last_valid
            self._current = cal
            self._last_valid = cal
            self._last_refresh_ok = True
            self._last_refresh_error = None
            self._last_mtime_ns = mtime_ns
            return cal

    def current(self) -> TailCapCalibration | None:
        """The calibration the runtime should use *right now*. Prefers the
        current file; if a refresh failed (or never happened), returns the
        last-valid; if neither, returns None (caller uses legacy ATR)."""
        with self._lock:
            return self._current or self._last_valid

    def status(self) -> dict[str, Any]:
        """Summary for the methodology-health panel."""
        with self._lock:
            cal = self._current or self._last_valid
            return {
                "expected_path": str(self.expected_path),
                "has_current": self._current is not None,
                "has_last_valid": self._last_valid is not None,
                "last_refresh_ok": self._last_refresh_ok,
                "last_refresh_error": self._last_refresh_error,
                "calibration_source_path": (
                    str(cal.source_path) if cal is not None else None
                ),
                "calibration_as_of_date": cal.as_of_date if cal is not None else None,
                "calibration_session_kind": (
                    cal.session_kind if cal is not None else None
                ),
                "calibration_is_low_sample": (
                    cal.is_low_sample if cal is not None else None
                ),
                "calibration_tail_concentration_health": (
                    cal.tail_concentration_health if cal is not None else None
                ),
            }


__all__ = [
    "EXPECTED_SCHEMA_VERSION",
    "TailCapCalibration",
    "CalibrationLoader",
]
