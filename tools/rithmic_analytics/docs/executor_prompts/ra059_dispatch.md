# RA-059 Dispatch - Iceberg / hidden-order detector

Copy-paste below into Codex. This is the second bookmap-equivalent
signal ticket. Build it after RA-058 unless explicitly redirected:
RA-058 provides the trade-side footprint view, while RA-059 adds the
MBO order-lifecycle pattern detector for refilling/defended levels.

Critical context: this ticket is not "true hidden quantity" detection.
Retail-accessible MBO can infer iceberg-like behavior from repeated
visible refills at one price after consumption. The detector should be
honest about that approximation while still surfacing the signal as
institutional commitment.

---

# Copy-paste below

```
RA-059 - Iceberg / hidden-order detector.

Build an MBO-based iceberg detector that identifies repeated refilling
at the same price level after consumption. RA-049 detects institutional
flow from trade size; RA-059 detects institutional commitment from
order-lifecycle behavior. The goal is to surface the Bookmap-style
"someone is defending/filling this level" signal directly in the local
dashboard.

Ticket spec at:
D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md (search "RA-059")

~6-8h estimate. P1. Project:
D:\Quant-futures-app\tools\rithmic_dashboard

Recommended build order: RA-058 first, then RA-059. If RA-058 has not
shipped, keep RA-059 independent and do not depend on its footprint
module.

# Context you need before building

1. **Input is MBO order-lifecycle data, not obs01 trades.** Use the
   existing Rithmic raw/MBO capture artifacts and bounded-tail pattern.
   Do not put full-session MBO scans into the 5-minute dashboard light
   path.

2. **This is inferred iceberg behavior.** We cannot know exchange-side
   hidden total size. The v1 signal is "iceberg-like refilling": repeated
   distinct order IDs at the same price, visible size consumed, then
   similar visible size re-added within a short window.

3. **Default detector thresholds are part of the spec.**
   - `min_refills = 3`
   - `refill_window_seconds = 30`
   - `size_consistency_pct = 0.40`
   - `aggressor_side_consistent = True`
   - `min_total_consumed = 50`
   Make them configurable and feed future calibration.

4. **Direction semantics must be explicit.** A sell-side iceberg means
   sellers are refilling/absorbing buy aggression at the offer or a
   defended sell level; a buy-side iceberg means buyers are refilling/
   absorbing sell aggression at the bid or a defended buy level. Confirm
   exact mapping from MBO/execution fields during the pre-build sweep.

5. **Probability multipliers have a mandatory mutual-exclusion guard.**
   Add:
   - `iceberg_at_entry`: +20% when iceberg direction matches scenario
   - `iceberg_opposing_entry`: -25% when iceberg is against scenario
   - `iceberg_high_intensity_stack`: +30% when 2+ distinct iceberg
     events defend the same zone within 30 minutes; this replaces the
     base `iceberg_at_entry`, not stacks on top of it
   `iceberg_at_entry` and `iceberg_opposing_entry` must never both fire
   on the same scenario.

6. **Persist canonical events to live_analysis.** Write
   `data/live_analysis/<date>_<session>_icebergs.jsonl` with generic
   RA-050 event schema:
   - `timestamp_pt`
   - `event_type = "iceberg_detected"`
   - `level_id`
   - `description`
   - `intensity`
   - `confidence`
   - `metadata` including price, refill_count, total_consumed, side,
     median_refill_size, and window_seconds

7. **Register family `"iceberg"` in RA-050 maps.** Add it to
   `multi_signal_stack_alert.py` and `zone_signal_badges.py` in the same
   PR. Use the ticket's badge/icon intent, but keep the family string
   canonical as `"iceberg"`.

8. **RA-052 memory contract is non-negotiable.** MBO tracking must use
   bounded tails and LRU eviction. Peak RSS on the 5-minute light path
   must remain under 2GB.

9. **Calibration is included but should not block the live detector.**
   Add `rithmic_dashboard/cli/calibrate_iceberg_thresholds.py` to tune
   thresholds against historical captures, targeting roughly 5-10
   events/session. Write `data/live_analysis/iceberg_thresholds.json`
   atomically. If the corpus is insufficient, exit non-zero with a clear
   message.

# Pre-build sweep expectation

Per established discipline (RA-040 through RA-053), do a pre-build
sweep BEFORE writing source. Surface 9 ambiguity points:

1. Order tracker memory bound: LRU evict older-than-window orders vs
   keep all tail-window orders. Recommend LRU.
2. Refill window: 30 sec vs 60 sec. Recommend 30 sec.
3. Size consistency threshold: 40% vs stricter 30%. Recommend 40%.
4. `min_total_consumed`: 50 for MNQ vs higher. Recommend 50 for v1,
   configurable.
5. Aggressor/execution-side consistency: strict all-same vs >=80%.
   Recommend strict for v1.
6. High-intensity stack threshold: 2 events in 30 min vs 3 in 60 min.
   Recommend 2 in 30 min.
7. Calibration retention: all-time outcomes vs trailing N sessions.
   Recommend all-time JSONL, cheap and useful for Wilson-CI later.
8. "At entry zone" semantics for opposing/matching iceberg: recommend
   within the scenario's existing entry zone/level tolerance, not any
   iceberg elsewhere on the chart.
9. Anything surfaced while reading the current MBO schema and capture
   parser, especially how order add/modify/cancel/execute events and
   side fields are encoded.

Also include:
- Plan paragraph summarizing the 5 phases and how they connect
- Engineer's-call defaults unless flipped
- Time estimate per phase
- Explicit confirmation of the mutual-exclusion guard for
  `iceberg_at_entry` vs `iceberg_opposing_entry`

Surface the sweep as a single message. Wait for green-light before
writing code. Do not start Phase 1 source until explicitly approved.

# Build order recommendation

Phases are sequential:

1. **Phase 1 (~90-120 min): MBO order-lifecycle tracker.**
   Create `rithmic_dashboard/features/mbo_order_tracker.py`.
   Stream bounded-tail MBO records. Track order_id lifecycle
   add/modify/cancel/execute and maintain a compact price-level index.
   Add LRU eviction by time and possibly max order count. Tests should
   cover lifecycle state, price indexing, eviction, and missing/unknown
   event handling.

2. **Phase 2 (~90-120 min): iceberg detector.**
   Create `rithmic_dashboard/features/iceberg_detector.py`.
   Detect repeated consumed-then-refilled visible orders at the same
   price using the default thresholds. Emit `iceberg_detected` to
   `<date>_<session>_icebergs.jsonl`. Tests:
   - positive: 5 refills within 30 sec, sizes within tolerance
   - negative: mixed side when strict consistency is enabled
   - negative: refills outside the window
   - confidence high when thresholds are exceeded by 50%+

3. **Phase 3 (~75-90 min): probability multiplier integration.**
   Extend `probability_adjuster.py` with the three iceberg multipliers.
   Add co-firing tests with RA-049 institutional flow and RA-047 delta
   dislocation. Verify [0.4, 1.6] cap clips cleanly while tooltip still
   shows all unclipped contributions. Verify high-intensity stack
   replaces the base multiplier and opposing/matching guards are
   mutually exclusive.

4. **Phase 4 (~75-90 min): renderer, posture, RA-050 wiring.**
   Add Orderflow Pulse "Recent Icebergs", Active Posture sentence when
   relevant, audit event types, and family `"iceberg"` in RA-050 maps.
   Multi-signal stack should fire when iceberg combines with sweep or
   absorption at the same zone within the configured window.

5. **Phase 5 (~60-75 min): calibration + docs.**
   Add `rithmic_dashboard/cli/calibrate_iceberg_thresholds.py`, outcome
   logging to `data/live_analysis/iceberg_outcomes.jsonl`, and docs:
   `docs/iceberg_detection_methodology.md`, `docs/feature_reference.md`,
   and `docs/operations.md`.

Buffer: ~45-60 min for integration, visual smoke, full tests, ruff, and
mypy.

# Smoke test paths after build

1. **Order tracker tests:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -q tests/test_mbo_order_tracker.py
   ```
   Expected: lifecycle transitions, price index, and eviction behavior
   are deterministic and bounded.

