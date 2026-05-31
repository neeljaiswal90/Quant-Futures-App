# Bookmap Heatmap Audit - 2026-06-01 Globex

## Scope

Audited the live v2 dashboard against the provided Bookmap reference screenshot.
The focus was:

- why the heatmap does not visually read like Bookmap
- why chart history disappears before a certain time
- why the chart time labels were not Pacific time

## Runtime Evidence

Live stack was healthy during the audit:

- dashboard loaded at `http://127.0.0.1:5173/`
- browser console: no warnings or errors
- DOM ladder: `live`
- websocket sample over 20 seconds:
  - `price_tick`: 77 frames
  - `depth`: 13 frames
  - `sweep`: 20 frames
  - `heartbeat`: 8 frames
  - depth quality: `live`
  - depth `n_ticks`: 20
  - max visible depth size in sample: 23 contracts

The feed is live. The gap is presentation and history/backfill, not a dead feed.

## Finding 1 - Current View Is Not Bookmap-Equivalent

The line of large green/red circles on the chart is not the Bookmap-style
resting-liquidity heatmap. It is the event-bubble primitive rendering repeated
signal events, especially sweeps, at their `(time, price)` coordinates.

Bookmap's main panel has three separate visual layers:

1. background resting liquidity bands, mostly horizontal and persistent over
   time
2. trade bubbles/prints on top of the book
3. a current DOM/COB ladder beside the heatmap

The current dashboard has:

1. a depth heatmap layer, but it is low-contrast and underneath other layers
2. signal bubbles, not trade bubbles, drawn prominently on top
3. a DOM ladder, but separate from the main heatmap axis

This makes the visible output read as "signal dots over a chart", not as
"liquidity walls over time".

### Required Bookmap-Parity Change

Separate the layers explicitly:

- heatmap: high-contrast amber/orange liquidity bands from depth snapshots
- trades: small buy/sell/neutral execution bubbles from `price_tick`
- signals: smaller optional markers/chips, not the dominant layer
- DOM ladder: current snapshot, aligned visually with the heatmap price scale

## Finding 2 - Heatmap History Starts At Browser Runtime

The heatmap primitive retains a client-side ring buffer:

- `apps/dashboard_ui/src/chart/useDepthHeatmap.ts`
  - React store keeps only the latest `DepthPayload`
  - `DepthHeatmapPrimitive` retains columns after the page is connected
- `services/realtime_backend/feed.py`
  - backend caches only `_last_depth_message`
  - websocket connect replays only the latest cached depth frame plus snapshot

That means a browser refresh or dashboard reconnect loses prior heatmap columns.
The chart cannot display Bookmap-style session history because the backend does
not currently provide a depth-history backfill.

### Required Bookmap-Parity Change

Add a session-history source of truth in the backend:

- bounded in-memory depth column cache keyed by session
- bounded in-memory price/trade cache keyed by session
- websocket connect or REST endpoint replays the current session window
- frontend seeds the heatmap/price/trade layers from that backfill, then
  continues with live frames

## Finding 3 - Price Chart History Also Starts At Browser Runtime

The price line is an imperative client-side accumulator:

- `apps/dashboard_ui/src/chart/PriceChart.tsx`
  - seeds one point from the current snapshot price
  - appends live `price_tick` frames after page load
- `apps/dashboard_ui/src/chart/candles.ts`
  - holds only the current client-side accumulator state

The snapshot does not contain full-session price history. So after reload the
chart starts near the reload time instead of showing the full Globex session.

This explains "the chart does not show historical values past a certain time":
the earlier values are not being sent to this client.

### Required Bookmap-Parity Change

Add price/trade backfill alongside depth backfill:

- replay recent/session `price_tick` points on connect
- rebuild the price line, volume bars, and CVD display from history
- then switch to live incremental updates

## Finding 4 - Time Axis Was UTC, Not Pacific Time

The underlying timestamps are correct. Example from the live sample:

- latest price tick: `2026-05-31T23:04:09Z`
- same tick in Pacific time: `2026-05-31 16:04:09 PT`

The chart displayed UTC because `lightweight-charts` defaults to UTC-style
formatting for `UTCTimestamp` values unless a formatter is supplied.

### Fix Applied

Added Pacific-time formatters:

- `apps/dashboard_ui/src/chart/timeFormat.ts`
- `apps/dashboard_ui/src/chart/PriceChart.tsx`
- `apps/dashboard_ui/src/chart/timeFormat.test.ts`

The chart now formats axis/crosshair time in `America/Los_Angeles` time. Labels
should be read as PT; the date may be PST or PDT depending on daylight saving.

## Recommended Ticket

Create a dedicated Bookmap-parity ticket rather than trying to patch this as a
small style tweak.

Suggested scope:

1. Backend session backfill:
   - depth-history ring buffer
   - price/trade-history ring buffer
   - reconnect snapshot/backfill endpoint
2. Frontend hydration:
   - seed price line, volume, CVD, trade bubbles, and depth heatmap from backfill
   - preserve history on reconnect
3. Visual re-layering:
   - heatmap high-contrast amber liquidity bands
   - trade bubbles as executions
   - signal bubbles demoted to smaller optional markers
   - Bookmap-style current-price / DOM alignment
4. QA:
   - page reload preserves prior session history
   - chart axis is PT
   - heatmap displays liquidity bands, not signal-dot rows
   - no console errors

## Immediate Status

- Feed health: good
- Depth quality: live
- Time axis: fixed to PT
- Full-session historical display: not implemented yet
- Bookmap-equivalent heatmap presentation: not implemented yet
