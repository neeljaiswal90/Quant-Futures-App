# Codex Dispatch — RA-111: chunked backfill hydration + cached projection

Coordinator dispatch from the RA-109 perf profile findings (commit `57f827e`). Read `v2_codex_handoff.md` for invariants. Pre-build sweep → green-light → build → verify → ship.

## Why this exists

RA-109 measured: cold `/api/bookmap-backfill` hydration took **1,646 ms** for 13,838 price ticks + 2,748 depth columns + 5.5 MB response. On the renderer thread, Scenario B accumulated **3,037 ms** of aggregate JS/task time and was the only scenario with long tasks (>50ms) — two of them. Live-burst (Scenario C) had zero long tasks. Steady-state (Scenario A) had zero long tasks.

The "dashboard feels slow" perception is the reload experience, not steady-state. CPU is 89-91% idle across all scenarios. Heatmap-specific functions account for 1.17-1.6% of CPU — confirming a WebGL rewrite is premature.

This ticket targets the actual bottleneck: the synchronous backfill replay path. Three optimizations identified in RA-109's recommendation:

1. **Chunked hydration with requestAnimationFrame yielding** — split the one-big-batch into 8-16 smaller chunks. Same total CPU but no single long task, and the chart shows partial state during hydration instead of a blank pane.
2. **Pre-dedupe depth/price rows before chart handoff** — lightweight-charts requires strictly-ascending unique time values for setData; it internally dedupes when input violates that. Doing it ourselves with a Map keyed by `time` is cheaper than letting the library do it post-hoc.
3. **Cache projected visible ranges** — `priceToCoordinate` and `timeToCoordinate` calls per cell per frame dominate the projection work. Cache the projected coords keyed by visible range; only invalidate when the visible range changes.

Estimated combined gain: **400-900 ms perceived reload improvement** + smoother live update path (fewer per-tick coordinate computations).

UI-only. No contract change. No backend touch.

## Build

### 1. Chunked hydration in `PriceChart.tsx`

The current hydration path in `apps/dashboard_ui/src/chart/PriceChart.tsx` (line 175-262, the RAF loop) processes the entire backfill response in one synchronous block when `bookmapBackfillEpoch` changes:

```typescript
const seeded = aggregator.seedFromHistory(backfill.price_ticks.map(...));
priceLine.setData(seeded.prices);
volumeRef.setData(seeded.volumes);  // or two volume series after RA-107b
cvdRef.setData(seeded.cvd);
tradeBubbleRef.setHistory(backfill.price_ticks.map(...));
// And separately, depthHeatmapPrimitive.setHistory(backfill.depth) via useDepthHeatmap
```

Replace with a chunked processor:

- Constants: `HYDRATION_CHUNK_SIZE = 1000` (price ticks per chunk), `HYDRATION_DEPTH_CHUNK_SIZE = 200` (depth columns per chunk). Configurable.
- Algorithm:
  1. On `bookmapBackfillEpoch` change, capture a snapshot of the backfill arrays.
  2. Compute total chunks needed: `Math.ceil(price_ticks.length / HYDRATION_CHUNK_SIZE)` + `Math.ceil(depth.length / HYDRATION_DEPTH_CHUNK_SIZE)`.
  3. Start a chunked-processing state machine:
     - First chunk: clear all chart series + reset the persistence accumulator (depthHeatmapPrimitive `clear()` analog).
     - Each subsequent chunk: ingest `HYDRATION_CHUNK_SIZE` ticks through `aggregator.ingest()`, accumulate the resulting bars/cvd into the chart via `update()` (NOT `setData` again — incremental append).
     - After each chunk: `requestAnimationFrame(processNextChunk)` to yield.
  4. Same for depth: process `HYDRATION_DEPTH_CHUNK_SIZE` depth columns through the persistence accumulator and append to the depth heatmap.
  5. On final chunk: mark hydration complete, switch to the live-update fast path.

