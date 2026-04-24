"""
l2_authority_fsm.py — authoritative-book state machine.

DATA-12 history:
  - v3.2.1 §5.2 original build: FSM fed by Databento L2 (MBP-10) path.
  - V1 live input is Rithmic BBO/depth, with Databento retained for
    historical replay and research.

Publishes quote_authoritative only when ALL five reconvergence rules
are simultaneously satisfied:

  1. Post-reset population rule
     Best bid AND best ask are populated from updates whose event
     timestamps are strictly AFTER reconvergence_epoch_ts_ms.
     Pre-reset carry-over state must NOT satisfy this rule — this is
     the kickoff tightening §2 invariant: "populated from updates
     received after the most recent reset/gap boundary", not merely
     "populated".

  2. Top-of-book validity rule
     best_bid < best_ask; top-of-book is neither crossed nor inverted.

  3. Gap-free post-reset sequence rule
     At least `l2_reconvergence_min_updates` consecutive A/M/C/T
     updates have been processed since the reconvergence boundary,
     with no sequence-gap jump. Default: 25.

  4. Quiet-period rule
     No provider parse/reset/error has occurred in the last
     `l2_reconvergence_quiet_ms` milliseconds. Default: 2000 ms.

  5. Ordinary freshness rule
     Top-of-book age is within the configured freshness budget.

These five rules are EXHAUSTIVE and AUTHORITATIVE. There is no
separate hidden predicate.

On any of:
  - startup / reconnect
  - provider reset (R action)
  - record-gap detection
  - provider parse / error

… the FSM flips:
  - snapshot_synced → false
  - quote_authoritative → false
  - reconvergence_epoch_ts_ms → reset boundary
  - carried-over pre-reset state is non-authoritative by policy

Hard-risk rule (v3.2.1 §1.2): consumers treating
quote_authoritative=false MUST fail-closed for new entries.
Enforcement is at the consumer boundary (RISK-10A + TS hard-risk
lane); this module publishes the state but does not itself block
trades.

L2_AUTHORITY_FSM_ENABLED=false (debug/test only)
  Setting this env var disables the FSM — quote_authoritative is
  forced to True at all times. This is a debug hatch ONLY. Any
  acceptance-flag env (DATA17_ACCEPTANCE_RUN, PHASE2_ACCEPTANCE,
  MEAS03_POST_RUN) combined with the disabled FSM MUST raise at
  startup via `assert_acceptance_compatible_config()`. The kickoff
  tightening §2 policy is: "someone under schedule pressure will
  disable the FSM to 'unblock' later tickets" — the assertion is
  the CI gate preventing exactly that.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Optional

try:  # optional import — caller may already hold an ApplyResult.
    from .mbp10_book_state import ApplyResult
except ImportError:  # pragma: no cover — defensive for standalone use
    ApplyResult = None  # type: ignore[assignment]


DEFAULT_MIN_POST_RESET_UPDATES = 25
DEFAULT_QUIET_MS = 2000
DEFAULT_FRESHNESS_BUDGET_MS = 500
_NS_PER_MS = 1_000_000

# Sentinel key for the live FSM in the L2AuthorityRegistry. The live
# stream may not pin a numeric instrument_id the way Databento does,
# so a single sentinel key suffices. Negative so it cannot collide with
# any real Databento
# instrument_id (Databento uses unsigned 32-bit ids).
RITHMIC_LIVE_INSTRUMENT_ID = -1


@dataclass(frozen=True)
class LiveBboObservation:
    """Live BBO observation shape adapted to the FSM's apply contract.

    The FSM was originally written for MBP-10 ApplyResult + snapshot
    pairs; this struct lets a live feed adapter use the FSM without
    reconstructing the MBP-10 shape. Exposes the same four accessors
    the FSM's _recompute_authority reads.
    """
    bid: Optional[float]
    ask: Optional[float]
    bid_qty: Optional[float]
    ask_qty: Optional[float]

    def best_bid(self) -> Optional[float]:
        return self.bid

    def best_ask(self) -> Optional[float]:
        return self.ask

    def best_bid_qty(self) -> Optional[float]:
        return self.bid_qty

    def best_ask_qty(self) -> Optional[float]:
        return self.ask_qty


@dataclass(frozen=True)
class LiveBboApplyResult:
    """ApplyResult-shaped struct for live BBO updates.

    The FSM's on_apply_result() branch expects .applied / .cleared /
    .ts_recv_ns on the result argument. Building one of these per BBO
    event keeps the FSM contract identical across providers without
    leaking MBP-10 semantics into the live feed adapter.
    """
    applied: bool = True
    cleared: bool = False
    ts_recv_ns: Optional[int] = None
    # Parity with mbp10_book_state.ApplyResult shape so downstream
    # consumers inspecting the struct see the same fields.
    action: Optional[str] = "bbo"
    levels_present: bool = True
    top_of_book_populated: bool = True


class L2AuthorityConfigError(RuntimeError):
    """Raised when the startup env config is incompatible with the
    declared acceptance mode. Fail-closed by design."""


@dataclass
class L2AuthorityConfig:
    """Tunable thresholds for the reconvergence rules.

    Defaults match v3.2.1 §5.2:
      - min_post_reset_updates = 25  (rule 3)
      - quiet_ms = 2000              (rule 4)
      - freshness_budget_ms = 500    (rule 5)
    All are config-driven so a paper-day or shadow-cutover run can
    tune them without a code change; the DATA-17 regime-conditioned
    parity harness (next slice) writes the chosen values into its
    self-describing output.
    """
    min_post_reset_updates: int = DEFAULT_MIN_POST_RESET_UPDATES
    quiet_ms: int = DEFAULT_QUIET_MS
    freshness_budget_ms: int = DEFAULT_FRESHNESS_BUDGET_MS


# ─── Acceptance-gate invariant (kickoff tightening §2) ─────────────

_ACCEPTANCE_ENV_NAMES = (
    "DATA17_ACCEPTANCE_RUN",
    "PHASE2_ACCEPTANCE",
    "MEAS03_POST_RUN",
)


def _is_truthy(v: Optional[str]) -> bool:
    if v is None:
        return False
    return v.strip().lower() in ("1", "true", "yes", "on")


def l2_authority_fsm_enabled_from_env() -> bool:
    """L2_AUTHORITY_FSM_ENABLED env → bool. Default True. Only a
    deliberate "false"/"0" disables the FSM."""
    raw = os.environ.get("L2_AUTHORITY_FSM_ENABLED")
    if raw is None or not raw.strip():
        return True
    return raw.strip().lower() not in ("false", "0", "no", "off")


def acceptance_mode_active_in_env() -> list[str]:
    """Return the list of acceptance-mode env vars currently set
    truthy. Empty list means no acceptance run is declared."""
    return [
        name for name in _ACCEPTANCE_ENV_NAMES
        if _is_truthy(os.environ.get(name))
    ]


def assert_acceptance_compatible_config(
    *,
    fsm_enabled: Optional[bool] = None,
    acceptance_envs: Optional[list[str]] = None,
) -> None:
    """CI gate per kickoff tightening §2.

    If any acceptance-mode env is truthy AND the FSM is disabled via
    L2_AUTHORITY_FSM_ENABLED=false, raise L2AuthorityConfigError.
    Ship the raise LOUD — disabling the authoritative-book FSM under
    an acceptance run would silently produce acceptance evidence
    built on a path where quote_authoritative is always True, which
    is exactly what the kickoff note warned against.

    Callable at startup and from tests; both inputs can be injected
    to exercise the gate without mutating the ambient environment.
    """
    enabled = (
        l2_authority_fsm_enabled_from_env()
        if fsm_enabled is None else fsm_enabled
    )
    envs = (
        acceptance_mode_active_in_env()
        if acceptance_envs is None else acceptance_envs
    )
    if envs and not enabled:
        raise L2AuthorityConfigError(
            "L2_AUTHORITY_FSM_ENABLED=false is incompatible with "
            f"acceptance-mode envs {envs}. The FSM is debug/test only — "
            "acceptance evidence must be produced with the FSM active, "
            "per v3.2.1 kickoff tightening §2."
        )


# ─── FSM state ─────────────────────────────────────────────────────


@dataclass
class L2AuthorityState:
    """Publicly-observable state. One instance per instrument_id.

    These are the fields v3.2.1 §5.2 requires on /lob/health; the
    FSM writes them directly. Downstream consumers (TS hard-risk,
    /lob/bbo publication gating) read `quote_authoritative` and
    `snapshot_synced` — the rest is diagnostic.
    """
    snapshot_synced: bool = False
    quote_authoritative: bool = False
    warmup_state: str = "cold"  # "cold" | "reconverging" | "ready"
    # Reset tracking
    reconvergence_epoch_ts_ms: Optional[int] = None
    reset_count: int = 0
    gap_detected: bool = False
    last_gap_ts_ms: Optional[int] = None
    last_provider_error_ts_ms: Optional[int] = None
    # Post-reset population tracking (rule 1)
    last_bid_update_ts_ms: Optional[int] = None
    last_ask_update_ts_ms: Optional[int] = None
    bid_populated_post_reset: bool = False
    ask_populated_post_reset: bool = False
    # Sequence/gap-free tracking (rule 3)
    reconvergence_updates_without_gap: int = 0
    # Ordinary freshness (rule 5)
    last_good_quote_ts_ms: Optional[int] = None
    # Reason the book is currently not authoritative, for observability.
    not_authoritative_reason: Optional[str] = "cold_startup"


class L2AuthorityFSM:
    """Per-instrument authoritative-book FSM.

    Usage:
      fsm = L2AuthorityFSM()
      # On each MBP-10 ApplyResult + current top-of-book snapshot:
      fsm.on_apply_result(result, snapshot, now_ns=...)
      # On reset/gap/error events:
      fsm.on_reset(now_ns=...)
      fsm.on_gap_detected(now_ns=...)
      fsm.on_provider_error(now_ns=...)
      # Optional explicit startup boundary (equivalent to on_reset):
      fsm.on_startup_or_reconnect(now_ns=...)

    Authority is re-evaluated on every call; callers read
    fsm.state.quote_authoritative to gate hard-risk consumers.

    Debug hatch:
      L2AuthorityFSM(enabled=False) forces quote_authoritative to
      True and warmup_state to "ready" regardless of inputs. Only
      use under debugging; the startup assertion
      (assert_acceptance_compatible_config) guarantees this mode
      cannot be combined with an acceptance run.
    """

    def __init__(
        self,
        *,
        config: Optional[L2AuthorityConfig] = None,
        enabled: Optional[bool] = None,
    ) -> None:
        self._config = config or L2AuthorityConfig()
        self._enabled = (
            l2_authority_fsm_enabled_from_env()
            if enabled is None else enabled
        )
        self._state = L2AuthorityState()
        if not self._enabled:
            # Debug override — the state machine is bypassed entirely.
            self._state.quote_authoritative = True
            self._state.snapshot_synced = True
            self._state.warmup_state = "ready"
            self._state.not_authoritative_reason = None
        else:
            # A freshly-constructed FSM is semantically at the startup
            # boundary — snapshot_synced=False, quote_authoritative=False,
            # warmup_state="reconverging". Callers that want a
            # timestamped reset boundary must call on_startup_or_reconnect
            # / on_reset explicitly; passing now_ns=None here keeps the
            # epoch unset so rule 4 (quiet-period) only fires once a
            # real timestamped reset has occurred.
            self._apply_reset(now_ns=None, reason="startup_or_reconnect")

    @property
    def state(self) -> L2AuthorityState:
        return self._state

    @property
    def enabled(self) -> bool:
        return self._enabled

    # ─── Reset / gap / error hooks ─────────────────────────────────

    def on_startup_or_reconnect(self, *, now_ns: Optional[int] = None) -> None:
        """Equivalent to a reset — startup and reconnect both flip
        authority off until the reconvergence criteria are re-met."""
        self._apply_reset(now_ns=now_ns, reason="startup_or_reconnect")

    def on_reset(self, *, now_ns: Optional[int] = None) -> None:
        """R (clear) action or explicit session-boundary reset."""
        self._apply_reset(now_ns=now_ns, reason="reset_r_action")

    def on_gap_detected(self, *, now_ns: Optional[int] = None) -> None:
        """Record-sequence gap observed in the feed."""
        if not self._enabled:
            return
        ts_ms = _ns_to_ms(now_ns)
        self._state.gap_detected = True
        self._state.last_gap_ts_ms = ts_ms
        self._apply_reset(now_ns=now_ns, reason="gap_detected")

    def on_provider_error(self, *, now_ns: Optional[int] = None) -> None:
        """Provider parse / error event. Not a full reset of the book
        state, but must flip authority off and restart the quiet-period
        window."""
        if not self._enabled:
            return
        self._state.last_provider_error_ts_ms = _ns_to_ms(now_ns)
        self._state.quote_authoritative = False
        self._state.snapshot_synced = False
        self._state.warmup_state = "reconverging"
        self._state.not_authoritative_reason = "provider_error_recent"

    def _apply_reset(self, *, now_ns: Optional[int], reason: str) -> None:
        if not self._enabled:
            return
        ts_ms = _ns_to_ms(now_ns)
        self._state.snapshot_synced = False
        self._state.quote_authoritative = False
        self._state.warmup_state = "reconverging"
        self._state.reconvergence_epoch_ts_ms = ts_ms
        self._state.reset_count += 1
        self._state.bid_populated_post_reset = False
        self._state.ask_populated_post_reset = False
        self._state.reconvergence_updates_without_gap = 0
        self._state.last_bid_update_ts_ms = None
        self._state.last_ask_update_ts_ms = None
        self._state.not_authoritative_reason = reason

    # ─── Apply-result hook ────────────────────────────────────────

    def on_apply_result(
        self,
        result,  # ApplyResult from mbp10_book_state
        snapshot,  # Mbp10Snapshot-like; exposes best_bid/best_ask/best_*_qty
        *,
        now_ns: Optional[int] = None,
    ) -> None:
        """Called after each MBP-10 record is applied to the book.

        Drives the post-reset population flags (rule 1), the gap-free
        counter (rule 3), and the ordinary-freshness timestamp
        (rule 5). R-action apply results are treated as resets.
        """
        if not self._enabled:
            return
        if result is None:
            return
        ts_ms = _ns_to_ms(now_ns if now_ns is not None
                          else getattr(result, "ts_recv_ns", None))
        if getattr(result, "cleared", False):
            # Book-level R action IS a reset boundary. Equivalent to
            # on_reset — unify here so the sink only has to call one
            # path per event.
            self._apply_reset(now_ns=now_ns, reason="reset_r_action")
            return
        if not getattr(result, "applied", False):
            # Unknown / ignored action — does not advance the gap-free
            # counter. Rule 3 must be driven by real level events only.
            self._recompute_authority(snapshot, ts_ms)
            return
        # Post-reset population: an A/M/C/T that carries this side
        # counts as "populated from an update received after the
        # most recent reset/gap boundary." Both sides must flip true
        # before rule 1 is satisfied.
        bb = snapshot.best_bid() if snapshot is not None else None
        ba = snapshot.best_ask() if snapshot is not None else None
        if bb is not None:
            self._state.bid_populated_post_reset = True
            self._state.last_bid_update_ts_ms = ts_ms
        if ba is not None:
            self._state.ask_populated_post_reset = True
            self._state.last_ask_update_ts_ms = ts_ms
        self._state.reconvergence_updates_without_gap += 1
        # Clear the stale gap flag once we're successfully advancing.
        # A new gap re-sets this via on_gap_detected().
        self._state.gap_detected = False
        self._recompute_authority(snapshot, ts_ms)

    # ─── Authority recomputation ──────────────────────────────────

    def _recompute_authority(
        self, snapshot, now_ms: Optional[int],
    ) -> None:
        """Apply the five rules and set quote_authoritative."""
        # Rule 1 — post-reset population of BOTH sides.
        if not (self._state.bid_populated_post_reset
                and self._state.ask_populated_post_reset):
            self._state.quote_authoritative = False
            self._state.warmup_state = "reconverging"
            self._state.not_authoritative_reason = "post_reset_population_incomplete"
            return
        # Rule 2 — top-of-book validity.
        bb = snapshot.best_bid() if snapshot is not None else None
        ba = snapshot.best_ask() if snapshot is not None else None
        if bb is None or ba is None:
            self._state.quote_authoritative = False
            self._state.not_authoritative_reason = "one_sided_book"
            return
        if not (bb < ba):
            self._state.quote_authoritative = False
            self._state.not_authoritative_reason = "crossed_or_inverted"
            return
        # Rule 3 — gap-free post-reset sequence length.
        if (
            self._state.reconvergence_updates_without_gap
            < self._config.min_post_reset_updates
        ):
            self._state.quote_authoritative = False
            self._state.warmup_state = "reconverging"
            self._state.not_authoritative_reason = "post_reset_sequence_short"
            return
        # Rule 4 — quiet period: no reset / error within quiet_ms.
        if now_ms is not None:
            if self._state.last_provider_error_ts_ms is not None:
                if now_ms - self._state.last_provider_error_ts_ms < self._config.quiet_ms:
                    self._state.quote_authoritative = False
                    self._state.not_authoritative_reason = "quiet_period_pending_error"
                    return
            if self._state.last_gap_ts_ms is not None:
                if now_ms - self._state.last_gap_ts_ms < self._config.quiet_ms:
                    self._state.quote_authoritative = False
                    self._state.not_authoritative_reason = "quiet_period_pending_gap"
                    return
            if self._state.reconvergence_epoch_ts_ms is not None:
                if now_ms - self._state.reconvergence_epoch_ts_ms < self._config.quiet_ms:
                    self._state.quote_authoritative = False
                    self._state.not_authoritative_reason = "quiet_period_pending_reset"
                    return
        # Rule 5 — ordinary freshness.
        if now_ms is not None:
            newest_side_ts = max(
                self._state.last_bid_update_ts_ms or 0,
                self._state.last_ask_update_ts_ms or 0,
            )
            if newest_side_ts > 0:
                age = now_ms - newest_side_ts
                if age > self._config.freshness_budget_ms:
                    self._state.quote_authoritative = False
                    self._state.not_authoritative_reason = "stale_top_of_book"
                    return
        # All five rules satisfied.
        self._state.snapshot_synced = True
        self._state.quote_authoritative = True
        self._state.warmup_state = "ready"
        self._state.last_good_quote_ts_ms = now_ms
        self._state.not_authoritative_reason = None

    # ─── Serialization ────────────────────────────────────────────

    def to_health_dict(self) -> dict:
        """Shape for /lob/health publication. Explicit and typed —
        v3.2.1 §5.2 requires machine-readable authority semantics."""
        s = self._state
        return {
            "snapshot_synced": s.snapshot_synced,
            "quote_authoritative": s.quote_authoritative,
            "warmup_state": s.warmup_state,
            "gap_detected": s.gap_detected,
            "reset_count": s.reset_count,
            "reconvergence_epoch_ts_ms": s.reconvergence_epoch_ts_ms,
            "reconvergence_updates_without_gap":
                s.reconvergence_updates_without_gap,
            "last_gap_ts_ms": s.last_gap_ts_ms,
            "last_provider_error_ts_ms": s.last_provider_error_ts_ms,
            "last_bid_update_ts_ms": s.last_bid_update_ts_ms,
            "last_ask_update_ts_ms": s.last_ask_update_ts_ms,
            "last_good_quote_ts_ms": s.last_good_quote_ts_ms,
            "not_authoritative_reason": s.not_authoritative_reason,
            "fsm_enabled": self._enabled,
        }


@dataclass
class L2AuthorityRegistry:
    """One FSM per instrument_id."""
    _config: L2AuthorityConfig = field(default_factory=L2AuthorityConfig)
    _enabled: bool = field(default_factory=l2_authority_fsm_enabled_from_env)
    _fsms: dict[int, L2AuthorityFSM] = field(default_factory=dict)

    def get_or_create(self, instrument_id: int) -> L2AuthorityFSM:
        fsm = self._fsms.get(instrument_id)
        if fsm is None:
            fsm = L2AuthorityFSM(config=self._config, enabled=self._enabled)
            # Mark the startup boundary explicitly so the first
            # observed events are treated as post-reset, not
            # pre-reset carry-over.
            fsm.on_startup_or_reconnect(now_ns=None)
            self._fsms[instrument_id] = fsm
        return fsm

    def get(self, instrument_id: int) -> Optional[L2AuthorityFSM]:
        return self._fsms.get(instrument_id)

    def all_items(self):
        return list(self._fsms.items())

    def clear_all(self) -> None:
        self._fsms.clear()


def _ns_to_ms(ns: Optional[int]) -> Optional[int]:
    if ns is None:
        return None
    return ns // _NS_PER_MS
