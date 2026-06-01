@echo off
setlocal
set REPO_ROOT=%~dp0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REPO_ROOT%scripts\launch_mnq_dashboard_shell.ps1" %*
if errorlevel 1 (
  echo.
  echo MNQ dashboard launch failed. Review the message above.
  pause
)
