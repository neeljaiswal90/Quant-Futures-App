"""Unit tests for the RA-112e zone-touch / outcome event logger."""

from __future__ import annotations

import json

import pytest

from realtime_backend.zone_touches import (
    APPROACH_SPEED_HORIZONS_SEC,
    DEFAULT_COOLDOWN_SEC,
    DEFAULT_MIN_DISTANCE_TICKS,
    DEFAULT_TICK_SIZE,
    MonitoredLevel,
    OUTCOME_HORIZONS_SEC,
    OutcomeLabel,
    OutcomeRow,
    OutcomeTracker,
    PreTouchFeatures,
    RollingFeatureAccumulator,
    SCHEMA_VERSION,
    Touch,
    TouchDetector,
    TouchEvent,
    TouchSide,
    ZoneTouchStream,
    monitored_levels_from_snapshot_dict,
)


# ---------------------------------------------------------------------------
# TouchDetector
# ---------------------------------------------------------------------------


REF_VAH = MonitoredLevel(
    zone_id="ref-vah-30560.00",
    zone_family="reference_line",
    low=30560.0,
    high=30560.0,
    label="VAH 30560",
)
REF_VAL = MonitoredLevel(
    zone_id="ref-val-30424.00",
    zone_family="reference_line",
    low=30424.0,
    high=30424.0,
    label="VAL 30424",
)


def _detector(**overrides) -> TouchDetector:
    return TouchDetector(
        min_distance_ticks=overrides.get(
            "min_distance_ticks", DEFAULT_MIN_DISTANCE_TICKS
        ),
        cooldown_sec=overrides.get("cooldown_sec", DEFAULT_COOLDOWN_SEC),
        tick_size=overrides.get("tick_size", DEFAULT_TICK_SIZE),
    )


