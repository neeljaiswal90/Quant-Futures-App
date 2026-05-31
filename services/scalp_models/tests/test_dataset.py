from scalp_models.dataset import DatasetConfig, build_training_examples


def test_join_setup_rows_to_forward_labels_and_exclude_non_ok() -> None:
    setup = make_setup_row()
    label = make_label_row(status_1s="ok", mfe_1s=5.0, status_5s="tape_eof_before_horizon")

    result = build_training_examples(
        setup_rows=[setup],
        label_rows=[label],
        config=DatasetConfig(target_ticks=4.0, horizons_seconds=(1, 5)),
    )

    assert len(result.examples) == 1
    assert result.examples[0].label == 1
    assert result.examples[0].horizon_seconds == 1
    assert result.exclusion_counts == {"zone_rejection|5|tape_eof_before_horizon": 1}


def test_missing_label_is_excluded_not_negative() -> None:
    result = build_training_examples(
        setup_rows=[make_setup_row()],
        label_rows=[],
        config=DatasetConfig(horizons_seconds=(1,)),
    )

    assert result.examples == []
    assert result.exclusion_counts == {"zone_rejection|1|missing_label": 1}


def make_setup_row(ts_ns: int = 1000, setup_type: str = "zone_rejection") -> dict:
    return {
        "schema_version": 1,
        "ts_ns": ts_ns,
        "setup_type": setup_type,
        "direction": "long",
        "price": 100.0,
        "level_id": "z1",
        "zone_context": {"id": "z1", "kind": "vwap", "price": 100.0, "distance_pts": 0.0},
        "regime": "NORMAL",
        "orderflow_snapshot": {},
        "depth_snapshot": {},
        "confluence_stack_size": 2,
        "source_signals": [
            {
                "signal_id": "2026-06-01_rth|rth|1000|sweep|sweep_detected|z1|100.00",
                "ts_ns": ts_ns,
                "family": "sweep",
                "event_type": "sweep_detected",
                "price": 100.0,
                "level_id": "z1",
                "tier": "HIGH",
            }
        ],
        "features": {},
        "replay": {"capture_date": "2026-06-01_rth", "session": "rth", "step_ns": 500000000},
    }


def make_label_row(*, status_1s: str, mfe_1s: float, status_5s: str) -> dict:
    return {
        "label_schema_version": 1,
        "signal": {
            "schema_version": 1,
            "ts_ns": "1000",
            "family": "sweep",
            "event_type": "sweep_detected",
            "tier": "HIGH",
            "price": 100.0,
            "level_id": "z1",
            "side": None,
            "direction": "long",
            "replay": {
                "capture_date": "2026-06-01_rth",
                "session": "rth",
                "step_ns": "500000000",
                "source_obs01": "obs.jsonl",
                "source_mbo": None,
                "schema_version": 1,
            },
        },
        "candidate_seed": {"ts_ns": "1000"},
        "forward_returns": [
            {"horizon_seconds": 1, "status": status_1s, "mfe_ticks": mfe_1s},
            {"horizon_seconds": 5, "status": status_5s, "mfe_ticks": None},
        ],
    }
