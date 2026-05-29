"""Tests for ``rithmic_analytics.features.zone_quality`` (RA-027)."""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.schema import Zone
from rithmic_analytics.features.zone_quality import (
    BinomialEstimate,
    ConvictionSummary,
    HistoryReport,
    SessionQualityReport,
    ZoneOutcome,
    aggregate_history,
    classify_zones,
    score_session,
    wilson_ci,
)

_NS_PER_SECOND = 10**9
_BASE_TS = 1_777_300_000_000_000_000  # ~ 2026-04-27


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _make_trades(prices: list[float], *, dt_seconds: float = 1.0,
                 session_id: str = "mnq-2026-04-27-rth") -> pd.DataFrame:
    """Build a synthetic trades DataFrame at 1-second spacing."""
    n = len(prices)
    ts = [_BASE_TS + int(i * dt_seconds * _NS_PER_SECOND) for i in range(n)]
    df = pd.DataFrame({
        "event_ts_ns": pd.Series(ts, dtype="int64"),
        "recv_ts_ns": pd.Series(ts, dtype="int64"),
        "session_id": session_id,
        "price": pd.Series(prices, dtype="float64"),
        "quantity": pd.Series([1] * n, dtype="int32"),
        "aggressor_side": pd.Categorical(["buy"] * n),
        "trade_id": pd.Series([f"t-{i}" for i in range(n)], dtype="string"),
        "signed_qty": pd.Series([1] * n, dtype="int32"),
    })
    return df


def _zone(zid: str, top: float, bot: float, *, conviction: str = "MED",
          ztype: str = "support") -> Zone:
    return Zone(
        id=zid, top=top, bot=bot, type=ztype, conviction=conviction,
        text=f"Zone {zid}", sources=["hvn_rth"], volume_pct=0.1,
    )


# ---------------------------------------------------------------------------
# Wilson CI
# ---------------------------------------------------------------------------


def test_wilson_ci_zero_trials_returns_full_range() -> None:
    assert wilson_ci(0, 0) == (0.0, 1.0)


def test_wilson_ci_perfect_success() -> None:
    """10/10 → upper bound 1.0, lower bound > 0."""
    low, high = wilson_ci(10, 10)
    assert high == pytest.approx(1.0, abs=0.001)
    assert 0.6 < low < 1.0


def test_wilson_ci_perfect_failure() -> None:
    """0/10 → lower bound 0.0, upper bound > 0."""
    low, high = wilson_ci(0, 10)
    assert low == pytest.approx(0.0, abs=0.001)
    assert 0.0 < high < 0.4


def test_wilson_ci_known_value_50_50() -> None:
    """50/100 → roughly symmetric around 0.5."""
    low, high = wilson_ci(50, 100)
    assert low == pytest.approx(0.404, abs=0.005)
    assert high == pytest.approx(0.596, abs=0.005)


def test_wilson_ci_small_sample_wide_interval() -> None:
    """4/5 has a wide interval — single-point estimate would mislead."""
    low, high = wilson_ci(4, 5)
    assert high - low > 0.4  # wide
    assert 0.3 < low < 0.5
    assert 0.95 < high <= 1.0


# ---------------------------------------------------------------------------
# Touch detection + outcomes — SUPPORT
# ---------------------------------------------------------------------------


