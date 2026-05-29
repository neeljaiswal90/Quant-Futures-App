# Codex Prompt 3 of 3 — Dashboard AUTOMATION

Send this AFTER the analysis prompt is acknowledged and the dashboard 
generator is at least scaffolded. Specifies the 15-min update scheduling + 
failure handling + how to consume from the browser.

---

# Copy-paste below

```
The dashboard generator from Prompt 2 produces a static HTML file on each 
invocation. This prompt covers the AUTOMATION: schedule it to run every 
15 minutes, handle failures gracefully, persist state across runs, and 
make it consumable from a browser tab.

# Scheduling

Use your scheduling tool to fire the dashboard generator on a 15-minute 
cadence. Specifics:

- **Cadence**: every 15 minutes, on 15-min boundaries (00, 15, 30, 45 
  minutes past the hour) — easier for Neel to predict refresh times
- **Active hours**: 24/7 during weekdays Mon-Fri. Skip weekends.
- **Holidays**: same as the capture operator — no calendar; skip if data 
  sources are stale/empty
- **First invocation**: immediately when this prompt is received (don't 
  wait 15 min for the first one)

# What runs every 15 min

```powershell
cd D:\Quant-futures-app\tools\rithmic_dashboard
$logPath = "data\dashboard\generator_$(Get-Date -Format 'yyyy-MM-dd').log"
$start = Get-Date

python -m rithmic_dashboard.cli.generate `
    --output-path data\dashboard\index.html `
    2>&1 | Out-File -Append -FilePath $logPath

$elapsed = ((Get-Date) - $start).TotalSeconds
Add-Content -Path $logPath -Value "Generator completed in $($elapsed.ToString('F2'))s at $(Get-Date -Format 'HH:mm:ss')"
```

Note: the dashboard project lives at `tools/rithmic_dashboard/` (per the 
architectural decision in Prompt 1). If Codex put it inside 
rithmic_analytics, adjust paths accordingly.

# Failure handling

Each 15-min invocation must be idempotent and defensive. Per-failure 
behavior:

| Failure mode | Detection | Action |
|---|---|---|
| Zones JSON missing for trading_date | `not Path.exists()` | Generator writes "missing data" HTML with the missing path. Status report flags it. Sleep 15 min, retry. |
| Capture file missing | Same | Same — generator marks "no live price; using last known" |
| Capture file present but no LAST_TRADE records | `last_price is None` | Generator marks "stale price" + shows last known. Don't crash. |
| Current price seems wrong (>10× ATR away from VWAP) | sanity check in generator | Generator flags "PRICE OUTLIER — verify capture quality" but still renders. Don't suppress. |
| State file corrupt (JSON parse error) | exception in load | Move corrupt file to `_state.json.broken_<ts>`, start fresh. Log it. |
| Template render error (Jinja2 exception) | exception | Generator writes a minimal error page with the exception text + last-good timestamp. Don't crash the schedule. |
| Generator runtime > 60s | wall-clock measurement | Log WARNING. Next invocation continues normally. |
| Disk write failure | exception | Log error. Next invocation retries. |

The dashboard renders best-effort. If ANY section fails, the OTHER 
sections still render. Section-level try/except wrapping (similar to 
RA-030.1's defensive emit pattern).

# State persistence across runs

State files live in `data/dashboard/`:

- `index.html` — the rendered output
- `_state.json` — per-level last-known distance + last-check timestamp 
  (for crossing detection)
- `_scenarios.json` — per-scenario state machine (state + entry-fill 
  timestamps + outcome)
- `_audit.json` — last 50 audit entries
- `generator_<date>.log` — daily log file

State files survive across the daily session boundary. On session 
transition (e.g., RTH→Globex at 14:55 PT), the generator detects the new 
session and resets `_scenarios.json` (each scenario is per-session-bound). 
`_audit.json` is rolling regardless of session.

# Initial setup steps (one-time)

Before the schedule kicks in, do these once:

1. **Create the dashboard project structure** per the architectural choice 
   in Prompt 1.
2. **Run a manual smoke test**:
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m rithmic_dashboard.cli.generate --output-path data\dashboard\index.html
   ```
   - Confirm `data/dashboard/index.html` is generated
   - Open it in Chrome: `file:///D:/Quant-futures-app/tools/rithmic_dashboard/data/dashboard/index.html`
   - Verify it renders correctly with the current zones JSON
3. **Create a desktop shortcut** to the HTML file for one-click access.
4. **Schedule the recurring generator** per the cadence above.
5. **Send Neel a notice** when scheduled — "Dashboard automation live, 
   refreshes every 15 min. Open `<path>` in your browser to view."

# Browser consumption pattern

