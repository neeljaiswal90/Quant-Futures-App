# Codex Dispatch - RA-100 Bookmap-Parity Heatmap Backfill + Trade Bubble Layering

## Objective

Build the next real dashboard fix: make the v2 decision map behave like Bookmap for live trading. The current stack is live, but it only accumulates price/depth history from browser connect time, the depth heatmap lacks strong resting-liquidity bands, signal bubbles are visually confused with executions, and the DOM ladder/heatmap need stricter price-axis alignment.

This ticket is **not** a capture or scheduler task. Do not start/stop Rithmic capture, edit credentials, edit `.env`, edit scheduler entries, or change normalization ownership.

This ticket solves browser reload/reconnect while the backend remains running. Backend-restart full-session reconstruction from capture/MBO is a separate replay/backfill ticket unless explicitly approved later.

## Read First

- `D:\Quant-futures-app\tools\rithmic_dashboard\docs\bookmap_heatmap_audit_2026-06-01_globex.md`
- `D:\Quant-futures-app\tools\rithmic_analytics\docs\executor_prompts\v2_codex_dispatch_depth_heatmap_dom.md`
- `D:\Quant-futures-app\tools\rithmic_analytics\docs\executor_prompts\v2_codex_dispatch_ui_parallel_streams.md`
- `D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md` -> RA-100

## Current Diagnosis

The feed is not dead. The gap is history and presentation:

- Price-line history starts at browser connect/reload time.
- Depth heatmap history also starts at browser connect/reload time because the backend only replays the latest depth message.
- Signal/event bubbles visually dominate the map and can look like Bookmap trade bubbles even though they are detector events.
- Liquidity should read as persistent orange time-by-price bands.
- Trade bubbles should be execution-derived and separate from detector/signal markers.
- DOM ladder rows and heatmap price cells must share the same tick grid.
- Time axis must stay Pacific time.
- CVD history is display/proxy unless an orderflow delta is present; do not imply true CVD can be reconstructed from fast `price_tick` history alone.

## Hard Invariants

- Do not touch `scripts/infra/capture-rithmic-probe.py`.
- Do not modify credentials, `.env`, scheduler entries, chart/Pine files, or capture lifecycle.
- Do not change normalization ownership or create a second normalizer.
- Keep RA-052 memory discipline: bounded buffers only, explicit caps, no unbounded session arrays.
- If you touch frozen realtime contracts, edit Python and TypeScript together and keep the parity tripwire green.
- Stage path-scoped changes only. There is unrelated dirt in the worktree; do not sweep-stage.

## Required V1 Decisions

- **Backfill endpoint**: `GET /api/bookmap-backfill`
- **Depth history cap**: `min(12_000 columns, 8h)`
- **Price/trade history cap**: `min(100_000 ticks, 8h)`
- **Response observability**: include `generated_at_ns` and `through_seq`, or a documented equivalent watermark.
- **History storage**: compact DTO rings only; do not store full `RealtimeMessage`/Pydantic envelope objects.
- **Reconnect model**: WS connect first, buffer or accept live frames, fetch REST backfill, hydrate imperatively, then merge idempotently.
- **Fast-null duplicate rule**: fast-path `orderflow: null` and compute-path enriched duplicate for the same `(trade_ts_ns, price, volume)` update the same trade record and render one execution bubble.
- **Palette**: liquidity bands are amber/orange only; green/red are reserved for executions.
- **CVD**: display/proxy unless true orderflow delta is present.
- **Scope boundary**: backend restart reconstruction is out of scope.

## Pre-Build Sweep Gate

Post a pre-build sweep before writing source code. The sweep must answer these questions:

1. **Backfill transport**: confirm `GET /api/bookmap-backfill` as the v1 path. Do not push thousands of historical frames through WS replay unless you explicitly prove the REST path cannot work.
2. **DTO shape**: define compact response DTOs, including `generated_at_ns`, `through_seq` or documented equivalent, caps/limits metadata, price/trade records, and depth columns.
3. **History caps**: default to depth `min(12_000 columns, 8h)` and price/trades `min(100_000 ticks, 8h)`. Provide memory math and tighten only with justification.
4. **Reconnect ordering**: connect WS first and buffer/accept live frames, fetch backfill, hydrate idempotently, then merge buffered/live frames by dedupe key.
5. **Dedupe keys**: price tick/trade bubble key, depth snapshot key, reconnect/live merge key, and fast-null -> compute-enriched duplicate update key.
6. **Imperative hydration**: identify the chart/primitive APIs that need `seedFromHistory` / `setHistory` style entrypoints.
7. **Trade-bubble provenance**: how aggressor side is sourced; what happens when side is unknown; how size maps to bubble radius.
8. **Visual layer order**: amber liquidity bands, price line, green/red trade bubbles, demoted signal markers, zones, current-price line, and DOM ladder; include opacity/z-order plan.
9. **Price-axis alignment**: shared tick-bucket strategy between DOM rows, heatmap cells, trade bubbles, and current-price projection; tests to prove DOM row price equals heatmap cell price.
10. **Operational safety**: confirm capture, scheduler, credentials, and normalization remain untouched.
11. **Verification plan**: backend tests, frontend tests, browser visual smoke, and reload/reconnect smoke.

