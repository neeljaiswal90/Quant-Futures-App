<#
.SYNOPSIS
  Launch the v2 realtime dashboard stack (RA-068) on the local machine.

.DESCRIPTION
  Starts the three long-running processes that make up the realtime stack,
  each in its own window, and waits for the backend health endpoint:

    1. RA-060 WebSocket backend  (FastAPI/uvicorn)  -> ws://127.0.0.1:<port>/ws
    2. RA-061 dashboard UI       (Vite dev server)  -> http://127.0.0.1:5173
    3. RA-062 notification daemon (Windows toasts)  -> WS client of the backend

  Read-only decision support. This script does NOT touch credentials, the
  capture/refresh processes, or Task Scheduler. It only launches the v2
  consumer stack, which is strictly downstream of the capture siblings.

.PARAMETER Port
  Backend port (default 8765 — the same port the RA-067 mock uses, so the UI
  and daemon need no reconfiguration when swapping mock -> real backend).

.PARAMETER NoUi
  Skip the UI dev server (e.g. headless backend + daemon only).

.PARAMETER NoDaemon
  Skip the Windows notification daemon.

.PARAMETER Mock
  Launch the RA-067 mock emitter instead of the real RA-060 backend (for UI /
  daemon development against synthetic events).

.EXAMPLE
  .\run_realtime_stack.ps1
  .\run_realtime_stack.ps1 -Mock          # develop UI/daemon against the mock
  .\run_realtime_stack.ps1 -NoUi -NoDaemon
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [switch]$NoUi,
    [switch]$NoDaemon,
    [switch]$Mock
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
$Services = Join-Path $RepoRoot "services"
$UiDir = Join-Path $RepoRoot "apps\dashboard_ui"

function Start-Component {
    param([string]$Title, [string]$WorkDir, [string]$Command)
    Write-Host "  starting: $Title" -ForegroundColor Cyan
    # Each component runs in its own PowerShell window so logs are separable
    # and Ctrl-C in one doesn't kill the others.
    Start-Process -FilePath "powershell" -ArgumentList @(
        "-NoExit", "-Command",
        "Set-Location '$WorkDir'; `$host.UI.RawUI.WindowTitle='$Title'; $Command"
    ) | Out-Null
}

Write-Host "v2 realtime stack — launching" -ForegroundColor Green

# 1. Backend (or mock).
if ($Mock) {
    Start-Component -Title "ra067-mock" -WorkDir $RepoRoot `
        -Command "python -m contracts.realtime.mock_emitter"
    Write-Host "  (mock mode: synthetic events on port 8765)" -ForegroundColor Yellow
} else {
    Start-Component -Title "ra060-backend" -WorkDir $Services `
        -Command "python -m realtime_backend --host 127.0.0.1 --port $Port"
}

# 2. Wait for the backend /health before bringing up consumers.
$healthUrl = "http://127.0.0.1:$Port/health"
$deadline = (Get-Date).AddSeconds(30)
$ready = $false
Write-Host "  waiting for backend health at $healthUrl ..."
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($resp.status -eq "ok") { $ready = $true; break }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
if (-not $ready) {
    Write-Warning "backend health not confirmed within 30s — bringing up consumers anyway (they reconnect with backoff)."
} else {
    Write-Host "  backend healthy." -ForegroundColor Green
}

# 3. Notification daemon (CRITICAL Windows toasts).
if (-not $NoDaemon) {
    Start-Component -Title "ra062-daemon" -WorkDir $Services `
        -Command "python -m notification_daemon.run --url ws://127.0.0.1:$Port/ws"
}

# 4. UI dev server. Requires `npm install` to have been run in apps/dashboard_ui.
if (-not $NoUi) {
    if (-not (Test-Path (Join-Path $UiDir "node_modules"))) {
        Write-Warning "apps/dashboard_ui/node_modules missing — run 'npm install' there first; skipping UI."
    } else {
        Start-Component -Title "ra061-ui" -WorkDir $UiDir -Command "npm run dev"
    }
}

Write-Host ""
Write-Host "v2 realtime stack up:" -ForegroundColor Green
Write-Host "  backend  : http://127.0.0.1:$Port/health  (ws://127.0.0.1:$Port/ws)"
if (-not $NoUi)     { Write-Host "  UI       : http://127.0.0.1:5173" }
if (-not $NoDaemon) { Write-Host "  daemon   : CRITICAL Windows toasts (WS client)" }
Write-Host "Close each component's window to stop it."
