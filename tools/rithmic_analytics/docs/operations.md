# Operations

How this layer runs day-to-day, what to check, and what to do when things
break. **For first-time install**, see
[`task_scheduler_setup.md`](./task_scheduler_setup.md). This file is the
oncall reference *after* the pipeline is running.

## Daily routine

The pipeline is fully automated via five scheduled tasks (see
[`task_scheduler_setup.md`](./task_scheduler_setup.md)). On a normal day there
is **nothing to do**. The 90-second morning check below is for spot-checking
that yesterday completed cleanly:

1. **Quickest signal — render the capture-quality dashboard.**
   The dashboard is a library callable, not a CLI; the simplest invocation:
   ```powershell
   python -c "from pathlib import Path; from rithmic_analytics.viewer.capture_dashboard import render_capture_dashboard; render_capture_dashboard(Path('data/captures'), Path('data/reports/capture_dashboard.html'))"
   start data/reports/capture_dashboard.html
   ```
   The header line tells you: capture days seen / total bytes / total alerts
   / FAIL count. If FAIL=0 and yesterday's row shows two green sizes (RTH +
   Globex), you're done.

2. **If yesterday is red or missing**, jump to ["Failure modes"](#failure-modes)
   below.

3. **Daily zone JSON**: produced automatically by `RithmicDailyZones` at
   17:30 ET each weekday. Output lands at
   `data/zones/YYYY-MM-DD_MNQ_{rth,globex}.json`. Consumed by chart-drawing
   tooling and the daily HTML report.

4. **Daily HTML report** (if you've wired it up): call
   `render_daily_report(...)` from `viewer.vp_report`. The Plotly bundle
   inlines by default (~10 MB) so the file is readable offline — convenient
   on a plane. See [`future_work.md` item 11](./future_work.md) for the
   planned shared-bundle optimisation.

## Manual workflows

### One-off zone JSON for a specific session

```powershell
python -m rithmic_analytics.cli.compute_vp `
    --input data\captures\2026-05-15\MNQ_rth.jsonl `
    --output zones.json `
    --symbol MNQ --timeframe rth --bin-size-ticks 20
```

Exits 1 on bad input, 2 on schema validation failure (= bug; file an issue).

### Operator-initiated mid-RTH zone refresh

```powershell
python -m rithmic_analytics.cli.daily_zones --trading-date 2026-05-15
```

Bypasses the "trading day complete" check (16:05 ET); processes the
in-progress capture with a warning logged. Use sparingly — repeated
re-renders during RTH thrash chart tooling that reads the same file.

### Monthly EWMA volatility calibration

RA-053 calibrates the dashboard's adaptive volatility regime from Databento
history. Run it manually after the corpus changes materially:

```powershell
python -m rithmic_analytics.cli.calibrate_ewma --symbol MNQ
```

The CLI scans `D:\qfa-cache\databento` and
`D:\Quant-futures-app\data\databento\sim03_corpus`, streams `trades.dbn.zst`
files in chunks, writes `data/calibration_corpus/per_session_stats.parquet`,
and writes `data/calibration_corpus/ewma_decay.json`. It logs the verified
session count as:

```text
corpus_loaded: X verified sessions from N total directories (rejected M: reasons)
```

The dashboard reads `ewma_decay.json` during the 5-minute local refresh loop.
No scheduler is created for recalibration.

### Ad-hoc exploration

`python -i scripts/explore_session.py 2026-05-15` opens an interactive shell
with `trades`, `vp`, `cvd_df`, `footprint`, `absorption_events`, `multi`,
and `envelope` already populated for that trading day. See the script's
docstring.

### Force a capture rotation now

```powershell
python -m rithmic_analytics.cli.rotate --dry-run    # preview
python -m rithmic_analytics.cli.rotate              # apply
```

Rotation runs nightly at 02:00 (`RithmicRotation`) so manual invocation is
only needed if disk pressure hits unexpectedly between scheduled runs.

## Discord push notifications (RA-032)

FAIL-severity events post to a Discord webhook with 30-min dedupe per
`(severity, source_name)` key. Setup:

1. Create a Discord webhook (Server settings → Integrations → Webhooks).
2. Add `RITHMIC_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...`
   to your [`.env`](../.env) file.
3. Restart any long-running processes (daily_zones picks up env on
   invocation, so it picks up new env values automatically).

Behavior:

- **FAIL gap alerts** post once; identical FAIL within 30 min suppressed.
- **WARN-severity** events never push (volume too high — log only).
- **Heartbeat-watchdog FAIL** (RA-033) posts when prior-day heartbeat
  missing.
- **Daily digest** posts at end of `daily_zones` run with one-line summary.
- **Missing env var** → INFO log on first attempt, silent no-op after.
  Pipeline never crashes on alerter failure.

Dedupe state lives at `data/alerts/.alerts_state.json` and survives
process restarts.

## Heartbeat-of-heartbeat watchdog (RA-033)

At the end of each `daily_zones` run, the watchdog checks whether the
prior business day's heartbeat file (`data/heartbeat/<YYYY-MM-DD>.txt`)
exists. If absent AND the directory contains at least one other
heartbeat file (i.e. not a fresh install), a WARNING logs and — if
RA-032's webhook is wired — a FAIL alert posts with
`source_name=heartbeat_watchdog`.

This catches the Windows-Update-wipes-Task-Scheduler-entries silent
failure mode: the heartbeat task itself disappears, no heartbeat fires,
no missing-heartbeat alert generates because there's no fire to check.
The watchdog runs on the OTHER scheduled task (daily_zones) so it
survives heartbeat-task deletion.

Bootstrap-safe: empty heartbeat directory → no false alarm.

Override the directory via `--heartbeat-dir` (default `data/heartbeat`).

## Morning workflow → tv_sync executor (RA-034)

After `daily_zones` emits today's zone JSON, run `tv_sync` to plan the
chart updates and have a Claude Code session apply them via MCP tools.
Two phases:

### Phase 1 (Python) — plan emit

Schedulable, no MCP needed:

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
python -m rithmic_analytics.cli.tv_sync `
    --zones data\zones\2026-05-20_MNQ_rth.json `
    --target both `
    --apply
```

Writes two plan files (one per backend) under `data/tv_sync_plans/`:
- `tv_desktop_MNQ_<ts>.json`
- `tradesea_MNQ_<ts>.json`
- `_latest.json` pointer (most recent plan)

Per-backend planning failure does NOT gate the other — partial success
is success.

### Phase 2 (executor agent) — applies the plan

Open a Claude Code session with TV-MCP and Chrome-MCP tools loaded.
Hand the agent this prompt template (use the `_latest.json` pointer to
locate the plan):

> Read `data/tv_sync_plans/_latest.json` to find the most recent plan
> file. Read the plan. For each operation:
> - **`add`**: invoke the matching backend's add-shape tool
>   (`mcp__tradingview__draw_shape` for tv_desktop;
>   `mcp__Claude_in_Chrome__javascript_tool` injecting
>   `iframe[id^="tradingview_"]`'s `tradingViewApi.activeChart().createMultipointShape(...)` for tradesea).
>   Time anchor = `Math.floor(Date.now() / 1000)` — NOT
>   `getVisibleRange().to`. Record the returned shape_id.
> - **`remove`**: invoke remove-shape (`draw_remove_one` /
>   `removeEntity`). If the shape is already gone, treat as success.
> - **`noop`**: skip.
>
> After all ops execute, write back the state file at
> `data/tv_sync_state/<backend>_<chart_id>.json` with the updated
> `source_id → shape_id` mappings.

The executor session is intentionally Claude-Code-driven, not
auto-scheduled. **Fully scheduled automation requires Option C
infrastructure** (out-of-band MCP-client wrapper) — RA-035 candidate
when there's operational pressure for it.

### Safety contract

`tv_sync` ONLY touches shapes it previously created (tracked in the
state file). Manual user drawings — fib retracements, trend lines,
annotations — are invisible to the planner forever. The classification
engine never enumerates the chart's full shape inventory; it operates
purely against (envelope, state file).

### Reading dry-run output

`--dry-run` (default) prints the plan to stdout as pretty-JSON.
Inspect `operations[]`. A bootstrapping morning (no state file yet)
shows all `add` ops; subsequent runs show mostly `noop` with
occasional `remove`+`add` pairs when prices move between sessions.

### Common gotchas

- **Tradesea iframe ID remounts** — the executor MUST re-query
  `iframe[id^="tradingview_"]` before every operation. Don't cache the
  ID. Verified in the 2026-05-19 session: `tradingview_d12f0` →
  `tradingview_1083c` on a chart-state change.
- **`createMultipointShape` no underscore** — the public no-underscore
  API works; the underscore-prefix internal `_createMultipointShape`
  only persists the first point (2026-05-20 incident).
- **Time anchor** — `Math.floor(Date.now() / 1000)`, rounded to bar
  resolution. NOT `getVisibleRange().to` (places labels 8 weeks in
  future-space, off-screen). The plan's `meta.time_anchor_hint`
  carries this reminder.
- **Indicator-emitted vs user-drawn** — TV Charting Library's
  `getAllShapes()` returns only user-drawn shapes. Indicator-emitted
  zones (Quant Regime + Zones [Neel v2.3]) are invisible to `tv_sync`
  and stay where they are.

## Automated cancellation analysis (RA-036, Rule 7 measurement)

The "did price reach my cancelled limit?" question is now answered
automatically per session. Add `--emit-cancellation-analysis` to the
production `daily_zones` invocation. Result:

```
data/cancellations/{YYYY-MM-DD}_MNQ_<session>.json
```

`daily_zones` looks for the trader's Tradesea CSV at
`data/trades/{YYYY-MM-DD}/orders.csv` — drop today's export into that
path before the daily_zones run (or after; it's just a nightly compute).
If the CSV is absent, the step skips silently with an INFO log line
(this is the bootstrap case — not an error).

### Reading the report

**Rule 7 alarm: `regret_cancel_rate > 20%`** suggests discipline
drift. Look at the per-cancel outcomes:

- **favorable + reached_limit=True** = canonical regret cancel (price
  came to your level, you weren't there).
- **regret_rebuy_at_worse_price=True** is the compounding sin:
  cancelled, then chased back in at worse pricing within 10 min.
- **window_truncated=True** = the regret window extended past the
  capture's last bar; treat that outcome's verdict as inconclusive.

The trade-replay HTML report (`render_trade_replay_html` with
`cancellation_report=...`) renders these inline with the Rule 7 alarm
visible at the top of the section.

### Smoke-test before flipping ON

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
# Standalone CLI for ad-hoc reprocessing
python -m rithmic_analytics.cli.analyze_cancellations `
    --orders data\trades\2026-05-19\orders.csv `
    --jsonl data\captures\2026-05-19\MNQ_rth.obs01.jsonl `
    --output data\cancellations\2026-05-19_MNQ_rth.json
```

Today's `data/trades/2026-05-19/orders.csv` contains 3 cancelled
orders — should produce a 3-element `per_cancel_outcomes` list.

### Defensive design (same as RA-030.1 / RA-035)

Failures during cancellation emit **never gate the zones JSON**:

- `cancellation emit: skipped for ... — no Tradesea CSV` — bootstrap or
  off-platform trading; not an error.
- `cancellation emit failed for ... (zones still produced)` — parse or
  compute error. Zones JSON is fine.

### Tuning knobs

The defaults (5 min regret window, 10 min rebuy window, 1 tick
tolerance, 60s min-tape) match the RA-036 sweep. If Neel finds the
regret window too tight or too loose after a few sessions, override via
CLI flags or `CancellationAnalysisConfig`.

## Automated order-pressure events (RA-035)

Once smoke-tested, add `--emit-pressure-json` to the production
`daily_zones` invocation. Result:

```
data/zones/{YYYY-MM-DD}_MNQ_<session>.json         ← zones (existing)
data/absorption/{YYYY-MM-DD}_MNQ_<session>.json    ← absorption events (RA-030.1)
data/order_pressure/{YYYY-MM-DD}_MNQ_<session>.json ← NEW
```

The pressure JSON contains per-(30-sec time-bin, 1pt price-bin) rows
with add/cancel/fill counts, add_cancel_ratio, depletion_velocity, and
spoof_score. See [`feature_reference.md` → `features.order_pressure`](./feature_reference.md).

### Defensive design (same as RA-030.1)

Failures during pressure emit **never gate the zones JSON**:

- `pressure emit: skipped for ... — no MBO sibling at <name>` — capture
  predates RA-035 (no MBO sibling produced during normalization) or
  the `.obs01.jsonl` was cached without the `.mbo.jsonl`. Delete the
  obs01 sibling and rerun normalization to regenerate.
- `pressure emit failed for ... (zones still produced)` — compute or
  write error. Zones JSON is fine; pressure file is missing for that
  session.

### Runtime cost

Expect ~30s additional wall-clock on a full overnight Globex MBO
(~13.8M events) and ~3 GB peak memory. The `pressure emit:` log line
includes wall-clock duration so drift is visible.

### Smoke-test before flipping ON

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
python -m rithmic_analytics.cli.daily_zones `
    --trading-date 2026-05-21 `
    --emit-pressure-json
# Inspect:
Get-Item data\order_pressure\2026-05-21_MNQ_globex.json | Select Length
Get-Content data\order_pressure\2026-05-21_MNQ_globex.json -TotalCount 5 | ConvertFrom-Json
```

If `metadata.window_seconds=30`, `metadata.n_input_events > 1_000_000`,
and `rows[].spoof_score` shows a mix of None / low / high values, the
pipeline is healthy. Then update the `RithmicDailyZones` scheduled
task to include `--emit-pressure-json` alongside
`--emit-absorption-json`.

### Reading the artifact

Top spoof-score bins are the "watch for fade" levels — orders shown
but withdrawn. Combine with the absorption JSON's events to spot
"absorption that wasn't" (high-volume one-sided + high spoof_score at
the same price). Cross-source attribution is RA-028's job; for now,
side-by-side inspection in the morning chart-prep.

### Standalone reprocessing

For ad-hoc reruns or testing different spoof-window values:

```powershell
python -m rithmic_analytics.cli.compute_pressure `
    --mbo data\captures\2026-05-21\MNQ_globex.mbo.jsonl `
    --output data\order_pressure\2026-05-21_MNQ_globex.json `
    --spoof-cancel-window-ms 250 `
    --top-n-levels 10
```

The `--top-n-levels` flag emits a sibling `_summary.json` ranking
price bins by max_spoof_score — useful for morning chart-prep.

## Automated absorption events (RA-030.1)

Once smoke-tested, add `--emit-absorption-json` to the production
`daily_zones` scheduled-task invocation. Result:

```
data/zones/{YYYY-MM-DD}_MNQ_rth.json        ← existing zone envelope
data/absorption/{YYYY-MM-DD}_MNQ_rth.json   ← NEW absorption events
```

Default OFF means existing daily_zones behavior is unchanged until you
flip the flag. The artifact path is documented above in
[`feature_reference.md`](./feature_reference.md).

**Defensive design**: failures during absorption emit (missing MBP1
sibling, compute error, disk write error) **never gate the zones JSON**.
Watch for a `WARNING` log line like:

- `absorption emit: skipped for ... — no MBP1 sibling` — pre-RA-030
  capture or cached `.obs01.jsonl` without paired `.mbp1.jsonl`. Delete
  the obs01 sibling and rerun to regenerate both.
- `absorption emit failed for ... (zones still produced)` — compute or
  write error. Zones JSON is fine; absorption file is missing for that
  session.

**Runtime cost**: expect ~30–60s additional wall-clock and ~1.7 GB peak
memory on a full RTH session (8M+ MBP1 records). Acceptable for nightly
batch; the `absorption emit:` log line includes wall-clock duration so
drift is visible.

### Smoke-test before flipping ON

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
python -m rithmic_analytics.cli.daily_zones `
    --trading-date 2026-05-20 `
    --emit-absorption-json
# Inspect:
Get-Item data\absorption\2026-05-20_MNQ_rth.json | Select Length
Get-Content data\absorption\2026-05-20_MNQ_rth.json -TotalCount 1 | ConvertFrom-Json
```

If `mbp1_stale=False` on the majority of events and `factors.displacement
> 0`, the four-factor pipeline is healthy. Then update the
`RithmicDailyZones` scheduled task to include `--emit-absorption-json`.

### Reading absorption events downstream

The JSON is consumable by `viewer.vp_report.render_daily_report` (as the
`absorption_events` kwarg, after deserializing back to `AbsorptionEvent`)
and by RA-028 P&L attribution (pending). Schema is stable across
RA-030.1; no version bump required if/when new fields are added.

## Session-anchored VWAP + σ bands (RA-031)

Daily zone JSON output now includes VWAP reference lines:

```json
"reference_lines": [
  {"price": 27381.25, "text": "VWAP RTH 27381.25", "source": "vwap_rth"},
  {"price": 27395.50, "text": "VWAP RTH +1σ",      "source": "vwap_rth_band_p1sd"},
  {"price": 27367.00, "text": "VWAP RTH -1σ",      "source": "vwap_rth_band_m1sd"},
  {"price": 27380.10, "text": "VWAP Weekly 27380.10", "source": "vwap_weekly"}
]
```

±2σ bands are omitted from the main output (chart-prep noise floor).
Call `compute_vwap()` directly if you need them.

`grade_zone` now elevates HVN + VWAP-band + structural overlap to
**HIGH conviction** (previously HIGH was effectively unreachable from
Phase-1 zones). The next session's `score_zones` HistoryReport will
finally produce non-empty HIGH-tier statistics.

## Trade-log workflow (RA-026)

After a trading session, you can produce a trade-replay HTML showing what
the tape looked like 60 seconds before and after each fill. Two input
formats:

### Option A — Tradesea CSV (preferred, when available)

1. From the Tradesea web UI, export the order history for the day.
   Filename will be `orders_YYYY-MM-DD.csv` in `C:\Users\Neel\Downloads\`.
2. Run the replay CLI:

   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_analytics
   python -m rithmic_analytics.cli.replay_session `
       --trade-log C:\Users\Neel\Downloads\orders_2026-05-19.csv `
       --jsonl data\captures\2026-05-19\MNQ_rth.jsonl `
       --output data\reports\replay_2026-05-19.html `
       --zones data\zones\2026-05-18_MNQ_rth.json
   start data\reports\replay_2026-05-19.html
   ```

The CSV loader handles Tradesea's quirks automatically: reverse-chronological
ordering, `CME:MNQ` symbol prefix, PDT/PST timestamps, and the
missing-decimal bug on price columns (logs a WARNING line per occurrence;
quarantines fills/orders where recovery is ambiguous).

### Option B — Manual JSON log (fallback)

For fills you placed off-platform (mobile, paper, etc.) — maintain a JSON
file by hand:

```json
{"fills": [
  {"fill_ts": "2026-05-19T14:32:15-04:00", "symbol": "MNQ",
   "side": "buy", "price": 27381.25, "quantity": 1,
   "order_type": "market", "fill_id": "m-001",
   "notes": "hvn-27380 reclaim"}
]}
```

ISO-8601 timestamps with explicit offset are required (naive timestamps
fail with a clear error). Run the CLI with `--trade-log fills.json`; the
extension determines which loader fires.

### Reading the report

- **Header** — gross PnL@60s, hit-rate@60s, "best window" (highest-hit-rate
  ET hour-of-day bucket with ≥3 fills).
- **Skip callouts** — if any fills were skipped (wrong symbol, outside the
  JSONL capture window), they're flagged at the top.
- **Fills table** — pre/post delta tells you whether the market was already
  one-sided when you entered. PnL columns at 60s / 300s / 900s are green/red
  coded. Em-dash means the session ended before that horizon.
- **Cancellations table** — only shown when Tradesea provided cancelled
  orders. Cancellation-rate in the header.

### What to look for

- **Pre delta vs your side**: if you bought into pre delta of +400 (already
  one-sided buy aggression), you're chasing — that's a flag.
- **PnL@60s positive but PnL@900s negative**: classic late-entry pattern —
  the move was right but you held too long. Look at the post delta to see
  when the tape turned.
- **Best window**: if 80%+ of your 10:30–11:30 ET fills win but 30% of your
  14:00+ fills win, that's a structural signal. Schedule around it.

### Common gotchas

- **Fills skipped as "outside window"** — your JSONL covered a different
  date than your trade log. Make sure `--jsonl` points to the same trading
  day as the CSV.
- **Cross-symbol fills warning** — Lucid is MNQ-only today, but if you ever
  trade MES/ES on the same account, those fills are skipped against an MNQ
  capture. Run a separate replay per symbol.
- **`atr_14: null` from zones JSON** — proximity falls back to top-5
  nearest zones regardless of distance, marked `(atr-fb)` in the nearest-zone
  cell. Expected when the prior session was too short for 14 bars at the
  configured bar size.

## Daily zone scoring (RA-027)

After each capture day finishes, you can grade the zones that were live
for that session against what price actually did. Over a 30-session
rolling window the per-conviction hit-rates become statistically
meaningful — that's the structural feedback loop telling you whether
SUPER zones really hold 80%+, HIGH ~60%, etc., and lets you size
accordingly per tier.

### Single-session scoring

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
python -m rithmic_analytics.cli.score_zones `
    --zones data\zones\2026-05-18_MNQ_rth.json `
    --jsonl data\captures\2026-05-19\MNQ_rth.jsonl `
    --output data\reports\quality_2026-05-19.json
```

This pairs **yesterday's zone JSON** (computed at 17:30 ET day before)
with **today's RTH price action** — the same question your morning
chart-prep asks: "did yesterday's HVN at 27381 hold today?"

### Rolling history (the structural feedback loop)

```powershell
python -m rithmic_analytics.cli.score_zones `
    --aggregate-from-dir data\zones `
    --captures-root data\captures `
    --output data\reports\history_30session.json `
    --pairing next-day `
    --window-sessions 30
```

Walks every zone JSON in `data/zones/`, pairs each against the
forward-day RTH capture (skipping weekends/holidays automatically up to
7 days forward), aggregates the trailing 30 sessions, and writes a
`HistoryReport` with Wilson 95% CI per conviction tier.

### Pairing modes

| `--pairing` | What it answers | When to use |
|---|---|---|
| **`next-day`** (default) | Did yesterday's zones hold today? | Structural feedback loop — the primary mode. |
| `globex-to-rth` | Did overnight zones survive RTH open? | Morning chart-prep validation. |
| `same-day` | Did the zones we computed today fit today's price action? | **Post-hoc, VP-algo tuning only** — emits a WARNING on use. Not a forward trading signal. |

### Reading a HistoryReport

Example output snippet:
```json
{
  "sessions_analyzed": 30,
  "pairing": "next-day",
  "hit_rate_by_conviction": {
    "SUPER": {"n_trials": 0, "rate": null, "insufficient_data": true, ...},
    "HIGH":  {"n_trials": 0, "rate": null, "insufficient_data": true, ...},
    "MED":   {"n_trials": 47, "n_success": 32, "rate": 0.681,
              "ci_low": 0.535, "ci_high": 0.798, "insufficient_data": false},
    "LOW":   {"n_trials": 0, "rate": null, "insufficient_data": true, ...}
  },
  "insufficient_data_tiers": ["SUPER", "HIGH", "LOW"]
}
```

Empty tiers (`n_trials: 0`) are **always rendered explicitly** so you
know they were checked, not silently filtered. The Wilson CI gives you
honest uncertainty: MED hit-rate above is `0.681 [0.535, 0.798]` over 47
zones — wider than the point estimate suggests. Don't size off the point
estimate; size off the lower CI bound until N grows.

### Tuning knobs

- `--settlement-window-minutes 10` (default): how long after a touch we
  wait before calling no-break a "held". Tighten for higher-vol regimes.
- `--internal-carveout-minutes 5` (default): window for the
  internal-at-open reclassification.
- `--window-sessions 30` (default): rolling-window size for the
  HistoryReport.

### What to look for in the rolling report

- **Tier ordering matches conviction intent**: `SUPER > HIGH > MED > LOW`
  hit-rates. If MED is beating HIGH, the conviction grader has a bug or
  your structural sources are mis-calibrated.
- **Ambiguous fraction**: `summary_by_conviction[tier].n_ambiguous /
  n_zones` should stay <15%. Higher means the settlement window is too
  tight or sessions are too short for that tier's zones.
- **Bounce vs continuation magnitude**: held zones should produce
  bounces ≥1× the ATR (otherwise the level isn't actionable);
  broken zones should produce continuations ≥2× the ATR (otherwise the
  break isn't worth chasing).

Today's Phase-1 emits **MED-only**; SUPER/HIGH require the multi-TF
aggregator (RA-021). Expect SUPER/HIGH rows to read "insufficient data"
until that ships and produces enough zones for the rolling window.

### Common gotchas

- **`atr_fallback: true` in a session report**: the envelope's `atr_14`
  was null and trade-recompute failed too (very short capture, fewer
  than 14 bars at 5min). Hit-rate is still computed against the
  contract-aware fallback (5 pts for MNQ), but trust it less for that
  session.
- **`functional_role: internal` outcomes**: zone band spanned the
  session-open price and didn't resolve via the carveout. These are
  always `ambiguous` — they're zones that needed a directional signal
  the session never provided.
- **`declared_type` vs `functional_role` mismatch on every row**: this
  is expected and benign — Phase-1 zones all carry `declared_type:
  "support"`. The `functional_role` field is where the meaningful
  classification lives.

## Credentials

The probe needs five Rithmic values: `RITHMIC_CONNECT_POINT`,
`RITHMIC_SYSTEM_NAME`, `RITHMIC_USER`, `RITHMIC_PASSWORD`,
`RITHMIC_RPROTOCOL_HOME`. They are resolved in this order, highest precedence
first:

1. **Environment variables** — what production uses. Set system-wide
   (*System Properties → Environment Variables → System variables*) so
   Task Scheduler-launched processes inherit them. This is what
   [`task_scheduler_setup.md`](./task_scheduler_setup.md) walks through.
2. **`<project_root>/.env`** — for developer-laptop use. Same names as the
   env vars; `KEY=VALUE` per line; matching quotes around the value are
   stripped. The file is in `.gitignore` — never commit it.
3. **`~/.rithmic_creds.toml`** — legacy fallback. TOML keys are
   `connect_point`, `system_name`, `user`, `password`, `rprotocol_home`.

Env beats `.env` beats TOML. The first source that provides a non-empty
value wins per field, so partial coverage (e.g. password in env, rest in
`.env`) is fine.

Example `.env` for local dev:

```bash
# tools/rithmic_analytics/.env
RITHMIC_CONNECT_POINT=login_agg.rithmic.com:65000
RITHMIC_SYSTEM_NAME="Rithmic Paper Trading"
RITHMIC_USER=neel
RITHMIC_PASSWORD=...
RITHMIC_RPROTOCOL_HOME=C:\rprotocol
```

Parser is stdlib only (~15 lines): `#` comments and blank lines skipped;
malformed lines without `=` silently ignored; no multi-line, no escape
sequences, no `${VAR}` expansion. If your secret needs any of those, use
the TOML fallback or set the env var directly.

When the Rithmic password rotates: update whichever source you're using and
run `python -m rithmic_analytics.cli.start_capture --root-symbol MNQ --session rth --dry-run`
to confirm; no need to re-register scheduled tasks (they read env vars at
invocation time).

## Failure modes

### Rithmic disconnects mid-session

**Symptom.** Today's capture file is shorter than usual. The
`RithmicHeartbeat` check writes today's heartbeat regardless, so the heartbeat
log won't flag it. Look for one of:

- `data/alerts/alerts.ndjson` entries with `stream="LAST_TRADE"` and
  `gap_type="time"`, `severity="FAIL"` near the disconnect time.
- The capture dashboard's "Sessions" row showing a smaller-than-typical RTH
  byte count.
- `daily_zones_<date>.log` carrying the "partial capture" warning (fewer than
  `--partial-capture-warn-threshold` trades — default 50,000).

**Recovery.**

1. **Identify the gap.** `Get-Content data/alerts/alerts.ndjson -Tail 30` —
   look for the last FAIL entry on the affected session.
2. **Is the wrapper still running?** `Get-Process python` should show the
   probe process. If not, the wrapper has already exited; the JSONL is final.
   If yes, decide whether to let the wrapper continue (probe may reconnect
   on its own — Rithmic protocol allows it) or kill it and accept partial
   data.
3. **Reprocess the partial capture.** Re-run daily_zones for the affected day
   to regenerate the zone JSON from whatever was captured:
   ```powershell
   python -m rithmic_analytics.cli.daily_zones --trading-date 2026-05-15
   ```
   The "partial capture" warning will fire; the zone JSON is still valid for
   the trades that *did* land.
4. **If the disconnect was significant** (e.g. lost 30+ minutes of RTH):
   document the gap in your trading journal and treat that day's zones with
   reduced conviction.

The wrapper's `terminate()` on Windows is effectively `kill()` — the JSONL
may be missing its final line. RA-009's gap detector surfaces this as a
terminal-gap alert; it's not silently lost. See
[architecture.md D-002](./architecture.md).

### A scheduled task didn't fire

**Symptom.** No `wrapper.log` for today; no zone JSON; dashboard shows
yesterday as the most recent row.

**First check.**
```powershell
schtasks /Query /TN RithmicCapture_RTH /V /FO LIST
```
Look at `Last Run Time`, `Last Result`, `Next Run Time`. If `Last Run Time`
is older than expected:
- **System was off / asleep during the window** → `RithmicHeartbeat` will
  emit `CAPTURE_HEARTBEAT_MISSING` on its next 10:00 ET run. Accept that
  day as a write-off.
- **Task is disabled** → re-enable: `schtasks /Change /TN RithmicCapture_RTH /ENABLE`.
- **Task was deleted (Windows Update or manual)** → re-run
  `install_scheduled_tasks.ps1` (see
  [`task_scheduler_setup.md`](./task_scheduler_setup.md)).

The heartbeat task can itself silently disappear if Windows Update wipes
Task Scheduler entries — there is currently **no external monitor of the
monitor**. Mitigations tracked in [`future_work.md` item 6](./future_work.md).

### Live capture produced an empty replay report / zero zones

**Symptom.** `cli.replay_session` shows every fill as "outside window";
`cli.daily_zones` logs "0 trades" or "capture is unrecoverable"; the
capture-quality dashboard shows the expected file size but no analytics.

**Diagnose.** Sniff the first record of the capture:

```powershell
Get-Content data\captures\<date>\MNQ_rth.jsonl -TotalCount 1 | ConvertFrom-Json
```

Two failure modes:

1. **`raw_present: false` AND no `price` / `size` fields** → the capture
   was made WITHOUT `--parity-payload` (default before RA-029, or
   explicitly set via `--no-parity-payload`). The trade-level data was
   never persisted to disk. **Unrecoverable** for that day.
   - Confirm via `cli.normalize` — it'll exit non-zero with an
     `UNRECOVERABLE CAPTURE` error rather than silently producing empty
     output.
   - Forward fix: next capture launches automatically pick up
     `--parity-payload` (RA-029 default). One trading day's loss.

2. **`raw_present: false` BUT `price` / `size` present** → parity capture,
   but the analytics layer can't read this shape directly. Normalize
   first:
   ```powershell
   python -m rithmic_analytics.cli.normalize `
       --input data\captures\<date>\MNQ_rth.jsonl `
       --output data\captures\<date>\MNQ_rth.obs01.jsonl
   ```
   Then re-run the consumer (replay_session, daily_zones, score_zones).
   `daily_zones` does this automatically on the nightly sweep — manual
   normalize is for ad-hoc backfills.

The capture pipeline contract is documented in [architecture.md D-006](./architecture.md).

### Capture started but produced no zone JSON

**Symptom.** `data/captures/YYYY-MM-DD/MNQ_rth.jsonl` exists and is sized
normally, but `data/zones/YYYY-MM-DD_MNQ_rth.json` is missing.

**Likely causes.**

1. **`daily_zones` hasn't run yet.** RTH closes at 16:05 ET; daily_zones
   fires at 17:30 ET. Wait until after 17:30 ET — or run it manually with
   `--trading-date`.
2. **Schema validation failure.** Check `logs/daily_zones_<date>.log` for an
   `emitted envelope ... failed schema validation` line. This shouldn't
   happen — if it does, it's a bug; capture the envelope dict and file an
   issue.
3. **Load error.** Same log file will show `failed to load .../MNQ_rth.jsonl`
   with a JSON / KeyError / ValueError reason. Most common cause: a
   truncated last line from a hard-killed probe (D-002). Trim the file's
   final partial line and rerun.

### Disk pressure (capture root >85%)

`RithmicRotation` runs nightly at 02:00 and is the primary defence —
2 trading days raw + 14 days compressed is the steady-state footprint. If
disk usage is climbing despite rotation:

1. Inspect the rotation report: rerun `--dry-run` and read the JSON.
   `disk_used_pct_before` / `..._after_projected` and the `warnings` array
   tell you what rotation thinks it can free.
2. **Old archives not being deleted?** Confirm
   `data/captures_archive/` contains directories older than
   `compressed_hot_days` (14). If yes and rotation says "would delete" but
   isn't, check `apply_rotation`'s per-file errors in the report.
3. **A specific day's MBO/MBP10 is unexpectedly huge?** MBP10 is
   ~28 GB/RTH; if it's in the lean stack accidentally (it shouldn't be),
   exclude it from capture or move it to cold storage.

### Alerts file growing without bound

`alerts.ndjson` is append-only — gap and heartbeat alerts both land there
([D-005](./architecture.md)). It is not rotated automatically. If it's
many GB, archive the file outside `data/alerts/` and start fresh:

```powershell
Move-Item data\alerts\alerts.ndjson data\alerts\alerts.ndjson.archived-2026-05-15
```

The dashboard reads only the last `lookback_days` (default 30) from the
file, so archiving doesn't lose recent context.

### Aggressor-coverage warning

`load_obs01_trades` warns if more than 1% of TRADE envelopes have
`aggressor_side="unknown"`. Per the Rithmic spec, coverage should be ≥99%
in practice. When the warning fires:

- **>5% unknown** — feed-quality problem. The session's CVD and absorption
  numbers will be biased low (unknown contributes 0 to `signed_qty`).
  Re-check the JSONL for partial records (truncated `payload`) or
  protocol-version mismatches.
- **1–5% unknown** — usually transient; note it in the journal and continue.

## Monitoring touchpoints

| Surface | What it tells you | How often to check |
|---|---|---|
| `data/reports/capture_dashboard.html` | 30-day capture health, alerts trend | Daily, 90s glance |
| `data/alerts/alerts.ndjson` (raw) | Per-gap detail when dashboard flags something | On dashboard FAIL |
| `logs/daily_zones_<date>.log` | What `daily_zones` did, partial-capture warnings, schema errors | When a zone JSON is missing |
| `data/captures/<date>/wrapper.log` | Per-session capture launch + probe stdio | When a capture fails or has gaps |
| `data/heartbeat/<date>.txt` | "I was alive at 10:00 ET on this date" | Implicit — heartbeat-miss alerts call this out |

The dashboard is the right entry point for routine checks; the rest are
drill-downs.

## Manual edits in `D:\MNQ-Futures\tools\vp_*.py`

Until RA-020 generalises these scripts, each trading day Neel manually
updates a few constants in `vp_multi_tf_full.py`, `vp_15m_compute.py`, and
`vp_htf_globex_prep.py`. The exact lines + current values are catalogued
in [`future_work.md` items 7–9](./future_work.md). A future generalization
ticket can collapse these into a daily `prep.toml` regenerated from market
state.

## RA-041 — Picking up the L1_QUOTE forward-fill on existing captures

The on-disk MBP1 sibling produced by `normalize_probe` before RA-041
shipped is a delta tape (only the side that changed carries its fields;
the other side is `0.0`/`0`/`0`). On real MNQ Globex this means ~99.8%
of records are one-sided when read by `load_mbp1` — enough for absorption
analytics' asof-merge to silently degrade (it pulls forward whatever
sparse two-sided rows exist, often minutes stale of the trade bar).

