# Codex dispatch — Bookmap-parity trade-dot GPU pipeline (P9)

**Branch suggestion:** `feat/bookmap-trade-dots-01`
**Base:** `feat/ra067-realtime-contract` at `5fe62b3` or later
**Scope:** WebGPU pipeline for rendering live trade events as Bookmap-style dots overlaid on the depth heatmap, with size-by-volume and pulse-on-recent-trade animations.
**Estimated effort:** 3-5 days focused work.
**Parallelism:** This work is INDEPENDENT of the texture-heatmap integration (P8 Days 2-5, owned by the coordinator). You write a separate WebGPU layer that composites above the heatmap canvas. No merge conflicts expected on the GPU files; minor coordination on the dashboard hook layer.

---

## Context (read first, ~5 min)

This is one half of Path A — a 2-week effort to bring the MNQ dashboard's depth-heatmap rendering to Bookmap parity. Full architectural context:

1. **`docs/perf/path-a-bookmap-heatmap.md`** — the master plan. Read in full before starting. Particularly Section "What stays unchanged" and "What's NEW."
2. **`docs/perf/option-d-webgpu-plan.md`** — the prior WebGPU architecture decision. Explains why we're WebGPU + LC hybrid, not full custom chart.
3. **`docs/perf/dashboard-rendering-baseline.md`** — what the renderers were before WebGPU.

Your half (P9) is the **trade-dot GPU pipeline + signal-bubble hide**. The coordinator's half (P8 Days 2-5) is replacing the discrete-cell heatmap with the texture pipeline. The two halves are independent, but compose to deliver Bookmap parity together.

### What already exists (your foundations)

| File | Purpose | You should USE this |
|---|---|---|
| `apps/dashboard_ui/src/chart/gpu/context.ts` | Shared `GPUDevice` lifecycle. Acquires the 4080 adapter once; multiple renderers share. | `acquireGpu()` returns the shared context. Call from your `TradeDotsGPU.create()`. |
| `apps/dashboard_ui/src/chart/gpu/depthHeatmapGPU.ts` | Existing instanced-rendering pipeline (current heatmap). | **Use as a structural template** for your `tradeDotsGPU.ts`. Same shape: shader + pipeline + buffers + render(). |
| `apps/dashboard_ui/src/chart/gpu/depthHeatmapLayer.ts` | LC-aware overlay layer that owns an overlay canvas. | **Mirror this pattern** for trade dots. Your layer creates a SECOND overlay canvas, positioned above the heatmap's overlay, with `pointer-events: none` and `z-index: 2`. |
| `apps/dashboard_ui/src/chart/tradeBubbles.ts` | Existing Canvas2D primitive rendering trade bubbles. | **READ THIS FILE** to understand the data shape — what trade events look like, sizes, colors. You'll DISABLE this primitive's draw via the same backend-switch pattern, then render via WebGPU. |
| `apps/dashboard_ui/src/chart/eventBubbles.ts` | Existing Canvas2D event/signal marker primitive (sweep, absorption, etc.). | **Out of scope for this dispatch.** Signal bubbles get HIDDEN by default (feature flag) in your work; their GPU migration is a separate follow-up. |
| `apps/dashboard_ui/src/store/reducer.ts` | Redux-ish store with trade-event slice. | Your layer reads trades from here OR from the tradeBubbles primitive's column buffer — whichever is easier; both reflect the same data. |

### Naming + style conventions

- New file naming: lowercase, dot-separated for type (`tradeDots.ts`, `tradeDots.wgsl`).
- TypeScript: strict mode, `noUnusedLocals: true`, `verbatimModuleSyntax: true`. Match the existing GPU files.
- WGSL: 2-space indent, snake_case for struct fields, camelCase for function names. Match `depthHeatmap.wgsl` / `heatmapTexture.wgsl`.
- Comments: explain WHY, not WHAT. The existing GPU files are good references.
- Feature flag: `VITE_TRADE_DOTS_RENDERER=webgpu | canvas2d` (default `canvas2d` until you ship and the operator opts in).

### What "Bookmap parity for trade dots" means concretely

Look up Bookmap's trade-bubble rendering style (or ask the operator). Key visual properties:

| Property | Target |
|---|---|
| Shape | Filled circles (anti-aliased) — NOT squares, NOT outlined rings |
| Position | Exact (time, price) of the trade — pixel-accurate alignment with candles |
| Color | Green-ish for bid-aggressor (buyer), red-ish for ask-aggressor (seller). Tunable palette. |
| Size | Proportional to trade volume — log-scaled with sensible min (~3 px diameter) and max (~25 px diameter) clamps |
| Border | None by default (no rings). Optional subtle outer glow for trades above a size threshold. |
| Pulse on new trades | The most recent N trades (last ~500 ms) pulse via animated alpha + slight radius oscillation. Pulse decays smoothly to steady-state. |
| Density at high volume | Hundreds of trades per second should render without dropping frames (instanced draw, one call) |
| Layering | Above the depth heatmap, below the candles + signal markers + axes |

