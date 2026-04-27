"""DATA-07A deterministic L1/trade gap detection.

The detector is intentionally scoped to the DATA-01A verified surface:
L1_QUOTE and LAST_TRADE. MBP10/MBO rows are counted as blocked diagnostics and
never enter L2/L3 gap logic.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

from services.market_data_sidecar.config import (
    DATA01A_FULL_GATE_STATUS,
    DATA01A_PARTIAL_PARITY_STATUS,
    DATA01B_STATUS,
)
from services.market_data_sidecar.providers.rithmic_live import (
    NormalizationDiagnostic,
    RithmicL1TradeNormalizer,
)

GapSeverity = Literal["info", "warning", "fail"]
GapReportStatus = Literal["pass", "warning", "fail"]
VerifiedStream = Literal["L1_QUOTE", "LAST_TRADE"]

MAX_RECORDED_GAPS = 100
MAX_RECORDED_DIAGNOSTICS = 100
NS_PER_MS = 1_000_000


@dataclass(frozen=True)
class GapThresholds:
    l1_quote_warning_ms: int = 1_000
    l1_quote_fail_ms: int = 5_000
    last_trade_warning_ms: int = 60_000
    last_trade_fail_ms: int = 300_000


@dataclass(frozen=True)
class GapDiagnostic:
    stream: VerifiedStream
    previous_exchange_event_ts_ns: str
    current_exchange_event_ts_ns: str
    gap_ms: float
    severity: GapSeverity
    reason_code: str
    record_count_at_gap: int
    sidecar_recv_ts_ns: str | None
    partial_parity_status: str


@dataclass(frozen=True)
class StreamGapSummary:
    record_count: int
    observed_interval_count: int
    gap_count: int
    gaps_over_threshold: int
    max_gap_ms: float
    last_exchange_event_ts_ns: str | None


@dataclass(frozen=True)
class L1TradeGapReport:
    status: GapReportStatus
    streams_checked: list[VerifiedStream]
    quote_gap_count: int
    trade_gap_count: int
    max_quote_gap_ms: float
    max_trade_gap_ms: float
    warning_count: int
    fail_count: int
    input_rows: int
    skipped_mbp10_rows: int
    skipped_mbo_rows: int
    skipped_null_exchange_ts_rows: int
    diagnostic_count: int
    diagnostic_counts: dict[str, int]
    diagnostics: list[dict[str, Any]]
    diagnostics_truncated: bool
    gaps: list[dict[str, Any]]
    gaps_truncated: bool
    thresholds: dict[str, int]
    stream_summaries: dict[VerifiedStream, dict[str, Any]]
    partial_parity_status: str
    data01_full_gate_status: str
    data01b_status: str


@dataclass
class _MutableStreamState:
    record_count: int = 0
    observed_interval_count: int = 0
    gap_count: int = 0
    gaps_over_threshold: int = 0
    max_gap_ms: float = 0.0
    last_exchange_event_ts_ns: int | None = None


class L1TradeGapDetector:
    def __init__(self, thresholds: GapThresholds | None = None) -> None:
        self.thresholds = thresholds or GapThresholds()
        self._states: dict[VerifiedStream, _MutableStreamState] = {
            "L1_QUOTE": _MutableStreamState(),
            "LAST_TRADE": _MutableStreamState(),
        }
        self.warning_count = 0
        self.fail_count = 0
        self._gaps: list[GapDiagnostic] = []
        self._gap_count = 0

    @property
    def gaps_truncated(self) -> bool:
        return self._gap_count > len(self._gaps)

    def observe(
        self,
        *,
        stream: VerifiedStream,
        exchange_event_ts_ns: str,
        sidecar_recv_ts_ns: str | None,
    ) -> None:
        current_ts_ns = int(exchange_event_ts_ns)
        state = self._states[stream]
        state.record_count += 1
        record_count_at_gap = state.record_count

        if state.last_exchange_event_ts_ns is None:
            state.last_exchange_event_ts_ns = current_ts_ns
            return

        previous_ts_ns = state.last_exchange_event_ts_ns
        state.last_exchange_event_ts_ns = current_ts_ns
        delta_ns = current_ts_ns - previous_ts_ns
        if delta_ns < 0:
            self._record_gap(
                GapDiagnostic(
                    stream=stream,
                    previous_exchange_event_ts_ns=str(previous_ts_ns),
                    current_exchange_event_ts_ns=str(current_ts_ns),
                    gap_ms=round(delta_ns / NS_PER_MS, 6),
                    severity="warning",
                    reason_code=_reason_code(stream, "timestamp_decrease"),
                    record_count_at_gap=record_count_at_gap,
                    sidecar_recv_ts_ns=sidecar_recv_ts_ns,
                    partial_parity_status=DATA01A_PARTIAL_PARITY_STATUS,
                )
            )
            self.warning_count += 1
            return

        state.observed_interval_count += 1
        gap_ms = round(delta_ns / NS_PER_MS, 6)
        state.gap_count += 1
        state.max_gap_ms = max(state.max_gap_ms, gap_ms)

        severity = _gap_severity(stream, gap_ms, self.thresholds)
        if severity == "info":
            return

        state.gaps_over_threshold += 1
        if severity == "warning":
            self.warning_count += 1
        else:
            self.fail_count += 1
        self._record_gap(
            GapDiagnostic(
                stream=stream,
                previous_exchange_event_ts_ns=str(previous_ts_ns),
                current_exchange_event_ts_ns=str(current_ts_ns),
                gap_ms=gap_ms,
                severity=severity,
                reason_code=_reason_code(stream, severity),
                record_count_at_gap=record_count_at_gap,
                sidecar_recv_ts_ns=sidecar_recv_ts_ns,
                partial_parity_status=DATA01A_PARTIAL_PARITY_STATUS,
            )
        )

    def to_report(
        self,
        *,
        input_rows: int,
        diagnostic_count: int,
        diagnostic_counts: dict[str, int],
        diagnostics: list[NormalizationDiagnostic],
        skipped_mbp10_rows: int,
        skipped_mbo_rows: int,
        skipped_null_exchange_ts_rows: int,
    ) -> L1TradeGapReport:
        quote_summary = self._summary("L1_QUOTE")
        trade_summary = self._summary("LAST_TRADE")
        status: GapReportStatus = "pass"
        if self.fail_count > 0:
            status = "fail"
        elif self.warning_count > 0:
            status = "warning"

        return L1TradeGapReport(
            status=status,
            streams_checked=["L1_QUOTE", "LAST_TRADE"],
            quote_gap_count=quote_summary.gaps_over_threshold,
            trade_gap_count=trade_summary.gaps_over_threshold,
            max_quote_gap_ms=quote_summary.max_gap_ms,
            max_trade_gap_ms=trade_summary.max_gap_ms,
            warning_count=self.warning_count,
            fail_count=self.fail_count,
            input_rows=input_rows,
            skipped_mbp10_rows=skipped_mbp10_rows,
            skipped_mbo_rows=skipped_mbo_rows,
            skipped_null_exchange_ts_rows=skipped_null_exchange_ts_rows,
            diagnostic_count=diagnostic_count,
            diagnostic_counts=dict(sorted(diagnostic_counts.items())),
            diagnostics=[asdict(diagnostic) for diagnostic in diagnostics],
            diagnostics_truncated=diagnostic_count > len(diagnostics),
            gaps=[asdict(gap) for gap in self._gaps],
            gaps_truncated=self.gaps_truncated,
            thresholds=asdict(self.thresholds),
            stream_summaries={
                "L1_QUOTE": asdict(quote_summary),
                "LAST_TRADE": asdict(trade_summary),
            },
            partial_parity_status=DATA01A_PARTIAL_PARITY_STATUS,
            data01_full_gate_status=DATA01A_FULL_GATE_STATUS,
            data01b_status=DATA01B_STATUS,
        )

    def _summary(self, stream: VerifiedStream) -> StreamGapSummary:
        state = self._states[stream]
        return StreamGapSummary(
            record_count=state.record_count,
            observed_interval_count=state.observed_interval_count,
            gap_count=state.gap_count,
            gaps_over_threshold=state.gaps_over_threshold,
            max_gap_ms=state.max_gap_ms,
            last_exchange_event_ts_ns=(
                None if state.last_exchange_event_ts_ns is None else str(state.last_exchange_event_ts_ns)
            ),
        )

    def _record_gap(self, gap: GapDiagnostic) -> None:
        self._gap_count += 1
        if len(self._gaps) < MAX_RECORDED_GAPS:
            self._gaps.append(gap)


def analyze_l1_trade_gaps_from_probe(
    *,
    input_path: Path,
    thresholds: GapThresholds | None = None,
) -> L1TradeGapReport:
    detector = L1TradeGapDetector(thresholds)
    diagnostics: list[NormalizationDiagnostic] = []
    diagnostic_counts: dict[str, int] = {}
    diagnostic_count = 0
    input_rows = 0
    skipped_mbp10_rows = 0
    skipped_mbo_rows = 0
    skipped_null_exchange_ts_rows = 0
    normalizer = RithmicL1TradeNormalizer()

    with input_path.open("r", encoding="utf-8", errors="replace") as source:
        for line_number, line in enumerate(source, 1):
            if line.strip() == "":
                continue
            input_rows += 1
            row = json.loads(line)
            if not isinstance(row, dict):
                diagnostic_count = _record_normalization_diagnostic(
                    diagnostics,
                    diagnostic_counts,
                    diagnostic_count,
                    NormalizationDiagnostic(line_number, "missing", "row_not_object"),
                )
                continue

            normalized, diagnostic = normalizer.normalize_row(row, line_number=line_number)
            if diagnostic is not None:
                diagnostic_count = _record_normalization_diagnostic(
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

            detector.observe(
                stream="L1_QUOTE" if normalized.event_type == "QUOTE" else "LAST_TRADE",
                exchange_event_ts_ns=normalized.ts_ns,
                sidecar_recv_ts_ns=_optional_decimal_string(normalized.payload.get("sidecar_recv_ts_ns")),
            )

    return detector.to_report(
        input_rows=input_rows,
        diagnostic_count=diagnostic_count,
        diagnostic_counts=diagnostic_counts,
        diagnostics=diagnostics,
        skipped_mbp10_rows=skipped_mbp10_rows,
        skipped_mbo_rows=skipped_mbo_rows,
        skipped_null_exchange_ts_rows=skipped_null_exchange_ts_rows,
    )


def write_gap_report(report_path: Path, report: L1TradeGapReport) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(asdict(report), sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _record_normalization_diagnostic(
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


def _gap_severity(stream: VerifiedStream, gap_ms: float, thresholds: GapThresholds) -> GapSeverity:
    if stream == "L1_QUOTE":
        if gap_ms >= thresholds.l1_quote_fail_ms:
            return "fail"
        if gap_ms >= thresholds.l1_quote_warning_ms:
            return "warning"
        return "info"

    if gap_ms >= thresholds.last_trade_fail_ms:
        return "fail"
    if gap_ms >= thresholds.last_trade_warning_ms:
        return "warning"
    return "info"


def _reason_code(stream: VerifiedStream, severity: str) -> str:
    if severity == "timestamp_decrease":
        return f"{stream.lower()}_exchange_timestamp_decrease"
    if stream == "L1_QUOTE":
        return f"l1_quote_feed_gap_{severity}"
    return f"last_trade_silence_{severity}"


def _optional_decimal_string(value: Any) -> str | None:
    if isinstance(value, int) and value >= 0:
        return str(value)
    if isinstance(value, str) and value.isdecimal():
        return value
    return None
