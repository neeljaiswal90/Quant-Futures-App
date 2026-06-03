# Dashboard perf upgrade options (P3)

**Date:** 2026-06-03
**Status:** five concrete options ranked by effort × payoff. User picks which to ship.
**Companion doc:** `dashboard-rendering-baseline.md` for what's measured today.

---

## The core diagnosis

The current dashboard is Canvas2D-only. Canvas2D in Chromium is GPU-accelerated at the rasterizer level, but the CPU still issues every primitive draw call individually. The depth heatmap can issue up to **75,000 `fillRect` calls per frame** — that's pure CPU cost, and the RTX 4080 sits idle waiting for work.

**To use the 4080, we need to either:**
1. Replace Canvas2D with WebGL or WebGPU on the heaviest renderers, where N primitives become 1 instanced draw call, or
2. Reduce the work the CPU is doing on every frame (offload to workers, throttle React renders, defer non-critical updates).

Most upgrade plans combine both. Here are the five real options.

---

## Option A — WebGL overlay for depth heatmap

**The 80/20 win.** Add a transparent WebGL `<canvas>` element layered over the Lightweight Charts canvas. The WebGL canvas renders ONLY the depth heatmap as a single instanced draw call. Lightweight Charts continues to render candles, price line, σ shelves, bubbles, etc., on its Canvas2D canvas underneath.

**Architecture:**
```
┌───────────────────────────────────────┐
│   WebGL canvas (transparent)          │  ← depth heatmap (1 draw call, ~50k instances)
├───────────────────────────────────────┤
│   Lightweight Charts Canvas2D          │  ← candles, σ shelves, bubbles, lines
└───────────────────────────────────────┘
   Both synchronized via Lightweight Charts' timeScale + priceScale APIs.
```

**Expected user-visible improvement:**
- Frame time during depth bursts: 15–40ms → <5ms
- Sustained 60 FPS even with full 75k-cell load
- 4080 GPU usage during bursts: <5% → ~10–20% (instanced rendering is cheap; the 4080 is overkill for this workload but it's WORKING for us)
- Visually identical output

**Effort:** ~3–5 days
- 1 day: WebGL skeleton, instanced rect shader, color buffer plumbing
- 1 day: wire to depth heatmap data model (`depthPersistence` already produces a flat cell list)
- 1 day: viewport sync with Lightweight Charts (timeScale subscribe, priceScale projection)
- 1 day: pan/zoom coordination + hit-test integration
- 1 day: contrast normalization on GPU (move the `DEPTH_INTENSITY_POWER` pow + percentile lookup into the shader)

**Risk:**
- Synchronization edge cases: when Lightweight Charts re-flows the time axis (auto-fit, fit-content), the overlay must follow. Lightweight Charts v5 exposes `subscribeVisibleTimeRangeChange` and `subscribeVisibleLogicalRangeChange` for this.
- Pixel-perfect alignment under DPR changes (high-DPI displays).
- 4080-or-bust: if the user's GPU drivers misbehave, fallback to existing Canvas2D path needed.

**What ships:**
- New: `apps/dashboard_ui/src/chart/depthHeatmapGL.ts` (WebGL renderer)
- New: `apps/dashboard_ui/src/chart/glContext.ts` (shared WebGL context + capability detect)
- Modified: `useDepthHeatmap.ts` to pick GL vs Canvas2D backend at runtime
- Existing `depthHeatmap.ts` kept as fallback

---

## Option B — Web Workers for depth processing

**The CPU-relief win.** Move the depth processing pipeline (`depthPersistence.ts` EWMA accumulator, rolling-percentile contrast normalization, cell projection) off the main thread into a Web Worker. Main thread receives a flat `Float32Array` of cell positions + intensities per frame and renders.

**Expected user-visible improvement:**
- Main thread frees up ~30–50% of frame budget during depth bursts
- UI interactions (panning, hover, button clicks) stay snappy even during heavy data
- 4080 unaffected — this is a CPU-relief change, not a rendering change

**Effort:** ~3–5 days
- 1 day: worker scaffolding, Comlink or postMessage protocol
- 1 day: serialize `DepthPersistenceAccumulator` to worker-side state
- 1 day: transfer cell-projection output via `Transferable` `ArrayBuffer`
- 1 day: backpressure handling (worker can fall behind WS rate; need drop policy)
- 1 day: integration tests + degraded-state handling

**Risk:**
- Worker state lag during reconnect / cold-start hydration sequence — needs careful handshaking with the backend backfill REST endpoint.
- `Transferable` semantics: zero-copy buffer transfer can confuse React renders if the buffer is re-used.

**Composes with Option A** — the worker emits the cell buffer, the WebGL renderer consumes it.

---

## Option C — RAF batching + React render-storm fix

**The cheapest pure-CPU win.** The current reducer dispatches per-WS-message. At 6–10 Hz that's tolerable; at 30+ Hz (which we'll hit if backend cadence increases or during reconnect backlog flush) it's a render storm.

**Changes:**
- Wrap WS message dispatch in a `requestAnimationFrame`-aligned batcher. Multiple messages between RAFs collapse to one state update.
- Audit which components subscribe to which slices of state; memoize aggressively.
- Possibly: split the chart-state slice from the panel-state slice so chart re-renders don't trigger panel re-renders.