To pick up RA-041's forward-fill on a session that already has cached
siblings, delete the cached OBS-01 file and let the next `daily_zones`
run regenerate everything from the raw parity capture (mirrors the
RA-035 MBO sibling invalidation workflow):

```powershell
# Force re-normalization for a single trading day.
Remove-Item data\captures\2026-05-21\MNQ_globex.obs01.jsonl
Remove-Item data\captures\2026-05-21\MNQ_globex.mbp1.jsonl
Remove-Item data\captures\2026-05-21\MNQ_globex.mbo.jsonl  # if present
# Next daily_zones run produces fresh siblings with the RA-041 fix applied.
```

Verify the fix landed:

```powershell
python -c "from pathlib import Path; from rithmic_analytics.core.loader import load_mbp1, summarize_spread; df = load_mbp1(Path('data/captures/2026-05-21/MNQ_globex.mbp1.jsonl')); s = summarize_spread(df); print(f'two-sided: {((df.bid_px_00 > 0) & (df.ask_px_00 > 0)).mean()*100:.2f}%'); print(f'spread mean: {s.mean_ticks:.2f}t  p99: {s.p99_ticks:.2f}t  crossed: {s.n_crossed_quotes}')"
```

Target post-fix: **>95% two-sided coverage**, spread mean 1-3 ticks,
n_crossed_quotes near zero. The `daily_zones` log line for the
normalize step now surfaces the diagnostic counters (`ff=...` for
forward-filled, `edge=...` for first-record one-sided) — predicted
~99% ff, 1-5 edge per session. Significant deviation from those numbers
points to a probe-side schema change worth investigating.

