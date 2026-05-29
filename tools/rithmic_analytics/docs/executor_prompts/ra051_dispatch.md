# RA-051 Dispatch — Day-type classification (auction market theory)

Copy-paste below into Codex. THIRD and final build in the new
RA-049/050/051 triplet (RA-050 shipped 2026-05-26, RA-049 shipped
2026-05-27). The structural upgrade that conditions all per-event
multipliers (sweep, absorption, delta_dislocation, institutional_flow)
on session character. Biggest single multiplier-framework upgrade
per academic literature — auction market theory's 10 day types each
carry distinct probability priors that materially affect when fades
work, when trend-follow wins, and when mean-reversion is suicide.

---

# Copy-paste below

```
RA-051 — Day-type classification (auction market theory).
Currently the dashboard treats every session the same — same scenario
priors, same probability multipliers. In reality, the CHARACTER of the
day materially affects which setups have edge. Auction Market Theory
classifies days into 10 types (5 directional × 2 variants), each with
distinct trade probabilities:

- Trend day: fading either extreme is suicide; trend-follow only
- Normal day: IB extremes are high-probability fades
- Neutral day: mean-reversion to mid works
- Double distribution: trade between distributions, fade extremes
- Normal variation: 1× IB extensions are reaction levels

This ticket auto-classifies the day within first 90 min of RTH and
conditions ALL scenario probability multipliers (sweep + absorption +
dislocation + institutional_flow + existing distance/time/state) on
day type. Adds 2 new scenario types (IB-Long, IB-Short) with
auction-theory-based extension targets.

Ticket spec at:
D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md (search "RA-051")

~4-6h estimate. P1. Project: tools/rithmic_dashboard/ (extend
existing). Largest of the RA-049/050/051 triplet — touches scenario
state machine, probability adjuster, posture synthesis, audit trail,
calibration log. Standard 5-phase build pattern.

# Context you need before building

1. **This is the STRUCTURAL conditioning layer on top of everything
   else.** RA-046, RA-047, RA-049 added per-event multipliers (sweep,
   absorption, dislocation, institutional_flow). RA-051 adds a layer
   ABOVE those — the day-type modifies how those per-event multipliers
   apply. Example: a sell_absorbed event at W+2σ short zone on a
   TREND DAY UP should NOT trigger fade scenarios (-40% mean-reversion
   penalty); the same event on a NORMAL DAY is high-conviction
   (+20% mean-reversion boost). The implementation must apply day-type
   conditioning AFTER per-event multipliers compute, not as a
   parallel/independent path.

2. **Classification window is 90 min into RTH.** For MNQ: RTH opens
   06:30 PT, IB closes 07:30 PT, classification fires at 08:00 PT.
   Before 08:00 PT, day_type is `pending` — pre-classification
   multipliers should NOT apply (no day-type conditioning until
   classified). Post-classification, every 15-min dashboard tick
   re-evaluates and may emit `day_type_revised` event if the
   classification changes (rare but possible — e.g., a normal day that
   extends late afternoon into a trend day).

3. **IB definition for MNQ: first 60 min of regular trading hours.**
   06:30:00 PT to 07:30:00 PT. IB high = max(high) in those 60 min.
   IB low = min(low). IB range = high - low. IB midpoint = (high +
   low) / 2. Use the live capture's MNQ_rth.jsonl OR the dashboard's
   live_signals tail (whichever is more readily available — confirm
   in pre-build sweep). For Globex-only sessions (overnight before
   RTH opens), classification is `pending` indefinitely (RTH IB
   doesn't exist yet).

4. **10 day types with classification rules:**

   | Type | Rule (post-IB, in classification window) |
   |---|---|
   | trend_day_up | RTH open within 10pt of session low + price ≥ 1.5× IB range above IB high |
   | trend_day_down | RTH open within 10pt of session high + price ≤ 1.5× IB range below IB low |
   | double_distribution_up | Strong move up after IB + NEW value area forms above (non-contiguous) |
   | double_distribution_down | Same direction down |
   | neutral_day_extreme | Price extends both sides of IB + closes near extreme |
   | neutral_day_center | Price extends both sides of IB + closes near IB midpoint |
   | normal_variation_up | Extends 0.5-1.5× IB above + doesn't extend below |
   | normal_variation_down | Same direction down |
   | normal_day | Holds entirely in IB range OR extends < 0.5× IB either side |
   | pending | Before 90 min of RTH OR partial-session flag set |

   Classification is exclusive — exactly one type at any given time.
   Document the priority order in the classifier when multiple rules
   could match (e.g., trend_day_up before normal_variation_up if
   1.5× threshold exceeded).

5. **Day-type-conditioned multipliers compose MULTIPLICATIVELY with
   per-event multipliers and remain bounded by [0.4, 1.6].** A
   scenario could see day-type +25%, then sweep +10%, then institutional
   +20%, all stacking. The cap clips cleanly per the established
   pattern. Co-firing tests are mandatory and now must cover:
   day_type × sweep × absorption × dislocation × institutional all
   firing on same scenario in worst-case stack scenario.

6. **2 new scenario types: IB-Long, IB-Short.** These are added to the
   existing scenario state machine (DORMANT → WATCHING → ACTIVE →
   COMPLETED) with auction-theory extension targets at 0.5×, 1.0×,
   1.5× IB range above/below IB high/low. Base probability 55% (prior
   from auction-theory literature); modified by day-type per the
   multiplier table. They go into `_scenarios.json` and produce
   audit events like all other scenarios. RA-050's Recent Signals
   panel + zone badges will surface them via the existing scenario
   integration (verify in smoke).

7. **Partial-session handling for holidays.** Memorial Day 5/25 was
   a half-session (early close at 10:00 PT instead of 13:00 PT).
   Classification rules assume normal 6.5h RTH. Add a
   `partial_session: bool` config flag (manually set per session OR
   auto-detect from CME holiday calendar — recommend manual for v1,
   document the flag in operations.md). When partial_session=true,
   skip classification (day_type stays `pending`) and emit audit
   event `day_type_skipped_partial_session`. Don't try to classify
   on partial sessions — the auction-theory rules don't fit and false
   classifications could mis-condition probability multipliers.

8. **Family registration in RA-050.** Day-type classification events
   (`day_type_classified`, `day_type_revised`, `ib_high_break`,
   `ib_low_break`, `ib_extension_reached`, `day_type_skipped_partial_session`)
   should register as family `"day_type"` in
   `multi_signal_stack_alert.py` and `zone_signal_badges.py`. Suggest
   icon ⏰ or 📊 for the badge (confirm in pre-build sweep). Day-type
   events are session-level (not zone-level) so they should NOT trigger
   zone badges — but they SHOULD appear in the Recent Signals panel
   with no zone cross-reference (or a "session-wide" placeholder).

# Pre-build sweep expectation

Per established discipline (RA-040 through RA-047, RA-049, RA-050), do
a pre-build sweep BEFORE writing any source files:

- Plan paragraph summarizing the build and how the 5 phases connect
- Confirmation of the 7 ambiguity points (recommended defaults in
  ticket): classification window timing, trend-day threshold,
  re-classification frequency, multiplier magnitudes, IB-break
  scenarios as separate scenarios vs modifiers, partial-session
  handling mechanism, plus anything new surfaced when reading
  scenarios.py / probability_adjuster.py / RA-049's institutional_flow
  code
- Engineer's-call defaults taken unless flipped
- Time estimate per phase

Surface the sweep as a single message. Wait for green-light before
writing code. Do not start Phase 1 source until explicitly approved.

# Build order recommendation

Phases are sequential — each builds on the previous:

1. **Phase 1 (~60-75 min)**: day_type_classifier.py — IB computation,
   10-rule classification logic, classification window + re-eval
   frequency, partial_session handling. Persists per-session JSON to
   `data/live_analysis/<date>_<session>_day_type.json`. Tests with
   synthetic OHLCV fixtures for ALL 10 day types + pre-classification
   pending + partial-session skip.

2. **Phase 2 (~45-60 min)**: probability_adjuster.py extension. Add
   day-type multiplier table (see spec for full matrix). Apply
   day-type conditioning AFTER per-event multipliers. Tests for each
   day-type × scenario-bias combination + worst-case stack
   (day_type × sweep × absorption × dislocation × institutional_flow
   all firing — verify [0.4, 1.6] cap clips cleanly without dropping
   multipliers).

3. **Phase 3 (~45-60 min)**: ib_scenarios.py — IB-Long and IB-Short
   scenario factories that integrate with existing scenario state
   machine. Auction-theory extension targets at 0.5×, 1.0×, 1.5× IB
   range. Tests for: scenario state transitions on IB break, T1/T2/T3
   correct extension prices, day-type conditioning of base 55% prior.

4. **Phase 4 (~45-60 min)**: Renderer + audit + posture wiring. New
   Day-Type card in Distance Grid (type name, IB range, current
   extension, classification timestamp, confidence). Active Posture
   gets day-type prefix sentence when classified. New audit event
   types. Register `"day_type"` family in RA-050's stack-alert and
   badge constants. Tests for render output + family map update.

5. **Phase 5 (~45-60 min)**: Calibration log integration. Per session
   at close, log classified day type + outcomes per scenario. Persists
   to `data/live_analysis/day_type_outcomes.jsonl`. After 30+ sessions,
   future ticket can use this to compute realized vs predicted
   win-rates per day type and replace heuristic multipliers with
   Wilson-CI calibrated values. Tests for log entry schema + write
   atomicity.

Buffer: ~30-45 min for integration + visual smoke + docs.

# Smoke test paths after build

1. **Manual run against current state**:
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m rithmic_dashboard.cli.generate --output-path data\dashboard\index.html
   ```

