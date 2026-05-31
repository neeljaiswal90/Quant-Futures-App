# Codex Dispatch - RA-100 Bookmap-Parity Heatmap Backfill + Trade Bubble Layering

## Objective

Build the next real dashboard fix: make the v2 decision map behave like Bookmap for live trading. The current stack is live, but it only accumulates price/depth history from browser connect time, the depth heatmap lacks strong resting-liquidity bands, signal bubbles are visually confused with executions, and the DOM ladder/heatmap need stricter price-axis alignment.

This ticket is **not** a capture or scheduler task. Do not start/stop Rithmic capture, edit credentials, edit `.env`, edit scheduler entries, or change normalization ownership.

## Read First

- `D:\Quant-futures-app\tools\rithmic_dashboard\docs\bookmap_heatmap_audit_2026-06-01_globex.md`
- `D:\Quant-futures-app\tools\rithmic_analytics\docs\executor_prompts\v2_codex_dispatch_depth_heatmap_dom.md`
- `D:\Quant-futures-app\tools\rithmic_analytics\docs\executor_prompts\v2_codex_dispatch_ui_parallel_streams.md`
- `D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md` → RA-100

## Current Diagnosis

The feed is not dead. The gap is history and presentation:

- Price-line history starts at browser connect/reload time.
- Depth heatmap history also starts at browser connect/reload time because the backend only replays the latest depth message.
- Signal/event bubbles visually dominate the map and can look like Bookmap trade bubbles even though they are detector events.
- Liquidity should read as persistent orange time-by-price bands.
- Trade bubbles should be execution-derived and separate from detector/signal markers.
- DOM ladder rows and heatmap price cells must share the same tick grid.
- Time axis must stay Pacific time.

## Hard Invariants

- Do not touch `scripts/infra/capture-rithmic-probe.py`.
- Do not modify credentials, `.env`, scheduler entries, chart/Pine files, or capture lifecycle.
- Do not change normalization ownership or create a second normalizer.
- Keep RA-052 memory discipline: bounded buffers only, explicit caps, no unbounded session arrays.
- If you touch frozen realtime contracts, edit Python and TypeScript together and keep the parity tripwire green.
- Stage path-scoped changes only. There is unrelated dirt in the worktree; do not sweep-stage.

## Pre-Build Sweep Gate

Post a pre-build sweep before writing source code. The sweep must answer these questions:

1. **Backfill transport**: REST endpoint vs additive realtime family. If contract-free REST is chosen, define typed frontend DTOs and why this avoids frozen-contract churn. If a realtime family is chosen, name the family and parity files.
2. **History caps**: exact age/count caps for price ticks/trades and depth snapshots, plus memory math for a full RTH session.
3. **Reconnect ordering**: precise client startup order such as `snapshot → backfill → live frames`, including no-gap/no-duplicate behavior.
4. **Dedupe keys**: price tick/trade bubble key, depth snapshot key, and reconnect/live merge key.
5. **Trade-bubble provenance**: how aggressor side is sourced; what happens when side is unknown; how size maps to bubble radius.
6. **Visual layer order**: liquidity bands, price line, trade bubbles, signal markers, zones, current-price line, and DOM ladder; include opacity/z-order plan.
7. **Price-axis alignment**: shared tick-bucket strategy between DOM rows and heatmap cells; tests to prove DOM row price equals heatmap cell price.
8. **Operational safety**: confirm capture, scheduler, credentials, and normalization remain untouched.
9. **Verification plan**: backend tests, frontend tests, browser visual smoke, and reload/reconnect smoke.

Do not start implementation until the sweep is green-lit.

## Build Phases

### Phase 1 — Backend Session History + Backfill

Add bounded in-memory history for:

- price ticks / execution ticks
- depth snapshots emitted by the depth poller

The history should be session-scoped and bounded by both time and count. Prefer compact DTOs. Backfill should be deterministic and ordered by event time.

Do not persist to capture files. Do not reread full captures on every reconnect. This is a live-session history cache, not a new normalizer.

### Phase 2 — Frontend Hydration + Merge

Hydrate chart state from backfill before live streaming continues:

- price line
- trade bubbles
- depth heatmap columns
- volume/CVD panel state where available

The live stream must merge idempotently with hydrated history. A browser reload after minutes of capture should not erase earlier heatmap/price context.

### Phase 3 — Bookmap-Style Visual Layering

Separate three concepts:

- **Resting liquidity**: amber/orange horizontal bands, stable intensity scale, rendered as the heatmap.
- **Executions**: trade bubbles from price ticks/trades, sized by volume, colored by aggressor side when known.
- **Signals**: detector events, demoted to smaller markers/chips or a lower-emphasis overlay. Sweeps/signals must not look like trade bubbles.

Keep the chart operational and dense. This is a trading surface, not a marketing redesign.

### Phase 4 — DOM / Heatmap Price Alignment

Use one tick-grid rule for:

- heatmap price buckets
- DOM ladder rows
- current-price marker
- trade-bubble y projection

Add tests for rounding/bucketing and row/cell projection. The same price should land on the same row/cell across the ladder and map.

### Phase 5 — Verification + Docs

Update operations/dashboard docs to explain:

- backfill and reconnect behavior
- liquidity bands vs trade bubbles vs signal markers
- caps and expected memory behavior

Run the relevant backend and frontend checks. Include a browser visual smoke with a reload/reconnect check when a local dev server is running.

## Acceptance Criteria

- Reloading the dashboard after at least 10 minutes of live capture preserves earlier price and depth history.
- Heatmap shows persistent orange liquidity bands, not only faint current-state patches.
- Trade bubbles are execution-derived and visually separate from signal markers.
- Signal markers no longer dominate the chart as green/red clusters.
- DOM ladder price rows align with heatmap cells and current-price marker.
- Time labels remain Pacific time.
- Backfill is bounded, deterministic, and dedupes cleanly with live frames.
- No capture/credential/scheduler/normalization ownership files changed.
- Backend pytest/ruff/mypy clean for touched packages.
- Dashboard vitest/tsc/eslint/build clean for touched UI.

## Ship Report

Report:

- files changed
- chosen backfill transport and caps
- memory-budget math
- exact dedupe keys
- verification commands and results
- browser/reload smoke result
- any remaining Bookmap-parity gaps