## RA-052 — Intraday-light vs EOD-heavy analytics

The 2026-05-27 memory incident established a hard operational split:

| Tier | Cadence | Command shape | Purpose |
|---|---|---|---|
| Intraday-light | Every 5 minutes during active capture | `daily_zones --mode light` | Normalize new probe records incrementally, refresh VP/probability/live-analysis artifacts, avoid full MBO scans |
| EOD-heavy | Once at 13:15 PT after RTH close | `daily_zones --mode full` | Rebuild normalized siblings and run pressure/cancellation analytics intentionally |

The intraday runner is:

```powershell
D:\Quant-futures-app\tools\rithmic_dashboard\scripts\run_local_probe_refresh.ps1 `
  -TradingDate <YYYY-MM-DD> -Session rth -Loop -IntervalMinutes 5
```

Default behavior:

- Calls `python -m rithmic_analytics.cli.normalize_probe_incremental`.
- Calls `python -m rithmic_analytics.cli.daily_zones --mode light`.
- Does **not** call the retired V1 static HTML generator.
- Does **not** run `--emit-pressure-json` or `--emit-cancellation-analysis`.

The EOD-heavy runner is:

```powershell
D:\Quant-futures-app\tools\rithmic_dashboard\scripts\run_eod_full_analytics.ps1 `
  -TradingDate <YYYY-MM-DD> -Session rth
```

