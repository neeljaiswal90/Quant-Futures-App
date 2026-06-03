# Path A — Bookmap-parity heatmap (texture-based, 2-week scope)

**Date:** 2026-06-03
**Decision:** approved 2026-06-03 — pursue continuous-gradient texture-based heatmap rendering. Keep Lightweight Charts for candles + axes. Bookmap-style trade dots as separate GPU pass.

> **The fundamental shift.** Move from "render N discrete quads, one per depth cell" to "render one fullscreen quad, sample a 2D texture per pixel via bilinear filtering." The texture stores the persistence-accumulator state on a `(column × price)` grid. Bilinear sampling = smooth continuous gradient. This is how Bookmap actually renders its heatmap.

---

## The architecture shift

### Current (RA-115 Phase 1+2, shipped today)

```
DepthPersistenceAccumulator (Map<price, score>)
    ↓
DepthHeatmapPrimitive.columns: DepthHistoryColumn[]  (ring buffer of ~200 columns)
    ↓
GPU layer projects to instances: { time, price, intensity, side, ... } × N
    ↓
Instanced draw: N quads, each colored by its cell's intensity
    ↓
Bloom (vertex-quad expansion) for bright cells
```

**Visual result:** discrete colored cells, ~1.5px each, visible as dots especially when zoomed out. Bloom helps walls but base rendering is cellular.

### Target (Path A)

```
DepthPersistenceAccumulator (per column)
    ↓
DepthHistoryColumn[] (existing ring buffer — UNCHANGED)
    ↓
GPU "heatmap texture" — 2D R32_FLOAT, sized PRICE_BUCKETS × COLUMN_BUCKETS
  - Each texel = (intensity, side, age) packed into one or more channels
  - Updated incrementally: new columns shift the texture content (or use a
    ring-buffer offset uniform); CPU writes only the latest column's slice
    ↓
Heatmap fragment shader:
  - One fullscreen quad covering the pane
  - For each fragment: derive (time, price) from pixel coords + camera
  - Sample the texture at (time, price) with bilinear filter
  - Apply color palette + contrast curve
  - Output RGBA
    ↓
Trade dot pipeline (separate pass):
  - Instanced SDF circles
  - Per-instance: time, price, color (bid/ask), size (by volume), age
  - Pulse animation in shader on recent trades
    ↓
LC continues to render candles + axes underneath
Signal bubbles HIDDEN by default (toggle to show)
```

**Visual result:** continuous gradient. Walls glow naturally because adjacent pixels share interpolated intensity. Trade dots overlay as the secondary visual layer. Looks like Bookmap.

---

## Data structure: the heatmap texture

### Format

```
texture format: R32_FLOAT (single channel, full precision)
dimensions: 512 (price bucket axis) × 512 (column axis)  -- tunable
total memory: 512 × 512 × 4 bytes = 1 MB per texture, negligible
```

### Encoding

Each texel stores **signed intensity**:
- `0.0` = no liquidity at this (column, price)
- `+x` = bid-side liquidity, magnitude = intensity (0..1)
- `-x` = ask-side liquidity, magnitude = intensity (0..1)

(Single-channel encoding via sign. Alternative: two-channel `R8G8` for (bid, ask) separately if more visual flexibility is needed. Start with signed single-channel for simplicity.)

### Bucket mapping

**Price axis (rows):** 512 buckets across the visible price range. At a typical 160-pt visible range, each bucket = 0.31 points ≈ 1.25 ticks. Sub-tick resolution.

**Column axis (cols):** 512 columns across the visible time range. At 5-min visible range, each column = ~0.6 seconds. Matches roughly the backend's 4Hz depth emit cadence.

### Update strategy

**Ring buffer of columns.** A `currentColumn` uniform (modulo 512) advances each new depth payload. Each frame:
1. CPU writes the latest column's price-bucket slice to the texture at offset `currentColumn`
2. Shader samples texture via UV that maps `pixel_col` → `(currentColumn - pixel_col_offset) mod 512`
3. As `currentColumn` advances, the visual scrolls left automatically

**Bilinear filter** is set on the texture sampler. WebGPU's hardware bilinear handles per-fragment interpolation natively. No additional shader work.

**CPU cost per frame:** one `writeTexture` of 512 floats = 2 KB per depth payload (~4 Hz). Negligible.

---

## Phased implementation (2 weeks)

### Week 1 — Texture heatmap foundation

| Day | Work |
|---|---|
| 1 | **Foundation files**: `src/chart/gpu/heatmapTexture.ts` (texture lifecycle + ring-buffer write), `src/chart/gpu/heatmapTexture.wgsl` (new shader: fullscreen quad, sample texture, palette). Texture format decision (R32_FLOAT signed). |
| 2 | **Texture write pipeline**: CPU writes incremental per-column updates from `DepthHistoryColumn` data. Coordinate sync from existing LC layer. |
| 3 | **Fragment shader**: pixel → world coords → texture UV → bilinear sample → palette → RGBA. Color palette decision — start with Bookmap-inspired (deep blue/cyan for bid, deep red/orange for ask, dark at zero). |
| 4 | **A/B switch**: feature flag selects new texture-based pipeline vs. old instanced-cells. Default: texture-based. Compare visuals side-by-side on dev server. |
| 5 | **Polish**: contrast tuning, bilinear vs. nearest-neighbor sampling A/B, performance check (should be way under 1ms GPU per frame). |

