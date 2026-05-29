# Codex Dispatch — RA-077 chart rework: price-anchored events + Bookmap-style + CVD/quant panel

Coordinator/reviewer wrote this from a UI diagnostic. Work it phased; pre-build
sweep per phase, wait for green-light. Read `v2_codex_handoff.md` first for
invariants/verification/commit discipline. (RA-073/074 appear shipped — the feed
hydrates and the reducer handles `price_tick`; those get a separate review.)

---

## Diagnosis (confirmed by the coordinator)

The chart's event markers do not track the price scale — you can't tell at what
price an event occurred. Root causes:

1. **`useEventMarkers.ts` uses `createSeriesMarkers`**, whose markers are anchored
   to a bar's TIME with `aboveBar`/`belowBar` placement — **no price-Y
   coordinate.** Events pin to the bar top/bottom and stack into a column;
   zooming the price scale can't move them. (Zones use `createPriceLine` and
   correctly track price — that's the contrast you see.)
2. **`FeedItem` (`src/contract/render.ts:198`) drops the event `price`** — it
   carries `tsNs/tier/family/text` only, though the `sweep`/`iceberg`/`absorption`
   payloads all have `price`. So there is currently no price to anchor to.
3. Live candle stream: RA-073 (price_tick) just shipped; the live backend must be
   restarted (operator) to actually emit it, and true-live needs the RA-070
   cutover. Independent of the marker bug — fix the markers regardless.

## Research finding (the fix)

lightweight-charts **series markers are fundamentally time/bar-anchored — they
cannot sit at an arbitrary price.** The v5-blessed way to draw at `(time, price)`
is a **custom Series/Pane Primitive** (`ISeriesPrimitive` → `paneViews()` →
`IPrimitivePaneRenderer.draw(CanvasRenderingTarget2D)`), using `attached()`'s
chart/series handles to convert each event's `(time, price)` →
`series.priceToCoordinate(price)` + `chart.timeScale().timeToCoordinate(time)` →
pixel `(x, y)`, redrawn via `requestUpdate()`/`updateAllViews()` on scale/scroll.
That anchors events to BOTH axes → Bookmap-style bubbles that move with zoom and
read at their price.

Bookmap reality check: a full Bookmap is a **liquidity heatmap** (price × time,
color = resting size) + trade bubbles + CVD. lightweight-charts is not a heatmap
engine. A custom pane primitive can render **event bubbles at price** now; a true
liquidity heatmap needs MBP-10 depth piped through the contract + a heavier
primitive — deferred (RA-077c).

---

## Phased tickets

### RA-077a — price-anchored event layer (P0, the reported bug)
- Thread the event **`price`** into the marker model: add `price` to `FeedItem`
  (and the snapshot/feed mappings in `render.ts`) from the payloads that carry it
  (`sweep`/`iceberg`/`absorption`/signal where present). **No contract change** —
  the wire payloads already have `price`; this is a UI-side mapping fix.
- Replace `createSeriesMarkers` in `useEventMarkers.ts` with a **custom
  primitive** that draws each event as a bubble/dot at `(time, price)` via
  `priceToCoordinate`/`timeToCoordinate`, colored by tier/family, sized by
  intensity. Markers must move with both zoom and scroll.
- Keep zone price-lines (`useZonePriceLines`, already correct) + the candle
  stream (RA-073). Bound the drawn set by `HISTORY_CAP`; redraw efficiently.
- Acceptance: zoom/scroll the price scale → event bubbles track their price;
  hovering/reading an event shows its price. vitest + tsc + eslint + build green;
  a render/coordinate unit test for the primitive's (time,price)→(x,y) mapping.

### RA-077b — shrink chart + CVD panel + quant-computations panel (P1)
- Restructure the Tier-4 region: **smaller main chart** + a dedicated **CVD
  panel** + a **quant-stats panel** (delta, footprint imbalance, absorption
  ratios, σ-band stats — the readouts a discretionary trader uses). A CSS
  grid/flex split (optionally resizable).
- **CVD data gap (coordinate before building):** the chart's existing CVD pane is
  client-derived from `price_tick` volume, but `price_tick` carries no
  aggressor/delta, so CVD can't be computed correctly client-side. The backend
  HAS aggressor/CVD (RA-058). Surface it to the UI via **additive `price_tick`
  metadata** (e.g., `delta`/`cvd`) or a **new `cvd`/`aggressor` family** (RA-050
  extensibility — additive, no shape change to existing families). This is a
  contract touch → **pre-build sweep must propose the exact additive shape and I
  green-light it before you edit `events.py`/`events.ts`** (parity tripwire).
- Quant panel reads the snapshot + feed (and the new CVD/delta field) — no new
  backend logic beyond surfacing what RA-058 already computes.
- Acceptance: chart smaller, CVD panel shows a real CVD series, quant panel shows
  live stats; layout responsive; the contract addition passes the parity tripwire.

### RA-077c — liquidity heatmap (P2, research/defer)
Bookmap-style resting-liquidity heatmap from MBP-10 depth. Needs depth piped
through the contract + a heavy custom primitive. **Out of scope for now** —
sweep a research note when RA-077a/b land, don't build blind.

---

## Constraints

- **Frozen contract:** RA-077a needs NO contract change (price already on the wire
  payloads — UI mapping only). RA-077b's CVD/delta surfacing IS a contract touch →
  additive only (new field/family), `events.py` ⇄ `events.ts` together, parity
  tripwire green; **propose the shape in the sweep, get green-light first.**
- Keep zone price-lines + the candle stream working; don't regress RA-073/074.
- Read-only decision support; never add trade execution.
- Surgical path-scoped commits (UI = `apps/dashboard_ui`; if RA-077b touches the
  backend/contract, those packages too). Never stage `capture-rithmic-probe.py`.
- Don't adopt a community charting wrapper; use the lightweight-charts primitive
  API directly (handoff §8).

## First action

Pre-build sweep for **RA-077a** (the bug fix) — the primitive design, how you
thread `price` into `FeedItem`/mappings, the redraw/perf approach, and the test
plan. RA-077b's sweep comes after RA-077a lands (and must include the proposed
contract-additive CVD shape for my review). Wait for green-light before source.
