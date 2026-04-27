"""DATA-01A L1/trade journal publisher.

The publisher converts rich Rithmic probe/provider rows to OBS-01 QUOTE/TRADE source
events. It intentionally skips MBP10/MBO rows until DATA-01B parity is complete.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from services.market_data_sidecar.config import (
    DATA01A_FULL_GATE_STATUS,
    DATA01A_PARTIAL_PARITY_STATUS,
    DATA01B_STATUS,
)
from services.market_data_sidecar.providers.rithmic_live import (
    NormalizationDiagnostic,
    RithmicL1TradeNormalizer,
)
from services.market_data_sidecar.publish.event_journal import make_source_event_envelope

MAX_RECORDED_DIAGNOSTICS = 100


@dataclass(frozen=True)
class L1TradePublishReport:
    input_rows: int
    emitted_events: int
    emitted_quote_events: int
    emitted_trade_events: int
    skipped_mbp10_rows: int
    skipped_mbo_rows: int
    skipped_null_exchange_ts_rows: int
    diagnostic_count: int
    diagnostic_counts: dict[str, int]
    diagnostics: list[dict[str, Any]]
    diagnostics_truncated: bool
    partial_parity_status: str
    data01_full_gate_status: str
    data01b_status: str


def publish_l1_trade_journal_from_probe(
    *,
    input_path: Path,
    output_path: Path,
    run_id: str,
    session_id: str,
) -> L1TradePublishReport:
    diagnostics: list[NormalizationDiagnostic] = []
    diagnostic_counts: dict[str, int] = {}
    diagnostic_count = 0
    input_rows = 0
    emitted_events = 0
    quote_events = 0
    trade_events = 0
    skipped_mbp10_rows = 0
    skipped_mbo_rows = 0
    skipped_null_exchange_ts_rows = 0
    normalizer = RithmicL1TradeNormalizer()

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

            normalized, diagnostic = normalizer.normalize_row(row, line_number=line_number)
            if diagnostic is not None:
                diagnostic_count = _record_diagnostic(
                    diagnostics,
                    diagnostic_counts,
                    diagnostic_count,
                    diagnostic,
                )
                if diagnostic.reason == "blocked_l2_l3_stream" and diagnostic.stream == "MBP10":
                    skipped_mbp10_rows += 1
                elif diagnostic.reason == "blocked_l2_l3_stream" and diagnostic.stream == "MBO":
                    skipped_mbo_rows += 1
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
            if normalized.event_type == "QUOTE":
                quote_events += 1
            else:
                trade_events += 1

    return L1TradePublishReport(
        input_rows=input_rows,
        emitted_events=emitted_events,
        emitted_quote_events=quote_events,
        emitted_trade_events=trade_events,
        skipped_mbp10_rows=skipped_mbp10_rows,
        skipped_mbo_rows=skipped_mbo_rows,
        skipped_null_exchange_ts_rows=skipped_null_exchange_ts_rows,
        diagnostic_count=diagnostic_count,
        diagnostic_counts=dict(sorted(diagnostic_counts.items())),
        diagnostics=[asdict(diagnostic) for diagnostic in diagnostics],
        diagnostics_truncated=diagnostic_count > len(diagnostics),
        partial_parity_status=DATA01A_PARTIAL_PARITY_STATUS,
        data01_full_gate_status=DATA01A_FULL_GATE_STATUS,
        data01b_status=DATA01B_STATUS,
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
