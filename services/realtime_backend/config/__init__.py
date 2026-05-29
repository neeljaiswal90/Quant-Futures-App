"""RA-063 alert-configuration system for the RA-060 realtime backend.

Owns persistence + REST serving + tier-gating for the alert preferences whose
*type* is frozen in :mod:`contracts.realtime.config` (declared by RA-067).

Three pieces, each pure or narrowly-scoped:

- :mod:`realtime_backend.config.store` — :class:`AlertConfigStore`, a
  load-or-seed-defaults persistence layer with atomic write
  (tmp-in-same-dir + :func:`os.replace`), an in-memory cache, and
  write-through on every replace. The cache backs the REST surface and
  write-through persists to the shared ``alert_config.json`` that
  out-of-process consumers (the notification daemon) also read — so a PUT
  takes effect with no restart.

- :mod:`realtime_backend.config.gating` — the pure
  :func:`should_fire` decision: tier-enabled -> proximity-armed ->
  quiet-hours audio-suppression, returning an :class:`AlertDisposition`. This
  is the canonical gating semantics the alert consumers apply (the daemon gates
  toasts; the UI gates audio/browser alerts); the feed emits every signal.

- :mod:`realtime_backend.config.router` — a mountable FastAPI
  ``APIRouter`` exposing ``GET``/``PUT`` ``/api/config/alerts`` backed by the
  store. RA-060 mounts it with one line (see this package's ``README.md``).

This module re-exports the contract type so callers can do
``from realtime_backend.config import AlertConfig`` without reaching across to
``contracts`` directly.
"""

from __future__ import annotations

# Importing this subpackage imports the parent ``realtime_backend`` package
# first, whose ``__init__`` bootstraps the repo root onto ``sys.path`` — which
# is what makes the ``contracts.realtime...`` imports below resolve regardless
# of the cwd the process was launched from.
from contracts.realtime.config import (
    ALERT_TIERS,
    AlertConfig,
    ProximityConfig,
    QuietHoursConfig,
    TierAlertConfig,
    default_alert_config,
)

from realtime_backend.config.gating import (
    AlertDisposition,
    should_fire,
)
from realtime_backend.config.store import (
    DEFAULT_CONFIG_PATH,
    AlertConfigStore,
)

__all__ = [
    # contract re-exports
    "ALERT_TIERS",
    "AlertConfig",
    "ProximityConfig",
    "QuietHoursConfig",
    "TierAlertConfig",
    "default_alert_config",
    # store
    "AlertConfigStore",
    "DEFAULT_CONFIG_PATH",
    # gating
    "AlertDisposition",
    "should_fire",
]
