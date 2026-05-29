"""Capture-file rotation: compress old raw captures, delete old archives.

Trading-day granularity per architecture.md D-003: a "day" is a
``captures_root/YYYY-MM-DD/`` directory containing one or more
``<root>_{rth,globex}.jsonl`` files. All files in the same trading-day
directory are rotated atomically as a group — operators retrieving "raw data
from last 2 days" expect both RTH and Globex per day.

Retention policy values mirror QFA's ``L1TradeRetentionPolicy`` defaults per
architecture.md D-001 (we reuse the policy *values*, not the algorithm — our
session_id format and dual-session captures are incompatible with QFA's
scanner). The policy class is vendored locally rather than imported because
QFA has no installable package layout.

Disk thresholds in the policy are *report-only* here — ``apply_rotation`` runs
regardless of disk pressure, since deleting old data is the fix for high
usage. The report carries ``disk_used_pct_before`` plus
``disk_used_pct_after_projected`` (assuming a 5× compression ratio for raw →
gz) and ``warnings`` for RA-009 to consume.

Archive layout (sibling default to avoid glob crosstalk with live data):
    data/captures/YYYY-MM-DD/{root}_{session}.jsonl     — live
    data/captures_archive/YYYY-MM-DD/{root}_{session}.jsonl.gz — archived

Crash recovery: ``.tmp`` files left from an interrupted compress are
overwritten by the next run's atomic rename. The wrapper does not actively
scrub them — they are functionally orphaned but never read.
"""

from __future__ import annotations

import contextlib
import gzip
import logging
import re
import shutil
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Literal

_LOG = logging.getLogger("rithmic_analytics.rotation")

# Trading-day directory pattern: 2026-05-15
_TRADING_DAY_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Capture file pattern: MNQ_rth.jsonl, MNQ_globex.jsonl, future ES_rth.jsonl etc.
_CAPTURE_FILE_RE = re.compile(r"^[A-Z][A-Z0-9]*_(rth|globex)\.jsonl$")

# Conservative compression ratio for projected-usage math. Real ratios for our
# streams are 5–8× (MBO), 3–4× (MBP1), 6× (OBS-01); 5× is a defensive estimate.
_PROJECTED_COMPRESSION_RATIO: float = 5.0


@dataclass(frozen=True, slots=True)
class RetentionPolicy:
    """Retention thresholds — vendored from QFA ``L1TradeRetentionPolicy``.

    Field names and defaults intentionally match the source-of-truth at
    ``services/market_data_sidecar/retention.py`` so operators reading docs
    from either project see the same numbers. We do NOT import that dataclass
    because QFA has no pip-installable layout; if QFA's defaults change, the
    operational values here should be updated to match.

    Attributes:
        keep_raw_rth_sessions: Number of trading days to keep as raw JSONL.
            **Note**: QFA's name reflects their RTH-only scope; here it means
            "trading days" — both RTH and Globex files per day are kept or
            compressed together. Default 2.
        compressed_hot_days: Number of days to retain compressed archives
            before deletion. Default 14.
        disk_warning_used_pct: Used-percentage at which the report emits a
            disk-pressure warning. Default 70.0.
        disk_fail_used_pct: Used-percentage at which the report flags FAIL
            (rotation still runs). Default 85.0.
    """

    keep_raw_rth_sessions: int = 2
    compressed_hot_days: int = 14
    disk_warning_used_pct: float = 70.0
    disk_fail_used_pct: float = 85.0


@dataclass(frozen=True, slots=True)
class RotationAction:
    """One file-level retention action — plan or applied."""

    path: Path
    action: Literal["keep", "compress", "delete"]
    reason: str
    target_path: Path | None = None  # destination for compress; None otherwise

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "action": self.action,
            "reason": self.reason,
            "target_path": str(self.target_path) if self.target_path else None,
        }