Properties:
- **Same total CPU** as the one-batch path (no extra work).
- **No long task** — each chunk completes in <16ms (target 60fps yielding).
- **Progressive rendering** — operator sees the chart filling in instead of waiting blank.
- **Live updates** that arrive DURING hydration are buffered, then drained after hydration completes. NO live updates lost.

### 2. Pre-dedupe in `candles.ts` and `depthHeatmap.ts`

`apps/dashboard_ui/src/chart/candles.ts` `seedFromHistory()` currently:

```typescript
const ordered = [...ticks].filter(...).sort((a, b) => a.tsNs - b.tsNs);
// Then iterates `ordered` and emits prices/volumes/cvd
```

The output `prices.values()` may have multiple entries per `time` (multiple ticks within a 1s bucket — already handled by the Map dedupe at line 189). Confirm the Map approach holds; if so, no change needed here. Document the existing dedupe in a comment.

`apps/dashboard_ui/src/chart/depthHeatmap.ts` `DepthHeatmapPrimitive.setHistory()`:

```typescript
const last = this.columns.at(-1);
if (last && column.tsNs < last.tsNs) continue;
if (last && column.tsNs === last.tsNs) {
  this.columns[this.columns.length - 1] = column;
} else {
  this.columns.push(column);
}
```

This already dedupes per column. Verify. Add a test that asserts duplicate-tsNs payloads produce N=1 column, not N=2.

For `tradeBubbles.ts` `setHistory()`:

```typescript
this.byKey.clear();
for (const tick of ticks) this.byKey.set(tradeBubbleKey(tick), tick);
this.rebuildItems();
```

Already deduped via Map. Confirm.

The "pre-dedupe" work is largely a **verification + documentation** pass — the code already does this; we just need to confirm and lock it with tests so it stays correct.

### 3. Cached projection in `depthHeatmap.ts`

`projectDepthHeatmapCells()` calls `timeToCoordinate()` and `priceToCoordinate()` for every cell on every paint frame. For dense persistence-score columns × hundreds of cells × 4 paints/sec, this is a lot of synchronous coordinate-math calls into lightweight-charts.

Optimization: cache projection results keyed by visible-range tuple.

- New cache: `Map<rangeKey, ProjectedCoords>` where `rangeKey = '${visibleRange.from}|${visibleRange.to}'`.
- On each `projectDepthHeatmapCells()` invocation:
  - Compute `rangeKey` for the current visible range.
  - If cache hit: reuse projected (x, y, width, height) for unchanged cells.
  - If cache miss: project fresh, store in cache (bounded LRU at 16 entries — at most 16 distinct visible ranges in any session).
- Invalidate cache:
  - On visible range change (different `rangeKey`).
  - On the chart re-sizing (re-bind to new dimensions via `requestUpdate`).
  - On series detach (cache.clear() in `detached()`).

Properties:
- Cache hit rate is HIGH during steady-state — operator rarely pans the time axis at sub-second granularity.
- Cache miss falls back to current behavior — no regression risk.
- Bounded by N=16 ranges — memory bounded.

This optimization is the secondary perf win — RA-109's profile showed coordinate-projection calls as repeated but not dominant. Codex should land it as part of the same commit if cheap, but treat it as lower priority than chunked hydration.

### 4. Tests

`apps/dashboard_ui/src/chart/PriceChart.test.tsx` (new or extended):
- Fixture: feed a synthetic backfill response with N=5000 price ticks + N=1000 depth columns. Assert hydration completes via chunked processing (mock requestAnimationFrame, count invocations).
- Assert no single chunk processes >2000 items at once.
- Assert live WS updates received DURING hydration are buffered and drained after.

`apps/dashboard_ui/src/chart/depthHeatmap.test.ts` (extended):
- Existing tests should still pass without modification.
- Add: a fixture with two payloads at the same `tsNs` produces one column (dedupe regression guard).
- Add: cached projection — calling `projectDepthHeatmapCells()` twice with the same inputs and identical visible range returns identical results AND the second call exhibits fewer `priceToCoordinate` calls (via mock).

## Hard invariants

