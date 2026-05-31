# Dashboard Runtime Audit - 2026-06-01 Globex

## Scope

Audited the live v2 dashboard after depth was enabled:

- backend health and process memory
- websocket frame rates and sequence behavior
- browser-visible chart, heatmap, DOM ladder, feed, and console state
- code paths for depth heatmap, DOM ladder, websocket reducer, and notification launch

## Live System Health

Backend and capture were healthy during the audit:

- realtime backend: healthy, around 180 MB working set
- Rithmic wrapper/probe: running and writing live Globex capture
- refresh loop: running with `-SkipNormalize`
- Vite UI and notification daemon: running

The issue is not a repeat of the earlier Python memory blowup.

## Finding 1 - Heatmap/Chart Is Clipped By Layout

In the in-app browser viewport, measured layout was:

- app viewport: `487 x 813`
- `.chart-panel`: about `471 x 97`, with `overflow: hidden`
- chart child: `469 x 320`
- lightweight-chart canvases: chart layers taller than the visible panel

So the chart/heatmap is rendering into a 320px-tall component, but the parent
panel is only about 97px high and clips overflow. This makes the heatmap look
like it is not loading or only partially loading.

Relevant code:

- `apps/dashboard_ui/src/styles.css`
  - `.app { grid-template-rows: auto auto 1fr auto auto; height: 100%; }`
  - `.chart-col { grid-template-rows: auto 1fr; }`
  - `.decision-surface { grid-template-columns: minmax(0, 1fr) 184px; }`
  - `.chart-panel { overflow: hidden; min-height: 0; }`
- `apps/dashboard_ui/src/chart/PriceChart.tsx`
  - outer chart wrapper uses `minHeight: 320`

### Recommended fix

Give the decision surface an explicit minimum chart height and a responsive
desktop/mobile split:

- desktop: chart + DOM ladder side-by-side with chart min-height around 520-640px
- narrow viewport: chart full width with min-height around 360-420px, DOM ladder
  below with its own fixed usable height
- avoid letting `.main` compress the chart below the chart component minimum

## Finding 2 - DOM Ladder Is Too Tall For Its Visible Box

DOM ladder measured state:

- 45 DOM rows
- visible row area: about 63px
- row scroll height: about 990px

The ladder is live, but it is squeezed into a tiny scrollbox. This makes it feel
laggy or timed out because only 2-3 useful price rows are visible at a time.

### Recommended fix

- Give DOM ladder a larger fixed/viewport-relative height.
- Consider reducing row count on narrow viewports by using a smaller `n_ticks`
  for the ladder display, or render a compact ladder mode with fewer rows.
- Keep heatmap time history on the chart; keep DOM ladder current-only.

## Finding 3 - Transient `unavailable` Depth Frames Clear Heatmap History

Websocket sample over 30 seconds:

- `depth`: 31 frames
- `price_tick`: 82 frames
- `heartbeat`: 6 frames
- one depth frame ended as `quality: "unavailable"` with empty levels

The heatmap primitive currently clears all retained depth history when
`depthPayloadToColumn(payload)` returns null:

```ts
if (column == null) {
  this.columns = [];
  this.sessionMaxSize = 0;
  this.updateAllViews();
  this.requestUpdate?.();
  return;
}
```

That means a single transient unavailable depth frame can wipe the whole
time x price heatmap even if live depth resumes immediately afterward.

Likely cause:

- backend depth poller derives the depth mid from `latest_price_tick(...)`
- after the strict trade fix, `latest_price_tick` can return `None` when the
  current raw tail has no usable trade within the tiny tail window or fails the
  quote sanity guard
- `resolve_depth_mid(None)` produces `source="none"`
- quality becomes `unavailable`
- snapshot around `mid=None` has no levels

### Recommended fix

Backend:

- retain the last usable `DepthMid` in the depth poller and use it for a few
  seconds when a new tick is unavailable
- classify the result as `stale_l1` or `inferred`, not `unavailable`, while the
  MBO book is still fresh

Frontend:

- do not clear retained heatmap history on a transient `unavailable` frame
- clear only on session change, depth disabled, explicit reset, or prolonged
  unavailable state

## Finding 4 - One Slow Client Can Force All Clients To Resync

The backend logs showed websocket disconnect errors during initial snapshot
send, and the sampled websocket stream observed a sequence gap.

Current server behavior:

- each emitted frame uses global seq
- if any client queue drops a frame, `_broadcast_and_account` increments the
  global seq
- all clients then observe a gap, not only the slow client
- all UI clients may resync via `/snapshot`

This can cause snapshot spam and perceived timeout/lag even when the active
dashboard client is fine.

### Recommended fix

