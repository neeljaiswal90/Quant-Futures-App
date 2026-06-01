# Codex Dispatch — RA-107: depth heatmap time-persistence accumulator (the actual Bookmap mechanism)

Coordinator dispatch from a live UI audit dated 2026-06-01. Read `v2_codex_handoff.md` for invariants. Pre-build sweep → green-light → build → verify → ship.

## Why this exists

RA-105a's heatmap contrast model (10-min rolling p60 floor + ^2.0 power scale) is mathematically correct but the operator reports it as "non-existent" on MNQ. Live data sampled 2026-06-01 23:00 PT shows why:

| Percentile | Size (lots) |
|---|---|
| min | 1 |
| p25 | 2 |
| median | 3 |
| **p60 (current floor)** | **6** |
| p99 | 20 |
| max | 21 |

**MNQ's order book distribution is uniform, not fat-tailed.** Max-to-median ratio is 7×. The largest single level is 21 lots — there are NO actual walls in any single frame. Bookmap's signature visual assumes a distribution with persistent 50-200x outliers; MNQ in normal conditions doesn't have them.

The fundamental issue: **single-frame contrast is the wrong signal**. Bookmap's real mechanism is **time-persistence** — a level shows as bright BECAUSE size > threshold persisted at that price for many consecutive frames, not because it's big in one frame. A 10-lot level standing at $30,545 for 5 minutes is a wall; a transient 20-lot pop is noise. Single-frame size cannot distinguish them.

This ticket builds the persistence accumulator that creates the horizontal-band signature operators recognize. Replaces "size per cell" with "persistence-score per cell" as the variable the contrast model operates on. The contrast model from RA-105a stays, but its parameters need re-tuning against the new persistence-score distribution (sub-task #6 below).

## The math (formal definition)

For each price `p` in the depth payload, maintain a running persistence score updated per frame:

```
persistence_score[p, t] = decay_factor × persistence_score[p, t-1] + size[p, t]
```

Where `size[p, t]` is the level's size in the current frame (`0` if the price doesn't appear in the current frame — the level disappeared from the book temporarily).

Properties:
- **Steady state for persistent size s**: `s / (1 - decay_factor)`. With `decay = 0.998` and `s = 10`, steady-state score = 5,000.
- **Transient single-frame size s**: starts at `s`, decays geometrically. After 500 frames: `s × decay^500`. At `decay = 0.998`, that's `s × 0.367`.
- **Half-life**: `ln(0.5) / ln(decay)` frames. At `decay = 0.998` and 4 fps backend emission, half-life ≈ 173 frames ≈ 43 seconds.

The persistence_score has units of "lot-frames" (decay-weighted sum of size over frames). It is NOT a count of lots — it's a measure of "presence × magnitude × time."

**Why this works:** A persistent 10-lot level reaches steady-state score 5,000. A transient single-frame 50-lot level peaks at 50, then decays. The ratio at the persistent level's steady state is **100×** despite the transient being 5× larger in raw size. That's the wall vs noise contrast Bookmap shows.

## Build

### 1. Persistence accumulator module

New file: `apps/dashboard_ui/src/chart/depthPersistence.ts`.

