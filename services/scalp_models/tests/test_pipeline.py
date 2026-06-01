import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from scalp_models.pipeline import (
    PipelineConfig,
    PipelineError,
    PipelineSession,
    _assert_capture_not_active,
    run_pipeline,
    sessions_from_date_range,
    validate_schema_seam,
)


def test_schema_seam_smoke_accepts_joined_setup_and_label(tmp_path: Path) -> None:
    setups = tmp_path / "setups.jsonl"
    labels = tmp_path / "labels.jsonl"
    setups.write_text(_jsonl([_setup_row()]), encoding="utf-8")
    labels.write_text(_jsonl([_label_row()]), encoding="utf-8")

    summary = validate_schema_seam(setups, labels)

    assert summary.setup_row_count == 1
    assert summary.label_row_count == 1
    assert summary.joined_example_count == 5


def test_schema_seam_smoke_rejects_all_missing_join(tmp_path: Path) -> None:
    setups = tmp_path / "setups.jsonl"
    labels = tmp_path / "labels.jsonl"
    setups.write_text(_jsonl([_setup_row()]), encoding="utf-8")
    labels.write_text(_jsonl([_label_row(ts_ns=2000)]), encoding="utf-8")

    with pytest.raises(PipelineError, match="all missing_label"):
        validate_schema_seam(setups, labels)


