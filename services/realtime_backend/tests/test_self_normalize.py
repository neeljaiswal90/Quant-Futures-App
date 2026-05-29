"""RA-070: backend self-normalize flag wiring (off by default)."""

from __future__ import annotations

from pathlib import Path

from realtime_backend.settings import Settings
from realtime_backend.tests.fixtures.parity_fixture import build_parity_fixture
from realtime_backend.watcher import run_compute


def _obs01(capture_path: Path) -> Path:
    return capture_path.with_name(capture_path.name.removesuffix(".jsonl") + ".obs01.jsonl")


def _settings(analytics_root: Path, scratch: Path, fixture: object, *, self_normalize: bool) -> Settings:
    return Settings(
        analytics_root=analytics_root,
        scratch_dir=scratch / "dashboard",
        session_override=fixture.session,  # type: ignore[attr-defined]
        trading_date_override=fixture.trading_date,  # type: ignore[attr-defined]
        self_normalize=self_normalize,
    )


def test_self_normalize_off_does_not_create_obs01(tmp_path: Path) -> None:
    analytics_root = tmp_path / "analytics"
    fixture = build_parity_fixture(analytics_root)
    obs01 = _obs01(fixture.capture_path)
    assert not obs01.exists()  # fixture ships raw + hand mbo, no obs01
    settings = _settings(analytics_root, tmp_path / "off", fixture, self_normalize=False)
    result = run_compute(settings, now_pt=fixture.now_pt)
    assert result.signals is not None
    # Flag OFF (the default) -> the backend must NOT normalize; it reads the raw
    # trade fallback and leaves no obs01 behind.
    assert not obs01.exists()


def test_self_normalize_on_creates_obs01_from_raw(tmp_path: Path) -> None:
    analytics_root = tmp_path / "analytics"
    fixture = build_parity_fixture(analytics_root)
    obs01 = _obs01(fixture.capture_path)
    assert not obs01.exists()
    settings = _settings(analytics_root, tmp_path / "on", fixture, self_normalize=True)
    result = run_compute(settings, now_pt=fixture.now_pt)
    # Flag ON -> the backend ran the incremental normalize itself, materializing
    # the obs01 sibling from the raw capture with no external normalizer.
    assert obs01.exists()
    assert result.signals is not None
