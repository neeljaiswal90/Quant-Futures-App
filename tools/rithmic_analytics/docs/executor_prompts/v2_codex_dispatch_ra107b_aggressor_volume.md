# Codex Dispatch — RA-107b: aggressor-flow volume split + block-trade emphasis

Coordinator dispatch from a live UI audit dated 2026-06-01. Read `v2_codex_handoff.md` for invariants. Pre-build sweep → green-light → build → verify → ship.

## Why this exists

The current volume pane (per `chart/candles.ts`) renders `tick.volume` summed per 1s bucket, colored green/red by candle direction. Operator review: this is **almost zero decision-relevant signal** for orderflow scalping.

Three reasons it's not useful:

1. **Total volume hides direction.** A bucket with 100 aggressive buys + 100 aggressive sells looks identical to 200 aggressive buys + 0 aggressive sells. Both = 200 lots. The CVD pane shows cumulative net, but the per-bucket gross split is invisible.
2. **Up/down coloring is redundant** with the price line directly above.
3. **No institutional-flow marker.** A bucket with a single 100-lot print looks the same as a bucket with twenty 5-lot prints. Block trades disappear into the bar height.

The data to fix this is **already on the wire**. `OrderflowSnapshot.last_trade_aggressor: "buy" | "sell" | "unknown"` and `last_trade_delta` are present on every price_tick. The candle aggregator already consumes them for CVD via `signedVolume()` but only exposes the net, not the split.

This ticket surfaces the split AND adds block-trade emphasis. UI-only, no contract change, no backend touch.

## Build

### 1. CandleAggregator extension

In `apps/dashboard_ui/src/chart/candles.ts`:

- Extend `CandleAggregator` to track `buyVolume`, `sellVolume`, `largestPrint` per bucket (in addition to the existing `currentVolume`).
- New per-tick logic in `ingest()`:
  - Read `tick.orderflow.last_trade_aggressor`. If `"buy"` → bucket.buyVolume += tick.volume. If `"sell"` → sellVolume. If `"unknown"` → fallback to signed-via-last-price (existing `signedVolume` heuristic), accumulate into the corresponding side.
  - Track `largestPrint = max(largestPrint, tick.volume)` per bucket.
  - On bucket roll-over, reset all three for the new bucket.
- New return shape from `ingest()`:
  ```typescript
  {
    candle: Candle,
    buyBar: HistogramData,   // value: +buyVolume, color: greenWithBlockEmphasis
    sellBar: HistogramData,  // value: -sellVolume, color: redWithBlockEmphasis
    cvd: LineData,
    hasBlockTrade: boolean,  // true if largestPrint >= BLOCK_TRADE_LOTS
  }
  ```
