"""Tests for ``rithmic_analytics.cli.rotate``."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rithmic_analytics.cli.rotate import EXIT_OK, main


def _write_jsonl(path: Path, n: int = 10) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for i in range(n):
            f.write(json.dumps({"i": i}) + "\n")


def test_dry_run_does_not_modify_files(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    captures = tmp_path / "captures"
    _write_jsonl(captures / "2026-05-12" / "MNQ_rth.jsonl")
    _write_jsonl(captures / "2026-05-13" / "MNQ_rth.jsonl")
    _write_jsonl(captures / "2026-05-14" / "MNQ_rth.jsonl")
    archive = tmp_path / "captures_archive"

    rc = main(
        [
            "--captures-root", str(captures),
            "--archive-root", str(archive),
            "--reference-date", "2026-05-14",
            "--dry-run",
        ]
    )

    assert rc == EXIT_OK
    # 5/12 raw file still exists (dry-run doesn't compress)
    assert (captures / "2026-05-12" / "MNQ_rth.jsonl").exists()
    # Archive dir not created
    assert not archive.exists()
    # Stdout contains a planned compress action
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    actions = payload["actions"]
    assert any(a["action"] == "compress" for a in actions)


def test_apply_compresses_old_days(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    captures = tmp_path / "captures"
    _write_jsonl(captures / "2026-05-12" / "MNQ_rth.jsonl")
    _write_jsonl(captures / "2026-05-13" / "MNQ_rth.jsonl")
    _write_jsonl(captures / "2026-05-14" / "MNQ_rth.jsonl")
    archive = tmp_path / "captures_archive"

    rc = main(
        [
            "--captures-root", str(captures),
            "--archive-root", str(archive),
            "--reference-date", "2026-05-14",
        ]
    )

    assert rc == EXIT_OK
    # 5/12 raw is gone, archived
    assert not (captures / "2026-05-12" / "MNQ_rth.jsonl").exists()
    assert (archive / "2026-05-12" / "MNQ_rth.jsonl.gz").exists()
    # Stdout includes the apply report (errors list empty)
    payload = json.loads(capsys.readouterr().out)
    assert payload["errors"] == []


def test_default_archive_root_is_sibling(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    captures = tmp_path / "captures"
    captures.mkdir()

    rc = main(
        [
            "--captures-root", str(captures),
            "--reference-date", "2026-05-14",
        ]
    )

    assert rc == EXIT_OK
    payload = json.loads(capsys.readouterr().out)
    assert payload["archive_root"].endswith("captures_archive")


def test_reference_date_argparse_format() -> None:
    # Bad date format → argparse error
    with pytest.raises(SystemExit) as excinfo:
        main(["--captures-root", "x", "--reference-date", "not-a-date"])
    assert excinfo.value.code != 0
