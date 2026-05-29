"""Tests for ``rithmic_analytics.ops.rotation``."""

from __future__ import annotations

import gzip
import json
from datetime import date
from pathlib import Path

import pytest

from rithmic_analytics.ops.rotation import (
    RetentionPolicy,
    RotationAction,
    apply_rotation,
    default_archive_root,
    plan_rotation,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_jsonl(path: Path, lines: int = 10) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for i in range(lines):
            f.write(json.dumps({"i": i}) + "\n")


def _seed_capture_days(
    captures_root: Path,
    days: list[str],
    *,
    rth: bool = True,
    globex: bool = True,
    root_symbol: str = "MNQ",
) -> None:
    for d in days:
        if rth:
            _write_jsonl(captures_root / d / f"{root_symbol}_rth.jsonl", lines=50)
        if globex:
            _write_jsonl(captures_root / d / f"{root_symbol}_globex.jsonl", lines=30)


# ---------------------------------------------------------------------------
# Default archive root
# ---------------------------------------------------------------------------


def test_default_archive_root_is_sibling(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    assert default_archive_root(captures) == tmp_path / "captures_archive"


def test_default_archive_root_used_when_omitted(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    captures.mkdir()
    report = plan_rotation(captures, reference_date=date(2026, 5, 14))
    assert report.archive_root == tmp_path / "captures_archive"


# ---------------------------------------------------------------------------
# Planning — basic
# ---------------------------------------------------------------------------


def test_plan_empty_captures_returns_empty_actions(tmp_path: Path) -> None:
    report = plan_rotation(tmp_path / "captures", reference_date=date(2026, 5, 15))
    assert report.actions == []
    assert report.errors == []


def test_plan_two_days_keeps_both_raw(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-13", "2026-05-14"])

    report = plan_rotation(captures, reference_date=date(2026, 5, 14))

    keep_actions = [a for a in report.actions if a.action == "keep"]
    compress_actions = [a for a in report.actions if a.action == "compress"]
    # 2 days × 2 files each → 4 keep actions, 0 compress
    assert len(keep_actions) == 4
    assert len(compress_actions) == 0


def test_plan_three_days_compresses_oldest_atomically(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-12", "2026-05-13", "2026-05-14"])

    report = plan_rotation(captures, reference_date=date(2026, 5, 14))

    keep_actions = [a for a in report.actions if a.action == "keep"]
    compress_actions = [a for a in report.actions if a.action == "compress"]

    # 5/13 + 5/14 kept (2 × 2 files = 4); 5/12 compressed (2 files)
    assert len(keep_actions) == 4
    assert len(compress_actions) == 2

    # Atomicity: both files from 5/12 land in compress actions
    compressed_dirs = {a.path.parent.name for a in compress_actions}
    assert compressed_dirs == {"2026-05-12"}

    # Both files (RTH + Globex) included
    compressed_names = {a.path.name for a in compress_actions}
    assert compressed_names == {"MNQ_rth.jsonl", "MNQ_globex.jsonl"}


def test_plan_partial_day_counts_as_one_trading_day(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    # 5/12 has only RTH (partial day); 5/13 + 5/14 are full days
    _seed_capture_days(captures, ["2026-05-12"], globex=False)
    _seed_capture_days(captures, ["2026-05-13", "2026-05-14"])

    report = plan_rotation(captures, reference_date=date(2026, 5, 14))

    # Quota = 2 trading days → 5/13 and 5/14 kept, 5/12 compressed (one file)
    compress_actions = [a for a in report.actions if a.action == "compress"]
    assert len(compress_actions) == 1
    assert compress_actions[0].path.parent.name == "2026-05-12"


# ---------------------------------------------------------------------------
# Archive deletion
# ---------------------------------------------------------------------------


def test_old_archive_marked_for_deletion(tmp_path: Path) -> None:
    archive = tmp_path / "captures_archive"
    old = archive / "2026-05-01" / "MNQ_rth.jsonl.gz"
    old.parent.mkdir(parents=True)
    old.write_bytes(b"compressed_payload")

    report = plan_rotation(
        tmp_path / "captures",
        archive_root=archive,
        reference_date=date(2026, 5, 16),  # 15 days after — exceeds 14d hot window
    )

    delete_actions = [a for a in report.actions if a.action == "delete"]
    assert len(delete_actions) == 1
    assert delete_actions[0].path == old


def test_recent_archive_not_deleted(tmp_path: Path) -> None:
    archive = tmp_path / "captures_archive"
    recent = archive / "2026-05-10" / "MNQ_rth.jsonl.gz"
    recent.parent.mkdir(parents=True)
    recent.write_bytes(b"x")

    report = plan_rotation(
        tmp_path / "captures",
        archive_root=archive,
        reference_date=date(2026, 5, 15),  # 5 days — well within window
    )

    delete_actions = [a for a in report.actions if a.action == "delete"]
    assert delete_actions == []


def test_archive_boundary_inclusive_exclusive(tmp_path: Path) -> None:
    # Exactly compressed_hot_days old → kept; one day older → deleted.
    archive = tmp_path / "captures_archive"
    on_boundary = archive / "2026-05-01" / "MNQ_rth.jsonl.gz"
    just_past = archive / "2026-04-30" / "MNQ_rth.jsonl.gz"
    on_boundary.parent.mkdir(parents=True)
    just_past.parent.mkdir(parents=True)
    on_boundary.write_bytes(b"x")
    just_past.write_bytes(b"x")

    report = plan_rotation(
        tmp_path / "captures",
        archive_root=archive,
        reference_date=date(2026, 5, 15),  # 14 days from 5/1; 15 days from 4/30
    )

    deleted = {a.path for a in report.actions if a.action == "delete"}
    assert just_past in deleted
    assert on_boundary not in deleted


# ---------------------------------------------------------------------------
# Apply: compression behavior
# ---------------------------------------------------------------------------


def test_apply_compresses_old_days_and_unlinks_source(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-12", "2026-05-13", "2026-05-14"])
    archive = tmp_path / "captures_archive"

    report = apply_rotation(captures, archive_root=archive, reference_date=date(2026, 5, 14))

    assert report.errors == []
    # 5/12 raw files gone, archives present
    assert not (captures / "2026-05-12" / "MNQ_rth.jsonl").exists()
    assert not (captures / "2026-05-12" / "MNQ_globex.jsonl").exists()
    assert (archive / "2026-05-12" / "MNQ_rth.jsonl.gz").exists()
    assert (archive / "2026-05-12" / "MNQ_globex.jsonl.gz").exists()
    # 5/13 and 5/14 still raw
    assert (captures / "2026-05-13" / "MNQ_rth.jsonl").exists()
    assert (captures / "2026-05-14" / "MNQ_rth.jsonl").exists()


def test_apply_archives_are_valid_gzip_with_original_content(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-12", "2026-05-13", "2026-05-14"])
    archive = tmp_path / "captures_archive"

    apply_rotation(captures, archive_root=archive, reference_date=date(2026, 5, 14))

    archive_file = archive / "2026-05-12" / "MNQ_rth.jsonl.gz"
    with gzip.open(archive_file, "rt", encoding="utf-8") as f:
        lines = [json.loads(line) for line in f]
    assert len(lines) == 50  # _seed_capture_days uses 50 for rth
    assert lines[0]["i"] == 0
    assert lines[-1]["i"] == 49


def test_apply_is_idempotent_within_same_day(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-12", "2026-05-13", "2026-05-14"])
    archive = tmp_path / "captures_archive"

    first = apply_rotation(captures, archive_root=archive, reference_date=date(2026, 5, 14))
    second = apply_rotation(captures, archive_root=archive, reference_date=date(2026, 5, 14))

    assert first.errors == []
    assert second.errors == []
    # First run did the work; second has nothing left to compress
    compress_actions_second = [a for a in second.actions if a.action == "compress"]
    assert compress_actions_second == []


def test_apply_handles_leftover_tmp_file_from_prior_crash(tmp_path: Path) -> None:
    # Simulate a crash mid-compression: a stale .tmp file sits in archive_root.
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-12", "2026-05-13", "2026-05-14"])
    archive = tmp_path / "captures_archive"

    leftover = archive / "2026-05-12" / "MNQ_rth.jsonl.gz.tmp"
    leftover.parent.mkdir(parents=True)
    leftover.write_bytes(b"junk from prior crash")

    report = apply_rotation(captures, archive_root=archive, reference_date=date(2026, 5, 14))

    assert report.errors == []
    # Atomic rename clobbered the .tmp; final archive exists
    final = archive / "2026-05-12" / "MNQ_rth.jsonl.gz"
    assert final.exists()
    assert not leftover.exists()
    # Archive content is valid (not the junk)
    with gzip.open(final, "rt", encoding="utf-8") as f:
        first_record = json.loads(f.readline())
    assert first_record == {"i": 0}


def test_apply_continues_on_individual_file_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-12", "2026-05-13", "2026-05-14"])
    archive = tmp_path / "captures_archive"

    # Force a PermissionError on unlinking one specific file.
    failing_file = captures / "2026-05-12" / "MNQ_rth.jsonl"
    real_unlink = Path.unlink

    def mock_unlink(self: Path, missing_ok: bool = False) -> None:
        if self == failing_file:
            raise PermissionError("simulated read-only")
        return real_unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", mock_unlink)

    report = apply_rotation(captures, archive_root=archive, reference_date=date(2026, 5, 14))

    # One error recorded for the failing file
    assert len(report.errors) == 1
    assert "MNQ_rth.jsonl" in report.errors[0]
    # Other file in the same day still compressed + unlinked successfully
    assert (archive / "2026-05-12" / "MNQ_globex.jsonl.gz").exists()
    assert not (captures / "2026-05-12" / "MNQ_globex.jsonl").exists()


# ---------------------------------------------------------------------------
# Disk pressure (report-only)
# ---------------------------------------------------------------------------


def test_disk_usage_reported_in_plan(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    captures.mkdir()

    report = plan_rotation(captures, reference_date=date(2026, 5, 14))

    assert 0.0 <= report.disk_used_pct_before <= 100.0
    assert 0.0 <= report.disk_used_pct_after_projected <= 100.0


def test_disk_pressure_warning_threshold_emits_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Stub shutil.disk_usage to return 75% used (over default 70% warning)
    from collections import namedtuple

    DiskUsage = namedtuple("DiskUsage", ["total", "used", "free"])
    monkeypatch.setattr(
        "rithmic_analytics.ops.rotation.shutil.disk_usage",
        lambda _p: DiskUsage(total=1_000_000, used=750_000, free=250_000),
    )

    captures = tmp_path / "captures"
    captures.mkdir()
    report = plan_rotation(captures, reference_date=date(2026, 5, 14))

    assert any("WARNING" in w for w in report.warnings)
    assert report.disk_used_pct_before == pytest.approx(75.0)


def test_disk_pressure_fail_threshold_emits_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from collections import namedtuple

    DiskUsage = namedtuple("DiskUsage", ["total", "used", "free"])
    monkeypatch.setattr(
        "rithmic_analytics.ops.rotation.shutil.disk_usage",
        lambda _p: DiskUsage(total=1_000_000, used=900_000, free=100_000),
    )

    captures = tmp_path / "captures"
    captures.mkdir()
    report = plan_rotation(captures, reference_date=date(2026, 5, 14))

    assert any("FAIL" in w for w in report.warnings)


def test_apply_runs_even_with_disk_pressure_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Disk is FAIL-pressured. apply_rotation should still execute (deleting old
    # data is the fix). Verify via no special-case error.
    from collections import namedtuple

    DiskUsage = namedtuple("DiskUsage", ["total", "used", "free"])
    monkeypatch.setattr(
        "rithmic_analytics.ops.rotation.shutil.disk_usage",
        lambda _p: DiskUsage(total=1_000_000, used=900_000, free=100_000),
    )

    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-12", "2026-05-13", "2026-05-14"])
    archive = tmp_path / "captures_archive"

    report = apply_rotation(captures, archive_root=archive, reference_date=date(2026, 5, 14))

    # No errors; warnings present; old day actually compressed
    assert report.errors == []
    assert any("FAIL" in w for w in report.warnings)
    assert (archive / "2026-05-12" / "MNQ_rth.jsonl.gz").exists()


# ---------------------------------------------------------------------------
# RotationReport shape + serialization
# ---------------------------------------------------------------------------


def test_report_to_dict_is_json_serializable(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-14"])

    report = plan_rotation(captures, reference_date=date(2026, 5, 14))
    payload = report.to_dict()

    s = json.dumps(payload)
    parsed = json.loads(s)

    assert parsed["reference_date"] == "2026-05-14"
    assert isinstance(parsed["actions"], list)
    assert isinstance(parsed["warnings"], list)
    assert isinstance(parsed["errors"], list)


def test_report_action_to_dict_has_target_path() -> None:
    action = RotationAction(
        path=Path("captures") / "2026-05-12" / "MNQ_rth.jsonl",
        action="compress",
        reason="aging out",
        target_path=Path("archive") / "2026-05-12" / "MNQ_rth.jsonl.gz",
    )
    d = action.to_dict()
    assert d["action"] == "compress"
    # to_dict serializes Paths via str() — on Windows this is backslashes, on
    # POSIX forward slashes. Re-parse with Path() for cross-platform compare.
    assert d["target_path"] is not None
    assert Path(d["target_path"]) == action.target_path


def test_dataclasses_frozen() -> None:
    import dataclasses

    policy = RetentionPolicy()
    with pytest.raises(dataclasses.FrozenInstanceError):
        policy.keep_raw_rth_sessions = 99  # type: ignore[misc]

    action = RotationAction(path=Path("x"), action="keep", reason="")
    with pytest.raises(dataclasses.FrozenInstanceError):
        action.path = Path("y")  # type: ignore[misc]


def test_retention_policy_defaults_match_qfa() -> None:
    # Cross-reference with services/market_data_sidecar/retention.py defaults.
    # If QFA's source-of-truth changes, this test surfaces the drift.
    p = RetentionPolicy()
    assert p.keep_raw_rth_sessions == 2
    assert p.compressed_hot_days == 14
    assert p.disk_warning_used_pct == 70.0
    assert p.disk_fail_used_pct == 85.0


# ---------------------------------------------------------------------------
# Custom policy
# ---------------------------------------------------------------------------


def test_custom_policy_changes_quota(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15"])

    # Wider window: keep 4 days
    report = plan_rotation(
        captures,
        reference_date=date(2026, 5, 15),
        policy=RetentionPolicy(keep_raw_rth_sessions=4),
    )

    compress = [a for a in report.actions if a.action == "compress"]
    assert compress == []  # all 4 days kept


# ---------------------------------------------------------------------------
# Non-capture files are ignored
# ---------------------------------------------------------------------------


def test_wrapper_log_ignored(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-12", "2026-05-13", "2026-05-14"])
    # Wrapper.log lives in every day dir per RA-007
    (captures / "2026-05-12" / "wrapper.log").write_text("log content")

    report = plan_rotation(captures, reference_date=date(2026, 5, 14))

    paths = {a.path.name for a in report.actions}
    # wrapper.log is neither compressed nor deleted
    assert "wrapper.log" not in paths
    # Capture files are still planned
    assert "MNQ_rth.jsonl" in paths


def test_non_date_dir_ignored(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture_days(captures, ["2026-05-14"])
    # Random subdir that doesn't match YYYY-MM-DD
    (captures / "junk").mkdir()
    (captures / "junk" / "MNQ_rth.jsonl").write_text("noise")

    report = plan_rotation(captures, reference_date=date(2026, 5, 14))

    paths = {str(a.path) for a in report.actions}
    assert not any("junk" in p for p in paths)
