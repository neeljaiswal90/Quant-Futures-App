# Codex Dispatch — RA-107a: side-polarized heatmap + iceberg hue + top-N wall markers

Coordinator dispatch from a live UI audit dated 2026-06-01 against RA-107 (commit `63af040`). Read `v2_codex_handoff.md` for invariants. Pre-build sweep → green-light → build → verify → ship.

## Why this exists

RA-107's persistence heatmap landed correctly — bands are visible, the math is right. But operator review of the live shell shows three remaining issues that block at-a-glance readability while trading:

1. **Heatmap has no bid/ask polarity.** Every persistence band paints the same amber regardless of whether it's a resting offer above mid (ask-side, sellers defending) or a resting bid below mid (bid-side, buyers defending). Operators reading Bookmap rely on side polarization to instantly identify "ceiling vs floor" — currently a 2-second cognitive step for what should be a 0-second visual read.

2. **Iceberg coverage bands have a side-coloring bug.** The existing `icebergCoverageFill()` in `eventBubbles.ts` does check `side`:
   ```typescript
   return ask ? `rgba(251, 191, 36, alpha)` : `rgba(250, 204, 21, alpha)`;
   ```
   But the two RGB values are practically identical ambers. The differentiation exists in code, invisible to the eye. Operators report they "can't tell ask vs bid" on icebergs. Real bug, simple fix.

3. **No discrete "trade off this level" anchor.** The heatmap shows persistent bands as a gradient, but operators often want a specific labeled price line at the top-N most persistent levels: "Wall ask 30,525 (persist 4,823)". This is the difference between "I see persistence" and "I know exactly which level to trade off of right now."

All three are UI-only. None require contract change, backend touch, or detector work.

## Build

### 1. Side-polarized heatmap colors

In `apps/dashboard_ui/src/chart/depthHeatmap.ts`:

- `depthCellColor(intensity, quality, side)` takes a new `side: 'bid' | 'ask'` argument.
- `DepthHeatmapCell` adds `side: 'bid' | 'ask'` field, derived from `level.price > column.mid`.
- Color polarization:
  - **Ask side** (`price > mid`): pink/red family, base color `rgba(248, 113, 113, alpha)` — Tailwind red-400 saturation, NOT the execution-tier saturated red. Intensity blend stays within the pink family (no green-shift).
  - **Bid side** (`price < mid`): sky/cyan family, base color `rgba(56, 189, 248, alpha)` — Tailwind sky-400.
  - **Quality-modulation preserved**: `stale_l1` and `inferred` darken/desaturate the same way as today, just within the polarized hue.
- Intensity still drives opacity via `depthCellOpacity()` — unchanged formula. Hue indicates SIDE; opacity indicates PERSISTENCE.
- Equal-to-mid edge case: rare (price === mid exactly); treat as ask-side. Document the tie-break.

**Tests** (`depthHeatmap.test.ts`):
- Fixture with one ask-side level above mid + one bid-side level below mid + same intensity → asserts different hue family.
- Fixture with intensity gradient on one side → asserts opacity scales correctly within the polarized hue.

### 2. Iceberg coverage band hue fix

In `apps/dashboard_ui/src/chart/eventBubbles.ts`, replace `icebergCoverageFill()` and `icebergCoverageStroke()`:

- **Ask-side iceberg** (sellers refilling, defending ceiling): pink-400 family, `rgba(244, 114, 182, alpha)` fill, slightly brighter `rgba(249, 168, 212, 0.72)` stroke.
- **Bid-side iceberg** (buyers refilling, defending floor): sky-400 family, `rgba(56, 189, 248, alpha)` fill, `rgba(125, 211, 252, 0.72)` stroke.

These colors match the heatmap's polarization. An ask-side iceberg now visually sits inside the pink heatmap zone; bid-side sits inside the cyan zone. Operator mental model is consistent across both visual layers.

**Tests** (`eventBubbles.test.ts`):
- Assert ask-side iceberg band fill starts with `rgba(244, 114, 182` and bid-side starts with `rgba(56, 189, 248`. NOT both starting with the same first two RGB values.

### 3. Top-N wall markers

New file: `apps/dashboard_ui/src/chart/wallMarkers.ts`.

Logic:
- From the accumulator state in `DepthHeatmapPrimitive`, select the top-N levels by current persistence_score (N=3 default, configurable).
- For each, emit a `WallMarker` with:
  - `price` — the level
  - `side` — bid/ask (derived from mid at last update)
  - `persistenceScore` — for the label
  - `staleness` — `live` if level appeared in current frame, `stale` if it's persisting from prior frames but not currently in the book