2. **Browser verification** (open file:///D:/.../index.html):
   - Day-Type card appears in Distance Grid (or just above it, per
     pre-build sweep decision) — populated with classification when
     post-08:00 PT, or "pending" when pre-classification
   - Active Posture sentence prefixed with day-type when classified:
     "Day type: NORMAL VARIATION (UP) — IB 30,005-30,072, currently
     extended +45pt above IB high (~0.6× IB range). Long-continuation
     scenarios up-weighted +15%, fade scenarios down-weighted -10%."
   - IB-Long and IB-Short scenarios appear in scenario list with
     standard state machine (DORMANT/WATCHING/ACTIVE/COMPLETED)
   - When day_type_classified event fires, it appears in RA-050's
     Recent Signals panel with family icon ⏰ (or chosen icon)
   - Probability tooltip on scenarios shows day-type multiplier
     contribution: "day_type_normal_variation_up_long_bias: +15%
     (NORMAL VARIATION UP day, long bias matches)"
   - Multi-stack banner (RA-050) does NOT include day_type as a
     stack contributor at zone level (session-level only)

3. **Synthetic classification smoke** (10 fixtures, one per day type):
   - Trend day up: synthetic OHLCV where RTH open ≈ session low,
     mid-day price ≥ 1.5× IB range above IB high
   - Normal day: synthetic OHLCV holding entirely in IB range
   - Neutral day center: extends both sides, closes mid
   - Etc. for all 10 types + pending + partial_session=true

4. **Worst-case multiplier-stack test**:
   - Synthetic scenario with: day_type_normal_day_center match (+30%
     mean-reversion), sweep_at_entry (+10%), absorption_at_entry
     (+15%), delta_dislocation_at_entry (+25%), institutional_flow_match
     (+20%), distance match (+0%), session_drift match (+5%) — total
     unclipped +105% additive
   - Expected: clip to 1.6 cap, tooltip shows ALL contributing
     multipliers with unclipped contributions noted
   - Verify NO multiplier is silently dropped

5. **Partial-session handling smoke**:
   - Set `partial_session: true` in session config
   - Generate dashboard
   - Verify: day_type stays `pending`, no classification fires, audit
     event `day_type_skipped_partial_session` appears, posture sentence
     does NOT include day-type prefix

6. **Day-type revision smoke**:
   - Start with classified `normal_day` at 08:00 PT
   - Synthetic data extends 1.5× IB above at 12:00 PT
   - Expected: classifier re-evaluates at next 15-min tick, emits
     `day_type_revised` event, type changes to `trend_day_up`,
     multipliers immediately adjust

7. **Full suite + lint + types**:
   ```powershell
   python -m pytest -x --tb=short
   ruff check .
   mypy rithmic_dashboard
   ```
   Target: ~140 tests green (119 prior + ~20 new). Ruff + mypy clean.

# Docs

Update `docs/operations.md` with:
- How to interpret Day-Type card in Distance Grid
- Classification timing (08:00 PT for MNQ) and re-eval frequency
- How to set `partial_session: true` for holiday sessions
- Multiplier table per day type (or link to feature_reference)

Update `docs/feature_reference.md` with new module entries:
- `features/day_type_classifier.py`
- `features/ib_scenarios.py`
- Day-type multiplier table (full matrix)

Create `docs/auction_market_theory_primer.md` (NEW):
- Brief explanation of the 10 day types
- Steidlmayer reference
- Rules of thumb per day type
- Trade implications per type

# After ship

The dashboard's probability framework gets the largest structural
upgrade since the multiplier system was introduced in RA-046.
Combined with RA-049 (institutional flow) and RA-050 (signal
prominence), the full picture is:

- **Per-event signals** (sweep, absorption, dislocation,
  institutional_flow) detect what's happening RIGHT NOW
- **Day-type classification** conditions HOW those events should be
  weighted given session character
- **RA-050's prominence layer** surfaces signal stacks visually so the
  trader sees the combined picture at a glance

The calibration log (RA-051 Phase 5) starts accumulating day-type
outcomes immediately. After 30+ sessions, a future ticket
(RA-052-style) can use Wilson-CI to replace heuristic day-type
multipliers with empirically-calibrated values. This is the canonical
path from "informed-by-theory heuristics" to "data-grounded
probabilities" that the entire framework was designed around.

After RA-051 ships, the RA-046-through-RA-051 signal+multiplier stack
is COMPLETE for intraday MNQ scenario probability. Next-tier work
shifts to either:
- Empirical multiplier calibration (RA-052+, post-30-session data)
- New asset / cross-symbol expansion (ES, RTY parameterization)
- Strategy backtest framework (separate scope)

# Operational notes

- Dashboard generator currently runs on a 5-min cadence per
  `run_local_probe_refresh.ps1 -IntervalMinutes 5`. No new scheduling
  needed.
- DEFAULT_TAIL_BYTES is 20MB per RA-049 finding — sufficient for IB
  computation and session-level analytics. No tail-span concern.
- Canonical sources for day-type classification:
  - RTH session bars: read from live_signals.py rolling tail (preferred)
    OR direct from `data/captures/<date>/MNQ_rth.jsonl` if available
  - Per-session output: `data/live_analysis/<date>_<session>_day_type.json`
  - Calibration log:
    `data/live_analysis/day_type_outcomes.jsonl` (append-only)
- 5/19-5/27 corpus exists for synthetic classification testing
  against real data — verify your synthetic fixtures match the
  classifications a human would assign to those real sessions
- 5/25 Memorial Day half-session is the canonical
  partial_session=true test case

# Schema-extensibility contract with RA-050 (must hold)

Day-type and IB-related events emitted to live_analysis JSONL must
match RA-050's generic schema:

```jsonl
{"timestamp_pt": "2026-05-26 08:00:00 PT",
 "event_type": "day_type_classified",
 "level_id": null,
 "description": "NORMAL VARIATION (UP): IB 30,005-30,072, currently +45pt above (0.6× IB range), confidence high",
 "intensity": 3.0,
 "confidence": "high",
 "metadata": {"day_type": "normal_variation_up", "ib_high": 30072, "ib_low": 30005, "ib_range": 67, "extension_pts": 45, "extension_x_ib": 0.6}}
```

For IB-break events (level_id IS set):
```jsonl
{"timestamp_pt": "2026-05-26 09:15:00 PT",
 "event_type": "ib_high_break",
 "level_id": "ib_high",
 "description": "Price broke IB high 30,072 by 15pt",
 "intensity": 4.0,
 "confidence": "high",
 "metadata": {"ib_high": 30072, "current_price": 30087, "break_pts": 15}}
```

Family map updates in same PR (in RA-050's modules):
- `multi_signal_stack_alert.py`: add `"day_type"` family covering
  all day_type_* and ib_* event types
- `zone_signal_badges.py`: day-type events should NOT appear as zone
  badges (they're session-level); IB-break events MAY appear at the
  IB high/low levels if those are drawn zones
- Use icon ⏰ or 📊 in Recent Signals panel (confirm in pre-build sweep)

# Standing by

Acknowledge this prompt + surface the pre-build sweep (plan + 7 picks +
phase estimates + anything found in scenarios.py / probability_adjuster.py /
RA-049 code reading). Do not write source until green-lit.
```
