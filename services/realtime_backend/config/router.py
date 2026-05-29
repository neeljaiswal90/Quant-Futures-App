"""Mountable REST surface for the alert configuration (RA-063).

A FastAPI :class:`~fastapi.APIRouter` exposing the full-document get/put:

- ``GET  /api/config/alerts`` -> the current :class:`AlertConfig` JSON.
- ``PUT  /api/config/alerts`` -> full-document *replace*. The body is validated
  against :class:`AlertConfig` (the contract's ``extra="forbid"`` makes an
  unknown key a ``422`` — intended: PUT is a whole-document replace, not a
  patch). The persisted document is returned.

The router is wired against an :class:`AlertConfigStore` so the same cached
config object backs both the REST surface and RA-060's gating path (PUT mutates
the cache + persists -> next event sees it; no restart, no poller).

RA-060 mounts this on its app with one line — see this package's ``README.md``.
The default router (:data:`router`) is backed by a process-wide store at the
default path; RA-060 should instead call :func:`create_config_router` with its
own shared store so the REST cache and the gating cache are the *same* object.
"""

from __future__ import annotations

from contracts.realtime.config import AlertConfig
from fastapi import APIRouter

from realtime_backend.config.store import AlertConfigStore

_ROUTE = "/api/config/alerts"


def create_config_router(store: AlertConfigStore) -> APIRouter:
    """Build a config router backed by ``store``.

    Pass the *same* :class:`AlertConfigStore` instance that the gating path
    reads so a PUT is visible to the next event without a restart.
    """
    router = APIRouter(tags=["config"])

    @router.get(_ROUTE, response_model=AlertConfig)
    def get_alert_config() -> AlertConfig:
        """Return the current alert configuration."""
        return store.get()

    @router.put(_ROUTE, response_model=AlertConfig)
    def put_alert_config(config: AlertConfig) -> AlertConfig:
        """Replace the whole alert configuration and return the persisted doc.

        FastAPI validates ``config`` against the contract before this runs, so
        an unknown key or a wrong-typed field is rejected with ``422`` and the
        store is never touched.
        """
        return store.replace(config)

    return router


# Convenience default for the simplest mount / standalone runs. RA-060 should
# prefer ``create_config_router(backend.config_store)`` so the REST cache and
# the gating cache are one object.
router: APIRouter = create_config_router(AlertConfigStore())


__all__ = ["create_config_router", "router"]
