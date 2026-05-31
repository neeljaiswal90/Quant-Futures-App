import json
from pathlib import Path

from scalp_models.trainer import TrainingConfig, train_models


def test_trainer_writes_insufficient_metadata(tmp_path: Path) -> None:
    setups = tmp_path / "setups.jsonl"
    labels = tmp_path / "labels.jsonl"
    setups.write_text(_jsonl([_setup_row(1, 100.0, "2026-06-01")]), encoding="utf-8")
    labels.write_text(_jsonl([_label_row(1, 100.0, 1.0, "2026-06-01")]), encoding="utf-8")

    result = train_models(
        TrainingConfig(
            setup_path=setups,
            labels_path=labels,
            out_root=tmp_path / "runs",
            min_positives=30,
            min_negatives=30,
        )
    )

    metadata = json.loads((result.run_dir / "metadata" / "zone_rejection_1s.json").read_text())
    assert metadata["status"] == "insufficient_samples"
    assert metadata["recommended_action"] == "block"
    assert result.report_path.exists()


def test_trainer_fits_calibrated_model_and_writes_report(tmp_path: Path) -> None:
    setup_rows = []
    label_rows = []
    for index in range(80):
        session = f"2026-06-{index // 8 + 1:02d}"
        price = 100.0 + index
        setup_rows.append(_setup_row(index + 1, price, session, cvd=index * 10))
        label_rows.append(_label_row(index + 1, price, 6.0 if index % 2 == 0 else 1.0, session))
    setups = tmp_path / "setups.jsonl"
    labels = tmp_path / "labels.jsonl"
    setups.write_text(_jsonl(setup_rows), encoding="utf-8")
    labels.write_text(_jsonl(label_rows), encoding="utf-8")

    result = train_models(
        TrainingConfig(
            setup_path=setups,
            labels_path=labels,
            out_root=tmp_path / "runs",
            min_positives=10,
            min_negatives=10,
            run_id="synthetic",
        )
    )

    metadata = json.loads((result.run_dir / "metadata" / "zone_rejection_1s.json").read_text())
    assert metadata["status"] == "trained"
    assert metadata["calibration_method"] in {"platt", "isotonic"}
    assert metadata["gate"]["gate_name"] == "ra093_model_gate_mirror_v1"
    assert (result.run_dir / "models" / "zone_rejection_1s.joblib").exists()
    report = result.report_path.read_text(encoding="utf-8")
    assert "## zone_rejection" in report
    assert "Recommended action" in report


def _jsonl(rows: list[dict]) -> str:
    return "".join(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n" for row in rows)


def _setup_row(ts_ns: int, price: float, session: str, cvd: float = 0.0) -> dict:
    signal_id = f"{session}|rth|{ts_ns}|sweep|sweep_detected|z1|{price:.2f}"
    return {
        "schema_version": 1,
        "ts_ns": ts_ns,
        "setup_type": "zone_rejection",
        "direction": "long",
        "price": price,
        "level_id": "z1",
        "zone_context": {"id": "z1", "kind": "vwap", "price": price, "distance_pts": 0.0},
        "regime": "NORMAL",
        "orderflow_snapshot": {
            "quality": "live",
            "cvd": {"session_cvd": cvd, "last_60m_cvd": cvd / 2, "last_15m_cvd": cvd / 4},
        },
        "depth_snapshot": {
            "quality": "live",
            "mid": price,
            "bid_levels": [{"price": price - 0.25, "size": 10 + cvd / 100}],
            "ask_levels": [{"price": price + 0.25, "size": 10}],
        },
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
        "replay": {"capture_date": session, "session": "rth", "step_ns": 500000000},
    }


def _label_row(ts_ns: int, price: float, mfe_ticks: float, session: str) -> dict:
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
                "capture_date": session,
                "session": "rth",
                "step_ns": "500000000",
                "source_obs01": "obs.jsonl",
                "source_mbo": None,
                "schema_version": 1,
            },
        },
        "candidate_seed": {"ts_ns": str(ts_ns)},
        "forward_returns": [
            {"horizon_seconds": 1, "status": "ok", "mfe_ticks": mfe_ticks},
            {"horizon_seconds": 5, "status": "ok", "mfe_ticks": mfe_ticks},
            {"horizon_seconds": 15, "status": "ok", "mfe_ticks": mfe_ticks},
            {"horizon_seconds": 60, "status": "ok", "mfe_ticks": mfe_ticks},
            {"horizon_seconds": 300, "status": "ok", "mfe_ticks": mfe_ticks},
        ],
    }
