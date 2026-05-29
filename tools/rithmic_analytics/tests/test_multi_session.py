"""Tests for ``rithmic_analytics.features.multi_session``."""

from __future__ import annotations

import math

import pandas as pd
import pytest

from rithmic_analytics.features.multi_session import (
    MultiSessionHVN,
    MultiSessionVP,
    aggregate_multi_session,
)
from rithmic_analytics.features.volume_profile import HVNBin, VolumeProfile


def _make_vp(*, vpoc: float, vah: float, val: float, hvns: list[HVNBin]) -> VolumeProfile:
    return VolumeProfile(
        vpoc=vpoc,
        vah=vah,
        val=val,
        total_volume=sum(h.volume for h in hvns) or 1,
        bins=pd.Series(dtype="int64"),
        hvn_list=hvns,
        lvn_list=[],
        bin_size=5.0,
        va_pct=0.70,
    )


def _hvn(price_low: float, volume: int = 100, *, bin_size: float = 5.0) -> HVNBin:
    return HVNBin(
        price_low=price_low,
        price_high=price_low + bin_size,
        volume=volume,
        volume_pct=0.10,
    )


# ---------------------------------------------------------------------------
# Empty / degenerate input
# ---------------------------------------------------------------------------


def test_empty_session_list_returns_empty_result() -> None:
    multi = aggregate_multi_session([])

    assert isinstance(multi, MultiSessionVP)
    assert multi.sessions_used == []
    assert multi.rolling_window == 0
    assert multi.hvns == []
    assert math.isnan(multi.aggregate_vpoc)


def test_single_session_emits_single_conviction() -> None:
    vp = _make_vp(
        vpoc=27380.0, vah=27400.0, val=27360.0,
        hvns=[_hvn(27380.0, volume=100), _hvn(27370.0, volume=80)],
    )
    multi = aggregate_multi_session([("s1", vp)])

    assert multi.rolling_window == 1
    assert multi.sessions_used == ["s1"]
    # Single-session HVNs get conviction="SINGLE"
    assert all(h.conviction == "SINGLE" for h in multi.hvns)
    assert all(h.multi_session_count == 1 for h in multi.hvns)


# ---------------------------------------------------------------------------
# Clustering across sessions
# ---------------------------------------------------------------------------


def test_three_sessions_with_same_hvn_form_structural_cluster() -> None:
    vp1 = _make_vp(vpoc=27380.0, vah=27400.0, val=27360.0, hvns=[_hvn(27380.0, 100)])
    vp2 = _make_vp(vpoc=27380.0, vah=27400.0, val=27360.0, hvns=[_hvn(27380.0, 120)])
    vp3 = _make_vp(vpoc=27380.0, vah=27400.0, val=27360.0, hvns=[_hvn(27380.0, 110)])

    multi = aggregate_multi_session(
        [("s1", vp1), ("s2", vp2), ("s3", vp3)],
        structural_threshold=3,
    )

    assert len(multi.hvns) == 1
    h = multi.hvns[0]
    assert h.multi_session_count == 3
    assert h.conviction == "STRUCTURAL"
    assert sorted(h.member_sessions) == ["s1", "s2", "s3"]
    assert h.total_volume == 100 + 120 + 110


def test_two_sessions_with_same_hvn_is_persistent_not_structural() -> None:
    vp1 = _make_vp(vpoc=27380.0, vah=27400.0, val=27360.0, hvns=[_hvn(27380.0, 100)])
    vp2 = _make_vp(vpoc=27380.0, vah=27400.0, val=27360.0, hvns=[_hvn(27380.0, 120)])

    multi = aggregate_multi_session(
        [("s1", vp1), ("s2", vp2)],
        structural_threshold=3,
    )

    h = multi.hvns[0]
    assert h.multi_session_count == 2
    assert h.conviction == "PERSISTENT"


