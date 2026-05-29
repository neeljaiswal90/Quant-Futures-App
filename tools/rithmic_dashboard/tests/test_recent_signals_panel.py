from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from rithmic_dashboard.features.recent_signals_panel import build_recent_signals
from rithmic_dashboard.level_distances import compute_level_distances
from rithmic_dashboard.models import AdjustmentFactor, AuditEntry, ScenarioState
from rithmic_dashboard.session_state import PT, determine_session_state

from .conftest import sample_envelope


def test_recent_signals_prefer_live_jsonl_and_enrich_scenarios(tmp_path: Path) -> None:
    now_pt = datetime(2026, 5, 26, 6, 40, tzinfo=PT)
    live_dir = tmp_path / "live_analysis"
    live_dir.mkdir()
    _write_jsonl(
        live_dir / "2026-05-26_globex_sweeps.jsonl",
        [
            {
                "timestamp_pt": "2026-05-26 06:36:00 PT",
                "timestamp_ns": _ns(datetime(2026, 5, 26, 6, 36, tzinfo=PT)),
                "level_id": "ref-vah-29425.00",
                "level_text": "VAH 29425",
                "level_price": 29425.0,
                "direction": "up",
                "intensity_score": 5.0,
                "recovered_within_5min": False,
            },
            {
                "timestamp_pt": "2026-05-26 06:00:00 PT",
                "timestamp_ns": _ns(datetime(2026, 5, 26, 6, 0, tzinfo=PT)),
                "level_id": "ref-vah-29425.00",
                "level_text": "VAH 29425",
                "level_price": 29425.0,
                "direction": "up",
                "intensity_score": 5.0,
                "recovered_within_5min": False,
            },
        ],
    )
    _write_jsonl(
        live_dir / "2026-05-26_globex_absorption_proxy.jsonl",
        [
            {
                "timestamp_pt": "2026-05-26 06:37:00 PT",
                "timestamp_ns": _ns(datetime(2026, 5, 26, 6, 37, tzinfo=PT)),
                "price": 29425.25,
                "volume": 210,
                "net_delta": 4,
                "side_inferred": "sell_absorbed",
                "confidence": "high",
            }
        ],
    )
    _write_jsonl(
        live_dir / "2026-05-26_globex_institutional_flow.jsonl",
        [
            {
                "timestamp_pt": "2026-05-26 06:38:00 PT",
                "timestamp_ns": _ns(datetime(2026, 5, 26, 6, 38, tzinfo=PT)),
                "event_type": "institutional_concentration_detected",
                "level_price": 29425.0,
                "level_text": "VAH 29425",
                "direction": "long",
                "description": "Institutional concentration at VAH",
            }
        ],
    )
    audit = [
        AuditEntry(
            "2026-05-26 06:39:00 PT",
            "absorption_proxy",
            "Absorption proxy at 29,999.00: vol 999, delta +1, confidence low",
            "absorption-29999.00",
        )
    ]
    signals = build_recent_signals(
        live_dir=live_dir,
        session=determine_session_state(
            now_pt=now_pt,
            analytics_root=tmp_path,
            trading_date_override="2026-05-26",
            session_override="globex",
        ),
        audit=audit,
        scenarios=[_scenario("L1", "long", 29420.0, 29430.0)],
        levels=compute_level_distances(sample_envelope(), 29424.0, 40.0),
        now_pt=now_pt,
    )

    assert [signal.family for signal in signals] == ["institutional_flow", "absorption", "sweep"]
    assert signals[0].scenario_refs == ("L1",)
    assert signals[1].zone_key == "level:ref-vah-29425.00"
    assert all("29,999" not in signal.description for signal in signals)


