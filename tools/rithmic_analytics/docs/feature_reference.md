# Feature reference

Public API surface, organised by module. Each entry: one-paragraph what / how,
then a pointer to the source so the docstring + signature stay the source of
truth. **Read this alongside [`architecture.md`](./architecture.md) — the
architecture explains why; this explains what.**

Conventions used everywhere:

- All time bins use `event_ts_ns` (canonical exchange timestamp), never
  `recv_ts_ns`. See [architecture.md D-004](./architecture.md).
- All DataFrames flow through [`core/loader.py`](../rithmic_analytics/core/loader.py)
  — column names, dtypes, and the empty-frame contract are loader-defined.
- All detector configs are frozen dataclasses with MNQ-calibrated defaults.
  Pass a custom `Config()` to override; never mutate defaults in-place.
- Databento historical corpus readers stream DBN chunks; do not full-load
  multi-session corpora into memory.

---

## `data_loader.databento_loader`

Streaming Databento corpus discovery and session-stat extraction for RA-053.
`discover_corpus_sessions()` scans approved roots for `trades.dbn.zst`, parses
`YYYY-MM-DD_session`, dedupes by session key, and returns rejection provenance.
`compute_trade_session_stats()` streams trade chunks into five-minute high/low
bars, session VWAP, initial-balance high/low, and Parkinson `sigma_pts`.

`parkinson_sigma_points()` implements:

```python
sigma_log_squared = mean((log(H / L)) ** 2)
sigma_log = sqrt(sigma_log_squared / (4 * log(2)))
sigma_pts = sigma_log * vwap_session
```

## `cli.calibrate_ewma`

Manual/monthly EWMA calibration CLI. It builds or loads
`data/calibration_corpus/per_session_stats.parquet`, performs an 80/20 temporal
walk-forward lambda search over `[0.85, 0.99]`, and writes
`data/calibration_corpus/ewma_decay.json` with chosen lambda, train/validation
RMSE, corpus median sigma, and `corpus_provenance`.

---

## `core.contracts`

[`ContractSpec`](../rithmic_analytics/core/contracts.py): immutable per-symbol
metadata (`tick_size`, `dollars_per_tick`, `dollars_per_point`). Single
exported instance: **`MNQ`** (`tick_size=0.25`, `$0.50/tick`, `$2/point`).
Adding NQ/ES is a one-line append to the module.

---

## `core.loader`

JSONL loaders for each Rithmic stream. All return pandas DataFrames whose
canonical timestamp is `event_ts_ns: int64`; host-side receipt time is
`recv_ts_ns: int64` (QA / latency only — never bin on it).

| Function | Stream | Output columns | Notes |
|---|---|---|---|
| `load_obs01_trades(path)` | OBS-01 (TRADE) | `event_ts_ns`, `recv_ts_ns`, `session_id`, `price`, `quantity`, `aggressor_side`, `trade_id`, `signed_qty` | Flattens nested `payload.*`. Computes `signed_qty = quantity × {buy=+1, sell=-1, unknown=0}`. Warns at >1% unknown aggressors. |
| `load_mbp1(path, *, contract=MNQ)` | MBP1 (top-of-book) | base 8 + RA-037 derived: `spread_ticks` (f64; NaN if one-sided), `spread_bps` (f64), `is_crossed` (bool) | Databento-flat schema; loader renames timestamps and appends per-row spread derived from `tick_size`. Crossed quotes (`ask<bid`) preserved as `is_crossed=True`. |
| `load_mbo(path)` | MBO (per-order) | `event_ts_ns`, `recv_ts_ns`, `sequence`, `action` (A/M/C/F/T), `side` (B/A), `price` (NaN-tolerated), `size`, `order_id` | ~2% of rows carry NaN `price` per Rithmic spec — preserved, not filtered. |
| `load_mbp10(path, chunksize=100_000)` | MBP10 (10-level depth) | 62 cols: `event_ts_ns`, `recv_ts_ns`, then `{bid,ask}_{px,sz,ct}_{00..09}` | Chunk-streamed during parse (peak ~500 MB). Resulting DataFrame is still ~5 GB at full RTH fixture — see [`future_work.md` item 13](./future_work.md) for the planned chunk-join. |

Empty file (0 bytes) → empty DataFrame with full schema; non-empty file with no
matching records → empty DataFrame + `UserWarning`.

The on-disk schemas are documented in [`jsonl-inspection-report.md`](./jsonl-inspection-report.md).

### RA-037: spread summary

`summarize_spread(mbp1_df) -> SpreadSummary` aggregates per-row spread columns
into a single immutable snapshot for liquidity-quality monitoring. NaN /
crossed rows are excluded from distribution stats but still surfaced via
`n_records` / `n_crossed_quotes` so the consumer can compute coverage.

| Field | Type | Meaning |
|---|---|---|
| `mean_ticks` / `mean_bps` | f64 | Unweighted mean over valid two-sided rows. |
| `p50_ticks` / `p95_ticks` / `p99_ticks` | f64 | Quantiles (linear interp). |
| `max_ticks` | f64 | Max valid spread. |
| `time_above_1tick_pct` / `time_above_2tick_pct` | f64 | Row-count fraction where `spread_ticks > N`. |
| `n_records` | int | Total MBP1 rows. |
| `n_crossed_quotes` | int | Rows where `ask < bid` (preserved, not filtered). |

The `daily_zones` orchestrator now emits one INFO log per session
summarizing spread distribution (RA-037 wiring) — defensive, never gates
zone output.

---

## `core.schema`

Canonical zone JSON envelope — the wire format every downstream consumer
(chart-drawing pipelines, `vp_*.py` retrofit, daily HTML reports) reads.
Schema spec is [`zone_schema.json`](../rithmic_analytics/core/zone_schema.json);
the dataclasses in [`schema.py`](../rithmic_analytics/core/schema.py) match 1:1.

**`SCHEMA_VERSION = 1`.** Bump on any incompatible change (rename, remove,
type change). Adding an optional field with a default is non-breaking.