def test_disjoint_hvns_no_structural_cluster() -> None:
    # 5 sessions, each with HVN at a different price → no clusters merge.
    sessions = [
        (f"s{i}", _make_vp(
            vpoc=27380.0 + i * 50,
            vah=27400.0 + i * 50,
            val=27360.0 + i * 50,
            hvns=[_hvn(27380.0 + i * 50, 100)],
        ))
        for i in range(5)
    ]

    multi = aggregate_multi_session(sessions, structural_threshold=3)

    assert all(h.conviction == "SINGLE" for h in multi.hvns)


def test_cluster_tolerance_kwarg_respected() -> None:
    # Two HVNs 4 points apart. With tolerance=5 (default), they cluster.
    # With tolerance=2, they don't.
    vp1 = _make_vp(vpoc=27380.0, vah=27400.0, val=27360.0, hvns=[_hvn(27380.0, 100)])
    vp2 = _make_vp(vpoc=27384.0, vah=27400.0, val=27360.0, hvns=[_hvn(27384.0, 120)])

    multi_loose = aggregate_multi_session(
        [("s1", vp1), ("s2", vp2)], cluster_tolerance_pts=5.0
    )
    multi_strict = aggregate_multi_session(
        [("s1", vp1), ("s2", vp2)], cluster_tolerance_pts=2.0
    )

    assert len(multi_loose.hvns) == 1  # merged
    assert multi_loose.hvns[0].multi_session_count == 2
    assert len(multi_strict.hvns) == 2  # not merged
    assert all(h.multi_session_count == 1 for h in multi_strict.hvns)


def test_same_session_two_adjacent_hvns_count_as_one_session() -> None:
    # Defensive: if one session has two HVNs in the same cluster, the cluster
    # still counts that session ONCE.
    vp1 = _make_vp(
        vpoc=27380.0, vah=27400.0, val=27360.0,
        hvns=[_hvn(27378.0, 80), _hvn(27382.0, 100)],  # both within 5pt
    )
    vp2 = _make_vp(vpoc=27380.0, vah=27400.0, val=27360.0, hvns=[_hvn(27380.0, 90)])

    multi = aggregate_multi_session([("s1", vp1), ("s2", vp2)], cluster_tolerance_pts=5.0)

    # All three HVNs merge into one cluster, but session count is 2 (not 3)
    h = multi.hvns[0]
    assert h.multi_session_count == 2
    assert sorted(h.member_sessions) == ["s1", "s2"]
    # Total volume still sums all member HVN volumes
    assert h.total_volume == 80 + 100 + 90


def test_structural_threshold_kwarg_respected() -> None:
    vps = [
        ("s1", _make_vp(vpoc=27380.0, vah=27400.0, val=27360.0, hvns=[_hvn(27380.0, 100)])),
        ("s2", _make_vp(vpoc=27380.0, vah=27400.0, val=27360.0, hvns=[_hvn(27380.0, 100)])),
    ]
    # threshold=2 → 2-session cluster qualifies as STRUCTURAL
    multi_loose = aggregate_multi_session(vps, structural_threshold=2)
    # threshold=3 → 2-session cluster is just PERSISTENT
    multi_strict = aggregate_multi_session(vps, structural_threshold=3)

    assert multi_loose.hvns[0].conviction == "STRUCTURAL"
    assert multi_strict.hvns[0].conviction == "PERSISTENT"


def test_top_n_kwarg_caps_returned_clusters() -> None:
    # 5 single-session HVNs at different prices → 5 clusters
    sessions = [
        (f"s{i}", _make_vp(
            vpoc=27380.0 + i * 50,
            vah=27400.0 + i * 50,
            val=27360.0 + i * 50,
            hvns=[_hvn(27380.0 + i * 50, 100)],
        ))
        for i in range(5)
    ]

    multi = aggregate_multi_session(sessions, top_n=3)

    assert len(multi.hvns) == 3


# ---------------------------------------------------------------------------
# Aggregate VPOC / VAH / VAL
# ---------------------------------------------------------------------------


