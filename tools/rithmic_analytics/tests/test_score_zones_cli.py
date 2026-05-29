"""Tests for ``rithmic_analytics.cli.score_zones`` (RA-027)."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from rithmic_analytics.cli.score_zones import (
    EXIT_BAD_INPUT,
    EXIT_OK,
    EXIT_USAGE,
    main,
)

# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


def _write_obs01_jsonl(path: Path, *, prices: list[float], base_ts: int = 1_777_300_000_000_000_000) -> None:
    """Write a minimal OBS-01 JSONL fixture the loader will accept."""
    lines = []
    for i, p in enumerate(prices):
        envelope = {
            "type": "TRADE",
            "session_id": "mnq-2026-05-19-rth",
            "payload": {
                "exchange_event_ts_ns": str(base_ts + i * 1_000_000_000),
                "sidecar_recv_ts_ns": str(base_ts + i * 1_000_000_000),
                "price": p,
                "quantity": 1,
                "aggressor_side": "buy" if i % 2 == 0 else "sell",
                "trade_id": f"t-{i}",
            },
        }
        lines.append(json.dumps(envelope))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_zones_envelope(
    path: Path,
    *,
    zones: list[dict[str, object]] | None = None,
    atr_14: float | None = 10.0,
) -> None:
    """Write a valid zone-envelope JSON."""
    if zones is None:
        zones = [
            {
                "id": "hvn-100", "top": 110.0, "bot": 100.0,
                "type": "support", "conviction": "MED",
                "text": "HVN 10%", "sources": ["hvn_rth"],
                "volume_pct": 0.1,
                "multi_tf_count": None,
                "multi_session_count": None,
            }
        ]
    payload = {
        "schema_version": 1,
        "symbol": "MNQ",
        "timeframe": "rth",
        "bars_used": 100,
        "computed_at": "2026-05-18T20:00:00+00:00",
        "data_source": "rithmic",
        "vpoc": 105.0,
        "vah": 110.0,
        "val": 100.0,
        "atr_14": atr_14,
        "bin_size_ticks": 20,
        "zones": zones,
        "reference_lines": [],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


# ---------------------------------------------------------------------------
# Single-session mode
# ---------------------------------------------------------------------------


def test_single_session_happy_path(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    jsonl = tmp_path / "trades.jsonl"
    out = tmp_path / "report.json"
    # Price stays above zone the whole time → untouched
    _write_obs01_jsonl(jsonl, prices=[120.0] * 700)
    _write_zones_envelope(zones)

    rc = main([
        "--zones", str(zones),
        "--jsonl", str(jsonl),
        "--output", str(out),
    ])

    assert rc == EXIT_OK
    assert out.exists()
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["outcomes"][0]["final_outcome"] == "untouched"


def test_single_session_classifies_held(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    jsonl = tmp_path / "trades.jsonl"
    out = tmp_path / "report.json"
    # Price above, touches, bounces → held
    prices = [120.0] * 60 + [105.0] + [120.0, 125.0] * 350
    _write_obs01_jsonl(jsonl, prices=prices)
    _write_zones_envelope(zones)

    rc = main([
        "--zones", str(zones),
        "--jsonl", str(jsonl),
        "--output", str(out),
    ])

    assert rc == EXIT_OK
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["outcomes"][0]["final_outcome"] == "held"


def test_single_session_missing_zones_returns_bad_input(tmp_path: Path) -> None:
    jsonl = tmp_path / "trades.jsonl"
    _write_obs01_jsonl(jsonl, prices=[120.0])
    rc = main([
        "--zones", str(tmp_path / "no.json"),
        "--jsonl", str(jsonl),
        "--output", str(tmp_path / "report.json"),
    ])
    assert rc == EXIT_BAD_INPUT


def test_single_session_missing_jsonl_returns_bad_input(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)
    rc = main([
        "--zones", str(zones),
        "--jsonl", str(tmp_path / "no.jsonl"),
        "--output", str(tmp_path / "report.json"),
    ])
    assert rc == EXIT_BAD_INPUT


def test_mutually_exclusive_modes_rejected(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    jsonl = tmp_path / "trades.jsonl"
    _write_zones_envelope(zones)
    _write_obs01_jsonl(jsonl, prices=[120.0])
    rc = main([
        "--zones", str(zones),
        "--jsonl", str(jsonl),
        "--aggregate-from-dir", str(tmp_path),
        "--output", str(tmp_path / "report.json"),
    ])
    assert rc == EXIT_USAGE


def test_no_mode_specified_returns_usage(tmp_path: Path) -> None:
    rc = main(["--output", str(tmp_path / "report.json")])
    assert rc == EXIT_USAGE


def test_partial_single_session_args_returns_usage(tmp_path: Path) -> None:
    """--zones without --jsonl → usage error."""
    zones = tmp_path / "zones.json"
    _write_zones_envelope(zones)
    rc = main([
        "--zones", str(zones),
        "--output", str(tmp_path / "report.json"),
    ])
    assert rc == EXIT_USAGE


def test_negative_settlement_window_returns_usage(tmp_path: Path) -> None:
    zones = tmp_path / "zones.json"
    jsonl = tmp_path / "trades.jsonl"
    _write_zones_envelope(zones)
    _write_obs01_jsonl(jsonl, prices=[120.0])
    rc = main([
        "--zones", str(zones),
        "--jsonl", str(jsonl),
        "--output", str(tmp_path / "report.json"),
        "--settlement-window-minutes", "-1",
    ])
    assert rc == EXIT_USAGE


# ---------------------------------------------------------------------------
# Aggregate mode — pairing rules
# ---------------------------------------------------------------------------


def _setup_aggregate_dirs(tmp_path: Path) -> tuple[Path, Path]:
    """Create zones_dir + captures_root and return them."""
    zones_dir = tmp_path / "zones"
    captures_root = tmp_path / "captures"
    zones_dir.mkdir()
    captures_root.mkdir()
    return zones_dir, captures_root


def _seed_pair(
    zones_dir: Path, captures_root: Path,
    *, zones_date: str, capture_date: str, session: str = "rth",
    root: str = "MNQ",
    prices: list[float] | None = None,
) -> None:
    """Drop a paired zones JSON + capture JSONL."""
    if prices is None:
        prices = [120.0] * 700
    _write_zones_envelope(zones_dir / f"{zones_date}_{root}_{session}.json")
    cap_dir = captures_root / capture_date
    cap_dir.mkdir(parents=True, exist_ok=True)
    _write_obs01_jsonl(cap_dir / f"{root}_{session}.jsonl", prices=prices)


def test_aggregate_next_day_pairs_correctly(tmp_path: Path) -> None:
    zones_dir, captures_root = _setup_aggregate_dirs(tmp_path)
    # Zones from 2026-05-17 RTH should pair with capture from 2026-05-18 RTH
    _seed_pair(zones_dir, captures_root, zones_date="2026-05-17",
               capture_date="2026-05-18")
    out = tmp_path / "history.json"

    rc = main([
        "--aggregate-from-dir", str(zones_dir),
        "--captures-root", str(captures_root),
        "--output", str(out),
        "--pairing", "next-day",
    ])

    assert rc == EXIT_OK
    history = json.loads(out.read_text(encoding="utf-8"))
    assert history["sessions_analyzed"] == 1
    assert history["pairing"] == "next-day"


def test_aggregate_next_day_skips_weekend_to_next_existing(tmp_path: Path) -> None:
    """Friday zones → Monday capture (gap of 3 days handled)."""
    zones_dir, captures_root = _setup_aggregate_dirs(tmp_path)
    # Friday 2026-05-15 zones, Monday 2026-05-18 capture (Sat/Sun missing)
    _seed_pair(zones_dir, captures_root, zones_date="2026-05-15",
               capture_date="2026-05-18")
    out = tmp_path / "history.json"

    rc = main([
        "--aggregate-from-dir", str(zones_dir),
        "--captures-root", str(captures_root),
        "--output", str(out),
        "--pairing", "next-day",
    ])

    assert rc == EXIT_OK
    history = json.loads(out.read_text(encoding="utf-8"))
    assert history["sessions_analyzed"] == 1


def test_aggregate_next_day_skips_unpaired_zones(tmp_path: Path) -> None:
    """Zones with no forward capture → skipped, not error."""
    zones_dir, captures_root = _setup_aggregate_dirs(tmp_path)
    # Zones from 2026-05-17 but no capture anywhere forward → skipped
    _write_zones_envelope(zones_dir / "2026-05-17_MNQ_rth.json")
    out = tmp_path / "history.json"

    rc = main([
        "--aggregate-from-dir", str(zones_dir),
        "--captures-root", str(captures_root),
        "--output", str(out),
        "--pairing", "next-day",
    ])

    assert rc == EXIT_OK
    history = json.loads(out.read_text(encoding="utf-8"))
    assert history["sessions_analyzed"] == 0


def test_aggregate_globex_to_rth_pairs_same_day(tmp_path: Path) -> None:
    zones_dir, captures_root = _setup_aggregate_dirs(tmp_path)
    # Globex zones from 2026-05-19 morning → RTH capture from 2026-05-19
    _write_zones_envelope(zones_dir / "2026-05-19_MNQ_globex.json")
    cap_dir = captures_root / "2026-05-19"
    cap_dir.mkdir()
    _write_obs01_jsonl(cap_dir / "MNQ_rth.jsonl", prices=[120.0] * 700)
    out = tmp_path / "history.json"

    rc = main([
        "--aggregate-from-dir", str(zones_dir),
        "--captures-root", str(captures_root),
        "--output", str(out),
        "--pairing", "globex-to-rth",
    ])

    assert rc == EXIT_OK
    history = json.loads(out.read_text(encoding="utf-8"))
    assert history["sessions_analyzed"] == 1
    assert history["pairing"] == "globex-to-rth"


def test_aggregate_globex_to_rth_skips_rth_zones(tmp_path: Path) -> None:
    """RTH zones don't feed globex-to-rth pairing — they're skipped."""
    zones_dir, captures_root = _setup_aggregate_dirs(tmp_path)
    _seed_pair(zones_dir, captures_root, zones_date="2026-05-19",
               capture_date="2026-05-19", session="rth")
    out = tmp_path / "history.json"

    rc = main([
        "--aggregate-from-dir", str(zones_dir),
        "--captures-root", str(captures_root),
        "--output", str(out),
        "--pairing", "globex-to-rth",
    ])

    assert rc == EXIT_OK
    history = json.loads(out.read_text(encoding="utf-8"))
    assert history["sessions_analyzed"] == 0


def test_aggregate_same_day_warns(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    zones_dir, captures_root = _setup_aggregate_dirs(tmp_path)
    _seed_pair(zones_dir, captures_root, zones_date="2026-05-19",
               capture_date="2026-05-19")
    out = tmp_path / "history.json"

    with caplog.at_level(logging.WARNING, logger="rithmic_analytics.score_zones"):
        rc = main([
            "--aggregate-from-dir", str(zones_dir),
            "--captures-root", str(captures_root),
            "--output", str(out),
            "--pairing", "same-day",
        ])

    assert rc == EXIT_OK
    assert any("post-hoc" in r.message for r in caplog.records)


def test_aggregate_skips_malformed_filenames(tmp_path: Path) -> None:
    """Files in zones dir that don't match the canonical name are skipped."""
    zones_dir, captures_root = _setup_aggregate_dirs(tmp_path)
    (zones_dir / "not_a_zone_file.txt").write_text("ignore me")
    (zones_dir / "weird_name.json").write_text("{}")
    # Plus one valid pair
    _seed_pair(zones_dir, captures_root, zones_date="2026-05-17",
               capture_date="2026-05-18")
    out = tmp_path / "history.json"

    rc = main([
        "--aggregate-from-dir", str(zones_dir),
        "--captures-root", str(captures_root),
        "--output", str(out),
    ])

    assert rc == EXIT_OK
    history = json.loads(out.read_text(encoding="utf-8"))
    assert history["sessions_analyzed"] == 1


