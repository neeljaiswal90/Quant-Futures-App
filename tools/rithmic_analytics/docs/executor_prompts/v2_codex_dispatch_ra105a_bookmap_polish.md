# Codex Dispatch — RA-105a: Bookmap-parity polish (heatmap contrast, DOM scrollability, pane labels, directional CVD)

Coordinator dispatch from a UI audit dated 2026-05-31 against `c569c3a`/the committed RA-105 baseline. Read `v2_codex_handoff.md` for invariants. Pre-build sweep → green-light → build → verify → ship.

## Why this exists

RA-105 landed dashboard layout + heatmap intensity tuning + institutional fill coverage, but the live shell still has four UX problems an operator hits in seconds:

1. **Heatmap is orange fog, not Bookmap walls.** Every positive depth level renders visible because `depthCellOpacity = 0.04 + sqrt(size/sessionMax)*0.81`. A level at 10% of session max paints at 30% opacity. Stacked across 100 columns × ~150 levels per column = visual mud, no contrast. Bookmap's signature is **black background + sharp orange/yellow bands where size persists**, not "every level is orange."
2. **DOM ladder is price-following, not operator-scrollable.** `DomLadder` keeps a `centerPrice` that auto-recenters on the active price; `.dom-ladder-rows { overflow: hidden }` blocks wheel scroll. RA-104 raised `n_ticks` to 100 but the operator can see only the ~25 rows that fit on screen — exactly the rows near current price. The far-from-price liquidity walls that RA-104 was supposed to surface are invisible.
3. **Volume + CVD secondary panes are unlabeled.** Both panes are bare series; the operator reads current values from the top text bar, never from the pane itself. Glance cost is 2 saccades when it should be 0.
4. **CVD line is direction-ambiguous.** Single `#a371f7` (purple) line with no zero baseline, no sign-based coloring, no flip markers. Direction is invisible without reading the top text. CVD direction is arguably the second-most-important read on the chart after price.

All four are UI-only, all in `apps/dashboard_ui/src/`. None require contract change, backend touch, or detector work.

## Build

### 1. Heatmap contrast model

Goal: dark, mostly-quiet cells with sharp saturated bands only where size persists. Three knobs Codex sweep must pick from (propose one, list trade-offs):

- **(a) Hard size floor**: cells below `THRESHOLD_FRACTION × rollingMax` paint at 0 opacity. Simple, deterministic. `THRESHOLD_FRACTION` ~ 0.05 starting point.
- **(b) Percentile filter**: cells below the `p_50` (median) of in-window column sizes paint at 0. Adapts to session character (low-volume night vs high-volume open).
- **(c) Top-N per column**: only the N largest levels per timestamp render. Closest to Bookmap aesthetic but loses temporal liquidity-evolution.

Coordinator lean: **(b) with `p_60` floor + rolling-window max instead of session-wide max**. Adaptivity matters because a 5-min session-open burst should not flatten the whole session's visualization. Codex may propose (a) or (c) with reasoning in the sweep.

Additional sub-knobs:

- **Power scale**: replace `sqrt(size/sessionMax)` with `(size/rollingMax)^2.0` (or higher). Stronger curve = thinner low-end, more headroom for walls.
- **Rolling window for max**: use trailing N-minute (e.g., 10 min) max instead of session-wide. Avoids one early spike flattening all visualization.
- **Wider opacity range**: current `0.04 → 0.85`; widen to `0.0 → 0.95` so high-end walls are visually unmistakable AND filtered cells are truly invisible (0, not 0.04).
- **Color palette**: keep amber/orange family but consider a brighter saturated mid-tone (e.g., `rgba(255, 180, 60, x)` instead of the current dark red-orange blend). Codex should A/B this in the sweep.

Acceptance: at default `n_ticks=100`, a quiet-period sample frame shows mostly black with 2-4 clearly visible orange/yellow horizontal bands at the levels with persistent size. NOT 100 levels of orange.

File: `apps/dashboard_ui/src/chart/depthHeatmap.ts`. Tests in `depthHeatmap.test.ts` must extend to assert: (i) a fixture column with 100 small levels + 1 large one renders only the 1 large one at full opacity, the 100 at 0; (ii) the rolling-window max responds to size changes within the window.

### 2. DOM ladder manual navigation

Operator must be able to scroll the visible window up/down by ticks WITHOUT the ladder snapping back to live price.

