"""Tests for ``rithmic_analytics.core.schema``."""

from __future__ import annotations

import dataclasses
import json
import math
import re

import jsonschema
import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.schema import (
    SCHEMA_VERSION,
    ReferenceLine,
    Zone,
    ZoneEnvelope,
    _format_bin_id,
    grade_zone,
    validate_envelope,
)
from rithmic_analytics.features.volume_profile import compute_vp

# ---------------------------------------------------------------------------
# _format_bin_id
# ---------------------------------------------------------------------------


def test_format_bin_id_integer_drops_decimal() -> None:
    assert _format_bin_id(27380.0) == "27380"


def test_format_bin_id_quarter() -> None:
    assert _format_bin_id(27380.25) == "27380.25"


def test_format_bin_id_half_strips_trailing_zero() -> None:
    assert _format_bin_id(27380.50) == "27380.5"


def test_format_bin_id_negative() -> None:
    assert _format_bin_id(-5.0) == "-5"
    assert _format_bin_id(-5.25) == "-5.25"


# ---------------------------------------------------------------------------
# grade_zone — SUPER (≥4 distinct HVN TFs)
# ---------------------------------------------------------------------------


def test_grade_zone_super_4_distinct_tfs() -> None:
    assert grade_zone(["hvn_1m", "hvn_5m", "hvn_15m", "hvn_1h"]) == "SUPER"


def test_grade_zone_super_5_distinct_tfs() -> None:
    assert grade_zone(["hvn_1m", "hvn_5m", "hvn_15m", "hvn_1h", "hvn_4h"]) == "SUPER"


def test_grade_zone_same_tf_repeated_is_not_super() -> None:
    # Defensive: 4 entries of the same TF count as 1 distinct TF → MED, not SUPER.
    assert grade_zone(["hvn_5m"] * 4) == "MED"


def test_grade_zone_three_distinct_tfs_alone_is_med() -> None:
    assert grade_zone(["hvn_5m", "hvn_15m", "hvn_1h"]) == "MED"


# ---------------------------------------------------------------------------
# grade_zone — HIGH (HVN + band + structural)
# ---------------------------------------------------------------------------


def test_grade_zone_high_hvn_band_ema() -> None:
    assert grade_zone(["hvn_5m", "weekly_avwap_band", "ema50"]) == "HIGH"


def test_grade_zone_high_hvn_band_swing() -> None:
    assert grade_zone(["hvn_15m", "daily_avwap_upper_band", "swing_high"]) == "HIGH"


def test_grade_zone_hvn_band_without_structural_is_med() -> None:
    # HIGH requires all three legs.
    assert grade_zone(["hvn_5m", "weekly_avwap_band"]) == "MED"


def test_grade_zone_hvn_structural_without_band_is_med() -> None:
    assert grade_zone(["hvn_5m", "ema50"]) == "MED"


# ---------------------------------------------------------------------------
# grade_zone — MED + LOW
# ---------------------------------------------------------------------------


def test_grade_zone_band_alone_is_med() -> None:
    assert grade_zone(["weekly_avwap_band"]) == "MED"


def test_grade_zone_vah_alone_is_med() -> None:
    assert grade_zone(["vah"]) == "MED"


def test_grade_zone_val_alone_is_med() -> None:
    assert grade_zone(["val"]) == "MED"


def test_grade_zone_ema_and_round_only_is_low() -> None:
    assert grade_zone(["ema50", "round_27500"]) == "LOW"


def test_grade_zone_empty_is_low() -> None:
    assert grade_zone([]) == "LOW"


def test_grade_zone_malformed_hvn_no_tf_skipped() -> None:
    # 'hvn_' with no TF suffix and 'hvn_garbage' should not contribute to TF count.
    assert grade_zone(["hvn_", "ema50"]) == "LOW"
    assert grade_zone(["hvn_garbage", "ema50"]) == "LOW"


def test_grade_zone_unknown_source_ignored() -> None:
    # Truly unknown sources don't promote conviction.
    assert grade_zone(["foobar"]) == "LOW"