def test_aggregate_missing_root_dir_returns_bad_input(tmp_path: Path) -> None:
    rc = main([
        "--aggregate-from-dir", str(tmp_path / "no_zones"),
        "--captures-root", str(tmp_path),
        "--output", str(tmp_path / "report.json"),
    ])
    assert rc == EXIT_BAD_INPUT


def test_aggregate_missing_captures_root_returns_bad_input(tmp_path: Path) -> None:
    zones_dir = tmp_path / "zones"
    zones_dir.mkdir()
    rc = main([
        "--aggregate-from-dir", str(zones_dir),
        "--captures-root", str(tmp_path / "no_captures"),
        "--output", str(tmp_path / "report.json"),
    ])
    assert rc == EXIT_BAD_INPUT


def test_aggregate_empty_directory_produces_empty_history(tmp_path: Path) -> None:
    zones_dir, captures_root = _setup_aggregate_dirs(tmp_path)
    out = tmp_path / "history.json"

    rc = main([
        "--aggregate-from-dir", str(zones_dir),
        "--captures-root", str(captures_root),
        "--output", str(out),
    ])

    assert rc == EXIT_OK
    history = json.loads(out.read_text(encoding="utf-8"))
    assert history["sessions_analyzed"] == 0
    # Every conviction tier rendered explicitly per Neel's "n=0 visible" requirement
    for tier in ("SUPER", "HIGH", "MED", "LOW"):
        assert tier in history["hit_rate_by_conviction"]
        assert history["hit_rate_by_conviction"][tier]["insufficient_data"] is True