Currently the Canvas2D `tradeBubbles.ts` draws filled circles via `ctx.arc + fill`. Each bubble is a separate `arc + fill` call. At 100+ trades/sec sustained, that's 100+ canvas ops per frame on the main thread = visible jank. Your WebGPU pipeline replaces that with one instanced draw call regardless of count.

---

## Deliverables

### 1. WGSL shader: `apps/dashboard_ui/src/chart/gpu/tradeDots.wgsl`

Per-instance: time, price, color RGBA, size (radius in pixels), age (seconds since trade).

Vertex shader:
- Unit-quad expansion sized by per-instance `size` (in pixels).
- Convert quad position to NDC via camera uniform (time range + price range + canvas size).
- Compute pulse: `pulse = 1.0 + 0.3 * sin((1.0 - clamp(age/0.5, 0, 1)) * π)` — radius oscillation that decays to 1.0 over 500 ms.
- Pass UV (0..1 across the quad) and per-instance color to fragment.

Fragment shader:
- Compute distance from quad center via UV: `d = length(uv - 0.5)`
- SDF circle: `alpha = smoothstep(0.5, 0.5 - aa_width, d)` (anti-aliased disk)
- Pulse alpha modulation on recent trades: `alpha *= mix(0.4, 1.0, 1.0 - smoothstep(0, 0.5, age))` (recent trades extra-bright)
- Premultiplied alpha output

Camera UBO: same layout pattern as `depthHeatmap.wgsl` (time_range, price_range, canvas_size). 80 bytes; aligned.

### 2. Renderer class: `apps/dashboard_ui/src/chart/gpu/tradeDotsGPU.ts`

Mirror `DepthHeatmapGPU` from `depthHeatmapGPU.ts`:

```typescript
export const TRADE_DOT_MAX_INSTANCES = 10_000;  // 10k trades in history; tunable
export const TRADE_DOT_STRIDE_FLOATS = 8;        // time(1) price(1) color(4) size(1) age(1)

export class TradeDotsGPU {
  static async create(canvas: HTMLCanvasElement): Promise<TradeDotsGPU> { ... }
  setCamera(c: TradeCameraInputs): void { ... }
  setInstances(data: Float32Array): void { ... }
  render(): Promise<undefined> { ... }
  destroy(): void { ... }
  diagnostics(): { instances: number; vendor: string; architecture: string } { ... }
}
```

Pipeline: instanced triangle-strip (4 verts × N instances). Pre-multiplied alpha blending matching `depthHeatmapGPU.ts`.

### 3. LC-aware layer: `apps/dashboard_ui/src/chart/gpu/tradeDotsLayer.ts`

Mirror `DepthHeatmapGPULayer` from `depthHeatmapLayer.ts`:

- `attach(chart, series, primitive)` async factory.
- Creates a transparent overlay canvas as a sibling to the heatmap's overlay. **z-index: 2** (above heatmap z=1, below LC's z=2 candles — IMPORTANT for layering). `pointer-events: none`.
- RAF loop that reads from the trade primitive's data each frame, projects to instances, calls `renderer.render()`.
- Calls `syncOverlaySize()` each frame to track LC's `paneSize()` (same pattern as the heatmap layer).
- Reads trade events from `tradeBubbles` primitive's data buffer. You'll need to add a `getTrades(): readonly TradeEvent[]` accessor to `tradeBubbles.ts` matching the depth heatmap primitive's `getColumns()` accessor.

### 4. Modify `tradeBubbles.ts`: add backend switch

Same pattern as depth heatmap's `setBackend("gpu")`:

```typescript
export type TradeBubblesBackend = "canvas2d" | "gpu";

class TradeBubblesPrimitive {
  // ... existing ...
  setBackend(b: TradeBubblesBackend): void { ... }
  getTrades(): readonly TradeEvent[] { return this.trades; }
}
```

In `gpu` mode, the primitive's draw method early-returns (so Canvas2D doesn't double-draw); the WebGPU layer takes over.

### 5. Hook integration: extend `useDepthHeatmap.ts` OR new `useTradeDots.ts`

Two valid approaches:

