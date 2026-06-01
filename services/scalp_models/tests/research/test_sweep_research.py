from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from rithmic_dashboard.models import TradeTick

from scalp_models.pipeline import PipelineSession
from scalp_models.research import sweep
from scalp_models.research.sweep import (
    SweepResearchConfig,
    _audit_session,
    _detect_research_sweeps,
    run_sweep_research,
    wilson_interval,
)


def test_wilson_interval_matches_known_rounded_value() -> None:
    low, high = wilson_interval(42, 100)

    assert round(low, 4) == 0.3280
    assert round(high, 4) == 0.5179


def test_rolling_detector_collects_multiple_sweeps_for_same_level() -> None:
    base = _ns("2026-05-29T13:30:00+00:00")
    ticks = [
        TradeTick(base, 99.0, 5, "sell"),
        TradeTick(base + 1_000_000_000, 100.75, 5, "buy"),
        TradeTick(base + 70_000_000_000, 99.0, 5, "sell"),
        TradeTick(base + 71_000_000_000, 100.75, 5, "buy"),
    ]

    events = _detect_research_sweeps(
        ticks,
        [{"level_id": "ref-vpoc-100", "text": "VPOC 100", "source": "vpoc", "price": 100.0}],
        detector_step_seconds=1,
    )

    assert [event.timestamp_ns for event in events] == [
        base + 1_000_000_000,
        base + 71_000_000_000,
    ]


def test_completeness_marks_mid_session_gap_partial(tmp_path: Path) -> None:
    obs01 = tmp_path / "MNQ_rth.obs01.jsonl"
    obs01.write_text("{}\n", encoding="utf-8")
    session = PipelineSession(capture_date="2026-05-29", session="rth")
    ticks = [
        TradeTick(_ns("2026-05-29T13:31:00+00:00"), 100.0, 1, "buy"),
        TradeTick(_ns("2026-05-29T13:32:00+00:00"), 100.25, 1, "buy"),
        TradeTick(_ns("2026-05-29T13:34:05+00:00"), 100.50, 1, "buy"),
        TradeTick(_ns("2026-05-29T20:05:00+00:00"), 101.00, 1, "buy"),
    ]

    audit = _audit_session(session, obs01, tmp_path / "zones.json", ticks)

    assert audit.status == "partial"
    assert "max_gap_gt_60s" in audit.reasons
    assert audit.max_gap_seconds is not None
    assert audit.max_gap_seconds >= 125.0


def test_run_sweep_research_writes_required_artifacts(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    analytics_root = tmp_path / "analytics"
    capture_dir = analytics_root / "data" / "captures" / "2026-05-29"
    zones_dir = analytics_root / "data" / "zones"
    capture_dir.mkdir(parents=True)
    zones_dir.mkdir(parents=True)
    obs01 = capture_dir / "MNQ_rth.obs01.jsonl"
    _write_obs01(
        obs01,
        [
            ("2026-05-29T13:30:00+00:00", 99.0, 5, "sell"),
            ("2026-05-29T13:30:01+00:00", 100.75, 5, "buy"),
            ("2026-05-29T13:31:10+00:00", 99.0, 5, "sell"),
            ("2026-05-29T13:31:11+00:00", 100.75, 5, "buy"),
            ("2026-05-29T13:31:12+00:00", 101.75, 5, "buy"),
        ],
    )
    (zones_dir / "2026-05-29_MNQ_rth.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "symbol": "MNQ",
                "reference_lines": [
                    {"source": "vpoc", "price": 100.0, "text": "VPOC 100.00"}
                ],
                "zones": [],
            }
        ),
        encoding="utf-8",
    )

    def fake_labels(
        *,
        config: SweepResearchConfig,
        dataset_path: Path,
        trade_tape_path: Path,
        labels_path: Path,
        manifest_path: Path,
    ) -> None:
        del trade_tape_path
        rows = [
            json.loads(line)
            for line in dataset_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        labels = []
        for row in rows:
            labels.append(
                {
                    "label_schema_version": 1,
                    "signal": {
                        "schema_version": 1,
                        "ts_ns": row["ts_ns"],
                        "family": row["family"],
                        "event_type": row["event_type"],
                        "tier": row["tier"],
                        "price": row["price"],
                        "level_id": row["level_id"],
                        "side": row["side"],
                        "direction": row["direction"],
                        "replay": row["replay"],
                    },
                    "candidate_seed": {"ts_ns": row["ts_ns"]},
                    "forward_returns": [
                        {
                            "horizon_seconds": horizon,
                            "status": "ok",
                            "realized_ticks": 5.0,
                            "mfe_ticks": 6.0,
                            "mae_ticks": -1.0,
                        }
                        for horizon in config.horizons_seconds
                    ],
                }
            )
        labels_path.write_text(
            "".join(json.dumps(row, sort_keys=True) + "\n" for row in labels),
            encoding="utf-8",
        )
        manifest_path.write_text(f'{{"row_count":{len(labels)}}}\n', encoding="utf-8")

    monkeypatch.setattr(sweep, "_run_label_cli", fake_labels)

    result = run_sweep_research(
        SweepResearchConfig(
            sessions=(PipelineSession(capture_date="2026-05-29", session="rth"),),
            analytics_root=analytics_root,
            dashboard_root=tmp_path / "dashboard",
            out_root=tmp_path / "runs",
            run_id="fixture",
            horizons_seconds=(1, 60),
            include_partial_sessions=True,
            allow_live_capture_contention=True,
            detector_step_seconds=1,
        )
    )

    for path in (
        result.report_path,
        result.conditional_tables_path,
        result.sample_counts_path,
        result.sweep_events_path,
        result.scatter_path,
        result.manifest_path,
    ):
        assert path.exists()
        assert path.stat().st_size > 0

    report = result.report_path.read_text(encoding="utf-8")
    assert "Five Operator-Readable Findings" in report
    assert "LVN/HVN levels are not measured" in report
    tables = json.loads(result.conditional_tables_path.read_text(encoding="utf-8"))
    assert tables["baseline"]["60"]["n"] >= 1


def _write_obs01(path: Path, rows: list[tuple[str, float, int, str]]) -> None:
    output = []
    for timestamp, price, quantity, side in rows:
        output.append(
            json.dumps(
                {
                    "type": "TRADE",
                    "ts_ns": _ns(timestamp),
                    "price": price,
                    "quantity": quantity,
                    "aggressor_side": side,
                }
            )
        )
    path.write_text("\n".join(output) + "\n", encoding="utf-8")


def _ns(value: str) -> int:
    return int(datetime.fromisoformat(value).astimezone(UTC).timestamp() * 1_000_000_000)
