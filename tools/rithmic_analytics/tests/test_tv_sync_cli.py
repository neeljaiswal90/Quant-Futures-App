"""Tests for ``rithmic_analytics.cli.tv_sync`` (RA-034)."""

from __future__ import annotations

import json
from pathlib import Path

from rithmic_analytics.cli.tv_sync import EXIT_BAD_INPUT, EXIT_OK, main


def _write_zones_envelope(
    path: Path,
    *,
    symbol: str = "MNQ",
    reference_lines: list[dict[str, object]] | None = None,
    zones: list[dict[str, object]] | None = None,
    atr_14: float | None = 5.0,
) -> None:
    if reference_lines is None:
        reference_lines = [
            {"price": 27381.25, "text": "VPOC", "source": "vpoc"},
            {"price": 27390.00, "text": "VAH", "source": "vah"},
            {"price": 27370.00, "text": "VAL", "source": "val"},
        ]
    payload = {
        "schema_version": 1,
        "symbol": symbol,
        "timeframe": "rth",
        "bars_used": 100,
        "computed_at": "2026-05-20T20:00:00+00:00",
        "data_source": "rithmic",
        "vpoc": 27381.25,
        "vah": 27390.00,
        "val": 27370.00,
        "atr_14": atr_14,
        "bin_size_ticks": 20,
        "zones": zones or [],
        "reference_lines": reference_lines,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


# ---------------------------------------------------------------------------
# Dry-run mode (default)
# ---------------------------------------------------------------------------


def test_cli_dry_run_default_does_not_write_plan(
    tmp_path: Path, capsys: object,
) -> None:
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)
    plans_root = tmp_path / "plans"
    state_root = tmp_path / "state"

    rc = main([
        "--zones", str(zones),
        "--target", "tv_desktop",
        "--state-root", str(state_root),
        "--plans-root", str(plans_root),
    ])

    assert rc == EXIT_OK
    # No plan file written
    assert not plans_root.exists() or not any(plans_root.iterdir())
    # Dry-run prints to stdout
    out = capsys.readouterr().out  # type: ignore[attr-defined]
    assert "operations" in out


def test_cli_dry_run_explicit_flag(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)
    plans_root = tmp_path / "plans"

    rc = main([
        "--zones", str(zones),
        "--target", "tv_desktop",
        "--state-root", str(tmp_path / "state"),
        "--plans-root", str(plans_root),
        "--dry-run",
    ])

    assert rc == EXIT_OK
    assert not plans_root.exists() or not any(plans_root.iterdir())


# ---------------------------------------------------------------------------
# Apply mode
# ---------------------------------------------------------------------------


def test_cli_apply_writes_plan_file_and_latest_pointer(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)
    plans_root = tmp_path / "plans"

    rc = main([
        "--zones", str(zones),
        "--target", "tv_desktop",
        "--state-root", str(tmp_path / "state"),
        "--plans-root", str(plans_root),
        "--apply",
    ])

    assert rc == EXIT_OK
    plan_files = list(plans_root.glob("tv_desktop_MNQ_*.json"))
    assert len(plan_files) == 1
    plan = json.loads(plan_files[0].read_text(encoding="utf-8"))
    assert plan["backend"] == "tv_desktop"
    assert plan["chart_id"] == "MNQ"
    assert len(plan["operations"]) == 3  # VPOC, VAH, VAL adds

    # _latest.json pointer
    latest = plans_root / "_latest.json"
    assert latest.exists()
    latest_payload = json.loads(latest.read_text(encoding="utf-8"))
    assert latest_payload["backend"] == "tv_desktop"
    assert latest_payload["plan_path"] == str(plan_files[0])


def test_cli_apply_target_both_writes_two_plans(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)
    plans_root = tmp_path / "plans"

    rc = main([
        "--zones", str(zones),
        "--target", "both",
        "--state-root", str(tmp_path / "state"),
        "--plans-root", str(plans_root),
        "--apply",
    ])

    assert rc == EXIT_OK
    tv_plans = list(plans_root.glob("tv_desktop_MNQ_*.json"))
    tradesea_plans = list(plans_root.glob("tradesea_MNQ_*.json"))
    assert len(tv_plans) == 1
    assert len(tradesea_plans) == 1


def test_cli_apply_chart_id_defaults_to_envelope_symbol(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones, symbol="ES")  # not MNQ
    plans_root = tmp_path / "plans"

    rc = main([
        "--zones", str(zones),
        "--target", "tv_desktop",
        "--state-root", str(tmp_path / "state"),
        "--plans-root", str(plans_root),
        "--apply",
    ])

    assert rc == EXIT_OK
    plans = list(plans_root.glob("tv_desktop_ES_*.json"))
    assert len(plans) == 1


def test_cli_apply_explicit_chart_id_overrides_symbol(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)  # symbol=MNQ
    plans_root = tmp_path / "plans"

    rc = main([
        "--zones", str(zones),
        "--target", "tv_desktop",
        "--state-root", str(tmp_path / "state"),
        "--plans-root", str(plans_root),
        "--chart-id", "MNQ_DayTrading",
        "--apply",
    ])

    assert rc == EXIT_OK
    plans = list(plans_root.glob("tv_desktop_MNQ_DayTrading_*.json"))
    assert len(plans) == 1


# ---------------------------------------------------------------------------
# Idempotency: re-apply with same state → no add ops
# ---------------------------------------------------------------------------