class TestTouchDetector:
    def test_first_observation_does_not_fire(self):
        d = _detector()
        d.update_levels([REF_VAH])
        assert d.on_price_tick(price=30555.0, ts_ns=0) == []

    def test_no_touch_when_still_outside(self):
        d = _detector()
        d.update_levels([REF_VAH])
        d.on_price_tick(price=30555.0, ts_ns=0)
        # Still below the band, 1-tick movement.
        assert d.on_price_tick(price=30555.25, ts_ns=10_000_000) == []

    def test_crossing_from_below_fires_touch(self):
        d = _detector()
        d.update_levels([REF_VAH])
        # 5 ticks below the band (4-tick margin + 1).
        d.on_price_tick(price=30558.75, ts_ns=0)
        touches = d.on_price_tick(price=30560.0, ts_ns=1_000_000_000)
        assert len(touches) == 1
        t = touches[0]
        assert t.level == REF_VAH
        assert t.touch_price == 30560.0
        assert t.approach_side == TouchSide.FROM_BELOW.value
        assert t.expected_bounce_direction == "down"

    def test_crossing_from_above_fires_touch(self):
        d = _detector()
        d.update_levels([REF_VAH])
        d.on_price_tick(price=30564.0, ts_ns=0)  # 4t above band+margin
        touches = d.on_price_tick(price=30560.0, ts_ns=1_000_000_000)
        assert len(touches) == 1
        assert touches[0].approach_side == TouchSide.FROM_ABOVE.value
        assert touches[0].expected_bounce_direction == "up"

    def test_cooldown_blocks_double_fire(self):
        d = _detector(cooldown_sec=30)
        d.update_levels([REF_VAH])
        d.on_price_tick(price=30558.75, ts_ns=0)
        # First touch.
        assert len(d.on_price_tick(price=30560.0, ts_ns=1_000_000_000)) == 1
        # Move away, come back within cooldown.
        d.on_price_tick(price=30558.75, ts_ns=5_000_000_000)
        touches = d.on_price_tick(price=30560.0, ts_ns=10_000_000_000)
        assert touches == []

    def test_cooldown_releases_after_window(self):
        d = _detector(cooldown_sec=5)
        d.update_levels([REF_VAH])
        d.on_price_tick(price=30558.75, ts_ns=0)
        d.on_price_tick(price=30560.0, ts_ns=1_000_000_000)
        d.on_price_tick(price=30558.75, ts_ns=2_000_000_000)
        # 7s later (>5s cooldown) -> allowed again.
        touches = d.on_price_tick(price=30560.0, ts_ns=8_000_000_000)
        assert len(touches) == 1

    def test_band_level_crossings(self):
        band = MonitoredLevel(
            zone_id="sigma_v3_vwap_anchor:SUP_1",
            zone_family="sigma_v3_vwap_anchor",
            low=30560.0,
            high=30576.43,
            label="SUP_1",
        )
        d = _detector(min_distance_ticks=2)
        d.update_levels([band])
        d.on_price_tick(price=30555.0, ts_ns=0)  # well below
        # Enter the band.
        touches = d.on_price_tick(price=30568.0, ts_ns=1_000_000_000)
        assert len(touches) == 1
        assert touches[0].approach_side == TouchSide.FROM_BELOW.value

    def test_update_levels_preserves_cooldown_for_survivors(self):
        d = _detector(cooldown_sec=30)
        d.update_levels([REF_VAH])
        d.on_price_tick(price=30558.75, ts_ns=0)
        d.on_price_tick(price=30560.0, ts_ns=1_000_000_000)
        # New snapshot — same level survives.
        d.update_levels([REF_VAH, REF_VAL])
        d.on_price_tick(price=30558.75, ts_ns=2_000_000_000)
        # Should still be in cooldown.
        touches = d.on_price_tick(price=30560.0, ts_ns=3_000_000_000)
        assert touches == []

    def test_update_levels_drops_state_for_removed(self):
        d = _detector()
        d.update_levels([REF_VAH])
        d.on_price_tick(price=30558.75, ts_ns=0)
        # Drop the level.
        d.update_levels([REF_VAL])
        d.update_levels([REF_VAH])  # re-add as if new snapshot brought it back
        # First observation after re-add must not fire.
        touches = d.on_price_tick(price=30560.0, ts_ns=1_000_000_000)
        assert touches == []

    def test_multiple_levels_one_tick(self):
        d = _detector(min_distance_ticks=2)
        narrow = MonitoredLevel(
            zone_id="ref-vah-30560.00",
            zone_family="reference_line",
            low=30560.0,
            high=30560.0,
            label="VAH",
        )
        adjacent = MonitoredLevel(
            zone_id="ref-vwap-30562.00",
            zone_family="reference_line",
            low=30562.0,
            high=30562.0,
            label="VWAP",
        )
        d.update_levels([narrow, adjacent])
        d.on_price_tick(price=30557.0, ts_ns=0)
        # Big jump touches both bands (4t margin around each).
        touches = d.on_price_tick(price=30562.0, ts_ns=1_000_000_000)
        zone_ids = {t.level.zone_id for t in touches}
        assert "ref-vah-30560.00" in zone_ids
        assert "ref-vwap-30562.00" in zone_ids


# ---------------------------------------------------------------------------
# RollingFeatureAccumulator
# ---------------------------------------------------------------------------


