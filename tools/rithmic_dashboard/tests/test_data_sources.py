from __future__ import annotations

import json
from pathlib import Path

from rithmic_dashboard.data_sources import get_current_price, load_envelope

from .conftest import sample_envelope


def test_load_envelope_exact_path(tmp_path: Path) -> None:
    zones = tmp_path / "data" / "zones"
    zones.mkdir(parents=True)
    path = zones / "2026-05-21_MNQ_rth.json"
    path.write_text(json.dumps(sample_envelope()), encoding="utf-8")
    envelope, used, warnings = load_envelope(path, analytics_root=tmp_path)
    assert envelope is not None
    assert used == path
    assert warnings == []


def test_load_envelope_falls_back_to_latest(tmp_path: Path) -> None:
    zones = tmp_path / "data" / "zones"
    zones.mkdir(parents=True)
    fallback = zones / "2026-05-20_MNQ_rth.json"
    fallback.write_text(json.dumps(sample_envelope()), encoding="utf-8")
    envelope, used, warnings = load_envelope(zones / "missing.json", analytics_root=tmp_path)
    assert envelope is not None
    assert used == fallback
    assert warnings == []


def test_load_envelope_merges_rth_statistical_lines(tmp_path: Path) -> None:
    zones = tmp_path / "data" / "zones"
    zones.mkdir(parents=True)
    combined = zones / "2026-05-21_MNQ_session_combined.json"
    rth = zones / "2026-05-21_MNQ_rth.json"
    primary = sample_envelope()
    primary["reference_lines"] = [
        {"price": 29235.0, "text": "VPOC 29235", "source": "vpoc"},
        {"price": 29415.0, "text": "VAH 29415", "source": "vah"},
    ]
    overlay = sample_envelope()
    combined.write_text(json.dumps(primary), encoding="utf-8")
    rth.write_text(json.dumps(overlay), encoding="utf-8")

    envelope, used, warnings = load_envelope(combined, analytics_root=tmp_path)

    assert used == combined
    assert not warnings
    assert envelope is not None
    sources = {line["source"] for line in envelope["reference_lines"]}
    assert {"vpoc", "vah", "vwap_rth", "vwap_rth_band_p1sd", "vwap_rth_band_m1sd"} <= sources
    assert "vwap_rth_band_p2sd" in sources
    assert "vwap_rth_band_m2sd" in sources
    assert envelope["dashboard_sources"]["overlay_path"] == str(rth)


def test_load_envelope_uses_overlay_only_when_primary_missing(tmp_path: Path) -> None:
    zones = tmp_path / "data" / "zones"
    zones.mkdir(parents=True)
    rth = zones / "2026-05-21_MNQ_rth.json"
    rth.write_text(json.dumps(sample_envelope()), encoding="utf-8")

    envelope, used, warnings = load_envelope(
        zones / "2026-05-21_MNQ_session_combined.json",
        analytics_root=tmp_path,
    )

    assert used == rth
    assert envelope is not None
    assert envelope["dashboard_sources"]["mode"] == "overlay_only"
    assert warnings == []


def test_get_current_price_from_raw_last_trade(tmp_path: Path) -> None:
    path = tmp_path / "MNQ_rth.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"stream": "MBO", "price": 1}),
                json.dumps({"stream": "LAST_TRADE", "price": 29240.25, "exchange_event_ts_ns": "1779374400000000000"}),
            ]
        ),
        encoding="utf-8",
    )
    snapshot = get_current_price(path)
    assert snapshot.price == 29240.25
    assert snapshot.source == "raw capture tail"


def test_get_current_price_prefers_obs_sibling(tmp_path: Path) -> None:
    raw = tmp_path / "MNQ_rth.jsonl"
    obs = tmp_path / "MNQ_rth.obs01.jsonl"
    raw.write_text(
        json.dumps({"stream": "LAST_TRADE", "price": 111.0, "exchange_event_ts_ns": "1779374400000000000"}) + "\n",
        encoding="utf-8",
    )
    obs.write_text(
        json.dumps({"type": "TRADE", "payload": {"price": 29241.0, "exchange_event_ts_ns": "1779374400000000000"}}),
        encoding="utf-8",
    )
    snapshot = get_current_price(raw)
    assert snapshot.price == 29241.0
    assert snapshot.source == "normalized OBS-01 trade tail"


def test_get_current_price_uses_last_known_when_missing(tmp_path: Path) -> None:
    snapshot = get_current_price(tmp_path / "missing.jsonl", last_known_price=29200.0)
    assert snapshot.price == 29200.0
    assert snapshot.source == "state:last_known_price"
