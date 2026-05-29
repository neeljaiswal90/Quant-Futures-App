"""Tests for ``rithmic_analytics.viewer.tv_publisher`` (RA-034)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rithmic_analytics.core.schema import ReferenceLine, Zone
from rithmic_analytics.viewer._tv_backend import MockBackend, ShapeRecord
from rithmic_analytics.viewer.tv_publisher import (
    STYLE_BY_CONVICTION,
    STYLE_BY_SOURCE,
    AddOperation,
    NoChangeOperation,
    RemoveOperation,
    load_state,
    plan_sync,
    reference_line_source_id,
    write_latest_pointer,
    write_plan,
    write_state,
    zone_source_id,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_envelope(
    *,
    reference_lines: list[dict[str, object]] | None = None,
    zones: list[dict[str, object]] | None = None,
    symbol: str = "MNQ",
    timeframe: str = "rth",
    atr_14: float | None = 5.0,
) -> dict[str, object]:
    """Build a valid zone-envelope dict for tests."""
    return {
        "schema_version": 1,
        "symbol": symbol,
        "timeframe": timeframe,
        "bars_used": 100,
        "computed_at": "2026-05-20T20:00:00+00:00",
        "data_source": "rithmic",
        "vpoc": 27381.25,
        "vah": 27390.00,
        "val": 27370.00,
        "atr_14": atr_14,
        "bin_size_ticks": 20,
        "zones": zones or [],
        "reference_lines": reference_lines or [],
    }


def _ref(
    *, price: float = 27381.25, text: str = "VPOC", source: str = "vpoc",
) -> dict[str, object]:
    return {"price": price, "text": text, "source": source}


def _zone_dict(
    *, zid: str = "hvn-27380", top: float = 27385.0, bot: float = 27375.0,
    conviction: str = "MED",
) -> dict[str, object]:
    return {
        "id": zid, "top": top, "bot": bot,
        "type": "support", "conviction": conviction,
        "text": f"HVN {zid}", "sources": ["hvn_rth"],
        "volume_pct": 0.1, "multi_tf_count": None, "multi_session_count": None,
    }


# ---------------------------------------------------------------------------
# Source-ID derivation
# ---------------------------------------------------------------------------


def test_reference_line_source_id_includes_price_to_2_decimals() -> None:
    ref = ReferenceLine(price=27381.25, text="VPOC", source="vpoc")
    assert reference_line_source_id(ref) == "ref:vpoc:27381.25"


def test_reference_line_source_id_stable_under_fp_noise() -> None:
    """27381.25 vs 27381.250000000001 → same source ID."""
    r1 = ReferenceLine(price=27381.25, text="x", source="vpoc")
    r2 = ReferenceLine(price=27381.250000000001, text="x", source="vpoc")
    assert reference_line_source_id(r1) == reference_line_source_id(r2)


def test_reference_line_source_id_distinct_per_price() -> None:
    """Two LVNs (same source string, different prices) get distinct IDs."""
    a = ReferenceLine(price=27365.0, text="LVN", source="lvn_rth")
    b = ReferenceLine(price=27355.0, text="LVN", source="lvn_rth")
    assert reference_line_source_id(a) != reference_line_source_id(b)


def test_zone_source_id_uses_zone_id() -> None:
    z = Zone(
        id="hvn-27380", top=27385.0, bot=27375.0,
        type="support", conviction="MED", text="HVN",
        sources=["hvn_rth"],
    )
    assert zone_source_id(z) == "zone:hvn-27380"


# ---------------------------------------------------------------------------
# Plan generation — empty / bootstrap
# ---------------------------------------------------------------------------


def test_plan_empty_envelope_empty_state_is_noop(tmp_path: Path) -> None:
    envelope = _make_envelope()
    plan = plan_sync(
        envelope=envelope, state={},
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )
    assert plan.operations == []
    assert plan.n_add == 0
    assert plan.n_remove == 0
    assert plan.n_noop == 0


def test_plan_bootstrap_adds_everything(tmp_path: Path) -> None:
    """Empty state + envelope with content → Add ops for every source."""
    envelope = _make_envelope(
        reference_lines=[
            _ref(price=27381.25, source="vpoc"),
            _ref(price=27390.00, source="vah"),
            _ref(price=27370.00, source="val"),
        ],
        zones=[_zone_dict(zid="hvn-27380")],
    )
    plan = plan_sync(
        envelope=envelope, state={},
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )

    assert plan.n_add == 4
    assert plan.n_remove == 0
    assert plan.n_noop == 0
    source_ids = {op.source_id for op in plan.operations}
    assert "ref:vpoc:27381.25" in source_ids
    assert "ref:vah:27390.00" in source_ids
    assert "zone:hvn-27380" in source_ids


# ---------------------------------------------------------------------------
# Plan generation — remove-stale
# ---------------------------------------------------------------------------


def test_plan_removes_state_entries_not_in_envelope(tmp_path: Path) -> None:
    """Yesterday's VPOC at 27355 → stale today; emit Remove."""
    envelope = _make_envelope(
        reference_lines=[_ref(price=27381.25, source="vpoc")],
    )
    state = {
        "ref:vpoc:27355.00": "shape-old-vpoc",   # stale (moved)
        "zone:hvn-27200": "shape-old-hvn",         # stale (gone)
    }
    plan = plan_sync(
        envelope=envelope, state=state,
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )

    removes = [op for op in plan.operations if isinstance(op, RemoveOperation)]
    assert len(removes) == 2
    removed_source_ids = {op.source_id for op in removes}
    assert "ref:vpoc:27355.00" in removed_source_ids
    assert "zone:hvn-27200" in removed_source_ids
    # Each remove carries the shape_id from state
    by_source = {op.source_id: op for op in removes}
    assert by_source["ref:vpoc:27355.00"].shape_id == "shape-old-vpoc"
    assert by_source["zone:hvn-27200"].shape_id == "shape-old-hvn"