class TestRollingFeatureAccumulator:
    def test_trade_imbalance_positive_buy_dominant(self):
        acc = RollingFeatureAccumulator()
        acc.on_trade(ts_ns=0, price=30550.0, volume=10, aggressor_side="buy")
        acc.on_trade(ts_ns=1_000_000_000, price=30551.0, volume=5, aggressor_side="sell")
        f = acc.features_at(2_000_000_000)
        assert f.trade_imbalance_5s == pytest.approx((10 - 5) / 15)

    def test_trade_imbalance_balanced(self):
        acc = RollingFeatureAccumulator()
        acc.on_trade(ts_ns=0, price=30550.0, volume=5, aggressor_side="buy")
        acc.on_trade(ts_ns=1_000_000_000, price=30551.0, volume=5, aggressor_side="sell")
        f = acc.features_at(2_000_000_000)
        assert f.trade_imbalance_5s == 0.0

    def test_trade_imbalance_no_samples_returns_none(self):
        acc = RollingFeatureAccumulator()
        # 10s passes but no trades.
        f = acc.features_at(10_000_000_000)
        assert f.trade_imbalance_5s is None
        assert f.trade_imbalance_30s is None

    def test_trade_imbalance_window_excludes_old_samples(self):
        acc = RollingFeatureAccumulator()
        # 10s ago, buy 100 (outside 5s window).
        acc.on_trade(ts_ns=0, price=30550.0, volume=100, aggressor_side="buy")
        # 1s ago, sell 5 (inside 5s window).
        acc.on_trade(ts_ns=9_000_000_000, price=30549.0, volume=5, aggressor_side="sell")
        f = acc.features_at(10_000_000_000)
        # 5s window should only see the sell -> imbalance = -1.0.
        assert f.trade_imbalance_5s == -1.0
        # 30s window sees both -> mostly buy.
        assert f.trade_imbalance_30s == pytest.approx((100 - 5) / 105)

    def test_approach_speed_uptrend_positive(self):
        acc = RollingFeatureAccumulator()
        # 5 ticks (1.25 pt) over 5 seconds = +0.25 ticks/sec... wait
        # 1.25 pt in price = 5 ticks; 5 ticks / 5s = 1 tick/sec.
        acc.on_trade(ts_ns=0, price=30550.0, volume=1, aggressor_side="buy")
        acc.on_trade(ts_ns=5_000_000_000, price=30551.25, volume=1, aggressor_side="buy")
        f = acc.features_at(5_000_000_000)
        # (30551.25 - 30550.0) / 0.25 = 5 ticks, over 5s = 1.0 ticks/sec.
        assert f.approach_speed_5s == pytest.approx(1.0)

    def test_approach_speed_single_sample_returns_none(self):
        acc = RollingFeatureAccumulator()
        acc.on_trade(ts_ns=0, price=30550.0, volume=1, aggressor_side="buy")
        f = acc.features_at(5_000_000_000)
        assert f.approach_speed_5s is None

    def test_depth_imbalance_instant(self):
        acc = RollingFeatureAccumulator()
        acc.on_depth(
            ts_ns=1_000_000_000,
            bid_price=30559.75,
            ask_price=30560.0,
            bid_size=100,
            ask_size=20,
        )
        f = acc.features_at(2_000_000_000)
        # (100 - 20) / (100 + 20) = 80/120 ≈ 0.667
        assert f.depth_imbalance_touch == pytest.approx(80 / 120)

    def test_depth_imbalance_zero_size_returns_none(self):
        acc = RollingFeatureAccumulator()
        acc.on_depth(
            ts_ns=1_000_000_000,
            bid_price=30559.75,
            ask_price=30560.0,
            bid_size=0,
            ask_size=0,
        )
        f = acc.features_at(2_000_000_000)
        assert f.depth_imbalance_touch is None

    def test_microprice_offset_lean_to_ask(self):
        # bid 30559.75/100, ask 30560.0/20
        # mid = 30559.875
        # microprice = (30559.75*20 + 30560*100) / 120 = 3666995/120 = 30558.... wait
        # bid_price * ask_size + ask_price * bid_size = 30559.75*20 + 30560.0*100
        # = 611195 + 3056000 = 3667195
        # / 120 = 30559.958333...
        # offset = (30559.958333... - 30559.875) / 0.25 = 0.083333... / 0.25 = 0.333...
        acc = RollingFeatureAccumulator()
        acc.on_depth(
            ts_ns=1_000_000_000,
            bid_price=30559.75,
            ask_price=30560.0,
            bid_size=100,
            ask_size=20,
        )
        f = acc.features_at(2_000_000_000)
        assert f.microprice_offset_touch == pytest.approx(0.333333, abs=1e-3)

    def test_spread_in_ticks(self):
        acc = RollingFeatureAccumulator()
        acc.on_depth(
            ts_ns=1_000_000_000,
            bid_price=30559.75,
            ask_price=30560.25,
            bid_size=10,
            ask_size=10,
        )
        f = acc.features_at(2_000_000_000)
        # 30560.25 - 30559.75 = 0.5 pt = 2 ticks.
        assert f.spread_touch == 2.0

    def test_features_use_only_data_at_or_before_ts(self):
        """Regression: post-touch samples must not leak into pre-touch features."""
        acc = RollingFeatureAccumulator()
        # Trades both BEFORE and AFTER the query ts.
        acc.on_trade(ts_ns=1_000_000_000, price=30550.0, volume=10, aggressor_side="buy")
        acc.on_trade(ts_ns=3_000_000_000, price=30551.0, volume=5, aggressor_side="buy")
        acc.on_trade(ts_ns=8_000_000_000, price=30552.0, volume=100, aggressor_side="sell")
        # Query at ts=4s. The 8s sell must NOT influence the imbalance.
        f = acc.features_at(4_000_000_000)
        assert f.trade_imbalance_5s == pytest.approx(1.0)  # only buys in window

    def test_old_samples_pruned_at_max_window(self):
        acc = RollingFeatureAccumulator(max_window_sec=10)
        acc.on_trade(ts_ns=0, price=30550.0, volume=1, aggressor_side="buy")
        # Push a sample 100s later; the old one should be dropped.
        acc.on_trade(ts_ns=100_000_000_000, price=30551.0, volume=1, aggressor_side="buy")
        # Querying at 100s with a 60s window should not see the t=0 sample.
        f = acc.features_at(100_000_000_000)
        # Only one sample in the window -> approach_speed needs >=2 -> None.
        assert f.approach_speed_15s is None

    def test_ofi_fields_remain_none_stub(self):
        """RA-112e step 2 ships OFI as None; full MBP1 quote feed comes later."""
        acc = RollingFeatureAccumulator()
        acc.on_trade(ts_ns=0, price=30550.0, volume=10, aggressor_side="buy")
        f = acc.features_at(1_000_000_000)
        assert f.ofi_5s is None
        assert f.ofi_60s is None


