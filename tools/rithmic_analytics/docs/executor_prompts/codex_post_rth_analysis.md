# Codex Post-RTH Analysis Prompt

One-shot focused task: after RTH closes (~13:05 PT), run the full analysis
cycle against today's capture. Normalize → verify RA-041 → run daily_zones
with all flags → compute supplementary stats → write analysis-rich status
report.

**This prompt is for a fresh Codex session.** Does NOT replace the
long-running operator (codex_capture_operator.md v2). Designed to coexist:
the operator handles routine normalize + scheduled daily_zones at 13:10 PT;
this one-shot does deeper analysis on top.

---

# Copy-paste below

```
You are running a one-shot post-RTH analysis task for 2026-05-21.

Project root: D:\Quant-futures-app\tools\rithmic_analytics\

# Context

- RTH ran from 07:40 PT (late start — 70 min after the scheduled 06:30 
  PT open) through 13:05 PT close. Partial RTH (~5.5h captured of the 
  6.5h window). 70-min open-hour gap is a known data limitation today.
- RA-041 (MBP1 forward-fill structural fix) shipped this morning. Today's 
  RTH normalize is the first end-to-end test of RA-041 on a fresh 
  RTH capture (Globex was re-normalized retrospectively at ~10am PT 
  with 100% two-sided coverage).
- Globex artifacts already exist for 2026-05-21:
  - data/captures/2026-05-21/MNQ_globex.{obs01,mbp1,mbo}.jsonl
  - data/zones/2026-05-21_MNQ_globex.json (VPOC 29180, VAH 29355, VAL 29120)
  - data/order_pressure/2026-05-21_MNQ_globex.json
  - data/codex_reports/ra041_verification_2026-05-21.md (Phase 1 done; 
    Phase 2 RTH section pending)
- The long-running operator may have already started normalize+daily_zones 
  at 13:10 PT. Check first; don't double-run.

# Safety rules (immutable)

1. Never modify .env, credentials, or rithmic_analytics source.
2. Never delete raw `.jsonl` files. Siblings are safe (regenerable).
3. If the long-running operator is mid-run, WAIT — don't compete.
4. Report-don't-act on anything unexpected.

# Phase 1 — Verify RTH probe has exited

```powershell
# Check no probe is still capturing RTH
$probe = Get-Process python -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match "capture-rithmic-probe" -or $_.CommandLine -match "start_capture"
}
if ($probe) {
  Write-Output "PROBE STILL RUNNING at $(Get-Date). Cannot proceed with normalize."
  $probe | Select-Object Id, StartTime
  exit 1
}
Write-Output "Probe exited cleanly. Proceeding with normalize."

# Verify raw RTH file exists + size
$rthRaw = "D:\Quant-futures-app\tools\rithmic_analytics\data\captures\2026-05-21\MNQ_rth.jsonl"
Get-Item $rthRaw | Select-Object Name, Length, LastWriteTime
```

**Pass**: probe is gone, raw file exists, mtime is recent (within last 5 min).
**Fail**: probe still running → STOP, escalate. Probe was supposed to auto-exit at RTH close.

# Phase 2 — Check if normalize already ran

```powershell
$rthObs01 = "D:\Quant-futures-app\tools\rithmic_analytics\data\captures\2026-05-21\MNQ_rth.obs01.jsonl"
$rthMbp1 = "D:\Quant-futures-app\tools\rithmic_analytics\data\captures\2026-05-21\MNQ_rth.mbp1.jsonl"
$rthMbo = "D:\Quant-futures-app\tools\rithmic_analytics\data\captures\2026-05-21\MNQ_rth.mbo.jsonl"

$siblings = @($rthObs01, $rthMbp1, $rthMbo) | Where-Object { Test-Path $_ }
Write-Output "Existing RTH siblings: $($siblings.Count) of 3"
$siblings | ForEach-Object { Get-Item $_ | Select-Object Name, Length, LastWriteTime }
```

**Decision branch:**
- If all 3 siblings exist AND mtime is within last 30 min: long-running operator already normalized. Skip to Phase 4 (verification).
- If 0 or partial siblings: run normalize in Phase 3.

# Phase 3 — Normalize RTH (if not already done)

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
$logPath = "data\codex_reports\normalize_rth_2026-05-21.log"
$start = Get-Date
python -m rithmic_analytics.cli.normalize `
  --input data\captures\2026-05-21\MNQ_rth.jsonl `
  --output data\captures\2026-05-21\MNQ_rth.obs01.jsonl `
  --force 2>&1 | Tee-Object -FilePath $logPath
