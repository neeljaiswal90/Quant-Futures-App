"""Unit tests for the RA-112e zone-snapshot stream + policy."""

from __future__ import annotations

import dataclasses
import json

import pytest

from realtime_backend.zone_snapshots import (
    AnchorVsValueState,
    EmitReason,
    PolicyConfig,
    ReferenceLine,
    SCHEMA_VERSION,
    SessionAnchors,
    Shelf,
    SnapshotPolicy,
    TacticalAnchor,
    ZoneSnapshot,
    ZoneSnapshotParams,
    ZoneSnapshotStream,
    classify_rolling_anchor_vs_value,
)


def _snapshot(
    *,
    as_of_ts_ns: int = 1_780_000_000_000_000_000,
    session: str = "globex",
    method_versions: dict[str, str] | None = None,
    params_hash: str = "sha256:aaa",
    vah: float = 30560.0,
    val: float = 30424.0,
    anchor: float | None = 30595.5,
    rolling_state: str = "above_value",
    distance: float = 142.0,
    shelves: tuple[Shelf, ...] = (),
    reference_lines: tuple[ReferenceLine, ...] = (
        ReferenceLine(source="vah", price=30560.0, label="VAH 30560"),
        ReferenceLine(source="val", price=30424.0, label="VAL 30424"),
    ),
    cap_bind_flags: dict[str, bool] | None = None,
    bound_source: dict[str, str] | None = None,
    seq: int = 0,
    emit_reason: str = EmitReason.SESSION_OPEN.value,
) -> ZoneSnapshot:
    """Build a snapshot with realistic defaults for tests."""
    return ZoneSnapshot(
        schema_version=SCHEMA_VERSION,
        zone_snapshot_seq=seq,
        as_of_ts_ns=as_of_ts_ns,
        input_cutoff_ts_ns=as_of_ts_ns - 23_400_000,  # ~23ms behind
        emit_reason=emit_reason,
        symbol="MNQ",
        session=session,
        method_versions=method_versions
        or {"tactical": "v3.0.0-pending", "legacy": "v2.0.0"},
        params_hash=params_hash,
        session_anchors=SessionAnchors(
            vah=vah,
            val=val,
            vpoc=30466.0,
            atr_14_5m=32.62,
            atr_14_60m=65.73,
            atr_cap=32.87,
        ),
        tactical_anchor=(
            None
            if anchor is None
            else TacticalAnchor(
                method="vwap_w_60m",
                value=anchor,
                window_start_ts_ns=as_of_ts_ns - 60 * 60 * 1_000_000_000,
                window_end_ts_ns=as_of_ts_ns,
            )
        ),
        rolling_anchor_vs_session_value=rolling_state,
        rolling_anchor_distance_ticks=distance,
        shelves=shelves,
        reference_lines=reference_lines,
        cap_bind_flags=cap_bind_flags or {},
        bound_source=bound_source or {},
    )


# ---------------------------------------------------------------------------
# SnapshotPolicy
# ---------------------------------------------------------------------------


