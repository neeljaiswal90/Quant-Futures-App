# RA-052 Dispatch - Intraday-light vs EOD-heavy analytics split

Copy-paste below into Codex. Operational hardening ticket prompted by
the 2026-05-27 memory incident: the 5-minute dashboard refresh loop was
running heavyweight EOD MBO analytics against a live-extending RTH
capture and pushed Python to roughly 40GB peak memory.

Recommended NEXT build before more analytics features. The manual
stopgap is already in place via `run_local_probe_refresh.ps1`
`-EmitHeavyAnalytics`; RA-052 turns that stopgap into a durable CLI
contract, EOD path, regression guard, and incremental normalize.

---

# Copy-paste below

```
RA-052 - Intraday-light vs EOD-heavy analytics split + incremental normalize.

On 2026-05-27 the trading machine hit a serious operational issue: the
5-minute dashboard refresh loop was invoking heavyweight daily_zones
MBO work (`--emit-pressure-json` and `--emit-cancellation-analysis`)
against a live-extending RTH capture. The heavy path loaded full MBO
order lifecycle state and pushed Python to roughly 40GB peak memory.

A manual stopgap has already been applied:

- `D:\Quant-futures-app\tools\rithmic_dashboard\scripts\run_local_probe_refresh.ps1`
  now has an explicit `-EmitHeavyAnalytics` opt-in switch.
- Default 5-minute intraday loop runs the light path only.
- `-EmitHeavyAnalytics` is reserved for EOD/full analytics.

This ticket formalizes that split in the Python CLI, adds an EOD script,
adds memory regression coverage, and introduces incremental normalize so
the dashboard loop stops re-scanning full captures every 5 minutes.

Ticket spec at:
D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md (search "RA-052")

~4-6h estimate. P1. Project:
- Primary: `D:\Quant-futures-app\tools\rithmic_analytics`
- Consumer validation: `D:\Quant-futures-app\tools\rithmic_dashboard`

# Context you need before building

1. **Preserve the current stopgap contract.** The existing
   `run_local_probe_refresh.ps1 -EmitHeavyAnalytics` switch must keep
   working. Default/no-switch behavior must remain intraday-light.
   With the switch, route through the new full/EOD mode. Do not remove
   the switch or make heavy analytics default again.

2. **This is an ops-safety ticket, not a new-signal ticket.** Do not add
   new CVD, sweep, absorption, dislocation, institutional, or day-type
   analytics. The work is CLI mode separation, scheduling script,
   memory guard, incremental normalization, and documentation.

3. **Mode semantics should be loud and explicit.** Recommended design:
   add `--mode light|full` to `rithmic_analytics.cli.daily_zones`.
   - Explicit `--mode light` plus `--emit-pressure-json` or
     `--emit-cancellation-analysis` should fail fast with a clear error.
   - Explicit `--mode full` permits heavy flags and full MBO work.
   - Backward compatibility: old callers that omit `--mode` but pass
     heavy flags should route to full mode with a deprecation warning.
   This avoids silent ignore behavior, which is how the incident
   becomes easy to repeat.

4. **The light path has a hard memory budget.** The intraday path must
   stay under 2GB peak RSS and should complete in under 30 seconds even
   against large live captures. If a feature requires full MBO order
   lifecycle scans, it belongs in full mode/EOD, not light mode.

5. **The EOD-heavy path is still allowed to be expensive, but bounded.**
   Full mode may run the pressure JSON and cancellation analysis, but it
   should be scheduled after RTH close, not every 5 minutes. Add a
   dedicated `run_eod_full_analytics.ps1` script for the once-per-day
   13:15 PT run. Document optional hourly full mode as a future opt-in
   pattern, but do not schedule hourly in this ticket.

6. **Incremental normalize is the second load-bearing fix.** The current
   dashboard loop still risks re-scanning the full raw capture. Add
   `rithmic_analytics.cli.normalize_probe_incremental` with a
   per-capture state file alongside the capture/obs01 artifacts:
   `<capture>.obs01.normalize_state.json`. It should resume from a byte
   offset, append normalized records, and atomically update state on
   success.

7. **Fallbacks should favor correctness with an audit trail.** If the
   incremental state file is missing or corrupt, do a full normalize
   fallback with a visible warning/audit log entry. Do not silently skip
   normalization. If the raw capture shrank or rotated unexpectedly,
   treat state as invalid and rebuild.

8. **Memory regression tests are the meta-requirement.** Without a test,
   future tickets can accidentally reintroduce full-MBO work into the
   intraday loop. Add tests that exercise light mode on a large/synthetic
   fixture and assert peak memory remains below the configured ceiling.
   Keep CI practical: synthetic fixtures may be generated sparse or
   scaled, but the test must catch accidental full-file materialization
   in light mode.

# Pre-build sweep expectation

Per established discipline (RA-040 through RA-051), do a pre-build
sweep BEFORE writing any source files:

- Plan paragraph summarizing the build and how the 5 phases connect
- Confirmation of the 8 ambiguity points from the ticket:
  1. `--mode light|full` flag vs separate CLI modules
  2. incremental normalize state-file location
  3. missing/corrupt state fallback behavior
  4. memory ceiling for light mode
  5. EOD trigger fixed time vs file watcher
  6. pressure/cancellation behavior in light mode
  7. backward compatibility for old heavy-flag callers
  8. anything surfaced while reading current `daily_zones.py`,
     `normalize_probe.py`, and `run_local_probe_refresh.ps1`
- Engineer's-call defaults taken unless flipped
- Time estimate per phase
- Explicit confirmation that the current `-EmitHeavyAnalytics` switch
  survives the refactor and maps to full mode

Surface the sweep as a single message. Wait for green-light before
writing code. Do not start Phase 1 source until explicitly approved.

# Build order recommendation

Phases are sequential:

1. **Phase 1 (~60-90 min): daily_zones mode split.**
   Add `--mode light|full` to `rithmic_analytics.cli.daily_zones`.
   Implement guard behavior:
   - `--mode light` rejects heavy flags with clear error.
   - `--mode full` permits heavy flags.
   - omitted mode + heavy flags routes to full with deprecation warning.
   - omitted mode + no heavy flags defaults to light.
   Add tests for every mode/flag combination.

2. **Phase 2 (~30-45 min): dashboard scripts + EOD full script.**
   Update:
   `D:\Quant-futures-app\tools\rithmic_dashboard\scripts\run_local_probe_refresh.ps1`
   so the default loop calls `daily_zones --mode light` explicitly.
   Preserve `-EmitHeavyAnalytics` and make it call `--mode full`.
   Add:
   `D:\Quant-futures-app\tools\rithmic_dashboard\scripts\run_eod_full_analytics.ps1`
   for the 13:15 PT full analytics run after RTH close.

3. **Phase 3 (~45-60 min): memory regression guard.**
   Add tests around light-mode memory behavior. Use `psutil` or a
   repo-consistent subprocess monitor. The goal is to fail if light mode
   loads full raw/MBO captures into memory. Keep the fixture practical
   for CI while still catching the incident class.

4. **Phase 4 (~75-90 min): incremental normalize.**
   Add `rithmic_analytics.cli.normalize_probe_incremental`.
   Requirements:
   - state file alongside capture artifacts
   - byte-offset resume
   - append-only normalized output
   - atomic state update after success
   - fallback full normalize on missing/corrupt/invalid state with
     visible warning/audit log
   - synthetic test: initial file + appended records yields identical
     obs01 output to a full normalize rebuild
   Wire the 5-minute dashboard loop to use incremental normalize.

5. **Phase 5 (~30-45 min): docs + post-mortem.**
   Update operations docs with the two-tier model:
   - intraday-light every 5 minutes
   - EOD-heavy once after RTH close
   - manual commands for both
   - memory expectations and log markers
   Create:
   `D:\Quant-futures-app\tools\rithmic_analytics\docs\incident_5_27_memory_blowup.md`
   documenting root cause, stopgap, permanent fix, and the rule for
   future tickets: full-MBO scans must be gated to full/EOD mode.

Buffer: ~30-45 min for integration, live dry-run, and cleanup.

# Smoke test paths after build

1. **Mode guard tests:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_analytics
   python -m pytest -q tests/test_daily_zones_mode_guard.py
   ```
   Expected:
   - explicit light + heavy flags fails clearly
   - explicit full + heavy flags works
   - omitted mode + heavy flags routes to full with deprecation warning
   - omitted mode + no heavy flags defaults to light