# ---------------------------------------------------------------------------
# Plan generation — noop / idempotency
# ---------------------------------------------------------------------------


def test_plan_noop_when_state_matches_envelope(tmp_path: Path) -> None:
    """All target sources already in state → all NoChange."""
    envelope = _make_envelope(
        reference_lines=[
            _ref(price=27381.25, source="vpoc"),
            _ref(price=27390.00, source="vah"),
        ],
    )
    state = {
        "ref:vpoc:27381.25": "shape-a",
        "ref:vah:27390.00": "shape-b",
    }
    plan = plan_sync(
        envelope=envelope, state=state,
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )

    assert plan.n_add == 0
    assert plan.n_remove == 0
    assert plan.n_noop == 2


def test_plan_idempotent_same_inputs_same_output(tmp_path: Path) -> None:
    """plan_sync is pure — same inputs → identical output (excluding timestamps)."""
    envelope = _make_envelope(
        reference_lines=[_ref(price=27381.25, source="vpoc")],
        zones=[_zone_dict(zid="hvn-27380")],
    )
    state = {"ref:vpoc:27381.25": "shape-1"}
    p1 = plan_sync(
        envelope=envelope, state=state,
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )
    p2 = plan_sync(
        envelope=envelope, state=state,
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )

    # Same operation list (timestamps differ but ops are deterministic)
    assert [o.to_dict() for o in p1.operations] == [o.to_dict() for o in p2.operations]


# ---------------------------------------------------------------------------
# Plan generation — mixed add/remove/noop
# ---------------------------------------------------------------------------


def test_plan_mixed_add_remove_noop(tmp_path: Path) -> None:
    """One stale + one unchanged + one new → 1 remove + 1 noop + 1 add."""
    envelope = _make_envelope(
        reference_lines=[
            _ref(price=27381.25, source="vpoc"),    # unchanged
            _ref(price=27390.00, source="vah"),     # NEW
        ],
    )
    state = {
        "ref:vpoc:27381.25": "shape-vpoc",  # unchanged
        "ref:val:27370.00": "shape-old-val",  # stale (envelope has no VAL today)
    }
    plan = plan_sync(
        envelope=envelope, state=state,
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )

    assert plan.n_add == 1
    assert plan.n_remove == 1
    assert plan.n_noop == 1


# ---------------------------------------------------------------------------
# Style policy
# ---------------------------------------------------------------------------


def test_vwap_rth_color_is_teal_not_orange() -> None:
    """Avoid visual collision with Neel's W-AVWAP indicator. Locked per
    RA-034 D-default."""
    assert STYLE_BY_SOURCE["vwap_rth"]["color"] == "#14B8A6"


def test_vwap_globex_color_is_purple_not_orange() -> None:
    """Same as above for Globex anchor."""
    assert STYLE_BY_SOURCE["vwap_globex"]["color"] == "#A855F7"


def test_vwap_band_color_matches_centerline() -> None:
    """±1σ bands inherit the anchor's color so they visually group with the line."""
    assert STYLE_BY_SOURCE["vwap_rth_band_p1sd"]["color"] == STYLE_BY_SOURCE["vwap_rth"]["color"]
    assert STYLE_BY_SOURCE["vwap_globex_band_m1sd"]["color"] == STYLE_BY_SOURCE["vwap_globex"]["color"]


