"""DATA-01B-MBO provider-internal MBO lifecycle journal publisher."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from services.market_data_sidecar.book.mbo_order_lifecycle import RithmicMboOrderLifecycleNormalizer
from services.market_data_sidecar.config import (
    DATA01B_FULL_STATUS,
    DATA01B_MBO_FEATURE_STATUS,
    DATA01B_MBO_LIFECYCLE_STATUS,
    DATA01B_MBO_STATUS,
)
from services.market_data_sidecar.providers.rithmic_live import NormalizationDiagnostic
from services.market_data_sidecar.publish.event_journal import make_source_event_envelope

MAX_RECORDED_DIAGNOSTICS = 100


@dataclass(frozen=True)
class MboOrderLifecyclePublishReport:
    input_rows: int
    emitted_events: int
    emitted_mbo_order_lifecycle_events: int
    skipped_mbp10_rows: int
    skipped_non_mbo_rows: int
    skipped_null_exchange_ts_rows: int
    skipped_missing_sidecar_recv_ts_rows: int
    skipped_invalid_order_rows: int
    diagnostic_count: int
    diagnostic_counts: dict[str, int]
    diagnostics: list[dict[str, Any]]
    diagnostics_truncated: bool
    mbo_status: str
    mbo_lifecycle_status: str
    mbo_feature_status: str
    data01b_full_status: str


def publish_mbo_order_lifecycle_journal_from_probe(
    *,
    input_path: Path,
    output_path: Path,
    run_id: str,
    session_id: str,
) -> MboOrderLifecyclePublishReport:
    diagnostics: list[NormalizationDiagnostic] = []
    diagnostic_counts: dict[str, int] = {}
    diagnostic_count = 0
    input_rows = 0
    emitted_events = 0
    skipped_mbp10_rows = 0
    skipped_non_mbo_rows = 0
    skipped_null_exchange_ts_rows = 0
    skipped_missing_sidecar_recv_ts_rows = 0
    skipped_invalid_order_rows = 0
    normalizer = RithmicMboOrderLifecycleNormalizer()

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
                skipped_invalid_order_rows += 1
                continue

            normalized_events, row_diagnostics = normalizer.normalize_row(row, line_number=line_number)
            for diagnostic in row_diagnostics:
                diagnostic_count = _record_diagnostic(diagnostics, diagnostic_counts, diagnostic_count, diagnostic)
                if diagnostic.reason == "mbp10_not_consumed_by_mbo_path":
                    skipped_mbp10_rows += 1
                elif diagnostic.reason == "non_mbo_stream":
                    skipped_non_mbo_rows += 1
                elif diagnostic.reason == "missing_exchange_event_ts_ns":
                    skipped_null_exchange_ts_rows += 1
                elif diagnostic.reason == "missing_sidecar_recv_ts_ns":
                    skipped_missing_sidecar_recv_ts_rows += 1
                elif diagnostic.stream == "MBO":
                    skipped_invalid_order_rows += 1

            for normalized in normalized_events:
                sequence = emitted_events + 1
                event_id = f"{normalized.event_id_prefix}-{run_id}-{sequence:012d}"
                envelope = make_source_event_envelope(
                    event_id=event_id,
                    event_type=normalized.event_type,
                    ts_ns=normalized.ts_ns,
                    run_id=run_id,
                    session_id=session_id,
                    payload={**normalized.payload, "feature_snapshot_id": event_id},
                )
                output.write(json.dumps(envelope, sort_keys=True, separators=(",", ":")))
                output.write("\n")
                emitted_events += 1

    return MboOrderLifecyclePublishReport(
        input_rows=input_rows,
        emitted_events=emitted_events,
        emitted_mbo_order_lifecycle_events=emitted_events,
        skipped_mbp10_rows=skipped_mbp10_rows,
        skipped_non_mbo_rows=skipped_non_mbo_rows,
        skipped_null_exchange_ts_rows=skipped_null_exchange_ts_rows,
        skipped_missing_sidecar_recv_ts_rows=skipped_missing_sidecar_recv_ts_rows,
        skipped_invalid_order_rows=skipped_invalid_order_rows,
        diagnostic_count=diagnostic_count,
        diagnostic_counts=dict(sorted(diagnostic_counts.items())),
        diagnostics=[asdict(diagnostic) for diagnostic in diagnostics],
        diagnostics_truncated=diagnostic_count > len(diagnostics),
        mbo_status=DATA01B_MBO_STATUS,
        mbo_lifecycle_status=DATA01B_MBO_LIFECYCLE_STATUS,
        mbo_feature_status=DATA01B_MBO_FEATURE_STATUS,
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
