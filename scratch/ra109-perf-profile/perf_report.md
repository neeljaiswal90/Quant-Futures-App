# RA-109 Dashboard Render-Pipeline Performance Profile

## Methodology

- Target: Vite dev server `http://127.0.0.1:5173` against live backend `http://127.0.0.1:8765`.
- Browser: Chrome 148 via CDP on isolated profile / port 9333.
- Recording: 15 seconds per scenario with CDP `Profiler` CPU profile plus `Tracing` DevTools timeline essentials.
- Live Tauri shell, backend, capture, contracts, detectors, probe, and scheduler were not edited.
- Scenario B separately records the cold REST `/api/bookmap-backfill` call before the page-load profile so cold-load hydration is not confused with steady-state frame cost.

## Headline Finding

The dominant measured cost is **main-thread JS/chart update work plus cold REST hydration**, not raw canvas paint. Scenario B's cold REST backfill was 1646 ms for 13838 price ticks and 2748 depth columns (5567396 bytes). On the dashboard renderer thread, Scenario B also had 3037.82 ms aggregate JS/task time, 574.47 ms layout/paint/composite time, and 2 true RunTask >50ms events. Heatmap self-time stayed under 2% of sampled CPU in every scenario, so the profile does not justify a WebGL rewrite as the first move.

Recommendation: **(B) JS optimization first**, specifically reducing REST-backfill hydration/replay work and repeated chart primitive projection on reconnect. Estimated saving: 400-900 ms from reload/backfill perceived latency plus smoother live updates by avoiding large synchronous batches. Re-profile after that before dispatching a WebGL heatmap rewrite.

## Scenario Summary

| Scenario | Mode | Backend seq | WS fps before/after | CPU sample ms | RAF/update avg/p95/p99 ms | Long tasks | Heatmap self |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | steady | 19863 -> 19943 | 3.79 / 3.99 | 15112.61 | 175.12 / 722.28 / 876.82 | 0 | 176.46 (1.17%) |
| B | hydration | 19961 -> 20026 | 2.59 / 2.23 | 15211.2 | 139.62 / 642.91 / 991.62 | 2 | 242.79 (1.6%) |
| C | live-burst | 20037 -> 20114 | 3.39 / 4.2 | 15048.71 | 135.4 / 568.16 / 695.76 | 0 | 183.32 (1.22%) |

## Per-Scenario Details

### Scenario A — steady

Trace target: CrRendererMain 23000:22580. Breakdown on that renderer thread: JS/task 2359.16 ms (15.7% wall), render/paint/layout 503.54 ms (3.35% wall), other 2406.79 ms (16.02% wall). True RunTask >50ms count: 0.

Top CPU self-time:

| Function | ms | % CPU |
| --- | --- | --- |
| (idle) | 13772.19 | 91.13 |
| (program) | 879.42 | 5.82 |
| (garbage collector) | 44.01 | 0.29 |
| _internal_firstBar @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:3747:20 | 25.54 | 0.17 |
| (anonymous) @ src/chart/eventBubbles.ts:59:23 | 16.4 | 0.11 |
| jsxDEV @ node_modules/.vite/deps/react_jsx-dev-runtime.js?v=3f9a29d7:604:23 | 16.01 | 0.11 |
| warnUnknownProperties @ node_modules/.vite/deps/chunk-KVMAXHTM.js?v=3f9a29d7:3460:44 | 14.39 | 0.1 |
| projectBubbleItems @ src/chart/eventBubbles.ts:58:34 | 14.15 | 0.09 |
| depthContrastStats @ src/chart/depthHeatmap.ts:94:34 | 13.26 | 0.09 |
| depthCellColor @ src/chart/depthHeatmap.ts:132:30 | 12.72 | 0.08 |

Top CPU total-time:

| Function | ms | % CPU |
| --- | --- | --- |
| (root) | 15112.61 | 100 |
| (idle) | 13772.19 | 91.13 |
| (program) | 879.42 | 5.82 |
| (anonymous) @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:10883:62 | 232.22 | 1.54 |
| _private__drawImpl @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:10813:20 | 231.71 | 1.53 |
| _internal_updateAllViews @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:3933:26 | 162.55 | 1.08 |
| _internal_paint @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:10527:17 | 155.68 | 1.03 |
| _internal_paint @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:9650:17 | 149.4 | 0.99 |
| _internal_recalculate @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:5610:23 | 139.81 | 0.93 |
| _internal_recalculateAllPanes @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:7158:31 | 123.03 | 0.81 |

