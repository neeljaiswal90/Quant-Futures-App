# RA-050 Dispatch — Dashboard prominence upgrade for sweep + absorption signals

Copy-paste below into Codex. Smaller-scope UI/renderer upgrade that makes
RA-046's existing sweep/absorption signals — plus future RA-049/051
signals — explicitly visible at the top of the dashboard with
cross-references to scenarios.

Recommended FIRST build in the new RA-049/050/051 triplet: ships fastest,
delivers immediate trader-facing value, and creates the rendering frame
that the other two tickets' signals slot into without extra work.

---

# Copy-paste below

```
RA-050 — Dashboard prominence upgrade for sweep + absorption signals.
RA-046 added sweep + absorption detectors and surfaces them in the
Orderflow Pulse subsection + audit trail. In practice these signals get
buried — a trader scanning the dashboard quickly may miss a recent sweep
cluster at their target zone. This ticket makes sweeps and absorption
EXPLICIT, top-of-mind signals with visual prominence, cross-references to
scenarios, time-decay highlighting, and a sticky multi-signal stack
banner.

Ticket spec at:
D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md (search "RA-050")

~3-4h estimate. P1. Project: tools/rithmic_dashboard/ (extend existing
renderer). Smaller-scope UI/renderer ticket — no new computation, no new
event types, no probability-multiplier changes. Pure prominence upgrade
on existing RA-046 signal stream.

# Context you need before building

1. **This is a RENDERER ticket, not a computation ticket.** All signal
   events RA-050 displays already exist: sweep_detected and
   absorption_proxy in `_audit.json` AND in
   `data/live_analysis/<date>_<session>_sweeps.jsonl` /
   `data/live_analysis/<date>_<session>_absorption_proxy.jsonl`, plus
   delta_dislocation events from RA-047 in
   `data/live_analysis/<date>_<session>_delta_dislocations.jsonl`. No
   new sources. The work is aggregation + display + cross-reference
   logic. NOTE: the live_analysis JSONL files are the canonical
   per-session sources; `_audit.json` is a rolling deduped subset.
   Aggregation should read from live_analysis primarily and fall back
   to audit when live_analysis files are missing.

2. **The Recent Signals panel is the load-bearing element.** Positioned
   between Active Posture and Distance Grid (see ambiguity #1 — the
   recommended position is locked in, just confirm). Must show last 10
   events sorted newest-first, color-coded urgency, with cross-reference
   chips showing which scenarios each event affects.

3. **Cross-reference computation is the trickiest piece.** For each
   event, the renderer needs to: (a) look up which scenario zones the
   event price falls within (from the active scenario state); (b) match
   scenario bias direction with signal direction. The mapping logic
   should live in a small helper module, not inline in the template.

4. **Time-decay highlighting is purely visual.** <5min = glow, 5-15min
   = normal, 15-30min = 40% opacity, >30min = dropped. Implement as CSS
   classes applied based on event age at render time, NOT via animated
   transitions (the dashboard re-renders every 5 min per the active
   `run_local_probe_refresh.ps1 -IntervalMinutes 5` automation —
   animations would be incoherent across refreshes).

5. **Zone-level signal badges in Distance Grid.** Each zone row gets a
   small badge column with unicode icons (🔵 sweep, 🟠 absorption, 🔴
   dislocation, 💎 multi-stack). Badge appears if ANY event of that type
   fired at that level in the last 30 min. Badge tooltip shows the most
   recent event details. The badge column should be narrow (~30px) and
   NOT break the existing Distance Grid layout.

6. **The sticky multi-signal stack banner is the highest-value element
   for trade decisions.** Fires when ≥2 DISTINCT signal types (sweep AND
   absorption, or absorption AND dislocation, etc.) hit the same zone
   within a 30-min window. Critical that "≥2 of the same type" does NOT
   trigger the stack — only DISTINCT types qualify. Banner sits above
   Active Posture, full-width, dismissible. Auto-decays after 30 min OR
   when price moves >30pt away from the zone.

7. **Schema extensibility matters.** RA-049 (trade-size profiling) and
   RA-051 (day-type classification) will both add new event types
   (institutional_concentration, day_type_classified, ib_high_break,
   etc.). The Recent Signals panel + zone badges + multi-stack alert
   logic should accept ARBITRARY event_type strings without code change
   — schema is `(timestamp, event_type, level_id, description,
   intensity, confidence)`. Don't hardcode event-type lists.

# Pre-build sweep expectation

Per the established discipline (RA-040 through RA-047), do a pre-build
sweep BEFORE writing any source files:

- Plan paragraph summarizing the build and how the 5 phases connect
- Confirmation of the 7 ambiguity points (recommended defaults in
  ticket): panel position, time-decay window, multi-stack threshold
  semantics, badge styling, cross-reference scope, sticky banner
  placement, plus anything new surfaced when reading the renderer code
- Engineer's-call defaults taken unless flipped
- Time estimate per phase

Surface the sweep as a single message. Wait for green-light before
writing code. Do not start Phase 1 source until explicitly approved.

# Build order recommendation

Phases are sequential — each builds on the previous renderer state:

1. **Phase 1 (~45-60 min)**: Recent Signals panel module +
   template integration. Pulls events from audit trail + dislocations
   log, formats rows, renders between Active Posture and Distance Grid.
   Tests with synthetic event mix.

2. **Phase 2 (~30-45 min)**: Cross-reference helper. Maps event price
   → scenario zones currently active. Renders "affects:" chips on each
   event row. Tests with multi-zone overlap cases.

3. **Phase 3 (~20-30 min)**: Time-decay CSS classes + render-time age
   computation. Visual states verified via snapshot tests + manual smoke.

4. **Phase 4 (~30-45 min)**: Zone-level signal badge column in Distance
   Grid. Per-zone event aggregation. Badge with tooltip. Tests with
   multi-event-type-at-zone case.

5. **Phase 5 (~45-60 min)**: Multi-signal stack detection module +
   sticky banner template. Distinct-type validation, 30-min window
   logic, price-distance auto-decay. Tests with: 2 distinct types
   trigger banner, 3 same type does NOT trigger, banner decays after
   30 min, banner decays when price moves >30pt away.

Buffer: ~30-45 min for integration + visual smoke + docs.

# Smoke test paths after build

1. **Manual run against current state**:
   ```powershell
   cd D:\Quant-futures-app\tools\rithmic_dashboard
   python -m rithmic_dashboard.cli.generate --output-path data\dashboard\index.html
   ```

2. **Browser verification** (open file:///D:/.../index.html):
   - Recent Signals panel appears between Active Posture and Distance Grid
   - Panel shows recent events sourced from 5/26 live_analysis JSONLs
     + `_audit.json` artifacts combined (sweeps + absorption_proxy +
     delta_dislocations); should display the last 10 sorted
     newest-first
   - Color chips (red/amber/gray) render correctly per urgency
   - "affects:" cross-reference chips appear on event rows where
     scenario zones contain the event price
   - Time-decay opacity is visually distinguishable for <5/<15/<30 min
     buckets
   - Distance Grid badge column renders without breaking layout
   - Badges appear on zones with recent events; tooltip shows recent
     event details on hover

3. **Synthetic multi-signal stack test** (controlled):
   - Synthetic state file with: sweep_detected at 30,000 at T-10min,
     buy_absorbed at 30,000.50 at T-5min, current price 30,005
   - Expected: sticky banner appears above Active Posture listing both
     events
   - Synthetic state file with: 3 sweep_detected at 30,000 within 5 min
   - Expected: NO sticky banner (same type doesn't count)
   - Synthetic state file with: stack triggered, then price moves to
     30,050 (40pt away)
   - Expected: banner decays

4. **Schema-extensibility smoke**: inject a synthetic event with a
   never-before-seen event_type ("institutional_concentration_detected")
   and verify it renders in Recent Signals panel without errors. This
   confirms RA-049/051 signals will slot in cleanly.

5. **Full suite + lint + types**:
   ```powershell
   python -m pytest -x --tb=short
   ruff check .
   mypy rithmic_dashboard
   ```
   Target: ~107 tests green (97 prior + ~10 new). Ruff + mypy clean.

# Docs

Update `docs/operations.md` with:
- How to read the Recent Signals panel (color codes, sort order, decay)
- How to interpret zone badges in Distance Grid
- What triggers the multi-signal stack banner + how to dismiss

Update `docs/feature_reference.md` with new module entries:
- `features/recent_signals_panel.py`
- `features/zone_signal_badges.py`
- `features/multi_signal_stack_alert.py`

# After ship

The dashboard becomes materially easier to scan. The trader will see at
a glance: "what signals just fired and which of my scenarios do they
affect?" The multi-signal stack banner becomes the highest-conviction
alert for trade decisions — when sweep + absorption fire at the same
zone in 30 min, that's the moment to take the trade.

Subsequent tickets (RA-049, RA-051) will produce additional event types
that flow into this same display infrastructure without rework. The
schema-extensibility test (smoke #4 above) is the contract that future
event types will appear automatically.

# Operational notes

- Dashboard generator currently runs on a **5-min cadence** per
  `run_local_probe_refresh.ps1 -IntervalMinutes 5` (capture operator's
  active automation). No new scheduling needed.
- **Real-data fixture for visual smoke**: combine the 5/26
  `data/live_analysis/2026-05-26_globex_*.jsonl` files (sweeps,
  absorption_proxy, delta_dislocations) with the rolling
  `_audit.json`. Don't rely on audit count alone — many signal
  artifacts live in the per-session live_analysis JSONLs and the audit
  is deduped/capped. Aggregation tests should read from the JSONL
  files first.
- Canonical sources for aggregation:
  - Sweep events: `data/live_analysis/<date>_<session>_sweeps.jsonl`
    (fallback: `_audit.json` event_type=sweep_detected)
  - Absorption events:
    `data/live_analysis/<date>_<session>_absorption_proxy.jsonl`
    (fallback: `_audit.json` event_type=absorption_proxy)
  - Delta dislocation events:
    `data/live_analysis/<date>_<session>_delta_dislocations.jsonl`
    (no audit fallback — this is the only source)

# Standing by

Acknowledge this prompt + surface the pre-build sweep (plan + 7 picks +
phase estimates). Do not write source until green-lit.
```