**Acceptance Week 1:** the heatmap renders as a smooth continuous gradient with no visible cells, on real live depth data. Pan/zoom is smooth (uniform updates only). Visual is recognizably Bookmap-style.

### Week 2 — Trade dots + polish

| Day | Work |
|---|---|
| 6 | **Trade dot pipeline foundation**: `src/chart/gpu/tradeDots.ts` + `tradeDots.wgsl`. Read trade events from the existing tradeBubbles primitive's column buffer (extract the data layer; replace only the renderer). |
| 7 | **Instanced trade dots**: per-trade quad → SDF circle in fragment. Color by aggressor. Size by volume (with sensible min/max clamps). |
| 8 | **Pulse animation**: age-based alpha in shader. Recent trades (last ~500ms) pulse via `sin(age * π / 0.5)` ramp. Old trades stay solid. |
| 9 | **Hide signal bubbles by default**: feature flag in `useEventMarkers` to disable Canvas2D event bubbles. Add a toggle in the existing UI controls. Tune color palette to match Bookmap better. |
| 10 | **Final polish**: pixel-perfect alignment between heatmap texture grid and LC's time axis. Handle DPR changes. Test on cold-reload backfill. |

**Acceptance Week 2:** dashboard's main pane reads visually as Bookmap-equivalent. Trade dots are the secondary visual layer. Signal bubbles are off by default (analyst can toggle). Pan/zoom smooth at 60+ FPS even during high volume.

---

## What stays unchanged

- Backend (depth emit, persistence accumulator, signal pipeline) — no changes needed
- `DepthHistoryColumn` / `DepthPersistenceAccumulator` data model — still the source of truth
- Lightweight Charts for candles + axes
- Persistent levels, wall markers, σ shelves (low cost, work as-is)
- Hit-testing on heatmap (per-pixel inverse projection: pixel → (time, price) → texture lookup)

## What gets retired

- `depthHeatmap.wgsl`'s instanced-quad shader (replaced by texture-sample shader)
- `MIN_DEPTH_CELL_WIDTH` / `MIN_DEPTH_CELL_HEIGHT_PX` clamps (no longer needed with per-pixel rendering)
- Bloom fake-bloom (the texture's bilinear sampling already produces smooth halos; we can add a real Gaussian blur post-pass if we want stronger glow)
- Edge-fade (still useful; ported to new shader)

## What's NEW

- Heatmap texture (R32_FLOAT, 512×512)
- Texture-write pipeline (CPU → GPU per depth payload)
- Trade-dot GPU pipeline (instanced SDF circles with pulse animation)
- Feature toggle: classic-cells vs. Bookmap-texture

---

## Risks + open questions

| Risk | Mitigation |
|---|---|
| Texture coordinate alignment with LC's time axis pixel mapping (must be pixel-perfect or you'll see aliasing as the chart pans) | Test against LC's `timeToCoordinate` directly each frame; adjust UV offsets if needed |
| Bilinear filtering introduces blur — might wash out very thin walls | Tune intensity power curve to push walls higher; consider mipmap-style anisotropic sampling |
| Old discrete-cell renderer still has users who like its look | Feature flag preserves classic mode; user can toggle |
| `R32_FLOAT` might have driver issues on some hardware | Smoke test on RTX 4080 first (confirmed in earlier P4 smoke); if issues, fall back to `RG8_UNORM` two-channel |
| Trade-volume range (1 → 1000+ lots) — sizing trade dots proportionally needs care | log-scale dot radius with sensible min/max in pixels |

## Open question — color palette

Bookmap's palette is iconic but commercial. We need to pick a palette that reads similarly without copying. Two candidates:

1. **Cyan / magenta** — high contrast against dark background. Cyan for bid (cool), magenta for ask (warm). Modern look.
2. **Blue-green / red-orange** — closer to Bookmap aesthetic. Deep navy at zero, cyan → teal for bid, orange → red for ask.

Will pick during Week 1 Day 3 with a live visual. Easy to swap because it's a single 1D LUT texture or shader function.

---

## What this doesn't solve (still on hybrid path)

- LC's candles remain Canvas2D — pan/zoom there still has the LC redraw cost (small but not zero)
- LC's axes are LC-styled, not Bookmap-styled — the chrome looks like our existing dashboard, not Bookmap
- No "time profile" column at right edge — that's Path B territory

If after Path A the only remaining gap is the chart chrome, you can decide whether to pursue Path B (5-6 weeks for full custom chart) or accept the hybrid look.