Do not start implementation until the sweep is green-lit.

## Build Phases

### Phase 1 - Backend Session History + Backfill

Add bounded compact in-memory history for:

- price ticks / execution ticks
- depth snapshots emitted by the depth poller

The history must be session-scoped, compact, and bounded by both time and count. Backfill should be deterministic and ordered by event time.

Add `GET /api/bookmap-backfill` with a compact response similar to:

```json
{
  "schema_version": 1,
  "trading_date": "2026-06-01",
  "session": "globex",
  "generated_at_ns": "1780358400123456789",
  "through_seq": 12345,
  "limits": {
    "price_ticks_max": 100000,
    "depth_columns_max": 12000,
    "max_age_seconds": 28800
  },
  "price_ticks": [],
  "depth": []
}
```

The exact DTO may differ, but it must include the observability fields, caps metadata, compact price/trade records, and compact depth columns. Do not persist to capture files. Do not reread full captures on every reconnect. This is a live-session history cache, not a new normalizer.

Memory target: keep the added history budget comfortably below 100 MB for a full RTH session. A reasonable starting estimate is price/trade ring under roughly 16 MB for 100k compact ticks, and depth ring under roughly 60 MB for 12k compact columns, depending on Python object overhead. If the chosen representation exceeds that, tighten caps or use more compact structures.

### Phase 2 - Frontend Hydration + Merge

Hydrate chart state from backfill with a race-safe sequence:

1. Open WS.
2. Buffer or accept live frames without dropping them.
3. Fetch `/api/bookmap-backfill`.
4. Hydrate bulk history imperatively.
5. Merge buffered/live frames by dedupe key.

Hydrated surfaces:

- price line
- trade bubbles
- depth heatmap columns
- volume/CVD display proxy where available

Add explicit `seedFromHistory` / `setHistory` style APIs where reducers are insufficient:

- price chart series
- volume/CVD display proxy
- depth heatmap primitive
- trade-bubble primitive

The live stream must merge idempotently with hydrated history. A browser reload after minutes of capture should not erase earlier heatmap/price context.

### Phase 3 - Bookmap-Style Visual Layering

Separate three concepts:

- **Resting liquidity**: amber/orange horizontal bands, stable intensity scale, rendered as the heatmap.
- **Executions**: a new `TradeBubblePrimitive` from price ticks/trades, sized by volume, colored green/red by aggressor side when known and neutral when unknown.
- **Signals**: the existing `EventBubblePrimitive` remains signal/event-derived and is demoted to smaller markers/chips or a lower-emphasis overlay. Sweeps/signals must not look like trade bubbles.

Keep the chart operational and dense. This is a trading surface, not a marketing redesign.

### Phase 4 - DOM / Heatmap Price Alignment

Add or reuse a shared price-grid utility and use one tick-grid rule for:

- heatmap price buckets
- DOM ladder rows
- current-price marker
- trade-bubble y projection

Add tests for rounding/bucketing and row/cell projection. The same price should land on the same row/cell across the ladder and map.

### Phase 5 - Verification + Docs

Update operations/dashboard docs to explain:

- backfill and reconnect behavior
- liquidity bands vs trade bubbles vs signal markers
- caps and expected memory behavior
- CVD display/proxy limits when true orderflow delta is absent

Run the relevant backend and frontend checks. Include a browser visual smoke with a reload/reconnect check when a local dev server is running.

## Acceptance Criteria

- Reloading the dashboard after at least 10 minutes of live capture preserves earlier price and depth history.
- Scope is browser reload/reconnect while the backend remains running; backend-restart reconstruction is not included.
- Heatmap shows persistent orange liquidity bands, not only faint current-state patches.
- Trade bubbles are execution-derived and visually separate from signal markers.
- Signal markers no longer dominate the chart as green/red clusters.
- DOM ladder price rows align with heatmap cells and current-price marker.
- Time labels remain Pacific time.
- Backfill is bounded, deterministic, and dedupes cleanly with live frames.
- Fast-null and compute-enriched duplicate ticks render as one updated execution bubble.
- CVD history is labeled/treated as proxy unless true orderflow delta is present.
- No capture/credential/scheduler/normalization ownership files changed.
- Backend pytest/ruff/mypy clean for touched packages.
- Dashboard vitest/tsc/eslint/build clean for touched UI.

## Ship Report

Report:

- files changed
- chosen backfill DTO shape and caps
- memory-budget math
- exact dedupe keys
- hydration/reconnect ordering
- verification commands and results
- browser/reload smoke result
- any remaining Bookmap-parity gaps
