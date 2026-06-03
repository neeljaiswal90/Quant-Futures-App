# Dashboard rendering baseline (P1 + P2)

**Date:** 2026-06-03
**Purpose:** ground the "use the RTX 4080 more" performance work in what's actually limiting throughput today.
**Status:** code-level audit only — runtime measurement still needed (see "What's missing" below).

---

## Stack as built today

| Layer | Tech | Notes |
|---|---|---|
| Desktop wrapper | Tauri 2 | `apps/dashboard_shell/`. WebView2 (Chromium-based). No GPU/perf flags set in `tauri.conf.json`. |
| UI framework | React 18 + Vite 6 | `apps/dashboard_ui/`. No React Compiler / forgetti yet. |
| Chart library | **lightweight-charts 5.2.0** | **Canvas2D-only.** No WebGL backend exists for this library. |
| Custom primitives | Custom `ISeriesPrimitive` impls | Drawn via Lightweight Charts' `CanvasRenderingTarget2D` — also Canvas2D. |
| WS / state | Custom `useRealtime` + reducer at `src/store/reducer.ts` (307 lines) | No throttle/debounce/RAF batching in export list — WS messages dispatch synchronously through React state. |

**Implication:** the entire visual layer is Canvas2D. WebView2's Chromium IS GPU-accelerated for Canvas2D, but only at the rasterizer level (the GPU draws the bitmap; CPU still issues each `fillRect`). High-primitive-count workloads are CPU-bound on the issue path, not GPU-bound. **The RTX 4080 is almost certainly idle today even when the dashboard appears to struggle.**

---

## Renderer ranking (heaviest first)

Sorted by code size as a proxy for complexity + per-frame cost; cross-checked against per-frame draw count where the code makes it explicit.

| # | Renderer | LOC | Per-frame cost shape | Why it's expensive |
|---|---|---|---|---|
| 1 | **`depthHeatmap.ts`** | 899 | up to 75,000 fillRect/frame (capped) | RA-100 Bookmap-parity. Each visible time-column × price-tick cell is a quantized-color rect. Already optimized to the limit Canvas2D allows: color quantized to 24 buckets, vertical culling, newest→oldest budget protection, time-width cap. The 24-bucket batching reduces `fillStyle` switches to ≤48 per frame, but still issues ~75k `fillRect` calls. |
| 2 | `eventBubbles.ts` | 622 | dozens of bubbles, hit-test per render | Signal markers (sweep, absorption, iceberg, microprice flips). Complex hit testing + label rendering. |
| 3 | `candles.ts` | 389 | viewport candles | Standard OHLC + volume coloring. Mostly delegated to Lightweight Charts core. |
| 4 | `tradeBubbles.ts` | 307 | one bubble per trade, capped | RA-100 separate from eventBubbles. Green/red trade bubbles by aggressor. |
| 5 | `sigmaShelves.ts` | 225 | small constant per pane | σ v2 shelves above VAH / below VAL + oversized-move bands. 10% opacity rectangles. Cheap. |
| 6 | `cvdDirection.ts` | 203 | small constant | CVD direction arrow + flip markers. |
| 7 | `persistentLevels.ts` | 202 | dozens of horizontal lines | VWAP, VAH/VAL/VPOC/HVN/LVN reference lines. |
| 8 | `wallMarkers.ts` | 142 | dozens | Bookmap wall annotations. |
| 9 | `depthPersistence.ts` | 122 | compute, not render | EWMA persistence accumulator. Pure compute on main thread. |

**The clear bottleneck is #1 (depth heatmap).** Items 2–9 combined are <2k LOC and most are constant-cost per frame.

---

## Code-level perf antipatterns already known (from memory)

These don't show up in current code — they were caught and fixed — but worth confirming the fixes didn't regress:

| Antipattern | Memory note | Status |
|---|---|---|
| `Math.min(...arr)` blowing V8 stack in WebView2 | `feedback_math_minmax_spread_antipattern.md` | Fixed; grep `Math\.(min\|max)\(\.\.\.` should return empty in chart/ |
| Lightweight-charts autoscale re-entrancy via `priceToCoordinate` | `feedback_lightweight_charts_autoscale_reentrancy.md` | Fixed; primitives return null from autoscaleInfo |
| V8 512MB string cap on JSONL reads | `feedback_v8_512mb_string_cap.md` | Backend-side; not in dashboard UI |

---

## What I'd expect to find if I could measure (instrumentation gap)

I can't run a profiler from this context, so the following are educated guesses that need runtime confirmation:

| Hypothesis | How to confirm |
|---|---|
| GPU utilization on the 4080 is <10% during dashboard idle, <30% during heavy depth bursts | Task Manager → Performance → GPU 0 (3D + Compute) while dashboard runs through a heavy moment |
| Main-thread JS frame time during depth bursts is 15–40ms (dropping to ~25 FPS during bursts) | DevTools Performance panel while a depth update lands |
| Most of that frame time is `CanvasRenderingContext2D.fillRect` calls | DevTools Performance bottom-up by function |
| The reducer dispatches per-WS-message; React re-renders the chart subtree every dispatch | React DevTools Profiler |
| WS message rate sustained: 6–10 Hz with sub-millisecond payload parse | Browser DevTools Network → WS frames |

If those guesses are roughly right, the bottleneck story is: **CPU-bound Canvas2D issue path during depth bursts, with React render storm amplifying the cost.** The 4080 sits idle because nothing currently asks it to do parallel work.

---

## Why "more 4080" doesn't have a simple knob

**WebView2 is Chromium.** Chromium's Canvas2D goes through Skia → ANGLE (D3D11) → GPU. The GPU rasterizes the final bitmap, but the path from `ctx.fillRect(x, y, w, h)` to a draw call is:

1. JS engine validates args (CPU)
2. Skia builds a draw command (CPU)
3. Command goes into a queue (CPU)
4. Commands batched + uploaded to GPU (CPU → GPU transfer)
5. GPU rasterizes (parallel, fast)

For 75k rects, steps 1–4 dominate. The 4080 sits >99% idle waiting for the CPU to feed it. **The only way to use the 4080 meaningfully is to issue fewer, larger draw calls via WebGL or WebGPU**, where N=75,000 instances becomes ONE draw call with a per-instance attribute buffer.

That's a rendering-architecture change, not a config flag.

---

## What's missing — runtime measurement to land before P3

To convert these hypotheses into evidence:

1. **Quick win: visual FPS/frame-time overlay in the dashboard UI itself.** Add a `<PerfOverlay>` component that displays:
   - frame time (`performance.now()` between RAFs)
   - canvas draw count per frame (instrument `fillRect` etc.)
   - WS message rate
   - React re-render count

   This is ~2h of work and gives a permanent on-screen baseline. Pairs well with reading Task Manager GPU usage side-by-side.

2. **Performance Monitor capture during a known-heavy moment.** Open Windows Task Manager → GPU. Watch the 4080 row during a depth burst. If it's >50% during the burst, the bottleneck is somewhere else than what I'm predicting. If it's <20% (likely), the diagnosis holds.

3. **One-shot DevTools profile.** F12 in the WebView2 (if dev-tools are enabled in the Tauri config — they may not be in release builds). Performance tab → record 5 seconds → review.

The proposal in P3 doesn't strictly need these to pick a direction — but they'd refine effort estimates significantly.