2. **Detector tests:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -q tests/test_iceberg_detector.py
   ```
   Expected: synthetic 5-refill sequence emits high-confidence
   `iceberg_detected`; mixed-side and outside-window sequences do not.

3. **Multiplier/co-firing tests:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -q tests/test_iceberg_multipliers.py
   ```
   Expected: matching/opposing guard works, high-intensity replaces
   base, and co-firing clips at the global cap without dropping tooltip
   details.

4. **RA-050 integration smoke:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -q tests/test_iceberg_ra050_integration.py
   ```
   Expected: iceberg events appear in Recent Signals and can contribute
   to stack banners with other families.

5. **Calibration CLI smoke:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m rithmic_dashboard.cli.calibrate_iceberg_thresholds --symbol MNQ --sessions 10
   ```
   Expected: writes `data/live_analysis/iceberg_thresholds.json` with a
   sensible threshold set targeting 5-10 events/session, or exits
   non-zero with a clear insufficient-data message.

6. **Real-data dashboard smoke:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m rithmic_dashboard.cli.generate --trading-date 2026-05-28 --session rth --output-path data\dashboard\index.html
   ```
   Expected: dashboard renders Recent Icebergs subsection. If real data
   has no iceberg patterns, render a quiet empty state and no crash.

7. **Memory validation:**
   Run RA-052 light-path memory/call-graph tests. Expected: MBO tracker
   bounded-tail/LRU behavior keeps peak RSS under 2GB.

8. **Full suite + lint + types:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -x --tb=short
   ruff check .
   mypy rithmic_dashboard
   ```
   Target: existing test count + roughly 18 new tests. Ruff + mypy
   clean.

