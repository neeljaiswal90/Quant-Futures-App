"""Markdown renderer for :class:`AnnotatedZoneEnvelope` — RA-038.

One-shot static markdown card. Designed to fit in a chat-message reply
or a checked-in trading log; renders to stdout-friendly width.

Output layout::

    # MNQ rth · 2026-05-20

    *Trailing-30 window, n=24 sessions · pairing=next-day*

    *Note: Probabilities conditioned on conviction tier only…*

    | Zone | Conviction | Role | P(hold) ci_low | Expected R | Size |
    |---|---|---|---|---|---|
    | hvn-27380 | SUPER | support | 0.72 | +0.84R | **full** |
    | hvn-27240 | HIGH | support | 0.51 | +0.18R | half |
    | hvn-27090 | MED | support | n/a | n/a | insufficient_history |
"""

from __future__ import annotations

import math
from collections.abc import Iterable

from rithmic_analytics.features.zone_probability import (
    AnnotatedZoneEnvelope,
    ZoneProbabilityAnnotation,
)

_SIZE_LABEL: dict[str, str] = {
    "full": "**full**",
    "half": "half",
    "skip": "skip",
    "insufficient_history": "insufficient_history",
}


def _fmt_rate(x: float) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "n/a"
    return f"{x:.2f}"


def _fmt_r(x: float) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "n/a"
    sign = "+" if x >= 0 else ""
    return f"{sign}{x:.2f}R"


def _row(ann: ZoneProbabilityAnnotation) -> str:
    return (
        f"| {ann.zone_id} | {ann.conviction} | {ann.functional_role} | "
        f"{_fmt_rate(ann.p_hold_ci_low)} | {_fmt_r(ann.expected_r)} | "
        f"{_SIZE_LABEL.get(ann.sizing_decision, ann.sizing_decision)} |"
    )


def render_probability_card(annotated: AnnotatedZoneEnvelope) -> str:
    """Render an :class:`AnnotatedZoneEnvelope` to markdown.

    Header always includes ``trailing-N window, n=K sessions`` — no
    explicit date range per Q-RA038-2. Bootstrap mode produces a single
    "no usable history" notice instead of the per-tier table.

    Args:
        annotated: Result of
            :func:`rithmic_analytics.features.zone_probability.annotate_zones_with_probability`.

    Returns:
        Markdown string. Always ends in a single trailing newline.
    """
    lines: list[str] = []
    lines.append(f"# {annotated.symbol} {annotated.timeframe} · {annotated.trading_date_iso}")
    lines.append("")

    if annotated.bootstrap_mode:
        if annotated.window_sessions == 0:
            lines.append(
                "*No usable history available (pre-bootstrap mode). "
                "Sizing recommendations suppressed.*"
            )
        else:
            lines.append(
                f"*Trailing-{annotated.window_sessions} window, "
                f"n={annotated.sessions_analyzed} sessions · "
                f"pairing={annotated.pairing}. All conviction tiers below "
                f"min-trials floor — sizing recommendations suppressed.*"
            )
    else:
        lines.append(
            f"*Trailing-{annotated.window_sessions} window, "
            f"n={annotated.sessions_analyzed} sessions · "
            f"pairing={annotated.pairing}*"
        )

    lines.append("")
    lines.append(f"*Note: {annotated.role_conditioning_note}*")
    lines.append("")

    if not annotated.zone_annotations:
        lines.append("_No zones in today's envelope._")
        lines.append("")
        return "\n".join(lines)

    lines.append("| Zone | Conviction | Role | P(hold) ci_low | Expected R | Size |")
    lines.append("|---|---|---|---|---|---|")
    lines.extend(_row(a) for a in annotated.zone_annotations)
    lines.append("")
    lines.append(_summary_footer(annotated.zone_annotations))
    lines.append("")
    return "\n".join(lines)


def _summary_footer(annotations: Iterable[ZoneProbabilityAnnotation]) -> str:
    counts = {"full": 0, "half": 0, "skip": 0, "insufficient_history": 0}
    for a in annotations:
        counts[a.sizing_decision] = counts.get(a.sizing_decision, 0) + 1
    return (
        f"_Summary: full={counts['full']}, half={counts['half']}, "
        f"skip={counts['skip']}, insufficient={counts['insufficient_history']}._"
    )
