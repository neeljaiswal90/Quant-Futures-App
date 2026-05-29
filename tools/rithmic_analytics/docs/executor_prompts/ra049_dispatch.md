# RA-049 Dispatch — Trade-size profiling + institutional flow detection

Copy-paste below into Codex. Second build in the new RA-049/050/051
triplet (RA-050 shipped 2026-05-26). Extends RA-046's signal stack with
institutional-flow visibility — separates 500-contracts-of-5-lots
(retail) from 500-contracts-of-5×100-lots (institutional). New event
types flow into RA-050's Recent Signals panel + multi-stack banner
automatically (RA-050's generic event support contract).

---

# Copy-paste below

```
RA-049 — Trade-size profiling + institutional flow detection.
Currently absorption events fire when volume × delta meet thresholds,
but the underlying TRADE composition is not differentiated. 500
contracts of buy-aggressor volume traded as 100 retail orders (5 lots
each) is very different from 500 contracts traded as 5 institutional
orders (100 lots each). The latter is smart money showing up; the
former is noise. This ticket adds trade-size classification to the
obs01 stream and aggregates institutional flow per zone. Output feeds
the probability adjuster as new high-conviction multipliers and slots
into RA-050's Recent Signals panel + multi-stack banner via the
generic event_type schema.

Ticket spec at:
D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md (search "RA-049")

~4-5h estimate. P1. Project: tools/rithmic_dashboard/ (extend
existing). New detector + threshold calibration CLI + 3 new probability
multipliers + renderer wiring. Standard 5-phase build pattern matching
RA-046/047/050.

# Context you need before building

1. **Reuses RA-046's bounded-tail-read pattern.** Use the same
   `load_trade_ticks_from_tail` helper from `live_signals.py` to read
   recent obs01. Same `DEFAULT_TAIL_BYTES = 750_000` limitation
   applies — for institutional flow detection (60-min aggregation
   window), the tail span is usually sufficient but verify against
   high-volume sessions where 750KB might cover < 60 min. Add a
   low_confidence flag when the parsed tail spans less than the
   aggregation window (mirrors the RA-047 pattern).

2. **Canonical output path matches the live_analysis convention:**
   `data/live_analysis/<date>_<session>_institutional_flow.jsonl`.
   This is the per-session JSONL that RA-050's recent_signals_panel.py
   will read. Do NOT write institutional events to `_audit.json` as the
   primary source — `_audit.json` is a rolling deduped subset; the
   per-session JSONL is canonical. The audit trail entry IS written
   too (for the historic audit view), but it's secondary.

3. **Threshold auto-calibration is the load-bearing meta-requirement.**
   The trade-size thresholds (1-9 retail / 10-49 mixed / 50-99
   institutional / ≥100 block) are STARTING DEFAULTS. They must be
   auto-calibrated per symbol from rolling 20-session percentile
   analysis. Without calibration, a symbol with chronically larger
   typical trade sizes (e.g., ES vs MNQ) would misclassify everything
   as retail. The CLI design pattern from RA-047's
   `calibrate_thresholds.py` is the template: idempotent, atomic write,
   exits non-zero on insufficient data, schedulable externally.

4. **Probability multipliers compose ADDITIVELY with existing ones.**
   The [0.4, 1.6] cap from RA-046 still applies. Co-firing test cases
   are mandatory: when `institutional_flow_match` (+20%) fires AND
   `cvd_direction_match` (+20% from RA-046) AND
   `delta_dislocation_at_entry` (+25% from RA-047) all hit the same
   scenario, verify the cap clips cleanly without silently dropping
   any multiplier. Tooltip must still display all contributing
   multipliers with their unclipped contributions noted.

5. **Generic event_type schema for RA-050 integration.** RA-050's
   recent_signals_panel.py was designed to accept arbitrary
   event_type strings via the schema `(timestamp, event_type,
   level_id, description, intensity, confidence)`. The
   `institutional_concentration_detected` and `block_trade_at_zone`
   event types must use this exact schema so they appear automatically
   in RA-050's panel + badges + multi-stack alerts. Don't introduce a
   parallel display path.

6. **Institutional flow is a DISTINCT signal family for multi-stack
   purposes.** RA-050's multi_signal_stack_alert.py triggers on ≥2
   distinct FAMILIES at the same zone in 30 min. Sweep, absorption,
   delta_dislocation are the existing families. Institutional flow
   (covering both institutional_concentration_detected and
   block_trade_at_zone events) is the 4th family. Register it in the
   stack-alert family map.

7. **Trade-size profiling is per-AGGRESSOR-side, not gross.** A
   500-contract buy from a single institutional buyer is bullish flow.
   A 500-contract sell is bearish. The aggregator must respect
   aggressor side and track buy vs sell concentration separately at
   each zone. Direction matching against scenario bias depends on
   this — institutional BUYING at a long-scenario's entry zone fires
   `institutional_flow_match`; institutional SELLING there fires
   `institutional_flow_oppose`.

# Pre-build sweep expectation

Per established discipline (RA-040 through RA-047, RA-050), do a
pre-build sweep BEFORE writing any source files:

- Plan paragraph summarizing the build and how the 5 phases connect
- Confirmation of the 7 ambiguity points (recommended defaults in
  ticket): threshold defaults, concentration threshold, multiplier
  values, aggregation window, block-trade definition, zone-matching
  scope, plus anything new surfaced when reading obs01 schema or
  RA-046's live_signals.py code
- Engineer's-call defaults taken unless flipped
- Time estimate per phase

Surface the sweep as a single message. Wait for green-light before
writing code. Do not start Phase 1 source until explicitly approved.

# Build order recommendation

Phases are sequential — each builds on the previous:

1. **Phase 1 (~45-60 min)**: trade_size_classifier.py — classifies
   each obs01 trade into retail/mixed/institutional/block buckets per
   per-symbol thresholds. Loads thresholds from JSON (with sensible
   defaults if file missing). Tests at threshold boundaries (1, 9, 10,
   49, 50, 99, 100, 200).

2. **Phase 2 (~60-75 min)**: institutional_flow.py — aggregator that
   reads classified trades from rolling tail, groups by zone, detects
   concentration events (≥3 institutional/block trades with directional
   delta > 100 in 15-min window). Persists to per-session JSONL with
   the canonical schema. Tests with synthetic concentration patterns
   + zone-matching edge cases (price exactly on zone boundary).

3. **Phase 3 (~45-60 min)**: probability_adjuster.py extension. Add 3
   new multipliers: institutional_flow_match (+20%),
   institutional_flow_oppose (-20%), block_trade_at_entry (+15%).
   Tests for each multiplier in isolation + critical co-firing tests:
   - institutional_flow_match + cvd_direction_match + dislocation
     (verify cap clips cleanly)
   - institutional_flow_match + institutional_flow_oppose collision
     (cannot both fire for same scenario — verify guard)
   - block_trade_at_entry composes additively with concentration
     (different events, same zone — both can fire)

4. **Phase 4 (~30-45 min)**: calibrate_trade_size_thresholds.py CLI.
   Reads last N session obs01s, computes percentile distribution,
   writes atomic threshold file. Same idempotent/exit-non-zero pattern
   as RA-047's calibrate_thresholds.py. Tests for: rolling percentile
   accuracy, exit-non-zero on insufficient data, atomic write
   round-trip.

5. **Phase 5 (~30-45 min)**: Renderer wiring. Add Institutional Flow
   subsection to Orderflow Pulse card (total inst volume, net inst
   delta, block count, per-zone concentration %). Wire new event types
   into audit trail. Wire Active Posture sentence generator. Confirm
   RA-050's recent_signals_panel picks up the events without code
   change (this is the schema-extensibility contract from RA-050).

Buffer: ~20-30 min for integration + visual smoke + docs.

# Smoke test paths after build

1. **Manual run against current state**:
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m rithmic_dashboard.cli.generate --output-path data\dashboard\index.html
   ```

2. **Browser verification** (open file:///D:/.../index.html):
   - Orderflow Pulse card has new "Institutional flow (last 60min)"
     subsection populated with data
   - When institutional concentration events fire during current
     session, they appear in RA-050's Recent Signals panel at top of
     dashboard (this verifies the schema-extensibility contract)
   - When ≥2 distinct families fire at same zone in 30 min (e.g.,
     sweep + institutional_concentration), RA-050's multi-stack banner
     appears at top (verifies family registration worked)
   - Active Posture sentence references institutional flow when
     relevant
   - Probability tooltip on scenarios shows institutional_flow_match
     contribution with trigger data: "+20% (12 institutional trades
     net +452 delta at W-1σ demand)"
   - Distance Grid zone badges (from RA-050) include institutional
     events with appropriate icon (suggest 🟣 purple for institutional;
     confirm in pre-build sweep)

3. **Threshold calibration smoke**:
   ```powershell
   python -m rithmic_dashboard.cli.calibrate_trade_size_thresholds `
     --symbol MNQ --lookback-sessions 6
   ```
   - With current capture corpus (~7 OBS sessions exist for MNQ from
     5/19-5/26), expect threshold values close to: retail p50 ≈ 2-3,
     mixed p75 ≈ 5-8, institutional p95 ≈ 30-50, block ≥ p95
   - Exit non-zero with insufficient data when --lookback-sessions
     exceeds available sessions

4. **Co-firing synthetic test**:
   - Synthetic scenario with institutional concentration at entry zone
     + bullish session CVD + delta dislocation
   - Expected: all 3 multipliers fire, additive composition reaches
     cap, tooltip shows all 3 with unclipped contributions noted
   - Verify guard against institutional_flow_match AND
     institutional_flow_oppose firing simultaneously for same scenario

5. **Full suite + lint + types**:
   ```powershell
   python -m pytest -x --tb=short
   ruff check .
   mypy rithmic_dashboard
   ```
   Target: ~123 tests green (108 prior + ~15 new). Ruff + mypy clean.

# Docs

Update `docs/operations.md` with:
- How to interpret Institutional Flow subsection
- When to run calibrate_trade_size_thresholds CLI (suggest weekly,
  external scheduling)
- How institutional events appear in Recent Signals panel and
  multi-stack banner
- Confidence flag meaning when tail span insufficient

Update `docs/feature_reference.md` with new module entries:
- `features/trade_size_classifier.py`
- `features/institutional_flow.py`
- `cli/calibrate_trade_size_thresholds.py`

# After ship

The probability framework gets institutional-flow conditioning, which
is the single largest source of signal alpha that current
absorption-based detection misses. A scenario at a zone with 3
institutional buys + matching CVD + sweep cluster will now display a
probability tooltip with 4 confirming multipliers (institutional + CVD
+ sweep + confluence) AND surface as a multi-stack banner alert in
RA-050.

After ship, the natural next step is RA-051 (day-type classification),
which conditions all of these per-event multipliers on session
character. Combined, RA-049 + RA-050 + RA-051 form the
sweep-absorption-dislocation-institutional-flow detection layer plus
day-type-conditional probability framework — the full picture for
intraday MNQ scenario probability.

# Operational notes

- Dashboard generator currently runs on a 5-min cadence per
  `run_local_probe_refresh.ps1 -IntervalMinutes 5`. No new scheduling
  needed.
- Canonical sources for aggregation:
  - obs01 trades: `data/captures/<date>/MNQ_<session>.obs01.jsonl`
    (read via bounded-tail helper, same as RA-046)
  - Output:
    `data/live_analysis/<date>_<session>_institutional_flow.jsonl`
    (canonical for institutional_concentration_detected and
    block_trade_at_zone events)
- Threshold file:
  `data/live_analysis/trade_size_thresholds.json` (atomic-write
  artifact from the CLI; loaded with sensible defaults if missing)
- 5/19-5/26 obs01 corpus exists for calibration testing; ~7 sessions
  available (Globex + RTH). Below the default --lookback-sessions 20
  but sufficient for synthetic verification of the percentile-rolling
  logic.

# Schema-extensibility contract with RA-050 (must hold)

When emitting events for live_analysis JSONL:

```jsonl
{"timestamp_pt": "2026-05-26 12:34:56 PT",
 "event_type": "institutional_concentration_detected",
 "level_id": "<zone_id>",
 "description": "12 institutional trades at W-1σ demand 29,790, net +452 delta",
 "intensity": 4.0,
 "confidence": "high",
 "metadata": {"count": 12, "net_delta": 452, "side": "buy"}}
```

The `event_type` string is what RA-050's family map uses for badge
icon + multi-stack family classification. Both
`institutional_concentration_detected` and `block_trade_at_zone`
should map to the same family ("institutional_flow") in RA-050's
family map for multi-stack purposes — they're distinct event types
but the same signal family.

Update RA-050's family map in the same PR (small edit to
multi_signal_stack_alert.py and zone_signal_badges.py constants).

# Standing by

Acknowledge this prompt + surface the pre-build sweep (plan + 7 picks +
phase estimates + anything found in obs01 schema or RA-046 code reading).
Do not write source until green-lit.
```
