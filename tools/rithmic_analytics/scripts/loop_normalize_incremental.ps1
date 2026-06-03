<#
.SYNOPSIS
  Background normalize loop — bridges the obs01 lag when the realtime
  backend's self-normalize is not active.

.DESCRIPTION
  Calls rithmic_analytics.cli.normalize_probe_incremental at a fixed
  interval (default 30 seconds) for a given trading date + session kind.
  This guarantees obs01 stays current even if the realtime backend was
  launched without RA60_SELF_NORMALIZE=1 (the env var sometimes doesn't
  propagate through Start-Process correctly on Windows).

  Per the project_ra060_realtime_backend memory note: ONLY ONE normalizer
  should be writing obs01 at a time. If you turn this on, ensure the
  backend's self-normalize is OFF (either env var unset OR explicitly
  RA60_SELF_NORMALIZE=0). Two writers will produce inconsistent state.

.PARAMETER TradingDate
  YYYY-MM-DD of the trading day to normalize.

.PARAMETER Session
  globex | rth — which capture file under the trading date dir.

.EXAMPLE
  pwsh -File loop_normalize_incremental.ps1 -TradingDate 2026-06-03 -Session globex
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')]
    [string]$TradingDate,
    [ValidateSet('globex','rth')]
    [string]$Session = 'globex',
    [string]$RootSymbol = 'MNQ',
    [int]$IntervalSeconds = 30,
    [string]$AnalyticsRoot = 'D:\Quant-futures-app\tools\rithmic_analytics',
    [string]$Python = 'C:\Users\Neel\AppData\Local\Programs\Python\Python312\python.exe'
)

$src = Join-Path $AnalyticsRoot "data\captures\$TradingDate\${RootSymbol}_${Session}.jsonl"
$out = Join-Path $AnalyticsRoot "data\captures\$TradingDate\${RootSymbol}_${Session}.obs01.jsonl"

if (-not (Test-Path $src)) {
    Write-Host "ERROR: source file missing: $src"
    exit 2
}

Write-Host "loop_normalize_incremental: src=$src interval=${IntervalSeconds}s"
Write-Host "PID: $PID"

$pyScript = @"
from pathlib import Path
import sys, time, os
from rithmic_analytics.cli.normalize_probe_incremental import normalize_incremental
src = Path(sys.argv[1])
out = Path(sys.argv[2])
t0 = time.time()
result = normalize_incremental(input_path=src, obs01_path=out)
raw = os.path.getsize(src)
lag = raw - result.last_byte_offset
elapsed = time.time() - t0
print(f'  ok elapsed={elapsed:.1f}s cursor={result.last_byte_offset:,} trades={result.trades_emitted_total:,} lag_bytes={lag:,}', flush=True)
"@

while ($true) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-Host "$stamp normalize tick" -NoNewline
    try {
        & $Python -c $pyScript $src $out
    } catch {
        Write-Host "  ERROR: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $IntervalSeconds
}
