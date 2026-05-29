"""Tests for :class:`AlertConfigStore` — seed, round-trip, atomic write, cache."""

from __future__ import annotations

import json
from pathlib import Path

from contracts.realtime.config import AlertConfig, default_alert_config

from realtime_backend.config.store import AlertConfigStore


def test_seeds_defaults_when_file_missing(tmp_path: Path) -> None:
    store = AlertConfigStore(tmp_path / "alert_config.json")
    assert store.get() == default_alert_config()


def test_construction_does_not_write(tmp_path: Path) -> None:
    """A read-only lifecycle must not materialize the file as a side effect."""
    path = tmp_path / "alert_config.json"
    store = AlertConfigStore(path)
    _ = store.get()
    assert not path.exists()


def test_replace_persists_and_creates_parent_dirs(tmp_path: Path) -> None:
    # data/dashboard/ does not exist yet -> first write must mkdir parents.
    path = tmp_path / "data" / "dashboard" / "alert_config.json"
    store = AlertConfigStore(path)

    cfg = default_alert_config().model_copy(update={"schema_version": 1})
    cfg = cfg.model_copy(update={"medium": cfg.medium.model_copy(update={"enabled": True})})
    returned = store.replace(cfg)

    assert path.exists()
    assert returned == cfg
    on_disk = AlertConfig.model_validate_json(path.read_text(encoding="utf-8"))
    assert on_disk == cfg


def test_round_trip_through_new_store(tmp_path: Path) -> None:
    """A doc written by one store loads identically in a fresh one."""
    path = tmp_path / "alert_config.json"
    cfg = default_alert_config().model_copy(
        update={"proximity": default_alert_config().proximity.model_copy(update={"high_pt": 42.0})}
    )
    AlertConfigStore(path).replace(cfg)

    reopened = AlertConfigStore(path)
    assert reopened.get() == cfg
    assert reopened.get().proximity.high_pt == 42.0


def test_get_returns_cached_object_after_replace(tmp_path: Path) -> None:
    store = AlertConfigStore(tmp_path / "alert_config.json")
    cfg = default_alert_config().model_copy(update={"schema_version": 1})
    store.replace(cfg)
    # The cache is the same object replace() persisted (hot-reload mechanism).
    assert store.get() is cfg


def test_reload_from_disk_picks_up_out_of_band_edit(tmp_path: Path) -> None:
    path = tmp_path / "alert_config.json"
    store = AlertConfigStore(path)
    store.replace(default_alert_config())

    # Simulate an external editor changing the file on disk.
    edited = default_alert_config().model_copy(
        update={"critical": default_alert_config().critical.model_copy(update={"enabled": False})}
    )
    path.write_text(edited.model_dump_json(indent=2), encoding="utf-8")

    # Cache still holds the old value until an explicit reload.
    assert store.get().critical.enabled is True
    reloaded = store.reload_from_disk()
    assert reloaded.critical.enabled is False
    assert store.get().critical.enabled is False


def test_atomic_write_leaves_no_temp_files(tmp_path: Path) -> None:
    path = tmp_path / "alert_config.json"
    store = AlertConfigStore(path)
    store.replace(default_alert_config())
    store.replace(default_alert_config())
    # Only the target file should remain — no *.tmp siblings.
    siblings = [p.name for p in path.parent.iterdir()]
    assert siblings == [path.name]


def test_written_file_is_valid_indented_json(tmp_path: Path) -> None:
    path = tmp_path / "alert_config.json"
    AlertConfigStore(path).replace(default_alert_config())
    text = path.read_text(encoding="utf-8")
    # Parses as JSON and is pretty-printed (multi-line) with a trailing newline.
    parsed = json.loads(text)
    assert parsed["schema_version"] == 1
    assert "\n" in text.strip()
    assert text.endswith("\n")


def test_replace_overwrites_existing_document(tmp_path: Path) -> None:
    path = tmp_path / "alert_config.json"
    store = AlertConfigStore(path)
    store.replace(default_alert_config())

    new_cfg = default_alert_config().model_copy(
        update={"quiet_hours": default_alert_config().quiet_hours.model_copy(
            update={"enabled": True, "start_pt": "21:00", "end_pt": "05:30"}
        )}
    )
    store.replace(new_cfg)

    on_disk = AlertConfig.model_validate_json(path.read_text(encoding="utf-8"))
    assert on_disk.quiet_hours.enabled is True
    assert on_disk.quiet_hours.start_pt == "21:00"
    assert on_disk.quiet_hours.end_pt == "05:30"


def test_default_path_is_repo_data_dashboard() -> None:
    from realtime_backend.config.store import DEFAULT_CONFIG_PATH

    assert DEFAULT_CONFIG_PATH.parts[-3:] == ("data", "dashboard", "alert_config.json")