def test_aggregate_window_sessions_respected(tmp_path: Path) -> None:
    """5 pairs but window=2 → only last 2 are aggregated."""
    zones_dir, captures_root = _setup_aggregate_dirs(tmp_path)
    pairs = [
        ("2026-05-13", "2026-05-14"),
        ("2026-05-14", "2026-05-15"),
        ("2026-05-15", "2026-05-18"),
        ("2026-05-18", "2026-05-19"),
        ("2026-05-19", "2026-05-20"),
    ]
    for zd, cd in pairs:
        _seed_pair(zones_dir, captures_root, zones_date=zd, capture_date=cd)
    out = tmp_path / "history.json"

    rc = main([
        "--aggregate-from-dir", str(zones_dir),
        "--captures-root", str(captures_root),
        "--output", str(out),
        "--window-sessions", "2",
    ])

    assert rc == EXIT_OK
    history = json.loads(out.read_text(encoding="utf-8"))
    assert history["sessions_analyzed"] == 2
    assert history["window_sessions"] == 2


def test_window_sessions_zero_rejected(tmp_path: Path) -> None:
    zones_dir, captures_root = _setup_aggregate_dirs(tmp_path)
    rc = main([
        "--aggregate-from-dir", str(zones_dir),
        "--captures-root", str(captures_root),
        "--output", str(tmp_path / "report.json"),
        "--window-sessions", "0",
    ])
    assert rc == EXIT_USAGE