def test_grade_zone_session_label_counts_as_hvn() -> None:
    # The Phase 1 builder tags HVNs with the session label (e.g. 'hvn_rth',
    # 'hvn_globex') rather than a bar size. Those must be recognized so the
    # zones produced by `compute_vp` CLI get MED conviction, not LOW.
    assert grade_zone(["hvn_rth"]) == "MED"
    assert grade_zone(["hvn_globex"]) == "MED"


def test_grade_zone_mixed_bar_and_session_tfs_can_super() -> None:
    # 4 distinct TFs across bar + session labels → SUPER (multi-TF builder will
    # produce these once RA-021 lands).
    assert grade_zone(["hvn_5m", "hvn_15m", "hvn_rth", "hvn_globex"]) == "SUPER"


# ---------------------------------------------------------------------------
# ZoneEnvelope.from_volume_profile + validation round-trip
# ---------------------------------------------------------------------------


def _build_test_vp() -> object:
    trades = pd.DataFrame(
        {
            "price": [27380.5] * 60 + [27420.5] * 30 + [27460.5] * 10,
            "quantity": [1] * 100,
        }
    )
    return compute_vp(trades, MNQ, bin_size_ticks=20, top_n=3)


def test_envelope_from_vp_basic_fields() -> None:
    vp = _build_test_vp()
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
        bars_used=7,
    )

    assert env.schema_version == SCHEMA_VERSION
    assert env.symbol == "MNQ"
    assert env.timeframe == "5m"
    assert env.bars_used == 7
    assert env.data_source == "rithmic"
    assert env.atr_14 == 42.0
    assert env.bin_size_ticks == 20
    # ISO-8601 with timezone — must be parseable and contain 'T'
    assert "T" in env.computed_at
    assert "+00:00" in env.computed_at or env.computed_at.endswith("Z")


def test_envelope_from_vp_zones_match_hvns() -> None:
    vp = _build_test_vp()  # 3 HVN bins by construction
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    assert len(env.zones) == 3
    assert all(z.type == "support" for z in env.zones)
    assert all(z.id.startswith("hvn-") for z in env.zones)
    # All sources should be 'hvn_5m' → grader returns MED (single HVN, 1 TF).
    assert all(z.conviction == "MED" for z in env.zones)


def test_envelope_from_vp_reference_lines_include_vpoc_vah_val() -> None:
    vp = _build_test_vp()
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    sources = {r.source for r in env.reference_lines}
    assert "vpoc" in sources
    assert "vah" in sources
    assert "val" in sources