It performs a full `cli.normalize --force` rebuild first, then runs
`daily_zones --mode full`. It does not generate V1 HTML. If an operator manually passes
`-EmitHeavyAnalytics` to `run_local_probe_refresh.ps1`, that is treated as
an explicit EOD-style opt-in and maps to `daily_zones --mode full`.

### RA-071 V1 HTML retirement

The old `python -m rithmic_dashboard.cli.generate` static HTML dashboard is
retired. Direct calls now fail loudly and point to the v2 realtime stack. The
archived implementation is kept under `rithmic_dashboard/legacy_v1/` only for
historical reference.

Use the realtime stack instead:

```powershell
D:\Quant-futures-app\run_realtime_stack.ps1
```

RA-071 does **not** change normalize ownership. Before the RA-070 cutover, the
5-minute loop should keep normalizing. After the operator enables
`RA60_SELF_NORMALIZE=1`, start the loop with `-SkipNormalize` so exactly one
normalizer writes the capture siblings. Do not run loop normalize and backend
self-normalize at the same time.

### Mode guard rules

- `--mode light` rejects `--emit-pressure-json` and
  `--emit-cancellation-analysis` with an error. This is intentional.
- Omitting `--mode` while passing those heavy flags still works for old
  scripts, but logs a deprecation warning and routes to full mode.
