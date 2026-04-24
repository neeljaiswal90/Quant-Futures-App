"""
DATA-12 rebuild (v3.2.1 §5.2) — L2 authoritative-book FSM tests.

Covers the five reconvergence rules and the kickoff-tightening
invariants:

  Rule 1: post-reset population of BOTH sides from post-reset updates
  Rule 2: top-of-book validity (no cross/invert/one-sided)
  Rule 3: ≥ min_post_reset_updates gap-free updates since reset
  Rule 4: quiet period elapsed since last reset/gap/error
  Rule 5: top-of-book age within freshness budget

  Kickoff §2 — L2_AUTHORITY_FSM_ENABLED=false is debug/test only:
    * default True
    * explicit false disables → quote_authoritative forced True
    * acceptance-mode envs combined with disabled FSM raise loudly
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lob_features.l2_authority_fsm import (  # noqa: E402
    DEFAULT_FRESHNESS_BUDGET_MS,
    DEFAULT_MIN_POST_RESET_UPDATES,
    DEFAULT_QUIET_MS,
    L2AuthorityConfig,
    L2AuthorityConfigError,
    L2AuthorityFSM,
    L2AuthorityRegistry,
    acceptance_mode_active_in_env,
    assert_acceptance_compatible_config,
    l2_authority_fsm_enabled_from_env,
)
from lob_features.mbp10_book_state import ApplyResult  # noqa: E402


def _snap(best_bid=None, best_ask=None, best_bid_qty=None, best_ask_qty=None):
    return SimpleNamespace(
        best_bid=lambda: best_bid,
        best_ask=lambda: best_ask,
        best_bid_qty=lambda: best_bid_qty,
        best_ask_qty=lambda: best_ask_qty,
    )


def _apply(action="A", cleared=False, applied=True,
           levels_present=True, top=True, ts_recv_ns=None):
    return ApplyResult(
        applied=applied, action=action, cleared=cleared,
        levels_present=levels_present, top_of_book_populated=top,
        ts_recv_ns=ts_recv_ns,
    )


def _fast_config(**overrides):
    """Short-circuited thresholds so tests can reach 'ready' quickly.
    min_post_reset_updates=3 means three applies is enough to satisfy
    rule 3; quiet_ms=10 keeps the quiet-period gate out of the way
    for rule-1/2/3-focused tests; freshness_budget_ms=10_000 keeps
    rule 5 permissive."""
    cfg = L2AuthorityConfig(
        min_post_reset_updates=3, quiet_ms=10,
        freshness_budget_ms=10_000,
    )
    for k, v in overrides.items():
        setattr(cfg, k, v)
    return cfg


# ─── Rule 1: post-reset population ─────────────────────────────────

class TestPostResetPopulationRule:
    def test_fresh_fsm_is_not_authoritative(self):
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=True)
        assert fsm.state.quote_authoritative is False
        assert fsm.state.warmup_state == "reconverging"
        assert fsm.state.not_authoritative_reason == "startup_or_reconnect"

    def test_bid_alone_does_not_satisfy_rule_1(self):
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=True)
        # A single one-sided update — bid populated, ask still None.
        fsm.on_apply_result(
            _apply(), _snap(best_bid=100), now_ns=0,
        )
        assert fsm.state.bid_populated_post_reset is True
        assert fsm.state.ask_populated_post_reset is False
        assert fsm.state.quote_authoritative is False
        assert fsm.state.not_authoritative_reason == "post_reset_population_incomplete"

    def test_both_sides_populated_advances_past_rule_1(self):
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=True)
        fsm.on_apply_result(
            _apply(), _snap(best_bid=100, best_ask=101),
            now_ns=1_000_000,  # 1 ms past reset (quiet_ms=10 means we
                               # still need quiet period to elapse)
        )
        # Rule 1 satisfied; rule 3 still not — only one apply.
        assert fsm.state.bid_populated_post_reset is True
        assert fsm.state.ask_populated_post_reset is True
        assert fsm.state.not_authoritative_reason == "post_reset_sequence_short"

    def test_pre_reset_state_does_not_satisfy_rule_1_after_reset(self):
        """Kickoff §2 invariant: carried-over state can't satisfy
        populated-ness after a reset. Populate both sides; reset;
        populated flags must flip to False even though the book
        snapshot still carries the old values."""
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=True)
        # Reach ready.
        for i in range(5):
            fsm.on_apply_result(
                _apply(ts_recv_ns=(i + 1) * 20_000_000),
                _snap(best_bid=100, best_ask=101),
                now_ns=(i + 1) * 20_000_000,
            )
        assert fsm.state.quote_authoritative is True
        # Reset — the FSM must NOT treat the snapshot's lingering
        # best_bid/ask as post-reset population.
        fsm.on_reset(now_ns=200_000_000)
        assert fsm.state.bid_populated_post_reset is False
        assert fsm.state.ask_populated_post_reset is False
        assert fsm.state.quote_authoritative is False


# ─── Rule 2: top-of-book validity ──────────────────────────────────

class TestTopOfBookValidityRule:
    def _prime(self, fsm, base_ns=0):
        # Satisfy rules 1, 3, 4, 5 so rule 2 is the only gating check.
        for i in range(5):
            fsm.on_apply_result(
                _apply(ts_recv_ns=base_ns + (i + 1) * 20_000_000),
                _snap(best_bid=100, best_ask=101),
                now_ns=base_ns + (i + 1) * 20_000_000,
            )

    def test_crossed_book_blocks_authority(self):
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=True)
        self._prime(fsm)
        assert fsm.state.quote_authoritative is True
        # Crossed book on next update.
        fsm.on_apply_result(
            _apply(ts_recv_ns=200_000_000),
            _snap(best_bid=102, best_ask=101),
            now_ns=200_000_000,
        )
        assert fsm.state.quote_authoritative is False
        assert fsm.state.not_authoritative_reason == "crossed_or_inverted"

    def test_equal_bid_ask_blocks_authority(self):
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=True)
        self._prime(fsm)
        fsm.on_apply_result(
            _apply(ts_recv_ns=200_000_000),
            _snap(best_bid=101, best_ask=101),
            now_ns=200_000_000,
        )
        assert fsm.state.quote_authoritative is False

    def test_one_sided_snapshot_blocks_authority(self):
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=True)
        self._prime(fsm)
        fsm.on_apply_result(
            _apply(ts_recv_ns=200_000_000),
            _snap(best_bid=100, best_ask=None),
            now_ns=200_000_000,
        )
        # The snapshot is one-sided, so the instant recompute hits
        # rule 2's one_sided_book branch. (Rule 1's flags stay True
        # because an earlier apply carried both sides.)
        assert fsm.state.quote_authoritative is False
        assert fsm.state.not_authoritative_reason == "one_sided_book"


# ─── Rule 3: gap-free post-reset sequence ──────────────────────────

class TestGapFreeSequenceRule:
    def test_below_min_updates_blocks_authority(self):
        cfg = L2AuthorityConfig(
            min_post_reset_updates=5, quiet_ms=10,
            freshness_budget_ms=10_000,
        )
        fsm = L2AuthorityFSM(config=cfg, enabled=True)
        for i in range(4):  # one short of 5
            fsm.on_apply_result(
                _apply(ts_recv_ns=(i + 1) * 20_000_000),
                _snap(best_bid=100, best_ask=101),
                now_ns=(i + 1) * 20_000_000,
            )
        assert fsm.state.reconvergence_updates_without_gap == 4
        assert fsm.state.quote_authoritative is False
        assert fsm.state.not_authoritative_reason == "post_reset_sequence_short"

    def test_min_updates_reached_advances_past_rule_3(self):
        cfg = L2AuthorityConfig(
            min_post_reset_updates=5, quiet_ms=10,
            freshness_budget_ms=10_000,
        )
        fsm = L2AuthorityFSM(config=cfg, enabled=True)
        for i in range(5):
            fsm.on_apply_result(
                _apply(ts_recv_ns=(i + 1) * 20_000_000),
                _snap(best_bid=100, best_ask=101),
                now_ns=(i + 1) * 20_000_000,
            )
        assert fsm.state.reconvergence_updates_without_gap == 5
        assert fsm.state.quote_authoritative is True

    def test_gap_event_resets_sequence_counter(self):
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=True)
        for i in range(5):
            fsm.on_apply_result(
                _apply(ts_recv_ns=(i + 1) * 20_000_000),
                _snap(best_bid=100, best_ask=101),
                now_ns=(i + 1) * 20_000_000,
            )
        assert fsm.state.quote_authoritative is True
        fsm.on_gap_detected(now_ns=200_000_000)
        assert fsm.state.quote_authoritative is False
        assert fsm.state.reconvergence_updates_without_gap == 0
        assert fsm.state.gap_detected is True
        assert fsm.state.last_gap_ts_ms == 200

    def test_unknown_action_does_not_advance_sequence_counter(self):
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=True)
        for i in range(2):
            fsm.on_apply_result(
                _apply(ts_recv_ns=(i + 1) * 20_000_000),
                _snap(best_bid=100, best_ask=101),
                now_ns=(i + 1) * 20_000_000,
            )
        assert fsm.state.reconvergence_updates_without_gap == 2
        fsm.on_apply_result(
            _apply(applied=False, action="Z",
                   ts_recv_ns=100_000_000),
            _snap(best_bid=100, best_ask=101),
            now_ns=100_000_000,
        )
        # Counter unchanged by unknown action.
        assert fsm.state.reconvergence_updates_without_gap == 2


# ─── Rule 4: quiet period ──────────────────────────────────────────

class TestQuietPeriodRule:
    def test_reset_within_quiet_ms_blocks_authority(self):
        cfg = L2AuthorityConfig(
            min_post_reset_updates=3, quiet_ms=5000,
            freshness_budget_ms=10_000,
        )
        fsm = L2AuthorityFSM(config=cfg, enabled=True)
        # Establish a timestamped reset boundary at t=0 ms so rule 4
        # has an anchor. Even with rules 1/2/3/5 satisfied, rule 4
        # must block until quiet_ms elapses.
        fsm.on_reset(now_ns=0)
        for i in range(5):
            ns = (i + 1) * 100_000_000  # 100..500 ms
            fsm.on_apply_result(
                _apply(ts_recv_ns=ns),
                _snap(best_bid=100, best_ask=101), now_ns=ns,
            )
        assert fsm.state.quote_authoritative is False
        assert "quiet_period" in (fsm.state.not_authoritative_reason or "")

    def test_quiet_period_elapsed_allows_authority(self):
        cfg = L2AuthorityConfig(
            min_post_reset_updates=3, quiet_ms=500,
            freshness_budget_ms=10_000,
        )
        fsm = L2AuthorityFSM(config=cfg, enabled=True)
        fsm.on_reset(now_ns=0)
        # 600 ms past the reset epoch — quiet period elapsed.
        for i in range(5):
            ns = (i + 1) * 150_000_000  # 150..750 ms
            fsm.on_apply_result(
                _apply(ts_recv_ns=ns),
                _snap(best_bid=100, best_ask=101), now_ns=ns,
            )
        assert fsm.state.quote_authoritative is True

    def test_provider_error_restarts_quiet_window(self):
        cfg = L2AuthorityConfig(
            min_post_reset_updates=3, quiet_ms=500,
            freshness_budget_ms=10_000,
        )
        fsm = L2AuthorityFSM(config=cfg, enabled=True)
        fsm.on_reset(now_ns=0)
        for i in range(5):
            ns = (i + 1) * 150_000_000
            fsm.on_apply_result(
                _apply(ts_recv_ns=ns),
                _snap(best_bid=100, best_ask=101), now_ns=ns,
            )
        assert fsm.state.quote_authoritative is True
        fsm.on_provider_error(now_ns=800_000_000)
        assert fsm.state.quote_authoritative is False
        # Next applied event within quiet window → still blocked.
        fsm.on_apply_result(
            _apply(ts_recv_ns=900_000_000),
            _snap(best_bid=100, best_ask=101), now_ns=900_000_000,
        )
        assert fsm.state.quote_authoritative is False


# ─── Rule 5: ordinary freshness ────────────────────────────────────

class TestFreshnessRule:
    def test_stale_top_of_book_blocks_authority(self):
        cfg = L2AuthorityConfig(
            min_post_reset_updates=3, quiet_ms=10,
            freshness_budget_ms=100,
        )
        fsm = L2AuthorityFSM(config=cfg, enabled=True)
        # Reach ready.
        for i in range(5):
            ns = (i + 1) * 20_000_000
            fsm.on_apply_result(
                _apply(ts_recv_ns=ns),
                _snap(best_bid=100, best_ask=101), now_ns=ns,
            )
        assert fsm.state.quote_authoritative is True
        # Simulate a new "tick" now_ns 500 ms past the last update
        # with no new post-reset update — age > budget blocks authority.
        # We drive a no-op "unknown-action" apply just to trigger recompute.
        fsm.on_apply_result(
            _apply(applied=False, action="Z", ts_recv_ns=600_000_000),
            _snap(best_bid=100, best_ask=101), now_ns=600_000_000,
        )
        assert fsm.state.quote_authoritative is False
        assert fsm.state.not_authoritative_reason == "stale_top_of_book"


# ─── Defaults + serialization ─────────────────────────────────────

class TestDefaultsAndSerialization:
    def test_module_constants_match_v3_2_1(self):
        """v3.2.1 §5.2 defaults are load-bearing — if someone lowers
        min_post_reset_updates below 25 without a ticket + review, a
        paper-day run could restore authority after too few
        post-reset updates. Guard the defaults."""
        assert DEFAULT_MIN_POST_RESET_UPDATES == 25
        assert DEFAULT_QUIET_MS == 2000
        # Freshness budget is not specified verbatim by v3.2.1 §5.2
        # but a non-zero budget is required.
        assert DEFAULT_FRESHNESS_BUDGET_MS > 0

    def test_to_health_dict_exposes_required_fields(self):
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=True)
        d = fsm.to_health_dict()
        for k in (
            "snapshot_synced", "quote_authoritative", "warmup_state",
            "gap_detected", "reset_count", "reconvergence_epoch_ts_ms",
            "reconvergence_updates_without_gap", "last_gap_ts_ms",
            "last_provider_error_ts_ms", "last_bid_update_ts_ms",
            "last_ask_update_ts_ms", "last_good_quote_ts_ms",
            "not_authoritative_reason", "fsm_enabled",
        ):
            assert k in d, f"missing health field: {k}"


# ─── L2_AUTHORITY_FSM_ENABLED debug hatch ─────────────────────────

class TestDebugHatch:
    def test_default_env_is_enabled(self, monkeypatch):
        monkeypatch.delenv("L2_AUTHORITY_FSM_ENABLED", raising=False)
        assert l2_authority_fsm_enabled_from_env() is True

    def test_false_values_disable_fsm(self, monkeypatch):
        for v in ("false", "FALSE", "0", "no", "off"):
            monkeypatch.setenv("L2_AUTHORITY_FSM_ENABLED", v)
            assert l2_authority_fsm_enabled_from_env() is False

    def test_disabled_fsm_forces_authoritative_true(self):
        fsm = L2AuthorityFSM(config=_fast_config(), enabled=False)
        assert fsm.state.quote_authoritative is True
        assert fsm.state.snapshot_synced is True
        assert fsm.state.warmup_state == "ready"
        # Events must not change the state — FSM is bypassed.
        fsm.on_reset(now_ns=1)
        assert fsm.state.quote_authoritative is True
        fsm.on_gap_detected(now_ns=2)
        assert fsm.state.quote_authoritative is True


# ─── Acceptance-gate invariant (kickoff tightening §2) ─────────────

class TestAcceptanceGate:
    def test_no_acceptance_env_and_disabled_fsm_is_allowed(self):
        # Purely debugging: no acceptance env, FSM off — OK.
        assert_acceptance_compatible_config(
            fsm_enabled=False, acceptance_envs=[],
        )

    def test_acceptance_env_with_fsm_enabled_is_allowed(self):
        assert_acceptance_compatible_config(
            fsm_enabled=True,
            acceptance_envs=["PHASE2_ACCEPTANCE"],
        )

    def test_acceptance_env_with_disabled_fsm_raises(self):
        with pytest.raises(L2AuthorityConfigError, match="incompatible"):
            assert_acceptance_compatible_config(
                fsm_enabled=False,
                acceptance_envs=["PHASE2_ACCEPTANCE"],
            )

    def test_acceptance_mode_active_in_env_detects_truthy(self, monkeypatch):
        for truthy in ("1", "true", "YES", "on"):
            monkeypatch.setenv("DATA17_ACCEPTANCE_RUN", truthy)
            assert "DATA17_ACCEPTANCE_RUN" in acceptance_mode_active_in_env()
        monkeypatch.setenv("DATA17_ACCEPTANCE_RUN", "false")
        assert "DATA17_ACCEPTANCE_RUN" not in acceptance_mode_active_in_env()

    def test_all_three_acceptance_envs_are_tracked(self, monkeypatch):
        monkeypatch.delenv("DATA17_ACCEPTANCE_RUN", raising=False)
        monkeypatch.delenv("PHASE2_ACCEPTANCE", raising=False)
        monkeypatch.delenv("MEAS03_POST_RUN", raising=False)
        monkeypatch.setenv("DATA17_ACCEPTANCE_RUN", "1")
        monkeypatch.setenv("PHASE2_ACCEPTANCE", "yes")
        monkeypatch.setenv("MEAS03_POST_RUN", "true")
        envs = acceptance_mode_active_in_env()
        assert set(envs) == {
            "DATA17_ACCEPTANCE_RUN",
            "PHASE2_ACCEPTANCE",
            "MEAS03_POST_RUN",
        }


# ─── Registry ──────────────────────────────────────────────────────

class TestRegistry:
    def test_per_instrument_isolation(self):
        reg = L2AuthorityRegistry()
        a = reg.get_or_create(1)
        b = reg.get_or_create(2)
        assert a is not b
        # Each starts in reconverging state.
        assert a.state.warmup_state == "reconverging"
        assert b.state.warmup_state == "reconverging"

    def test_clear_all_drops_instruments(self):
        reg = L2AuthorityRegistry()
        reg.get_or_create(1)
        reg.get_or_create(2)
        reg.clear_all()
        assert reg.get(1) is None
        assert reg.get(2) is None
