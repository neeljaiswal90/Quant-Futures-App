# Option D — WebGPU dashboard rendering plan

**Date:** 2026-06-03
**Decision:** approved 2026-06-03 — proceed with WebGPU as the dashboard's primary rendering path. Goals are both **higher performance** (4080 actually utilized) and **richer visuals** (shader effects, animations, blur, gradients).
**Companion docs:** `dashboard-rendering-baseline.md` (current state), `dashboard-upgrade-options.md` (why D vs A-C-E).

> **The shift this represents.** We are moving from a chart that's optimized to draw boring rectangles fast → to a chart whose visual style is itself a competitive advantage. This is a strategic decision, not a tactical fix.

---

## Tech direction — three sub-options inside D

The proposal doc called Option D "full WebGPU rewrite" — that's actually three different commitments. Pick one before any code lands.

### D-Hybrid (Recommended starting point) — WebGPU layer + Lightweight Charts candles

- Keep Lightweight Charts for candle rendering, time axis, price axis (mature, well-tested, free)
- Add a WebGPU canvas layered above it for: depth heatmap, σ shelves, bubbles, markers, ANY custom shader effects, blur passes, animations
- Lightweight Charts and the WebGPU canvas synchronized via the same `subscribeVisibleTimeRangeChange` + `priceToCoordinate` APIs that already work for Canvas2D primitives
- Iteration timeline: meaningful improvement in 1 week; full feature set in 3–4 weeks
- Risk: lowest. Existing chart keeps working if WebGPU init fails (graceful fallback)
- Tradeoff: we don't get WebGPU rendering for candles themselves (LC stays Canvas2D for them)

### D-Custom — full custom WebGPU chart

- Replace Lightweight Charts entirely. Every element rendered via WebGPU.
- Compute shaders for contrast normalization, hit testing, viewport projection
- Iteration timeline: 5–6 weeks before feature parity with current chart
- Risk: high. Big maintenance surface; lose LC's accumulated edge cases (timezone handling, locale-aware axis labels, tick formatting, etc.)
- Tradeoff: maximum performance ceiling; maximum visual flexibility; we own every pixel

### D-via-Library — use deck.gl or three.js WebGPURenderer

- Leverage existing WebGPU abstractions
- **deck.gl** is data-viz focused; great for instanced primitives; geo-bias though
- **three.js** has experimental WebGPURenderer; 3D-bias but capable
- **PixiJS v8** has WebGPU support; 2D-focused, closest cultural fit
- Iteration timeline: 2–3 weeks via PixiJS v8, others uncertain
- Risk: bet on library's WebGPU maturity (most are 2024-era; still rough edges)
- Tradeoff: faster start, less control

**My strong recommendation: D-Hybrid.** Reasons:
1. Ships first value in 1 week (depth heatmap to WebGPU) — same as Option A would have, but on the path to D
2. Risk is contained — Canvas2D fallback always available
3. Doesn't throw away Lightweight Charts' battle-tested candle rendering
4. The hybrid IS the architecture even D-Custom would converge to once you realize "wait, I just rewrote ohlc rendering for the third time" — better to recognize that up front
5. Visual richness goal doesn't actually require candles to be WebGPU — all the rich-visual real estate is in the OVERLAY (heatmap, bubbles, signal effects, transitions)

---

## Phased implementation (D-Hybrid)

Each phase ships independently. User-facing wins compound. Total ~4–5 weeks for the full set.

### Phase 1 — WebGPU foundation + depth heatmap (week 1)

**Goal:** prove the architecture works and ship the biggest single perf win.

- Set up WebGPU adapter + device + canvas with proper resize handling
- Build a tiny shader infra: vertex + fragment shader pair for instanced colored rectangles
- Port the depth heatmap to WebGPU:
  - One instanced draw call for all 75k cells per frame
  - Per-instance attributes: time/price position, dimensions, intensity, side (bid/ask)
  - Color computed in fragment shader (no JS-side quantization needed any more — GPU handles the spectrum natively)