2. **Incremental normalize tests:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_analytics
   python -m pytest -q tests/test_normalize_incremental.py
   ```
   Expected: append/resume output matches full normalize output for the
   same synthetic capture.

3. **PowerShell dry-run verification:**
   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass `
     -File D:\Quant-futures-app\tools\rithmic_dashboard\scripts\run_local_probe_refresh.ps1 `
     -TradingDate 2026-05-27 -Session rth -DryRun -SkipNormalize -SkipDashboard
   ```
   Expected: command includes `daily_zones --mode light` and does not
   include pressure/cancellation flags.

4. **PowerShell heavy opt-in dry-run:**
   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass `
     -File D:\Quant-futures-app\tools\rithmic_dashboard\scripts\run_local_probe_refresh.ps1 `
     -TradingDate 2026-05-27 -Session rth -DryRun -SkipNormalize -SkipDashboard -EmitHeavyAnalytics
   ```
   Expected: command includes `daily_zones --mode full` and preserves
   heavy analytics opt-in semantics.

5. **EOD script smoke:**
   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass `
     -File D:\Quant-futures-app\tools\rithmic_dashboard\scripts\run_eod_full_analytics.ps1 `
     -TradingDate 2026-05-27 -Session rth -DryRun
   ```
   Expected: full-mode daily_zones command is printed and
   session-combined/next-day prep command is present if supported by the
   existing tooling.

