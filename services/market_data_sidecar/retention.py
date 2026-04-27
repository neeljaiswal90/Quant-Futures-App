"""DATA-05A deterministic retention planning for L1/trade journals.

This module handles only the DATA-01A verified surface. It plans and optionally
applies raw-journal compression/deletion using caller-provided reference session
metadata. No wall-clock reads are performed.
"""

from __future__ import annotations

import gzip
import json
import re
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Any, Literal

from services.market_data_sidecar.config import (
    DATA01A_FULL_GATE_STATUS,
    DATA01A_PARTIAL_PARITY_STATUS,
    DATA01B_STATUS,
)

RetentionActionType = Literal["keep_raw", "compress_raw", "delete_compressed", "skip"]
RetentionStatus = Literal["pass", "warning", "fail"]

L1_TRADE_EVENT_TYPES = frozenset({"QUOTE", "TRADE"})
SESSION_ID_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}-rth$")
ARCHIVE_SESSION_PATTERN = re.compile(r"(?P<session_id>\d{4}-\d{2}-\d{2}-rth)\.l1-trade\.jsonl\.gz$")


@dataclass(frozen=True)
class L1TradeRetentionPolicy:
    keep_raw_rth_sessions: int = 2
    compressed_hot_days: int = 14


@dataclass(frozen=True)
class RetentionDiagnostic:
    path: str
    reason: str


@dataclass(frozen=True)
class RetentionAction:
    action: RetentionActionType
    path: str
    session_id: str | None
    target_path: str | None
    reason: str


@dataclass(frozen=True)
class L1TradeRetentionReport:
    status: RetentionStatus
    mode: Literal["plan", "apply"]
    reference_session_id: str
    retained_raw_sessions: list[str]
    raw_journal_count: int
    compressed_journal_count: int
    keep_raw_count: int
    compress_raw_count: int
    delete_compressed_count: int
    skip_count: int
    actions: list[dict[str, Any]]
    diagnostics: list[dict[str, Any]]
    policy: dict[str, int]
    partial_parity_status: str
    data01_full_gate_status: str
    data01b_status: str


@dataclass(frozen=True)
class _RawJournal:
    path: Path
    session_id: str


@dataclass(frozen=True)
class _CompressedJournal:
    path: Path
    session_id: str


def plan_l1_trade_retention(
    *,
    journal_dir: Path,
    archive_dir: Path,
    reference_session_id: str,
    policy: L1TradeRetentionPolicy | None = None,
) -> L1TradeRetentionReport:
    active_policy = policy or L1TradeRetentionPolicy()
    _validate_session_id(reference_session_id)
    diagnostics: list[RetentionDiagnostic] = []
    actions: list[RetentionAction] = []
    raw_journals = _discover_raw_journals(journal_dir, diagnostics)
    compressed_journals = _discover_compressed_journals(archive_dir, diagnostics)
    retained_raw_sessions = _retained_sessions(raw_journals, reference_session_id, active_policy)

    retained_session_set = set(retained_raw_sessions)
    for journal in raw_journals:
        if journal.session_id in retained_session_set:
            actions.append(
                RetentionAction(
                    action="keep_raw",
                    path=_stable_path(journal.path),
                    session_id=journal.session_id,
                    target_path=None,
                    reason="current_or_prior_rth_session",
                )
            )
            continue
        target_path = archive_dir / f"{journal.session_id}.l1-trade.jsonl.gz"
        actions.append(
            RetentionAction(
                action="compress_raw",
                path=_stable_path(journal.path),
                session_id=journal.session_id,
                target_path=_stable_path(target_path),
                reason="raw_retention_exceeded",
            )
        )

    reference_date = _session_date(reference_session_id)
    for archive in compressed_journals:
        age_days = (reference_date - _session_date(archive.session_id)).days
        if age_days > active_policy.compressed_hot_days:
            actions.append(
                RetentionAction(
                    action="delete_compressed",
                    path=_stable_path(archive.path),
                    session_id=archive.session_id,
                    target_path=None,
                    reason="compressed_hot_retention_exceeded",
                )
            )

    actions = sorted(actions, key=lambda action: (action.action, action.session_id or "", action.path))
    return _to_report(
        mode="plan",
        reference_session_id=reference_session_id,
        retained_raw_sessions=retained_raw_sessions,
        raw_journal_count=len(raw_journals),
        compressed_journal_count=len(compressed_journals),
        actions=actions,
        diagnostics=diagnostics,
        policy=active_policy,
    )