def test_aggregate_scalars_mean_of_sessions() -> None:
    vp1 = _make_vp(vpoc=27380.0, vah=27400.0, val=27360.0, hvns=[])
    vp2 = _make_vp(vpoc=27390.0, vah=27410.0, val=27370.0, hvns=[])

    multi = aggregate_multi_session([("s1", vp1), ("s2", vp2)])

    assert multi.aggregate_vpoc == pytest.approx(27385.0)
    assert multi.aggregate_vah == pytest.approx(27405.0)
    assert multi.aggregate_val == pytest.approx(27365.0)


def test_aggregate_scalars_skip_nan_inputs() -> None:
    # Session 1 has NaN VPOC (empty VP); session 2 has finite values.
    # Aggregate should equal session 2 alone (not be polluted by NaN).
    vp1 = _make_vp(vpoc=math.nan, vah=math.nan, val=math.nan, hvns=[])
    vp2 = _make_vp(vpoc=27390.0, vah=27410.0, val=27370.0, hvns=[])

    multi = aggregate_multi_session([("s1", vp1), ("s2", vp2)])

    assert multi.aggregate_vpoc == pytest.approx(27390.0)


# ---------------------------------------------------------------------------
# Output ordering + dataclass safety
# ---------------------------------------------------------------------------


def test_hvns_sorted_by_count_then_volume_desc() -> None:
    # Three clusters: one 3-session (high), one 2-session (medium), one 1-session (low).
    # The 3-session one should sort first.
    vps = [
        ("s1", _make_vp(vpoc=27300.0, vah=27320.0, val=27280.0, hvns=[
            _hvn(27300.0, 100),  # → 3-session cluster
            _hvn(27400.0, 90),   # → 2-session cluster
            _hvn(27500.0, 50),   # → 1-session cluster
        ])),
        ("s2", _make_vp(vpoc=27300.0, vah=27320.0, val=27280.0, hvns=[
            _hvn(27300.0, 120),
            _hvn(27400.0, 110),
        ])),
        ("s3", _make_vp(vpoc=27300.0, vah=27320.0, val=27280.0, hvns=[
            _hvn(27300.0, 130),
        ])),
    ]

    multi = aggregate_multi_session(vps, structural_threshold=3, top_n=8)

    assert multi.hvns[0].multi_session_count == 3
    assert multi.hvns[1].multi_session_count == 2
    assert multi.hvns[2].multi_session_count == 1


def test_dataclasses_are_frozen() -> None:
    import dataclasses

    h = MultiSessionHVN(
        price_low=27380.0, price_high=27385.0, center=27382.5,
        member_sessions=["s1"], multi_session_count=1, conviction="SINGLE",
        total_volume=100,
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        h.conviction = "STRUCTURAL"  # type: ignore[misc]

    multi = MultiSessionVP(sessions_used=[], rolling_window=0)
    with pytest.raises(dataclasses.FrozenInstanceError):
        multi.rolling_window = 5  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Zone schema integration (multi_session_count field)
# ---------------------------------------------------------------------------


def test_zone_dataclass_accepts_multi_session_count() -> None:
    from rithmic_analytics.core.schema import Zone, ZoneEnvelope, validate_envelope

    # Note: MultiSessionHVN.conviction is "STRUCTURAL" (informational), but the
    # Zone's conviction must be one of the Zone schema's enum values. The
    # natural mapping for a STRUCTURAL multi-session cluster is "SUPER".
    zone = Zone(
        id="hvn-27380",
        top=27385.0,
        bot=27380.0,
        type="support",
        conviction="SUPER",
        text="3-session cluster",
        sources=["hvn_rth"],
        multi_session_count=3,
    )
    envelope = ZoneEnvelope(
        schema_version=1,
        symbol="MNQ",
        timeframe="multi-session",
        bars_used=0,
        computed_at="2026-05-17T00:00:00+00:00",
        data_source="rithmic",
        vpoc=27380.0,
        vah=27395.0,
        val=27365.0,
        atr_14=42.0,
        bin_size_ticks=20,
        zones=[zone],
        reference_lines=[],
    )

    payload = envelope.to_dict()
    validate_envelope(payload)  # must pass with new multi_session_count field
    assert payload["zones"][0]["multi_session_count"] == 3
