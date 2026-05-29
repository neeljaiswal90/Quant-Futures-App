# `apps/dashboard_ui` — RA-061 (skeleton created by RA-067)

**Owned by RA-061.** No other parallel ticket writes here.

## What goes here

Greenfield single-page app: **Vite + React 18 + TypeScript**, importing the
RA-067 TypeScript types from `contracts/realtime/events.ts`. Replaces the v1
HTML view entirely.

- WebSocket client with reconnect-with-backoff + seq-gap → REST `/snapshot`
  resync.
- Price surface: **TradingView lightweight-charts v5.2**
  (`npm i lightweight-charts`, Apache-2.0). Candlesticks via
  `chart.addSeries(CandlestickSeries, …)`; price lines for zones/σ-bands;
  `createSeriesMarkers` for discrete events; second pane for volume/CVD;
  per-tick `series.update()` (NOT `setData`, which full-redraws).
- 5-tier layout: alert banner / active scenarios / live feed / price
  context + chart / collapsed history + settings.
- Browser Notifications API + Web Audio for CRITICAL alerts.
- React integration is the documented `useRef`+`useEffect` lifecycle — **no
  community chart wrapper dependency**.
- Keep the TradingView attribution link in the footer (Apache-2.0 terms).

## Binds to the contract

Imports `contracts/realtime/events.ts` and `config.ts`. Develops entirely
against the RA-067 mock emitter (`ws://127.0.0.1:8765/ws`) — zero
dependency on RA-060 landing.

See `docs/tickets.md` → RA-061 and `docs/v2_realtime_architecture.md` §3
(lightweight-charts evaluation).
