<#
.SYNOPSIS
    Remove the five Rithmic-analytics scheduled tasks.

.DESCRIPTION
    Idempotent: silently skips tasks that don't exist. Does NOT touch capture
    data, archives, alerts, or environment variables — those are
    user-managed.

.EXAMPLE
    .\uninstall_scheduled_tasks.ps1

.NOTES
    Requires Administrator. To remove just one task manually:
        Unregister-ScheduledTask -TaskName RithmicHeartbeat -Confirm:$false
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()

$ErrorActionPreference = "Stop"

# Admin elevation
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Must run as Administrator. Right-click PowerShell -> Run as Administrator."
    exit 1
}

$taskNames = @(
    "RithmicCapture_RTH",
    "RithmicCapture_Globex",
    "RithmicDailyZones",
    "RithmicRotation",
    "RithmicHeartbeat"
)

foreach ($name in $taskNames) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
        if ($PSCmdlet.ShouldProcess($name, "Unregister scheduled task")) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "[removed] $name"
        }
    }
    else {
        Write-Host "[skip] $name (not registered)"
    }
}

Write-Host ""
Write-Host "Uninstall complete. Capture data and env vars are untouched."
