# RA-053 Dispatch — Adaptive σ via EWMA + databento corpus calibration

Copy-paste below into Codex. Foundation ticket for day-trading-suitable
signal generation. Replaces the manual `×1.7` / `×2.0` σ regime
multipliers (applied reactively on 2026-05-27 and 2026-05-28) with
empirically-calibrated EWMA volatility trained on a 96-session databento
corpus.

Critical context: the user has committed to day-trading discipline (no
overnight holds). Multi-day σ frameworks become contextual; intraday σ
becomes primary. The 96-session corpus (Feb-Apr 2026, ~127 GB across two
locations) makes empirical calibration possible for the first time —
the prior tickets (RA-046 through RA-052) were designed assuming the
corpus didn't exist.

---

# Copy-paste below

```
RA-053 — Adaptive σ via EWMA + databento corpus calibration.

The σ-band framework failed twice in 24 hours (5/27 = 5.7σ event, 5/28
= 3.37σ event AFTER manual ×1.7 widening). Reactive multipliers don't
work. This ticket replaces them with EWMA volatility estimation
calibrated empirically against a 96-session databento corpus, producing
a per-session σ_effective that auto-adapts to volatility regime without
manual intervention.

Foundation for day-trading-suitable signals. Subsequent tickets
(RA-055 day-type priors, RA-056 IB extension priors) consume RA-053's
output.

Ticket spec at:
D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md (search "RA-053")

~4-6h estimate. P1. Two-project ticket (analytics CLI + dashboard
consumer). 5-phase sequential build.

# Context you need before building

1. **The corpus is enterprise-grade and split across two locations.**
   Combine both for max calibration data:
   - D:\qfa-cache\databento\tier-a-feb-mar-2026\ (66 RTH sessions, ~87 GB)
   - D:\Quant-futures-app\data\databento\sim03_corpus\ (30 RTH sessions, ~40 GB)
   Total ~96 RTH sessions, Feb 2 → Apr 27 2026. Per session: definition,
   mbo, mbp-1, mbp-10, trades all in .dbn.zst format.

2. **RA-052's memory contract is the load-bearing operational
   constraint.** Light path (5-min refresh loop) must stay under 2GB
   peak RSS. The corpus loader MUST stream per-session, not full-load.
   The memory regression test in CI from RA-052 will catch violations.

3. **Parkinson volatility estimator over close-to-close σ.** Trending
   sessions like 5/27 (open 30,053 → high 30,380 → low 29,876) cause
   close-to-close σ to dramatically underestimate realized range.
   Parkinson uses high/low and is the appropriate estimator:
   σ_P = (1 / (4 × ln 2)) × √(mean[(ln(H/L))²])
   Compute per session, store in per_session_stats.parquet.

4. **EWMA replaces session-anchored σ.** Current pattern: each session
   starts σ fresh, ignoring prior sessions. EWMA inherits volatility
   memory across sessions:
   σ²_t = λ × σ²_{t-1} + (1 − λ) × σ²_observed_t
   Cold-start (no prior history) uses corpus median σ as σ_0.

5. **Vol regime classifier is HEURISTIC, not HMM.** Three states
   (LOW / NORMAL / HIGH) based on EWMA σ vs corpus median ratio.
   Returns (regime_name, regime_factor) where factor ∈ {1.0, 1.3, 1.6}.
   HMM is deferred to RA-059 once live-session calibration data
   accumulates (need 30+ live sessions before HMM is well-conditioned).

6. **σ_effective replaces manual multipliers.** Once RA-053 ships,
   the existing manual ×1.7 / ×2.0 patches applied during 5/27-5/28
   become unnecessary. The framework auto-recomputes zone widths
   based on σ_effective on every 5-min tick.

7. **Walk-forward validation only.** Random k-fold leaks future
   information into the training set. Use temporally-ordered 80/20
   split: first 77 sessions train, last 19 validate. Walk-forward
   respects the actual deployment scenario where future sessions
   are unknown.

8. **Dashboard regime events.** When the classifier transitions
   (e.g., NORMAL → HIGH), emit audit event `vol_regime_changed`.
   This event flows through RA-050's Recent Signals panel via the
   schema-extensibility contract. Family: "vol_regime".

# Pre-build sweep expectation

Per established discipline (RA-040 through RA-052), do a pre-build
sweep BEFORE writing source. Surface 9 ambiguity points:

- Plan paragraph summarizing the 5-phase build and how phases connect
- Confirmation of recommended defaults on the 9 ambiguity points
  (calibration metric, validation split, regime thresholds, corpus
  memory strategy, dual-corpus use, cold-start, EWMA window,
  recalibration cadence, plus anything surfaced reading databento
  package docs)
- Engineer's-call defaults taken unless flipped
- Time estimate per phase

Surface the sweep as a single message. Wait for green-light before
writing code. Do not start Phase 1 source until explicitly approved.

# Build order recommendation

Phases sequential — each builds on the previous:

1. **Phase 1 (~60-75 min)**: databento_loader.py + per-session
   stats parquet. Stream per session (memory contract). Compute
   Parkinson σ, VWAP, range, VPOC/VAH/VAL, IB high/low, volume.
   Tests with synthetic .dbn.zst fixture + Parkinson math validation.

2. **Phase 2 (~45-60 min)**: calibrate_ewma.py CLI. Sweep λ over
   [0.85, 0.99]. Walk-forward 80/20 validation. Atomic write to
   ewma_decay.json. Exit non-zero if corpus < 30 sessions.
   Tests with deterministic synthetic corpus producing known-output λ.

3. **Phase 3 (~60-75 min)**: EWMA σ in live_signals.py. Rolling
   state in session_state JSON. Cold-start from corpus median.
   Update on each 5-min tick. Tests for rolling correctness, cold-
   start behavior, state persistence across runs.

4. **Phase 4 (~30-45 min)**: vol_regime_classifier.py. Three-state
   classifier with 0.7× / 1.3× corpus-median ratio thresholds.
   Audit event on transition. Tests for boundary cases (state
   transitions, hysteresis).

5. **Phase 5 (~45-60 min)**: Dashboard rendering + zone framework
   wire. New Orderflow Pulse subsection "Volatility regime".
   Auto-recompute zone widths using σ_effective. Active Posture
   includes regime sentence. Update Distance Grid labels.

Buffer: ~30-45 min for integration + visual smoke + docs.

# Smoke test paths after build

1. **Calibration smoke** (manual run):
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_analytics
   python -m rithmic_analytics.cli.calibrate_ewma --symbol MNQ
   ```
   Expect: produces ewma_decay.json with λ in [0.85, 0.99] range,
   validation RMSE within 20% of training RMSE, sessions_used = 96.