# ---------------------------------------------------------------------------
# Settlement window flag plumbing
# ---------------------------------------------------------------------------


def test_settlement_window_flag_threads_through(tmp_path: Path) -> None:
    """Late-session touch + short settlement window → classified, not ambiguous."""
    zones = tmp_path / "zones.json"
    jsonl = tmp_path / "trades.jsonl"
    out = tmp_path / "report.json"
    # Touch at the very end, only 5 sec after, no break
    prices = [120.0] * 695 + [105.0] + [120.0] * 4
    _write_obs01_jsonl(jsonl, prices=prices)
    _write_zones_envelope(zones)

    # Default settlement (10 min) → ambiguous
    rc1 = main([
        "--zones", str(zones), "--jsonl", str(jsonl), "--output", str(out),
    ])
    assert rc1 == EXIT_OK
    r1 = json.loads(out.read_text(encoding="utf-8"))
    assert r1["outcomes"][0]["final_outcome"] == "ambiguous"

    # With --settlement-window-minutes 0 → held
    rc2 = main([
        "--zones", str(zones), "--jsonl", str(jsonl), "--output", str(out),
        "--settlement-window-minutes", "0",
    ])
    assert rc2 == EXIT_OK
    r2 = json.loads(out.read_text(encoding="utf-8"))
    assert r2["outcomes"][0]["final_outcome"] == "held"