Top trace event totals:

| Event | ms | count | max ms | % wall |
| --- | --- | --- | --- | --- |
| RunTask | 1285 | 3632 | 17.34 | 8.55 |
| ThreadControllerImpl::RunTask | 1261.19 | 3541 | 17.31 | 8.39 |
| v8.callFunction | 616.65 | 770 | 6.74 | 4.1 |
| FunctionCall | 609.98 | 770 | 6.72 | 4.06 |
| Layout | 314.69 | 86 | 8.68 | 2.09 |
| FireAnimationFrame | 312.4 | 85 | 6.77 | 2.08 |
| SimpleWatcher::OnHandleReady | 170.18 | 188 | 3.53 | 1.13 |
| TimerFire | 151.78 | 504 | 5.28 | 1.01 |
| Paint | 127.9 | 209 | 1.52 | 0.85 |
| PrePaint | 55.48 | 128 | 1.09 | 0.37 |

### Scenario B — hydration

Cold backfill: 1646 ms, 5567396 bytes, 13838 price ticks, 2748 depth columns, through_seq 19974.

Trace target: CrRendererMain 23000:22580. Breakdown on that renderer thread: JS/task 3037.82 ms (19.92% wall), render/paint/layout 574.47 ms (3.77% wall), other 3234.94 ms (21.21% wall). True RunTask >50ms count: 2.

Top CPU self-time:

| Function | ms | % CPU |
| --- | --- | --- |
| (idle) | 13580.57 | 89.28 |
| (program) | 949.71 | 6.24 |
| getClientRects | 72.16 | 0.47 |
| (garbage collector) | 49.36 | 0.32 |
| fmtTime @ src/components/HistoryPanel.tsx:19:16 | 30.54 | 0.2 |
| (anonymous) @ src/chart/eventBubbles.ts:59:23 | 24.61 | 0.16 |
| ReactElement @ node_modules/.vite/deps/react_jsx-dev-runtime.js?v=3f9a29d7:565:35 | 16.38 | 0.11 |
| depthContrastStats @ src/chart/depthHeatmap.ts:94:34 | 12.84 | 0.08 |
| key @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:7702:5 | 11.94 | 0.08 |
| prepareUpdate @ node_modules/.vite/deps/chunk-KVMAXHTM.js?v=3f9a29d7:8404:30 | 11.83 | 0.08 |

Top CPU total-time:

| Function | ms | % CPU |
| --- | --- | --- |
| (root) | 15211.2 | 100 |
| (idle) | 13580.57 | 89.28 |
| (program) | 949.71 | 6.24 |
| _private__drawImpl @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:10813:20 | 344.61 | 2.27 |
| (anonymous) @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:10883:62 | 306.08 | 2.01 |
| _internal_paint @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:10527:17 | 198.24 | 1.3 |
| workLoop @ node_modules/.vite/deps/chunk-KVMAXHTM.js?v=3f9a29d7:183:25 | 190.55 | 1.25 |
| flushWork @ node_modules/.vite/deps/chunk-KVMAXHTM.js?v=3f9a29d7:154:26 | 190.55 | 1.25 |
| performWorkUntilDeadline @ node_modules/.vite/deps/chunk-KVMAXHTM.js?v=3f9a29d7:376:47 | 190.55 | 1.25 |
| _internal_paint @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:9650:17 | 188.81 | 1.24 |

Top trace event totals:

| Event | ms | count | max ms | % wall |
| --- | --- | --- | --- | --- |
| RunTask | 1659.96 | 5648 | 65.06 | 10.88 |
| ThreadControllerImpl::RunTask | 1623.55 | 5365 | 65.02 | 10.65 |
| v8.callFunction | 839.12 | 858 | 53.19 | 5.5 |
| FunctionCall | 829.1 | 858 | 53.17 | 5.44 |
| FireAnimationFrame | 402.64 | 106 | 53.2 | 2.64 |
| Layout | 369.25 | 130 | 10.87 | 2.42 |
| SimpleWatcher::OnHandleReady | 222.09 | 221 | 22.49 | 1.46 |
| TimerFire | 142.36 | 504 | 4.49 | 0.93 |
| Paint | 133.92 | 217 | 1.85 | 0.88 |
| Receive mojo message | 67.66 | 153 | 31.06 | 0.44 |

