# RA-046 Dispatch — Live intra-session signals + quantifiable probability

Copy-paste below into Codex. Builds on RA-045 (which just shipped) — the
dashboard becomes responsive to real intra-session signals instead of
static priors.

---

# Copy-paste below

```
RA-046 — Live intra-session signal computation + quantifiable probability 
framework. RA-045 fixed the dashboard's structural display issues; this 
ticket makes the probability MEAN something by feeding it real signals 
computed every 15 minutes from the live capture.

Tonight's Globex example exposes the gap: the static-prior dashboard 
treats Scenario C (cycle-high fade) as ~55-65% probability based on 
multi-method confluence at the entry zone. But tonight's actual conditions 
(bullish CVD +1,419 session, +1,261 last 60m, accelerating into the high, 
high broken without rejection) argue the fade is MORE LIKELY 40-50%. The 
dashboard has no way to know this — the heuristic multipliers don't read 
CVD, sweeps, or absorption.

Ticket spec at:
D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md (search "RA-046")

~10-12h estimate. P1. Extends tools/rithmic_dashboard/.

# Context you need before building

1. **Probability becomes responsive to actual market behavior.** The 
   biggest single change: add a CVD-direction-match multiplier that 
   scales probability based on whether session CVD direction aligns with 
   scenario bias. Tonight's example: Scenario C (short bias) with 
   bullish CVD = -20% multiplier; Scenario E (long bias) with bullish 
   CVD = +20% multiplier. Same data the orderflow_pulse already computes.

2. **Sweeps and absorption proxies are NEW intra-session detectors.** 
   These don't exist anywhere yet in the project for live data 
   (RA-015/RA-035 are post-session). RA-046 builds:
   - Sweep detector: 3+ ticks through a structural level in <60sec
   - Absorption proxy: heavy-volume-balanced-delta clusters at fixed 
     price (proxy for the true MBP1-based RA-015 absorption — which 
     requires MBP1 sibling that doesn't exist intra-session)
   Both run on bounded-tail reads. Both feed probability multipliers.

3. **I/O budget from RA-045 still applies.** Even with the new computations, 
   each 15-min dashboard run must stay under 5MB disk I/O total. Sweep + 
   absorption detection on bounded-tail (last ~5-10min of capture, ~200KB) 
   plus state-file persistence. Never scan the full live file.

4. **Calibration logging is the load-bearing meta-requirement.** Every 
   probability displayed gets logged with the multipliers that produced 
   it, alongside outcome when scenario completes. After 30+ outcomes, the 
   heuristic multipliers can be empirically replaced via RA-027's Wilson 
   CI machinery. This ticket builds the LOG; future ticket does the 
   replacement.

5. **Transparency over precision.** Every multiplier displayed with 
   trigger data ("cvd_direction_match: +20% (session CVD +1,419 supports 
   long bias)"). Don't aggregate into a single mystery number. The trader 
   should see WHY probability is at the level it's at.

6. **Quantifiable but not yet calibrated.** Multipliers are heuristic 
   choices (e.g., +20% for CVD match) — informed by trading theory but 
   not yet empirically grounded. The dashboard footer must continue 
   to display "Probabilities are heuristic priors..." until the 
   30-session calibration corpus exists.

# Pre-build sweep expectation

Per the proven 10x velocity discipline:
- Plan paragraph
- Confirmation of the 4 phase design (live signals → adjuster v2 → 
  calibration log → renderer)
- Answers/picks on the 6 ambiguity points (live VWAP window, sweep 
  threshold, absorption proxy threshold, multiplier composition, 
  calibration log retention, plus anything else surfaced)
- Engineer's-call defaults
- Time estimate per phase

Surface as single message. Wait for green-light before coding.

# Build phasing

**Phase 1 (~3h)**: live_signals.py — computes intra-session VWAP/σ, 
CVD breakdown, volume velocity from bounded-tail reads. Tests with 
synthetic tail-data.

**Phase 2 (~2.5h)**: sweep_detector.py + absorption_proxy.py — both 
read recent ticks, emit events to per-session JSONL logs. Tests with 
controlled synthetic patterns.

**Phase 3 (~2.5h)**: probability_adjuster v2 — extends with the 6 new 
multipliers. Each multiplier function takes a context and returns 
(delta, rationale_text). Composition is additive with [0.4, 1.6] cap. 
Tests for each multiplier in isolation + composition tests.

**Phase 4 (~2h)**: Calibration log — outcome tracking when scenarios 
complete. Persists to probability_outcomes.jsonl with multiplier 
provenance.

**Phase 5 (~2h)**: Renderer updates — Active Posture references live 
signals; Orderflow Pulse adds velocity gauge + sweeps + absorption 
sections; scenario tooltips expanded; new audit trail event types.

# Smoke test paths after build

1. **Manual run against tonight's Globex** (5/22 data):
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m rithmic_dashboard.cli.generate --output-path data\dashboard\index.html
   ```

2. **Browser verification**:
   - Open file:///D:/.../index.html
   - Orderflow Pulse should show: velocity gauge, recent sweeps list, 
     absorption proxy events
   - Active Posture should reference CVD direction in sentence 3
   - Scenario tooltips show all applied multipliers with trigger data
   - Audit trail has sweep/absorption events (if any fired)

3. **CVD-multiplier verification (synthetic)**:
   - Synthetic envelope with Scenario E (long) probability 45-55%
   - Synthetic CVD with session net +2000
   - Expected: cvd_direction_match fires (+20%) → adjusted probability 
     ~54-66%
   - Tooltip shows the multiplier explicitly

4. **Sweep detector verification (synthetic)**:
   - Synthetic tail with 5 ticks through 29,500 in 30sec
   - Expected: SweepEvent appears in current session's sweeps.jsonl
   - Audit trail shows "Sweep detected at 29,500 (upward, intensity X)"

5. **Calibration log smoke**:
   - Force a scenario to COMPLETED state via state file manipulation
   - Verify probability_outcomes.jsonl gets a new entry with 
     displayed_prob + outcome + multipliers list

6. **Full suite + lint + types**:
   ```powershell
   python -m pytest -x --tb=short
   ruff check .
   mypy rithmic_dashboard
   ```
   Target: ~90 tests green (64 prior + ~26 new).

# After ship

Probability becomes a moving target reflecting actual conditions. 
Trader's mental model: "Why did Scenario C drop from 55% to 40% in the 
last hour?" → tooltip shows "cvd_direction_oppose: -20% (CVD turned 
strongly bullish), volume_velocity_quiet: -15% (last-15m volume 30% of 
baseline)". Information-dense without false precision.

Calibration log starts collecting from session 1. After 30+ completed 
scenarios, the empirical-replacement ticket (future RA-050 or so) uses 
Wilson CI to replace heuristic multipliers with measured win-rates 
per trigger condition.

# Standing by

Surface the pre-build sweep. Six ambiguity points minimum (see ticket). 
Then build phases 1-5 sequentially; smoke between phases as you go.
```