- New state: `centerPriceMode: 'follow' | 'manual'` (default `'follow'`).
- New `centerPriceOffset: number` (in ticks) — used only in manual mode.
- Wheel handler on `.dom-ladder-rows`: each wheel tick shifts `centerPriceOffset` by ±1 tick (configurable; ±2 or ±4 may be better — propose in sweep). Switches mode to `'manual'`.
- Optional: keyboard arrows (`↑` / `↓`) also shift, also switches to manual.
- New floating control row at the top of the DOM panel:
  - **`Follow price`** toggle button. When ON, mode auto-snaps to `'follow'` and `centerPriceOffset` resets to 0. When OFF, ladder stays where the operator scrolled it.
  - **`Recenter`** button — one-shot: switch to `'follow'` (which resets offset to 0) and stay there.
  - Visual indicator: small chip showing "Follow ON" (green) or "Manual" (yellow) for current state.
- `.dom-ladder-rows` overflow remains `hidden` (no native scrollbar); navigation is exclusively through `centerPriceOffset`. This avoids the scrollbar-implies-data-you-cant-see UI confusion that RA-105 already removed.
- Tick-aligned rendering: the rendered rows are `centerPrice + centerPriceOffset × MNQ_TICK` ± `visibleRadiusTicks` rows. This MUST stay aligned with the chart's price-axis ticks so the DOM and chart visually correspond.
- Far-from-price empty rows: if the operator scrolls beyond what the backend's `n_ticks` window covers, render those rows EMPTY (no bid/ask sizes, just the price label). This is the correct degenerate state — pairs with RA-104. NO new contract field needed.

Files: `apps/dashboard_ui/src/components/DomLadder.tsx`, `apps/dashboard_ui/src/components/domLadderModel.ts`. Tests in `DomLadder.test.tsx` must assert: (i) wheel event shifts centerPriceOffset; (ii) Follow toggle resets offset; (iii) Manual mode does NOT snap to live price changes; (iv) Recenter switches to follow.

### 3. Secondary pane labels

Volume and CVD panes each get an overlay label group rendered in absolute-positioned divs over the chart container (NOT inside the lightweight-charts canvas — too invasive).

