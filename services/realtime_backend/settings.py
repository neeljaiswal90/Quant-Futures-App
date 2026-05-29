"""Backend configuration — frozen settings + CLI/env resolution.

Centralizes every tunable RA-060 knob so the rest of the package never reaches
for an environment variable or a hardcoded path directly. The GREEN-LIT
decisions live here as defaults:

- bind ``127.0.0.1:8765`` (``--host`` / ``--port`` override),
- CORS allow-list is the Vite dev origin (never ``"*"``),
- per-client queue ``maxsize=256``, drop-oldest,
- watcher 250 ms trailing debounce, >= 500 ms min compute interval,
- multi-signal stack proximity 30.0 pt (RA-050 reuse),
- detector tail bound 20 MB (RA-052-safe).

The scratch ``dashboard_dir`` is BACKEND-OWNED and lives under this package so
``compute_live_signals`` (which is disk-stateful) never writes into capture
dirs or the real dashboard output.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from rithmic_dashboard.features.live_signals import DEFAULT_TAIL_BYTES

# This package lives at services/realtime_backend/.
_PACKAGE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _PACKAGE_DIR.parents[1]

# Default analytics root: the rithmic_analytics tree that session_state +
# generate.py resolve against. Mirrors the layout documented in MEMORY.md
# (D:\Quant-futures-app\tools\rithmic_analytics\). determine_session_state's
# own default is a relative "../rithmic_analytics" assuming cwd is the
# dashboard package; we resolve the absolute path explicitly instead.
DEFAULT_ANALYTICS_ROOT = _REPO_ROOT / "tools" / "rithmic_analytics"

# Vite dev origins (RA-061 frontend) — explicit allow-list, never "*".
DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


@dataclass(frozen=True)
class Settings:
    """Immutable runtime configuration for one backend process."""

    host: str = "127.0.0.1"
    port: int = 8765

    # Analytics tree feeding session_state / compute_live_signals.
    analytics_root: Path = DEFAULT_ANALYTICS_ROOT

    # BACKEND-OWNED scratch dir for the disk-stateful detector. Pointed away
    # from capture dirs and the real dashboard output on purpose. The detector
    # writes its persisted JSONL under ``scratch_dir.parent / "live_analysis"``.
    scratch_dir: Path = _PACKAGE_DIR / "_scratch" / "dashboard"

    # Optional EWMA calibration corpus; if missing, the regime stays None and
    # we simply do not emit vol_regime events (per the GREEN-LIT mapping).
    ewma_calibration_path: Path | None = (
        DEFAULT_ANALYTICS_ROOT / "data" / "calibration_corpus" / "ewma_decay.json"
    )

    # Session overrides (else auto-resolved from wall clock).
    session_override: str | None = None
    trading_date_override: str | None = None

    # Watcher cadence (GREEN-LIT).
    debounce_seconds: float = 0.250
    min_compute_interval_seconds: float = 0.500

    # Use watchdog's PollingObserver instead of native FS events. Native
    # ReadDirectoryChangesW on Windows is unreliable for pure *appends* to an
    # already-open capture file (no rename/close), so polling is the safe
    # default here. The native Observer remains selectable.
    use_polling_observer: bool = True

    # Backstop: even with an observer, re-trigger a recompute on this interval
    # so a missed FS event can never wedge the feed. The debounce + min-interval
    # guards collapse redundant triggers, so this is cheap.
    poll_fallback_interval_seconds: float = 2.0

    # WS backpressure (GREEN-LIT).
    client_queue_maxsize: int = 256

    # RA-050 multi-signal stack proximity.
    max_price_distance: float = 30.0

    # Detector bounds (RA-052-safe).
    tail_bytes: int = DEFAULT_TAIL_BYTES
    vwap_window_minutes: int = 60

    # Heartbeat + staleness.
    heartbeat_interval_seconds: float = 5.0
    staleness_threshold_seconds: float = 30.0

    cors_origins: tuple[str, ...] = field(default=DEFAULT_CORS_ORIGINS)

    def resolved_calibration_path(self) -> Path | None:
        """Return the calibration path only if it exists on disk."""
        if self.ewma_calibration_path is None:
            return None
        return self.ewma_calibration_path if self.ewma_calibration_path.exists() else None


def settings_from_env(**overrides: object) -> Settings:
    """Build :class:`Settings`, layering env vars then explicit overrides.

    Recognized env vars (all optional):
        ``RA60_HOST``, ``RA60_PORT``, ``RA60_ANALYTICS_ROOT``,
        ``RA60_SCRATCH_DIR``, ``RA60_SESSION``, ``RA60_TRADING_DATE``,
        ``RA60_EWMA_CALIBRATION_PATH``.

    ``overrides`` (typically parsed CLI args) win over env vars, which win over
    the dataclass defaults. ``None`` overrides are ignored so the default holds.
    """

    values: dict[str, object] = {}

    if (raw := os.environ.get("RA60_HOST")) is not None:
        values["host"] = raw
    if (raw := os.environ.get("RA60_PORT")) is not None:
        values["port"] = int(raw)
    if (raw := os.environ.get("RA60_ANALYTICS_ROOT")) is not None:
        values["analytics_root"] = Path(raw)
    if (raw := os.environ.get("RA60_SCRATCH_DIR")) is not None:
        values["scratch_dir"] = Path(raw)
    if (raw := os.environ.get("RA60_SESSION")) is not None:
        values["session_override"] = raw
    if (raw := os.environ.get("RA60_TRADING_DATE")) is not None:
        values["trading_date_override"] = raw
    if (raw := os.environ.get("RA60_EWMA_CALIBRATION_PATH")) is not None:
        values["ewma_calibration_path"] = Path(raw)

    for key, value in overrides.items():
        if value is not None:
            values[key] = value

    return Settings(**values)  # type: ignore[arg-type]


__all__ = [
    "DEFAULT_ANALYTICS_ROOT",
    "DEFAULT_CORS_ORIGINS",
    "Settings",
    "settings_from_env",
]