$elapsed = ((Get-Date) - $start).TotalSeconds
Write-Output "Normalize completed in $($elapsed.ToString('F1'))s"
```

Expected runtime: 2-5 min for typical RTH (~3 GB raw). Three siblings produced.

**Verify** in the log final JSON:
- `skipped_missing_payload: 0` (anomaly if non-zero — flag in final report)
- `mbp1_forward_filled`: should be ~99% of MBP1 record count (RA-041 working)
- `mbp1_first_record_one_sided`: single-digits (only at session start)

# Phase 4 — RA-041 quality verification on RTH MBP1

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
$verifyOutput = python -c @"
from rithmic_analytics.core.loader import load_mbp1, summarize_spread
from pathlib import Path
df = load_mbp1(Path('data/captures/2026-05-21/MNQ_rth.mbp1.jsonl'))
total = len(df)
two_sided = ((df['bid_px_00'] > 0) & (df['ask_px_00'] > 0)).sum()
pct = 100.0 * two_sided / total if total > 0 else 0
print(f'TOTAL_RECORDS={total}')
print(f'TWO_SIDED={two_sided}')
print(f'TWO_SIDED_PCT={pct:.2f}')
summary = summarize_spread(df)
print(f'MEAN_TICKS={summary.mean_ticks:.2f}')
print(f'P99_TICKS={summary.p99_ticks}')
print(f'MAX_TICKS={summary.max_ticks}')
print(f'N_CROSSED={summary.n_crossed_quotes}')
"@
$verifyOutput | Tee-Object -Append -FilePath "data\codex_reports\ra041_verification_2026-05-21.md"
$verifyOutput
```

**Pass criteria (RA-041 closure on RTH)**:
- TWO_SIDED_PCT >= 95.0 (target ~100% like Globex showed earlier)
- N_CROSSED <= single-digit
- MEAN_TICKS between 1.0 and 5.0
- MAX_TICKS < 200 (real fast-move ceiling)

**Fail criteria (STOP, escalate)**:
- TWO_SIDED_PCT < 95.0 → RA-041 didn't take effect on RTH
- N_CROSSED > 100 → unexpected data quality issue

# Phase 5 — Run daily_zones with all 5 emit flags + adaptive bins

If the long-running operator already ran this at 13:10 PT, check log first:

```powershell
$dailyLog = "D:\Quant-futures-app\tools\rithmic_analytics\data\daily_zones_2026-05-21.log"
if (Test-Path $dailyLog) {
    $age = ((Get-Date) - (Get-Item $dailyLog).LastWriteTime).TotalMinutes
    Write-Output "Existing daily_zones log, age=$($age.ToString('F1'))min"
    Get-Content $dailyLog -Tail 30
}
```

If log is missing OR older than 1h, run daily_zones now:

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
python -m rithmic_analytics.cli.daily_zones `
  --trading-date 2026-05-21 `
  --emit-absorption-json `
  --emit-pressure-json `
  --emit-cancellation-analysis `
  --emit-probability-card `
  --adaptive-bins 2>&1 | Tee-Object -FilePath "data\daily_zones_2026-05-21.log"
