"""Conviction-conditioned zone probability annotation — RA-038.

Given today's :class:`ZoneEnvelope` and a trailing-N-session
:class:`HistoryReport`, annotate each zone with a Wilson-conservative
probability of holding, expected R, and a sizing recommendation (full /
half / skip).

Design calls:

- **Conviction-only annotation** (Q-RA038-1, Option A). The probability is
  looked up by zone conviction tier, not by ``(conviction × role)``. The
  underlying ``HistoryReport.hit_rate_by_conviction`` schema is keyed by
  conviction alone — role conditioning is queued for RA-040-candidate.
  Functional role is rendered for context but does not enter the
  expected-R math.
- **Conservative ``ci_low``**. The Wilson 95% CI lower bound is used as
  the operating "P(hold)" so the sizing decision degrades gracefully when
  history is thin (wide CI → low ci_low → smaller bet). Once N stabilises
  the gap closes.
- **Bootstrap mode**. When no usable history exists (missing report,
  empty report, or every tier insufficient_data), still produce a card
  but mark sizing as ``"insufficient_history"`` for every zone.
- **Schema is additive**. ``AnnotatedZoneEnvelope`` wraps a
  :class:`ZoneEnvelope` rather than mutating one — the canonical zones
  JSON consumer contract is untouched.

Example:
    >>> annotations = annotate_zones_with_probability(envelope, history_report)
    >>> for ann in annotations.zone_annotations:
    ...     print(ann.zone_id, ann.p_hold_ci_low, ann.sizing_decision)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

from rithmic_analytics.core.schema import Zone, ZoneEnvelope
from rithmic_analytics.features.zone_quality import (
    BinomialEstimate,
    HistoryReport,
)

# Sizing thresholds (in R units, computed against expected_R = ci_low * bounce_R - (1 - ci_low)).
_FULL_SIZE_THRESHOLD_R: float = 0.30
_HALF_SIZE_THRESHOLD_R: float = 0.10

SizingDecision = Literal["full", "half", "skip", "insufficient_history"]


@dataclass(frozen=True, slots=True)
class ZoneProbabilityAnnotation:
    """Per-zone probability + sizing assessment.

    All numeric fields are NaN-tolerant: when the underlying tier has
    insufficient data, ``p_hold_ci_low`` / ``expected_r`` are NaN and
    ``sizing_decision`` is ``"insufficient_history"``.

    Attributes:
        zone_id: Mirrors :attr:`Zone.id`.
        conviction: Tier the probability lookup keyed on.
        functional_role: Same value as :attr:`Zone.type` (Phase-1 zones
            always emit ``"support"`` — see Q-RA038-1). Carried for
            display only.
        p_hold_ci_low: Wilson 95% CI lower bound on hit rate.
            NaN if tier had insufficient_data or no history available.
        p_hold_rate: Maximum-likelihood hit rate; NaN if no history.
        n_trials: HistoryReport trial count for this tier.
        avg_bounce_distance_pts: Average bounce distance from history.
        bounce_r: ``avg_bounce_distance_pts / atr_14`` — None if either is NaN.
        expected_r: ``p_hold_ci_low * bounce_r - (1 - p_hold_ci_low)``.
            NaN if either input is NaN.
        sizing_decision: ``"full"`` / ``"half"`` / ``"skip"`` /
            ``"insufficient_history"``. Threshold rules in module docstring.
        history_insufficient: True when the conviction tier was flagged
            insufficient by the HistoryReport (denominator below the
            min-trials floor).
    """

    zone_id: str
    conviction: str
    functional_role: str
    p_hold_ci_low: float
    p_hold_rate: float
    n_trials: int
    avg_bounce_distance_pts: float
    bounce_r: float | None
    expected_r: float
    sizing_decision: SizingDecision
    history_insufficient: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "zone_id": self.zone_id,
            "conviction": self.conviction,
            "functional_role": self.functional_role,
            "p_hold_ci_low": _nan_to_none(self.p_hold_ci_low),
            "p_hold_rate": _nan_to_none(self.p_hold_rate),
            "n_trials": self.n_trials,
            "avg_bounce_distance_pts": _nan_to_none(self.avg_bounce_distance_pts),
            "bounce_r": self.bounce_r,
            "expected_r": _nan_to_none(self.expected_r),
            "sizing_decision": self.sizing_decision,
            "history_insufficient": self.history_insufficient,
        }


@dataclass(frozen=True, slots=True)
class AnnotatedZoneEnvelope:
    """Today's zones + annotations + history provenance.

    Attributes:
        symbol: Echo of :attr:`ZoneEnvelope.symbol`.
        timeframe: Echo of :attr:`ZoneEnvelope.timeframe`.
        trading_date_iso: ISO-8601 date string of the run.
        atr_14: Echo from envelope (for sizing math). NaN-tolerated.
        zone_annotations: Per-zone results.
        sessions_analyzed: From HistoryReport; 0 in bootstrap mode.
        window_sessions: Configured rolling window; 0 in bootstrap mode.
        pairing: HistoryReport pairing label ("next-day" etc.); empty in bootstrap.
        bootstrap_mode: True when no usable history was available.
        role_conditioning_note: Always set — explains the Q-RA038-1
            limitation in the rendered card. Surfaced separately so
            renderers can prefix/suffix or omit at their discretion.
    """

    symbol: str
    timeframe: str
    trading_date_iso: str
    atr_14: float
    zone_annotations: list[ZoneProbabilityAnnotation] = field(default_factory=list)
    sessions_analyzed: int = 0
    window_sessions: int = 0
    pairing: str = ""
    bootstrap_mode: bool = False
    role_conditioning_note: str = (
        "Probabilities conditioned on conviction tier only. Functional role "
        "(support / resistance) is displayed for context but does not enter "
        "the expected-R math. Role conditioning is queued for RA-040-candidate."
    )

    def to_dict(self) -> dict[str, object]:
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "trading_date_iso": self.trading_date_iso,
            "atr_14": _nan_to_none(self.atr_14),
            "zone_annotations": [a.to_dict() for a in self.zone_annotations],
            "sessions_analyzed": self.sessions_analyzed,
            "window_sessions": self.window_sessions,
            "pairing": self.pairing,
            "bootstrap_mode": self.bootstrap_mode,
            "role_conditioning_note": self.role_conditioning_note,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _nan_to_none(x: float | None) -> float | None:
    if x is None:
        return None
    if isinstance(x, float) and math.isnan(x):
        return None
    return x


def _sizing_from_expected_r(expected_r: float, history_insufficient: bool) -> SizingDecision:
    if history_insufficient or math.isnan(expected_r):
        return "insufficient_history"
    if expected_r > _FULL_SIZE_THRESHOLD_R:
        return "full"
    if expected_r >= _HALF_SIZE_THRESHOLD_R:
        return "half"
    return "skip"


def _empty_estimate() -> BinomialEstimate:
    return BinomialEstimate(
        n_trials=0,
        n_success=0,
        rate=None,
        ci_low=0.0,
        ci_high=1.0,
        insufficient_data=True,
    )


# ---------------------------------------------------------------------------
# Annotator
# ---------------------------------------------------------------------------


def annotate_zone(
    zone: Zone,
    *,
    atr_14: float,
    history: HistoryReport | None,
) -> ZoneProbabilityAnnotation:
    """Annotate a single zone. Bootstrap-safe (``history`` may be None)."""
    conviction = zone.conviction
    estimate: BinomialEstimate
    avg_bounce: float
    if history is None:
        estimate = _empty_estimate()
        avg_bounce = float("nan")
        history_insufficient = True
    else:
        estimate = history.hit_rate_by_conviction.get(conviction, _empty_estimate())
        history_insufficient = estimate.insufficient_data
        raw_bounce = history.avg_bounce_distance_by_conviction.get(conviction)
        avg_bounce = float("nan") if raw_bounce is None else float(raw_bounce)

    p_hold_ci_low = float("nan") if history_insufficient else estimate.ci_low
    p_hold_rate = float("nan") if estimate.rate is None else estimate.rate

    bounce_r: float | None
    if math.isnan(avg_bounce) or atr_14 is None or math.isnan(atr_14) or atr_14 <= 0:
        bounce_r = None
    else:
        bounce_r = avg_bounce / atr_14

    if bounce_r is None or history_insufficient or math.isnan(p_hold_ci_low):
        expected_r = float("nan")
    else:
        expected_r = p_hold_ci_low * bounce_r - (1.0 - p_hold_ci_low)

    sizing = _sizing_from_expected_r(expected_r, history_insufficient)

    return ZoneProbabilityAnnotation(
        zone_id=zone.id,
        conviction=conviction,
        functional_role=zone.type,
        p_hold_ci_low=p_hold_ci_low,
        p_hold_rate=p_hold_rate,
        n_trials=estimate.n_trials,
        avg_bounce_distance_pts=avg_bounce,
        bounce_r=bounce_r,
        expected_r=expected_r,
        sizing_decision=sizing,
        history_insufficient=history_insufficient,
    )


def annotate_zones_with_probability(
    envelope: ZoneEnvelope,
    history: HistoryReport | None,
    *,
    trading_date_iso: str,
) -> AnnotatedZoneEnvelope:
    """Build an :class:`AnnotatedZoneEnvelope` for the given inputs.

    Bootstrap-safe: when ``history`` is ``None`` (or every tier is
    insufficient), the returned envelope sets ``bootstrap_mode=True`` and
    each annotation carries ``sizing_decision="insufficient_history"``.

    Args:
        envelope: Today's :class:`ZoneEnvelope`.
        history: Trailing-N-session :class:`HistoryReport`, or ``None``.
        trading_date_iso: Trading-day ISO string (used for the rendered card).

    Returns:
        :class:`AnnotatedZoneEnvelope` with one
        :class:`ZoneProbabilityAnnotation` per zone in the input envelope.
    """
    annotations = [
        annotate_zone(z, atr_14=envelope.atr_14, history=history)
        for z in envelope.zones
    ]

    if history is None:
        bootstrap = True
        sessions_analyzed = 0
        window_sessions = 0
        pairing = ""
    else:
        sessions_analyzed = history.sessions_analyzed
        window_sessions = history.window_sessions
        pairing = history.pairing
        # Even with a HistoryReport, treat as bootstrap if every tier is insufficient.
        bootstrap = all(
            est.insufficient_data
            for est in history.hit_rate_by_conviction.values()
        ) if history.hit_rate_by_conviction else True

    return AnnotatedZoneEnvelope(
        symbol=envelope.symbol,
        timeframe=envelope.timeframe,
        trading_date_iso=trading_date_iso,
        atr_14=envelope.atr_14,
        zone_annotations=annotations,
        sessions_analyzed=sessions_analyzed,
        window_sessions=window_sessions,
        pairing=pairing,
        bootstrap_mode=bootstrap,
    )