Neel opens the HTML file once and leaves it in a tab. The `<meta 
http-equiv="refresh" content="900">` tag auto-reloads every 15 min — 
slightly after the generator writes the new HTML, so the page always shows 
the latest data.

Refresh timing: 
- Generator runs at :00, :15, :30, :45 of each hour
- Browser meta-refresh fires 15 min after page load
- These will drift relative to each other over time, but within a few 
  minutes of accuracy is fine

**For tighter sync** (optional v2): switch the page to JavaScript polling 
that checks a `last_updated.txt` file's mtime and reloads when it changes. 
~30 lines of vanilla JS. Defer unless Neel finds the meta-refresh too 
imprecise in practice.

# Monitoring

Codex's scheduled task should write a daily summary to 
`data/dashboard/daily_summary_<date>.md` at the end of each day:

```markdown
# Dashboard daily summary — 2026-05-21

## Generator invocations
- Total: N
- Successful: N  
- Failed: N (with reasons)

## Average runtime: X.Xs

## Sessions covered
- Globex: <start> — <end>
- RTH: <start> — <end>

## Notable state changes
- [List from _audit.json today's entries]

## Anomalies
- [Any WARNING / ERROR log lines]
```

Append a line to `data/codex_reports/dashboard_health.md` for Neel's 
operational visibility.

# Pause / unpause workflow

Neel may want to pause the dashboard (e.g., when actively trading and the 
auto-refresh is distracting). Implement a simple pause file:

- If `data/dashboard/_pause.flag` exists, the scheduler skips the generator 
  invocation and just logs "paused, skipping."
- Neel creates the flag manually (`echo > _pause.flag`) and deletes it to 
  resume.
- The generator itself does NOT pause — it just runs less often. The 
  meta-refresh in browser still fires; it'll just show stale data with a 
  visible "PAUSED" header banner (read the flag file in the generator).

# Coexistence with other Codex schedules

Neel has two other long-running Codex schedules:
1. `codex_capture_operator.md` v2 — manages Globex + RTH probe captures + 
   normalize + daily_zones
2. This dashboard generator (NEW)

These should NOT conflict:
- Capture operator runs on session-boundary schedules (14:50, 14:55, every 
  30 min during sessions, 06:30, 13:10, 13:16)
- Dashboard generator runs every 15 min on 15-min boundaries
- They share `data/zones/*.json` but with read/write separation: capture 
  operator WRITES; dashboard READS
- File locking shouldn't be an issue since the dashboard only reads 
  zones JSON (never writes to it)

If you discover a conflict (e.g., the capture operator is mid-write of 
zones JSON when dashboard tries to read), implement retry-with-backoff in 
the read path. Should be rare.

# Acceptance criteria

- Scheduler fires the generator every 15 min on :00/:15/:30/:45 boundaries
- First invocation happens immediately on prompt receipt
- Each invocation completes successfully OR writes an error-state HTML 
  that explains why
- Browser refresh shows updated data within ~1 min of generator writing
- Daily summary file written at end of each weekday
- Pause flag respected
- Logs accumulate in `data/dashboard/generator_<date>.log` for 
  diagnostics
- Failure of one component (e.g., session signals section) doesn't gate 
  the whole page

# Code quality bar

Match rithmic_analytics standards:
- ruff + mypy clean
- ≥80% test coverage on logic modules (renderer is harder to test, 
  acceptable to be lower)
- Frozen dataclasses where possible
- Section-level try/except wrap (defensive emit pattern)
- Clear log lines with structured context (timing, file paths, decisions)

# Failure-mode triage (operational, for Codex)

If you observe these patterns, surface in the daily summary:

- **Generator runtime > 30s consistently**: zones JSON parsing or capture 
  file tail-read is slow. Profile + optimize.
- **Repeated "missing zones JSON" warnings**: capture operator may be 
  failing. Cross-check with operator status reports.
- **Scenarios stay in DORMANT all session**: configuration error in the 
  scenario-to-envelope mapping. Test the mapping logic against the 
  current envelope.
- **Audit trail not growing**: state file persistence is broken. Verify 
  read-modify-write cycle.

# Communication

When scheduling is live, write a one-time status message to Neel:

```
Dashboard automation engaged.

Cadence: every 15 min on :00/:15/:30/:45 boundaries
Path: D:\Quant-futures-app\tools\rithmic_dashboard\data\dashboard\index.html
Browser: open the file in any browser; it auto-refreshes every 15 min
Pause: create _pause.flag to skip generator runs
Resume: delete _pause.flag

Standing by. Next scheduled run: <HH:MM PT>
```

Then proceed with scheduling. Self-check after the first 2-3 invocations 
that they're firing correctly + producing valid HTML.

# Standing by

Acknowledge this prompt + confirm the scheduling tool you'll use + 
provide the first scheduled-run timestamp. Then proceed.
```