def test_recent_signals_fall_back_to_audit_when_live_file_missing(tmp_path: Path) -> None:
    now_pt = datetime(2026, 5, 26, 6, 40, tzinfo=PT)
    signals = build_recent_signals(
        live_dir=tmp_path / "missing",
        session=determine_session_state(
            now_pt=now_pt,
            analytics_root=tmp_path,
            trading_date_override="2026-05-26",
            session_override="globex",
        ),
        audit=[
            AuditEntry(
                "2026-05-26 06:35:00 PT",
                "absorption_proxy",
                "Absorption proxy at 29,425.25: vol 210, delta +4, confidence low",
                "absorption-29425.25",
            )
        ],
        scenarios=[_scenario("L1", "long", 29420.0, 29430.0)],
        levels=compute_level_distances(sample_envelope(), 29424.0, 40.0),
        now_pt=now_pt,
    )

    assert len(signals) == 1
    assert signals[0].family == "absorption"
    assert signals[0].scenario_refs == ("L1",)


def test_day_type_session_event_appears_without_zone_reference(tmp_path: Path) -> None:
    now_pt = datetime(2026, 5, 26, 8, 5, tzinfo=PT)
    live_dir = tmp_path / "live_analysis"
    live_dir.mkdir()
    _write_jsonl(
        live_dir / "2026-05-26_rth_day_type.jsonl",
        [
            {
                "timestamp_pt": "2026-05-26 08:00:00 PT",
                "timestamp_ns": _ns(datetime(2026, 5, 26, 8, 0, tzinfo=PT)),
                "event_type": "day_type_classified",
                "level_id": None,
                "description": "NORMAL VARIATION UP: IB 100-110",
                "intensity": 3.0,
                "confidence": "high",
                "metadata": {"day_type": "normal_variation_up"},
            }
        ],
    )

    signals = build_recent_signals(
        live_dir=live_dir,
        session=determine_session_state(
            now_pt=now_pt,
            analytics_root=tmp_path,
            trading_date_override="2026-05-26",
            session_override="rth",
        ),
        audit=[],
        scenarios=[_scenario("IB-Long", "long", 115.0, 120.0)],
        levels=compute_level_distances(sample_envelope(), 29424.0, 40.0),
        now_pt=now_pt,
    )

    assert len(signals) == 1
    assert signals[0].family == "day_type"
    assert signals[0].scenario_refs == ()
    assert signals[0].zone_price is None


def test_vol_regime_session_event_appears_without_zone_reference(tmp_path: Path) -> None:
    now_pt = datetime(2026, 5, 26, 8, 5, tzinfo=PT)
    live_dir = tmp_path / "live_analysis"
    live_dir.mkdir()
    _write_jsonl(
        live_dir / "2026-05-26_rth_vol_regime.jsonl",
        [
            {
                "timestamp_pt": "2026-05-26 08:00:00 PT",
                "timestamp_ns": _ns(datetime(2026, 5, 26, 8, 0, tzinfo=PT)),
                "event_type": "vol_regime_changed",
                "level_id": None,
                "description": "Volatility regime changed NORMAL -> HIGH",
                "intensity": 1.42,
                "confidence": "high",
                "metadata": {"regime": "HIGH"},
            }
        ],
    )

    signals = build_recent_signals(
        live_dir=live_dir,
        session=determine_session_state(
            now_pt=now_pt,
            analytics_root=tmp_path,
            trading_date_override="2026-05-26",
            session_override="rth",
        ),
        audit=[],
        scenarios=[_scenario("L1", "long", 100.0, 110.0)],
        levels=compute_level_distances(sample_envelope(), 29424.0, 40.0),
        now_pt=now_pt,
    )

    assert len(signals) == 1
    assert signals[0].family == "vol_regime"
    assert signals[0].label == "Vol regime"
    assert signals[0].scenario_refs == ()
    assert signals[0].zone_price is None


