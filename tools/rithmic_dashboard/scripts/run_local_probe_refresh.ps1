param(
    [string]$TradingDate = "",
    [ValidateSet("auto", "globex", "rth", "both")]
    [string]$Session = "auto",
    [string]$RootSymbol = "MNQ",
    [string]$Python = "C:\Users\Neel\AppData\Local\Programs\Python\Python312\python.exe",
    [string]$AnalyticsRoot = "D:\Quant-futures-app\tools\rithmic_analytics",
    [string]$DashboardRoot = "D:\Quant-futures-app\tools\rithmic_dashboard",
    [switch]$SkipNormalize,
    [switch]$SkipDailyZones,
    [switch]$SkipDashboard,
    [switch]$TryCalibrateThresholds,
    [switch]$EmitHeavyAnalytics,
    [int]$LookbackSessions = 20,
    [switch]$OpenDashboard,
    [switch]$ContinueOnError,
    [switch]$ClearPauseFlag,
    [switch]$Loop,
    [int]$IntervalMinutes = 5,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-Status {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    Add-Content -Path $script:LogPath -Value $line
}

function Resolve-Python {
    param([string]$Candidate)
    if (Test-Path $Candidate) {
        return $Candidate
    }
    return "python"
}

function Resolve-TradingDate {
    param([string]$ExplicitDate)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitDate)) {
        return $ExplicitDate
    }
    $capturesRoot = Join-Path $AnalyticsRoot "data\captures"
    if (-not (Test-Path $capturesRoot)) {
        throw "captures root missing: $capturesRoot"
    }
    $latest = Get-ChildItem -Path $capturesRoot -Directory |
        Where-Object {
            (Test-Path (Join-Path $_.FullName "$RootSymbol`_globex.jsonl")) -or
            (Test-Path (Join-Path $_.FullName "$RootSymbol`_rth.jsonl"))
        } |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if ($null -eq $latest) {
        throw "no capture folders containing $RootSymbol raw JSONL were found under $capturesRoot"
    }
    return $latest.Name
}

function Resolve-Sessions {
    param([string]$SelectedSession, [string]$Date)
    if ($SelectedSession -eq "both") {
        return @("globex", "rth")
    }
    if ($SelectedSession -in @("globex", "rth")) {
        return @($SelectedSession)
    }
    $captureDir = Join-Path $AnalyticsRoot "data\captures\$Date"
    $found = @()
    foreach ($candidate in @("globex", "rth")) {
        if (Test-Path (Join-Path $captureDir "$RootSymbol`_$candidate.jsonl")) {
            $found += $candidate
        }
    }
    if ($found.Count -eq 0) {
        throw "no $RootSymbol raw captures found for $Date in $captureDir"
    }
    return $found
}

function Invoke-Step {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [string[]]$Arguments,
        [switch]$AllowFailure
    )
    $display = "$script:PythonExe $($Arguments -join ' ')"
    Write-Status "START $Name"
    Write-Status "CMD   $display"
    if ($DryRun) {
        Write-Status "DRY   skipped $Name"
        return 0
    }
    $stdoutPath = Join-Path $env:TEMP ("mnq_local_refresh_stdout_{0}.log" -f ([guid]::NewGuid()))
    $stderrPath = Join-Path $env:TEMP ("mnq_local_refresh_stderr_{0}.log" -f ([guid]::NewGuid()))
    $proc = Start-Process -FilePath $script:PythonExe `
        -ArgumentList $Arguments `
        -WorkingDirectory $WorkingDirectory `
        -NoNewWindow `
        -Wait `
        -PassThru `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath
    if (Test-Path $stdoutPath) {
        Write-RedirectFile -Path $stdoutPath
        Remove-Item $stdoutPath -ErrorAction SilentlyContinue
    }
    if (Test-Path $stderrPath) {
        Write-RedirectFile -Path $stderrPath
        Remove-Item $stderrPath -ErrorAction SilentlyContinue
    }
    $exitCode = $proc.ExitCode
    Write-Status "END   $Name exit=$exitCode"
    if ($exitCode -ne 0 -and -not $AllowFailure -and -not $ContinueOnError) {
        throw "$Name failed with exit code $exitCode"
    }
    return $exitCode
}

function Write-RedirectFile {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) {
        return
    }
    $sampleLength = [Math]::Min($bytes.Length, 40)
    $nulCount = 0
    for ($i = 0; $i -lt $sampleLength; $i++) {
        if ($bytes[$i] -eq 0) {
            $nulCount++
        }
    }
    if ($nulCount -gt 5) {
        $text = [System.Text.Encoding]::Unicode.GetString($bytes)
    } else {
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    }
    if ([string]::IsNullOrWhiteSpace($text)) {
        return
    }
    $text.TrimEnd() -split "`r?`n" | ForEach-Object {
        Write-Host $_
        Add-Content -Path $script:LogPath -Value $_
    }
}

