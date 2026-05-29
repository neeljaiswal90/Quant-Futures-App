"""Multi-method confluence grouping."""

from __future__ import annotations

from typing import Any, Literal

from rithmic_dashboard.level_distances import compute_level_distances
from rithmic_dashboard.models import ConfluenceGroup, Conviction, LevelDistance


def compute_confluence_groups(
    envelope: dict[str, Any],
    max_gap_pts: float = 10.0,
) -> list[ConfluenceGroup]:
    """Compute clusters where adjacent levels are within ``max_gap_pts``."""

    levels = _dedupe_for_confluence(
        compute_level_distances(envelope, current_price=0.0, atr=1.0)
    )
    levels = sorted(levels, key=lambda level: level.price)
    if not levels:
        return []

    groups: list[ConfluenceGroup] = []
    current: list[LevelDistance] = [levels[0]]
    for level in levels[1:]:
        if abs(level.price - current[-1].price) <= max_gap_pts:
            current.append(level)
            continue
        _append_group(groups, current)
        current = [level]
    _append_group(groups, current)

    return sorted(groups, key=lambda group: group.center_price)


def _append_group(groups: list[ConfluenceGroup], levels: list[LevelDistance]) -> None:
    if len(levels) < 2:
        return
    prices = [level.price for level in levels]
    span = max(prices) - min(prices)
    center = sum(prices) / len(prices)
    tightness: Literal["TIGHT", "LOOSE"] = "TIGHT" if span < 5.0 else "LOOSE"
    groups.append(
        ConfluenceGroup(
            levels=tuple(levels),
            center_price=center,
            span_pts=span,
            tightness=tightness,
            conviction_score=_conviction(levels, span),
        )
    )


def _conviction(levels: list[LevelDistance], span: float) -> Conviction:
    methods = {_method_name(level.source) for level in levels}
    if len(methods) >= 3 and span <= 10.0:
        return "SUPER"
    if len(methods) >= 2 and span <= 10.0:
        return "HIGH"
    if len(methods) >= 2:
        return "HIGH" if len(methods) >= 3 else "MED"
    return "LOW"


def _dedupe_for_confluence(levels: list[LevelDistance]) -> list[LevelDistance]:
    """Drop duplicate volume marks, especially HVNs sitting on VPOC."""

    vpocs = [level.price for level in levels if level.source == "vpoc"]
    result: list[LevelDistance] = []
    seen: set[tuple[str, int]] = set()
    for level in levels:
        if "hvn" in level.source and any(abs(level.price - vpoc) <= 2.5 for vpoc in vpocs):
            continue
        key = (_method_name(level.source), round(level.price * 4))
        if key in seen:
            continue
        seen.add(key)
        result.append(level)
    return result


def _method_name(source: str) -> str:
    if "vwap" in source and "band" in source:
        return "sigma"
    if "vwap" in source:
        return "vwap"
    if "lvn" in source:
        return "lvn"
    if "hvn" in source:
        return "hvn"
    return source
