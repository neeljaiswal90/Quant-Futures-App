# Codex Dispatch — RA-109: dashboard render-pipeline performance profile

Coordinator dispatch. Pre-build sweep → green-light → measure → report. Read `v2_codex_handoff.md` for invariants.

**Status:** Pure investigation. No code change. Output is a `perf_report.md` that tells coordinator where to spend the next engineering week (JS optimization vs custom WebGL heatmap vs deeper rendering rework).

## Why this exists

Operator reports the dashboard "feels slow" — not Bookmap-fast. The GPU (RTX 4080) is technically being used (WebView2/Chromium uses D3D11 for compositing), but the upstream JS/canvas pipeline likely dominates frame time. Without measurement, any GPU work would be speculative.

Three candidate cost centers are plausible:

1. **JS-side per-frame work** — persistence accumulator (RA-107), depth-cell projection, intensity computation, color string generation. All single-threaded JS.
2. **`ctx.fillRect()` call volume in the heatmap** — at 100 ticks × 100 cols × ~30% non-empty = ~3,000 fillRect/repaint. At 4 fps that's 12k draw calls/sec.
3. **lightweight-charts internal layout/autoscale** — coordinate queries, primitive iteration, autoscale resolution per paint frame.

This ticket measures which dominates, then makes a recommendation. **No remediation work — that's a follow-up dispatch.**

## Build

### 1. Enable profiling environment

Profile against the **Vite dev server**, not the Tauri shell. Tauri's WebView2 has the same rendering engine (Chromium/Blink/D3D11) but its devtools are disabled in release builds. Vite dev server with Chrome gives full DevTools Performance recorder with no config change.

Procedure:
```powershell
cd D:\Quant-futures-app\apps\dashboard_ui
npm run dev
# Opens at http://localhost:5173 (or similar)
# Open in Chrome (not Edge/WebView2)
# Connect to live backend ws://127.0.0.1:8765/ws — same endpoint Tauri shell uses
```

The live backend is already running (per the launcher). The dashboard UI fetches /api/bookmap-backfill + connects WS exactly as the Tauri shell would. Same data, same renderer, same JS code.

### 2. Take performance recordings

Three scenarios, ~15 seconds each:

- **Scenario A — quiet steady state**: market in a chop range, heatmap showing the contrast model's typical output. Measures baseline per-frame cost.
- **Scenario B — backfill hydration**: hard-reload the page. Measures cost of `setHistory()` + persistence-accumulator replay + initial render of ~100 depth columns + ~364 price ticks at once. This is the worst-case render path.
- **Scenario C — high-frequency live event**: during a sweep / aggressor-flow burst (~5-10 signals/sec). Measures cost of the live-update path under signal load.

Each recording produces a Chrome DevTools `.json` profile file. Save to `scratch/ra109-perf-profile/scenario-{a,b,c}.json`.

### 3. Analyze each profile

For each profile, extract:

- **Top 10 functions by self-time** (total time spent IN the function excluding callees)
- **Top 10 functions by total-time** (including callees)
- **Layout/paint/composite breakdown** (% of frame time in each)
- **JS execution % vs rendering % vs idle**
- **Long tasks** (>50ms) — count and identify their stacks
- **Average frame time** (target: 16.6ms for 60fps; observed will likely be much higher)
- **Heatmap-specific stacks**: any function with `depthHeatmap`, `depthPersistence`, `projectDepthHeatmapCells`, `DepthHeatmapRenderer.draw`, `fillRect` in the stack — measure their share

### 4. Produce `perf_report.md`

Run-dir layout:
```
scratch/ra109-perf-profile/
├── perf_report.md          ← the deliverable
├── scenario-a.json         ← raw Chrome devtools profile
├── scenario-b.json
├── scenario-c.json
└── screenshots/            ← optional, before/after for visual context
```

Report structure:

1. **Methodology**: Chrome version, Vite dev server git commit, time of day, captured during which trading session, hardware (CPU model, GPU model, RAM).
2. **Headline finding**: in plain English. Examples of what's acceptable:
   - "Heatmap repaint dominates: 8.2ms per frame (49% of frame time), with 3,142 fillRect calls. Custom WebGL primitive recommended."
   - "Persistence accumulator update dominates: 6.4ms per frame (38% of frame time). JS optimization recommended."
   - "Lightweight-charts internal autoscale dominates: 11.5ms per frame (69% of frame time). May need to fork or replace."
