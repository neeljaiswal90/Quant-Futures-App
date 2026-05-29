from __future__ import annotations

import json
from pathlib import Path

from rithmic_dashboard.cli.generate import main

from .conftest import sample_envelope


def _make_analytics_root(tmp_path: Path) -> Path:
    root = tmp_path / "rithmic_analytics"
    zones = root / "data" / "zones"
    captures = root / "data" / "captures" / "2026-05-21"
    zones.mkdir(parents=True)
    captures.mkdir(parents=True)
    (zones / "2026-05-21_MNQ_rth.json").write_text(
        json.dumps(sample_envelope()),
        encoding="utf-8",
    )
    (captures / "MNQ_rth.jsonl").write_text(
        json.dumps({"stream": "LAST_TRADE", "price": 29237.5, "exchange_event_ts_ns": "1779374400000000000"}),
        encoding="utf-8",
    )
    return root


def test_cli_generate_writes_html(tmp_path: Path) -> None:
    root = _make_analytics_root(tmp_path)
    out = tmp_path / "dashboard" / "index.html"
    code = main(
        [
            "--analytics-root",
            str(root),
            "--output-path",
            str(out),
            "--now-pt",
            "2026-05-21T08:00:00-07:00",
        ]
    )
    assert code == 0
    assert out.exists()
    assert "MNQ current price" in out.read_text(encoding="utf-8")


def test_cli_generate_persists_state_files(tmp_path: Path) -> None:
    root = _make_analytics_root(tmp_path)
    out = tmp_path / "dashboard" / "index.html"
    main(["--analytics-root", str(root), "--output-path", str(out), "--now-pt", "2026-05-21T08:00:00-07:00"])
    assert (out.parent / "_state.json").exists()
    assert (out.parent / "_scenarios.json").exists()
    assert (out.parent / "_audit.json").exists()


def test_cli_generate_fail_open_when_zones_missing(tmp_path: Path) -> None:
    root = tmp_path / "rithmic_analytics"
    (root / "data" / "captures" / "2026-05-21").mkdir(parents=True)
    out = tmp_path / "dashboard" / "index.html"
    code = main(
        [
            "--analytics-root",
            str(root),
            "--output-path",
            str(out),
            "--now-pt",
            "2026-05-21T08:00:00-07:00",
        ]
    )
    assert code == 0
    html = out.read_text(encoding="utf-8")
    assert "No zones JSON available" in html


def test_cli_generate_keeps_data_warnings_out_of_audit(tmp_path: Path) -> None:
    root = tmp_path / "rithmic_analytics"
    (root / "data" / "captures" / "2026-05-21").mkdir(parents=True)
    out = tmp_path / "dashboard" / "index.html"
    main(
        [
            "--analytics-root",
            str(root),
            "--output-path",
            str(out),
            "--now-pt",
            "2026-05-21T08:00:00-07:00",
        ]
    )
    audit = json.loads((out.parent / "_audit.json").read_text(encoding="utf-8"))
    assert all(entry["event_type"] != "data_warning" for entry in audit["entries"])