- Wire the WebGPU canvas to Lightweight Charts' coordinate system (subscribeVisibleTimeRangeChange + priceToCoordinate)
- Build the runtime feature-flag: `?renderer=webgpu` query param OR config setting. Default Canvas2D until shipped.
- WebGPU initialization fallback: if `navigator.gpu` is undefined or device acquisition fails, log + fall back to Canvas2D
- **Acceptance:** depth heatmap renders identically to Canvas2D version. Frame time during bursts: 15–40ms → <2ms. 4080 GPU usage rises measurably.

**Files added:**
- `apps/dashboard_ui/src/chart/gpu/context.ts` — adapter/device/canvas lifecycle
- `apps/dashboard_ui/src/chart/gpu/shaders/depthHeatmap.wgsl` — shader source
- `apps/dashboard_ui/src/chart/gpu/depthHeatmapGPU.ts` — pipeline + draw
- `apps/dashboard_ui/src/chart/gpu/coordinateSync.ts` — LC integration

**Files modified:**
- `useDepthHeatmap.ts` — backend picker (Canvas2D vs WebGPU)
- `PriceChart.tsx` — mount WebGPU canvas overlay if enabled

**Existing files preserved as fallback:** `depthHeatmap.ts`.

### Phase 2 — Visual richness pass 1: smooth transitions + heatmap blur (week 2)

**Goal:** introduce the visual upgrades that make the dashboard FEEL premium.

- **Temporal smoothing**: depth cells fade in/out over 250ms instead of popping; intensity transitions are interpolated in the shader rather than per-frame in JS
- **Bloom/blur pass on bright walls**: a second render target captures cells above a brightness threshold and Gaussian-blurs them; composited back with the main heatmap. Strong walls now visually "glow."
- **Gradient between bid/ask sides**: at the midprice, render a subtle gradient transition rather than a hard color boundary
- **Animated price-line pulse on new trades**: a soft ripple effect emanates from the latest trade price for ~500ms after each trade

**Acceptance:** these features are tunable from a debug panel (intensity, blur radius, animation speed). User reviews and signs off on each before they become defaults.

### Phase 3 — σ shelves + reference lines + bubbles to WebGPU (week 2.5)

**Goal:** port the remaining custom primitives so the entire overlay is one render pass.

- σ shelves: instanced semi-transparent rectangles, gradient fills, optional shimmer effect for actively-touched zones
- Reference lines (VAH/VAL/VPOC/HVN/LVN/VWAP): line primitives in WebGPU; thicker/glow on hover
- Event bubbles + trade bubbles: textured-quad instanced rendering with SDF text for labels (sharp at any zoom)

**Acceptance:** the entire dashboard overlay renders in one WebGPU pass (depth + shelves + lines + bubbles). Total frame time <3ms on RTX 4080.

### Phase 4 — Compute shader: contrast normalization on GPU (week 3)

**Goal:** move the rolling-percentile contrast computation off the CPU.

- Currently `depthPersistence.ts` runs a JS loop over the last 10 minutes of cells to compute p35 (dark floor) and p95 (bright ceiling)
- Move this to a compute shader: input is a buffer of intensities, output is two floats (the percentiles)
- Reduces CPU work by O(N) per frame where N = cells in the rolling window (often 100k+)

**Acceptance:** the `DEPTH_CONTRAST_PERCENTILE` and `DEPTH_CONTRAST_BRIGHT_PERCENTILE` calculations no longer appear in CPU profile.

### Phase 5 — Candles to WebGPU? Decision point. (week 3.5)

**Goal:** evaluate whether replacing Lightweight Charts is worth it now or ever.

- By this phase we have ~4 weeks of WebGPU experience and a working overlay
- Honest assessment: is LC's candle rendering blocking ANY user-facing improvement we want? Probably not — candles look fine
- IF we want to ship time-axis features LC doesn't support (e.g. custom session-aware tick labels with shader-rendered glyphs), we revisit
- Otherwise, KEEP LC for candles and call Phase 4 the end of the core port

### Phase 6 — Polish + acceptance (week 4)

