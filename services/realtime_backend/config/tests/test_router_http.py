"""Live-HTTP integration tests for the alert-config router (RA-068).

These exercise the real FastAPI/Starlette stack via ``TestClient`` — status
codes, response_model JSON serialization, and FastAPI's request-validation
422 path — which was impossible until ``httpx`` was installed (the
handler-level tests in ``test_router.py`` cover the mechanism; these cover
the wire). Hermetic: each client gets a tmp-path store, so no repo file is
touched.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("httpx")  # TestClient requires httpx

from contracts.realtime.config import default_alert_config  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from realtime_backend.config.router import create_config_router  # noqa: E402
from realtime_backend.config.store import AlertConfigStore  # noqa: E402

ROUTE = "/api/config/alerts"


def _client(tmp_path: Path) -> tuple[TestClient, AlertConfigStore]:
    store = AlertConfigStore(tmp_path / "alert_config.json")
    app = FastAPI()
    app.include_router(create_config_router(store))
    return TestClient(app), store


def test_get_returns_default_config_200(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)
    resp = client.get(ROUTE)
    assert resp.status_code == 200
    body = resp.json()
    assert body["schema_version"] == default_alert_config().schema_version
    assert {"critical", "high", "medium", "proximity", "quiet_hours"} <= set(body)


def test_put_persists_and_subsequent_get_reflects_it(tmp_path: Path) -> None:
    client, store = _client(tmp_path)
    cfg = default_alert_config().model_dump()
    cfg["medium"]["enabled"] = True

    put = client.put(ROUTE, json=cfg)
    assert put.status_code == 200
    assert put.json()["medium"]["enabled"] is True

    # Hot-reload over HTTP: a fresh GET on the same store reflects the PUT.
    assert client.get(ROUTE).json()["medium"]["enabled"] is True
    # And it was actually persisted + cached.
    assert (tmp_path / "alert_config.json").exists()
    assert store.get().medium.enabled is True


def test_put_unknown_key_returns_422(tmp_path: Path) -> None:
    # extra="forbid" on the contract → FastAPI rejects before the handler.
    client, store = _client(tmp_path)
    cfg = default_alert_config().model_dump()
    cfg["bogus_field"] = 1
    resp = client.put(ROUTE, json=cfg)
    assert resp.status_code == 422
    # Store untouched on a rejected write — no file materialized.
    assert not (tmp_path / "alert_config.json").exists()


def test_put_wrong_type_returns_422(tmp_path: Path) -> None:
    client, _ = _client(tmp_path)
    cfg = default_alert_config().model_dump()
    cfg["proximity"]["critical_pt"] = "not-a-number"
    resp = client.put(ROUTE, json=cfg)
    assert resp.status_code == 422
