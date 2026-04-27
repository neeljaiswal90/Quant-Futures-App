"""DATA-06A session phase and warmup report for L1/trade rows."""

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
from services.market_data_sidecar.session.session_clock import (
    MnqSessionCalendar,
    SessionEvaluation,
    SessionPhase,
    WarmupPolicy,
    evaluate_mnq_session,
    load_mnq_session_calendar,
)

MAX_RECORDED_TRANSITIONS = 100
MAX_RECORDED_DIAGNOSTICS = 100


@dataclass(frozen=True)
class SessionPhaseTransition:
    previous_phase: SessionPhase | None
    phase: SessionPhase
    exchange_event_ts_ns: str
    sidecar_recv_ts_ns: str | None
    trading_date: str
    session_id: str
    candidate_eligible: bool
    warmup_suppressed: bool
    block_reason: str | None
    record_count_at_transition: int
    partial_parity_status: str


@dataclass(frozen=True)
class SessionWarmupReport:
    status: str
    input_rows: int
    verified_l1_trade_rows: int
    quote_rows: int
    trade_rows: int
    candidate_eligible_count: int
    blocked_count: int
    warmup_suppressed_count: int
    phase_counts: dict[str, int]
    block_reason_counts: dict[str, int]
    transition_count: int
    transitions: list[dict[str, Any]]
    transitions_truncated: bool
    skipped_mbp10_rows: int
    skipped_mbo_rows: int
    skipped_null_exchange_ts_rows: int
    diagnostic_count: int
    diagnostic_counts: dict[str, int]
    diagnostics: list[dict[str, Any]]
    diagnostics_truncated: bool
    warmup_seconds: int
    first_exchange_event_ts_ns: str | None
    last_exchange_event_ts_ns: str | None
    partial_parity_status: str
    data01_full_gate_status: str
    data01b_status: str


def analyze_l1_trade_session_warmup_from_probe(
    *,
    input_path: Path,
    calendar: MnqSessionCalendar | None = None,
    warmup_policy: WarmupPolicy | None = None,
) -> SessionWarmupReport:
    active_calendar = calendar or load_mnq_session_calendar()
    active_policy = warmup_policy or WarmupPolicy()
    diagnostics: list[NormalizationDiagnostic] = []
    diagnostic_counts: dict[str, int] = {}
    diagnostic_count = 0
    transitions: list[SessionPhaseTransition] = []
    transition_count = 0
    previous_phase: SessionPhase | None = None

    input_rows = 0
    verified_rows = 0
    quote_rows = 0
    trade_rows = 0
    candidate_eligible_count = 0
    blocked_count = 0
    warmup_suppressed_count = 0
    phase_counts: dict[str, int] = {}
    block_reason_counts: dict[str, int] = {}
    skipped_mbp10_rows = 0
    skipped_mbo_rows = 0
    skipped_null_exchange_ts_rows = 0
    first_exchange_event_ts_ns: str | None = None
    last_exchange_event_ts_ns: str | None = None
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

            verified_rows += 1
            if normalized.event_type == "QUOTE":
                quote_rows += 1
            else:
                trade_rows += 1

            evaluation = evaluate_mnq_session(
                normalized.ts_ns,
                calendar=active_calendar,
                warmup_policy=active_policy,
            )
            first_exchange_event_ts_ns = first_exchange_event_ts_ns or evaluation.exchange_event_ts_ns
            last_exchange_event_ts_ns = evaluation.exchange_event_ts_ns
            phase_counts[evaluation.session_phase] = phase_counts.get(evaluation.session_phase, 0) + 1
            if evaluation.candidate_eligible:
                candidate_eligible_count += 1
            else:
                blocked_count += 1
            if evaluation.warmup_suppressed:
                warmup_suppressed_count += 1
            if evaluation.block_reason is not None:
                block_reason_counts[evaluation.block_reason] = block_reason_counts.get(evaluation.block_reason, 0) + 1

            if previous_phase != evaluation.session_phase:
                transition_count += 1
                if len(transitions) < MAX_RECORDED_TRANSITIONS:
                    transitions.append(
                        _to_transition(
                            previous_phase=previous_phase,
                            evaluation=evaluation,
                            sidecar_recv_ts_ns=_optional_decimal_string(
                                normalized.payload.get("sidecar_recv_ts_ns")
                            ),
                            record_count_at_transition=verified_rows,
                        )
                    )
                previous_phase = evaluation.session_phase

    return SessionWarmupReport(
        status="pass",
        input_rows=input_rows,
        verified_l1_trade_rows=verified_rows,
        quote_rows=quote_rows,
        trade_rows=trade_rows,
        candidate_eligible_count=candidate_eligible_count,
        blocked_count=blocked_count,
        warmup_suppressed_count=warmup_suppressed_count,
        phase_counts=dict(sorted(phase_counts.items())),
        block_reason_counts=dict(sorted(block_reason_counts.items())),
        transition_count=transition_count,
        transitions=[asdict(transition) for transition in transitions],
        transitions_truncated=transition_count > len(transitions),
        skipped_mbp10_rows=skipped_mbp10_rows,
        skipped_mbo_rows=skipped_mbo_rows,
        skipped_null_exchange_ts_rows=skipped_null_exchange_ts_rows,
        diagnostic_count=diagnostic_count,
        diagnostic_counts=dict(sorted(diagnostic_counts.items())),
        diagnostics=[asdict(diagnostic) for diagnostic in diagnostics],
        diagnostics_truncated=diagnostic_count > len(diagnostics),
        warmup_seconds=active_policy.warmup_seconds,
        first_exchange_event_ts_ns=first_exchange_event_ts_ns,
        last_exchange_event_ts_ns=last_exchange_event_ts_ns,
        partial_parity_status=DATA01A_PARTIAL_PARITY_STATUS,
        data01_full_gate_status=DATA01A_FULL_GATE_STATUS,
        data01b_status=DATA01B_STATUS,
    )


def write_session_warmup_report(report_path: Path, report: SessionWarmupReport) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(asdict(report), sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _to_transition(
    *,
    previous_phase: SessionPhase | None,
    evaluation: SessionEvaluation,
    sidecar_recv_ts_ns: str | None,
    record_count_at_transition: int,
) -> SessionPhaseTransition:
    return SessionPhaseTransition(
        previous_phase=previous_phase,
        phase=evaluation.session_phase,
        exchange_event_ts_ns=evaluation.exchange_event_ts_ns,
        sidecar_recv_ts_ns=sidecar_recv_ts_ns,
        trading_date=evaluation.trading_date,
        session_id=evaluation.session_id,
        candidate_eligible=evaluation.candidate_eligible,
        warmup_suppressed=evaluation.warmup_suppressed,
        block_reason=evaluation.block_reason,
        record_count_at_transition=record_count_at_transition,
        partial_parity_status=evaluation.partial_parity_status,
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


def _optional_decimal_string(value: Any) -> str | None:
    if isinstance(value, int) and value >= 0:
        return str(value)
    if isinstance(value, str) and value.isdecimal():
        return value
    return None
