"""DATA-01B-PS MBP10 price-state journal publisher."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from services.market_data_sidecar.book.mbp10_price_state import Mbp10PriceStateReconstructor
from services.market_data_sidecar.config import (
    DATA01B_FULL_STATUS,
    DATA01B_MBO_STATUS,
    DATA01B_MBP10_PRICE_STATE_STATUS,
    DATA01B_SIZE_ORDER_COUNT_STATUS,
)
from services.market_data_sidecar.providers.rithmic_live import NormalizationDiagnostic
from services.market_data_sidecar.publish.event_journal import make_source_event_envelope

MAX_RECORDED_DIAGNOSTICS = 100


@dataclass(frozen=True)
class Mbp10PriceStatePublishReport:
    input_rows: int
    emitted_events: int
    emitted_mbp10_price_state_events: int
    skipped_mbo_rows: int
    seeded_null_exchange_ts_rows: int
    skipped_null_exchange_ts_rows: int
    diagnostic_count: int
    diagnostic_counts: dict[str, int]
    diagnostics: list[dict[str, Any]]
    diagnostics_truncated: bool
    mbp10_price_state_status: str
    mbo_status: str
    size_order_count_status: str
    data01b_full_status: str


def publish_mbp10_price_state_journal_from_probe(
    *,
    input_path: Path,
    output_path: Path,
    run_id: str,
    session_id: str,
) -> Mbp10PriceStatePublishReport:
    diagnostics: list[NormalizationDiagnostic] = []
    diagnostic_counts: dict[str, int] = {}
    diagnostic_count = 0
    input_rows = 0
    emitted_events = 0
    skipped_mbo_rows = 0
    seeded_null_exchange_ts_rows = 0
    skipped_null_exchange_ts_rows = 0
    reconstructor = Mbp10PriceStateReconstructor()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with (
        input_path.open("r", encoding="utf-8", errors="replace") as source,
        output_path.open("w", encoding="utf-8", newline="\n") as output,
    ):
        for line_number, line in enumerate(source, 1):
            if line.strip() == "":
                continue
            input_rows += 1
            row = json.loads(line)
            if not isinstance(row, dict):
                diagnostic_count = _record_diagnostic(
                    diagnostics,
                    diagnostic_counts,
                    diagnostic_count,
                    NormalizationDiagnostic(line_number, "missing", "row_not_object"),
                )
                continue

            normalized, diagnostic = reconstructor.normalize_row(row, line_number=line_number)
            if diagnostic is not None:
                diagnostic_count = _record_diagnostic(
                    diagnostics,
                    diagnostic_counts,
                    diagnostic_count,
                    diagnostic,
                )
                if diagnostic.stream == "MBO":
                    skipped_mbo_rows += 1
                if diagnostic.reason == "seeded_null_exchange_ts_ns":
                    seeded_null_exchange_ts_rows += 1
                elif diagnostic.reason == "missing_exchange_event_ts_ns":
                    skipped_null_exchange_ts_rows += 1
                continue

            if normalized is None:
                continue

            sequence = emitted_events + 1
            event_id = f"{normalized.event_id_prefix}-{run_id}-{sequence:012d}"
            envelope = make_source_event_envelope(
                event_id=event_id,
                event_type=normalized.event_type,
                ts_ns=normalized.ts_ns,
                run_id=run_id,
                session_id=session_id,
                payload=normalized.payload,
            )
            output.write(json.dumps(envelope, sort_keys=True, separators=(",", ":")))
            output.write("\n")
            emitted_events += 1

    return Mbp10PriceStatePublishReport(
        input_rows=input_rows,
        emitted_events=emitted_events,
        emitted_mbp10_price_state_events=emitted_events,
        skipped_mbo_rows=skipped_mbo_rows,
        seeded_null_exchange_ts_rows=seeded_null_exchange_ts_rows,
        skipped_null_exchange_ts_rows=skipped_null_exchange_ts_rows,
        diagnostic_count=diagnostic_count,
        diagnostic_counts=dict(sorted(diagnostic_counts.items())),
        diagnostics=[asdict(diagnostic) for diagnostic in diagnostics],
        diagnostics_truncated=diagnostic_count > len(diagnostics),
        mbp10_price_state_status=DATA01B_MBP10_PRICE_STATE_STATUS,
        mbo_status=DATA01B_MBO_STATUS,
        size_order_count_status=DATA01B_SIZE_ORDER_COUNT_STATUS,
        data01b_full_status=DATA01B_FULL_STATUS,
    )


def _record_diagnostic(
    diagnostics: list[NormalizationDiagnostic],
    diagnostic_counts: dict[str, int],
    diagnostic_count: int,
    diagnostic: NormalizationDiagnostic,
) -> int:
    key = f"{diagnostic.stream}:{diagnostic.reason}"
    diagnostic_counts[key] = diagnostic_counts.get(key, 0) + 1
    if len(diagnostics) < MAX_RECORDED_DIAGNOSTICS:
        diagnostics.append(diagnostic)
    return diagnostic_count + 1