- `BLOCK_TRADE_LOTS = 25` (matches RA-105a's block-trade chart bubble threshold; consistent semantics across the UI).
- `seedFromHistory()` similarly produces `buyBars[]`, `sellBars[]` instead of single `volumes[]`. Backfill from the obs01-derived aggressor field if available; if not, fall back to the `signedVolume` heuristic from the existing code path.

### 2. PriceChart wiring

In `apps/dashboard_ui/src/chart/PriceChart.tsx`:

- Replace the single `volumeRef` (HistogramSeries) with two refs:
  - `volumeBuyRef: ISeriesApi<"Histogram">` — positive values, green family
  - `volumeSellRef: ISeriesApi<"Histogram">` — negative values, red family
- Both attached to the same `priceScaleId: "vol"` so they share the volume axis. The axis now displays both positive and negative values centered on zero — explicit zero baseline (operator-readable).
- Per-tick update path: from `aggregator.ingest()` result, call `volumeBuyRef.update(buyBar)` and `volumeSellRef.update(sellBar)` instead of single `volume.update`.
- `seedFromHistory()` path similarly populates both series via `setData()`.

### 3. Block-trade emphasis (color modulation)

Per-bar color:

- Normal bucket (no block trade): `rgba(34, 197, 94, 0.65)` (green-500 at 0.65 alpha) for buys, `rgba(239, 68, 68, 0.65)` (red-500 at 0.65 alpha) for sells.
- Block-trade bucket (`hasBlockTrade === true`): same hue, **alpha bumped to 1.0** for visual emphasis. Operator sees the saturated bars stand out from the lighter sea of normal-flow bars.
- Color is passed via the HistogramData `color` field per-bar (lightweight-charts supports per-bar color in the histogram series).

No new chart primitives — pure data-driven coloring of the existing histogram series. Avoids autoscale re-entrancy concerns entirely.

### 4. Carve-out from the RA-100/RA-103 green/red rule

The RA-100/RA-103 invariant says **saturated green/red is reserved for trade executions on the price chart**.

RA-107b explicitly carves out the **volume pane** as an aggressor-flow visualization that uses green/red for buy/sell aggression:

- **Why the carve-out is correct here**: aggressor flow IS directional volume — the semantic match with green=buy, red=sell is overwhelming. Forcing pink/sky here (the RA-107a polarization palette) would create a new visual disconnect because operators read aggressor flow as buy/sell, not as ask/bid.
- **Boundary**: the volume pane lives below the price chart with its own axis and is clearly a SECONDARY pane. There is no risk of confusing an aggressor-flow bar with a price-chart trade execution marker — they're spatially separate, and the volume pane never renders individual trade markers.
- **What stays reserved**: saturated execution-green (`#3fb950`) and execution-red (`#f85149`) remain reserved for trade-execution markers ON the price chart. The volume-pane palette uses green-500 (`#22c55e`) and red-500 (`#ef4444`) which are visually distinct from the execution palette by hue saturation. Codex must NOT use the execution palette for the volume bars.

Update `apps/dashboard_ui/src/styles.css` top-of-file carve-out comment block:

```css
/*
 * Color carve-out summary:
 * - Saturated execution-green #3fb950 + execution-red #f85149: RESERVED for
 *   trade-execution markers on the price chart (RA-100/RA-103).
 * - Pink-400 #f87171 + sky-400 #38bdf8: liquidity-context palette for
 *   heatmap cells, iceberg coverage bands, wall markers (RA-107a). Ask = pink,
 *   bid = sky.
 * - Green-500 #22c55e + red-500 #ef4444: aggressor-flow palette in the
 *   volume pane (RA-107b). Buy aggression = green, sell aggression = red.
 *   Distinct from execution colors by hue saturation; spatially confined to
 *   the secondary volume pane.
 */
```

### 5. Tests

`apps/dashboard_ui/src/chart/candles.test.ts` (modified):

- Fixture: feed 10 ticks with explicit `orderflow.last_trade_aggressor` values (mix of "buy"/"sell"/"unknown"). Assert per-bucket `buyVolume` + `sellVolume` accumulate correctly. Assert the "unknown" tick falls back to signed-via-last-price.
- Fixture: feed a tick with `volume = 25` (exactly threshold). Assert `hasBlockTrade === true`. Feed a tick with `volume = 24`. Assert `hasBlockTrade === false`.
- Fixture: feed multiple ticks per bucket with one ≥25-lot print + others smaller. Assert `largestPrint` captures the max; `hasBlockTrade === true` for the bucket.
- Assert bucket roll-over resets all three (`buyVolume`, `sellVolume`, `largestPrint`).

`apps/dashboard_ui/src/chart/candles.test.ts` `seedFromHistory()` tests similarly updated to assert split bars from historical ticks.

## Hard invariants

- **UI-only.** Path scope: `apps/dashboard_ui/src/chart/` + `apps/dashboard_ui/src/styles.css`. NO contract change, NO backend touch, NO detector change, NO capture/probe/scheduler/.env change.
- **No new chart primitives.** Use existing `HistogramSeries` with two instances + per-bar color. Avoids autoscale re-entrancy entirely.
- **No `Math.min(...arr)` / `Math.max(...arr)` spread patterns.** Per [[math-minmax-spread-antipattern]]: grep before merging.
- **Carve-out from green/red rule documented in styles.css.** Per RA-100/RA-103.
- **Existing CandleAggregator API surface preserved.** Existing callers of `ingest()` must keep working OR be updated in the same commit. Don't break RA-107's persistence accumulator or RA-105a's chart bubbles.
- **Surgical path-scoped commit.** Stage only the changed chart files + styles.css. Verify with `git diff --cached --name-only` before commit. The worktree dirt must not be bundled.

## Pre-build sweep gate

Sweep must cover:

1. **Live `orderflow.last_trade_aggressor` field availability** — sample the WS stream for 5 min. What fraction of price_tick frames carry `last_trade_aggressor != "unknown"`? If the fraction is below 50%, the "unknown" fallback (signed-via-last-price heuristic) becomes the primary path, not a fallback — flag in the sweep.
2. **Backfill aggressor field** — does the `/api/bookmap-backfill` `price_ticks` array include `aggressor_side`? If yes, the seedFromHistory path produces accurate split. If no, backfill bars use the heuristic and live bars use the wire data — visually OK but slightly inconsistent. Note in the sweep.
3. **Histogram series support for per-bar color + negative values** — confirm via a small lightweight-charts API check that:
   (a) Two HistogramSeries on the same `priceScaleId` render correctly with one having negative values
   (b) Per-bar `color` field overrides the series default
   If either is missing, propose a fallback design.
4. **Block-trade threshold alignment** — RA-105a used `BLOCK_TRADE_LOTS = 25` for chart-bubble emphasis. Codex confirms the same constant is used here for consistency, OR proposes a different value with reasoning.
5. **Zero-baseline rendering** — confirm the volume axis shows the zero baseline clearly. Operator must instantly see "this bucket is biased buy" vs "biased sell" from the visual axis crossing.
6. **Confirmation no contract / backend / detector / capture / probe touch.**

## Acceptance

- Before/after side-by-side screenshots of the volume pane during a live session. The "after" image shows clear stacked-with-zero-baseline green-up + red-down bars per bucket. The eye instantly reads which buckets are buy-biased vs sell-biased.
- During a high-flow burst, the block-trade buckets stand out (saturated bars among lighter neighbors).
- vitest passes (extended candles tests + any modified PriceChart tests).
- tsc / lint / build clean.
- Grep `Math\.(min|max)\(\.\.\.` over the diff returns zero matches.
- `styles.css` carve-out comment block updated.
- Commit is path-scoped to chart files + styles.css only.

## Coordinator review focus

Three operator-readability checks:

1. Can I look at the volume pane and instantly tell "this minute had aggressive buying" vs "this minute had aggressive selling" without reading any numbers?
2. When a block trade hits, does its bar visually stand out from the surrounding bars?
3. Does the zero-baseline give me a clear "balance vs imbalance" read across the time window?

If all three are yes, RA-107b is shipped.

## Priority

Sequential after RA-107a. Independent of RA-094 (gated on RA-093b report) and RA-109 (perf profile). Half-day Codex work. Operator-readability impact is high — the volume pane goes from near-zero info-density to one of the most decision-relevant panes on the chart.

## Future option (out of scope; for the operator)

- **RA-107c** — block-trade tick markers. Currently block-trade emphasis is a bucket-level alpha bump. A future ticket could mark the EXACT timestamp of the block print with a small vertical tick on the bar, so operators see "the 100-lot print hit at 09:02:14" not just "this minute had a block." Hold.
- **RA-107d** — institutional-flow detector signal. Stream-level signal that fires when block-trade clustering crosses a threshold (e.g., ≥ 3 block trades in 10s). Emitted to LiveFeed as a discrete event. Contract addition; defer until RA-094 lands.
- **RA-107e** — per-bucket aggressor ratio normalization. Currently bars scale with absolute lots; a future option could normalize to "% aggressor share" per bucket so a quiet minute with 95% sell aggression visually stands out as much as a heavy minute with 50/50 chop. Hold — current absolute-lots view is more familiar to most operators.