- Hit-testing for all WebGPU primitives (depth cell hover, bubble click, etc.) via ray-casting against the underlying data model — not pixel-pick (cheap, exact)
- Accessibility: keyboard navigation between elements still works
- Performance overlay (the FPS / GPU / draw-count thing from baseline doc) becomes the way we verify regressions
- High-DPI display testing: WebGPU canvas must match LC's DPR
- Driver compatibility matrix: Intel iGPU, NVIDIA GTX 1xxx-onwards, AMD RX 6xxx-onwards (the trader's 4080 is the primary target but a fallback works on everything)

---

## Visual richness — what's actually in scope

The "richer visuals" goal needs scoping. Here are concrete additions WebGPU enables that Canvas2D either can't do or can't do without ruinous cost:

| Feature | Difficulty | Per-frame cost | Value |
|---|---|---|---|
| Bloom/glow on bright depth walls | medium | <0.5ms (2-pass blur) | High — instantly readable |
| Smooth fade-in/out of depth cells (temporal interpolation) | low | negligible | High — eliminates pop-in jank |
| Animated trade-price ripple on each new trade | low | negligible | Medium — feedback for tape activity |
| Gradient mid-price band | low | negligible | Medium — clarifies bid/ask transition |
| Signal markers with shader-rendered glow + pulse | medium | <0.2ms | High — important signals visually shout |
| σ shelf "shimmer" when actively touched | medium | <0.1ms | Medium — touch confirmation |
| Soft drop shadows on bubbles | low | <0.1ms | Low — pure aesthetic |
| Volume profile rendered as a heatmap fade (left edge) | medium | <0.3ms | High — adds context at no clutter cost |
| Animated zoom/pan transitions | low | inherits frame rate | High — feel premium |
| Particle effects on critical signals (sweep_detected, etc.) | high | <0.5ms | Low — risk of looking gimmicky |
| Theme system: light/dark/custom shader-tuned palettes | low | negligible | Medium |

**Recommendation:** ship the High-value items in Phase 2–3. Defer Low-value aesthetic items unless you specifically want them. Particle effects: hard veto from me — financial dashboards reading "serious" matters; particles read "game."

User picks which features land in the first richness pass.

---

## Risks specific to D

| Risk | Likelihood | Mitigation |
|---|---|---|
| WebView2 WebGPU support varies by Edge version | Medium | Tauri 2.x bundles modern WebView2; we'll pin a minimum WebView2 version in the Tauri config. Smoke at start of Phase 1. |
| WebGPU adapter request can fail on first launch (driver state) | Medium | Always have Canvas2D fallback. Log adapter init failures to a structured backend log. |
| Synchronization with LC's coordinate system has edge cases (DPR change, axis re-flow, auto-fit) | High | Test matrix: 100% DPI, 125% DPI, 150% DPI, 200% DPI; manual zoom; auto-fit; symbol changes |
| 4080 driver issues during heavy compute + rasterization | Low | Use WGSL spec-correct shaders; avoid extensions; standard pipeline state objects |
| Maintenance burden grows as we add shader features | Real | Document each shader thoroughly; keep effects toggleable; no Phase 5 (full candle replacement) unless absolutely needed |
| Repo-split timing — these files all land dashboard-side | Zero | This work lives in `apps/dashboard_ui/`; flows into `Quant-Futures-Dashboard` via filter-repo Saturday. |

---

## Concrete first step (if approved)

Phase 1, day 1: write `apps/dashboard_ui/src/chart/gpu/context.ts` — the WebGPU adapter/device/canvas lifecycle. This is the smallest piece that proves WebGPU works in your Tauri WebView2 at all. If `navigator.gpu` returns undefined or device acquisition fails on your machine, the rest of D doesn't apply — we'd need to upgrade WebView2 or pivot to Option A (WebGL).

I'd want to do this AFTER the 13:06 PT MBP1 repair task fires and the 13:10 PT EoS pipeline completes, so the live system is in a known-good state when I start touching the dashboard. That puts coding start at ~14:00 PT today.

Before I start, three calls only you can make.