| Dataclass | Purpose |
|---|---|
| `Zone(id, top, bot, type, conviction, text, sources, volume_pct?, multi_tf_count?, multi_session_count?)` | Horizontal price band with conviction grading. **`type` defaults to `"support"`** for Phase 1 builders — see ["Phase-1 zone type"](#phase-1-zone-type-resolution) below. |
| `ReferenceLine(price, text, source)` | Single-price marker (VPOC/VAH/VAL/LVN). |
| `ZoneEnvelope(schema_version, symbol, timeframe, bars_used, computed_at, data_source, vpoc, vah, val, atr_14, bin_size_ticks, zones, reference_lines)` | Top-level container. |

`ZoneEnvelope.from_volume_profile(vp, ...)` is the Phase-1 builder: HVNs →
zones, VPOC/VAH/VAL → reference lines, LVNs → reference lines tagged
`lvn_<timeframe>`.

`validate_envelope(payload)` runs `jsonschema.validate` against the on-disk
spec — used by RA-006 CLI before write and by RA-020 retrofit for the
`vp_*.py` scripts' new JSON output.

### Conviction grading (`grade_zone(sources)`)

| Grade | Rule |
|---|---|
| **SUPER** | ≥4 *distinct* HVN timeframes (set, not list — four `hvn_5m` entries grade MED). |
| **HIGH** | ≥1 HVN + ≥1 band (`*avwap*` / `*_band`) + ≥1 structural (`ema*` / `swing_*`). |
| **MED** | Any single HVN, any band, or `vah`/`val`. |
| **LOW** | Only EMA / round-number / swing without HVN/band/VA, plus empty source list. |

Malformed source strings (`hvn_` with no TF, `hvn_garbage`) are silently
skipped.

### `atr_14: null` is a real wire value (not a test edge case)

Any capture with fewer than 14 bars at the chosen `bar_size_ns` emits
`atr_14: null`. Downstream consumers **must check `envelope.atr_14 is None`**
before using ATR-derived zone widths or stop distances. Recommended fallback:
skip ATR-derived sizing and fall back to raw `bin_size_ticks` until enough
data accumulates. RA-021 daily / multi-session aggregators produce non-null
ATR by definition.

### Phase-1 zone type resolution

Phase-1 zones default to `type="support"` regardless of price location. The
single-TF VP builder has **no current-price context** so it cannot
disambiguate support from resistance. Consumers with live-price context (chart
rendering, real-time alerts) should reassign `type` based on `current_price ≷
zone.top`. RA-021's multi-session aggregator does carry session-spanning
context but still emits `support` — by convention, type-flipping is a
consumer-side concern.

---

## `features.volume_profile`

[`compute_vp(trades, contract, *, bin_size_ticks=20, va_pct=0.70, hvn_dedup_ticks=60, top_n=6, bin_size_mode="fixed", atr_14=None) -> VolumeProfile`](../rithmic_analytics/features/volume_profile.py)

Aggregates trades into tick-aligned bins; emits **VPOC** (highest-volume bin
low; ties → lowest price), **VAH/VAL** (expand outward from VPOC until
cumulative volume ≥ `va_pct × total`), **HVN list** (top-volume bins, deduped
within `hvn_dedup_ticks × tick_size`), and **LVN list** (lowest-volume bins
with `volume > 0`).

Bin convention: `bin_low = floor(price / bin_size) * bin_size` covers
`[bin_low, bin_low + bin_size)`. Invariant: `VAH >= VPOC >= VAL`.

`VolumeProfile.bins` is a Series indexed by bin-low (float64) with int64
volumes — useful for custom downstream renderers.

### RA-039: adaptive bin sizing

`bin_size_mode` controls how `effective_bin_size_ticks` is resolved:

| Mode | Behavior |
|---|---|
| `"fixed"` (default) | Honors `bin_size_ticks` verbatim. **Byte-exact backward-compatible** with pre-RA-039 output. |
| `"adaptive"` | Derives `effective_bin_size_ticks = clamp(round(atr_14 / 4), [4, 40])`. ATR is in price units (points). NaN/None ATR → transparent fallback to mode `"adaptive_fallback"` + WARN log. |
| `"adaptive_fallback"` | Caller asks for the 20-tick fallback explicitly; no ATR consultation. |

The resolved `effective_bin_size_ticks` and `bin_size_mode` are surfaced on
`VolumeProfile` so downstream consumers can audit what was actually used. The
`daily_zones` CLI exposes adaptive mode via `--adaptive-bins`; the `compute_vp`
CLI via `--bin-size-mode {fixed,adaptive}`. See architecture decision D-010.

---

## `features.atr`

[`compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_5M) -> float`](../rithmic_analytics/features/atr.py)

Resamples ticks into fixed-width OHLC bars on `event_ts_ns`, then standard
Wilder ATR: `TR = max(H-L, |H-PrevC|, |L-PrevC|)`, seeded with `mean(TR[:N])`,
recursive after. Returns `math.nan` when fewer than `period` complete bars
exist after resampling. Pre-computed constants `NS_1M / NS_5M / NS_15M / NS_1H`
in the same module.

---

## `features.cvd`

[`compute_cvd(trades) -> trades + ["cvd", "cvd_rth", "cvd_minute"]`](../rithmic_analytics/features/cvd.py)
adds three running totals:

- `cvd` — cumulative `signed_qty` over the full input.
- `cvd_rth` — cumulative within each `session_id` (resets at session
  boundaries; matches what Neel watches on Bookmap).
- `cvd_minute` — 1-minute event-time bucket sum, broadcast to every row in the
  bucket. Useful as a "delta strength" feature for footprint overlays.

[`detect_divergence(trades, *, price_window=500, cvd_window=500, min_divergence=0.5)`](../rithmic_analytics/features/cvd.py)
flags rows where the rolling-window percentile rank of price differs from the
same window's rank of CVD by ≥ `min_divergence`. Use case: price punches a new
local high but CVD does not → aggressive buying has stalled (classic bearish
divergence).

---

## `features.footprint`

[`compute_footprint(trades, contract, *, time_bin_sec=30, price_bin_ticks=1) -> Footprint`](../rithmic_analytics/features/footprint.py)

Pivots trades into a time × price grid. Returns three aligned views in one
dataclass:

- `deltas` — `signed_qty` sum per cell (float; NaN where no trades).
- `total_volume_per_bin` — row total `quantity` (int64).
- `imbalance_per_level` — per-cell `net_delta / total_volume` ∈ `[-1, +1]`.

The renderer in [`viewer.footprint_html`](../rithmic_analytics/viewer/footprint_html.py)
consumes this shape. Hover currently shows net delta only; the per-cell
buys/sells breakdown is the [follow-up](./future_work.md#enhancement-notes-non-blocking).

---

## `features.absorption`

[`compute_absorption_events(trades, mbp1, contract, config=None) -> list[AbsorptionEvent]`](../rithmic_analytics/features/absorption.py)
flags bars where one-sided aggression hits resting size at the dominant price
without breaking it (Bookmap-equivalent absorption / institutional refill).
Four-factor score: volume × range × one-sidedness × displacement
(weights 0.30 / 0.25 / 0.20 / 0.25). Hard gates: `max_range_ticks ≤ 4`,
`min_onesidedness ≥ 0.6`, `min_displacement ≥ 0.5`, `min_emit_score ≥ 0.5`.

[`apply_next_bar_confirmation(events, trades)`](../rithmic_analytics/features/absorption.py)
runs a second pass — flips `confirmed=True` when the absorbed level held into
the next bar.

Full methodology (factors, gates, calibration, tier-1-to-5 fixture set):
[`absorption_methodology.md`](./absorption_methodology.md).

Real-data annotated cases for ongoing calibration are tracked in
[`future_work.md` item 2](./future_work.md).

---

### Daily absorption-events artifact (RA-030.1)

When `daily_zones` runs with `--emit-absorption-json`, it persists the
session's absorption events to:

    data/absorption/{YYYY-MM-DD}_{ROOT}_{session}.json

Shape: JSON array of `AbsorptionEvent.to_dict()` entries —
`start_ts_ns`, `end_ts_ns`, `side`, `price_center`, `dominant_price`,
`volume`, `net_delta`, `range_ticks`, `score`, `confirmed`,
`mbp1_stale`, `factors` (with the four sub-factors). Sorted by
`start_ts_ns`.

**Defensive guarantee**: absorption emit never gates zone JSON output.
Failures (missing MBP1 sibling, compute error, write failure) log a
WARNING and continue. Zones JSON is the load-bearing artifact; absorption
events are valuable-but-not-critical.

Default OFF; flip ON in production with `--emit-absorption-json` once
smoke-tested. Output dir override: `--absorption-root` (default
`data/absorption`).

Expected runtime cost on a full-RTH session: ~30–60s additional
wall-clock, ~1.7 GB peak memory (8M+ MBP1 records). Acceptable for
nightly batch; monitor the `absorption emit` log line for drift.

---

## `features.cancellation_analysis` (RA-036)

Tradesea cancellation pattern analytics — direct Rule 7 measurement.
Joins :class:`CancelledOrder` records against the live OBS-01 tape;
answers four diagnostic questions per cancel: did price reach the
limit, which direction did it move, by how much, and did the trader
rebuy at worse.

[`analyze_cancellations(cancelled_orders, trades, contract, *, fills=None, config=None, trading_date=None) -> CancellationAnalysisReport`](../rithmic_analytics/features/cancellation_analysis.py)

Pure function. ``cancelled_orders`` from
:func:`rithmic_analytics.core.trade_log.load_tradesea_csv` (the
second element of the returned tuple). ``trades`` is the OBS-01
tape. ``fills`` is the optional first element of the same tuple — when
supplied, ``regret_rebuy_at_worse_price`` fires on same-side fills at a
worse price within ``rebuy_window_minutes``.

### Diagnostic outputs (`CancelOutcome`)

| Field | Meaning |
|---|---|
| `reached_limit: bool` | Price came within `regret_tolerance_ticks` of the cancelled limit within `regret_window_minutes`. |
| `direction` | ``"favorable"`` (clear move toward/past limit), ``"unfavorable"`` (clear move away), ``"neutral"`` (within ±1 tick band). |
| `max_favorable_pts: float \| None` | Signed: positive = toward limit, negative = away. ``None`` when no post-cancel tape. |
| `regret_rebuy_at_worse_price: bool` | Same-side subsequent fill at worse price within window. |
| `window_truncated: bool` | The regret-window extended past the input tape's last bar — interpret `reached_limit` with care. |
| `has_sufficient_tape: bool` | `False` when `<min_window_seconds` of tape after cancel. Excluded from session summary denominator. |
| `unanalyzable_reason: str` | Non-empty when the cancel can't be analyzed (e.g. `"no_limit_price"`, `"no_tape_after_cancel"`, `"empty_tape"`). |

### Session summary

`SessionSummary.regret_cancel_rate = n_reached_limit / n_cancels_analyzed`
where `n_cancels_analyzed` excludes insufficient-tape and unanalyzable
outcomes. **Rule 7 alarm threshold: > 20%** flagged in the HTML report.

### Tuning knobs (`CancellationAnalysisConfig`)

| Field | Default | Notes |
|---|---|---|
| `regret_window_minutes` | 5 | Forward-look window for limit-reach. |
| `rebuy_window_minutes` | 10 | Separate (and longer) window for regret-rebuy detection. |
| `regret_tolerance_ticks` | 1 | Within 1 tick of limit counts as reached. |
| `min_window_seconds` | 60 | Below this much post-cancel tape, exclude from denominator. |

### Output schema

```json
{
  "schema_version": 1,
  "per_cancel_outcomes": [ { ... }, ... ],
  "session_summary": { ... },
  "metadata": {
    "regret_window_minutes": 5, "rebuy_window_minutes": 10,
    "regret_tolerance_ticks": 1, "min_window_seconds": 60,
    "trading_date": "2026-05-19", "sessions_covered": [...]
  }
}
```

The HTML viewer (`viewer.trade_replay_report.render_trade_replay_html`)
accepts a `cancellation_report=...` kwarg to render the outcomes inline
in the trade-replay HTML with a Rule-7-alarm callout when applicable.

---

## `features.order_pressure` (RA-035)

MBO add/cancel pressure detector. The lean-stack alternative to MBP10
heatmap rendering: same orderflow signals (build/thin/spoof) from
Rithmic's per-order lifecycle stream without the ~28 GB/session
storage cost. See [architecture.md D-009](./architecture.md).

[`compute_order_pressure(mbo, contract, *, config=None) -> OrderPressureSeries`](../rithmic_analytics/features/order_pressure.py)

Vectorised pandas groupby on (time_bin, price_bin). 5M synthetic MBO
rows in under 8s; the 13.8M-row overnight Globex capture fits well
under the 60s budget.

[`aggregate_to_session_summary(pressure) -> dict[str, dict]`](../rithmic_analytics/features/order_pressure.py)

Collapses the (time × price) grid to per-price-bin totals — useful for
"which levels saw the most spoof activity overnight?" morning prep.

### Diagnostics per bin

- **n_adds / n_cancels / n_modifies / n_fills** — raw event counts.
  Surfaced as the dedupe key so consumers can apply their own minimum-
  sample filter (RA-027 `BinomialEstimate` pattern: surface `n_trials`,
  don't bake an `n<5` threshold into the compute layer).
- **add_cancel_ratio** = `cancels / adds`. `>1` = level being pulled
  faster than offered. `<1` = level building. `None` when adds == 0.
- **depletion_velocity_per_sec** = `(cancels + fills) / window_seconds`.
  Pure outflow rate. Combine with `n_adds` to read build-vs-thin.
- **spoof_score** ∈ [0, 1] = fraction of adds at this bin where the
  same order_id cancelled within `spoof_cancel_window_ms` AND never
  filled. `None` when n_adds == 0. High values = "shown but withdrawn"
  fingerprint.

### Tuning knobs (`OrderPressureConfig`)

| Field | Default | Notes |
|---|---|---|
| `window_seconds` | 30 | Matches absorption's bar grid for join-ability. |
| `price_bin_ticks` | 4 | 1pt MNQ; sub-VP granularity needed for order-level activity. |
| `spoof_cancel_window_ms` | 500 | Tunable. High-frequency spoofs cancel in <100ms; "fade-the-lurker" patterns hold for 1-2s. |

### Independence guarantee

The pressure series is NOT joined to absorption events at fill-time
in v1. RA-028 (P&L attribution) will perform the cross-join when ≥5
paired sessions accumulate. Independence keeps the module testable
and the signals interpretable in isolation.

---

## `features.sweep`

[`detect_sweeps(mbo, mbp1, contract, *, config=None) -> list[SweepEvent]`](../rithmic_analytics/features/sweep.py)
flags the *inverse* of absorption: aggression that consumes resting liquidity
across multiple price levels in a tight burst.

Pipeline: filter MBO to `action="T"` → group consecutive trades into bursts by
**per-event gap** (`event_gap_max_ms=200`) capped at `burst_window_max_sec=1.0`
total duration → hard-gate on levels swept (5–50) / volume (≥20) / one-sidedness
(≥0.5) → four-factor score (range 0.35, speed 0.20, displacement 0.20,
one-sidedness 0.25). MBP1 confirmation in two passes (pre + post); both flags
reported but neither disqualifies. Direction from MBO `side` dominance —
canonical vs noisy price-trajectory inference.

Defaults are MNQ-calibrated (tick=0.25 pt); ES/NQ share tick size and apply
unchanged. Tune via `SweepConfig` for other markets.

---

## `features.hidden_liquidity`

[`infer_hidden_liquidity(trades, mbp10, contract, *, config=None, return_per_trade=False)`](../rithmic_analytics/features/hidden_liquidity.py)

For each aggressive trade, asof-joins to the most recent MBP10 snapshot
(default 1 ms pre-trade), looks up the visible size at the traded price level
on the aggressed side, and flags `traded / visible ≥ N` (default 3.0).

Aggregation is per `(session_id, price, side)` — tick-aligned, no banding.
Returns `HiddenLiquiditySummary` with `records` plus three diagnostic counters
(`trades_processed`, `trades_skipped_unknown_aggressor`,
`trades_outside_mbp10_depth`). Pass `return_per_trade=True` to also get the
per-trade DataFrame for ad-hoc inspection.

**Storage cost**: requires MBP10 capture (~28 GB / RTH session). Opt-in for
institutional-flow studies; not in the lean stack.

**Aliasing caveat**: between MBP10 snapshots, orders can be both added AND
consumed. A trade of 300 against visible 100 doesn't strictly mean 200 hidden
— could be 100 visible consumed, 200 new visible added mid-snapshot, then
those consumed too. Default `N=3` is margin against this; tighten only with
clean reference data.

The full-fixture DataFrame from `load_mbp10` sits at ~5 GB peak — the planned
chunk-join in [`future_work.md` item 13](./future_work.md) drops this to
streaming.

---

## `features.multi_session`

[`aggregate_multi_session(session_vps, *, structural_threshold=3, cluster_tolerance_pts=5.0) -> MultiSessionVP`](../rithmic_analytics/features/multi_session.py)

Given N most-recent session VPs, clusters HVNs across sessions: two HVNs
belong to the same cluster if `|p1 - p2| <= cluster_tolerance_pts`. A cluster
where `multi_session_count >= structural_threshold` is tagged
`conviction="STRUCTURAL"`. Other clusters are `"PERSISTENT"` (2+ sessions) or
`"SINGLE"` (1 session). Note: `MultiSessionHVN.conviction` is informational; if
mapping to `Zone.conviction`, `"STRUCTURAL"` should be remapped to `"SUPER"`
to satisfy the JSON Schema enum.

---

## `features.ohlcv_aggregate`

[`aggregate_to_ohlcv(trades, bar_size_sec) -> list[dict]`](../rithmic_analytics/features/ohlcv_aggregate.py)
resamples ticks into fixed-width OHLCV bars keyed on `event_ts_ns`. Output is
a list of TradingView-compatible dicts (`time` unix-seconds int, `open`,
`high`, `low`, `close`, `volume`). Empty bars are excluded. Raises
`ValueError` on `bar_size_sec <= 0`.

---

## `features.vwap`

Session-anchored VWAP with ±1σ / ±2σ standard-deviation bands — RA-031.

[`compute_vwap(trades, *, anchor) -> VwapSeries`](../rithmic_analytics/features/vwap.py)

Anchors: ``"rth"`` (09:30 ET), ``"globex"`` (17:00 ET prior business
day), ``"weekly"`` (Sunday 17:00 ET). The anchor is resolved from the
**last trade's** timestamp — a capture spanning Globex+RTH anchors at
today's 09:30 RTH open, excluding pre-open prints.

Numerical stability: West's incremental algorithm for volume-weighted
variance — relative error <1e-9 across 100K-bar sessions. Naive
``Σ(p²·v)`` accumulation drifts on these workloads.

`VwapSeries` exposes running arrays (``vwap``, ``vwap_p1sd``,
``vwap_m1sd``, ``vwap_p2sd``, ``vwap_m2sd``) aligned to
``event_ts_ns``, plus convenience accessors ``final_vwap()``,
``final_sigma()``, ``final_bands()``.

Wired into ``daily_zones`` to emit reference lines tagged ``vwap_<anchor>``,
``vwap_<anchor>_band_p1sd``, ``vwap_<anchor>_band_m1sd``, ``vwap_weekly``.
``grade_zone`` recognises ``*_band_*`` substrings → HVN + band +
structural now elevates to HIGH conviction.

---

## `ops.alerts`

[`analyze_obs01_trade_gaps(obs01_path, *, thresholds=None) -> list[Gap]`](../rithmic_analytics/ops/alerts.py)
and
[`analyze_mbp1_quote_gaps(mbp1_path, *, session_id, thresholds=None) -> list[Gap]`](../rithmic_analytics/ops/alerts.py)
stream a capture JSONL and return `Gap` records for `event_ts_ns` gaps
exceeding `GapThresholds`.

[`emit_alerts(gaps, alerts_path=None, *, ts_iso=None) -> int`](../rithmic_analytics/ops/alerts.py)
appends one NDJSON line per gap to `alerts.ndjson` (append-only — the
dashboard expects a cumulative log).

[`emit_heartbeat_missing_alert(trading_date, ...)`](../rithmic_analytics/ops/alerts.py)
appends a `CAPTURE_HEARTBEAT_MISSING` record with the same wire shape.

[`send_discord_webhook(webhook_url, gaps)`](../rithmic_analytics/ops/alerts.py)
posts a one-line summary; failures are logged but never raised.

[`post_fail(*, source_name, message, ...) -> bool`](../rithmic_analytics/ops/alerts.py)
(RA-032) posts a FAIL-severity Discord alert with 30-min dedupe by
``(severity, source_name)``. Reads ``RITHMIC_DISCORD_WEBHOOK_URL`` from
env; missing → silent no-op + INFO log on first attempt. Dedupe state
persists to ``data/alerts/.alerts_state.json``, surviving process
restart. Returns True if posted, False if suppressed or no webhook.

[`post_digest(summary, ...) -> bool`](../rithmic_analytics/ops/alerts.py)
(RA-032) posts a once-per-call digest line. No dedupe — fires every
invocation. Used by ``daily_zones`` at end of run.

NDJSON wire shape:

```json
{"ts_iso": "2026-05-15T19:30:00+00:00",
 "session_id": "mnq-2026-05-15-rth",
 "stream": "LAST_TRADE", "gap_type": "time",
 "gap_value_ns": 72_500_000_000,
 "threshold_ns": 60_000_000_000,
 "severity": "WARN"}
```

Defaults (vendored from QFA, [D-001](./architecture.md)):

| Stream | Warn | Fail |
|---|---|---|
| `L1_QUOTE` (MBP1) | 1 s | 5 s |
| `LAST_TRADE` (OBS-01) | 60 s | 5 min |

`HEARTBEAT` alerts reuse the same wire shape with `gap_type="missing_capture"`,
`gap_value_ns=null`, `threshold_ns=null` — see [D-005](./architecture.md).

---

## `ops.rotation`

[`plan_rotation(captures_root, *, archive_root=None, reference_date=None) -> RotationReport`](../rithmic_analytics/ops/rotation.py)
and
[`apply_rotation(...)`](../rithmic_analytics/ops/rotation.py)
implement trading-day-granularity retention: compress raw captures older than
`keep_raw_rth_sessions` (default 2 trading days), delete archives older than
`compressed_hot_days` (default 14).

Disk thresholds (default 70% warn, 85% fail) are **report-only** — rotation
runs regardless, since deleting old data is the fix for high usage.

The report carries `disk_used_pct_before`, `disk_used_pct_after_projected`
(assuming a 5× compression ratio), and a `warnings` list consumed by RA-009.

`RetentionPolicy` is vendored from QFA's `L1TradeRetentionPolicy`
([D-001](./architecture.md)); the `test_retention_policy_defaults_match_qfa`
test flags drift.

---

## `ops.heartbeat_check`

[`write_heartbeat(captures_root, heartbeat_dir, today, root_symbol)`](../rithmic_analytics/ops/heartbeat_check.py)
writes `data/heartbeat/{trading_date}.txt` summarising today's capture
presence + size.

[`check_missing_heartbeats(heartbeat_dir, alerts_path, *, now_et, deadline, lookback_weekdays=5)`](../rithmic_analytics/ops/heartbeat_check.py)
scans recent weekdays for missing heartbeat files. Emits one
`CAPTURE_HEARTBEAT_MISSING` NDJSON alert (`stream="HEARTBEAT"`,
[D-005](./architecture.md)) per missing past-deadline day.

The heartbeat task itself has no external monitor — if Task Scheduler drops
the entry, no alert fires. Mitigations ordered by cost in
[`future_work.md` item 6](./future_work.md).

---

## `ops.rollover_calendar`

[`resolve_front_month(root, today)`](../rithmic_analytics/ops/rollover_calendar.py)
returns the active front-month contract code (e.g. `"MNQM6"`) for a root
symbol on a given date, using the rollover rule documented in
[`rollover_playbook.md`](./rollover_playbook.md). Raises `RolloverCalendarMiss`
if the date falls in an unconfigured window.

---

## `ops.normalize_probe`

Probe-parity → OBS-01 + MBP1 normalization bridge — RA-029 / RA-030.
Transforms `capture-rithmic-probe.py` parity-mode JSONL into the
envelope shapes `load_obs01_trades` and `load_mbp1` read. Pure JSON
transformation, no protobuf parsing.

[`normalize_probe_to_obs01(in_path, out_path, *, mbp1_out_path=None, session_id=None, run_id=None, overwrite=False) -> NormalizeReport`](../rithmic_analytics/ops/normalize_probe.py)

Single-pass walker. Routes:

- **LAST_TRADE** / **MBO action=T** → OBS-01 TRADE envelope → ``out_path``.
- **L1_QUOTE** → MBP1 envelope → ``mbp1_out_path`` (RA-030; when supplied).
  RA-041: a session-scoped ``_L1QuoteForwardFiller`` post-processes each
  pure-converter output, substituting cached prior state for any side
  the input record omitted. Without this the on-disk MBP1 sibling is a
  delta tape (99.8% one-sided on real Globex); with this it's a snapshot
  stream (100% two-sided on 2026-05-20 measured). See architecture.md
  D-007 RA-041 update for the design rationale.
- Everything else → dropped, counted in :class:`NormalizeReport`.

``session_id`` derives from the canonical
``data/captures/YYYY-MM-DD/<ROOT>_<session>.jsonl`` layout when not
supplied. Raises ``UnrecoverableCaptureError`` when the input is
metadata-only (raw_present:false + no parity fields — e.g. the
2026-05-19 pre-RA-030 capture).

[`parity_record_to_obs01_dict(rec, *, session_id, run_id, counter) -> dict | (None, reason)`](../rithmic_analytics/ops/normalize_probe.py)

Pure per-record helper for OBS-01 routing.

[`parity_l1quote_record_to_mbp1_dict(rec) -> dict | (None, reason)`](../rithmic_analytics/ops/normalize_probe.py)
(RA-030) Pure per-record helper for L1_QUOTE → MBP1 field rename. One-sided
quotes (only bid OR only ask) emit with the missing side zeroed. Forward-fill
to a true snapshot stream happens in the wrapping loop via
``_L1QuoteForwardFiller`` (RA-041) — this pure function is preserved for
unit-test reuse.

``NormalizeReport`` carries two RA-041 diagnostic counters:
``mbp1_forward_filled`` (records where ≥1 side was substituted from cache;
predicted ~99% of L1_QUOTE records) and ``mbp1_first_record_one_sided``
(records where ≥1 side hit the no-cache edge; predicted 1-5 per session).
Deviation from those predictions is the signal that something probe-side
changed shape.

[`session_id_from_path(path) -> str | None`](../rithmic_analytics/ops/normalize_probe.py)

Derives ``mnq-YYYY-MM-DD-rth`` from the canonical capture path.
Validates the date component (rejects ``2026-13-99`` etc.).

Pipeline contract: see [architecture.md D-006 + D-007](./architecture.md).

---

## `ops.credentials`

[`load_credentials() -> RithmicCredentials`](../rithmic_analytics/ops/credentials.py)
reads the five `RITHMIC_*` env vars; raises `CredentialsMissing` listing the
absent ones. Used by `cli.start_capture` before subprocess launch.

---

## `viewer.tv_publisher` + `cli.tv_sync` (RA-034)

TV / Tradesea chart-shape sync from the canonical zones JSON. Python
emits a plan; an executor agent (Claude Code session with TV-MCP or
Chrome-MCP tools) reads the plan and performs the actual shape
add/remove operations. Two-phase architecture; survives mid-execution
crashes (plan is a permanent artifact).

[`plan_sync(*, envelope, state, backend, chart_id, ...) -> TVSyncPlan`](../rithmic_analytics/viewer/tv_publisher.py)

Pure function. Given a zone envelope + the current state-file mapping
(``source_id → shape_id``), computes a list of ``Add`` / ``Remove`` /
``NoChange`` operations. Stale-detection is state-file-driven: anything
in state but not in envelope → Remove; anything in envelope but not in
state → Add. **The planner never queries the chart**, by design — this
is the safety contract that keeps Neel's manually-drawn fibs / trend
lines invisible to the planner.

[`write_plan(plan, plan_path)` / `write_latest_pointer(plans_root, plan_path, backend)`](../rithmic_analytics/viewer/tv_publisher.py)

``write_latest_pointer`` writes ``<plans_root>/_latest.json`` pointing at
the most recent plan — lets the executor agent locate the right plan
without globbing. Multiple targets in one morning each get their own
``_latest.json`` overwrite, but state files prevent collisions.

[`load_state(path)` / `write_state(path, ...)`](../rithmic_analytics/viewer/tv_publisher.py)

Atomic write via ``.tmp`` + rename. Malformed state file → log warning,
treat as empty (bootstrap-safe).

### Source ID convention

- ReferenceLine: ``ref:<source>:<price formatted to 2 decimals>``
  (e.g. ``ref:vpoc:27381.25``). LVNs are plural — price disambiguates.
- Zone: ``zone:<zone.id>`` (e.g. ``zone:hvn-27380``). ``Zone.id`` is
  already deterministic in the schema.

### Style policy

Defined in ``STYLE_BY_SOURCE`` / ``STYLE_BY_CONVICTION`` dicts at the
top of ``tv_publisher.py``. Hand-picked first; tune later:

| Source | Color | Style | Width |
|---|---|---|---|
| `vpoc` | `#84CC16` lime | solid | 2 |
| `vah` / `val` | red / green | dashed | 1 |
| `lvn_*` | `#06B6D4` cyan | dotted | 1 |
| `vwap_rth*` | `#14B8A6` teal | solid / dashed | 2 / 1 |
| `vwap_globex*` | `#A855F7` purple | solid / dashed | 2 / 1 |
| `vwap_weekly` | `#3B82F6` blue | solid | 2 |

VWAP-RTH is teal (not orange) deliberately — avoids visual collision
with Neel's existing W-AVWAP indicator on the chart.

Zone rectangles use ``STYLE_BY_CONVICTION``: yellow with opacity
ordered SUPER (0.4) > HIGH (0.3) > MED (0.2); LOW falls back to gray
0.15.

### Plan file shape

```json
{
  "plan_version": 1,
  "generated_at": "2026-05-21T13:35:00+00:00",
  "backend": "tv_desktop",
  "chart_id": "MNQ",
  "zones_json_path": "data/zones/2026-05-20_MNQ_rth.json",
  "state_path": "data/tv_sync_state/tv_desktop_MNQ.json",
  "operations": [
    {"op": "remove", "source_id": "ref:vpoc:27355.00",
     "shape_id": "shape-old", "reason": "not present in zones JSON"},
    {"op": "add", "source_id": "ref:vpoc:27381.25",
     "kind": "reference_line", "label": "VPOC 27381.25",
     "price": 27381.25, "style": {"color": "#84CC16", ...}},
    {"op": "noop", "source_id": "zone:hvn-27380",
     "reason": "already present"}
  ],
  "meta": {
    "time_anchor_hint": "Math.floor(Date.now() / 1000)",
    "createMultipointShape_hint": "...no underscore...",
    "iframe_remount_hint": "..."
  }
}
```

The ``meta`` hints exist to remind the executor agent of the
2026-05-20 incidents (8-week-future-space anchor bug; `_createMultipointShape`
truncation; iframe ID remount).

### CLI

```
python -m rithmic_analytics.cli.tv_sync \
    --zones data/zones/2026-05-20_MNQ_rth.json \
    --target {tv_desktop,tradesea,both} \
    --chart-id MNQ \
    [--dry-run | --apply]
```

Default mode `--dry-run` prints to stdout without writing. `--apply`
writes a timestamped plan file + updates `_latest.json`. Mutually
exclusive. Per-backend failure does NOT gate other backends.

### Executor agent contract

Out of scope for the Python package — see `docs/operations.md` ↳
"Morning workflow → tv_sync executor" for the canonical Claude Code
prompt template.

---

## `viewer.cvd_plot`

[`render_cvd_html(trades, output_path, *, title=None, bar_size_sec=60, show_divergence=True, divergence_window=500, min_divergence=0.5, include_plotlyjs="cdn") -> Path`](../rithmic_analytics/viewer/cvd_plot.py)
writes a self-contained HTML with a Plotly WebGL `Scattergl` price + CVD
overlay. WebGL is mandatory at the 100K+ tick scale — the SVG renderer
hangs. Divergence events from `detect_divergence` are overlaid as triangle
markers when `show_divergence=True`. Raises `ValueError` on empty `trades`.

---

## `viewer.footprint_html`

[`render_footprint_html(footprint, output_path, ...)`](../rithmic_analytics/viewer/footprint_html.py)
renders a `Footprint` to a static HTML heatmap, dark theme, with hover deltas.

---

## `viewer.vp_report`

[`render_daily_report(captures_root, output_path, *, trading_date, ...) -> Path`](../rithmic_analytics/viewer/vp_report.py)
composes the daily HTML report: header gap-alert callout, zones,
CVD chart, footprint, absorption, multi-session, gap warnings. Plotly bundle
is **inlined by default** for offline portability (`include_plotlyjs=True`,
~10.5 MB). Pass `"cdn"` to drop to ~5 KB per file at the cost of needing
internet — see [`future_work.md` item 11](./future_work.md) for the planned
shared-bundle extraction.

---

## `viewer.capture_dashboard`

[`render_capture_dashboard(captures_root, output_path, *, alerts_path=None, lookback_days=30, root_symbol="MNQ", today=None, title=None, include_plotlyjs="cdn") -> Path`](../rithmic_analytics/viewer/capture_dashboard.py)

Operational dashboard for the last N days of captures + alerts. Sections:

1. Header — total bytes, total alerts, FAIL count.
2. Sessions table — RTH/Globex sizes per day (missing → italic "missing"),
   alerts per day.
3. Alert timeline — stacked bar (WARN amber, FAIL red).
4. File-size trend — RTH/Globex MB-per-day lines.
5. Recent alerts — latest 50, table.

Static by design: 30-day data set is small enough to skim by eye, filtering
would be over-engineering. Plotly via CDN by default (re-renders are cheap).

---

## `core.trade_log`

Trade-log loaders for the RA-026 replay framework.

[`load_tradesea_csv(path) -> tuple[list[TradeFill], list[CancelledOrder]]`](../rithmic_analytics/core/trade_log.py)
parses Tradesea's order-history CSV export. Behaviours documented in the
module docstring:

- Reverse-chronological → sorted ascending by `fill_ts_ns`.
- `"CME:MNQ"` symbol → `"MNQ"`.
- `"Buy"`/`"Sell"` → `"buy"`/`"sell"`.
- Pacific time (`PDT`/`PST`) → UTC. The TZ label is sanity-checked against
  the date-derived offset; mismatch logs a WARNING but parsing proceeds.
- **Missing-decimal recovery** for prices ≥6 digits with no `.`:
  6-digit → ÷10, 7-digit → ÷100, ≥8-digit → `None` + `quarantined=True`.
  Always logs a WARNING with raw + recovered values for audit.
- Statuses other than `"Filled"` route to `CancelledOrder`. Unknown
  statuses warn but still route to the cancelled list (forward-compat).

[`load_manual_log(path) -> list[TradeFill]`](../rithmic_analytics/core/trade_log.py)
parses a hand-maintained JSON log. Schema validated via `jsonschema`. ISO-8601
timestamps with an explicit offset are required (naive timestamps raise).

Dataclasses (frozen, slots):

- `TradeFill(fill_ts_ns, symbol, side, price, quantity, order_type, fill_id, notes="", quarantined=False)`
- `CancelledOrder(cancel_ts_ns, symbol, side, order_type, limit_price, stop_price, quantity, status, quarantined=False)`

---

## `features.trade_replay`

Pre/post-fill orderflow snapshots — RA-026.

[`compute_fill_snapshot(fill, trades, contract, *, zones=None, atr_14=None, window_seconds=60, pnl_horizons_seconds=(60,300,900)) -> FillSnapshot`](../rithmic_analytics/features/trade_replay.py)

For one fill, computes window stats (volume / delta / aggressor-ratio / VWAP /
price-change) on the pre and post windows, cumulative CVD at the fill and
60s after, zone proximity (1×ATR filter, top-5 cap; falls back to top-5
nearest when `atr_14 is None`), and realised gross PnL at each horizon
(`× qty × dollars_per_point`). Quarantined fills return NaN PnL. PnL is
`None` for horizons that exceed the session window.

[`replay_session(fills, trades, contract, *, zones=None, atr_14=None, cancelled=None, window_seconds=60, pnl_horizons_seconds=(60,300,900)) -> ReplaySession`](../rithmic_analytics/features/trade_replay.py)

Vectorised replay across all fills. Returns a `ReplaySession` carrying
sorted snapshots + cancellation pass-through + skip-counter metadata:

- `fills_skipped_symbol_mismatch` — fills whose symbol ≠ `contract.root`.
- `fills_skipped_outside_window` — fills with `fill_ts_ns` outside
  `[trades.event_ts_ns.min(), .max()]`.

Both skips log a WARNING; both counters render in the HTML report.

Perf: vectorised via `np.searchsorted`. 100K trades × 50 fills runs in
under 5s.

---

## `viewer.trade_replay_report`

[`render_trade_replay_html(session, output_path, *, title=None) -> Path`](../rithmic_analytics/viewer/trade_replay_report.py)

Self-contained HTML report with five regions:

1. **Header** — total fills, gross PnL@60s, hit-rate@60s, best ET hour
   bucket (≥3 fills required to qualify).
2. **Skip-counter callouts** — surfaces `symbol_mismatch` and
   `outside_window` counts.
3. **Fills table** — time, side, price, qty, pre Δ, post Δ, PnL columns
   per horizon, nearest zone. Green/red coded PnL cells, quarantined fills
   visually marked.
4. **Cancellations table** (only when supplied) — count + cancellation-rate
   header, intent column for limit/stop prices.
5. **Footer** — pointer to docs.

Dark theme, no JS, no external assets.

---

## `features.zone_quality`

Daily zone-quality scoring — RA-027. Classifies each zone against the
session's price action: did price touch it? If touched, did it hold or
break? Aggregates per-conviction hit-rates with Wilson 95% confidence
intervals so a 30-session rolling window can tell you whether SUPER
zones really hold 80%+, HIGH ~60%, etc.

### Functional role, not declared type

**Phase-1 zones default to `type="support"` regardless of price location**
([feature_reference.md → Phase-1 zone type resolution](#phase-1-zone-type-resolution)).
The classifier ignores the declared type and instead derives the
**functional role** from price-vs-zone at session open:

- Reference price = median of the first `max(100 trades, 60 sec)` of the
  session (time floor protects against post-Fed-day burst opens).
- `reference_price > zone.top` → role = `support` (price above, zone acts
  from below).
- `reference_price < zone.bot` → role = `resistance` (price below).
- Inside the band → role = `internal` → ambiguous, *unless* the
  internal-at-open carveout resolves it.

The original `zone.type` is preserved as `declared_type` for audit.

### Internal-at-open carveout

If price opens inside the zone but **exits cleanly within the first 5
minutes** and never returns to the zone band for the rest of that window,
the classifier reclassifies role by exit direction (above → `support`,
below → `resistance`). The session-open "touch" is treated as a non-event;
subsequent re-entries are real touches. Configurable via
`--internal-carveout-minutes`.

### API

[`classify_zones(zones, trades, contract, *, atr_14=None, settlement_window_minutes=10, internal_carveout_minutes=5) -> list[ZoneOutcome]`](../rithmic_analytics/features/zone_quality.py)

Per-zone classification. Vectorised; sub-second on 50 zones × 100K trades.

[`score_session(zones, trades, contract, *, ...) -> SessionQualityReport`](../rithmic_analytics/features/zone_quality.py)

Wraps `classify_zones` and produces per-conviction + per-role roll-ups.
**All four conviction tiers are rendered explicitly** in
`summary_by_conviction` even when `n_zones=0` — empty rows are a feature
(visible "we looked, found nothing"), not noise.

[`aggregate_history(reports, *, window_sessions=30) -> HistoryReport`](../rithmic_analytics/features/zone_quality.py)

Rolling-window aggregate with **Wilson 95% CI** per tier. Hit-rate is
`None` (`insufficient_data=True`) when `n_trials < 5`. Pairing modes from
the source reports must match — `aggregate_history` raises `ValueError`
on mixed pairings.

[`wilson_ci(successes, trials, *, z=1.96) -> tuple[float, float]`](../rithmic_analytics/features/zone_quality.py)

Stdlib-only Wilson score interval. Correct for small N and extreme rates
where the normal approximation breaks down.

---

## `features.zone_probability`

Conviction-conditioned zone probability annotation — RA-038. Reads a
:class:`HistoryReport` and a :class:`ZoneEnvelope`, emits one
:class:`ZoneProbabilityAnnotation` per zone with:

- `p_hold_ci_low`: Wilson 95% CI **lower bound** — conservative operating
  P(hold). Used so thin history degrades sizing gracefully.
- `bounce_r`: `avg_bounce_distance_pts / atr_14`.
- `expected_r`: `p_hold_ci_low * bounce_r - (1 - p_hold_ci_low)`.
- `sizing_decision`: `"full"` (>0.3R), `"half"` (0.1–0.3R), `"skip"`
  (<0.1R), or `"insufficient_history"` (tier flagged or history missing).

**Conviction-only**: annotations key on conviction tier alone, not
`(conviction × role)`. The underlying `HistoryReport.hit_rate_by_conviction`
schema doesn't carry role; the functional role is displayed in the rendered
card for context but does not enter the math. Role conditioning is queued
for RA-040-candidate. The renderer always surfaces this limitation in a
note line.

[`annotate_zones_with_probability(envelope, history, *, trading_date_iso) -> AnnotatedZoneEnvelope`](../rithmic_analytics/features/zone_probability.py)
— builds annotations + envelope wrapper. Bootstrap-safe: `history=None` or
all-insufficient → `bootstrap_mode=True`, every zone gets
`sizing_decision="insufficient_history"`.

[`render_probability_card(annotated) -> str`](../rithmic_analytics/viewer/probability_card.py)
— markdown renderer. Header says **"trailing-N window, n=K sessions"** —
no explicit date range (Q-RA038-2). The `daily_zones` CLI exposes this
behind `--emit-probability-card` (default OFF, defensive).

### Outcome semantics

| `final_outcome` | When |
|---|---|
| `untouched` | Price never entered the zone band. |
| `held` | Touched + no break threshold hit + settlement window cleared. |
| `broken` | Touched + price moved past zone by >0.5×ATR(14) in the wrong direction. **Broken trumps held** in multi-touch sessions. |
| `ambiguous` | Touched but post-touch tape is shorter than the settlement window (default 10 min); OR started inside zone and didn't exit cleanly; OR ATR fallback fired. |

`ambiguous` outcomes are **excluded from hit-rate denominators** but
counted separately so they're visible.

### Settlement window: 10 minutes

A touch in the final 10 minutes of a session with no break lands
`ambiguous`, not `held` — prevents news-spike wicks from polluting the
hit-rate. One full 5-min bar of follow-through is the minimum to call
structural intent rather than noise. Configurable via
`--settlement-window-minutes`.

### ATR resolution order

1. `envelope.atr_14` (preferred).
2. Recompute from trades via `compute_atr_from_ticks(period=14,
   bar_size_ns=NS_5M)`.
3. Contract-aware fallback (`tick_size × 20` = 5 pts for MNQ).
   `atr_fallback=True` on the report so consumers can discount confidence.

### Dataclasses (frozen, slots)

- `ZoneOutcome(zone_id, declared_type, functional_role, conviction, top, bot, touched, first_touch_ts_ns?, max_penetration_pts?, held?, broken?, first_break_ts_ns?, bounce_distance_pts?, continuation_distance_pts?, final_outcome, notes)`
- `ConvictionSummary(conviction, n_zones, n_touched, n_held, n_broken, n_ambiguous, n_untouched, hit_rate?)`
- `SessionQualityReport(session_id, trading_date, outcomes, summary_by_conviction, summary_by_role, atr_used, atr_fallback, pairing, reference_price, settlement_window_minutes)`
- `BinomialEstimate(n_trials, n_success, rate?, ci_low, ci_high, insufficient_data)`
- `HistoryReport(sessions_analyzed, window_sessions, pairing, hit_rate_by_conviction, avg_bounce_distance_by_conviction, avg_continuation_distance_by_conviction, insufficient_data_tiers)`

---

## RA-052 intraday-light / EOD-heavy operations

`daily_zones` now has an explicit operational mode:

- `--mode light`: intraday-safe. Refuses `--emit-pressure-json` and
  `--emit-cancellation-analysis` because those require full MBO/order
  lifecycle scans.
- `--mode full`: EOD-heavy. Enables pressure and cancellation analytics and
  is intended for the post-RTH full run.
- No `--mode` + heavy flags: backward-compatible route to full mode with a
  deprecation warning.
- No `--mode` + no heavy flags: defaults to light mode.

`normalize_probe_incremental` is the intraday normalizer:

```powershell
python -m rithmic_analytics.cli.normalize_probe_incremental `
  --input data\captures\<date>\MNQ_rth.jsonl `
  --output data\captures\<date>\MNQ_rth.obs01.jsonl
```

It tracks `<capture>.obs01.normalize_state.json`, resumes from the last byte
offset, appends to OBS-01/MBP1/MBO siblings, and falls back to full normalize
when state is missing/corrupt/invalid. Full fallback writes
`normalize_state_missing_fallback_full` into the dashboard audit file when
`--audit-path` is supplied.

---

## CLI entry points

| Entry point | Purpose | Ticket |
|---|---|---|
| `python -m rithmic_analytics.cli.compute_vp` | One-shot VP → zone JSON | RA-006 |
| `python -m rithmic_analytics.cli.start_capture` | Probe supervision wrapper | RA-007 |
| `python -m rithmic_analytics.cli.daily_zones` | Zone-JSON orchestrator with `--mode light\|full`; light is intraday-safe, full is EOD-heavy | RA-010 / RA-030.1 / RA-052 |
| `python -m rithmic_analytics.cli.rotate` | Capture rotation | RA-008 |
| `python -m rithmic_analytics.cli.heartbeat` | Daily heartbeat task | RA-011 |
| `python -m rithmic_analytics.cli.replay_session` | Trade-replay HTML report | RA-026 |
| `python -m rithmic_analytics.cli.score_zones` | Zone-quality scoring (single + aggregate) | RA-027 |
| `python -m rithmic_analytics.cli.normalize` | Probe-parity → OBS-01 normalizer (+ optional MBP1 / MBO siblings via `--mbp1-output` / `--mbo-output`) | RA-029 / RA-030 / RA-035 |
| `python -m rithmic_analytics.cli.normalize_probe_incremental` | Byte-offset incremental normalizer for 5-minute dashboard refresh loops | RA-052 |
| `python -m rithmic_analytics.cli.compute_pressure` | MBO add/cancel pressure detector (standalone) | RA-035 |
| `python -m rithmic_analytics.cli.analyze_cancellations` | Tradesea cancellation pattern analytics (Rule 7) | RA-036 |
| `python -m rithmic_analytics.cli.tv_sync` | TV / Tradesea chart-sync planner (plan-emit only; executor agent applies) | RA-034 |

Each module's docstring documents flags + exit codes. The scheduled-task wiring
is in [`task_scheduler_setup.md`](./task_scheduler_setup.md).

---

## Interactive exploration

For ad-hoc poking at a session: [`scripts/explore_session.py`](../scripts/explore_session.py)
pre-populates `trades`, `vp`, `cvd_df`, `footprint`, `absorption_events`,
`multi`, and `envelope` as locals. Invoke with
`python -i scripts/explore_session.py <trading-date>`.