### Scenario C — live-burst

Trace target: CrRendererMain 23000:22580. Breakdown on that renderer thread: JS/task 2361.22 ms (15.72% wall), render/paint/layout 501.28 ms (3.34% wall), other 2339.36 ms (15.57% wall). True RunTask >50ms count: 0.

Top CPU self-time:

| Function | ms | % CPU |
| --- | --- | --- |
| (idle) | 13748.7 | 91.36 |
| (program) | 845.25 | 5.62 |
| (garbage collector) | 44.06 | 0.29 |
| assert @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:482:15 | 18.6 | 0.12 |
| (anonymous) @ src/chart/eventBubbles.ts:59:23 | 17.95 | 0.12 |
| depthCellColor @ src/chart/depthHeatmap.ts:132:30 | 14.83 | 0.1 |
| key @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:7702:5 | 13.65 | 0.09 |
| depthContrastStats @ src/chart/depthHeatmap.ts:94:34 | 13.22 | 0.09 |
| fillText | 12.87 | 0.09 |
| (anonymous) @ src/chart/depthHeatmap.ts:231:35 | 12.83 | 0.09 |

Top CPU total-time:

| Function | ms | % CPU |
| --- | --- | --- |
| (root) | 15048.71 | 100 |
| (idle) | 13748.7 | 91.36 |
| (program) | 845.25 | 5.62 |
| (anonymous) @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:10883:62 | 235.84 | 1.57 |
| _private__drawImpl @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:10813:20 | 235.76 | 1.57 |
| _internal_paint @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:10527:17 | 166.35 | 1.11 |
| _internal_paint @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:9650:17 | 156.96 | 1.04 |
| _internal_updateAllViews @ node_modules/.vite/deps/lightweight-charts.js?v=3f9a29d7:3933:26 | 144.15 | 0.96 |
| commitMutationEffectsOnFiber @ node_modules/.vite/deps/chunk-KVMAXHTM.js?v=3f9a29d7:17740:45 | 143.05 | 0.95 |
| recursivelyTraverseMutationEffects @ node_modules/.vite/deps/chunk-KVMAXHTM.js?v=3f9a29d7:17717:51 | 133.83 | 0.89 |

Top trace event totals:

| Event | ms | count | max ms | % wall |
| --- | --- | --- | --- | --- |
| RunTask | 1289.61 | 3583 | 19.16 | 8.59 |
| ThreadControllerImpl::RunTask | 1265.15 | 3441 | 19.13 | 8.42 |
| v8.callFunction | 613.48 | 785 | 5.87 | 4.08 |
| FunctionCall | 606.37 | 785 | 5.86 | 4.04 |
| FireAnimationFrame | 322.65 | 100 | 5.89 | 2.15 |
| Layout | 308.3 | 85 | 10.71 | 2.05 |
| SimpleWatcher::OnHandleReady | 165.91 | 183 | 3.38 | 1.1 |
| TimerFire | 142.59 | 505 | 4.13 | 0.95 |
| Paint | 127.66 | 213 | 1.53 | 0.85 |
| PrePaint | 59.02 | 140 | 1.64 | 0.39 |

## Recommendation

Proceed with path **B: JS optimization**.

Evidence:
- Scenario B's cold REST + hydration path is the visible pain point: the REST call alone exceeded 1.6s in this run, then React/chart replay work followed.
- Long tasks appeared only in hydration (two RunTask windows, reported as two events after de-duplication), not in steady state or live-burst.
- Heatmap-specific self-time was measurable but not dominant in the sampled CPU profile.
- Paint/layout/composite totals were not the dominant trace category, so a WebGL rewrite is premature.

Concrete follow-up shape: split backfill hydration into incremental chunks with requestAnimationFrame yielding, pre-dedupe depth/price rows before chart handoff, and cache projected visible ranges so price_tick/depth updates do less synchronous work. Target 300-600 ms perceived reload improvement first, then re-profile.

## Artifacts

- `scenario-a.json`, `scenario-b.json`, `scenario-c.json`: raw CDP trace + CPU profile per scenario.
- `scenario-a-analysis.json`, `scenario-b-analysis.json`, `scenario-c-analysis.json`: parsed summaries.
- `recording_summary.json`: capture metadata and backend/WS baselines.
- `scripts/record_profile.mjs`, `scripts/analyze_profiles.mjs`: scratch-only harness scripts.