def test_aggressor_flow_event_appears_with_family_mapping(tmp_path: Path) -> None:
    now_pt = datetime(2026, 5, 26, 8, 5, tzinfo=PT)
    live_dir = tmp_path / "live_analysis"
    live_dir.mkdir()
    _write_jsonl(
        live_dir / "2026-05-26_rth_aggressor_flow.jsonl",
        [
            {
                "timestamp_pt": "2026-05-26 08:03:00 PT",
                "timestamp_ns": _ns(datetime(2026, 5, 26, 8, 3, tzinfo=PT)),
                "event_type": "stacked_footprint_imbalance",
                "level_id": "ref-vah-29425.00",
                "level_price": 29425.0,
                "level_text": "VAH 29425",
                "direction": "long",
                "description": "Stacked footprint buy imbalance at VAH",
                "intensity": 3.0,
                "confidence": "medium",
            }
        ],
    )

    signals = build_recent_signals(
        live_dir=live_dir,
        session=determine_session_state(
            now_pt=now_pt,
            analytics_root=tmp_path,
            trading_date_override="2026-05-26",
            session_override="rth",
        ),
        audit=[],
        scenarios=[_scenario("L1", "long", 29420.0, 29430.0)],
        levels=compute_level_distances(sample_envelope(), 29424.0, 40.0),
        now_pt=now_pt,
    )

    assert len(signals) == 1
    assert signals[0].family == "aggressor_flow"
    assert signals[0].label == "Aggressor"
    assert signals[0].scenario_refs == ("L1",)


def test_iceberg_event_appears_with_family_mapping(tmp_path: Path) -> None:
    now_pt = datetime(2026, 5, 26, 8, 5, tzinfo=PT)
    live_dir = tmp_path / "live_analysis"
    live_dir.mkdir()
    _write_jsonl(
        live_dir / "2026-05-26_rth_icebergs.jsonl",
        [
            {
                "timestamp_pt": "2026-05-26 08:03:00 PT",
                "timestamp_ns": _ns(datetime(2026, 5, 26, 8, 3, tzinfo=PT)),
                "event_type": "iceberg_detected",
                "level_id": "ref-vah-29425.00",
                "level_price": 29425.0,
                "level_text": "VAH 29425",
                "direction": "short",
                "side": "ask",
                "description": "Iceberg-like ask-side refill at VAH",
                "intensity": 3.0,
                "confidence": "high",
            }
        ],
    )

    signals = build_recent_signals(
        live_dir=live_dir,
        session=determine_session_state(
            now_pt=now_pt,
            analytics_root=tmp_path,
            trading_date_override="2026-05-26",
            session_override="rth",
        ),
        audit=[],
        scenarios=[_scenario("S1", "short", 29420.0, 29430.0)],
        levels=compute_level_distances(sample_envelope(), 29424.0, 40.0),
        now_pt=now_pt,
    )

    assert len(signals) == 1
    assert signals[0].family == "iceberg"
    assert signals[0].label == "Iceberg"
    assert signals[0].icon == "🧊"
    assert signals[0].scenario_refs == ("S1",)


def _scenario(
    scenario_id: str,
    direction: str,
    low: float,
    high: float,
) -> ScenarioState:
    return ScenarioState(
        scenario_id=scenario_id,
        name=f"{scenario_id} setup",
        direction="long" if direction == "long" else "short",
        state="ACTIVE",
        entry_zone_low=low,
        entry_zone_high=high,
        stop=low - 10.0,
        target_1=high + 20.0,
        target_2=None,
        target_3=None,
        prior_prob_low=0.4,
        prior_prob_high=0.5,
        adjusted_prob_low=0.4,
        adjusted_prob_high=0.5,
        r_multiple_t1=2.0,
        r_multiple_t2=None,
        r_multiple_t3=None,
        current_r=0.0,
        adjustment_factors=(AdjustmentFactor("test", 1.0, "test"),),
        tooltip="test",
        reason="test",
    )


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text("\n".join(json.dumps(row, sort_keys=True) for row in rows), encoding="utf-8")


def _ns(value: datetime) -> int:
    return int(value.astimezone(UTC).timestamp() * 1_000_000_000)