**Expected user-visible improvement:**
- Smoother behavior during reconnects (the cold-replay burst from backend backfill currently can stall the UI for 1–2s)
- More consistent frame rate (eliminates spikes)
- Net "feels snappier" — not a single big win but a smoothness improvement everywhere

**Effort:** ~2–4 days
- 1 day: RAF batcher prototype + integration
- 1 day: state-slice refactor (potentially Zustand or Redux Toolkit if currently using bespoke reducer)
- 1 day: React Profiler-guided memoization pass
- 1 day: test under simulated load

**Risk:** Low. Mostly mechanical. Worst case: subtle ordering changes if some state updates expect to be observed in WS-arrival order.

**Composes with A and B.**

---

## Option D — Full WebGPU rendering pipeline

**The long-term ambitious play.** Replace Lightweight Charts entirely with a custom WebGPU rendering stack. All chart elements (candles, depth heatmap, primitives) become GPU pipelines. Compute shaders handle percentile normalization, intensity mapping, hit-testing.

**Why this is interesting:**
- Modern WebView2 (bundled with Edge ≥113, which Tauri 2.x typically uses) supports WebGPU
- Compute shaders mean the rolling percentile contrast normalization runs on the 4080 in <0.1ms instead of CPU O(N log N)
- All rendering becomes one or two pipeline executions per frame
- This is the literal use-case for a 4080 — parallel compute + parallel rasterization

**Expected user-visible improvement:**
- 4080 actually used: 20–40% utilization during heavy bursts
- Frame time on heaviest workloads <3ms
- Sustained 144 Hz capable (if monitor supports it)
- Headroom for far richer visuals (heatmap blur passes, depth-of-field on signal markers, animated transitions)

**Effort:** ~3–6 weeks
- Week 1: WebGPU context, shader infra, basic primitive (rect with color)
- Week 2: candle pipeline (instanced + custom blending)
- Week 3: depth heatmap pipeline + compute pass for contrast
- Week 4: σ shelves + bubbles + markers + reference lines
- Week 5: WS state → GPU buffer plumbing
- Week 6: hit-testing, hover, panning, zoom, polish

**Risk:**
- WebGPU is still "new" — driver bugs, especially in Tauri's bundled WebView2 vs system WebView2
- Custom chart = huge maintenance surface vs Lightweight Charts which gives candles + scales for free
- Need a Canvas2D fallback path for the cases where WebGPU initialization fails (it does happen)

**This is a strategic bet, not a tactical fix.** Worth doing only if (a) the dashboard's long-term roadmap involves significantly richer visuals or (b) we hit a wall that A+B+C can't solve.

---

## Option E — Native Tauri pane with wgpu

**The maximum-perf, maximum-pain play.** Render the chart pane using Rust's `wgpu` directly to a native window pane, with HTML overlay for controls.

**Why this is on the list:**
- Eliminates the WebView2 ↔ GPU translation layer entirely
- Tauri allows mixed native + web UI in the same window
- Direct D3D12 (or Vulkan) access to the 4080

**Why it probably isn't worth it:**
- Massive complexity for marginal gain over Option D
- We give up all the React tooling for the chart pane
- Hit-test sync between Rust pane and JS overlay is hairy
- Effort: ~6–10 weeks

**Listed for completeness. Recommend skipping unless D somehow doesn't suffice.**

---

## Recommendation

**Ship A + C in series, B opportunistically.** Skip D and E for now.

| Phase | Option | Effort | Why this order |
|---|---|---|---|
| 1 | **A** (WebGL depth heatmap) | 3–5 days | Biggest single user-visible win. Frame time during bursts drops to <5ms. The 4080 starts doing work. Most contained risk: one renderer, one new file, existing Canvas2D path remains as fallback. |
| 2 | **C** (RAF batching + render-storm fix) | 2–4 days | Smooths out the cases where the issue is React, not Canvas. Pairs naturally with A — fixes the "WS burst feels janky" cases A alone won't help. |
| 3 | **B** (Web Worker for depth processing) | 3–5 days | Final CPU-relief layer. Frees main thread for everything else. Composes cleanly with A (worker emits the cell buffer A renders). |
| Skip | D, E | weeks | Only revisit if user-visible perf still isn't where we want after A+B+C. |

**Total effort:** ~8–14 days of focused work for A+B+C.
**Expected aggregate user-visible improvement:** 60 → 144 FPS capable, no jank even during cold-reconnect backlog floods, 4080 actually getting workload.

---

## What I'd ask the user before starting

1. **What's the symptom that prompted "use the 4080 more"?** Concrete: scroll/pan jank? Slow updates during fast markets? Cold-reconnect freezes? Initial load? The answer changes which option to start with. (RAF batching helps reconnect-freeze; WebGL helps burst frame time; worker helps everything-else-stays-snappy.)
2. **What's the target frame rate?** Are we shooting for 60 Hz lock or going for 144 Hz? Determines whether C+A is enough or whether we need to push to D.
3. **Is the dashboard currently profilable in DevTools?** If the Tauri config has dev-tools enabled in release, I can ask you to grab a 5-second Performance trace during a heavy moment — would refine effort estimates by ~30%.
4. **Repo-split timing:** all this code lives in `apps/dashboard_ui/` and `apps/dashboard_shell/`, both of which are dashboard-side in the split. **Safe to land in the current monorepo now**; it'll flow into `Quant-Futures-Dashboard` naturally via `git filter-repo` on Saturday. No timing conflict.
