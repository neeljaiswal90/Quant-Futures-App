"""End-of-day shutdown orchestration for the local live dashboard stack.

This module deliberately targets only local process signatures used by the
dashboard stack and the Rithmic capture wrappers/probes. The endpoint that
uses it is an explicit operator action, not an automatic health behavior.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
from collections.abc import Callable, Iterable
from dataclasses import dataclass

_KIND_PRIORITY = {
    "rithmic_capture": 0,
    "refresh_loop": 1,
    "notification_daemon": 2,
    "dashboard_ui": 3,
    "stack_launcher": 4,
    "realtime_backend": 5,
}


@dataclass(frozen=True)
class ProcessInfo:
    """Minimal process view needed for local shutdown targeting."""

    pid: int
    command_line: str


@dataclass(frozen=True)
class ShutdownTarget:
    """One process selected for end-of-day termination."""

    kind: str
    pid: int
    reason: str


class EndDayShutdownService:
    """Find and stop the dashboard stack plus active Rithmic capture processes."""

    def __init__(
        self,
        *,
        backend_port: int = 8765,
        ui_port: int = 5173,
        process_provider: Callable[[], Iterable[ProcessInfo]] | None = None,
        port_pid_provider: Callable[[int], Iterable[int]] | None = None,
        terminator: Callable[[int], None] | None = None,
    ) -> None:
        self.backend_port = backend_port
        self.ui_port = ui_port
        self._process_provider = process_provider or list_windows_processes
        self._port_pid_provider = port_pid_provider or list_listening_pids
        self._terminator = terminator or terminate_process_tree

    def build_plan(self) -> list[ShutdownTarget]:
        """Return the deduped ordered target list for an end-day shutdown."""

        targets: dict[int, ShutdownTarget] = {}
        for proc in self._process_provider():
            match = _classify_process(proc.command_line)
            if match is None:
                continue
            kind, reason = match
            targets[proc.pid] = ShutdownTarget(kind=kind, pid=proc.pid, reason=reason)

        for pid in self._port_pid_provider(self.ui_port):
            targets.setdefault(
                pid,
                ShutdownTarget(
                    kind="dashboard_ui",
                    pid=pid,
                    reason=f"listening on dashboard UI port {self.ui_port}",
                ),
            )
        for pid in self._port_pid_provider(self.backend_port):
            targets.setdefault(
                pid,
                ShutdownTarget(
                    kind="realtime_backend",
                    pid=pid,
                    reason=f"listening on backend port {self.backend_port}",
                ),
            )

        return sorted(
            targets.values(),
            key=lambda target: (
                target.pid == os.getpid(),
                _KIND_PRIORITY.get(target.kind, 99),
                target.pid,
            ),
        )

    def response_payload(self, targets: list[ShutdownTarget]) -> dict[str, object]:
        """Small JSON-safe summary; command lines stay out of the browser."""

        return {
            "status": "scheduled",
            "message": "End-day shutdown scheduled.",
            "targets": [
                {"kind": target.kind, "pid": target.pid, "reason": target.reason}
                for target in targets
            ],
        }

    def execute_plan(self, targets: list[ShutdownTarget]) -> None:
        """Terminate non-self targets first, then schedule this backend last."""

        self_pid = os.getpid()
        for target in targets:
            if target.pid == self_pid:
                continue
            self._terminator(target.pid)

        if any(target.pid == self_pid for target in targets):
            schedule_self_termination(self_pid)


def _classify_process(command_line: str) -> tuple[str, str] | None:
    cmd = command_line.lower()
    if "run_local_probe_refresh.ps1" in cmd:
        return ("refresh_loop", "local probe/dashboard refresh loop")
    if "notification_daemon.run" in cmd:
        return ("notification_daemon", "dashboard notification daemon")
    if "capture-rithmic-probe.py" in cmd:
        return ("rithmic_capture", "Rithmic probe capture process")
    if "rithmic_analytics.cli.start_capture" in cmd:
        return ("rithmic_capture", "Rithmic start_capture wrapper")
    if "run_live_realtime_stack.ps1" in cmd:
        return ("stack_launcher", "live realtime stack launcher")
    if "-m realtime_backend" in cmd or " live-realtime-backend" in cmd:
        return ("realtime_backend", "realtime backend process")
    if "npm run dev" in cmd or ("vite" in cmd and "dashboard_ui" in cmd):
        return ("dashboard_ui", "dashboard UI dev server")
    return None


def list_windows_processes() -> list[ProcessInfo]:
    """Read Windows process command lines via PowerShell/CIM."""

    script = (
        "Get-CimInstance Win32_Process | "
        "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    )
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", script],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    raw = completed.stdout.strip()
    if not raw:
        return []
    data = json.loads(raw)
    rows = data if isinstance(data, list) else [data]
    processes: list[ProcessInfo] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        pid = row.get("ProcessId")
        cmd = row.get("CommandLine")
        if isinstance(pid, int) and isinstance(cmd, str) and cmd.strip():
            processes.append(ProcessInfo(pid=pid, command_line=cmd))
    return processes


def list_listening_pids(port: int) -> list[int]:
    """Return unique process IDs listening on ``port`` using PowerShell."""

    script = (
        f"Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | "
        "Select-Object -ExpandProperty OwningProcess | "
        "Sort-Object -Unique | ConvertTo-Json -Compress"
    )
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", script],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )
    raw = completed.stdout.strip()
    if not raw:
        return []
    data = json.loads(raw)
    values = data if isinstance(data, list) else [data]
    return [pid for pid in values if isinstance(pid, int)]


def terminate_process_tree(pid: int) -> None:
    """Terminate a process tree; use taskkill on Windows and SIGTERM elsewhere."""

    if os.name == "nt":
        subprocess.run(
            ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
        )
        return
    os.kill(pid, signal.SIGTERM)


def schedule_self_termination(pid: int) -> None:
    """Give the HTTP response a moment to flush before ending this backend."""

    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.Popen(
            [
                "powershell.exe",
                "-NoProfile",
                "-Command",
                f"Start-Sleep -Milliseconds 700; Stop-Process -Id {pid} -Force",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        return
    subprocess.Popen(
        ["sh", "-c", f"sleep 0.7; kill -TERM {pid}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


__all__ = [
    "EndDayShutdownService",
    "ProcessInfo",
    "ShutdownTarget",
    "list_listening_pids",
    "list_windows_processes",
    "schedule_self_termination",
    "terminate_process_tree",
]
