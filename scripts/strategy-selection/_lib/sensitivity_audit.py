"""QFA-611 strategy-level execution sensitivity audit.

The audit consumes the machine-readable QFA-402c cell artifact. It does not
parse markdown tables. Cells with zero probes are treated as unknown evidence,
which keeps the downstream decision logic from silently marking unobserved
execution states as clean.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from thresholds import ADR0016_STAGE1_THRESHOLDS


CELL_KEY_FIELDS = ("regime", "spread_bucket", "queue_ahead_bucket")


@dataclass(frozen=True)
class FidelityCell:
    regime: str
    spread_bucket: str
    queue_ahead_bucket: str
    share_ppm: int
    probe_count: int
    within_tolerance_count: int

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.regime, self.spread_bucket, self.queue_ahead_bucket)


def load_fidelity_cells(path: str | Path) -> dict[tuple[str, str, str], FidelityCell]:
    artifact = json.loads(Path(path).read_text(encoding="utf-8"))
    if artifact.get("schema_version") != 1:
        raise ValueError("QFA-402c cell artifact schema_version must be 1")
    if artifact.get("methodology_id") != "qfa-402c-cells-v1":
        raise ValueError("QFA-402c cell artifact methodology_id must be qfa-402c-cells-v1")
    cells: dict[tuple[str, str, str], FidelityCell] = {}
    for index, raw_cell in enumerate(artifact.get("cells", [])):
        for field in (*CELL_KEY_FIELDS, "share_ppm", "probe_count", "within_tolerance_count"):
            if field not in raw_cell:
                raise ValueError(f"QFA-402c cell {index} missing required field {field}")
        cell = FidelityCell(
            regime=str(raw_cell["regime"]),
            spread_bucket=str(raw_cell["spread_bucket"]),
            queue_ahead_bucket=str(raw_cell["queue_ahead_bucket"]),
            share_ppm=int(raw_cell["share_ppm"]),
            probe_count=int(raw_cell["probe_count"]),
            within_tolerance_count=int(raw_cell["within_tolerance_count"]),
        )
        if cell.key in cells:
            raise ValueError(f"duplicate QFA-402c cell: {cell.key}")
        cells[cell.key] = cell
    return cells


def compute_sensitivity_audit(
    trades: Sequence[Mapping[str, Any]],
    fidelity_cells: Mapping[tuple[str, str, str], FidelityCell],
    *,
    low_fidelity_share_ppm: int = ADR0016_STAGE1_THRESHOLDS["sensitivity_low_fidelity_share_ppm"],
    concentration_fraction: float = ADR0016_STAGE1_THRESHOLDS["sensitivity_concentration_fraction"],
) -> dict[str, Any]:
    total_trades = len(trades)
    low_fidelity_counts: dict[tuple[str, str, str], int] = {}
    unknown_counts: dict[tuple[str, str, str], int] = {}

    for index, trade in enumerate(trades):
        key = trade_cell_key(trade, index)
        cell = fidelity_cells.get(key)
        if cell is None or cell.probe_count == 0:
            unknown_counts[key] = unknown_counts.get(key, 0) + 1
            continue
        if cell.share_ppm < low_fidelity_share_ppm:
            low_fidelity_counts[key] = low_fidelity_counts.get(key, 0) + 1

    low_count = sum(low_fidelity_counts.values())
    unknown_count = sum(unknown_counts.values())
    low_fraction = 0.0 if total_trades == 0 else low_count / total_trades
    unknown_fraction = 0.0 if total_trades == 0 else unknown_count / total_trades
    missing_flag = unknown_fraction >= concentration_fraction and total_trades > 0
    low_flag = low_fraction >= concentration_fraction and total_trades > 0
    flag = missing_flag or low_flag
    reason = "clean"
    if missing_flag:
        reason = "missing_cell_concentration"
    elif low_flag:
        reason = "low_fidelity_concentration"

    return {
        "flag": flag,
        "reason": reason,
        "total_trades": total_trades,
        "low_fidelity_trade_count": low_count,
        "low_fidelity_trade_fraction": low_fraction,
        "unknown_cell_trade_count": unknown_count,
        "unknown_cell_trade_fraction": unknown_fraction,
        "flagged_cells": flagged_cell_rows(low_fidelity_counts, unknown_counts, fidelity_cells, total_trades),
    }


def trade_cell_key(trade: Mapping[str, Any], index: int) -> tuple[str, str, str]:
    missing = [field for field in CELL_KEY_FIELDS if field not in trade]
    if missing:
        raise ValueError(f"trade {index} missing sensitivity audit fields: {', '.join(missing)}")
    return (str(trade["regime"]), str(trade["spread_bucket"]), str(trade["queue_ahead_bucket"]))


def flagged_cell_rows(
    low_fidelity_counts: Mapping[tuple[str, str, str], int],
    unknown_counts: Mapping[tuple[str, str, str], int],
    fidelity_cells: Mapping[tuple[str, str, str], FidelityCell],
    total_trades: int,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for status, counts in (("low_fidelity", low_fidelity_counts), ("unknown", unknown_counts)):
        for key, count in sorted(counts.items()):
            cell = fidelity_cells.get(key)
            rows.append({
                "regime": key[0],
                "spread_bucket": key[1],
                "queue_ahead_bucket": key[2],
                "cell_status": status,
                "strategy_trade_count": count,
                "strategy_trade_fraction": 0.0 if total_trades == 0 else count / total_trades,
                "share_ppm": None if cell is None else cell.share_ppm,
                "probe_count": None if cell is None else cell.probe_count,
            })
    return rows
