param(
    [string]$TradingDate = "",
    [ValidateSet("rth", "globex", "both")]
    [string]$Session = "rth",
    [string]$RootSymbol = "MNQ",
    [string]$Python = "C:\Users\Neel\AppData\Local\Programs\Python\Python312\python.exe",
    [string]$AnalyticsRoot = "D:\Quant-futures-app\tools\rithmic_analytics",
    [string]$DashboardRoot = "D:\Quant-futures-app\tools\rithmic_dashboard",
    [switch]$SkipNormalize,
    [switch]$SkipDashboard,
    [switch]$ContinueOnError,
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
    return (Get-Date).ToString("yyyy-MM-dd")
}

function Resolve-Sessions {
    param([string]$SelectedSession)
    if ($SelectedSession -eq "both") {
        return @("globex", "rth")
    }
    return @($SelectedSession)
}

function Write-RedirectFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        return
    }
    $text = Get-Content -Path $Path -Raw -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace($text)) {
        return
    }
    $text.TrimEnd() -split "`r?`n" | ForEach-Object {
        Write-Host $_
        Add-Content -Path $script:LogPath -Value $_
    }
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
    $stdoutPath = Join-Path $env:TEMP ("mnq_eod_full_stdout_{0}.log" -f ([guid]::NewGuid()))
    $stderrPath = Join-Path $env:TEMP ("mnq_eod_full_stderr_{0}.log" -f ([guid]::NewGuid()))
    $proc = Start-Process -FilePath $script:PythonExe `
        -ArgumentList $Arguments `
        -WorkingDirectory $WorkingDirectory `
        -NoNewWindow `
        -Wait `
        -PassThru `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath
    Write-RedirectFile -Path $stdoutPath
    Write-RedirectFile -Path $stderrPath
    Remove-Item $stdoutPath -ErrorAction SilentlyContinue
    Remove-Item $stderrPath -ErrorAction SilentlyContinue
    $exitCode = $proc.ExitCode
    Write-Status "END   $Name exit=$exitCode"
    if ($exitCode -ne 0 -and -not $AllowFailure -and -not $ContinueOnError) {
        throw "$Name failed with exit code $exitCode"
    }
    return $exitCode
}

$script:PythonExe = Resolve-Python -Candidate $Python
$DashboardDataDir = Join-Path $DashboardRoot "data\dashboard"
New-Item -ItemType Directory -Path $DashboardDataDir -Force | Out-Null
$script:LogPath = Join-Path $DashboardDataDir ("eod_full_analytics_{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))
if (-not (Test-Path $script:LogPath)) {
    New-Item -ItemType File -Path $script:LogPath | Out-Null
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

try {
    $ResolvedDate = Resolve-TradingDate -ExplicitDate $TradingDate
    $ResolvedSessions = @(Resolve-Sessions -SelectedSession $Session)
    $SessionsCsv = ($ResolvedSessions -join ",")
    Write-Status "EOD full analytics date=$ResolvedDate sessions=$SessionsCsv python=$script:PythonExe"

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
            Invoke-Step -Name "normalize full $item" -WorkingDirectory $AnalyticsRoot -Arguments @(
                "-m", "rithmic_analytics.cli.normalize",
                "--input", $raw,
                "--output", $obs,
                "--force"
            ) | Out-Null
        }
    } else {
        Write-Status "SKIP  normalize"
    }

    Invoke-Step -Name "daily_zones full $SessionsCsv" -WorkingDirectory $AnalyticsRoot -Arguments @(
        "-m", "rithmic_analytics.cli.daily_zones",
        "--trading-date", $ResolvedDate,
        "--root-symbol", $RootSymbol,
        "--sessions", $SessionsCsv,
        "--mode", "full",
        "--emit-absorption-json",
        "--emit-probability-card",
        "--adaptive-bins"
    ) | Out-Null

    $sessionCombinedCli = Join-Path $AnalyticsRoot "rithmic_analytics\cli\session_combined.py"
    if (Test-Path $sessionCombinedCli) {
        Invoke-Step -Name "session_combined" -WorkingDirectory $AnalyticsRoot -AllowFailure -Arguments @(
            "-m", "rithmic_analytics.cli.session_combined",
            "--trading-date", $ResolvedDate,
            "--root-symbol", $RootSymbol
        ) | Out-Null
    } else {
        Write-Status "WARN  session_combined CLI not present; RA-057 should track this EOD-prep gap if needed"
    }

    if ($SkipDashboard) {
        Write-Status "SKIP  V1 dashboard generation retired; -SkipDashboard is retained for compatibility"
    } else {
        Write-Status "SKIP  V1 dashboard generation retired; EOD full analytics now stops after data artifacts"
    }

    Write-Status "DONE  EOD full analytics"
} finally {
    $env:PYTHONPATH = $oldPythonPath
}
