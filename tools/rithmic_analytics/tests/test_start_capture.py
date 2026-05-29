"""Tests for ``rithmic_analytics.cli.start_capture``.

Test strategy:
    - Time control: monkey-patch ``_now_et`` / ``_today_et`` to fixed ET datetimes.
    - Subprocess control: monkey-patch ``_spawn_probe`` to return a ``FakeProc``.
    - Sleep control: monkey-patch ``_sleep_until`` to a no-op so pre-window
      tests don't actually wait.

Covers acceptance criteria from RA-007:
    - Dry-run mode prints invocation without subprocess
    - Real run launches probe; exit-code translation per the contract
    - Session windows: 09:25-16:05 ET (RTH), 17:55-09:30 ET (Globex)
    - Output path uses trading-date convention (Globex spans midnight)
    - Pre-window sleep with cap; post-window no-op; late launch shortens duration
    - --contract-override audit logging
"""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from rithmic_analytics.cli import start_capture
from rithmic_analytics.cli.start_capture import (
    EXIT_BAD_CONFIG,
    EXIT_OK,
    EXIT_PROBE_ERRORS,
    EXIT_PROBE_PREFLIGHT,
    compute_session_window,
    compute_trading_date,
    main,
)

_ET = ZoneInfo("America/New_York")


class FakeProc:
    """Minimal Popen stand-in for tests."""

    def __init__(self, exit_code: int = 0) -> None:
        self._exit_code = exit_code
        self.pid = 9999
        self.terminated = False
        self.killed = False
        self.cmd: list[str] | None = None
        self.log_path: Path | None = None

    def wait(self, timeout: float | None = None) -> int:  # noqa: ARG002
        return self._exit_code

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True

    def poll(self) -> int | None:
        return self._exit_code


@pytest.fixture(autouse=True)
def _stub_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """Provide RITHMIC_* env vars so load_credentials() succeeds in every test."""
    monkeypatch.setenv("RITHMIC_CONNECT_POINT", "test-cp")
    monkeypatch.setenv("RITHMIC_SYSTEM_NAME", "test-sys")
    monkeypatch.setenv("RITHMIC_USER", "test-user")
    monkeypatch.setenv("RITHMIC_PASSWORD", "test-pw")
    monkeypatch.setenv("RITHMIC_RPROTOCOL_HOME", "/opt/rp-test")