def test_cli_re_apply_with_matching_state_produces_noop_plan(tmp_path: Path) -> None:
    """Pre-seed the state file with the exact source IDs the envelope
    would generate. Plan should produce zero adds + zero removes."""
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)
    state_root = tmp_path / "state"
    plans_root = tmp_path / "plans"

    # Pre-seed state matching exactly the envelope's reference lines
    state_root.mkdir()
    state_path = state_root / "tv_desktop_MNQ.json"
    state_path.write_text(
        json.dumps({
            "version": 1, "backend": "tv_desktop", "chart_id": "MNQ",
            "mappings": {
                "ref:vpoc:27381.25": "shape-vpoc",
                "ref:vah:27390.00": "shape-vah",
                "ref:val:27370.00": "shape-val",
            },
        }),
        encoding="utf-8",
    )

    rc = main([
        "--zones", str(zones),
        "--target", "tv_desktop",
        "--state-root", str(state_root),
        "--plans-root", str(plans_root),
        "--apply",
    ])

    assert rc == EXIT_OK
    plan_files = list(plans_root.glob("tv_desktop_MNQ_*.json"))
    plan = json.loads(plan_files[0].read_text(encoding="utf-8"))

    # All noops
    op_kinds = {o["op"] for o in plan["operations"]}
    assert op_kinds == {"noop"}
    assert len(plan["operations"]) == 3


# ---------------------------------------------------------------------------
# Failure modes
# ---------------------------------------------------------------------------


def test_cli_missing_zones_returns_bad_input(tmp_path: Path) -> None:
    rc = main([
        "--zones", str(tmp_path / "no.json"),
        "--target", "tv_desktop",
        "--state-root", str(tmp_path / "state"),
        "--plans-root", str(tmp_path / "plans"),
    ])
    assert rc == EXIT_BAD_INPUT


def test_cli_invalid_zones_json_returns_bad_input(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    zones.write_text("not-valid-json{[", encoding="utf-8")
    rc = main([
        "--zones", str(zones),
        "--target", "tv_desktop",
        "--state-root", str(tmp_path / "state"),
        "--plans-root", str(tmp_path / "plans"),
    ])
    assert rc == EXIT_BAD_INPUT


def test_cli_envelope_missing_symbol_returns_usage(tmp_path: Path) -> None:
    """Schema-valid envelope but missing 'symbol' → can't derive default chart_id."""
    zones = tmp_path / "zones.json"
    # Write a payload that fails validate_envelope (symbol field is required by schema)
    zones.write_text(json.dumps({"schema_version": 1, "zones": []}), encoding="utf-8")
    rc = main([
        "--zones", str(zones),
        "--target", "tv_desktop",
        "--state-root", str(tmp_path / "state"),
        "--plans-root", str(tmp_path / "plans"),
    ])
    # Schema validation catches this → EXIT_BAD_INPUT
    assert rc == EXIT_BAD_INPUT


def test_cli_mutually_exclusive_dry_run_and_apply_rejected(tmp_path: Path) -> None:
    """argparse handles the mutex group; SystemExit on conflict."""
    import pytest as _pytest
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)

    with _pytest.raises(SystemExit):
        main([
            "--zones", str(zones),
            "--target", "tv_desktop",
            "--state-root", str(tmp_path / "state"),
            "--plans-root", str(tmp_path / "plans"),
            "--dry-run", "--apply",
        ])


# ---------------------------------------------------------------------------
# "Never fail one-because-of-other" partial-success rule
# ---------------------------------------------------------------------------


def test_cli_one_backend_planning_failure_does_not_gate_other(
    tmp_path: Path, monkeypatch: object,
) -> None:
    """If one backend's plan_for_backend raises, the other backend still gets planned.

    Implementation: monkeypatch `_plan_for_backend` to raise for tradesea
    only. Verify tv_desktop plan still lands.
    """
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)
    plans_root = tmp_path / "plans"

    from rithmic_analytics.cli import tv_sync as tv_sync_mod
    original = tv_sync_mod._plan_for_backend

    def selective_failure(**kwargs: object) -> object:
        if kwargs.get("backend") == "tradesea":
            raise ValueError("synthetic tradesea failure")
        return original(**kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(tv_sync_mod, "_plan_for_backend", selective_failure)  # type: ignore[attr-defined]

    rc = main([
        "--zones", str(zones),
        "--target", "both",
        "--state-root", str(tmp_path / "state"),
        "--plans-root", str(plans_root),
        "--apply",
    ])

    assert rc == EXIT_OK  # tv_desktop succeeded → overall OK
    tv_plans = list(plans_root.glob("tv_desktop_MNQ_*.json"))
    tradesea_plans = list(plans_root.glob("tradesea_MNQ_*.json"))
    assert len(tv_plans) == 1     # succeeded
    assert len(tradesea_plans) == 0  # failed but didn't gate tv_desktop


def test_cli_all_backends_failing_returns_bad_input(
    tmp_path: Path, monkeypatch: object,
) -> None:
    """If ALL backends fail, exit with EXIT_BAD_INPUT — nothing useful happened."""
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)

    from rithmic_analytics.cli import tv_sync as tv_sync_mod

    def always_fails(**kwargs: object) -> object:
        raise ValueError("synthetic universal failure")

    monkeypatch.setattr(tv_sync_mod, "_plan_for_backend", always_fails)  # type: ignore[attr-defined]

    rc = main([
        "--zones", str(zones),
        "--target", "both",
        "--state-root", str(tmp_path / "state"),
        "--plans-root", str(tmp_path / "plans"),
        "--apply",
    ])

    assert rc == EXIT_BAD_INPUT