def test_pipeline_writes_manifest_and_insufficient_report(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_replay(
        *,
        config: PipelineConfig,
        session: PipelineSession,
        signals_path: Path,
        setups_path: Path,
        scratch_dir: Path,
    ) -> SimpleNamespace:
        del config, scratch_dir
        signals_path.write_text(_jsonl([_signal_row(session)]), encoding="utf-8")
        setups_path.write_text(_jsonl([_setup_row(session=session)]), encoding="utf-8")
        signals_manifest = signals_path.with_suffix(".manifest.json")
        setups_manifest = setups_path.with_suffix(".manifest.json")
        signals_manifest.write_text('{"row_count":1}\n', encoding="utf-8")
        setups_manifest.write_text('{"row_count":1}\n', encoding="utf-8")
        return SimpleNamespace(
            manifest_path=signals_manifest,
            setup_result=SimpleNamespace(manifest_path=setups_manifest),
        )

    def fake_labels(
        *,
        config: PipelineConfig,
        dataset_path: Path,
        labels_path: Path,
        manifest_path: Path,
    ) -> None:
        del config, dataset_path
        labels_path.write_text(_jsonl([_label_row()]), encoding="utf-8")
        manifest_path.write_text('{"row_count":1}\n', encoding="utf-8")

    monkeypatch.setattr("scalp_models.pipeline._run_replay_for_session", fake_replay)
    monkeypatch.setattr("scalp_models.pipeline._run_label_cli", fake_labels)
    monkeypatch.setattr("scalp_models.pipeline._matching_capture_processes", lambda session: [])

    result = run_pipeline(
        PipelineConfig(
            sessions=(PipelineSession(capture_date="2026-05-29", session="rth"),),
            analytics_root=tmp_path / "analytics",
            dashboard_root=tmp_path / "dashboard",
            out_root=tmp_path / "runs",
            run_id="fixture",
            min_positives=30,
            min_negatives=30,
        )
    )

    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert manifest["generated_by"] == "ra093b_scalp_pipeline_v1"
    assert manifest["merged_inputs"]["schema_seam"]["joined_example_count"] == 5
    assert manifest["git"]["dirty"] in {True, False}
    assert "dirty status is recorded for audit only" in manifest["git"]["note"]
    assert result.training.report_path.exists()
    assert "insufficient_samples" in result.training.report_path.read_text(encoding="utf-8")


def test_live_capture_guard_blocks_recent_target_writes(tmp_path: Path) -> None:
    session = PipelineSession(capture_date="2026-05-29", session="rth")
    capture_dir = tmp_path / "analytics" / "data" / "captures" / session.capture_date
    capture_dir.mkdir(parents=True)
    (capture_dir / "MNQ_rth.obs01.jsonl").write_text("{}\n", encoding="utf-8")

    with pytest.raises(PipelineError, match="target capture appears active"):
        _assert_capture_not_active(
            session,
            PipelineConfig(
                sessions=(session,),
                analytics_root=tmp_path / "analytics",
                live_write_stale_seconds=3600,
            ),
        )


def test_date_range_expansion_is_inclusive() -> None:
    assert sessions_from_date_range("2026-05-25..2026-05-26", ("rth",)) == (
        PipelineSession(capture_date="2026-05-25", session="rth"),
        PipelineSession(capture_date="2026-05-26", session="rth"),
    )


def _jsonl(rows: list[dict]) -> str:
    return "".join(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n" for row in rows)


def _signal_row(session: PipelineSession | None = None) -> dict:
    session = session or PipelineSession(capture_date="2026-05-29", session="rth")
    return {
        "schema_version": 1,
        "ts_ns": 1000,
        "family": "sweep",
        "event_type": "sweep_detected",
        "tier": "HIGH",
        "price": 100.0,
        "level_id": "z1",
        "side": None,
        "direction": "long",
        "zone_context": None,
        "regime": None,
        "orderflow_snapshot": None,
        "depth_snapshot": None,
        "confluence_stack_size": 2,
        "payload": {},
        "replay": {
            "capture_date": session.capture_date,
            "session": session.session,
            "step_ns": 1500,
            "source_obs01": "obs.jsonl",
            "source_mbo": None,
            "schema_version": 1,
        },
    }


def _setup_row(
    *,
    ts_ns: int = 1000,
    price: float = 100.0,
    session: PipelineSession | None = None,
) -> dict:
    session = session or PipelineSession(capture_date="2026-05-29", session="rth")
    signal_id = (
        f"{session.capture_date}|{session.session}|{ts_ns}|sweep|sweep_detected|z1|{price:.2f}"
    )
    return {
        "schema_version": 1,
        "ts_ns": ts_ns,
        "setup_type": "zone_rejection",
        "direction": "long",
        "price": price,
        "level_id": "z1",
        "zone_context": {"id": "z1", "kind": "vwap", "price": price, "distance_pts": 0.0},
        "regime": "NORMAL",
        "orderflow_snapshot": {},
        "depth_snapshot": {},
        "confluence_stack_size": 2,
        "source_signals": [
            {
                "signal_id": signal_id,
                "ts_ns": ts_ns,
                "family": "sweep",
                "event_type": "sweep_detected",
                "price": price,
                "level_id": "z1",
                "tier": "HIGH",
            }
        ],
        "features": {},
        "replay": {
            "capture_date": session.capture_date,
            "session": session.session,
            "step_ns": 1500,
        },
    }


def _label_row(*, ts_ns: int = 1000, price: float = 100.0) -> dict:
    return {
        "label_schema_version": 1,
        "signal": {
            "schema_version": 1,
            "ts_ns": str(ts_ns),
            "family": "sweep",
            "event_type": "sweep_detected",
            "tier": "HIGH",
            "price": price,
            "level_id": "z1",
            "side": None,
            "direction": "long",
            "replay": {
                "capture_date": "2026-05-29",
                "session": "rth",
                "step_ns": "1500",
                "source_obs01": "obs.jsonl",
                "source_mbo": None,
                "schema_version": 1,
            },
        },
        "candidate_seed": {"ts_ns": str(ts_ns)},
        "forward_returns": [
            {"horizon_seconds": 1, "status": "ok", "mfe_ticks": 5.0},
            {"horizon_seconds": 5, "status": "ok", "mfe_ticks": 5.0},
            {"horizon_seconds": 15, "status": "ok", "mfe_ticks": 5.0},
            {"horizon_seconds": 60, "status": "ok", "mfe_ticks": 5.0},
            {"horizon_seconds": 300, "status": "ok", "mfe_ticks": 5.0},
        ],
    }
