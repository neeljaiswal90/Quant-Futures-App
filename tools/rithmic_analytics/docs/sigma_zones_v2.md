# Sigma Supply/Demand Zones — Convention v2 (RA-098)

## Background

The v1 convention (`convention_sigma_zone_construction`, established 2026-05-22):
```
2σ supply = VAH→+2σ
1σ supply = +1σ→VAH
1σ demand = -1σ→VAL
2σ demand = -2σ→-1σ
```
where σ is the session-anchored VWAP standard deviation and VAH/VAL are
value-area boundaries from `compute_vp`.

## Audit findings (4 real gaps, 2 cosmetic)

1. **Two-source mixing** — VAH/VAL come from the **volume distribution** (70%
   acceptance band); σ comes from **price deviation from cumulative VWAP**.
   They measure different things on different scales. Whether +1σ sits above,
   at, or below VAH is entirely determined by session distribution shape, not
   by anything meaningful about supply/demand. Friday 5/29 example: σ=58.76,
   VAH−VWAP=+44.27 → +1σ sat **above** VAH by 14pt (thin 1σ supply shelf);
   VWAP−VAL=+76.48 → −1σ sat **inside** value area, overlapping HVN
   structure. Different sessions produce wildly different zone widths and
   overlaps.

2. **σ is trend-inflated** in directional sessions. Session-anchored VWAP σ
   captures both real volatility AND trend drift (cumulative VWAP lags a
   trend). Friday's IB range was ~190pt; σ_VWAP = 58.76 partly reflects the
   trend, not pure dispersion. Trending sessions get systematically wider
   "2σ" zones than the actual price dispersion warrants.

3. **Symmetric ±σ assumes a normal distribution.** Markets are non-Gaussian
   (fat tails, skew). Friday distributed asymmetrically: 76pt of selling
   exhaustion below VWAP vs 73pt of buying exhaustion above. A symmetric ±σ
   convention loses that directional information.

4. **Zone widths are unbounded.** v1 "2σ supply = VAH→+2σ" on Friday is 73pt
   wide ($146/contract). A stop at the far edge of a 73pt zone isn't a stop —
   it's a position-sizing problem. v1 has no width cap.

Cosmetic (worth fixing while we're here):
5. **VPOC drawn as a line** instead of a band one bin wide.
6. **No multi-session alignment scoring** despite `multi_session_count: null`
   already existing in the zones JSON output.

(Item 7 was added in the dispatch but is out of scope for v2 source-level:
**depth-weighted conviction**, which requires the `DepthBook` from the
rithmic_dashboard package. Documented as a future hook on
`confluence_score_v2`.)

## v2 formula

```
σ_above  = √( Σ_{p>VWAP} q·(p−VWAP)² / Σ_{p>VWAP} q )    over trailing window_minutes
σ_below  = √( Σ_{p<VWAP} q·(p−VWAP)² / Σ_{p<VWAP} q )    over trailing window_minutes
ATR_cap  = cap_atr_fraction · ATR(14)                    default 0.5

2σ_supply = [ VAH,
              max( VAH, min(VWAP + 2·σ_above,  VAH + ATR_cap     ) ) ]
1σ_supply = [ VAH,
              max( VAH, min(VWAP + 1·σ_above,  VAH + ATR_cap / 2 ) ) ]
VPOC_band = [ VPOC − 0.5·bin_width, VPOC + 0.5·bin_width ]
1σ_demand = [ min( VAL, max(VWAP − 1·σ_below, VAL − ATR_cap / 2 ) ),
              VAL ]
2σ_demand = [ min( VAL, max(VWAP − 2·σ_below, VAL − ATR_cap     ) ),
              VAL ]
```

`window_minutes` default 60 (matches `compute_live_signals` recency window).
`bin_width` = `bin_size_ticks × tick_size` (Friday 5/29: 7 × 0.25 = 1.75pt).

The `max(VAH, …)` / `min(VAL, …)` clamps enforce the invariants
`supply.top ≥ VAH` and `demand.bottom ≤ VAL` — so a session where σ
collapses (e.g. quiet balance or constant prices) produces zero-width zones
AT the value-area boundary rather than inverting.

## How v2 addresses each gap

- **Gap 1** (source mixing): the asymmetric σ_above / σ_below are still
  derived from VWAP residuals, but the clamps to VAH/VAL keep zones on the
  correct side of the value area regardless of VWAP/value-area geometry. The
  cap also prevents σ from running unboundedly past VAH/VAL.
- **Gap 2** (trend inflation): trailing 60-min window naturally tracks the
  trend (the windowed VWAP moves with price), so σ measures actual dispersion
  around recent fair value rather than dispersion-plus-drift from session
  open.
- **Gap 3** (symmetry): σ_above and σ_below are computed independently.
  Volume-weighted, around 0 (not around the conditional mean — that would
  underestimate σ on a strongly directional session). One side reaching zero
  observations correctly produces σ=0 on that side.
- **Gap 4** (unbounded widths): every zone is capped at
  `cap_atr_fraction × ATR(14)` per side (default half a daily ATR). The
  `bound_source` field on each zone records whether σ or the ATR cap
  determined the boundary, for audit/calibration.
- **Gap 5** (VPOC as line): `VPOC_band` renders as a tick-bin-wide band.
- **Gap 6** (multi-session alignment): `confluence_score_v2` accepts
  `multi_session_count` from `aggregate_multi_session`, contributing up to
  +0.5 to the conviction score when ≥ structural threshold.

## Per-zone confluence score

```
confluence_score = clamp(volume_pct
                         + 0.5 · min(1, multi_session_count / structural_threshold)
                         + 0.5 · depth_resting_fraction,
                         0, 1)
```

- `volume_pct` — the zone's share of session volume (0..1)
- `multi_session_count` — overlapping prior-session HVN clusters
- `structural_threshold` — default 3 (matches `aggregate_multi_session`)
- `depth_resting_fraction` — DOM resting size inside zone ÷ session-max DOM.
  `None` until cross-package depth wiring lands (future hook).

## Status

- **Shipped (this commit):** module `features/sigma_zones_v2.py` + 10-test
  suite covering each gap closure. Module is a pure standalone — no CLI
  integration yet.
- **Follow-up:** wire into `cli/daily_zones.py` behind a `--zones-v2` flag
  that emits an additional `sigma_zones_v2` block in the zones JSON (v1
  output unchanged). Add `confluence_score_v2` enrichment over each existing
  zone using prior-session VPs via `aggregate_multi_session`.
- **Deferred:** depth-weighted conviction requires the `DepthBook` from
  `tools/rithmic_dashboard/rithmic_dashboard/features/depth_book.py`
  (now live in the realtime backend). Wiring it into offline `daily_zones`
  is a cross-package dependency and lives in its own ticket.

## Calibration plan

Once Codex's RA-090a→091 replay+labels pipeline lands deeper, v2 zones
should be validated against forward-return labels on historical captures:
- Does the asymmetric σ predict directional reaction better than v1
  symmetric σ?
- Does the ATR cap actually preserve tradeable widths without sacrificing
  rejection accuracy?
- Does the multi-session bonus correlate with realized hold-rate?

That validation is the natural Phase 2 of RA-098.