@pytest.fixture
def fake_today_2026_05_15(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin _today_et() to 2026-05-15 (a Friday, MNQM6 is front-month)."""
    monkeypatch.setattr(start_capture, "_today_et", lambda: date(2026, 5, 15))


def _pin_now(monkeypatch: pytest.MonkeyPatch, dt: datetime) -> None:
    """Pin _now_et() to a fixed ET datetime, plus _today_et() to its date."""
    monkeypatch.setattr(start_capture, "_now_et", lambda: dt)
    monkeypatch.setattr(start_capture, "_today_et", lambda: dt.date())


def _inject_fake_proc(monkeypatch: pytest.MonkeyPatch, exit_code: int = 0) -> FakeProc:
    """Replace _spawn_probe with a fake; return the FakeProc for assertions."""
    fake = FakeProc(exit_code=exit_code)

    def _fake_spawn(cmd: list[str], log_path: Path) -> Any:
        fake.cmd = list(cmd)
        fake.log_path = log_path
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.touch()
        return fake

    monkeypatch.setattr(start_capture, "_spawn_probe", _fake_spawn)
    # Silence signal-handler install in tests (signal.signal raises in non-main thread)
    monkeypatch.setattr(start_capture, "_install_sigint_handler", lambda proc: None)
    return fake


# ---------------------------------------------------------------------------
# Pure helpers — trading date + session window
# ---------------------------------------------------------------------------


def test_trading_date_rth_is_current_day() -> None:
    et_morning = datetime(2026, 5, 15, 9, 25, tzinfo=_ET)
    assert compute_trading_date(et_morning, "rth") == date(2026, 5, 15)


def test_trading_date_globex_pm_launch_is_next_day() -> None:
    et_evening = datetime(2026, 5, 14, 23, 0, tzinfo=_ET)
    # Globex started 5/14 23:00 → ends 5/15 09:30 → trading day = 5/15.
    assert compute_trading_date(et_evening, "globex") == date(2026, 5, 15)


def test_trading_date_globex_am_launch_is_same_day() -> None:
    et_dawn = datetime(2026, 5, 15, 6, 0, tzinfo=_ET)
    # AM launch of an in-progress Globex job → 5/15 morning still belongs to 5/15.
    assert compute_trading_date(et_dawn, "globex") == date(2026, 5, 15)


def test_compute_session_window_rth() -> None:
    start, end = compute_session_window(date(2026, 5, 15), "rth")
    assert start == datetime(2026, 5, 15, 9, 25, tzinfo=_ET)
    assert end == datetime(2026, 5, 15, 16, 5, tzinfo=_ET)


def test_compute_session_window_globex_spans_midnight() -> None:
    start, end = compute_session_window(date(2026, 5, 15), "globex")
    assert start == datetime(2026, 5, 14, 17, 55, tzinfo=_ET)
    assert end == datetime(2026, 5, 15, 9, 30, tzinfo=_ET)


def test_compute_session_window_unknown_session_raises() -> None:
    with pytest.raises(ValueError):
        compute_session_window(date(2026, 5, 15), "asia")


# ---------------------------------------------------------------------------
# Dry-run
# ---------------------------------------------------------------------------


def test_dry_run_does_not_invoke_subprocess(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Pin now to a moment inside RTH window so we don't trip pre/post-window logic.
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))
    spawned = False

    def _fail_spawn(cmd: list[str], log_path: Path) -> Any:  # noqa: ARG001
        nonlocal spawned
        spawned = True
        raise AssertionError("dry-run must not spawn the probe")

    monkeypatch.setattr(start_capture, "_spawn_probe", _fail_spawn)

    rc = main(
        [
            "--root-symbol", "MNQ",
            "--session", "rth",
            "--captures-root", str(tmp_path),
            "--dry-run",
        ]
    )

    assert rc == EXIT_OK
    assert not spawned


# ---------------------------------------------------------------------------
# --parity-payload (RA-029)
# ---------------------------------------------------------------------------


def test_parity_payload_default_on_in_probe_cmd(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Default invocation includes --parity-payload in the resolved probe command."""
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    rc = main(
        [
            "--root-symbol", "MNQ",
            "--session", "rth",
            "--captures-root", str(tmp_path),
        ]
    )

    assert rc == EXIT_OK
    assert fake.cmd is not None
    assert "--parity-payload" in fake.cmd


def test_no_parity_payload_omits_flag_and_warns(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """--no-parity-payload drops the flag from the probe cmd and logs a WARN."""
    import logging as _logging
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    with caplog.at_level(_logging.WARNING, logger="rithmic_analytics.start_capture"):
        rc = main(
            [
                "--root-symbol", "MNQ",
                "--session", "rth",
                "--captures-root", str(tmp_path),
                "--no-parity-payload",
            ]
        )

    assert rc == EXIT_OK
    assert fake.cmd is not None
    assert "--parity-payload" not in fake.cmd
    assert any("metadata-only" in r.message for r in caplog.records)


def test_parity_payload_appears_in_dry_run_invocation_line(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Dry-run log line shows --parity-payload by default — operator audit trail."""
    import logging as _logging
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))

    with caplog.at_level(_logging.INFO, logger="rithmic_analytics.start_capture"):
        rc = main(
            [
                "--root-symbol", "MNQ",
                "--session", "rth",
                "--captures-root", str(tmp_path),
                "--dry-run",
            ]
        )

    assert rc == EXIT_OK
    invocation_lines = [r.message for r in caplog.records if "DRY-RUN: would invoke" in r.message]
    assert invocation_lines
    assert "--parity-payload" in invocation_lines[0]


# ---------------------------------------------------------------------------
# Happy path: in-window launch
# ---------------------------------------------------------------------------


def test_rth_launch_in_window_invokes_probe(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _pin_now(monkeypatch, datetime(2026, 5, 15, 9, 30, tzinfo=_ET))
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_OK
    assert fake.cmd is not None
    # Resolved contract should be MNQM6 on 2026-05-15
    assert "MNQM6" in fake.cmd
    # Output path should be data/captures/2026-05-15/MNQ_rth.jsonl under tmp_path
    expected_out = tmp_path / "2026-05-15" / "MNQ_rth.jsonl"
    assert str(expected_out) in fake.cmd


def test_output_path_trading_date_for_globex_at_23h(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Launched at 23:00 ET on 5/14 → trading day = 5/15 → folder 2026-05-15.
    _pin_now(monkeypatch, datetime(2026, 5, 14, 23, 0, tzinfo=_ET))
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    rc = main(["--root-symbol", "MNQ", "--session", "globex", "--captures-root", str(tmp_path)])

    assert rc == EXIT_OK
    assert fake.cmd is not None
    expected_out = tmp_path / "2026-05-15" / "MNQ_globex.jsonl"
    assert str(expected_out) in fake.cmd


# ---------------------------------------------------------------------------
# Exit code translation
# ---------------------------------------------------------------------------


def test_probe_exit_1_maps_to_wrapper_exit_1(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))
    _inject_fake_proc(monkeypatch, exit_code=1)

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_PROBE_ERRORS


def test_probe_exit_2_maps_to_wrapper_exit_3(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))
    _inject_fake_proc(monkeypatch, exit_code=2)

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_PROBE_PREFLIGHT


def test_probe_exit_130_maps_to_wrapper_exit_3(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))
    _inject_fake_proc(monkeypatch, exit_code=130)

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_PROBE_PREFLIGHT  # 130 is not 0 or 1 → treated as pre-flight failure


# ---------------------------------------------------------------------------
# Pre/post window edge cases
# ---------------------------------------------------------------------------


def test_post_window_launch_is_noop_exit_0(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Launched after RTH window closes (17:00 ET, window ends 16:05).
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 0, tzinfo=_ET))
    spawned = False

    def _fail_spawn(cmd: list[str], log_path: Path) -> Any:  # noqa: ARG001
        nonlocal spawned
        spawned = True
        raise AssertionError("post-window launch should not spawn probe")

    monkeypatch.setattr(start_capture, "_spawn_probe", _fail_spawn)

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_OK
    assert not spawned


def test_far_pre_window_launch_exits_bad_config(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # 30 min before RTH window-start (09:25). Cap is 600s = 10 min.
    _pin_now(monkeypatch, datetime(2026, 5, 15, 8, 55, tzinfo=_ET))
    spawned = False

    def _fail_spawn(cmd: list[str], log_path: Path) -> Any:  # noqa: ARG001
        nonlocal spawned
        spawned = True
        raise AssertionError("far-pre-window launch should not spawn")

    monkeypatch.setattr(start_capture, "_spawn_probe", _fail_spawn)

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_BAD_CONFIG
    assert not spawned


def test_within_cap_pre_window_launch_sleeps_then_runs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # 2 min before window-start. Should sleep then run.
    pinned_now = datetime(2026, 5, 15, 9, 23, tzinfo=_ET)
    _pin_now(monkeypatch, pinned_now)

    sleep_called_with: list[datetime] = []

    def _fake_sleep_until(target: datetime) -> None:
        sleep_called_with.append(target)
        # After "sleeping", advance time to window-start.
        new_now = datetime(2026, 5, 15, 9, 25, tzinfo=_ET)
        monkeypatch.setattr(start_capture, "_now_et", lambda: new_now)

    monkeypatch.setattr(start_capture, "_sleep_until", _fake_sleep_until)
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_OK
    assert len(sleep_called_with) == 1
    assert sleep_called_with[0] == datetime(2026, 5, 15, 9, 25, tzinfo=_ET)
    assert fake.cmd is not None


def test_late_launch_shortens_duration(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Launched 10 min into the RTH window. Window ends at 16:05.
    # 16:05 - 09:35 = 6h 30m = 23400s. Probe gets reduced duration.
    _pin_now(monkeypatch, datetime(2026, 5, 15, 9, 35, tzinfo=_ET))
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_OK
    assert fake.cmd is not None
    # Find --duration-sec arg
    duration_idx = fake.cmd.index("--duration-sec") + 1
    duration = int(fake.cmd[duration_idx])
    # Full RTH is 09:25→16:05 = 24000s. We launched 10min late → ≤ 23400s.
    assert duration <= 23400
    assert duration >= 23000  # ballpark


# ---------------------------------------------------------------------------
# Contract override
# ---------------------------------------------------------------------------


def test_contract_override_emits_audit_log(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    with caplog.at_level("WARNING"):
        rc = main(
            [
                "--root-symbol", "MNQ",
                "--session", "rth",
                "--captures-root", str(tmp_path),
                "--contract-override", "MNQU6",  # force next contract
            ]
        )

    assert rc == EXIT_OK
    # Audit line should be in the log
    audit_lines = [r.message for r in caplog.records if "rollover-override" in r.message]
    assert len(audit_lines) == 1
    assert "MNQU6" in audit_lines[0]
    assert "MNQM6" in audit_lines[0]  # resolved=
    assert "2026-05-15" in audit_lines[0]  # today=
    # And the probe gets MNQU6, not MNQM6
    assert fake.cmd is not None
    assert "MNQU6" in fake.cmd
    assert "MNQM6" not in fake.cmd


# ---------------------------------------------------------------------------
# Pre-flight errors
# ---------------------------------------------------------------------------


def test_missing_root_symbol_argparse_error(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(["--session", "rth", "--captures-root", str(tmp_path)])
    assert excinfo.value.code != 0


def test_missing_credentials_exits_bad_config(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Override the autouse stub by deleting one of the env vars
    monkeypatch.delenv("RITHMIC_PASSWORD")
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))

    rc = main(
        [
            "--root-symbol", "MNQ",
            "--session", "rth",
            "--captures-root", str(tmp_path),
            "--credentials-toml", str(tmp_path / "no.toml"),  # nonexistent
            "--dot-env-path", str(tmp_path / "no.env"),  # nonexistent (hermetic)
        ]
    )

    assert rc == EXIT_BAD_CONFIG


def test_unsupported_root_symbol_exits_bad_config(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))

    rc = main(["--root-symbol", "ES", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_BAD_CONFIG


def test_calendar_miss_exits_bad_config(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Pin today to a date before any calendar entry
    monkeypatch.setattr(start_capture, "_today_et", lambda: date(2025, 1, 1))
    monkeypatch.setattr(start_capture, "_now_et", lambda: datetime(2025, 1, 1, 10, 0, tzinfo=_ET))

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_BAD_CONFIG


# ---------------------------------------------------------------------------
# Wrapper.log file is created
# ---------------------------------------------------------------------------


def test_wrapper_log_created_alongside_jsonl(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_OK
    assert fake.log_path is not None
    assert fake.log_path.exists()
    assert fake.log_path.name == "wrapper.log"
    assert fake.log_path.parent == tmp_path / "2026-05-15"


# ---------------------------------------------------------------------------
# Exit codes are stable (RA-008/010 may key on them)
# ---------------------------------------------------------------------------


def test_exit_codes_stable() -> None:
    assert EXIT_OK == 0
    assert EXIT_PROBE_ERRORS == 1
    assert EXIT_BAD_CONFIG == 2
    assert EXIT_PROBE_PREFLIGHT == 3


# ---------------------------------------------------------------------------
# --override-duration-sec
# ---------------------------------------------------------------------------


def test_override_duration_sec_used_when_below_window(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Launched mid-RTH at 10:00 ET → computed window is ~21,900s remaining.
    # Override 300s should be used as-is.
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    rc = main(
        [
            "--root-symbol", "MNQ",
            "--session", "rth",
            "--captures-root", str(tmp_path),
            "--override-duration-sec", "300",
        ]
    )

    assert rc == EXIT_OK
    assert fake.cmd is not None
    duration_idx = fake.cmd.index("--duration-sec") + 1
    assert int(fake.cmd[duration_idx]) == 300


def test_override_duration_sec_clamped_when_above_window(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # Launched 10 min before window close. computed = ~600s. Override 99999 → clamped.
    _pin_now(monkeypatch, datetime(2026, 5, 15, 15, 55, tzinfo=_ET))
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    with caplog.at_level("WARNING"):
        rc = main(
            [
                "--root-symbol", "MNQ",
                "--session", "rth",
                "--captures-root", str(tmp_path),
                "--override-duration-sec", "99999",
            ]
        )

    assert rc == EXIT_OK
    assert fake.cmd is not None
    duration_idx = fake.cmd.index("--duration-sec") + 1
    duration = int(fake.cmd[duration_idx])
    # Window close is 16:05; launched at 15:55 → ~10 min = 600s remaining.
    assert duration <= 700  # clamped to window
    # Warning about clamping was logged
    assert any("clamping to window end" in r.message for r in caplog.records)


def test_override_duration_sec_omitted_uses_computed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _pin_now(monkeypatch, datetime(2026, 5, 15, 10, 0, tzinfo=_ET))
    fake = _inject_fake_proc(monkeypatch, exit_code=0)

    rc = main(["--root-symbol", "MNQ", "--session", "rth", "--captures-root", str(tmp_path)])

    assert rc == EXIT_OK
    assert fake.cmd is not None
    duration_idx = fake.cmd.index("--duration-sec") + 1
    duration = int(fake.cmd[duration_idx])
    # 16:05 - 10:00 = 6h 5min = 21900s. Computed window unchanged.
    assert duration > 21_000
    assert duration < 22_000
