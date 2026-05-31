from __future__ import annotations

from pathlib import Path

from replay.dataset import ReplayContext, SignalDatasetRow, ZoneContext
from replay.setups import (
    SetupDatasetManifest,
    derive_setup_rows,
    setup_dataset_text,
    write_setup_dataset,
)

BASE_TS = 1_770_000_000_000_000_000


def test_derive_all_ra092_setup_types(tmp_path: Path) -> None:
    rows = [
        _row(
            ts=BASE_TS,
            family="sweep",
            event_type="sweep_detected",
            direction="down",
            price=30350.0,
            level_id="zone-a",
        ),
        _row(
            ts=BASE_TS + 3_000_000_000,
            family="absorption",
            event_type="absorption_proxy",
            side="buy_absorbed",
            price=30350.5,
            level_id="zone-a",
        ),
        _row(
            ts=BASE_TS + 5_000_000_000,
            family="iceberg",
            event_type="iceberg_detected",
            direction="long",
            price=30352.0,
            level_id="zone-a",
        ),
        _row(
            ts=BASE_TS + 7_000_000_000,
            family="dislocation",
            event_type="delta_dislocation_long_detected",
            direction="bullish",
            price=30351.0,
            level_id="zone-a",
            orderflow_snapshot={
                "cvd": {
                    "session_cvd": -900,
                    "last_15m_cvd": 600,
                    "session_direction": "bearish",
                    "last_15m_direction": "bullish",
                    "momentum_flip": True,
                },
                "footprint": {"stacked_side": "sell"},
            },
        ),
        _row(
            ts=BASE_TS + 10_000_000_000,
            family="aggressor_flow",
            event_type="aggressor_imbalance_extreme",
            direction="bullish",
            price=30351.0,
            level_id="zone-a",
            depth_snapshot=_depth_snapshot(bid_size=90, ask_size=10),
        ),
        _row(
            ts=BASE_TS + 13_000_000_000,
            family="aggressor_flow",
            event_type="aggressor_imbalance_extreme",
            direction="bullish",
            price=30351.25,
            level_id="zone-a",
            depth_snapshot=_depth_snapshot(bid_size=100, ask_size=12),
        ),
    ]

    setups = derive_setup_rows(rows)
    setup_types = {row.setup_type for row in setups}

    assert setup_types == {
        "zone_rejection",
        "sweep_absorption",
        "iceberg_hold",
        "cvd_flip_at_zone",
        "microprice_flip_zone",
    }
    sweep_absorption = next(row for row in setups if row.setup_type == "sweep_absorption")
    assert sweep_absorption.direction == "short"
    assert len(sweep_absorption.source_signals) == 2
    assert sweep_absorption.features["sweep_to_absorption_seconds"] == 3.0

    microprice = next(row for row in setups if row.setup_type == "microprice_flip_zone")
    assert microprice.direction == "long"
    assert microprice.features["live_microprice_followup_required"] is True

    first_text = setup_dataset_text(setups)
    second_text = setup_dataset_text(derive_setup_rows(rows))
    assert first_text == second_text

    source = tmp_path / "signals.jsonl"
    source.write_text("placeholder\n", encoding="utf-8")
    result = write_setup_dataset(signal_rows=rows, out_path=tmp_path / "setups.jsonl", source_dataset_path=source)
    manifest = SetupDatasetManifest.model_validate_json(
        result.manifest_path.read_text(encoding="utf-8")
    )
    assert manifest.row_count == len(setups)
    assert manifest.source_row_count == len(rows)
    assert manifest.settings["live_microprice_followup_required"] is True


def test_setup_rules_do_not_fire_without_required_context() -> None:
    rows = [
        _row(
            ts=BASE_TS,
            family="sweep",
            event_type="sweep_detected",
            tier="MEDIUM",
            direction="up",
            confluence=1,
            zone=False,
        ),
        _row(
            ts=BASE_TS + 20_000_000_000,
            family="absorption",
            event_type="absorption_proxy",
            side="sell_absorbed",
            price=30400.0,
            level_id="different-zone",
            confluence=1,
            zone=False,
        ),
        _row(
            ts=BASE_TS + 30_000_000_000,
            family="iceberg",
            event_type="iceberg_detected",
            direction="short",
            confluence=1,
        ),
    ]

    assert derive_setup_rows(rows) == []


def _row(
    *,
    ts: int,
    family: str,
    event_type: str,
    tier: str | None = "HIGH",
    price: float | None = 30350.0,
    level_id: str | None = "zone-a",
    side: str | None = None,
    direction: str | None = None,
    confluence: int = 2,
    zone: bool = True,
    orderflow_snapshot: dict[str, object] | None = None,
    depth_snapshot: dict[str, object] | None = None,
) -> SignalDatasetRow:
    zone_context = (
        ZoneContext(
            id="zone-a",
            kind="vpoc",
            tier="HIGH",
            price=30350.0,
            distance_pts=0.5,
        )
        if zone
        else None
    )
    payload = {"event_type": event_type, "level_id": level_id, "price": price}
    return SignalDatasetRow(
        ts_ns=ts,
        family=family,  # type: ignore[arg-type]
        event_type=event_type,
        tier=tier,  # type: ignore[arg-type]
        price=price,
        level_id=level_id,
        side=side,
        direction=direction,
        zone_context=zone_context,
        regime="HIGH",
        orderflow_snapshot=orderflow_snapshot
        or {"footprint": {"stacked_side": "sell"}, "cvd": {"momentum_flip": False}},
        depth_snapshot=depth_snapshot,
        confluence_stack_size=confluence,
        payload=payload,
        replay=ReplayContext(
            capture_date="2026-05-29",
            session="rth",
            step_ns=ts + 500_000_000,
            source_obs01="D:/captures/MNQ_rth.obs01.jsonl",
            source_mbo="D:/captures/MNQ_rth.mbo.jsonl",
        ),
    )


def _depth_snapshot(*, bid_size: int, ask_size: int) -> dict[str, object]:
    return {
        "family": "depth",
        "ts_ns": BASE_TS,
        "mid": 30350.0,
        "bid_levels": [{"price": 30349.75, "size": bid_size}],
        "ask_levels": [{"price": 30350.25, "size": ask_size}],
        "n_ticks": 10,
        "quality": "live",
    }