**Option A** (simpler): extend `useDepthHeatmap.ts` to also attach the trade-dot layer when both `VITE_DEPTH_RENDERER=webgpu` AND `VITE_TRADE_DOTS_RENDERER=webgpu`. Same hook, two GPU layers, two cleanups.

**Option B** (cleaner): new file `apps/dashboard_ui/src/chart/useTradeDots.ts` modeled on `useDepthHeatmap.ts`. Called from `PriceChart.tsx` after the depth-heatmap hook.

**Pick whichever you'd rather defend in review.** Option B is more SRP-clean; Option A is fewer files. Both work.

### 6. Hide signal bubbles by default

Add a flag in `useEventMarkers.ts` (or wherever the signal/event bubble primitive is attached) controlled by `VITE_SHOW_SIGNAL_BUBBLES=true` (default `false`). When false, the primitive doesn't attach at all.

Reasoning: Bookmap doesn't show signal bubbles as the primary visual layer. Trade dots are the focal point. The signal bubbles are our analyst-mode overlay; should be opt-in.

Operator can still toggle them on via a UI button (the existing "Executions on" / "Icebergs on" buttons — repurpose if convenient, or add a new "Show signals" toggle).

### 7. Feature-flag plumbing

Add to `apps/dashboard_ui/src/vite-env.d.ts`:

```typescript
readonly VITE_TRADE_DOTS_RENDERER?: "canvas2d" | "webgpu";
readonly VITE_SHOW_SIGNAL_BUBBLES?: "true" | "false";
```

Default all to the conservative value (Canvas2D / show bubbles). The operator opts in via `.env.local` once they've verified the new pipeline.

---

## Acceptance criteria

A reviewer will check ALL of these before merging:

