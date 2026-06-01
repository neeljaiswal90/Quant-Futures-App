# RA-100 Bookmap Parity Report

Date: 2026-05-31

## Findings

- Browser reload/reconnect lost Bookmap-style history because the backend only replayed the latest depth frame plus snapshot on WebSocket connect.
- The heatmap was client-local: it accumulated depth columns only after the browser loaded, so refreshing the UI reset the visible liquidity history.
- The price line had only a single snapshot seed plus live ticks. Without bulk hydration, the chart could not show full in-session history after a reload.
- Fast-path price ticks and compute-path enriched price ticks can represent the same trade. Without merge-by-trade identity, the UI can render duplicate execution bubbles.
- Signal bubbles were visually competing with actual executions. Bookmap-style reading needs resting liquidity in amber/orange, executions in green/red, and detector signals as secondary context.
- DOM ladder and heatmap price alignment depended on separate tick-bucketing helpers, which risked subtle row/cell drift.

## Fixes

- Added backend compact session-history rings for price ticks and depth snapshots, bounded by 8 hours, 100k price ticks, and 12k depth columns.
- Added `GET /api/bookmap-backfill` for REST hydration with `generated_at_ns`, `through_seq`, history limits, compact price records, and compact depth records.
- Merged fast-null and enriched duplicate price ticks by `(trade_ts_ns, price, volume)` so one trade becomes one execution bubble with upgraded orderflow when available.
- Added race-safe frontend hydration: connect WebSocket, buffer incoming live bookmap frames during the REST fetch, hydrate from backfill, then merge buffered live frames by identity.
- Added imperative bulk seed APIs for price/volume/CVD proxy, depth heatmap, and trade bubbles so reload does not depend on React re-rendering thousands of points.
- Added a separate `TradeBubblePrimitive` for real executions. Signal/event bubbles were demoted in size, opacity, and z-order.
- Changed heatmap liquidity bands to amber/orange and reserved green/red for buy/sell execution bubbles.
- Added shared `priceGrid` helpers used by heatmap, DOM ladder, and trade bubbles.
- Prevented snapshot price seeds from rendering as execution bubbles.

## Post-Review Safety Follow-Ups

- Added a 100 MiB REST backfill byte budget with `effective_price_ticks_max`,
  `effective_depth_columns_max`, `max_response_bytes`, and
  `estimated_response_bytes` in the response limits block. The backend now
  returns the newest rows that fit under the budget instead of blindly dumping
  all configured records.
- Added a bounded live-frame buffer while REST backfill is in flight. The
  browser keeps the latest 512 Bookmap frames and drops oldest frames if a
  backfill request stalls.

## Scope Notes

- RA-100 fixes browser reload/reconnect while the backend remains running.
- Backend-restart reconstruction from capture files is intentionally out of scope and should be a separate replay/backfill ticket.
- CVD remains display/proxy unless the backend orderflow payload includes true `last_trade_delta`.
- Capture, normalization, contracts, credentials, scheduler entries, and `capture-rithmic-probe.py` were not changed.

## Verification

- `python -m pytest tests --basetemp D:\Quant-futures-app\scratch\pytest-ra100-full` from `D:\Quant-futures-app\services\realtime_backend`: 77 passed.
- `python -m ruff check realtime_backend` from `D:\Quant-futures-app\services`: clean.
- `python -m mypy realtime_backend --config-file realtime_backend/pyproject.toml` from `D:\Quant-futures-app\services`: clean.
- `npm --prefix apps/dashboard_ui test`: 116 passed.
- `npm --prefix apps/dashboard_ui run typecheck`: clean.
- `npm --prefix apps/dashboard_ui run lint`: clean.
- `npm --prefix apps/dashboard_ui run build`: clean.
