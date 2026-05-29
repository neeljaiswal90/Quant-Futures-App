<#
.SYNOPSIS
    Register the five Rithmic-analytics scheduled tasks.

.DESCRIPTION
    Pre-install gates (executed in order, hard-fail on any):
        1. Admin elevation
        2. Disk space >= MinFreeGB (default 250) on the captures drive
        3. `python -c "import rithmic_analytics"` exits 0
        4. RITHMIC_* env vars present (system-wide)
        5. Supports -WhatIf for dry-run

    Then registers five Windows Task Scheduler entries:
        - RithmicCapture_RTH      Mon-Fri 09:24
        - RithmicCapture_Globex   Sun-Thu 17:54
        - RithmicDailyZones       Mon-Fri 17:30
        - RithmicRotation         Daily   02:00
        - RithmicHeartbeat        Daily   10:00

    All times are interpreted in the LOCAL SYSTEM timezone. If the system is
    not set to America/New_York, adjust the times accordingly or change the
    system timezone before running. See docs/task_scheduler_setup.md.

.PARAMETER PythonPath
    Path to the python interpreter that has rithmic_analytics installed.
    Default: 'python' (resolves via PATH).

.PARAMETER WorkingDirectory
    Working directory each task runs from. Default: the rithmic_analytics
    project root (this script's grandparent).

.PARAMETER CapturesRoot
    Captures directory (for disk-space gate target). Default: data\captures.

.PARAMETER MinFreeGB
    Minimum free disk space, in GB, required to install. Default: 250.

.EXAMPLE
    # Dry-run (prints task definitions without registering)
    .\install_scheduled_tasks.ps1 -WhatIf

.EXAMPLE
    # Real install (requires elevated PowerShell)
    .\install_scheduled_tasks.ps1

.NOTES
    Idempotent: re-running overwrites existing tasks of the same name via
    Register-ScheduledTask -Force.

    Reboot behavior: -StartWhenAvailable is set on each task, so missed
    windows still fire when the system wakes (within Task Scheduler's
    default skew tolerance).
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$PythonPath = "python",
    [string]$WorkingDirectory = "",
    [string]$CapturesRoot = "data\captures",
    [int]$MinFreeGB = 250
)

$ErrorActionPreference = "Stop"

# ----- Defaults -----------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    # Resolve to project root (grandparent of this script: ops/.. -> rithmic_analytics root)
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $WorkingDirectory = Split-Path -Parent (Split-Path -Parent $scriptDir)
}

# ----- Pre-install gates --------------------------------------------------

# Gate 1: Admin elevation
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Must run as Administrator. Right-click PowerShell -> Run as Administrator."
    exit 1
}
Write-Host "[gate 1/5] Admin elevation: OK"

# Gate 2: Disk space
try {
    $capturesPath = Join-Path $WorkingDirectory $CapturesRoot
    $driveLetter = (Split-Path -Qualifier (Resolve-Path -LiteralPath $WorkingDirectory).Path).TrimEnd(':')
    $drive = Get-PSDrive -Name $driveLetter -ErrorAction Stop
    $freeGB = [math]::Round($drive.Free / 1GB, 1)
    if ($freeGB -lt $MinFreeGB) {
        Write-Error "Insufficient disk space on $driveLetter`: $freeGB GB free, $MinFreeGB GB required."
        exit 1
    }
    Write-Host "[gate 2/5] Disk space on $driveLetter`: $freeGB GB free (>= $MinFreeGB)"
}
catch {
    Write-Error "Disk space check failed: $_"
    exit 1
}

# Gate 3: Python environment
$pythonCheck = & $PythonPath -c "import rithmic_analytics; print(rithmic_analytics.__version__)" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Python environment check failed (exit $LASTEXITCODE): $pythonCheck"
    exit 1
}
Write-Host "[gate 3/5] Python env: rithmic_analytics version $pythonCheck"