- Render each wall as a thin horizontal price line via lightweight-charts' `createPriceLine` (existing API, not a custom primitive — avoids autoscale re-entrancy entirely):
  - Color: same polarization as the heatmap (pink for ask, sky for bid)
  - LineStyle: `Dashed` (distinct from RA-105's institutional level lines which are `Solid`)
  - Title: `wall ${side} ${formatMnqPrice(price)} (p${Math.round(score)})` — short, scannable

Refresh logic:
- The top-N walls re-evaluate when the accumulator updates.
- If a wall drops out of top-N (new larger wall appears OR this wall decayed below threshold), the price line is removed.
- If a wall enters top-N, a new price line is created.
- This is a state diff per frame; cheap with N=3.

State management:
- `wallMarkers.ts` exports `WallMarkerManager` class with `setAccumulatorState(state, mid)` method.
- `useDepthHeatmap.ts` instantiates one `WallMarkerManager`, attaches to the price series, calls `setAccumulatorState` from the depth-snapshot-callback path.
- On unmount/detach, all wall price lines are removed.

**Tests** (`wallMarkers.test.ts`):
- Fixture: 5 levels with persistence scores [100, 200, 50, 800, 400]. Top-3 = [800, 400, 200]. Assert which 3 markers are emitted with correct prices, sides, and stale flags.
- Fixture: same 5 levels, then add level with score 1000. Top-3 shifts. Assert old marker removed + new marker added.

### Carve-out documentation

The RA-100/RA-103 rule says **green/red is reserved for trade executions on the price chart**. RA-107a uses pink-400 (NOT saturated red) and sky-400 (NOT green) for both heatmap polarization and iceberg coverage bands. This is the explicit carve-out:

- Saturated execution-green (`#3fb950`) and execution-red (`#f85149`) are still reserved for trade-execution markers ONLY.
- Pink-400 (`rgb(248, 113, 113)`) and sky-400 (`rgb(56, 189, 248)`) are the polarization palette for **liquidity context** (heatmap + iceberg bands + wall markers). These never mark executions and are visually distinct enough from saturated red/green that operator confusion is minimal.

Update `apps/dashboard_ui/src/styles.css` comment block at the top of the chart-color section to document this carve-out for future reviewers.

## Hard invariants

- **UI-only.** Path scope: `apps/dashboard_ui/src/chart/` and `apps/dashboard_ui/src/styles.css`. NO contract change, NO backend touch, NO detector change, NO capture/probe/scheduler/.env change.
- **Autoscale re-entrancy preserved.** Per [[lightweight-charts-autoscale-reentrancy]]: any new primitive returns `null` from `autoscaleInfo()`. Wall markers use the existing `createPriceLine` API which is layout-only, not a primitive — avoids the problem entirely.
- **No `Math.min(...arr)` / `Math.max(...arr)` spread patterns.** Per [[math-minmax-spread-antipattern]]: grep `Math\.(min|max)\(\.\.\.` over the diff before shipping.
- **Persistence accumulator from RA-107 stays untouched.** This ticket consumes its state; it does not modify the math.
- **Surgical path-scoped commit.** Stage only the changed chart files + styles.css. Verify staging with `git diff --cached --name-only` before commit. The dirty worktree pattern (operator_console, probe, etc.) must not be bundled.

## Pre-build sweep gate

Sweep must cover:

1. **Mid-source for per-cell side derivation** — confirm that `DepthHistoryColumn.mid` is reliably non-null in live data. If it's null in a non-trivial fraction of frames, propose a fallback (e.g., use prior column's mid, or last-known mid). Show the live-data null-rate from a 5-min sample.
2. **Color contrast at low intensity** — at low persistence scores, the pink-400 and sky-400 fills will paint at low alpha (~0.15-0.30). Verify visual distinguishability on the live shell's dark background. Codex should A/B the two on a test render and confirm operator-readability before locking the colors.
3. **Top-N choice + threshold** — N=3 is the coordinator default. Codex's sweep should confirm: (a) is N configurable via a constant, (b) is there a minimum persistence threshold below which a level isn't marked even if it's top-N (e.g., score < 100 = noise, no marker).
4. **Wall marker title formatting** — `wall ask 30525.00 (p4823)` is the proposal. Confirm operator-readability + price formatting matches `formatMnqPrice` discipline. Update if 4-decimal format is too wide for the lightweight-charts marker title gutter.
5. **Quality modulation preservation** — confirm `stale_l1` and `inferred` quality still darken/desaturate within the polarized hue, not switching to amber/yellow.
6. **Confirmation no contract / backend / detector / capture / probe touch.**

## Acceptance

- Before/after side-by-side screenshots of the heatmap during a live session. After image shows clear pink-above-mid + sky-below-mid bands. Acceptance is operator-readable, not numeric.
- Iceberg coverage bands visibly different between ask and bid in the live shell.
- Top-3 wall markers render as thin dashed horizontal lines at the most persistent levels with side-colored titles.
- vitest passes (new + modified tests).
- tsc / lint / build clean.
- Codex's grep for `Math\.(min|max)\(\.\.\.` over the diff returns zero matches (per the memory rule).
- `apps/dashboard_ui/src/styles.css` carve-out comment block updated.
- Commit is path-scoped to `apps/dashboard_ui/src/chart/` + `apps/dashboard_ui/src/styles.css` only. No bundled probe/operator_console/strategy_runtime dirt.

## Coordinator review focus

The headline is the **side-polarized heatmap** in the after-screenshot. The two questions I'll ask:

1. Can I instantly identify ask-side vs bid-side bands at first glance, or do I have to look at the price scale to decide which side is which?
2. When an iceberg band appears, does it immediately read as "sellers defending the ceiling" or "buyers defending the floor" without reading a label?

If both are yes, RA-107a is shipped.

The wall markers are an additional convenience — secondary acceptance. If they clutter the chart at default N=3, demote to N=2 in the ship.

## Priority

Sequential after RA-107 (shipped). Independent of RA-094 (gated on RA-093b report) and RA-109 (perf profile). Codex can pick up immediately. Estimated 0.5-1 day.

## Future option (out of scope; for the operator)

- **RA-107b** — operator-configurable color palette. Some operators prefer Bookmap's blue/red rather than pink/sky. A theming config could make this swappable. Hold until first version is in operator hands.
- **RA-107c** — wall-marker fade as persistence decays. Currently top-N walls re-evaluate per frame; if a level drops out, its line is removed. A gentler animation (fade out over ~5s) would feel more polished. Hold.
- **RA-108** — discrete walls-feed signal family. Emit `WallDetectedPayload` on the wire when persistence_score crosses a threshold. Operator gets the wall in the LiveFeed alongside the chart marker. Contract addition; defer until RA-094 lands.