- track per-client dropped-frame state instead of globally skipping seq for all
  clients
- alternatively send a targeted `resync_required` control frame only to the slow
  client
- handle `WebSocketDisconnect` during initial snapshot send without logging a
  full ASGI exception

## Finding 5 - Repeated Iceberg Events Are Noisy

The live feed was dominated by repeated iceberg rows at adjacent prices:

- repeated `ICE` feed items at `30431.00`, `30431.25`, `30431.50`
- DOM ladder also showed repeated ICE chips

This increases visual churn and can make the dashboard feel busy even if the
rendering rate is not high.

### Recommended fix

- coalesce iceberg detections by `(side, rounded price or level_id)` over a
  short rolling window
- update the existing feed item intensity/refill count instead of appending
  another row every time
- keep raw events in history if needed, but feed should show the current
  consolidated state

## Finding 6 - Notification Click Launch Error

The Windows popup:

```text
Unable to find Electron app at C:\Program Files\WindowsApps\OpenAI.Codex...
Cannot find module ...?type=click&tag=...
```

This appears to be a browser/Electron notification activation issue, not a
market-data or chart issue. The frontend browser notification path creates a
standard browser notification with a `tag`. Clicking it makes Windows try to
activate the packaged Codex/Electron app with query parameters, and that launch
fails.

### Recommended fix

- for this dashboard, prefer the dedicated Windows toast daemon or audio-only
  alerts
- disable in-browser notification clicks, or avoid browser notifications when
  running inside the Codex/Electron shell
- keep the native notification daemon as the intended Windows notification path

## Priority Fix List

1. **P0 layout fix**: prevent chart/heatmap clipping and give DOM ladder a
   usable viewport.
2. **P0 depth continuity fix**: do not clear heatmap on transient unavailable
   frames; retain last usable mid in backend depth poller.
3. **P1 websocket backpressure fix**: avoid global seq gaps caused by one slow
   client.
4. **P1 iceberg coalescing**: reduce feed/DOM visual churn.
5. **P2 browser notification handling**: disable or route away from Electron
   activation path.

## Fixes Applied

The following fixes were applied from this audit:

1. **Chart and heatmap layout**
   - `apps/dashboard_ui/src/styles.css` now gives the decision surface, chart
     panel, and DOM ladder real viewport space instead of allowing the grid to
     compress the chart to under 100px.
   - Narrow viewports stack the decision map and ladder vertically with a usable
     fixed minimum height.

2. **Depth heatmap continuity**
   - `apps/dashboard_ui/src/chart/depthHeatmap.ts` now keeps retained
     time x price history on transient `unavailable` depth frames.
   - `services/realtime_backend/watcher.py` retains the last usable depth mid so
     the backend does not unnecessarily emit empty `unavailable` depth snapshots
     when the current tiny trade tail has no strict latest trade.

3. **Websocket resync churn**
   - `services/realtime_backend/feed.py` no longer increments the global `seq`
     when one slow client drops queued frames. The slow client still sees its
     own natural sequence gap from omitted frames; healthy clients no longer get
     forced into REST snapshot resyncs.
   - `services/realtime_backend/app.py` now exits quietly if a browser
     disconnects during the initial websocket snapshot send, avoiding noisy ASGI
     exception logs during dashboard reloads.
   - Connect-time cached depth replay is now sent before the current snapshot so
     a newly loaded dashboard does not see `snapshot seq=N` followed by an older
     `depth seq<N` and immediately self-trigger a resync.

4. **Codex/Electron browser notification popup**
   - `apps/dashboard_ui/src/alerts/AlertEngine.ts` suppresses browser
     Notification API usage inside Codex/Electron shells. Audio alerts and the
     dedicated native notification daemon path remain available.

## Remaining Follow-Up

- **Iceberg coalescing** remains open. Repeated ICE rows/chips are a signal
  presentation problem, not a transport/rendering failure. A separate pass
  should coalesce detections by `(side, level_id or rounded price)` over a short
  rolling window while preserving raw event history.
- **Live visual smoke** should be repeated during an active liquid window after
  the backend restart: confirm the heatmap retains columns through transient
  depth quality changes, DOM rows remain readable, and websocket snapshot spam
  drops from the backend logs.

## Evidence Commands

Websocket sample:

```powershell
python - <<'PY'
# Connected to ws://127.0.0.1:8765/ws and counted frame families for 30s.
# Observed depth ~= 1/sec, price_tick ~= 2.7/sec, one seq gap, one unavailable
# depth frame.
PY
```

Browser layout snapshot:

```text
chart-panel ~= 471 x 97, overflow hidden
chart child ~= 469 x 320
DOM ladder rows visible area ~= 63px, scrollHeight ~= 990px
```