# Docs

Create `docs/iceberg_detection_methodology.md` with:
- What can and cannot be inferred from retail MBO data
- The refill pattern definition
- Threshold definitions and defaults
- Direction semantics: buy-side vs sell-side iceberg
- Confidence levels
- False positive/false negative cases

Update `docs/feature_reference.md` with:
- Event schema and live_analysis output path
- Probability multipliers and tooltip meanings
- RA-050 badge/stack behavior

Update `docs/operations.md` with:
- How to run threshold calibration
- How to interpret "no icebergs"
- Memory expectations and bounded-tail limits

# Acceptance bar

- MBO order tracker reads bounded-tail and evicts old state.
- Detector fires on the specified synthetic refill pattern.
- Negative tests suppress mixed-side and outside-window false positives.
- `iceberg_at_entry`, `iceberg_opposing_entry`, and
  `iceberg_high_intensity_stack` behave exactly as specified.
- Matching/opposing multiplier guard is explicit and tested.
- Iceberg events persist to canonical live_analysis JSONL.
- Recent Signals, zone badges, and multi-stack alerts recognize family
  `"iceberg"`.
- Calibration CLI writes threshold JSON or fails clearly.
- Light path remains under the RA-052 2GB memory ceiling.
- Tests, ruff, and mypy are green.

# Out of scope

- True exchange-side hidden total quantity.
- Spoofing/layering detection.
- Canvas/WebGL heatmap rendering; that remains RA-062 territory.
- Cross-symbol iceberg correlation.
- Auto-trade execution.

# After ship

The dashboard should be able to tag levels that Bookmap visually shows
as defended/refilled. Together with RA-058, this gives local coverage of
the core tradeable Bookmap signals: aggressor flow, footprint imbalance,
and iceberg-like institutional commitment.

Standing by for the pre-build sweep. Do not write source until green-lit.
```