# ---------------------------------------------------------------------------
# OutcomeTracker
# ---------------------------------------------------------------------------


def _touch_event(
    *,
    event_id: str = "MNQ-20260601-globex-000001",
    touch_ts_ns: int = 0,
    touch_price: float = 30560.0,
    expected_bounce_direction: str = "up",
    approach_side: str = TouchSide.FROM_ABOVE.value,
) -> TouchEvent:
    return TouchEvent(
        schema_version=SCHEMA_VERSION,
        event_id=event_id,
        touch_event_seq=1,
        touch_ts_ns=touch_ts_ns,
        symbol="MNQ",
        session="globex",
        zone_snapshot_seq=42,
        zone_id="ref-vah-30560.00",
        zone_family="reference_line",
        zone_low=30560.0,
        zone_high=30560.0,
        touch_price=touch_price,
        approach_side=approach_side,
        expected_bounce_direction=expected_bounce_direction,
        pre_touch_features=PreTouchFeatures(),
        method_versions={"tactical": "v3.0.0-pending", "legacy": "v2.0.0"},
    )


class TestOutcomeTracker:
    def test_registers_one_pending_per_horizon(self):
        rows: list[OutcomeRow] = []
        t = OutcomeTracker(write_row=rows.append)
        t.register_touch(_touch_event())
        assert t.pending_count() == len(OUTCOME_HORIZONS_SEC)

    def test_ticks_within_horizon_dont_finalize(self):
        rows: list[OutcomeRow] = []
        t = OutcomeTracker(write_row=rows.append)
        t.register_touch(_touch_event(touch_ts_ns=0, expected_bounce_direction="up"))
        # 30s later, still well before 1-min horizon.
        t.on_price_tick(price=30562.0, ts_ns=30_000_000_000)
        assert rows == []

    def test_rejection_label_when_mfe_dominates(self):
        rows: list[OutcomeRow] = []
        t = OutcomeTracker(write_row=rows.append)
        # Touch at 30560.0, expecting bounce up.
        t.register_touch(_touch_event(touch_ts_ns=0, expected_bounce_direction="up"))
        # Price rallies +5 ticks over the 1-minute horizon, no adverse move.
        t.on_price_tick(price=30561.25, ts_ns=10_000_000_000)
        # Force flush past the 60s horizon.
        t.flush_overdue(120_000_000_000)
        one_min = next(r for r in rows if r.horizon_sec == 60)
        assert one_min.mfe_ticks == pytest.approx(5.0)
        assert one_min.mae_ticks == 0.0
        assert one_min.outcome_label == OutcomeLabel.REJECTION.value

    def test_break_label_when_mae_dominates(self):
        rows: list[OutcomeRow] = []
        t = OutcomeTracker(write_row=rows.append)
        # Approach FROM_ABOVE to a resistance -> bounce up. A move DOWN is adverse.
        t.register_touch(_touch_event(touch_ts_ns=0, expected_bounce_direction="up"))
        t.on_price_tick(price=30558.0, ts_ns=30_000_000_000)  # -8 ticks (adverse)
        t.flush_overdue(120_000_000_000)
        one_min = next(r for r in rows if r.horizon_sec == 60)
        assert one_min.mae_ticks == pytest.approx(8.0)
        assert one_min.outcome_label == OutcomeLabel.BREAK.value

    def test_ambiguous_label_when_both_move(self):
        rows: list[OutcomeRow] = []
        t = OutcomeTracker(write_row=rows.append)
        t.register_touch(_touch_event(touch_ts_ns=0, expected_bounce_direction="up"))
        t.on_price_tick(price=30562.0, ts_ns=5_000_000_000)   # +8 ticks
        t.on_price_tick(price=30559.0, ts_ns=30_000_000_000)  # then -4 ticks
        t.flush_overdue(120_000_000_000)
        one_min = next(r for r in rows if r.horizon_sec == 60)
        assert one_min.mfe_ticks == pytest.approx(8.0)
        assert one_min.mae_ticks == pytest.approx(4.0)
        # mfe < 2*mae and mae < 2*mfe -> ambiguous.
        assert one_min.outcome_label == OutcomeLabel.AMBIGUOUS.value

    def test_no_resolution_when_price_idle(self):
        rows: list[OutcomeRow] = []
        t = OutcomeTracker(write_row=rows.append)
        t.register_touch(_touch_event(touch_ts_ns=0))
        t.flush_overdue(700_000_000_000)  # flush all four horizons
        for r in rows:
            assert r.outcome_label == OutcomeLabel.NO_RESOLUTION.value

    def test_horizons_emit_independently(self):
        rows: list[OutcomeRow] = []
        t = OutcomeTracker(write_row=rows.append)
        t.register_touch(_touch_event(touch_ts_ns=0, expected_bounce_direction="up"))
        t.on_price_tick(price=30562.0, ts_ns=5_000_000_000)
        # After 70s, only 60s horizon emits.
        t.flush_overdue(70_000_000_000)
        assert len(rows) == 1
        assert rows[0].horizon_sec == 60
        # After 200s, the 180s horizon emits.
        t.flush_overdue(200_000_000_000)
        horizons = {r.horizon_sec for r in rows}
        assert horizons == {60, 180}

    def test_max_excursion_timestamps_captured(self):
        rows: list[OutcomeRow] = []
        t = OutcomeTracker(write_row=rows.append)
        t.register_touch(_touch_event(touch_ts_ns=0, expected_bounce_direction="up"))
        t.on_price_tick(price=30561.0, ts_ns=10_000_000_000)
        t.on_price_tick(price=30563.0, ts_ns=30_000_000_000)  # new max
        t.on_price_tick(price=30562.0, ts_ns=50_000_000_000)
        t.flush_overdue(120_000_000_000)
        one_min = next(r for r in rows if r.horizon_sec == 60)
        assert one_min.max_favorable_ts_ns == 30_000_000_000

    def test_pre_touch_ticks_ignored(self):
        """Ticks AT or BEFORE touch_ts must not contribute to excursions."""
        rows: list[OutcomeRow] = []
        t = OutcomeTracker(write_row=rows.append)
        t.register_touch(_touch_event(touch_ts_ns=10_000_000_000, expected_bounce_direction="up"))
        # Tick BEFORE touch.
        t.on_price_tick(price=30570.0, ts_ns=5_000_000_000)
        # Tick AT touch_ts.
        t.on_price_tick(price=30560.0, ts_ns=10_000_000_000)
        t.flush_overdue(80_000_000_000)
        one_min = next(r for r in rows if r.horizon_sec == 60)
        assert one_min.mfe_ticks == 0.0
        assert one_min.mae_ticks == 0.0


