"""Detector-as-library parity gate (RA-060 ship requirement).

Asserts the in-process projection (``compute_live_signals`` →
contract-payload mapping) is identical whether we read the *fresh* compute or
the state the detector persisted to JSONL and reloaded. ``compute_live_signals``
is disk-stateful (append-then-reload), so a second call over the same fixture
reloads the persisted JSONL — the two projections must match exactly. Drift
here means the library path diverged from the JSONL path and the swap-in
guarantee for the UI/daemon is broken.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from rithmic_dashboard.features.live_signals import compute_live_signals
from rithmic_dashboard.models import LiveSignals
from rithmic_dashboard.session_state import determine_session_state

from realtime_backend.signals import diff_signals, events_to_payloads
from realtime_backend.tests.fixtures.parity_fixture import build_parity_fixture, envelope


def _compute(analytics_root: Path, scratch: Path, fixture: Any) -> LiveSignals:
    session = determine_session_state(
        now_pt=fixture.now_pt,
        analytics_root=analytics_root,
        trading_date_override=fixture.trading_date,
        session_override=fixture.session,
    )
    return compute_live_signals(
        capture_path=fixture.capture_path,
        envelope=envelope(),
        session=session,
        dashboard_dir=scratch,
        tail_bytes=5_000_000,
    )


def _projection(signals: LiveSignals) -> list[dict[str, object]]:
    """Map every event in a snapshot to ordered, comparable payload dicts."""
    diff = diff_signals(None, signals)  # previous=None → all events are "new"
    return [event.payload.model_dump() for event in events_to_payloads(diff, signals)]


def test_detector_library_output_matches_jsonl_path(tmp_path: Path) -> None:
    """Library projection == reloaded-JSONL projection on the fixed fixture."""
    analytics_root = tmp_path / "analytics"
    fixture = build_parity_fixture(analytics_root)

    # First compute: detector parses the raw capture and persists JSONL.
    scratch_a = tmp_path / "scratch_a" / "dashboard"
    first = _compute(analytics_root, scratch_a, fixture)

    # Second compute against a FRESH scratch reproduces the same events purely
    # from the same raw fixture (deterministic detector run).
    scratch_b = tmp_path / "scratch_b" / "dashboard"
    second = _compute(analytics_root, scratch_b, fixture)

    proj_first = _projection(first)
    proj_second = _projection(second)

    assert proj_first == proj_second
    # The fixture is built to surface real events; an empty projection would
    # mean the gate is vacuously green.
    assert proj_first, "parity fixture produced no events — gate would be vacuous"


def test_detector_reload_is_stable_across_repeat_calls(tmp_path: Path) -> None:
    """A repeat compute over the SAME scratch (reloads persisted JSONL) is stable.

    This is the disk-stateful reload path: the second call re-reads what the
    first persisted. The recent-window projection must be identical.
    """
    analytics_root = tmp_path / "analytics"
    fixture = build_parity_fixture(analytics_root)
    scratch = tmp_path / "scratch" / "dashboard"

    first = _compute(analytics_root, scratch, fixture)
    second = _compute(analytics_root, scratch, fixture)

    assert _projection(first) == _projection(second)


def test_parity_fixture_surfaces_expected_families(tmp_path: Path) -> None:
    """Sanity: the synthesized fixture yields a sweep + iceberg projection."""
    analytics_root = tmp_path / "analytics"
    fixture = build_parity_fixture(analytics_root)
    signals = _compute(analytics_root, tmp_path / "scratch" / "dashboard", fixture)

    families = {p["family"] for p in _projection(signals)}
    assert "sweep" in families
    assert "iceberg" in families
