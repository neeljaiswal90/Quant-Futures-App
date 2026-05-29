from __future__ import annotations

import os

import pytest

from realtime_backend.shutdown import EndDayShutdownService, ProcessInfo, ShutdownTarget


def test_shutdown_plan_targets_stack_and_capture_processes() -> None:
    processes = [
        ProcessInfo(10, "powershell.exe -File run_local_probe_refresh.ps1 -Session rth"),
        ProcessInfo(11, "python.exe -m notification_daemon.run --url ws://127.0.0.1:8765/ws"),
        ProcessInfo(12, "python.exe -m realtime_backend --port 8765"),
        ProcessInfo(13, "npm run dev -- --host 127.0.0.1"),
        ProcessInfo(14, "python.exe -m rithmic_analytics.cli.start_capture --root-symbol MNQ --session rth"),
        ProcessInfo(15, "python.exe D:\\Quant-futures-app\\scripts\\infra\\capture-rithmic-probe.py"),
        ProcessInfo(16, "python.exe unrelated.py"),
    ]
    service = EndDayShutdownService(
        process_provider=lambda: processes,
        port_pid_provider=lambda port: [17] if port == 5173 else [],
    )

    plan = service.build_plan()

    assert {(target.kind, target.pid) for target in plan} == {
        ("refresh_loop", 10),
        ("notification_daemon", 11),
        ("realtime_backend", 12),
        ("dashboard_ui", 13),
        ("rithmic_capture", 14),
        ("rithmic_capture", 15),
        ("dashboard_ui", 17),
    }


def test_shutdown_plan_dedupes_port_and_command_line_matches() -> None:
    service = EndDayShutdownService(
        process_provider=lambda: [ProcessInfo(20, "npm run dev -- --host 127.0.0.1")],
        port_pid_provider=lambda port: [20] if port == 5173 else [],
    )

    plan = service.build_plan()

    assert len(plan) == 1
    assert plan[0].pid == 20
    assert plan[0].kind == "dashboard_ui"


def test_execute_plan_terminates_self_last(monkeypatch: pytest.MonkeyPatch) -> None:
    terminated: list[int] = []
    self_pid = os.getpid()
    scheduled: list[int] = []

    service = EndDayShutdownService(
        process_provider=lambda: [],
        port_pid_provider=lambda _port: [],
        terminator=terminated.append,
    )
    monkeypatch.setattr("realtime_backend.shutdown.schedule_self_termination", scheduled.append)

    service.execute_plan(
        [
            ShutdownTarget(kind="realtime_backend", pid=self_pid, reason="self"),
            ShutdownTarget(kind="dashboard_ui", pid=30, reason="ui"),
        ]
    )

    assert terminated == [30]
    assert scheduled == [self_pid]


def test_shutdown_response_omits_command_lines() -> None:
    service = EndDayShutdownService(
        process_provider=lambda: [],
        port_pid_provider=lambda _port: [],
    )

    payload = service.response_payload(
        [ShutdownTarget(kind="rithmic_capture", pid=40, reason="probe")]
    )

    assert payload["status"] == "scheduled"
    assert payload["targets"] == [
        {"kind": "rithmic_capture", "pid": 40, "reason": "probe"}
    ]