1. **`tsc --noEmit` clean** in `apps/dashboard_ui/`.
2. **All existing tests pass** (`npm run test -- --run`).
3. **`npm run build` succeeds** with `VITE_TRADE_DOTS_RENDERER=webgpu` set.
4. **WebGPU init succeeds** in the Tauri shell (open devtools, look for `[gpu] trade dots → WebGPU overlay attached` log line — follow the depth-heatmap log convention).
5. **Trade dots render in correct positions** — pixel-accurate alignment with LC's candles. A trade at price 30650.25 at 13:24:35 PT lands at the same (x, y) as where LC would draw a candle at that moment.
6. **Size scales with volume** — a 100-lot trade is visibly larger than a 1-lot trade; both are within min/max bounds (`~3 px` to `~25 px` diameter).
7. **Pulse animation on recent trades** — visible pulsing for the last ~500 ms after each trade event arrives. Pulse decays smoothly.
8. **No frame drops at 100+ trades/sec** — sustained high-volume burst (replay if needed) renders at 60+ FPS. Verify with the dev tools Performance tab.
9. **Hover hit-test still works** — hovering a trade dot shows the existing trade-info tooltip (which lives in the Canvas2D primitive's `hitTest`). Don't break that.
10. **Signal bubbles hidden by default** when `VITE_SHOW_SIGNAL_BUBBLES` is unset / false. Toggle visible via UI button.
11. **Graceful fallback** — if WebGPU init fails (e.g. older WebView2), trade dots fall back to Canvas2D path with `console.warn` (matching the heatmap layer's pattern).
12. **No regression in Canvas2D mode** — with `VITE_TRADE_DOTS_RENDERER=canvas2d` (or unset), behavior is exactly as today.

---

## Out of scope (DO NOT do)

- Migrating event/signal bubbles (sweep/absorption/iceberg markers) to WebGPU. That's a separate follow-up.
- Modifying the depth-heatmap pipeline (the coordinator is doing that in parallel; merging your work onto their branch).
- Replacing Lightweight Charts.
- Adding new UI components beyond the toggle for signal bubbles.
- Color-palette decisions for the heatmap (the coordinator is tuning those in P8).
- Refactoring `tradeBubbles.ts` beyond adding the `setBackend()` + `getTrades()` accessor.

If you find yourself needing any of these to ship the trade-dot layer, STOP and ask the coordinator. Probably an architecture clarification.

---

## How to verify your work locally

```powershell
# Set the flag
echo VITE_TRADE_DOTS_RENDERER=webgpu >> D:\Quant-futures-app\apps\dashboard_ui\.env.local
# (Also depth flag if not already set)
echo VITE_DEPTH_RENDERER=webgpu >> D:\Quant-futures-app\apps\dashboard_ui\.env.local

# Build + run dev server
cd D:\Quant-futures-app\apps\dashboard_ui
npm run dev
```

Open `http://127.0.0.1:5173/` in Chrome. Open devtools console; you should see:
- `[gpu] depth heatmap → WebGPU overlay attached`  (already shipped)
- `[gpu] trade dots → WebGPU overlay attached`     (your new log)

Now wait for live trades; you should see colored dots appearing at the latest price, with the most recent dots pulsing for ~500 ms.

To stress-test: trigger a high-volume replay session. Backend's replay infrastructure exists; ask the coordinator if you need a replay corpus.

---

## Known traps from the existing GPU work (read these before coding)

1. **`@webgpu/types` is required for the prod TypeScript build** but not the dev typecheck — your `tsc --noEmit` may pass while `npm run build` fails on missing GPU types. See `apps/dashboard_ui/tsconfig.app.json` for the existing `"types": ["@webgpu/types"]` line.

2. **WebView2 ignores `powerPreference: "high-performance"` on Windows.** This is harmless — the 4080 is selected anyway in practice — but if you log adapter info during dev and see a different GPU, that's why. See `feedback_webgpu_lightweight_charts_integration.md` in `C:\Users\Neel\.claude\projects\D--MNQ-Futures\memory\`.

3. **Sub-pixel quads are NOT rendered.** WebGPU's rasterizer follows the pixel-center test. If your trade dots end up <1.5 px diameter at default zoom, they'll be invisible. The depth-heatmap fix was `MIN_DEPTH_CELL_*_PX = 1.5`. For trade dots, your min-size clamp (3 px diameter) is sufficient — just don't accidentally allow smaller.

4. **Overlay canvas size MUST track `chart.paneSize()`** every render frame, NOT the chart container. The heatmap had this bug (commit `1292a43`); same trap will apply to trade dots. See `feedback_webgpu_lightweight_charts_integration.md` for the full story.

5. **Tauri's build with WebGPU requires `--enable-unsafe-webgpu` in WebView2 init args**, set in `tauri.conf.json -> app.windows[0].additionalBrowserArgs`. Already configured. Your work doesn't need to change Tauri config.

6. **The dev typecheck runs `tsc --noEmit` which is more permissive than the prod `tsc -b`**. Relative-path import bugs may slip through dev. Always run `npm run build` (not just typecheck) before claiming the work is complete.

---

## Coordination points with the coordinator

The coordinator is doing P8 (Week 1 heatmap texture integration) in parallel. Their work touches:
- `apps/dashboard_ui/src/chart/gpu/heatmapTexture.{ts,wgsl}` (already shipped foundation)
- `apps/dashboard_ui/src/chart/gpu/depthHeatmapLayer.ts` (will modify to delegate to texture pipeline)
- `apps/dashboard_ui/src/chart/depthHeatmap.ts` (data-side hooks)

**No conflicts expected with your trade-dot files** as long as you keep your work to:
- `apps/dashboard_ui/src/chart/gpu/tradeDots*` (new files)
- `apps/dashboard_ui/src/chart/tradeBubbles.ts` (minor additions: setBackend, getTrades)
- `apps/dashboard_ui/src/chart/useDepthHeatmap.ts` or new `useTradeDots.ts` (hook integration)
- `apps/dashboard_ui/src/vite-env.d.ts` (env flag types)
- `apps/dashboard_ui/src/chart/useEventMarkers.ts` (signal-bubble hide flag)

If your branch needs to merge with theirs at the end, the merge should be mechanical. Coordinate the final integration in `PriceChart.tsx` if both hooks need to be added there.

---

## Reporting back

When you complete the work, deliver:

1. **A PR / branch** containing all changes.
2. **A short report (< 300 words)** with:
   - Adapter info from `[gpu] trade dots → ...` log (vendor / architecture)
   - Visual verification: a 30-second screen recording or 3+ screenshots showing trade dots rendering during a normal session, including a high-volume burst
   - Frame time during high-volume (from devtools Performance trace)
   - Any open questions / decisions you made
3. **Update `docs/perf/path-a-bookmap-heatmap.md`** to reflect Week 2 progress.

---

## TL;DR for Codex

You're building the WebGPU trade-dot overlay for the MNQ dashboard. Mirror the existing depth-heatmap WebGPU architecture (4 files: WGSL shader, renderer class, LC-aware layer, hook integration). Trade dots are filled SDF circles, size by volume, pulse on recent trades, layered above the depth heatmap. Feature-flagged behind `VITE_TRADE_DOTS_RENDERER=webgpu`. Hide signal bubbles by default. 5 acceptance checks; ~3-5 days.

Start by reading `docs/perf/path-a-bookmap-heatmap.md` + `apps/dashboard_ui/src/chart/gpu/depthHeatmapLayer.ts` end-to-end. Then write your own.

Questions to the coordinator if anything's unclear before you start. Don't burn cycles guessing.