6. **Memory guard:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_analytics
   python -m pytest -q tests/test_intraday_memory_guard.py
   ```
   Expected: light mode remains under the configured memory ceiling.

7. **Full suite + lint + types:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_analytics
   python -m pytest -x --tb=short
   ruff check .
   mypy rithmic_analytics
   ```
   Also run dashboard tests if this repo has a separate suite:
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -x --tb=short
   ruff check .
   mypy rithmic_dashboard
   ```

# Acceptance bar

- Default dashboard refresh path is explicitly light mode.
- `-EmitHeavyAnalytics` still exists and maps to full mode.
- Light mode cannot accidentally run pressure/cancellation analytics.
- Old heavy-flag callers continue to work via full mode with warning.
- Incremental normalize resumes correctly and is safe across corrupt
  state, missing state, and raw-file shrink/rotation.
- Memory regression test prevents full-capture materialization in light
  mode.
- `run_eod_full_analytics.ps1` exists and can dry-run the full path.
- Operations docs and incident post-mortem are updated.
- Existing tests remain green; ruff + mypy clean.

# Docs

Update:
- `D:\Quant-futures-app\tools\rithmic_analytics\docs\operations.md`
- `D:\Quant-futures-app\tools\rithmic_analytics\docs\feature_reference.md`

Create:
- `D:\Quant-futures-app\tools\rithmic_analytics\docs\incident_5_27_memory_blowup.md`

Docs must clearly state:
- intraday-light runs every 5 minutes
- EOD-heavy runs after RTH close
- `-EmitHeavyAnalytics` is opt-in only
- any future full-MBO flag belongs in full mode unless proven safe
- how to detect a mis-invoked loop from logs

# Out of scope

- Real-time streaming normalization inside the capture process
- Rewriting pressure/cancellation analysis to be fundamentally
  memory-efficient
- Moving from pandas to polars/Arrow
- Multi-symbol scheduling
- New trading signals or probability multipliers

# Standing by

Acknowledge this prompt and surface the pre-build sweep: plan paragraph,
8 ambiguity confirmations, phase estimates, and confirmation that the
`-EmitHeavyAnalytics` contract remains intact. Do not write source until
green-lit.
```