def test_envelope_lvns_become_reference_lines() -> None:
    # Build a fixture with many LVN-eligible bins (lots of distinct prices, all 1-vol).
    trades = pd.DataFrame(
        {
            "price": [27000.0 + i * 5.0 + 0.5 for i in range(20)],
            "quantity": [1] * 20,
        }
    )
    vp = compute_vp(trades, MNQ, top_n=4)

    env = ZoneEnvelope.from_volume_profile(
        vp,
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    lvn_refs = [r for r in env.reference_lines if r.source == "lvn_5m"]
    assert len(lvn_refs) == 4


def test_envelope_to_dict_validates_against_schema() -> None:
    vp = _build_test_vp()
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    validate_envelope(env.to_dict())  # would raise on mismatch


def test_envelope_to_json_round_trip() -> None:
    vp = _build_test_vp()
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    s = env.to_json()
    parsed = json.loads(s)
    validate_envelope(parsed)
    # Round-trip determinism on the primitive fields
    assert parsed["symbol"] == env.symbol
    assert parsed["vpoc"] == env.vpoc
    assert parsed["bin_size_ticks"] == 20
    assert len(parsed["zones"]) == len(env.zones)


def test_envelope_to_json_strict_no_nan_token() -> None:
    # Empty VP → NaN VPOC → JSON must serialize as null, never "NaN" (which is
    # invalid JSON and would break downstream parsers).
    empty_vp = compute_vp(pd.DataFrame({"price": [], "quantity": []}), MNQ)
    env = ZoneEnvelope.from_volume_profile(
        empty_vp,
        symbol="MNQ",
        timeframe="rth",
        atr_14=math.nan,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    s = env.to_json()

    assert "NaN" not in s
    parsed = json.loads(s)
    assert parsed["vpoc"] is None
    assert parsed["vah"] is None
    assert parsed["val"] is None
    assert parsed["atr_14"] is None
    validate_envelope(parsed)


def test_envelope_data_source_enum_enforced() -> None:
    vp = _build_test_vp()
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    payload = env.to_dict()
    payload["data_source"] = "csv_import"  # not in enum

    with pytest.raises(jsonschema.ValidationError):
        validate_envelope(payload)


def test_envelope_conviction_enum_enforced() -> None:
    vp = _build_test_vp()
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    payload = env.to_dict()
    payload["zones"][0]["conviction"] = "ULTRA"  # not in enum

    with pytest.raises(jsonschema.ValidationError):
        validate_envelope(payload)


def test_envelope_missing_required_field_rejected() -> None:
    bad = {"schema_version": 1}
    with pytest.raises(jsonschema.ValidationError):
        validate_envelope(bad)


def test_envelope_additional_property_rejected() -> None:
    vp = _build_test_vp()
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    payload = env.to_dict()
    payload["unexpected_field"] = "should not be here"

    with pytest.raises(jsonschema.ValidationError):
        validate_envelope(payload)


# ---------------------------------------------------------------------------
# Zone-ID determinism + format
# ---------------------------------------------------------------------------


def test_zone_id_format_integer_bin() -> None:
    vp = _build_test_vp()
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    # Bin lows for 5-point bins are multiples of 5 → IDs should have no decimal.
    for zone in env.zones:
        assert re.match(r"^hvn-\d+$", zone.id), f"unexpected id format: {zone.id}"


def test_zone_id_idempotent_across_reruns() -> None:
    vp1 = _build_test_vp()
    vp2 = _build_test_vp()
    env1 = ZoneEnvelope.from_volume_profile(
        vp1,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )
    env2 = ZoneEnvelope.from_volume_profile(
        vp2,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    ids1 = sorted(z.id for z in env1.zones)
    ids2 = sorted(z.id for z in env2.zones)
    assert ids1 == ids2


# ---------------------------------------------------------------------------
# summary_line
# ---------------------------------------------------------------------------


def test_summary_line_format() -> None:
    vp = _build_test_vp()
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="rth",
        atr_14=39.7,
        data_source="rithmic",
        bin_size_ticks=20,
    )

    line = env.summary_line()

    assert "MNQ" in line
    assert "rth" in line
    assert "VPOC=" in line
    assert "VAH=" in line
    assert "VAL=" in line
    assert "HVNs" in line
    assert "ATR14=39.7" in line


# ---------------------------------------------------------------------------
# Frozen / dataclass safety
# ---------------------------------------------------------------------------


def test_zone_dataclass_frozen() -> None:
    z = Zone(
        id="hvn-27380",
        top=27385.0,
        bot=27380.0,
        type="support",
        conviction="MED",
        text="HVN",
        sources=["hvn_5m"],
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        z.top = 99.0  # type: ignore[misc]


def test_reference_line_frozen() -> None:
    r = ReferenceLine(price=27380.0, text="VPOC", source="vpoc")
    with pytest.raises(dataclasses.FrozenInstanceError):
        r.price = 99.0  # type: ignore[misc]


def test_envelope_frozen() -> None:
    vp = _build_test_vp()
    env = ZoneEnvelope.from_volume_profile(
        vp,  # type: ignore[arg-type]
        symbol="MNQ",
        timeframe="5m",
        atr_14=42.0,
        data_source="rithmic",
        bin_size_ticks=20,
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        env.symbol = "ES"  # type: ignore[misc]