- Omitting `--mode` and passing no heavy flags defaults to light mode.

### Incremental normalize state

Each raw capture gets a state file next to the normalized siblings:

```text
data/captures/<date>/MNQ_rth.obs01.normalize_state.json
```

If the state is missing, corrupt, points at a different raw file, or the raw
file shrank/rotated, the incremental normalizer falls back to a full
normalize and writes an audit entry:

```text
event_type: normalize_state_missing_fallback_full
```

The audit metadata includes `input_size_bytes`, `reason`, `session_id`, and
`session_fallback_count`. More than one fallback event for the same session
is a monitoring signal: investigate state-file atomicity, file rotation, or
unexpected output deletion before the loop drifts back toward expensive full
rebuilds.

### Mis-invocation markers

Check `data/dashboard/local_probe_refresh_<date>.log`:

- Healthy intraday line: `normalize incremental <session>`.
- Healthy intraday line: `daily_zones ... --mode light`.
- Healthy RA-071 line: `V1 dashboard generation retired`.
- Investigate immediately: repeated `normalize_state_missing_fallback_full`
  events in `_audit.json`.
- Investigate immediately: `--emit-pressure-json` or
  `--emit-cancellation-analysis` appearing in a 5-minute loop command.

## Contract rollover

Front-month rollover is handled by
[`ops.rollover_calendar`](../rithmic_analytics/ops/rollover_calendar.py).
`cli.start_capture` resolves the active contract automatically — no manual
update needed across a rollover. Quarterly rollover dates are in the
calendar config; if rollover ever produces unexpected behaviour, see
[`rollover_playbook.md`](./rollover_playbook.md).

## When in doubt

1. Open the v2 realtime dashboard. If it's green, the pipeline is fine.
2. Read the relevant log under `logs/` or `data/captures/<date>/`.
3. Check [`architecture.md`](./architecture.md) for the *why* behind a
   surprising behaviour — many design choices were deliberate (e.g.
   trading-day partitioning, D-002 hard kill, D-005 alert wire shape).
4. If the issue isn't covered above and isn't a clear bug, capture symptoms
   and add a new failure mode to this file.