class TestSnapshotPolicy:
    def test_first_snapshot_emits_session_open(self):
        policy = SnapshotPolicy()
        decision = policy.decide(None, _snapshot())
        assert decision.should_emit is True
        assert decision.reason == EmitReason.SESSION_OPEN.value

    def test_identical_state_no_emit(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0)
        # 100ms later, identical state -> no_change wins over throttle.
        cand = _snapshot(as_of_ts_ns=100_000_000)
        decision = policy.decide(prev, cand)
        assert decision.should_emit is False
        assert decision.reason == "no_change"

    def test_anchor_movement_below_threshold_no_emit(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0, anchor=30595.5)
        # 1-tick (0.25pt) move after 2s -> below 2-tick threshold AND no other
        # change -> no_change.
        cand = _snapshot(as_of_ts_ns=2 * 10**9, anchor=30595.75)
        decision = policy.decide(prev, cand)
        assert decision.should_emit is False

    def test_anchor_movement_at_threshold_emits_material(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0, anchor=30595.5)
        # 2-tick (0.5pt) move after 2s -> at threshold -> material_change.
        cand = _snapshot(as_of_ts_ns=2 * 10**9, anchor=30596.0)
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.MATERIAL_CHANGE.value

    def test_throttle_blocks_emit_under_min_interval(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0, rolling_state="above_value")
        # State change but only 0.5s elapsed -> throttled (waits for min interval).
        cand = _snapshot(as_of_ts_ns=500_000_000, rolling_state="inside_value")
        decision = policy.decide(prev, cand)
        assert decision.should_emit is False
        assert decision.reason == "throttled"

    def test_state_change_after_interval_emits(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0, rolling_state="above_value")
        cand = _snapshot(
            as_of_ts_ns=2 * 10**9, rolling_state="inside_value"
        )
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.ANCHOR_VALUE_STATE_CHANGE.value

    def test_session_change_emits(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0, session="globex")
        cand = _snapshot(as_of_ts_ns=2 * 10**9, session="rth")
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.SESSION_CHANGE.value

    def test_method_version_change_emits(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0)
        cand = _snapshot(
            as_of_ts_ns=2 * 10**9,
            method_versions={"tactical": "v3.0.0", "legacy": "v2.0.0"},
        )
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.METHOD_VERSION_CHANGE.value

    def test_params_hash_change_emits(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0, params_hash="sha256:aaa")
        cand = _snapshot(as_of_ts_ns=2 * 10**9, params_hash="sha256:bbb")
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.PARAMS_HASH_CHANGE.value

    def test_cap_bind_change_emits(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0, cap_bind_flags={"SUP_1": False})
        cand = _snapshot(
            as_of_ts_ns=2 * 10**9, cap_bind_flags={"SUP_1": True}
        )
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.CAP_BIND_CHANGE.value

    def test_bound_source_change_emits(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0, bound_source={"SUP_1": "estimator"})
        cand = _snapshot(
            as_of_ts_ns=2 * 10**9, bound_source={"SUP_1": "atr_cap"}
        )
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.BOUND_SOURCE_CHANGE.value

    def test_heartbeat_after_30s_idle(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0)
        cand = _snapshot(as_of_ts_ns=30 * 10**9)
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.HEARTBEAT.value

    def test_heartbeat_just_under_30s_no_emit(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0)
        # 29.5s — below heartbeat AND no other change.
        cand = _snapshot(as_of_ts_ns=29_500_000_000)
        decision = policy.decide(prev, cand)
        assert decision.should_emit is False

    def test_reference_line_movement_above_threshold(self):
        policy = SnapshotPolicy()
        prev = _snapshot(
            as_of_ts_ns=0,
            reference_lines=(
                ReferenceLine(source="vah", price=30560.0, label="VAH 30560"),
            ),
        )
        cand = _snapshot(
            as_of_ts_ns=2 * 10**9,
            reference_lines=(
                ReferenceLine(source="vah", price=30561.0, label="VAH 30561"),
            ),
        )
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.MATERIAL_CHANGE.value

    def test_reference_line_addition_is_material(self):
        policy = SnapshotPolicy()
        prev = _snapshot(
            as_of_ts_ns=0,
            reference_lines=(
                ReferenceLine(source="vah", price=30560.0, label="VAH 30560"),
            ),
        )
        cand = _snapshot(
            as_of_ts_ns=2 * 10**9,
            reference_lines=(
                ReferenceLine(source="vah", price=30560.0, label="VAH 30560"),
                ReferenceLine(
                    source="lvn_globex", price=30592.0, label="LVN 14"
                ),
            ),
        )
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.MATERIAL_CHANGE.value

    def test_anchor_known_to_unknown_is_material(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=0, anchor=30595.5)
        cand = _snapshot(as_of_ts_ns=2 * 10**9, anchor=None)
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True
        assert decision.reason == EmitReason.MATERIAL_CHANGE.value

    def test_clock_rewind_emits_defensively(self):
        policy = SnapshotPolicy()
        prev = _snapshot(as_of_ts_ns=10 * 10**9, anchor=30595.5)
        # Candidate ts is BEFORE prev — emit so the regression is visible.
        cand = _snapshot(as_of_ts_ns=5 * 10**9, anchor=30599.5)
        decision = policy.decide(prev, cand)
        assert decision.should_emit is True

    def test_custom_thresholds_respected(self):
        # Looser thresholds: a 5-tick move shouldn't trip a 10-tick threshold.
        policy = SnapshotPolicy(
            PolicyConfig(boundary_threshold_ticks=10, anchor_threshold_ticks=10)
        )
        prev = _snapshot(as_of_ts_ns=0, anchor=30595.5)
        cand = _snapshot(as_of_ts_ns=2 * 10**9, anchor=30596.75)  # 5-tick move
        decision = policy.decide(prev, cand)
        assert decision.should_emit is False


# ---------------------------------------------------------------------------
# ZoneSnapshotStream (I/O + sequencing)
# ---------------------------------------------------------------------------