def test_conviction_opacity_ordered_high_to_low() -> None:
    """SUPER > HIGH > MED > LOW opacity."""
    s = STYLE_BY_CONVICTION
    assert s["SUPER"]["opacity"] > s["HIGH"]["opacity"]
    assert s["HIGH"]["opacity"] > s["MED"]["opacity"]
    assert s["MED"]["opacity"] > s["LOW"]["opacity"]


def test_add_op_carries_style_for_reference_line(tmp_path: Path) -> None:
    envelope = _make_envelope(reference_lines=[_ref(source="vpoc")])
    plan = plan_sync(
        envelope=envelope, state={},
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )
    add_op = plan.operations[0]
    assert isinstance(add_op, AddOperation)
    assert add_op.style["color"] == "#84CC16"  # lime for VPOC


def test_add_op_carries_style_for_zone(tmp_path: Path) -> None:
    envelope = _make_envelope(zones=[_zone_dict(conviction="HIGH")])
    plan = plan_sync(
        envelope=envelope, state={},
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )
    add_op = plan.operations[0]
    assert isinstance(add_op, AddOperation)
    assert add_op.kind == "rectangle"
    assert add_op.style["opacity"] == STYLE_BY_CONVICTION["HIGH"]["opacity"]


def test_unknown_source_falls_back_to_default_style(tmp_path: Path) -> None:
    """A source not in STYLE_BY_SOURCE → neutral gray fallback, doesn't crash."""
    envelope = _make_envelope(
        reference_lines=[_ref(source="some_future_indicator")],
    )
    plan = plan_sync(
        envelope=envelope, state={},
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )
    add_op = plan.operations[0]
    assert isinstance(add_op, AddOperation)
    assert add_op.style["color"] == "#9CA3AF"  # gray fallback


# ---------------------------------------------------------------------------
# State file I/O
# ---------------------------------------------------------------------------


def test_load_state_missing_file_returns_empty_dict(tmp_path: Path) -> None:
    assert load_state(tmp_path / "nope.json") == {}


def test_load_state_malformed_returns_empty_dict(tmp_path: Path) -> None:
    """Don't crash on garbled state file — log + recover (bootstrap-safe)."""
    path = tmp_path / "state.json"
    path.write_text("not-valid-json{[", encoding="utf-8")
    assert load_state(path) == {}


def test_load_state_supports_flat_and_nested_mappings(tmp_path: Path) -> None:
    """Backward compatible: tolerates both {sid: str} and {sid: {"shape_id": str}}."""
    path = tmp_path / "state.json"
    path.write_text(
        json.dumps({
            "version": 1, "backend": "tv_desktop", "chart_id": "MNQ",
            "mappings": {
                "ref:vpoc:27381.25": {"shape_id": "shape-a", "added_at": "..."},
                "zone:hvn-27380": "shape-b",   # flat form
            },
        }),
        encoding="utf-8",
    )
    state = load_state(path)
    assert state == {"ref:vpoc:27381.25": "shape-a", "zone:hvn-27380": "shape-b"}


def test_write_state_atomic_via_tmp_rename(tmp_path: Path) -> None:
    """Verify the .tmp file is gone after write (rename completed)."""
    path = tmp_path / "state.json"
    write_state(
        path, backend="tv_desktop", chart_id="MNQ",
        mappings={"ref:vpoc:27381.25": "shape-a"},
    )
    assert path.exists()
    assert not (tmp_path / "state.json.tmp").exists()


def test_write_state_roundtrip(tmp_path: Path) -> None:
    """write_state + load_state → same mapping dict."""
    path = tmp_path / "state.json"
    mappings = {
        "ref:vpoc:27381.25": "shape-a",
        "zone:hvn-27380": "shape-b",
    }
    write_state(path, backend="tv_desktop", chart_id="MNQ", mappings=mappings)
    assert load_state(path) == mappings


def test_write_state_creates_parent_dir(tmp_path: Path) -> None:
    deep = tmp_path / "x" / "y" / "state.json"
    write_state(deep, backend="tv_desktop", chart_id="MNQ", mappings={})
    assert deep.exists()


# ---------------------------------------------------------------------------
# Safety contract: manual user shapes never seen by planner
# ---------------------------------------------------------------------------