@dataclass(frozen=True, slots=True)
class RotationReport:
    """Result of ``plan_rotation`` or ``apply_rotation``. JSON-serializable
    via ``to_dict()``.

    ``actions`` is plan output (or executed actions in apply mode).
    ``warnings`` carries non-fatal issues (disk pressure, missing dirs).
    ``errors`` carries per-file failures during apply (rotation continues).
    """

    reference_date: date
    captures_root: Path
    archive_root: Path
    actions: list[RotationAction] = field(default_factory=list)
    disk_used_pct_before: float = 0.0
    disk_used_pct_after_projected: float = 0.0
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "reference_date": self.reference_date.isoformat(),
            "captures_root": str(self.captures_root),
            "archive_root": str(self.archive_root),
            "actions": [a.to_dict() for a in self.actions],
            "disk_used_pct_before": self.disk_used_pct_before,
            "disk_used_pct_after_projected": self.disk_used_pct_after_projected,
            "warnings": list(self.warnings),
            "errors": list(self.errors),
        }


def default_archive_root(captures_root: Path) -> Path:
    """Sibling-directory default: ``data/captures`` → ``data/captures_archive``.

    Sibling (not nested) avoids glob crosstalk: ``captures_root/*/MNQ_*.jsonl``
    can never accidentally pick up archived ``.jsonl.gz`` files.
    """
    return captures_root.parent / f"{captures_root.name}_archive"


def _scan_trading_days(captures_root: Path) -> dict[date, list[Path]]:
    """Return ``{trading_date: [capture_files]}`` for properly-named day dirs."""
    result: dict[date, list[Path]] = {}
    if not captures_root.exists():
        return result
    for day_dir in sorted(captures_root.iterdir()):
        if not day_dir.is_dir():
            continue
        if not _TRADING_DAY_DIR_RE.match(day_dir.name):
            continue
        try:
            trading_day = date.fromisoformat(day_dir.name)
        except ValueError:
            continue
        files = sorted(
            f for f in day_dir.iterdir() if f.is_file() and _CAPTURE_FILE_RE.match(f.name)
        )
        if files:
            result[trading_day] = files
    return result


def _scan_archive_days(archive_root: Path) -> dict[date, list[Path]]:
    """Return ``{trading_date: [archive_files]}`` for archive day dirs."""
    result: dict[date, list[Path]] = {}
    if not archive_root.exists():
        return result
    for day_dir in sorted(archive_root.iterdir()):
        if not day_dir.is_dir():
            continue
        if not _TRADING_DAY_DIR_RE.match(day_dir.name):
            continue
        try:
            trading_day = date.fromisoformat(day_dir.name)
        except ValueError:
            continue
        files = sorted(
            f for f in day_dir.iterdir() if f.is_file() and f.name.endswith(".jsonl.gz")
        )
        if files:
            result[trading_day] = files
    return result


def _compute_disk_pressure(
    captures_root: Path,
    bytes_freed: int,
    policy: RetentionPolicy,
) -> tuple[float, float, list[str]]:
    """Return (used_pct_before, used_pct_after_projected, warnings)."""
    warnings: list[str] = []
    probe_path = captures_root if captures_root.exists() else captures_root.parent
    try:
        usage = shutil.disk_usage(probe_path)
    except OSError as exc:
        warnings.append(f"disk_usage check failed at {probe_path}: {exc}")
        return 0.0, 0.0, warnings

    used_before = usage.total - usage.free
    pct_before = used_before / usage.total * 100
    used_after = max(0, used_before - bytes_freed)
    pct_after = used_after / usage.total * 100

    if pct_after >= policy.disk_fail_used_pct:
        warnings.append(
            f"FAIL: projected disk usage {pct_after:.1f}% >= "
            f"{policy.disk_fail_used_pct}% fail threshold after rotation"
        )
    elif pct_after >= policy.disk_warning_used_pct:
        warnings.append(
            f"WARNING: projected disk usage {pct_after:.1f}% >= "
            f"{policy.disk_warning_used_pct}% warning threshold after rotation"
        )

    return pct_before, pct_after, warnings


