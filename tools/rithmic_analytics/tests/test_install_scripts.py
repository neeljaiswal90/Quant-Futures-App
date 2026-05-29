"""PowerShell syntax-check smoke tests for the install/uninstall scripts.

We invoke ``powershell.exe`` (or ``pwsh``) and ask it to **parse** the
scripts without executing them. This catches typos, unclosed braces, bad
parameter declarations — the cheap "does it even parse?" gate.

Skipped if neither shell is available on PATH (CI / non-Windows). The actual
registration is gated by admin elevation inside the scripts themselves and
is not exercised here.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

_OPS_DIR = (
    Path(__file__).resolve().parents[1] / "rithmic_analytics" / "ops"
)
_INSTALL = _OPS_DIR / "install_scheduled_tasks.ps1"
_UNINSTALL = _OPS_DIR / "uninstall_scheduled_tasks.ps1"


def _powershell_exe() -> str | None:
    for cand in ("pwsh", "powershell"):
        if shutil.which(cand):
            return cand
    return None


_PWSH = _powershell_exe()


@pytest.mark.skipif(_PWSH is None, reason="no PowerShell available on PATH")
@pytest.mark.skipif(not _INSTALL.exists(), reason="install script not found")
def test_install_script_parses_without_error() -> None:
    assert _PWSH is not None  # for mypy
    cmd = [
        _PWSH,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        f"$null = [scriptblock]::Create((Get-Content -LiteralPath '{_INSTALL}' -Raw))",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, (
        f"PowerShell parse failed (exit {result.returncode}):\n"
        f"STDOUT: {result.stdout}\nSTDERR: {result.stderr}"
    )


@pytest.mark.skipif(_PWSH is None, reason="no PowerShell available on PATH")
@pytest.mark.skipif(not _UNINSTALL.exists(), reason="uninstall script not found")
def test_uninstall_script_parses_without_error() -> None:
    assert _PWSH is not None
    cmd = [
        _PWSH,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        f"$null = [scriptblock]::Create((Get-Content -LiteralPath '{_UNINSTALL}' -Raw))",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, (
        f"PowerShell parse failed (exit {result.returncode}):\n"
        f"STDOUT: {result.stdout}\nSTDERR: {result.stderr}"
    )