3. **Per-scenario tables** — top 10 functions by self-time AND total-time, frame time avg / p95 / p99, long-task count.
4. **Recommendation**: which of the three follow-up paths makes sense:
   - **(B) JS optimization** — if JS execution dominates and the hot functions are in OUR code
   - **(C) WebGL heatmap primitive** — if fillRect call volume or canvas rasterization dominates
   - **(D) Renderer fork/replace** — if lightweight-charts internals dominate and we can't reach them from outside
5. **Per-path estimate**: how much frame time the recommendation would likely save (back-of-envelope from the profile data).

### 5. Hard NO's

- **No code changes** beyond what's needed to enable Vite dev server. The dashboard runs as-is.
- **No mock data, no synthetic benchmarks** — profile the real running system with live backend data. Synthetic benchmarks lie about cache behavior, JIT optimization, and main-thread contention.
- **No premature optimization**. This ticket measures. The fix is a separate dispatch.

## Hard invariants

- Read-only on captures, backend, contracts. Profile uses the running stack as-is.
- No detector / capture / probe / scheduler / `.env` changes.
- The live Tauri shell stays running for operator use. Profiling happens in a separate Chrome window against the dev server.
- Surgical path-scoped commit at the end: only `scratch/ra109-perf-profile/perf_report.md` (and supporting artifacts) — no production code.
- If Vite dev server doesn't start cleanly (port conflict, missing dep), flag in sweep — don't hack around it.

## Pre-build sweep gate

Sweep must cover:

1. **Vite dev server boots successfully** against the running backend. Confirm WS connection, snapshot frame received, depth payload renders.
2. **Chrome version + DevTools availability**. Confirm the Performance tab works (some corporate Chrome installs disable it).
3. **Recording scope** — confirm Codex can isolate the dashboard tab from other Chrome activity that would pollute the profile.
4. **Scenario reproducibility** — explain how to deliberately trigger scenarios B (hydration) and C (high-frequency burst) without waiting passively for them.
5. **Analysis methodology** — confirm how Codex will extract top-K functions from the .json profile (Chrome DevTools UI manually? scripted analysis via `cdpsession` or speedscope?). If manual, just commit screenshots of the relevant panels alongside the JSON.

## Acceptance

- `perf_report.md` exists with all four sections (methodology, headline, per-scenario tables, recommendation).
- Three `.json` profile recordings saved (one per scenario).
- Headline finding identifies the dominant cost center in measurable terms (function name + % of frame time + sample count).
- Recommendation is one of B/C/D with a specific path-time saving estimate. NOT "could try X" — a concrete call.
- No production code changes touched. Diff is artifact-only.

## Coordinator review focus

The headline finding + recommendation determine the next dispatch (RA-110 or RA-111 or RA-112). The report needs to be unambiguous about which path is justified. If the profile shows the bottleneck is in lightweight-charts' internals (not our code), that's important — it constrains the available solutions.

If multiple cost centers tie (e.g., 30% JS + 30% fillRect + 30% lightweight-charts), the report should say so and recommend a phased approach: cheapest wins first (B), then revisit.

## Priority

Sequential after RA-107 (just shipped). Codex's bandwidth is open. Estimated 1-2 hours for the actual profiling + report writing.

This unblocks the strategic GPU/perf decision. Without this report, any "use the RTX 4080" work would be speculative.

## Future option (out of scope; for the operator)

If the report concludes WebGL heatmap is the right move (likely, given the fillRect volume estimate), RA-110 is the build dispatch. The persistence accumulator's `Map<price, score>` becomes a 1D texture; a fragment shader computes color per pixel; renders in a single draw call. 100-1000× speedup for the heatmap specifically.

If JS optimization is the right move, RA-111 covers OffscreenCanvas + Worker thread + batched fillRect coalescing. Lower ceiling, lower cost.

If lightweight-charts internals dominate, RA-112 explores forking the library OR moving to a custom WebGL renderer for the whole chart. High cost; only justified if the profile leaves no other option.