- **Volume pane label**: top-left of the pane, format `VOL  <last-bar-value>  (<bullish|bearish>)`. Color: muted text + small color-coded direction badge. Hover tooltip: rolling-window average.
- **CVD pane label**: top-left of the pane, format `CVD  <current-cvd>  Δ <last-bar-delta>  (<bullish|bearish>)`. Direction badge color follows the cvd-pane palette (green/red per Build #4).
- Implementation: two new `<div className="chart-pane-label">` overlays inside the chart container's relative-positioned wrapper. They read current values from the same refs the existing per-tick update loop uses (`tickEpoch` / `liveTickRef`). NO React state in the hot path — refs only, updated imperatively, matches the per-tick discipline.
- Positioning: absolute, top-offset matches each pane's `scaleMargins.top` in `PriceChart.tsx`. Codex must wire pane y-offsets correctly so labels don't sit over candles.

File: `apps/dashboard_ui/src/chart/PriceChart.tsx` (overlay divs + ref-driven text updates), `apps/dashboard_ui/src/styles.css` (`.chart-pane-label` class). Tests: not strictly required (visual-only); but verify the label text content updates when the refs are mutated in a test harness.

### 4. Directional CVD with flip markers

CVD pane currently uses a single-color line series. Replace with a direction-aware visualization:

- **Sign-based segment coloring**: line segments where CVD > 0 painted green (`#3fb950`), segments where CVD < 0 painted red (`#f85149`). Lightweight-charts supports per-point color via `LineSeries` with `colorPoint` arrays OR splitting into two series stacked on the same scale. Codex picks the cleanest implementation; propose in sweep.
- **Zero baseline**: solid horizontal line at y=0 across the full visible time range. Color: muted gray (`#30363d`) or border color. This is the single most useful visual reference for direction.
- **Flip markers**: at each timestamp where CVD crosses zero (sign change), render a small vertical tick on the time axis of the CVD pane. Same primitive infrastructure as RA-105's CRITICAL vertical lines (verify it returns `null` from `autoscaleInfo()` per [[lightweight-charts-autoscale-reentrancy]] memory).
- **Backend-driven flip integration (optional)**: if `SignalPayload` already exposes an `orderflow.momentum_flip` boolean OR a per-tick `last_trade_aggressor` flip signal, render those as STRONGER vertical lines distinct from local sign-cross flips. Codex must verify the field exists in `contracts/realtime/events.py` first — if it doesn't, this sub-item is deferred to a separate contract dispatch and only local-sign-cross flips render.

Carve-out for the green/red palette rule: per RA-100/RA-103, green/red are reserved for **trade executions on the price chart**. The CVD pane is a separate visual context with its own axis, and direction is its primary read. **Carve-out allowed**: green/red for CVD line + zero baseline + flip markers. Do NOT reuse green/red anywhere else in this ticket (heatmap stays amber, DOM badges stay yellow/green-but-not-execution-green, etc).

File: `apps/dashboard_ui/src/chart/PriceChart.tsx` (CVD series replacement) + possibly a new `cvdDirection.ts` for the segment-coloring primitive. Tests in a new `cvdDirection.test.ts`: (i) positive segments use green; (ii) negative segments use red; (iii) zero-cross creates a flip marker at the correct timestamp.

## Hard invariants

- **UI-only.** Path scope: `apps/dashboard_ui/src/`. No `contracts/`, no `services/`, no detector touch, no capture/probe/scheduler/.env change.
- **No backend emission changes.** Heatmap intensity model reads existing depth payloads. DOM navigation is client-side. Pane labels read existing refs. Directional CVD reads existing `cvd.value` (positive or negative).
- **No new contract field.** If directional-CVD's backend-driven flip markers require a `momentum_flip` field that doesn't exist on `SignalPayload`, that sub-item is DEFERRED to a separate additive-contract ticket — flag it in sweep, don't sneak it in here.
- **Autoscale re-entrancy.** Per [[lightweight-charts-autoscale-reentrancy]]: any NEW chart primitive (CVD segment coloring if implemented as a primitive, flip-marker primitive) MUST return `null` from `autoscaleInfo()`. The price line + zones own autoscale.
- **`Math.min(...arr)` spread.** Per [[math-minmax-spread-antipattern]]: never spread large arrays. Grep `Math\.(min|max)\(\.\.\.` before merging.
- **RA-100/RA-103 green/red rule.** Green/red reserved for trade executions on the price chart. CVD pane is the only carve-out approved by this ticket. Heatmap stays amber/orange. Event bubble palette unchanged from RA-103. DOM tier badges may not use execution-green.
- **Surgical path-scoped commits.** Stage only RA-105a files. The worktree dirties easily. Three commits acceptable: (1) heatmap contrast, (2) DOM manual nav, (3) pane labels + directional CVD.

## Pre-build sweep gate

Sweep must cover:

1. **Heatmap contrast knob choice** — pick (a)/(b)/(c) above with reasoning. Show the math: at a fixture session-max=500 lots, what opacity does a 10-lot level render at? A 100-lot? A 400-lot? Side-by-side vs current behavior.
2. **DOM navigation UX** — wheel sensitivity (1 tick? 4 ticks? configurable?), button placement (top of panel? floating?), keyboard arrow support yes/no.
3. **Pane label positioning** — exact y-offsets for VOL and CVD overlays, showing how they align with `scaleMargins.top: 0.1` (volume) and `scaleMargins.top: 0.6` (cvd) from the existing `PriceChart.tsx` config.
4. **CVD direction-coloring strategy** — split-series vs per-point colorPoint vs custom primitive. Show the lightweight-charts API call for the chosen approach.
5. **`momentum_flip` field audit** — does `SignalPayload` or its `orderflow` nested type already expose a flip signal? If not, this sub-item defers — flag explicitly.
6. **Confirmation no backend/contract/detector/capture change.**

## Acceptance

- Heatmap: a screenshot of a quiet-period frame shows mostly black with 2-4 saturated horizontal bands. Side-by-side before/after. NO orange fog.
- DOM: operator scrolls wheel up — center price shifts up by configurable ticks, ladder shows rows above current price. "Follow price" toggle visibly OFF. "Recenter" snaps back to live price + toggle goes ON. Before/after screenshots demonstrating manual navigation.
- Volume + CVD pane labels: visible overlay text showing current values + direction badges. Updates every tick. Screenshot.
- CVD: line is green when CVD > 0, red when CVD < 0, with visible zero baseline and flip markers at sign-cross timestamps. Screenshot showing at least one bullish→bearish (or vice versa) flip.
- vitest 130+ passed; tsc, lint, build clean.
- No new contract field unless flagged + deferred.
- Surgical path-scoped commits — stage only RA-105a paths.

## Coordinator review focus

The headline is the heatmap. Bookmap parity has been the operator's clearest visual complaint for two sessions running. The dispatch should ship the heatmap fix FIRST commit, surface a before/after screenshot, and only proceed to commits 2-3 if the heatmap looks right. If Codex's first commit still has orange fog, kick it back for tuning before shipping the rest.

## Priority

After RA-094 (`scalp_score`) lands. RA-105a is operator-quality-of-life polish, not a blocker for the scalping pipeline critical path. But the heatmap fix is the single biggest visible improvement available right now, so don't sit on it for more than 1-2 sessions after RA-094 ships.

## Future option (out of scope; for the operator)

If DOM manual navigation reveals systematic blind spots (e.g., operator finds themselves frequently scrolling to specific far-away levels), RA-105b could add **pinned price levels**: operator clicks a far-away price, ladder anchors to it as a secondary visible window. Hold for now — start with simple manual nav and see if it's enough.