def test_safety_contract_planner_does_not_query_chart(tmp_path: Path) -> None:
    """plan_sync should NEVER touch a TVBackend instance — by design, the
    state file is the sole source of truth for what shapes tv_sync owns.

    A user's manually-drawn fib retracement isn't in the state file, so
    it can never be the target of a Remove op. This is the load-bearing
    safety invariant.
    """
    # Construct envelope with a vpoc; envelope's vpoc is the only thing tv_sync
    # would touch. The MockBackend's seeded fib shape must NEVER appear in plan ops.
    backend = MockBackend()
    backend.seed([
        ShapeRecord(
            shape_id="user-fib-1", kind="trend_line",
            label="Fib 0.618", price=None, top=27500.0, bot=27200.0,
        ),
    ])

    envelope = _make_envelope(reference_lines=[_ref(source="vpoc")])
    plan = plan_sync(
        envelope=envelope, state={},  # NOTE: empty state — fib isn't ours
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )

    # No operation references the user-fib shape_id
    for op in plan.operations:
        if isinstance(op, RemoveOperation):
            assert op.shape_id != "user-fib-1"
    # Fib survives backend.seed (the planner never even saw it)
    assert "user-fib-1" in backend.all_shape_ids()


# ---------------------------------------------------------------------------
# Plan file I/O
# ---------------------------------------------------------------------------


def test_write_plan_roundtrip(tmp_path: Path) -> None:
    envelope = _make_envelope(reference_lines=[_ref(source="vpoc")])
    plan = plan_sync(
        envelope=envelope, state={},
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )
    plan_path = tmp_path / "plans" / "tv_desktop_MNQ_20260520.json"
    write_plan(plan, plan_path)
    assert plan_path.exists()
    loaded = json.loads(plan_path.read_text(encoding="utf-8"))
    assert loaded["plan_version"] == 1
    assert loaded["backend"] == "tv_desktop"
    assert len(loaded["operations"]) == 1


def test_write_latest_pointer(tmp_path: Path) -> None:
    """`_latest.json` pointer for the executor agent."""
    plans_root = tmp_path / "plans"
    plan_path = plans_root / "tv_desktop_MNQ_xyz.json"
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    plan_path.write_text("{}")  # dummy

    latest_path = write_latest_pointer(plans_root, plan_path, "tv_desktop")
    assert latest_path == plans_root / "_latest.json"
    payload = json.loads(latest_path.read_text(encoding="utf-8"))
    assert payload["backend"] == "tv_desktop"
    assert payload["plan_path"] == str(plan_path)
    assert "generated_at" in payload


# ---------------------------------------------------------------------------
# Plan meta carries the executor hints
# ---------------------------------------------------------------------------


def test_plan_meta_carries_executor_hints(tmp_path: Path) -> None:
    """Plan.meta should carry the 2026-05-20 incident references so the
    executor agent's prompt has them visible."""
    envelope = _make_envelope()
    plan = plan_sync(
        envelope=envelope, state={},
        backend="tradesea", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )
    assert "time_anchor_hint" in plan.meta
    assert "Math.floor" in plan.meta["time_anchor_hint"]
    assert "createMultipointShape_hint" in plan.meta
    assert "underscore" in plan.meta["createMultipointShape_hint"]
    assert "iframe_remount_hint" in plan.meta


# ---------------------------------------------------------------------------
# Dataclass invariants
# ---------------------------------------------------------------------------


def test_add_operation_to_dict() -> None:
    op = AddOperation(
        source_id="ref:vpoc:27381.25", kind="reference_line",
        label="VPOC 27381.25", style={"color": "#84CC16"},
        price=27381.25,
    )
    d = op.to_dict()
    assert d["op"] == "add"
    assert d["source_id"] == "ref:vpoc:27381.25"
    assert d["style"]["color"] == "#84CC16"


def test_remove_operation_to_dict() -> None:
    op = RemoveOperation(
        source_id="ref:vpoc:27355.00", shape_id="shape-x",
        reason="not present in zones JSON",
    )
    assert op.to_dict()["shape_id"] == "shape-x"


def test_nochange_operation_to_dict() -> None:
    op = NoChangeOperation(source_id="ref:vpoc:27381.25", reason="already present")
    assert op.to_dict()["op"] == "noop"


def test_operations_are_frozen() -> None:
    import dataclasses
    op = AddOperation(
        source_id="x", kind="reference_line", label="x", style={},
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        op.source_id = "y"  # type: ignore[misc]


def test_plan_to_dict_serialisable_as_json(tmp_path: Path) -> None:
    """Plan.to_dict() output is JSON-safe."""
    envelope = _make_envelope(
        reference_lines=[_ref(source="vpoc")],
        zones=[_zone_dict()],
    )
    plan = plan_sync(
        envelope=envelope, state={"ref:val:27370.00": "old-shape"},
        backend="tv_desktop", chart_id="MNQ",
        zones_json_path=tmp_path / "z.json",
        state_path=tmp_path / "s.json",
    )
    s = json.dumps(plan.to_dict())
    assert "ref:vpoc:27381.25" in s