# ---------------------------------------------------------------------------
# ZoneTouchStream
# ---------------------------------------------------------------------------


class TestZoneTouchStream:
    def test_writes_touch_to_touches_subdir(self, tmp_path):
        stream = ZoneTouchStream(tmp_path, symbol="MNQ")
        event_id = stream.next_event_id(session="globex", ts_ns=1_780_000_000_000_000_000)
        evt = _touch_event(event_id=event_id, touch_ts_ns=1_780_000_000_000_000_000)
        stream.write_touch(evt)
        stream.close()
        touches_files = list((tmp_path / "zone_touches").glob("*.jsonl"))
        assert len(touches_files) == 1
        line = touches_files[0].read_text(encoding="utf-8").strip()
        rec = json.loads(line)
        assert rec["event_id"] == event_id
        assert rec["zone_id"] == "ref-vah-30560.00"
        assert rec["touch_price"] == 30560.0

    def test_event_id_format(self, tmp_path):
        stream = ZoneTouchStream(tmp_path, symbol="MNQ")
        # 2026-06-01 14:00:00 UTC.
        evt_id = stream.next_event_id(session="globex", ts_ns=1_780_322_400_000_000_000)
        assert evt_id == "MNQ-20260601-globex-000001"
        evt_id_2 = stream.next_event_id(session="globex", ts_ns=1_780_322_400_000_000_000)
        assert evt_id_2 == "MNQ-20260601-globex-000002"

    def test_session_rollover_resets_seq_and_paths(self, tmp_path):
        stream = ZoneTouchStream(tmp_path, symbol="MNQ")
        stream.next_event_id(session="globex", ts_ns=1_780_322_400_000_000_000)
        stream.next_event_id(session="globex", ts_ns=1_780_322_400_000_000_000)
        evt_id_rth = stream.next_event_id(session="rth", ts_ns=1_780_322_400_000_000_000)
        assert evt_id_rth == "MNQ-20260601-rth-000001"
        stream.close()

    def test_outcome_row_appended_to_outcomes_subdir(self, tmp_path):
        stream = ZoneTouchStream(tmp_path, symbol="MNQ")
        event_id = stream.next_event_id(session="globex", ts_ns=1_780_000_000_000_000_000)
        stream.write_touch(_touch_event(event_id=event_id))
        stream.write_outcome(
            OutcomeRow(
                schema_version=SCHEMA_VERSION,
                event_id=event_id,
                horizon_sec=60,
                horizon_end_ts_ns=60_000_000_000,
                mfe_ticks=5.0,
                mae_ticks=1.0,
                max_favorable_ts_ns=30_000_000_000,
                max_adverse_ts_ns=10_000_000_000,
                outcome_label=OutcomeLabel.REJECTION.value,
            )
        )
        stream.close()
        outcome_files = list((tmp_path / "zone_outcomes").glob("*.jsonl"))
        assert len(outcome_files) == 1
        rec = json.loads(outcome_files[0].read_text(encoding="utf-8").strip())
        assert rec["event_id"] == event_id
        assert rec["outcome_label"] == OutcomeLabel.REJECTION.value

    def test_close_is_idempotent(self, tmp_path):
        stream = ZoneTouchStream(tmp_path, symbol="MNQ")
        stream.next_event_id(session="globex", ts_ns=1_780_000_000_000_000_000)
        stream.close()
        stream.close()  # must not raise