```

**Surface from the log**:
- The RA-037 spread diagnostic INFO line (grep "MBP1 spread:")
- Adaptive bin sizing INFO line (grep "adaptive bin sizing")
- Each emit's success/failure summary

**Verify expected artifacts**:
```powershell
$artifacts = @(
  "data\zones\2026-05-21_MNQ_rth.json",
  "data\absorption\2026-05-21_MNQ_rth.json",
  "data\order_pressure\2026-05-21_MNQ_rth.json",
  "data\cancellations\2026-05-21_MNQ_rth.json",
  "data\probability_cards\2026-05-21_MNQ_rth.md"
)
foreach ($a in $artifacts) {
  $exists = Test-Path $a
  $size = if ($exists) { (Get-Item $a).Length } else { 0 }
  Write-Output "$a : exists=$exists size=$size"
}
```

Any missing artifact = log in status. Cancellation analysis will skip if 
no Tradesea CSV at `data/trades/2026-05-21/orders.csv` — that's expected 
when Neel hasn't exported yet.

# Phase 6 — RTH VWAP + σ bands (supplementary analysis)

The zones JSON contains VWAP via RA-031 ReferenceLines, but emit a 
standalone VWAP+σ summary for the analysis report:

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
$vwapOutput = python -c @"
import numpy as np
from pathlib import Path
from rithmic_analytics.core.loader import load_obs01_trades
trades = load_obs01_trades(Path('data/captures/2026-05-21/MNQ_rth.obs01.jsonl'))
v = trades['quantity'].astype('float64')
p = trades['price'].astype('float64')
cv = v.cumsum()
cpv = (p * v).cumsum()
cp2v = (p * p * v).cumsum()
vwap = cpv.iloc[-1] / cv.iloc[-1]
std = np.sqrt(max(cp2v.iloc[-1] / cv.iloc[-1] - vwap**2, 0))
agg = trades['aggressor_side'].values
sz = trades['quantity'].values
buys = int(sz[agg == 'buy'].sum())
sells = int(sz[agg == 'sell'].sum())
print(f'OPEN={p.iloc[0]:.2f}')
print(f'CLOSE={p.iloc[-1]:.2f}')
print(f'HIGH={p.max():.2f}')
print(f'LOW={p.min():.2f}')
print(f'RANGE={p.max() - p.min():.2f}')
print(f'TRADES={len(trades)}')
print(f'VOLUME={int(sz.sum())}')
print(f'VWAP={vwap:.2f}')
print(f'SIGMA={std:.2f}')
print(f'P2SIGMA_UP={vwap + 2*std:.2f}')
print(f'P1SIGMA_UP={vwap + std:.2f}')
print(f'M1SIGMA_DOWN={vwap - std:.2f}')
print(f'M2SIGMA_DOWN={vwap - 2*std:.2f}')
print(f'CVD_BUYS={buys}')
print(f'CVD_SELLS={sells}')
print(f'CVD_NET={buys - sells}')
print(f'CVD_BUY_PCT={100 * buys / (buys + sells):.1f}')
"@
$vwapOutput | Tee-Object -FilePath "data\codex_reports\rth_vwap_sigma_2026-05-21.log"
```

# Phase 7 — Order pressure top-bins surface

```powershell
$summaryPath = "D:\Quant-futures-app\tools\rithmic_analytics\data\order_pressure\2026-05-21_MNQ_rth_summary.json"
if (Test-Path $summaryPath) {
  Get-Content $summaryPath | ConvertFrom-Json | Format-List
}
```

Surface top-3 price bins by `n_adds_total` and any with `max_spoof_score >= 0.5` 
in the analysis report.

# Phase 8 — Globex vs RTH comparison

Read both zones JSONs and compare key levels:

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
$compareOutput = python -c @"
import json
from pathlib import Path
g = json.loads(Path('data/zones/2026-05-21_MNQ_globex.json').read_text())
r = json.loads(Path('data/zones/2026-05-21_MNQ_rth.json').read_text())
print(f'GLOBEX: VPOC={g[\"vpoc\"]} VAH={g[\"vah\"]} VAL={g[\"val\"]} ATR={g.get(\"atr_14\")}')
print(f'RTH:    VPOC={r[\"vpoc\"]} VAH={r[\"vah\"]} VAL={r[\"val\"]} ATR={r.get(\"atr_14\")}')
print(f'VPOC delta (RTH - Globex): {r[\"vpoc\"] - g[\"vpoc\"]:+.2f}')
print(f'VAH delta:  {r[\"vah\"] - g[\"vah\"]:+.2f}')
print(f'VAL delta:  {r[\"val\"] - g[\"val\"]:+.2f}')
print(f'Bin sizes: globex={g.get(\"effective_bin_size_ticks\", g[\"bin_size_ticks\"])} mode={g.get(\"bin_size_mode\", \"fixed\")} | rth={r.get(\"effective_bin_size_ticks\", r[\"bin_size_ticks\"])} mode={r.get(\"bin_size_mode\", \"fixed\")}')
"@
$compareOutput | Tee-Object -Append -FilePath "data\codex_reports\rth_vwap_sigma_2026-05-21.log"
```

# Phase 9 — Write comprehensive analysis report

Synthesize all of the above into a final report:

```powershell
$reportPath = "D:\Quant-futures-app\tools\rithmic_analytics\data\codex_reports\rth_analysis_2026-05-21.md"