def apply_l1_trade_retention(
    *,
    journal_dir: Path,
    archive_dir: Path,
    reference_session_id: str,
    policy: L1TradeRetentionPolicy | None = None,
) -> L1TradeRetentionReport:
    planned = plan_l1_trade_retention(
        journal_dir=journal_dir,
        archive_dir=archive_dir,
        reference_session_id=reference_session_id,
        policy=policy,
    )
    actions = [_action_from_dict(action) for action in planned.actions]
    archive_dir.mkdir(parents=True, exist_ok=True)

    for action in actions:
        if action.action == "compress_raw":
            if action.target_path is None:
                continue
            _compress_deterministic(Path(action.path), Path(action.target_path))
            Path(action.path).unlink()
        elif action.action == "delete_compressed":
            Path(action.path).unlink(missing_ok=True)

    return _to_report(
        mode="apply",
        reference_session_id=planned.reference_session_id,
        retained_raw_sessions=planned.retained_raw_sessions,
        raw_journal_count=planned.raw_journal_count,
        compressed_journal_count=planned.compressed_journal_count,
        actions=actions,
        diagnostics=[_diagnostic_from_dict(diagnostic) for diagnostic in planned.diagnostics],
        policy=policy or L1TradeRetentionPolicy(),
    )


def write_retention_report(report_path: Path, report: L1TradeRetentionReport) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(asdict(report), sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _discover_raw_journals(journal_dir: Path, diagnostics: list[RetentionDiagnostic]) -> list[_RawJournal]:
    if not journal_dir.exists():
        diagnostics.append(RetentionDiagnostic(_stable_path(journal_dir), "journal_dir_missing"))
        return []

    journals: list[_RawJournal] = []
    for path in sorted(journal_dir.glob("*.jsonl"), key=lambda item: item.as_posix()):
        journal = _classify_raw_journal(path, diagnostics)
        if journal is not None:
            journals.append(journal)
    return sorted(journals, key=lambda journal: (journal.session_id, _stable_path(journal.path)))


def _discover_compressed_journals(archive_dir: Path, diagnostics: list[RetentionDiagnostic]) -> list[_CompressedJournal]:
    if not archive_dir.exists():
        return []

    archives: list[_CompressedJournal] = []
    for path in sorted(archive_dir.glob("*.jsonl.gz"), key=lambda item: item.as_posix()):
        match = ARCHIVE_SESSION_PATTERN.search(path.name)
        if match is None:
            diagnostics.append(RetentionDiagnostic(_stable_path(path), "compressed_archive_missing_session_id"))
            continue
        session_id = match.group("session_id")
        _validate_session_id(session_id)
        archives.append(_CompressedJournal(path=path, session_id=session_id))
    return sorted(archives, key=lambda archive: (archive.session_id, _stable_path(archive.path)))


def _classify_raw_journal(path: Path, diagnostics: list[RetentionDiagnostic]) -> _RawJournal | None:
    session_id: str | None = None
    event_count = 0
    with path.open("r", encoding="utf-8", errors="replace") as source:
        for line_number, line in enumerate(source, 1):
            if line.strip() == "":
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                diagnostics.append(RetentionDiagnostic(_stable_path(path), f"malformed_json_line:{line_number}"))
                return None
            if not isinstance(row, dict):
                diagnostics.append(RetentionDiagnostic(_stable_path(path), f"row_not_object:{line_number}"))
                return None
            event_type = row.get("type")
            if event_type not in L1_TRADE_EVENT_TYPES:
                diagnostics.append(RetentionDiagnostic(_stable_path(path), f"non_l1_trade_event_type:{event_type}"))
                return None
            row_session_id = row.get("session_id")
            if not isinstance(row_session_id, str) or not SESSION_ID_PATTERN.match(row_session_id):
                diagnostics.append(RetentionDiagnostic(_stable_path(path), f"invalid_session_id:{line_number}"))
                return None
            if session_id is None:
                session_id = row_session_id
            elif session_id != row_session_id:
                diagnostics.append(RetentionDiagnostic(_stable_path(path), "mixed_session_ids"))
                return None
            event_count += 1

    if event_count == 0 or session_id is None:
        diagnostics.append(RetentionDiagnostic(_stable_path(path), "empty_journal"))
        return None
    return _RawJournal(path=path, session_id=session_id)


def _retained_sessions(
    raw_journals: list[_RawJournal],
    reference_session_id: str,
    policy: L1TradeRetentionPolicy,
) -> list[str]:
    reference_date = _session_date(reference_session_id)
    eligible_sessions = sorted(
        {
            journal.session_id
            for journal in raw_journals
            if _session_date(journal.session_id) <= reference_date
        },
        key=_session_date,
        reverse=True,
    )
    if reference_session_id not in eligible_sessions:
        eligible_sessions.insert(0, reference_session_id)
    return sorted(eligible_sessions[: policy.keep_raw_rth_sessions])


def _to_report(
    *,
    mode: Literal["plan", "apply"],
    reference_session_id: str,
    retained_raw_sessions: list[str],
    raw_journal_count: int,
    compressed_journal_count: int,
    actions: list[RetentionAction],
    diagnostics: list[RetentionDiagnostic],
    policy: L1TradeRetentionPolicy,
) -> L1TradeRetentionReport:
    status: RetentionStatus = "pass" if len(diagnostics) == 0 else "warning"
    return L1TradeRetentionReport(
        status=status,
        mode=mode,
        reference_session_id=reference_session_id,
        retained_raw_sessions=retained_raw_sessions,
        raw_journal_count=raw_journal_count,
        compressed_journal_count=compressed_journal_count,
        keep_raw_count=sum(1 for action in actions if action.action == "keep_raw"),
        compress_raw_count=sum(1 for action in actions if action.action == "compress_raw"),
        delete_compressed_count=sum(1 for action in actions if action.action == "delete_compressed"),
        skip_count=sum(1 for action in actions if action.action == "skip"),
        actions=[asdict(action) for action in actions],
        diagnostics=[asdict(diagnostic) for diagnostic in diagnostics],
        policy=asdict(policy),
        partial_parity_status=DATA01A_PARTIAL_PARITY_STATUS,
        data01_full_gate_status=DATA01A_FULL_GATE_STATUS,
        data01b_status=DATA01B_STATUS,
    )


def _compress_deterministic(source_path: Path, target_path: Path) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    data = source_path.read_bytes()
    temp_path = target_path.with_suffix(target_path.suffix + ".tmp")
    with temp_path.open("wb") as raw_output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw_output, mtime=0) as gzip_output:
            gzip_output.write(data)
    temp_path.replace(target_path)


def _action_from_dict(record: dict[str, Any]) -> RetentionAction:
    return RetentionAction(
        action=record["action"],
        path=record["path"],
        session_id=record.get("session_id"),
        target_path=record.get("target_path"),
        reason=record["reason"],
    )


def _diagnostic_from_dict(record: dict[str, Any]) -> RetentionDiagnostic:
    return RetentionDiagnostic(path=record["path"], reason=record["reason"])


def _validate_session_id(session_id: str) -> None:
    if not SESSION_ID_PATTERN.match(session_id):
        raise ValueError("session_id must match YYYY-MM-DD-rth")


def _session_date(session_id: str) -> date:
    _validate_session_id(session_id)
    return date.fromisoformat(session_id[:10])


def _stable_path(path: Path) -> str:
    return path.as_posix()