class TestZoneSnapshotStream:
    def test_first_emit_writes_session_open_record(self, tmp_path):
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        decision = stream.maybe_emit(_snapshot(session="globex"))
        stream.close()
        assert decision.should_emit is True
        assert decision.reason == EmitReason.SESSION_OPEN.value

        files = list(tmp_path.glob("*.jsonl"))
        assert len(files) == 1
        lines = files[0].read_text(encoding="utf-8").splitlines()
        assert len(lines) == 1
        record = json.loads(lines[0])
        assert record["zone_snapshot_seq"] == 1
        assert record["emit_reason"] == EmitReason.SESSION_OPEN.value
        assert record["session"] == "globex"
        assert record["schema_version"] == SCHEMA_VERSION

    def test_session_rollover_creates_new_file_and_resets_seq(self, tmp_path):
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        stream.maybe_emit(_snapshot(session="globex"))
        stream.maybe_emit(
            _snapshot(
                session="rth",
                as_of_ts_ns=1_780_001_000_000_000_000,
            )
        )
        stream.close()
        files = sorted(tmp_path.glob("*.jsonl"))
        assert len(files) == 2
        rth_lines = files[1].read_text(encoding="utf-8").splitlines()
        first_rth = json.loads(rth_lines[0])
        assert first_rth["zone_snapshot_seq"] == 1
        assert first_rth["session"] == "rth"
        assert first_rth["emit_reason"] == EmitReason.SESSION_OPEN.value

    def test_throttle_skips_writes(self, tmp_path):
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        stream.maybe_emit(_snapshot(as_of_ts_ns=0, anchor=30595.5))
        # Sub-second emit with material anchor change -> throttled.
        decision = stream.maybe_emit(
            _snapshot(as_of_ts_ns=500_000_000, anchor=30597.5)
        )
        stream.close()
        assert decision.should_emit is False
        lines = (
            list(tmp_path.glob("*.jsonl"))[0].read_text(encoding="utf-8").splitlines()
        )
        assert len(lines) == 1  # only session_open

    def test_force_emit_bypasses_throttle(self, tmp_path):
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        stream.maybe_emit(_snapshot(as_of_ts_ns=0))
        decision = stream.force_emit(_snapshot(as_of_ts_ns=100_000_000))
        stream.close()
        assert decision.should_emit is True
        assert decision.reason == EmitReason.TOUCH_FORCED.value
        lines = (
            list(tmp_path.glob("*.jsonl"))[0].read_text(encoding="utf-8").splitlines()
        )
        assert len(lines) == 2
        assert json.loads(lines[1])["emit_reason"] == EmitReason.TOUCH_FORCED.value
        # Touch-forced row must reflect monotonic seq.
        assert json.loads(lines[1])["zone_snapshot_seq"] == 2

    def test_force_emit_with_custom_reason(self, tmp_path):
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        stream.maybe_emit(_snapshot(as_of_ts_ns=0))
        decision = stream.force_emit(
            _snapshot(as_of_ts_ns=100_000_000),
            reason="custom_test_reason",
        )
        stream.close()
        lines = (
            list(tmp_path.glob("*.jsonl"))[0].read_text(encoding="utf-8").splitlines()
        )
        assert json.loads(lines[1])["emit_reason"] == "custom_test_reason"
        assert decision.reason == "custom_test_reason"

    def test_seq_monotonic_within_session(self, tmp_path):
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        stream.maybe_emit(_snapshot(as_of_ts_ns=0, anchor=30595.5))
        # +16-tick moves spaced 2s apart -> material each time.
        stream.maybe_emit(_snapshot(as_of_ts_ns=2 * 10**9, anchor=30599.5))
        stream.maybe_emit(_snapshot(as_of_ts_ns=5 * 10**9, anchor=30603.5))
        stream.close()
        lines = (
            list(tmp_path.glob("*.jsonl"))[0].read_text(encoding="utf-8").splitlines()
        )
        seqs = [json.loads(line)["zone_snapshot_seq"] for line in lines]
        assert seqs == [1, 2, 3]

    def test_heartbeat_emit_after_30s(self, tmp_path):
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        stream.maybe_emit(_snapshot(as_of_ts_ns=0))
        decision = stream.maybe_emit(_snapshot(as_of_ts_ns=30 * 10**9))
        stream.close()
        assert decision.should_emit is True
        assert decision.reason == EmitReason.HEARTBEAT.value
        lines = (
            list(tmp_path.glob("*.jsonl"))[0].read_text(encoding="utf-8").splitlines()
        )
        assert len(lines) == 2

    def test_no_change_writes_nothing(self, tmp_path):
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        stream.maybe_emit(_snapshot(as_of_ts_ns=0))
        # 5s later with no change at all (under heartbeat) -> nothing.
        decision = stream.maybe_emit(_snapshot(as_of_ts_ns=5 * 10**9))
        stream.close()
        assert decision.should_emit is False
        assert decision.reason == "no_change"
        lines = (
            list(tmp_path.glob("*.jsonl"))[0].read_text(encoding="utf-8").splitlines()
        )
        assert len(lines) == 1

    def test_file_path_format(self, tmp_path):
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        # 2026-05-31 23:30:00 UTC
        stream.maybe_emit(
            _snapshot(session="globex", as_of_ts_ns=1_780_343_400_000_000_000)
        )
        stream.close()
        files = list(tmp_path.glob("*.jsonl"))
        assert len(files) == 1
        # UTC date should match the timestamp.
        assert files[0].name == "2026-06-01_MNQ_globex.jsonl"

    def test_jsonl_records_are_compact(self, tmp_path):
        """Records must be one line each with no embedded newlines."""
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        stream.maybe_emit(_snapshot(as_of_ts_ns=0))
        stream.maybe_emit(_snapshot(as_of_ts_ns=30 * 10**9))  # heartbeat
        stream.close()
        text = list(tmp_path.glob("*.jsonl"))[0].read_text(encoding="utf-8")
        # Two complete records, each terminated by \n.
        assert text.count("\n") == 2
        # No blank lines between records.
        assert "\n\n" not in text

    def test_re_open_appends_not_truncates(self, tmp_path):
        """A new ZoneSnapshotStream over the same date must not clobber history."""
        s1 = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        s1.maybe_emit(_snapshot(as_of_ts_ns=0))
        s1.close()
        s2 = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        s2.maybe_emit(_snapshot(as_of_ts_ns=30 * 10**9))
        s2.close()
        files = list(tmp_path.glob("*.jsonl"))
        assert len(files) == 1
        lines = files[0].read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2

    def test_close_is_idempotent(self, tmp_path):
        stream = ZoneSnapshotStream(tmp_path, symbol="MNQ")
        stream.maybe_emit(_snapshot(as_of_ts_ns=0))
        stream.close()
        stream.close()  # should not raise.