$report = @"
# RTH Analysis Report — 2026-05-21

## Session metadata
- RTH start: 07:40 PT (70 min late vs 06:30 PT open)
- RTH close: 13:05 PT
- Capture coverage: ~5.5h of 6.5h window
- Known limitation: 70-min open-hour gap

## RA-041 verification (RTH)
- Total MBP1 records: [N]
- Two-sided coverage: [X.XX%]
- Mean spread: [X.XX ticks]
- P99 spread: [X ticks]
- Max spread: [X ticks]
- Crossed quotes: [N]
- mbp1_forward_filled: [N]
- mbp1_first_record_one_sided: [N]
- Pass/fail: [✓ ≥95% / ✗]

## RTH session profile
- Open: [P]
- Close: [P]
- High: [P]
- Low: [P]
- Range: [P pts]
- Trades: [N]
- Volume: [N contracts]
- VWAP: [P]
- σ: [P pts]
- +2σ: [P]
- +1σ: [P]
- −1σ: [P]
- −2σ: [P]
- CVD net: [N]
- CVD buy %: [N%]

## Volume Profile
- VPOC: [P]
- VAH: [P]
- VAL: [P]
- ATR(14): [P]
- Effective bin size: [N ticks, mode]

## Globex → RTH transition
- VPOC delta: [+/- pts]
- VAH delta: [+/- pts]
- VAL delta: [+/- pts]
- Read: [trend continuation / reversal / chop]

## Order pressure highlights
- Top-3 price bins by n_adds: [list]
- High-spoof bins (max_spoof_score ≥ 0.5): [list]
- MBO events processed: [N]

## Daily artifacts produced
- zones/2026-05-21_MNQ_rth.json: [✓ / ✗]
- absorption/2026-05-21_MNQ_rth.json: [✓ / ✗ — N events]
- order_pressure/2026-05-21_MNQ_rth.json: [✓ / ✗]
- cancellations/2026-05-21_MNQ_rth.json: [✓ / ✗ — likely ✗ if Tradesea CSV missing]
- probability_cards/2026-05-21_MNQ_rth.md: [✓ / ✗]

## Multi-method confluence
[Compare VPOC, VWAP, VAH, +1σ, VAL, −1σ. Note where they agree (within 
10pt = confluence) vs diverge. The strongest tradeable levels are 
multi-method confluences.]

## Trade framing for next session
[Based on the above, identify high-conviction tradeable levels for the 
upcoming Globex (or tomorrow's RTH if it's Friday). Use the same template 
as historical analyses:]

- LONG ideas (with conviction, entry, stop, target)
- SHORT ideas (with conviction, entry, stop, target)
- Neutral zones / no-trade

## Anomalies
[Anything unusual worth Neel's attention — abnormal spread mean, missing 
artifacts, spoof clusters, etc.]

## Status report path
- This file: data/codex_reports/rth_analysis_2026-05-21.md
- RA-041 verification: data/codex_reports/ra041_verification_2026-05-21.md (updated by long-running operator)
- Daily zones log: data/daily_zones_2026-05-21.log
"@

Set-Content -Path $reportPath -Value $report
Write-Output "Analysis report: $reportPath"
```

# Phase 10 — Exit

Once the analysis report is written, report back with:
1. RA-041 RTH verification pass/fail (the two-sided %)
2. RTH session summary (open/close/range/CVD)
3. Top multi-method confluences for next-session levels
4. Any anomalies that require Neel's attention
5. Status report file path

Then exit. **Do NOT reschedule.** This is a one-shot task. The 
long-running operator (codex_capture_operator.md) continues independently 
and handles Globex prep tonight.

# Failure handling

- If probe still running past 13:05 PT: STOP, escalate. The long-running 
  operator should have killed it.
- If RA-041 RTH coverage < 95%: STOP, escalate. RA-041 should produce 
  ≥95% on a fresh capture; failure indicates the new normalizer didn't 
  pick up the RA-041 code.
- If daily_zones fails entirely (no zones JSON): STOP, escalate. Per the 
  defensive-emit pattern, even failed sub-emits should produce zones JSON.
- If a specific emit fails (e.g., absorption skipped): log + continue. 
  This is the defensive-emit pattern working as designed.

Standing by for completion.
```