# Gate 4: Rithmic env vars
$required = @(
    "RITHMIC_CONNECT_POINT", "RITHMIC_SYSTEM_NAME",
    "RITHMIC_USER", "RITHMIC_PASSWORD", "RITHMIC_RPROTOCOL_HOME"
)
$missing = @()
foreach ($v in $required) {
    $val = [Environment]::GetEnvironmentVariable($v, "Machine")
    if ([string]::IsNullOrEmpty($val)) {
        $val = [Environment]::GetEnvironmentVariable($v, "User")
    }
    if ([string]::IsNullOrEmpty($val)) {
        $val = [Environment]::GetEnvironmentVariable($v, "Process")
    }
    if ([string]::IsNullOrEmpty($val)) {
        $missing += $v
    }
}
if ($missing.Count -gt 0) {
    Write-Error ("Missing env vars: {0}. Set them via System Properties -> Environment Variables before installing." -f ($missing -join ', '))
    exit 1
}
Write-Host "[gate 4/5] Env vars: all 5 RITHMIC_* present"

# Gate 5: -WhatIf handled via SupportsShouldProcess below
Write-Host "[gate 5/5] WhatIf mode: $($WhatIfPreference -or $PSCmdlet.WhatIf)"

# ----- Task definitions ---------------------------------------------------

$tasks = @(
    @{
        Name      = "RithmicCapture_RTH"
        Arguments = "-m rithmic_analytics.cli.start_capture --root-symbol MNQ --session rth"
        Days      = @("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")
        Hour      = 9
        Minute    = 24
        Daily     = $false
    },
    @{
        Name      = "RithmicCapture_Globex"
        Arguments = "-m rithmic_analytics.cli.start_capture --root-symbol MNQ --session globex"
        Days      = @("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday")
        Hour      = 17
        Minute    = 54
        Daily     = $false
    },
    @{
        Name      = "RithmicDailyZones"
        Arguments = "-m rithmic_analytics.cli.daily_zones"
        Days      = @("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")
        Hour      = 17
        Minute    = 30
        Daily     = $false
    },
    @{
        Name      = "RithmicRotation"
        Arguments = "-m rithmic_analytics.cli.rotate"
        Days      = @()
        Hour      = 2
        Minute    = 0
        Daily     = $true
    },
    @{
        Name      = "RithmicHeartbeat"
        Arguments = "-m rithmic_analytics.cli.heartbeat"
        Days      = @()
        Hour      = 10
        Minute    = 0
        Daily     = $true
    }
)

# ----- Registration -------------------------------------------------------

foreach ($t in $tasks) {
    $triggerDesc = if ($t.Daily) {
        "Daily {0:D2}:{1:D2}" -f $t.Hour, $t.Minute
    }
    else {
        "{0} {1:D2}:{2:D2}" -f ($t.Days -join ',') , $t.Hour, $t.Minute
    }
    $cmdDesc = "$PythonPath $($t.Arguments)"

    if ($PSCmdlet.ShouldProcess($t.Name, "Register scheduled task ($triggerDesc → $cmdDesc)")) {
        $action = New-ScheduledTaskAction -Execute $PythonPath `
            -Argument $t.Arguments `
            -WorkingDirectory $WorkingDirectory

        $triggerTime = (Get-Date -Hour $t.Hour -Minute $t.Minute -Second 0)
        if ($t.Daily) {
            $trigger = New-ScheduledTaskTrigger -Daily -At $triggerTime
        }
        else {
            $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $t.Days -At $triggerTime
        }

        $settings = New-ScheduledTaskSettingsSet `
            -StartWhenAvailable `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Hours 16)

        $principal = New-ScheduledTaskPrincipal `
            -UserId $env:USERNAME `
            -LogonType S4U `
            -RunLevel Highest

        Register-ScheduledTask `
            -TaskName $t.Name `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -Principal $principal `
            -Force | Out-Null

        Write-Host "[registered] $($t.Name): $triggerDesc"
    }
}

Write-Host ""
Write-Host "Install complete. Verify with: schtasks /Query /TN RithmicCapture_RTH"
Write-Host "See docs/task_scheduler_setup.md for the manual test plan."
