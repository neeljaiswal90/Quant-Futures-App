# RA-045 Dispatch — Dashboard hardening + orderflow integration

Copy-paste below into a fresh Codex session (or continue an existing dashboard
session). Codex should pre-build sweep, then implement.

---

# Copy-paste below

```
RA-045 — Dashboard hardening + orderflow integration. First-iteration 
review of the dashboard (live at file:///D:/Quant-futures-app/tools/rithmic_dashboard/
data/dashboard/index.html as of 2026-05-21 15:40 PT) surfaced four 
load-bearing issues + two high-value enhancements. Ticket spec at:

D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md (search "RA-045")

~8h estimate. P1. Single-session focused build on the existing 
tools/rithmic_dashboard/ project.

# Context you need before building

1. **Dashboard reading combined VP misses statistical bands.** The 
   current envelope is `2026-05-21_MNQ_session_combined.json` which only 
   carries volume-derived zones (HVN/LVN/VAH/VAL/VPOC). The statistical 
   reference_lines (VWAP, ±1σ, ±2σ from RA-031) only exist in the 
   RTH-only zones JSON (`2026-05-21_MNQ_rth.json`). Distance Grid is 
   missing 4 of the most-operationally-important rows because of this 
   single data-source bug.

2. **Scenario A stop is 150pt wide** (entry 29,230-29,240, stop 29,085). 
   That's a "tight confluence reversion" with -2σ as fallback stop. 
   R:R math becomes meaningless (0.00R at T1). Per-scenario stop policy 
   needs tightening — spec is in the ticket.

3. **Audit trail noise**: "Zones JSON missing" repeats every 15 min (6× 
   visible in current audit). Data warnings belong in the warnings panel, 
   not the audit trail. Audit should be strictly state-machine events.

4. **State machine has no hysteresis** — Scenario B2 flipped 
   DORMANT↔WATCHING three times in 7 minutes around its 2-ATR boundary. 
   Asymmetric thresholds (2.0 ATR promote / 2.2 ATR demote) eliminate.

5. **Two new sections add load-bearing value**:
   - Orderflow Pulse — surfaces CVD/spread/pressure/absorption (existing 
     RA-030.1/RA-035/RA-037 artifacts that the dashboard currently ignores)
   - Active Posture — 2-4 sentence synthesized recommendation that 
     synthesizes scenario states + CVD + price-vs-VWAP into a glance-able 
     "what to watch" summary

6. **Pre-build sweep is required per the established pattern.** Five 
   ambiguity points to call before coding (envelope merge precedence, 
   CVD window, posture sentence count, pulse section position, hysteresis 
   values). All have recommended defaults in the ticket; confirm or flip.

# Pre-build sweep expectation

Per the discipline that produced ~10x velocity on prior tickets, do a 
pre-build sweep BEFORE coding:

- Plan paragraph summarizing the build
- Confirmation of the four P0 fixes' design decisions
- Answers/picks on the five ambiguity points
- Engineer's-call defaults taken unless flipped
- Time estimate

Surface the sweep as a single message. Wait for green-light before 
writing code.

# Build order recommendation

1. **P0.1 (dual-source envelope merge)** — load-bearing for everything 
   else. Once VWAP + σ bands are in the envelope, the Distance Grid 
   immediately becomes more useful AND the Scenario state machine has 
   correct inputs for B1/B2/C/G stop calculations.

2. **P0.2 (scenario stop tightening)** — depends on P0.1 (need σ bands 
   loaded to validate). Per-scenario policy + cap at 0.5-1.5× ATR.

3. **P0.4 (state-machine hysteresis)** — small, isolated. Could be done 
   alongside P0.2.

4. **P0.3 (audit dedup)** — simple, isolated. Can be done independently 
   anytime.

5. **P1.5 (orderflow pulse)** — new section, ~3h. After P0 done.

6. **P1.6 (active posture)** — depends on P1.5 (uses CVD direction). 
   Last. ~2h.

# Smoke test paths after build

After full build:

1. **Re-run dashboard generator against today's data**:
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m rithmic_dashboard.cli.generate --output-path data\dashboard\index.html
   ```
   
2. **Open the file in browser**:
   ```
   file:///D:/Quant-futures-app/tools/rithmic_dashboard/data/dashboard/index.html
   ```

3. **Visual verification checklist**:
   - Distance Grid: includes VWAP, +1σ, -1σ, +2σ, -2σ rows (not just HVN/LVN/VAH/VAL/VPOC)
   - Scenario A: stop is in 29,210-29,220 range; T1 R-multiple is ≥3R
   - Audit trail: no "Zones JSON missing" entries (those moved to warnings panel)
   - Orderflow Pulse: new section visible between Distance Grid and Scenarios, populated
   - Active Posture: new section directly below header, 2-4 sentences
   - All 7 scenarios still render (A, B1, B2, C, D, E, G)

4. **Hysteresis verification** (synthetic):
   - Manually perturb the state file to put B2 right at the 2-ATR boundary
   - Run generator 4 times; B2 state should change at most 1× per direction

5. **Full suite + lint + types**: 
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -x --tb=short
   ruff check .
   mypy rithmic_dashboard
   ```
   Target: ~70 tests green; ruff + mypy clean.

# Docs

Update `feature_reference.md` (new modules: orderflow_pulse, 
posture_synthesis, envelope_loader changes). Update `operations.md` with 
the new sections' meaning + how to read them.

# After ship

The dashboard should look materially better than the current iteration. 
The Distance Grid becomes complete (VWAP + σ context); scenario R:R 
becomes interpretable; orderflow signal joins the static structural 
levels; active posture gives a 1-glance read.

Tomorrow morning's first full-pipeline cycle is the production test. 
Standing by for the pre-build sweep.
```