2. **Live signal smoke**:
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m rithmic_dashboard.cli.generate --output-path data\dashboard\index.html
   ```
   Expect: dashboard generates without error, Orderflow Pulse shows
   EWMA σ and regime, peak memory < 2GB (RA-052 contract).

3. **Browser verification** (file:///D:/.../index.html):
   - New "Volatility regime" subsection in Orderflow Pulse
   - Shows current EWMA σ (in points) + regime (LOW / NORMAL / HIGH)
     with color coding
   - σ_effective displayed for transparency
   - Corpus median σ shown for context
   - Calibration version (λ value) shown
   - Active Posture sentence includes regime context
   - Distance Grid zone labels updated with current σ value

4. **Regime transition smoke** (synthetic):
   - Synthetic session-state with EWMA σ at NORMAL boundary
   - Inject 15-min observation that pushes EWMA past 1.3× corpus median
   - Expected: classifier transitions to HIGH, vol_regime_changed audit
     event fires, dashboard reflects new state
   - Verify event appears in RA-050's Recent Signals panel

5. **Memory regression validation**:
   - Run the full RA-052 memory test suite
   - Confirm peak RSS still < 2GB on light path
   - Slow RSS smoke (`RUN_RA052_RSS_SMOKE=1`) still passes

6. **Full suite + lint + types**:
   ```powershell
   python -m pytest -x --tb=short
   ruff check .
   mypy rithmic_analytics
   mypy rithmic_dashboard
   ```
   Target: existing test counts + ~20 new tests. Ruff + mypy clean both
   projects.

# Docs

Update `docs/feature_reference.md` with:
- EWMA volatility computation + math reference
- Vol regime classifier rules + threshold values
- Where σ_effective is consumed (zone framework, probability adjuster,
  Active Posture)

Update `docs/operations.md` with:
- When to run `calibrate_ewma` CLI (monthly recommended)
- How to interpret regime states + when to investigate
- vol_regime_changed event meaning

Create `docs/ewma_calibration_methodology.md` (NEW):
- Why EWMA over rolling-window σ
- Why Parkinson over close-to-close
- Why walk-forward over random validation
- The decay parameter λ — what it controls, why we picked the optimal
- Comparison of EWMA vs prior heuristic ×1.7 / ×2.0 multipliers
  with side-by-side performance on 5/27 and 5/28 sessions

# After ship

The framework auto-adapts to regime shifts without manual intervention.
The 5/27 event (5.7σ on old framework) becomes properly bounded under
the EWMA model — backtest validation should confirm.

Subsequent tickets unblock:
- RA-055 (day-type priors) uses EWMA σ + corpus to compute empirical
  win-rates per day type per setup
- RA-056 (IB extension priors) uses corpus to measure realized IB-break
  follow-through statistics
- RA-059 (full HMM regime) eventually replaces the heuristic classifier
  with multi-state HMM trained on accumulated live-session data

The day-trading framework architecture is set: EWMA σ → regime
classifier → σ_effective → zone widths + day-type priors. Each layer
empirically grounded.

# Operational notes

- Dashboard generator currently runs on 5-min cadence via
  run_local_probe_refresh.ps1. RA-053's EWMA hook integrates with the
  existing tick cadence — no new scheduling needed.
- The 96-session corpus is one-time-readable (cached) — calibration
  CLI runs monthly or on-demand, not every refresh loop.
- The per_session_stats.parquet artifact is small (~10MB) and lives
  in data/calibration_corpus/. EOD heavy script may regenerate it
  if new corpus sessions arrive.
- RA-052's `-EmitHeavyAnalytics` switch IS NOT affected by RA-053.
  Calibration is a separate manual / monthly invocation.

# Schema-extensibility contract with RA-050 (must hold)

The vol_regime_changed event JSONL schema:

```jsonl
{"timestamp_pt": "2026-05-28 19:45:00 PT",
 "event_type": "vol_regime_changed",
 "level_id": null,
 "description": "Vol regime changed: NORMAL → HIGH (EWMA σ=204pt vs corpus median 78pt = 2.62× ratio)",
 "intensity": 4.0,
 "confidence": "high",
 "metadata": {"from_regime": "NORMAL", "to_regime": "HIGH", "ewma_sigma": 204.1, "corpus_median_sigma": 78.0, "ratio": 2.62, "regime_factor": 1.6}}
```

Register "vol_regime" as a new family in RA-050's
multi_signal_stack_alert.py and zone_signal_badges.py constants.
Day-trading events are SESSION-LEVEL (no level_id, no zone badges).
They appear in Recent Signals panel only.

Family map update in the SAME PR.

# Standing by

Acknowledge this prompt + surface the pre-build sweep (plan + 9 picks +
phase estimates + anything found reading databento package + .dbn.zst
schema). Do not write source until green-lit.
```