def test_support_zone_held_classic_bounce() -> None:
    """Price above zone, touches it, bounces 5pts and holds → held."""
    # Zone [100, 110]; price opens at 120, drops to 105 (touches), bounces to 125
    # ATR=10 → break threshold = bot - 5 = 95
    # Session = 200s = ~3.3 min — NEED 10 min settlement window for "held"
    # So make session 700 sec (12 min) with touch at 60s, then bounce
    prices = [120.0] * 60 + [105.0] + [115.0, 120.0, 125.0] * 200
    trades = _make_trades(prices)
    zone = _zone("z-support", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    assert len(outcomes) == 1
    o = outcomes[0]
    assert o.functional_role == "support"
    assert o.touched is True
    assert o.final_outcome == "held"
    assert o.held is True
    assert o.broken is False
    assert o.bounce_distance_pts is not None
    assert o.bounce_distance_pts == pytest.approx(15.0)  # 125 - 110
    assert o.continuation_distance_pts is None


def test_support_zone_broken_with_continuation() -> None:
    """Price above zone, touches, then crashes below by >0.5*ATR → broken."""
    # Zone [100, 110]; ATR=10 → break threshold = 95
    # Price 120 → 105 (touch) → 80 (broken, 20pt continuation)
    prices = [120.0] * 60 + [105.0] + [95.0, 90.0, 80.0] * 200
    trades = _make_trades(prices)
    zone = _zone("z-broken", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    o = outcomes[0]
    assert o.final_outcome == "broken"
    assert o.broken is True
    assert o.held is False
    assert o.continuation_distance_pts is not None
    assert o.continuation_distance_pts == pytest.approx(20.0)  # 100 - 80
    assert o.bounce_distance_pts is None
    assert o.first_break_ts_ns is not None
    assert o.first_break_ts_ns > o.first_touch_ts_ns  # type: ignore[operator]


def test_support_zone_untouched_when_price_never_enters() -> None:
    """Price stays above zone → untouched."""
    prices = [120.0 + i * 0.5 for i in range(700)]
    trades = _make_trades(prices)
    zone = _zone("z-untouched", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    o = outcomes[0]
    assert o.final_outcome == "untouched"
    assert o.touched is False
    assert o.first_touch_ts_ns is None
    assert o.max_penetration_pts is None
    assert o.held is None
    assert o.broken is None


def test_support_zone_max_penetration_correctly_measured() -> None:
    """Max penetration = top - lowest_price_inside_zone."""
    # Zone [100, 110]; price wicks to 102 (8pt penetration), then bounces
    prices = [120.0] * 60 + [102.0] + [120.0] * 700
    trades = _make_trades(prices)
    zone = _zone("z-pen", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    assert outcomes[0].max_penetration_pts == pytest.approx(8.0)


# ---------------------------------------------------------------------------
# Touch detection + outcomes — RESISTANCE
# ---------------------------------------------------------------------------


def test_resistance_zone_held_price_below_zone() -> None:
    """Price opens below zone, touches it, sells off → held."""
    # Zone [200, 210]; price opens at 180, rallies to 205 (touch), falls to 175
    prices = [180.0] * 60 + [205.0] + [195.0, 185.0, 175.0] * 200
    trades = _make_trades(prices)
    zone = _zone("z-res", top=210.0, bot=200.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    o = outcomes[0]
    assert o.functional_role == "resistance"
    assert o.final_outcome == "held"
    assert o.held is True
    assert o.bounce_distance_pts == pytest.approx(25.0)  # 200 - 175


def test_resistance_zone_broken_upward() -> None:
    """Price below zone, touches, breaks UP by >0.5*ATR → broken."""
    # Zone [200, 210]; ATR=10 → break = top + 5 = 215
    # Price 180 → 205 (touch) → 225 (broken)
    prices = [180.0] * 60 + [205.0] + [215.0, 220.0, 225.0] * 200
    trades = _make_trades(prices)
    zone = _zone("z-res-break", top=210.0, bot=200.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    o = outcomes[0]
    assert o.final_outcome == "broken"
    assert o.continuation_distance_pts == pytest.approx(15.0)  # 225 - 210


# ---------------------------------------------------------------------------
# Functional role derivation
# ---------------------------------------------------------------------------


def test_declared_support_with_price_below_becomes_resistance_functionally() -> None:
    """Phase-1 declared `support` zone above price → functional resistance."""
    # Price opens at 180 (below zone); zone declared "support" by Phase-1
    prices = [180.0] * 60 + [205.0] + [195.0] * 700
    trades = _make_trades(prices)
    # Zone declared as "support" (Phase-1 default) but functionally resistance
    zone = _zone("z-flip", top=210.0, bot=200.0, ztype="support")

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    o = outcomes[0]
    assert o.declared_type == "support"
    assert o.functional_role == "resistance"


def test_reference_price_uses_first_100_floor_when_60s_too_sparse() -> None:
    """First 100 trades dominate when the 60-sec window is sparse (< 100 trades)."""
    # 50 fast prints at 120, then 200 prints at 80 (1s spacing)
    # 60-sec window catches 60 prints; max(60, 100) → use first 100 prints
    # Of those 100: 50 at 120, 50 at 80 → median = 100 (exactly on top of zone)
    # Tie-break: median of [80, 120] sorted = (50th + 51st) / 2 = (80 + 120) / 2 = 100
    # Zone [100, 110]; ref=100 means we're AT bot, role = resistance (price < bot would be res)
    # Actually 100 is at the bot edge — let's verify with cleaner numbers
    fast_prints = [120.0] * 30
    settled_prints = [80.0] * 200
    n_fast = len(fast_prints)
    n_settled = len(settled_prints)
    ts = (
        [_BASE_TS + i * 1_000_000 for i in range(n_fast)]
        + [
            _BASE_TS + n_fast * 1_000_000 + i * _NS_PER_SECOND
            for i in range(n_settled)
        ]
    )
    prices = fast_prints + settled_prints
    n = len(prices)
    df = pd.DataFrame({
        "event_ts_ns": pd.Series(ts, dtype="int64"),
        "recv_ts_ns": pd.Series(ts, dtype="int64"),
        "session_id": "mnq-2026-04-27-rth",
        "price": pd.Series(prices, dtype="float64"),
        "quantity": pd.Series([1] * n, dtype="int32"),
        "aggressor_side": pd.Categorical(["buy"] * n),
        "trade_id": pd.Series([f"t-{i}" for i in range(n)], dtype="string"),
        "signed_qty": pd.Series([1] * n, dtype="int32"),
    })

    # First 100-prints-or-60-sec floor window: 30 fast + first 70 settled prints
    # Of these 100 prints: 30 at 120, 70 at 80. Median = 80.
    # Without floor, first 30 prints would yield median=120 (mis-classifying as support)
    zone = _zone("z-fed", top=110.0, bot=100.0)
    outcomes = classify_zones([zone], df, MNQ, atr_14=10.0)

    # ref_price=80 < bot=100 → resistance
    assert outcomes[0].functional_role == "resistance"


# ---------------------------------------------------------------------------
# Internal-at-open carve-out
# ---------------------------------------------------------------------------


def test_internal_zone_no_exit_within_window_stays_ambiguous() -> None:
    """Open inside zone, oscillates inside for 5+ min → ambiguous."""
    # Zone [100, 110]; price oscillates inside [102, 108] for entire session
    prices = [105.0, 103.0, 107.0, 104.0, 106.0] * 200  # 1000 prints, ~16 min
    trades = _make_trades(prices)
    zone = _zone("z-internal", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    o = outcomes[0]
    assert o.functional_role == "internal"
    assert o.final_outcome == "ambiguous"
    assert "started_inside_zone" in o.notes


def test_internal_zone_clean_exit_up_reclassifies_as_support() -> None:
    """Open inside, exits above cleanly within 5 min, doesn't return → support."""
    # First 2 min: inside zone [100,110]
    # Then exits to 130 (above) and stays
    prices = [105.0] * 120 + [130.0] * 700
    trades = _make_trades(prices)
    zone = _zone("z-carveout-up", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    o = outcomes[0]
    assert o.functional_role == "support"
    assert "internal_at_open_carveout" in o.notes
    # Since price never re-enters [100,110] after the exit, it's untouched
    assert o.final_outcome == "untouched"


def test_internal_zone_clean_exit_down_reclassifies_as_resistance() -> None:
    """Open inside, exits below cleanly → resistance."""
    prices = [105.0] * 120 + [80.0] * 700
    trades = _make_trades(prices)
    zone = _zone("z-carveout-down", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    o = outcomes[0]
    assert o.functional_role == "resistance"


def test_internal_zone_exit_up_then_return_stays_ambiguous() -> None:
    """Exit above + return into zone band within window → ambiguous."""
    # Exit above to 115, then return to 105 within the 5min window
    prices = [105.0] * 60 + [115.0] * 60 + [105.0] * 700
    trades = _make_trades(prices)
    zone = _zone("z-noisy-up", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    assert outcomes[0].final_outcome == "ambiguous"
    assert "started_inside_zone" in outcomes[0].notes


def test_internal_zone_exit_down_then_return_stays_ambiguous() -> None:
    """Exit below + return into zone band within window → ambiguous (symmetric).

    Regression guard for the carve-out's mirror branch: a buggy fix that only
    corrected exit-above would still mis-classify this as resistance.
    """
    # Exit below to 95, then return to 105 (back into the zone band) within window
    prices = [105.0] * 60 + [95.0] * 60 + [105.0] * 700
    trades = _make_trades(prices)
    zone = _zone("z-noisy-down", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    assert outcomes[0].functional_role == "internal"
    assert outcomes[0].final_outcome == "ambiguous"
    assert "started_inside_zone" in outcomes[0].notes


# ---------------------------------------------------------------------------
# Settlement window
# ---------------------------------------------------------------------------


def test_late_session_touch_no_break_is_ambiguous() -> None:
    """Touch in final 10 min with no break → ambiguous, not held."""
    # 700 prints: 690 above zone, then 1 touch, then 9 prints (~9 sec) — < 10 min
    prices = [120.0] * 690 + [105.0] + [120.0] * 9
    trades = _make_trades(prices)
    zone = _zone("z-late", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    o = outcomes[0]
    assert o.final_outcome == "ambiguous"
    assert "settlement_window_too_short" in o.notes


def test_late_session_touch_with_break_classifies_as_broken() -> None:
    """Even with short post-touch window, an immediate break still counts."""
    # 1 second after touch, price breaks below by 6pts (> 0.5×ATR=5)
    prices = [120.0] * 690 + [105.0, 90.0]
    trades = _make_trades(prices)
    zone = _zone("z-late-break", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    o = outcomes[0]
    assert o.final_outcome == "broken"
    assert o.broken is True


def test_settlement_window_configurable() -> None:
    """Shorter settlement window → previously-ambiguous now counts as held."""
    # 5 sec between touch and end — would be ambiguous at default 10 min
    prices = [120.0] * 690 + [105.0] + [120.0] * 5
    trades = _make_trades(prices)
    zone = _zone("z-cfg", top=110.0, bot=100.0)

    # Default settlement (10 min) → ambiguous
    out_default = classify_zones([zone], trades, MNQ, atr_14=10.0)
    assert out_default[0].final_outcome == "ambiguous"

    # Custom 1 sec settlement → held
    out_short = classify_zones(
        [zone], trades, MNQ, atr_14=10.0, settlement_window_minutes=0,
    )
    # Even at 0 min, the bounce path requires no break — let's verify
    assert out_short[0].final_outcome == "held"


# ---------------------------------------------------------------------------
# ATR resolution
# ---------------------------------------------------------------------------


def test_atr_none_recomputes_from_trades_when_possible() -> None:
    """envelope atr_14=None → loader recomputes from trades."""
    # Build a tape long enough to compute ATR(14) on 5m bars
    # 14 × 5 min = 70 min of data = 4200 sec at 1s spacing
    np.random.seed(42)
    prices_list = (120.0 + np.random.normal(0, 1, size=4500)).tolist()
    prices_list[2000] = 105.0  # one touch
    trades = _make_trades(prices_list)
    zone = _zone("z-atr-recompute", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=None)

    # Should not crash; should classify (with whatever ATR was recomputed)
    assert outcomes[0].touched is True


def test_atr_fallback_logged_when_unavailable(caplog: pytest.LogCaptureFixture) -> None:
    """No ATR + too few trades to recompute → contract-aware fallback."""
    # Only 5 trades — too short for 14-bar ATR
    prices = [120.0, 119.0, 105.0, 119.0, 120.0]
    trades = _make_trades(prices)
    zone = _zone("z-fallback", top=110.0, bot=100.0)

    import logging
    with caplog.at_level(logging.WARNING, logger="rithmic_analytics.zone_quality"):
        report = score_session([zone], trades, MNQ, atr_14=None)

    assert report.atr_fallback is True
    assert report.atr_used == MNQ.tick_size * 20.0  # 5.0 for MNQ
    assert any("falling back" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# Empty input + edge cases
# ---------------------------------------------------------------------------


def test_empty_zones_returns_empty_outcomes() -> None:
    trades = _make_trades([120.0] * 100)
    assert classify_zones([], trades, MNQ, atr_14=10.0) == []


def test_empty_trades_marks_all_zones_untouched() -> None:
    zone1 = _zone("z1", top=110.0, bot=100.0)
    zone2 = _zone("z2", top=210.0, bot=200.0, conviction="HIGH")
    empty = _make_trades([])  # zero-row DataFrame

    outcomes = classify_zones([zone1, zone2], empty, MNQ, atr_14=10.0)

    assert len(outcomes) == 2
    assert all(o.final_outcome == "untouched" for o in outcomes)
    assert all(o.notes == "empty_trades" for o in outcomes)


# ---------------------------------------------------------------------------
# Multi-touch / "broken trumps held" semantics
# ---------------------------------------------------------------------------


def test_multi_touch_broken_trumps_earlier_hold() -> None:
    """First touch bounces (held), second touch breaks → outcome=broken."""
    # Zone [100, 110]; price 120 → 105 (touch1) → 125 (bounce) → 105 (touch2) → 90 (broken)
    prices = (
        [120.0] * 60 + [105.0] + [120.0, 125.0] * 100
        + [105.0] + [90.0] * 100
    )
    trades = _make_trades(prices)
    zone = _zone("z-multi", top=110.0, bot=100.0)

    outcomes = classify_zones([zone], trades, MNQ, atr_14=10.0)

    assert outcomes[0].final_outcome == "broken"


# ---------------------------------------------------------------------------
# score_session
# ---------------------------------------------------------------------------


def test_score_session_extracts_session_id_from_trades() -> None:
    trades = _make_trades([120.0] * 700, session_id="mnq-2026-05-19-rth")
    zone = _zone("z1", top=110.0, bot=100.0)

    report = score_session([zone], trades, MNQ, atr_14=10.0)

    assert report.session_id == "mnq-2026-05-19-rth"
    assert report.trading_date == date(2026, 5, 19)


def test_score_session_renders_all_4_conviction_tiers_even_when_zero() -> None:
    """Empty rows for SUPER/HIGH/LOW when only MED zones present — Neel's req."""
    trades = _make_trades([120.0] * 700)
    zone = _zone("z-med", top=110.0, bot=100.0, conviction="MED")

    report = score_session([zone], trades, MNQ, atr_14=10.0)

    assert set(report.summary_by_conviction.keys()) == {"SUPER", "HIGH", "MED", "LOW"}
    assert report.summary_by_conviction["SUPER"].n_zones == 0
    assert report.summary_by_conviction["HIGH"].n_zones == 0
    assert report.summary_by_conviction["MED"].n_zones == 1
    assert report.summary_by_conviction["LOW"].n_zones == 0


def test_score_session_summary_by_role_includes_all_three_roles() -> None:
    trades = _make_trades([120.0] * 700)
    zone = _zone("z-med", top=110.0, bot=100.0)

    report = score_session([zone], trades, MNQ, atr_14=10.0)

    assert set(report.summary_by_role.keys()) >= {"support", "resistance", "internal"}


def test_score_session_hit_rate_none_when_under_5_trials() -> None:
    """N<5 outcomes → hit_rate=None per insufficient-data guard."""
    trades = _make_trades([120.0] * 60 + [105.0] + [120.0, 125.0] * 400)
    zones = [_zone(f"z{i}", top=110.0, bot=100.0) for i in range(3)]

    report = score_session(zones, trades, MNQ, atr_14=10.0)

    # 3 zones, all held → 3 trials, below 5-trial threshold
    assert report.summary_by_conviction["MED"].n_held == 3
    assert report.summary_by_conviction["MED"].hit_rate is None


def test_score_session_carries_pairing_in_metadata() -> None:
    trades = _make_trades([120.0] * 700)
    report = score_session([], trades, MNQ, pairing="globex-to-rth")
    assert report.pairing == "globex-to-rth"


# ---------------------------------------------------------------------------
# aggregate_history
# ---------------------------------------------------------------------------


def _quick_session(
    *, conviction: str, outcome: str, session_index: int,
    bounce: float | None = None, continuation: float | None = None,
) -> SessionQualityReport:
    """Build a minimal SessionQualityReport with one zone of given outcome."""
    held = outcome == "held"
    broken = outcome == "broken"
    final = outcome  # "held" / "broken" / "untouched" / "ambiguous"
    o = ZoneOutcome(
        zone_id=f"z-{session_index}", declared_type="support",
        functional_role="support", conviction=conviction,
        top=110.0, bot=100.0, touched=outcome != "untouched",
        first_touch_ts_ns=None, max_penetration_pts=None,
        held=held if outcome in ("held", "broken") else None,
        broken=broken if outcome in ("held", "broken") else None,
        first_break_ts_ns=None,
        bounce_distance_pts=bounce, continuation_distance_pts=continuation,
        final_outcome=final,  # type: ignore[arg-type]
    )
    return SessionQualityReport(
        session_id=f"sess-{session_index}",
        trading_date=date(2026, 5, 1 + session_index % 28),
        outcomes=[o],
        summary_by_conviction={},
        summary_by_role={},
        atr_used=10.0, atr_fallback=False, pairing="next-day",
        reference_price=120.0, settlement_window_minutes=10,
    )


def test_aggregate_history_empty_returns_full_uncertainty() -> None:
    history = aggregate_history([])
    assert history.sessions_analyzed == 0
    for tier in ("SUPER", "HIGH", "MED", "LOW"):
        est = history.hit_rate_by_conviction[tier]
        assert est.n_trials == 0
        assert est.rate is None
        assert est.insufficient_data is True
        assert (est.ci_low, est.ci_high) == (0.0, 1.0)
    assert set(history.insufficient_data_tiers) == {"SUPER", "HIGH", "MED", "LOW"}


def test_aggregate_history_rolls_30_session_window() -> None:
    """Older-than-window reports are excluded from aggregation."""
    # 35 reports — only the last 30 should count
    reports = [
        _quick_session(conviction="MED", outcome="held" if i < 5 else "broken",
                       session_index=i)
        for i in range(35)
    ]
    # First 5 are "held", remaining 30 are "broken". Window=30 sees the last 30,
    # so should be 0 held, 30 broken.
    history = aggregate_history(reports, window_sessions=30)

    est = history.hit_rate_by_conviction["MED"]
    assert est.n_trials == 30
    assert est.n_success == 0  # the 5 held are outside the window
    assert est.rate == 0.0


def test_aggregate_history_wilson_ci_bounded() -> None:
    """Estimate CI bounds are within [0, 1]."""
    reports = [
        _quick_session(conviction="SUPER", outcome="held", session_index=i)
        for i in range(10)
    ]
    history = aggregate_history(reports)

    est = history.hit_rate_by_conviction["SUPER"]
    assert est.n_trials == 10
    assert est.n_success == 10
    assert est.rate == 1.0
    assert 0.0 <= est.ci_low <= 1.0
    assert 0.0 <= est.ci_high <= 1.0
    assert est.ci_low > 0.7  # 10/10 → lower bound well above 0.5


def test_aggregate_history_insufficient_data_flag_when_n_lt_5() -> None:
    reports = [
        _quick_session(conviction="HIGH", outcome="held", session_index=i)
        for i in range(3)
    ]
    history = aggregate_history(reports)

    est = history.hit_rate_by_conviction["HIGH"]
    assert est.n_trials == 3
    assert est.rate is None
    assert est.insufficient_data is True
    assert "HIGH" in history.insufficient_data_tiers
    # SUPER/MED/LOW also insufficient
    assert "SUPER" in history.insufficient_data_tiers


def test_aggregate_history_rejects_mixed_pairings() -> None:
    r1 = _quick_session(conviction="MED", outcome="held", session_index=0)
    r2 = _quick_session(conviction="MED", outcome="held", session_index=1)
    # Force r2 to a different pairing
    import dataclasses
    r2 = dataclasses.replace(r2, pairing="same-day")

    with pytest.raises(ValueError, match="mixed pairings"):
        aggregate_history([r1, r2])


def test_aggregate_history_avg_bounce_per_conviction() -> None:
    reports = [
        _quick_session(conviction="MED", outcome="held",
                       session_index=i, bounce=10.0 * (i + 1))
        for i in range(5)
    ]
    history = aggregate_history(reports)

    # Average of 10, 20, 30, 40, 50 = 30.0
    assert history.avg_bounce_distance_by_conviction["MED"] == pytest.approx(30.0)
    # SUPER had no zones → None
    assert history.avg_bounce_distance_by_conviction["SUPER"] is None


def test_aggregate_history_avg_continuation_per_conviction() -> None:
    reports = [
        _quick_session(conviction="LOW", outcome="broken",
                       session_index=i, continuation=5.0 + i)
        for i in range(5)
    ]
    history = aggregate_history(reports)

    # Average of 5, 6, 7, 8, 9 = 7.0
    assert history.avg_continuation_distance_by_conviction["LOW"] == pytest.approx(7.0)


def test_aggregate_history_carries_pairing_through() -> None:
    reports = [
        _quick_session(conviction="MED", outcome="held", session_index=i)
        for i in range(3)
    ]
    history = aggregate_history(reports)
    assert history.pairing == "next-day"


# ---------------------------------------------------------------------------
# Dataclass invariants
# ---------------------------------------------------------------------------


def test_zone_outcome_is_frozen() -> None:
    import dataclasses
    o = ZoneOutcome(
        zone_id="z1", declared_type="support", functional_role="support",
        conviction="MED", top=110.0, bot=100.0, touched=False,
        first_touch_ts_ns=None, max_penetration_pts=None,
        held=None, broken=None, first_break_ts_ns=None,
        bounce_distance_pts=None, continuation_distance_pts=None,
        final_outcome="untouched",
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        o.touched = True  # type: ignore[misc]


def test_zone_outcome_to_dict_is_json_safe() -> None:
    import json
    o = ZoneOutcome(
        zone_id="z1", declared_type="support", functional_role="resistance",
        conviction="MED", top=110.0, bot=100.0, touched=True,
        first_touch_ts_ns=1234, max_penetration_pts=5.0,
        held=True, broken=False, first_break_ts_ns=None,
        bounce_distance_pts=10.0, continuation_distance_pts=None,
        final_outcome="held", notes="",
    )
    serialised = json.dumps(o.to_dict())
    assert "held" in serialised


def test_session_quality_report_to_dict_serialises() -> None:
    import json
    trades = _make_trades([120.0] * 700)
    report = score_session([_zone("z1", top=110.0, bot=100.0)], trades, MNQ,
                           atr_14=10.0)
    s = json.dumps(report.to_dict(), default=str)
    assert "MED" in s
    assert "trading_date" in s


def test_history_report_to_dict_serialises() -> None:
    import json
    reports = [
        _quick_session(conviction="MED", outcome="held", session_index=i)
        for i in range(7)
    ]
    history = aggregate_history(reports)
    s = json.dumps(history.to_dict())
    assert "hit_rate_by_conviction" in s
    assert "insufficient_data_tiers" in s


def test_binomial_estimate_is_frozen() -> None:
    import dataclasses
    be = BinomialEstimate(
        n_trials=5, n_success=4, rate=0.8, ci_low=0.4, ci_high=0.99,
        insufficient_data=False,
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        be.rate = 0.5  # type: ignore[misc]


def test_conviction_summary_to_dict() -> None:
    cs = ConvictionSummary(
        conviction="MED", n_zones=10, n_touched=8, n_held=5,
        n_broken=2, n_ambiguous=1, n_untouched=2, hit_rate=5 / 7,
    )
    d = cs.to_dict()
    assert d["hit_rate"] == 5 / 7
    assert d["n_zones"] == 10


def test_history_report_is_frozen() -> None:
    import dataclasses
    h = HistoryReport(
        sessions_analyzed=0, window_sessions=30, pairing="next-day",
        hit_rate_by_conviction={}, avg_bounce_distance_by_conviction={},
        avg_continuation_distance_by_conviction={},
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        h.sessions_analyzed = 1  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Multiple convictions in one session
# ---------------------------------------------------------------------------


def test_multiple_conviction_tiers_in_one_session() -> None:
    """SUPER + HIGH + MED + LOW zones in one session, mixed outcomes."""
    prices = [120.0] * 60 + [105.0] + [120.0] * 700  # held
    trades = _make_trades(prices)
    zones = [
        _zone("z-super", top=110.0, bot=100.0, conviction="SUPER"),
        _zone("z-high", top=110.0, bot=100.0, conviction="HIGH"),
        _zone("z-med", top=110.0, bot=100.0, conviction="MED"),
        _zone("z-low", top=110.0, bot=100.0, conviction="LOW"),
    ]

    report = score_session(zones, trades, MNQ, atr_14=10.0)

    for tier in ("SUPER", "HIGH", "MED", "LOW"):
        assert report.summary_by_conviction[tier].n_zones == 1
        assert report.summary_by_conviction[tier].n_held == 1