def plan_rotation(
    captures_root: Path,
    *,
    archive_root: Path | None = None,
    reference_date: date | None = None,
    policy: RetentionPolicy | None = None,
) -> RotationReport:
    """Plan retention actions without mutating the filesystem.

    Args:
        captures_root: Directory containing per-trading-day subdirectories.
        archive_root: Where compressed archives live / will be written.
            Defaults to a sibling of ``captures_root`` named ``{name}_archive``.
        reference_date: "Today" for age calculations. Defaults to UTC date.
        policy: Retention thresholds. Defaults to ``RetentionPolicy()``.

    Returns:
        ``RotationReport`` with planned ``actions``, projected disk usage,
        and any warnings about disk pressure.
    """
    policy = policy or RetentionPolicy()
    archive_root = archive_root or default_archive_root(captures_root)
    reference_date = reference_date or datetime.now(UTC).date()

    capture_days = _scan_trading_days(captures_root)
    archive_days = _scan_archive_days(archive_root)

    actions: list[RotationAction] = []
    bytes_freed = 0

    # Newest trading days kept raw; older compressed.
    sorted_days = sorted(capture_days.keys(), reverse=True)
    keep_days = set(sorted_days[: policy.keep_raw_rth_sessions])

    for day, files in capture_days.items():
        if day in keep_days:
            for f in files:
                actions.append(
                    RotationAction(
                        path=f,
                        action="keep",
                        reason=f"within {policy.keep_raw_rth_sessions}-day raw window",
                    )
                )
        else:
            for f in files:
                target = archive_root / day.isoformat() / f"{f.name}.gz"
                try:
                    raw_size = f.stat().st_size
                except OSError:
                    raw_size = 0
                bytes_freed += int(raw_size * (1 - 1 / _PROJECTED_COMPRESSION_RATIO))
                actions.append(
                    RotationAction(
                        path=f,
                        action="compress",
                        reason=(
                            f"trading day older than "
                            f"{policy.keep_raw_rth_sessions}-day raw window"
                        ),
                        target_path=target,
                    )
                )

    # Archives older than compressed_hot_days → delete.
    for day, files in archive_days.items():
        age_days = (reference_date - day).days
        if age_days > policy.compressed_hot_days:
            for f in files:
                with contextlib.suppress(OSError):
                    bytes_freed += f.stat().st_size
                actions.append(
                    RotationAction(
                        path=f,
                        action="delete",
                        reason=(
                            f"archive age {age_days}d exceeds "
                            f"{policy.compressed_hot_days}d hot window"
                        ),
                    )
                )

    pct_before, pct_after, warnings = _compute_disk_pressure(captures_root, bytes_freed, policy)

    return RotationReport(
        reference_date=reference_date,
        captures_root=captures_root,
        archive_root=archive_root,
        actions=actions,
        disk_used_pct_before=pct_before,
        disk_used_pct_after_projected=pct_after,
        warnings=warnings,
    )


def apply_rotation(
    captures_root: Path,
    *,
    archive_root: Path | None = None,
    reference_date: date | None = None,
    policy: RetentionPolicy | None = None,
) -> RotationReport:
    """Execute the rotation plan. Per-file failures are reported but do not
    abort the run.

    Apply ordering: compress actions run before delete actions so that even
    if compression fails for one day, downstream archive deletions still
    proceed (they don't depend on the compressions).
    """
    plan = plan_rotation(
        captures_root,
        archive_root=archive_root,
        reference_date=reference_date,
        policy=policy,
    )

    errors: list[str] = []

    # Execute compresses first, then deletes.
    for action in sorted(plan.actions, key=lambda a: 0 if a.action == "compress" else 1):
        if action.action == "keep":
            continue
        try:
            if action.action == "compress":
                if action.target_path is None:
                    errors.append(f"compress: target_path missing for {action.path}")
                    continue
                _compress_atomic(action.path, action.target_path)
                action.path.unlink()
            elif action.action == "delete":
                action.path.unlink(missing_ok=True)
        except OSError as exc:
            errors.append(f"{action.action} failed for {action.path}: {exc}")

    return RotationReport(
        reference_date=plan.reference_date,
        captures_root=plan.captures_root,
        archive_root=plan.archive_root,
        actions=plan.actions,
        disk_used_pct_before=plan.disk_used_pct_before,
        disk_used_pct_after_projected=plan.disk_used_pct_after_projected,
        warnings=list(plan.warnings),
        errors=errors,
    )


def _compress_atomic(source: Path, target: Path) -> None:
    """Gzip-compress ``source`` to ``target`` via a ``.tmp`` rename.

    The rename is the atomic step — a partial write to ``.tmp`` left over from
    a crash gets overwritten by this run's open(..., "wb"). On success the
    rename replaces any existing target (idempotent within a day).
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    with source.open("rb") as src, gzip.open(tmp, "wb", compresslevel=6) as dst:
        shutil.copyfileobj(src, dst)
    tmp.replace(target)
