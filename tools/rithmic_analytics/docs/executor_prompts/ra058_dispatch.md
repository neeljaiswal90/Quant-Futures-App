# RA-058 Dispatch - Aggressor flow metrics + tabular footprint

Copy-paste below into Codex. This is the first of the two
bookmap-equivalent signal tickets, and it should ship before RA-059
because it is the lighter scope: windowed trade aggregation from the
existing obs01 stream, plus a tabular footprint renderer.

Critical context: RA-046 already computes session/rolling CVD, RA-050
already exposes generic Recent Signals, and RA-052 protects the
5-minute dashboard loop with the light-path memory contract. RA-058
must add richer aggressor-flow visibility without changing existing CVD
semantics or making the loop heavy again.

---

# Copy-paste below

```
RA-058 - Aggressor flow metrics + tabular footprint chart.

Build the bookmap-equivalent liftAsk / hitBid / vDelta metrics and a
per-price-per-5-minute tabular footprint from the existing Rithmic
obs01 trade stream. This gives the dashboard the order-flow details the
user was manually reading from Bookmap during the 2026-05-28 session:
who is lifting the ask, who is hitting the bid, where momentum flips,
and which price levels show stacked buy/sell imbalance.

Ticket spec at:
D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md (search "RA-058")

~6-8h estimate. P1. Project:
D:\Quant-futures-app\tools\rithmic_dashboard

Build this before RA-059. RA-058 is pure aggregation over the existing
trade stream; RA-059 depends on more complex MBO order-lifecycle
tracking.

# Context you need before building

1. **This is additive to RA-046 CVD, not a replacement.** Keep
   `session_cvd`, `last_60m_cvd`, and existing CVD artifacts unchanged.
   RA-058 adds windowed aggressor decomposition: liftAsk, hitBid, net,
   ratio, vDelta, and footprint imbalance.

2. **Use the obs01 trade stream, not raw MBO.** Inputs should be
   `data\captures\<date>\MNQ_<session>.obs01.jsonl` when available,
   following the existing bounded-tail-read pattern from RA-046 and
   RA-052. Do not introduce full raw-capture scans on the 5-minute
   light path.

3. **The four aggressor windows are load-bearing.** Compute each
   dashboard tick for `[60s, 5m, 15m, 60m]`:
   - liftAsk = aggressive market-buy volume
   - hitBid = aggressive market-sell volume
   - net = liftAsk - hitBid
   - ratio = liftAsk / max(hitBid, 1)
   - total_volume = liftAsk + hitBid
   These are the Bookmap-style flow numbers the user wants surfaced.

4. **vDelta is short-window momentum, not session CVD.** Default
   vDelta window is 30 seconds. Emit `v_delta_sign_flip` only when the
   sign has remained flipped for at least 10 seconds; this hysteresis
   prevents noisy zero-crossing spam.

5. **Footprint is a table, not a heatmap.** Aggregate completed 5-minute
   bars by price tick:
   - bid_volume = aggressive sells at that price
   - ask_volume = aggressive buys at that price
   - imbalance = (ask_volume - bid_volume) / max(total_volume, 1)
   Persist to `data/live_analysis/<date>_<session>_footprint.jsonl`.
   Render a compact HTML table for the current/last completed bar.

6. **Audit events must use the RA-050 generic event schema.**
   Required event types:
   - `aggressor_imbalance_extreme`
   - `stacked_footprint_imbalance`
   - `v_delta_sign_flip`
   Register family `"aggressor_flow"` in `multi_signal_stack_alert.py`
   and `zone_signal_badges.py` in the same PR.

7. **RA-052 memory contract still rules.** Light-path peak RSS must
   stay under 2GB. Use bounded tails, streaming iteration, and compact
   aggregates. Do not materialize a full multi-GB session into memory.

8. **Active Posture should mention only meaningful extremes.** Avoid
   adding always-on narration. Add an aggressor-flow sentence only when
   a configured extreme fires, for example a ratio > 3.0 or < 0.33, or
   a meaningful vDelta sign flip near a key level.

9. **Keep the dashboard operationally quiet.** The 5-minute refresh
   should continue even if the footprint artifact is missing, a session
   has too little trade data, or aggressor_side fields are sparse.
   Emit a data caveat/audit entry rather than crashing.

# Pre-build sweep expectation

Per established discipline (RA-040 through RA-053), do a pre-build
sweep BEFORE writing source. Surface 9 ambiguity points:

1. vDelta window default: 30 sec vs 60 sec. Recommend 30 sec.
2. Aggressor windows: `[60s, 5m, 15m, 60m]` vs alternatives.
   Recommend the ticket defaults.
3. Footprint price granularity: per tick vs bucketed. Recommend
   per tick for MNQ precision.
4. Footprint bar window: 5-minute vs 1-minute. Recommend 5-minute to
   match dashboard cadence.
5. Imbalance audit threshold: 0.3 vs 0.5. Recommend 0.3.
6. Stacked imbalance count: 3 consecutive prices vs 4. Recommend 3.
7. vDelta sign-flip cooldown/hysteresis: 10 seconds vs no cooldown.
   Recommend 10 seconds.
8. Display formatting: Bookmap-style separators/chips vs raw integers.
   Recommend readable formatted numbers.
9. Anything surfaced reading current `orderflow_pulse.py`,
   `live_signals.py`, `audit_trail.py`, and RA-050 Recent Signals code.

Also include:
- Plan paragraph summarizing the 5 phases and how they connect
- Engineer's-call defaults unless flipped
- Time estimate per phase
- Explicit confirmation that existing CVD semantics are unchanged

Surface the sweep as a single message. Wait for green-light before
writing code. Do not start Phase 1 source until explicitly approved.

# Build order recommendation

Phases are sequential:

1. **Phase 1 (~75-90 min): windowed aggressor metrics.**
   Create `rithmic_dashboard/features/aggressor_metrics.py`.
   Compute liftAsk, hitBid, net, ratio, and total volume for the four
   windows. Persist most-recent metrics in session-state JSON or the
   repo's existing live-signal state pattern. Add synthetic tests for
   sign, window inclusion/exclusion, empty windows, and ratio guards.

2. **Phase 2 (~45-60 min): vDelta + sign-flip detection.**
   Add 30-second vDelta computation and the 10-second sign-flip
   hysteresis. Emit `v_delta_sign_flip` through the existing audit/live
   signal path. Tests should cover positive/negative signs, zero volume,
   noisy flips that should be suppressed, and stable flips that emit.

3. **Phase 3 (~90-120 min): footprint aggregator.**
   Create `rithmic_dashboard/features/footprint_aggregator.py`.
   Aggregate per-price bid/ask volume and imbalance for completed
   5-minute bars. Persist
   `data/live_analysis/<date>_<session>_footprint.jsonl` idempotently.
   Detect `stacked_footprint_imbalance` for 3+ consecutive prices with
   same-side imbalance magnitude > 0.3. Add tests for bar boundaries,
   per-price aggregation, imbalance bounds, and stacked detection.

4. **Phase 4 (~75-90 min): renderer, audit, posture wiring.**
   Extend Orderflow Pulse with:
   - "Aggressor Flow" subsection for the four windows
   - vDelta directional chip
   - "Footprint" subsection for current/last completed bar
   Add Active Posture text only for extreme events. Ensure missing data
   produces a caveat, not an exception.

5. **Phase 5 (~60-75 min): RA-050 integration + docs.**
   Register family `"aggressor_flow"` in the RA-050 family maps and
   zone badge constants. Ensure the three event types appear in Recent
   Signals via the existing schema contract. Update feature and ops
   docs. Add integration tests for Recent Signals and layout smoke.

Buffer: ~45-60 min for visual smoke, full tests, ruff, and mypy.

# Smoke test paths after build

1. **Unit tests for metrics:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -q tests/test_aggressor_metrics.py tests/test_v_delta.py
   ```
   Expected: liftAsk/hitBid math correct, window nesting correct,
   vDelta signs correct, sign-flip hysteresis suppresses flapping.

