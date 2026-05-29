$ErrorActionPreference = "Continue"

$Root = "D:\Quant-futures-app\tools\rithmic_dashboard"
$Python = "C:\Users\Neel\AppData\Local\Programs\Python\Python312\python.exe"
$DashboardDir = Join-Path $Root "data\dashboard"
$OutputPath = "data\dashboard\index.html"
$PauseFlag = Join-Path $DashboardDir "_pause.flag"

New-Item -ItemType Directory -Path $DashboardDir -Force | Out-Null
$LogPath = Join-Path $DashboardDir ("generator_{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

function Write-DashboardLog {
    param([string]$Message)
    Add-Content -Path $LogPath -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
}

try {
    $day = (Get-Date).DayOfWeek
    if ($day -eq [DayOfWeek]::Saturday -or $day -eq [DayOfWeek]::Sunday) {
        Write-DashboardLog "weekend, skipping"
        exit 0
    }

    if (Test-Path $PauseFlag) {
        Write-DashboardLog "paused, skipping"
        exit 0
    }

    if (-not (Test-Path $Python)) {
        throw "Python executable not found at $Python"
    }

    Set-Location $Root
    $start = Get-Date
    $stdoutPath = Join-Path $env:TEMP ("mnq_dashboard_stdout_{0}.log" -f ([guid]::NewGuid()))
    $stderrPath = Join-Path $env:TEMP ("mnq_dashboard_stderr_{0}.log" -f ([guid]::NewGuid()))
    $proc = Start-Process -FilePath $Python `
        -ArgumentList @("-m", "rithmic_dashboard.cli.generate", "--output-path", $OutputPath) `
        -WorkingDirectory $Root `
        -NoNewWindow `
        -Wait `
        -PassThru `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath
    if (Test-Path $stdoutPath) {
        Get-Content $stdoutPath | Add-Content -Path $LogPath
        Remove-Item $stdoutPath -ErrorAction SilentlyContinue
    }
    if (Test-Path $stderrPath) {
        Get-Content $stderrPath | Add-Content -Path $LogPath
        Remove-Item $stderrPath -ErrorAction SilentlyContinue
    }
    $exitCode = $proc.ExitCode
    $elapsed = ((Get-Date) - $start).TotalSeconds

    if ($elapsed -gt 60) {
        Write-DashboardLog ("WARNING generator runtime {0:F2}s exceeded 60s exit={1}" -f $elapsed, $exitCode)
    } else {
        Write-DashboardLog ("scheduled task completed in {0:F2}s exit={1}" -f $elapsed, $exitCode)
    }

    exit $exitCode
} catch {
    $message = $_.Exception.Message
    Write-DashboardLog "ERROR runner failed: $message"
    $escaped = [System.Net.WebUtility]::HtmlEncode($message)
    Set-Content -Path (Join-Path $DashboardDir "index.html") -Value @"
<!doctype html>
<html>
<head><meta charset="utf-8"><meta http-equiv="refresh" content="900"><title>MNQ Dashboard Error</title></head>
<body style="background:#0a0a0a;color:#e5e5e5;font-family:Consolas,monospace;padding:24px">
<h1>Dashboard Generator Error</h1>
<p>$escaped</p>
<p>See $LogPath</p>
</body>
</html>
"@
    exit 1
}