$script:PythonExe = Resolve-Python -Candidate $Python
$DashboardDataDir = Join-Path $DashboardRoot "data\dashboard"
New-Item -ItemType Directory -Path $DashboardDataDir -Force | Out-Null
$script:LogPath = Join-Path $DashboardDataDir ("local_probe_refresh_{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
if (-not (Test-Path $script:LogPath)) {
    New-Item -ItemType File -Path $script:LogPath | Out-Null
}
$PauseFlag = Join-Path $DashboardDataDir "_pause.flag"
if ($ClearPauseFlag -and (Test-Path $PauseFlag) -and -not $DryRun) {
    Remove-Item $PauseFlag -ErrorAction SilentlyContinue
    Write-Status "INFO  removed dashboard pause flag"
} elseif (Test-Path $PauseFlag) {
    Write-Status "WARN  dashboard pause flag exists; page will show PAUSED banner"
}

$oldPythonPath = $env:PYTHONPATH
$python312Site = "C:\Users\Neel\AppData\Local\Programs\Python\Python312\Lib\site-packages"
$pathParts = @($AnalyticsRoot, $DashboardRoot)
if (Test-Path $python312Site) {
    $pathParts += $python312Site
}
if (-not [string]::IsNullOrWhiteSpace($oldPythonPath)) {
    $pathParts += $oldPythonPath
}
$env:PYTHONPATH = ($pathParts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ";"

function Invoke-RefreshOnce {
    $ResolvedDate = Resolve-TradingDate -ExplicitDate $TradingDate
    $ResolvedSessions = @(Resolve-Sessions -SelectedSession $Session -Date $ResolvedDate)
    $SessionsCsv = ($ResolvedSessions -join ",")
    Write-Status "manual probe refresh date=$ResolvedDate sessions=$SessionsCsv python=$script:PythonExe"

    if (-not $SkipNormalize) {
        foreach ($item in $ResolvedSessions) {
            $raw = "data\captures\$ResolvedDate\$RootSymbol`_$item.jsonl"
            $obs = "data\captures\$ResolvedDate\$RootSymbol`_$item.obs01.jsonl"
            $rawAbs = Join-Path $AnalyticsRoot $raw
            if (-not (Test-Path $rawAbs)) {
                $msg = "raw capture missing, skipping normalize: $rawAbs"
                if ($ContinueOnError) {
                    Write-Status "WARN  $msg"
                    continue
                }
                throw $msg
            }
            if ($EmitHeavyAnalytics) {
                Invoke-Step -Name "normalize full $item" -WorkingDirectory $AnalyticsRoot -Arguments @(
                    "-m", "rithmic_analytics.cli.normalize",
                    "--input", $raw,
                    "--output", $obs,
                    "--force"
                ) | Out-Null
            } else {
                $auditPath = Join-Path $DashboardDataDir "_audit.json"
                Invoke-Step -Name "normalize incremental $item" -WorkingDirectory $AnalyticsRoot -Arguments @(
                    "-m", "rithmic_analytics.cli.normalize_probe_incremental",
                    "--input", $raw,
                    "--output", $obs,
                    "--audit-path", $auditPath
                ) | Out-Null
            }
        }
    } else {
        Write-Status "SKIP  normalize"
    }

    if (-not $SkipDailyZones) {
        $dailyZonesArgs = @(
            "-m", "rithmic_analytics.cli.daily_zones",
            "--trading-date", $ResolvedDate,
            "--root-symbol", $RootSymbol,
            "--sessions", $SessionsCsv,
            "--mode", $(if ($EmitHeavyAnalytics) { "full" } else { "light" }),
            "--emit-absorption-json",
            "--emit-probability-card",
            "--adaptive-bins"
        )
        if ($EmitHeavyAnalytics) {
            $dailyZonesArgs += @(
                "--emit-pressure-json",
                "--emit-cancellation-analysis"
            )
        } else {
            Write-Status "SKIP  heavy MBO pressure/cancellation analytics; use -EmitHeavyAnalytics for EOD/full scan"
        }
        Invoke-Step -Name "daily_zones $SessionsCsv" -WorkingDirectory $AnalyticsRoot -Arguments $dailyZonesArgs | Out-Null
    } else {
        Write-Status "SKIP  daily_zones"
    }

    if ($TryCalibrateThresholds) {
        Invoke-Step -Name "calibrate dislocation thresholds" -WorkingDirectory $DashboardRoot -AllowFailure -Arguments @(
            "-m", "rithmic_dashboard.cli.calibrate_thresholds",
            "--analytics-root", $AnalyticsRoot,
            "--symbol", $RootSymbol,
            "--lookback-sessions", "$LookbackSessions"
        ) | Out-Null
    }

    if ($SkipDashboard) {
        Write-Status "SKIP  V1 dashboard generation retired; -SkipDashboard is retained for compatibility"
    } else {
        Write-Status "SKIP  V1 dashboard generation retired; use the v2 realtime stack"
    }

    Write-Status "DONE  refresh complete; normalize and daily_zones preserved; v1_html=retired"
    if ($OpenDashboard) {
        Write-Status "WARN  -OpenDashboard is retired with the V1 HTML page; start v2 with D:\Quant-futures-app\run_realtime_stack.ps1"
    }
}

try {
    do {
        try {
            Invoke-RefreshOnce
        } catch {
            Write-Status ("ERROR refresh failed: {0}" -f $_.Exception.Message)
            if (-not $ContinueOnError) {
                throw
            }
        }
        if (-not $Loop) {
            break
        }
        $sleepSeconds = [Math]::Max(1, $IntervalMinutes) * 60
        if ($DryRun) {
            Write-Status "DRY   loop requested; stopping before sleep"
            break
        }
        Write-Status "SLEEP next refresh in $IntervalMinutes minute(s)"
        Start-Sleep -Seconds $sleepSeconds
    } while ($true)
} finally {
    $env:PYTHONPATH = $oldPythonPath
}
