$ErrorActionPreference = "Stop"

$Root = "D:\Quant-futures-app\tools\rithmic_dashboard"
$DashboardDir = Join-Path $Root "data\dashboard"
New-Item -ItemType Directory -Path $DashboardDir -Force | Out-Null
$LogPath = Join-Path $DashboardDir ("generator_{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

function Write-DashboardLog {
    param([string]$Message)
    Add-Content -Path $LogPath -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
}

$Message = "V1 static HTML dashboard generator is retired; use D:\Quant-futures-app\run_realtime_stack.ps1 for the v2 realtime dashboard."
Write-DashboardLog $Message
[Console]::Error.WriteLine($Message)
exit 2