Exports:
- `DEFAULT_DECAY_FACTOR = 0.998` (43s half-life at 4fps; operator-tunable).
- `DEFAULT_PRUNE_THRESHOLD = 0.5` (lot-frames; prices with score below this are removed from the accumulator's Map to bound memory).
- `class DepthPersistenceAccumulator`:
  - `constructor({ decayFactor, pruneThreshold })`
  - `update(levels: DepthHistoryLevel[]): Map<price, persistenceScore>` — applies the recurrence for ALL known prices (current frame + prior accumulator state), returns the new state. Pure-ish: takes input, returns output, also mutates internal state for the next call.
  - `clear()` — used on resync / session reset.
  - `state(): ReadonlyMap<price, score>` — for testing.
- Decimal-precision discipline: prices are snapped to `MNQ_TICK` (0.25) via `snapPrice()` from `priceGrid.ts`. The accumulator's Map keys are tick-aligned floats; comparing them is safe because of the snap.

### 2. DepthHistoryColumn change (the "size" field now carries persistence_score)

In `apps/dashboard_ui/src/chart/depthHeatmap.ts`:

- `DepthHistoryLevel.size` stays the field name, but the SEMANTICS change: it now holds `persistence_score`, not raw lots. Update the JSDoc comment to make this explicit.
- `DepthHeatmapCell` adds a NEW optional field `rawSize: number` for the hover tooltip (so the operator can still see "this cell currently has 12 lots" alongside the persistence-driven color). Tooltip text format: `"persist=4823 | size=12 @ 30547.50"`.
- `depthPayloadToColumn(payload)` now:
  1. Build the `DepthHistoryLevel[]` from the payload as before (raw size).
  2. Pass the raw-size array through `DepthPersistenceAccumulator.update()` → get persistence-score map.
  3. Re-emit the column's levels with `size = persistence_score[price]` and `rawSize = raw_size[price]`.
- The accumulator state lives on `DepthHeatmapPrimitive` (instance member). It's reset on `detached()` and on `setHistory()` (which represents a session resync).

### 3. setHistory replay (for reload-smoke / RA-100 backfill)

When `DepthHeatmapPrimitive.setHistory(payloads)` is called (on reconnect or initial backfill), the persistence accumulator must be **rebuilt from scratch** by replaying all backfilled frames in order. Codex must NOT use the raw setHistory-frame sizes directly — that would render the backfilled portion of the chart with single-frame-size visual semantics and the live portion with persistence-score semantics, an obvious visual seam. Replay through the accumulator → emit columns with the correctly-evolved persistence scores at each historical frame.

The replay cost is one accumulator-update per backfilled frame (cheap; map operations only). Backfill of 100 columns × ~150 prices each = ~15,000 ops, sub-ms.

### 4. Visible-range projection

`projectDepthHeatmapCells()` and the contrast model continue to operate on `size` (which now holds persistence_score). Filter thresholds, opacity scaling, color mapping all consume persistence_score values transparently. **No changes to the rendering pipeline** — just the input data has different semantics.

### 5. Operator-tunable decay

- Default `decayFactor = 0.998` (~43s half-life). Surface via a single env-driven UI constant, NOT a runtime control in v1 (avoid a slider that operators fiddle with mid-session).
- Add a CSS-grade comment in `depthPersistence.ts` explaining how to tune:
  - `0.99` ≈ 7s half-life (responsive, less persistent — feels close to the current behavior)
  - `0.998` ≈ 43s half-life (default — Bookmap-typical)
  - `0.9995` ≈ 23min half-life (session-view mode)
- If RA-107a follows up with an operator slider, scope is separate.

### 6. Re-tune the contrast model parameters for persistence-score distribution (NOT raw size)

RA-105a's parameters were calibrated against raw-size distribution (min=1, max=21, median=3). Persistence-score distribution will look very different:
- Persistent walls (10+ lots × hundreds of frames): scores in the thousands
- Transient noise (1-2 lots × a few frames): scores below 50
- Ratio between walls and noise: 100-1000× (the Bookmap-ratio we wanted)

The current `max(p60, 0.05 * rollingMax)` floor + `^2.0` power scale will likely OVER-suppress now that the dynamic range is larger. Codex must:
- Sample the actual persistence-score distribution after the accumulator runs against ~5 min of live capture
- Re-pick floor parameters: coordinator lean is `max(p25, 5.0 lot-frames)` — show the bottom 75% to keep visual density, hide only sub-noise levels
- Re-pick power scale: coordinator lean is `^0.5` (square-root, gentler than `^2.0`) given the wider dynamic range
- Re-pick minimum-shown opacity: `0.15` floor once a cell is rendered at all (so any shown cell is at least faintly visible — no "shown but invisible" cells)

Show the before/after distribution histograms in the ship report.

### 7. Tests (new and modified)

`apps/dashboard_ui/src/chart/depthPersistence.test.ts` (new):
- Fixture: 1000 frames with a 10-lot persistent level at $30,545 + transient 50-lot pops at random prices in 10% of frames.
- Assert:
  - The persistent level's score reaches its theoretical steady state (`10 / (1 - 0.998) = 5000`) within `5 / (1 - decay) = 2500` frames.
  - Transient pop scores never exceed `50 + epsilon` and decay below `pruneThreshold` within `~3000` frames.
  - After `clear()`, accumulator is empty.
  - Prune: a level absent for >2000 frames is removed from the Map (memory bounded).

`apps/dashboard_ui/src/chart/depthHeatmap.test.ts` (modified):
- Existing tests update to assert that `DepthHeatmapCell.size` now contains persistence_score, `rawSize` contains raw size. The pre-RA-107 size assertions become rawSize assertions.
- New test: a `setHistory` replay produces persistence-score-bearing columns whose values match a synchronous accumulator replay over the same input.
- New test: the contrast model on persistence-score distribution correctly hides transient pops and shows persistent walls.

## Hard invariants

- **UI-only.** Path scope: `apps/dashboard_ui/src/chart/`. NO contract change, NO backend change, NO detector change. The accumulator is fully client-side projection on top of existing DepthPayload data.
- **Autoscale re-entrancy preserved.** Per [[lightweight-charts-autoscale-reentrancy]]: `DepthHeatmapPrimitive.autoscaleInfo()` still returns `null`. Persistence accumulator does NOT introduce new chart primitives that could re-enter.
- **`Math.min(...arr)` spread antipattern preserved.** Per [[math-minmax-spread-antipattern]]: the persistence accumulator's max-over-state, used by the contrast model, is computed with a single-pass for-loop. Grep `Math\.(min|max)\(\.\.\.` over the diff before shipping.
- **No new wire payloads.** v1 is client-side persistence only. If a future ticket wants server-side persistence (so multiple clients agree on what's a wall), that's RA-107a with a contract addition.
- **Surgical path-scoped commit.** Stage only `apps/dashboard_ui/src/chart/depthPersistence.{ts,test.ts}` + `apps/dashboard_ui/src/chart/depthHeatmap.{ts,test.ts}`. Do NOT bundle the RA-105b parameter retune from this ticket with anything else.

## Pre-build sweep gate

Sweep must cover:

1. **Decay-factor choice math** — confirm the 0.998 default's half-life given the backend's actual `RA60_DEPTH_EMIT_INTERVAL_SECONDS` (default 0.250s = 4 fps; can be configured higher/lower). If operator runs at 2 fps, the half-life doubles to 86s — operator-aware doc comment must explain this.
2. **Memory bound for the accumulator** — at 100 ticks per side × 100 columns of history × 1 accumulator score per (price, frame) — the Map grows to at most ~200 entries (prices in current frame); pruning threshold + accumulator clear-on-resync keeps the size bounded. Show the worst-case Map size during a 10-min session.
3. **Replay determinism for setHistory** — Codex must confirm: replaying the same backfill produces identical persistence scores across runs. No floating-point drift between live and replay paths.
4. **Contrast model re-tuning method** — propose how Codex will sample the actual persistence-score distribution (e.g., a small instrumentation print in dev mode, or running against captured WS frames offline). Coordinator wants to see the histogram-based justification for the new parameters, not "feels about right."
5. **Hover tooltip format** — confirm operator-readable text. Coordinator proposal: `"30547.50 | persist 4823 | size 12 lots"` — explicit units, both numbers visible. Codex may iterate.
6. **Confirmation no contract / backend / detector / capture / probe / scheduler change.**

## Acceptance

- A 10-lot level standing for 5 minutes renders as a clearly-bright horizontal band on the heatmap.
- A transient 20-lot pop appears briefly, then visibly fades to invisible within ~30-60 seconds (operator-perceptible decay).
- Before/after screenshots in the ship report. Same chart, same data window — before (RA-105a single-frame) vs after (RA-107 persistence). The horizontal-band signature should be visible only in the "after" image.
- vitest passes (with new accumulator + heatmap tests).
- tsc, lint, build clean.
- A short (10-frame) sample log in the ship report showing persistence-score evolution at one persistent price + one transient price — operator-readable proof the math is correct.
- The hover tooltip on a heatmap cell shows BOTH the current raw size and the persistence score.
- Contrast model parameter re-tune values committed in the same commit (since they're coupled to the persistence-score distribution).
- Memory note: no leak — the accumulator's Map size stays bounded across a long-running session (verify with a 1-hour soak in dev mode if practical).

## Coordinator review focus

The headline is the **before/after side-by-side**. RA-107 ships when an operator can look at the live chart and see "ah, THERE's the wall at $30,545" — a horizontal bright band that wasn't visible before. The ship report MUST include the side-by-side screenshot (same chart, same time window).

The math doc comment in `depthPersistence.ts` is the secondary deliverable: a future operator (or coordinator) reading the code in 3 months should understand the formula, the half-life relation, and the rationale for the default decay value without having to re-derive it.

The unit test fixture (1000 synthetic frames with a persistent level + transient pops) is the third deliverable: it's the executable proof that the math is correct, and the regression guard for any future tuning work.

## Priority

After RA-105a (already landed) and RA-105b (the quick parameter relaxation, if shipped tonight separately). RA-107 supersedes RA-105b's parameter values — they'll need a fresh tune against the persistence-score distribution. If RA-105b ships first, document in its commit message that the parameters are "interim, to be re-tuned in RA-107."

Estimated 2-3 day implementation including the contrast model re-tune cycle.

## Future option (out of scope; for the operator)

- **RA-107a — operator-visible decay slider.** Tier-2 ergonomic improvement. The default 43s half-life works for most operators, but during news events or thin liquidity, a shorter half-life (responsive) or longer (session-view) may be preferred. Hold for now; default + env-driven tuning is enough for v1.
- **RA-107b — server-side persistence.** If multiple dashboards need to agree on what counts as a wall (or if persistence-history needs to survive client reloads), move the accumulator to the backend's depth poller and add `persistence_score` to `DepthLevel`. Contract addition; defer until there's a clear multi-client requirement.
- **RA-108 — walls feed.** Emit DISCRETE wall-detection events as a new signal family when persistence_score crosses a threshold. The heatmap is decorative context; the walls feed is the actionable signal. Distinct contract addition; defer until RA-107 proves the persistence-score formulation is correct.