# ---------------------------------------------------------------------------
# classify_rolling_anchor_vs_value
# ---------------------------------------------------------------------------


class TestClassifyRollingAnchor:
    def test_above_value(self):
        state, dist = classify_rolling_anchor_vs_value(
            30595.5, vah=30560.0, val=30424.0
        )
        assert state == AnchorVsValueState.ABOVE.value
        # (30595.5 - 30560.0) / 0.25 = 142
        assert dist == pytest.approx(142.0)

    def test_inside_value_at_vah(self):
        state, dist = classify_rolling_anchor_vs_value(
            30560.0, vah=30560.0, val=30424.0
        )
        # VAH boundary is inclusive on the inside-value side.
        assert state == AnchorVsValueState.INSIDE.value
        assert dist == 0.0

    def test_inside_value_at_val(self):
        state, dist = classify_rolling_anchor_vs_value(
            30424.0, vah=30560.0, val=30424.0
        )
        assert state == AnchorVsValueState.INSIDE.value
        assert dist == 0.0

    def test_inside_value_middle(self):
        state, dist = classify_rolling_anchor_vs_value(
            30490.0, vah=30560.0, val=30424.0
        )
        assert state == AnchorVsValueState.INSIDE.value
        assert dist == 0.0

    def test_below_value(self):
        state, dist = classify_rolling_anchor_vs_value(
            30400.0, vah=30560.0, val=30424.0
        )
        assert state == AnchorVsValueState.BELOW.value
        # (30424 - 30400) / 0.25 = 96
        assert dist == pytest.approx(96.0)

    def test_unknown_when_anchor_missing(self):
        state, dist = classify_rolling_anchor_vs_value(
            None, vah=30560.0, val=30424.0
        )
        assert state == AnchorVsValueState.UNKNOWN.value
        assert dist == 0.0

    def test_unknown_when_value_missing(self):
        state, dist = classify_rolling_anchor_vs_value(
            30500.0, vah=None, val=30424.0
        )
        assert state == AnchorVsValueState.UNKNOWN.value


# ---------------------------------------------------------------------------
# ZoneSnapshotParams hashing
# ---------------------------------------------------------------------------


class TestZoneSnapshotParamsHash:
    def _params(self, **overrides) -> ZoneSnapshotParams:
        base = {
            "vwap_window_minutes": 60,
            "cap_atr_fraction": 0.5,
            "va_pct": 0.70,
            "atr_period": 14,
            "atr_bar_size_min_bin": 5,
            "atr_bar_size_min_cap": 60,
            "bin_size_ticks": 20,
            "bin_size_mode": "adaptive",
        }
        base.update(overrides)
        return ZoneSnapshotParams(**base)

    def test_hash_deterministic(self):
        assert self._params().hash() == self._params().hash()

    def test_hash_format(self):
        h = self._params().hash()
        assert h.startswith("sha256:")
        assert len(h) == len("sha256:") + 64

    def test_hash_changes_on_cap_fraction(self):
        a = self._params()
        b = self._params(cap_atr_fraction=0.75)
        assert a.hash() != b.hash()

    def test_hash_changes_on_vwap_window(self):
        a = self._params()
        b = self._params(vwap_window_minutes=30)
        assert a.hash() != b.hash()

    def test_hash_changes_on_bin_mode(self):
        a = self._params()
        b = self._params(bin_size_mode="fixed")
        assert a.hash() != b.hash()