- **UI-only.** Path scope: `apps/dashboard_ui/src/chart/`. NO contract change, NO backend touch, NO detector change, NO capture/probe/scheduler/.env change.
- **No regression on live update path.** The chunked hydration must NOT slow down per-tick live updates (Scenario C is healthy; don't break it). After hydration completes, the per-tick path stays identical to current.
- **No data loss.** Live WS updates arriving during hydration are buffered, then drained. NEVER dropped.
- **Persistence accumulator semantics preserved.** RA-107's per-frame `update(levels, tsNs)` math is unchanged. Hydration replays chunks through the same accumulator path — bit-identical scores at the end of replay.
- **Autoscale re-entrancy preserved.** Per [[lightweight-charts-autoscale-reentrancy]].
- **No `Math.min(...arr)` spread patterns.** Per [[math-minmax-spread-antipattern]].
- **Surgical path-scoped commit.** Stage only `apps/dashboard_ui/src/chart/` files. Verify with `git diff --cached --name-only` before commit.

## Pre-build sweep gate

Sweep must cover:

1. **Chunk size proposal** — Codex picks `HYDRATION_CHUNK_SIZE` and `HYDRATION_DEPTH_CHUNK_SIZE` values based on actual measurement against the live shell. Default 1000 / 200 is the coordinator lean; show the wall-clock distribution of chunk-process times at the proposed sizes and confirm <16ms per chunk to stay under the long-task threshold.
2. **Live update buffering** — propose the queue shape. A simple unbounded array of WS messages received during hydration, drained in order after hydration completes. Confirm the queue size stays reasonable (live emission ~4 fps × ~1.6s hydration = ~6-7 buffered messages worst case).
3. **Persistence accumulator replay determinism** — chunked replay must produce bit-identical persistence scores vs the current one-batch replay. Show the unit-test fixture confirming this.
4. **Projection cache eviction policy** — bounded LRU at 16 entries OR clear-on-resize-only. Pick one; show the worst-case cache size during a 1-hour session.
5. **Confirmation no contract / backend / detector / capture / probe touch.**

## Acceptance

- Cold reload (Scenario B) reduces from ~1,646 ms to ~1,000-1,300 ms — measurable via the same RA-109 perf-profile harness re-run after RA-111 lands.
- ZERO long tasks (>50ms) during hydration in the new profile. (Currently 2 long tasks in Scenario B.)
- Scenario A (steady state) and Scenario C (live burst) latencies remain healthy (no regression).
- Operator-perceptible: chart fills in progressively during reload instead of blank-then-pop.
- vitest passes (extended chart tests).
- tsc / lint / build clean.
- Grep `Math\.(min|max)\(\.\.\.` over the diff returns zero matches.
- Commit is path-scoped to `apps/dashboard_ui/src/chart/` only.

## Coordinator review focus

Three measurements I'll ask for in the ship report:

1. Cold reload wall clock (before vs after) — measured with the same RA-109 harness.
2. Long-task count during hydration (target: 0).
3. Per-tick live update latency (target: no regression).

If all three are improved/preserved, RA-111 is shipped.

The chunked-hydration progressive render is the headline operator-visible improvement — a short screen recording (or sequence of screenshots) showing the chart filling in during reload would substantiate it.

## Priority

After RA-107a + RA-107b. Independent of RA-094 (gated on RA-093b report). 2-3 day estimated.

## Future option (out of scope; for the operator)

- **RA-111a** — backend-side compression of the `/api/bookmap-backfill` response. Currently 5.5 MB JSON. With gzip the same payload is ~600 KB. If REST transport time dominates AFTER RA-111's JS optimizations land, RA-111a adds server-side compression. Backend change, but trivial (add `Compression` middleware). Hold until the post-RA-111 profile shows it's needed.
- **RA-111b** — incremental backfill (request the LAST N seconds first, then progressively older). Operator sees the most recent state immediately and the older context fills in. Requires a contract change (paginate the backfill endpoint). Defer.
- **RA-111c** — service worker caching of the backfill response. Second reload within a short window reuses the cache. Hold; rarely needed in operator workflow.