# ---------------------------------------------------------------------------
# monitored_levels_from_snapshot_dict
# ---------------------------------------------------------------------------


class TestMonitoredLevelsAdapter:
    def test_reference_lines_become_point_levels(self):
        snap = {
            "reference_lines": [
                {"source": "vah", "price": 30560.0, "label": "VAH 30560"},
                {"source": "val", "price": 30424.0, "label": "VAL 30424"},
            ],
            "shelves": [],
        }
        levels = monitored_levels_from_snapshot_dict(snap)
        assert len(levels) == 2
        vah = levels[0]
        assert vah.zone_id == "ref-vah-30560.00"
        assert vah.low == vah.high == 30560.0
        assert vah.zone_family == "reference_line"

    def test_shelves_become_band_levels(self):
        snap = {
            "reference_lines": [],
            "shelves": [
                {
                    "family": "sigma_v3_vwap_anchor",
                    "name": "SUP_1",
                    "low": 30560.0,
                    "high": 30576.43,
                    "tier": 1,
                    "bound_source": "atr_cap",
                    "cap_bound": True,
                    "overlaps_vah": False,
                    "overlaps_val": False,
                    "nearest_structural_level": "VAH",
                    "distance_to_structural_level_ticks": 0.0,
                }
            ],
        }
        levels = monitored_levels_from_snapshot_dict(snap)
        assert len(levels) == 1
        sup = levels[0]
        assert sup.zone_id == "sigma_v3_vwap_anchor:SUP_1"
        assert sup.low == 30560.0
        assert sup.high == 30576.43
        assert sup.zone_family == "sigma_v3_vwap_anchor"

    def test_malformed_records_skipped(self):
        snap = {
            "reference_lines": [
                {"source": "vah", "price": None},  # missing price
                {"price": 30560.0},                # missing source
                {"source": "val", "price": "abc"}, # bad type
                {"source": "vpoc", "price": 30466.0, "label": "VPOC"},
            ],
            "shelves": [],
        }
        levels = monitored_levels_from_snapshot_dict(snap)
        assert len(levels) == 1
        assert levels[0].zone_id == "ref-vpoc-30466.00"


# ---------------------------------------------------------------------------
# Constants sanity
# ---------------------------------------------------------------------------


def test_horizons_match_q4_spec():
    assert OFI_HORIZONS_SEC == (5, 15, 30, 60)
    assert TRADE_IMBALANCE_HORIZONS_SEC == (5, 15, 30, 60)
    assert APPROACH_SPEED_HORIZONS_SEC == (1, 5, 15)
    assert OUTCOME_HORIZONS_SEC == (60, 180, 300, 600)


def test_default_thresholds_match_locked_defaults():
    assert DEFAULT_MIN_DISTANCE_TICKS == 4.0
    assert DEFAULT_COOLDOWN_SEC == 30.0


# Make `from realtime_backend.zone_touches import OFI_HORIZONS_SEC, ...` work
# from inside the test module without an explicit import line for each constant.
from realtime_backend.zone_touches import (  # noqa: E402
    OFI_HORIZONS_SEC,
    TRADE_IMBALANCE_HORIZONS_SEC,
)