2. **Footprint tests:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -q tests/test_footprint_aggregator.py tests/test_aggressor_imbalance_audit.py
   ```
   Expected: per-price-per-bar rows, imbalance in [-1, 1], stacked
   imbalance event fires only for configured consecutive levels.

3. **RA-050 schema smoke:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -q tests/test_aggressor_ra050_integration.py
   ```
   Expected: aggressor events appear in Recent Signals; family
   `"aggressor_flow"` is available to badges/stack alerts.

4. **Real-data dashboard smoke:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m rithmic_dashboard.cli.generate --trading-date 2026-05-28 --session rth --output-path data\dashboard\index.html
   ```
   Expected: Orderflow Pulse renders Aggressor Flow + Footprint
   sections against real 5/28 data without breaking existing panels.

5. **Memory validation:**
   Run the RA-052 light-path memory/call-graph tests. Expected:
   RA-058 does not introduce full-capture materialization and peak RSS
   remains under 2GB on the light path.

6. **Full suite + lint + types:**
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m pytest -x --tb=short
   ruff check .
   mypy rithmic_dashboard
   ```
   Target: existing test count + roughly 15 new tests. Ruff + mypy
   clean.

# Docs

Update `docs/feature_reference.md` with:
- liftAsk / hitBid / net / ratio definitions
- vDelta definition and how it differs from session CVD
- footprint row schema and imbalance formula
- audit event definitions and thresholds

Update `docs/operations.md` with:
- how to interpret aggressor-flow extremes
- what missing/low-volume footprint data means
- the memory contract: bounded-tail obs01 reads only

# Acceptance bar

- liftAsk / hitBid computed correctly on synthetic trade sequences.
- Multiple window metrics are internally consistent.
- vDelta sign and 10-second hysteresis work.
- Footprint JSONL persists per-price-per-bar rows idempotently.
- `aggressor_imbalance_extreme`, `stacked_footprint_imbalance`, and
  `v_delta_sign_flip` events use the generic RA-050 schema.
- Dashboard renders Aggressor Flow + Footprint without layout breakage.
- Active Posture updates only when meaningful extremes fire.
- Recent Signals panel shows aggressor-flow events via schema contract.
- Light path remains under the RA-052 2GB memory ceiling.
- Tests, ruff, and mypy are green.

# Out of scope

- Canvas/WebGL heatmap rendering; that remains RA-062 territory.
- MBO order-lifecycle/iceberg tracking; that is RA-059.
- Predictive ML flow modeling.
- Auto-trade execution.

# After ship

The dashboard should expose the same trade-side flow numbers the user
currently reads from Bookmap: liftAsk, hitBid, short-window vDelta, and
price-level footprint imbalance. RA-059 can then add the complementary
MBO hidden-order/iceberg signal on top of this footprint foundation.

Standing by for the pre-build sweep. Do not write source until green-lit.
```

