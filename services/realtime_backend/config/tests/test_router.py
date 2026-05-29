"""Tests for the REST config router — route registration, handlers, hot-reload.

httpx is not installed in this environment, so Starlette's ``TestClient`` is
unavailable (same constraint RA-060's ``test_app.py`` documents). We therefore
exercise the route *handlers* directly and assert the route wiring
(path/methods/response_model), and verify the 422 validation behavior at its
source — the contract model's ``extra="forbid"`` / type validation, which is
exactly what FastAPI runs to produce the 422 before the handler is reached.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from contracts.realtime.config import AlertConfig, default_alert_config
from fastapi import APIRouter
from fastapi.routing import APIRoute
from pydantic import ValidationError

from realtime_backend.config.router import create_config_router
from realtime_backend.config.store import AlertConfigStore

_ROUTE = "/api/config/alerts"


def _route(router: APIRouter, method: str) -> APIRoute:
    """The APIRoute on ``router`` for ``_ROUTE`` with the given HTTP method."""
    for r in router.routes:
        if isinstance(r, APIRoute) and r.path == _ROUTE and method in r.methods:
            return r
    raise AssertionError(f"no {method} route for {_ROUTE}")


# ----- route wiring ------------------------------------------------------


def test_router_registers_get_and_put(tmp_path: Path) -> None:
    router = create_config_router(AlertConfigStore(tmp_path / "alert_config.json"))
    get_route = _route(router, "GET")
    put_route = _route(router, "PUT")
    assert get_route.response_model is AlertConfig
    assert put_route.response_model is AlertConfig


# ----- GET handler -------------------------------------------------------


def test_get_handler_returns_current_config(tmp_path: Path) -> None:
    store = AlertConfigStore(tmp_path / "alert_config.json")
    router = create_config_router(store)
    handler = _route(router, "GET").endpoint
    result = handler()
    assert result == default_alert_config()
    assert result is store.get()


# ----- PUT handler -------------------------------------------------------


def test_put_handler_replaces_and_returns_persisted_doc(tmp_path: Path) -> None:
    store = AlertConfigStore(tmp_path / "alert_config.json")
    router = create_config_router(store)
    handler = _route(router, "PUT").endpoint

    new_cfg = default_alert_config().model_copy(
        update={"quiet_hours": default_alert_config().quiet_hours.model_copy(
            update={"enabled": True, "start_pt": "20:00", "end_pt": "04:00"}
        )}
    )
    returned = handler(new_cfg)
    assert returned == new_cfg
    # Persisted to disk...
    assert store.path.exists()
    on_disk = AlertConfig.model_validate_json(store.path.read_text(encoding="utf-8"))
    assert on_disk == new_cfg


def test_put_is_visible_to_shared_store_cache(tmp_path: Path) -> None:
    """The store the gating path reads sees the PUT immediately (hot-reload)."""
    store = AlertConfigStore(tmp_path / "alert_config.json")
    router = create_config_router(store)
    handler = _route(router, "PUT").endpoint

    new_cfg = default_alert_config().model_copy(
        update={"medium": default_alert_config().medium.model_copy(update={"enabled": True})}
    )
    handler(new_cfg)
    # No reload, no restart — the cached object the router shares reflects it.
    assert store.get().medium.enabled is True


def test_get_reflects_prior_put(tmp_path: Path) -> None:
    store = AlertConfigStore(tmp_path / "alert_config.json")
    router = create_config_router(store)
    put = _route(router, "PUT").endpoint
    get = _route(router, "GET").endpoint

    new_cfg = default_alert_config().model_copy(update={"schema_version": 1})
    new_cfg = new_cfg.model_copy(
        update={"proximity": new_cfg.proximity.model_copy(update={"high_pt": 75.0})}
    )
    put(new_cfg)
    assert get().proximity.high_pt == 75.0


# ----- validation (the mechanism behind FastAPI's 422) ------------------


def test_unknown_key_is_rejected_by_contract() -> None:
    """extra='forbid' rejects unknown PUT keys -> FastAPI returns 422."""
    body = default_alert_config().model_dump()
    body["surprise"] = "boom"
    with pytest.raises(ValidationError):
        AlertConfig.model_validate(body)


def test_wrong_type_is_rejected_by_contract() -> None:
    body = default_alert_config().model_dump()
    body["proximity"]["critical_pt"] = "not-a-number"
    with pytest.raises(ValidationError):
        AlertConfig.model_validate(body)


def test_missing_nested_field_is_rejected_by_contract() -> None:
    body = default_alert_config().model_dump()
    body["critical"].pop("enabled")
    body["critical"]["enabled"] = None  # null for a bool field -> invalid
    with pytest.raises(ValidationError):
        AlertConfig.model_validate(body)
