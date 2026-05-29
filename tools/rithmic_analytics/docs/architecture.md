# Architecture

This document explains the **shape of the codebase and why specific decisions
were made**. For *what each function does*, read
[`feature_reference.md`](./feature_reference.md). For *how to run the
pipeline*, read [`operations.md`](./operations.md).

A new engineer landing here should be able to:

1. Run the [Setup](./README.md#setup) commands cleanly.
2. Read this file end-to-end in 20–30 minutes.
3. Form a mental model of the data flow without grepping the source.

The decision log (D-001 onward) is the load-bearing part — those are the
choices that look wrong without context.

## Goals + non-goals

**Goals.**
- Tick-accurate analytics for MNQ futures off Rithmic captures, **offline**
  (no live streaming dependency in the analytics layer).
- One canonical zone JSON envelope that every downstream consumer reads.
- Operational hygiene: gap detection, heartbeat checks, rotation, capture
  quality dashboard.
- Defensible decisions — anything that diverges from QFA's conventions or the
  obvious approach is in the decision log.

**Non-goals.**
- Live market-data streaming or order routing — out of scope by design;
  Rithmic captures land via QFA's `capture-rithmic-probe.py` and this layer
  reads the resulting JSONL.
- Multi-symbol support beyond MNQ — `core.contracts` is structured for
  extension (one constant per symbol) but only `MNQ` is shipped.
- Hot-path latency. Detectors batch over JSONL and emit dataclasses; we
  optimise correctness and clarity over per-tick speed. Hidden-liquidity
  inference is the heaviest single feature (~5 GB peak DataFrame at full
  RTH); see [`future_work.md` item 13](./future_work.md) for the chunk-join
  plan.

## Data flow (one screen)

```
                  QFA capture-rithmic-probe.py
                          │
                          ▼
   data/captures/YYYY-MM-DD/{ROOT}_{rth,globex}.jsonl   ← trading-day partitioned (D-003)
                          │
        ┌─────────────────┼──────────────────────────────────────┐
        ▼                 ▼                                       ▼
   core.loader     ops.alerts (scan gaps)            ops.rotation (compress/delete)
        │                 │                                       │
        ▼                 ▼                                       ▼
  pd.DataFrame    data/alerts/alerts.ndjson             data/captures_archive/...
        │                 │
        ├────────┬────────┼──────────┬────────┬─────────────┐
        ▼        ▼        ▼          ▼        ▼             ▼
  volume_   atr   cvd  footprint  absorption  sweep   hidden_liquidity
   profile                                            (needs MBP10)
        │
        ▼
   core.schema.ZoneEnvelope ──validate_envelope──▶ data/zones/{date}_{root}_{session}.json
                                                   │
                                                   ▼
                                         viewer.vp_report (daily HTML)
                                         viewer.capture_dashboard (last-30 ops dashboard)
                                         chart-drawing tooling (RA-020 retrofit)
```

The canonical timestamp on every DataFrame is `event_ts_ns` ([D-004](#d-004--canonical-timestamp-is-payloadexchange_event_ts_ns-all-tickets)).

## Module map

| Module | Responsibility |
|---|---|
| [`core.contracts`](../rithmic_analytics/core/contracts.py) | Per-symbol metadata (tick size, $/point). Single `MNQ` instance exported. |
| [`core.loader`](../rithmic_analytics/core/loader.py) | JSONL → pandas DataFrames for OBS-01 / MBP1 / MBP10 / MBO. Canonical column names + dtypes. |
| [`core.schema`](../rithmic_analytics/core/schema.py) + `zone_schema.json` | `Zone` / `ReferenceLine` / `ZoneEnvelope` dataclasses + JSON Schema validator. Wire format every consumer reads. |
| [`features.volume_profile`](../rithmic_analytics/features/volume_profile.py) | VPOC / VAH / VAL / HVN / LVN compute. |
| [`features.atr`](../rithmic_analytics/features/atr.py) | Wilder ATR over event-time-bucketed OHLC. |
| [`features.cvd`](../rithmic_analytics/features/cvd.py) | True CVD + 1-minute bucketed deltas + divergence detector. |
| [`features.footprint`](../rithmic_analytics/features/footprint.py) | Time × price pivot of net deltas + imbalance ratios. |
| [`features.absorption`](../rithmic_analytics/features/absorption.py) | Absorption events (Bookmap-equivalent), four-factor score. Methodology: [`absorption_methodology.md`](./absorption_methodology.md). |
| [`features.sweep`](../rithmic_analytics/features/sweep.py) | Sweep events (inverse absorption), four-factor score. |
| [`features.hidden_liquidity`](../rithmic_analytics/features/hidden_liquidity.py) | Per-trade iceberg/refill inference via MBP10 asof-join. Opt-in (storage cost). |
| [`features.multi_session`](../rithmic_analytics/features/multi_session.py) | HVN clustering across N most-recent sessions. STRUCTURAL conviction tag. |
| [`features.ohlcv_aggregate`](../rithmic_analytics/features/ohlcv_aggregate.py) | Tick → OHLCV bar resampling. |
| [`ops.alerts`](../rithmic_analytics/ops/alerts.py) | Gap detection (LAST_TRADE + L1_QUOTE) → `alerts.ndjson`. Optional Discord webhook. |
| [`ops.rotation`](../rithmic_analytics/ops/rotation.py) | Compress raw captures older than 2 days; delete archives older than 14. |
| [`ops.heartbeat_check`](../rithmic_analytics/ops/heartbeat_check.py) | Daily "I'm alive" file + miss-detection on past weekdays. |
| [`ops.rollover_calendar`](../rithmic_analytics/ops/rollover_calendar.py) | Front-month resolution. Playbook: [`rollover_playbook.md`](./rollover_playbook.md). |
| [`ops.credentials`](../rithmic_analytics/ops/credentials.py) | `RITHMIC_*` env-var loader; raises `CredentialsMissing`. |
| [`viewer.cvd_plot`](../rithmic_analytics/viewer/cvd_plot.py) | Plotly WebGL price + CVD chart (Scattergl mandatory at 100K+ scale). |
| [`viewer.footprint_html`](../rithmic_analytics/viewer/footprint_html.py) | Footprint heatmap HTML. |
| [`viewer.vp_report`](../rithmic_analytics/viewer/vp_report.py) | Daily HTML report (7 sections incl. zones, CVD, footprint, absorption, multi-session). |
| [`viewer.capture_dashboard`](../rithmic_analytics/viewer/capture_dashboard.py) | Operational dashboard (30-day capture stats + alerts). |
| [`cli.*`](../rithmic_analytics/cli/) | `compute_vp`, `start_capture`, `daily_zones`, `rotate`, `heartbeat` entry points. |

## Cross-cutting conventions

- **`event_ts_ns` everywhere.** All time-bucketing, all `merge_asof`, all
  binning. See [D-004](#d-004--canonical-timestamp-is-payloadexchange_event_ts_ns-all-tickets).
- **Trading-day partitioning.** `data/captures/{YYYY-MM-DD}/...`. See
  [D-003](#d-003--trading-date-partitioning-for-file-layout-ra-007).
- **Frozen-dataclass configs.** `SweepConfig`, `AbsorptionConfig`,
  `HiddenLiquidityConfig`, `GapThresholds`, `RetentionPolicy`. MNQ-calibrated
  defaults; weights validated to sum to 1.0 at construction.
- **Empty-input contract.** Every loader and detector returns an empty
  DataFrame / list / summary with the correct schema/dtypes — never raises
  on an empty input. Tests rely on this; downstream code can `len(...)`
  without try/except.
- **Single `alerts.ndjson`.** Gap alerts and heartbeat-miss alerts share the
  same file. See [D-005](#d-005--gap-dataclass-repurposed-for-operational-alerts-ra-011).
- **Strict tooling.** `ruff check .` clean, `mypy .` clean. `pyproject.toml`
  pins ruff line length 100 and mypy strict-ish (pandas-stubs + types-jsonschema
  in the dev set).
- **Vendored from QFA, not imported.** QFA has no installable layout
  (no `pyproject.toml` at root), so `RetentionPolicy` and `GapThresholds`
  defaults are copied with drift-detection tests. See
  [D-001](#d-001--diverge-from-qfas-plan_l1_trade_retention-scanner-ra-008).

## Decision log

### D-001 — Diverge from QFA's `plan_l1_trade_retention` scanner (RA-008)

**Context.** QFA's `services/market_data_sidecar/retention.py` exposes
`L1TradeRetentionPolicy` (dataclass of retention thresholds) **and** a full
scanner / planner / applier (`plan_l1_trade_retention`,
`apply_l1_trade_retention`). The scanner validates every `*.jsonl` file in
`journal_dir` against `SESSION_ID_PATTERN = ^\d{4}-\d{2}-\d{2}-rth$` — no
prefix, RTH only — and rejects any file whose envelopes carry a session_id
in a different shape.

**Problem.** Our capture envelopes use `session_id = "mnq-YYYY-MM-DD-{rth,globex}"`
(MNQ-prefixed, both sessions). QFA's scanner rejects every one of our files as
`invalid_session_id`.

**Decision.** RA-008 implements its **own scanner** against our actual file
naming + session-id convention. We **reuse `L1TradeRetentionPolicy` for its
config defaults** only (`keep_raw_rth_sessions=2`, `compressed_hot_days=14`,
disk pressure thresholds) — the values are operationally correct; the
algorithm isn't.

**Implications for future readers.**
- Don't try to wire `plan_l1_trade_retention()` into the pipeline. It will
  fail on our files even if the file paths are right.
- If QFA's session-id convention ever moves to MNQ-prefixed (e.g. via a
  shared schema change), revisit this — at that point we could collapse the
  two implementations.

**Implementation note (RA-008 build).** We vendor the dataclass as
`rithmic_analytics.ops.rotation.RetentionPolicy` rather than importing
`L1TradeRetentionPolicy`, because QFA has no installable package layout
(no `pyproject.toml` at the QFA root). Field names + defaults are kept
identical. If QFA changes their defaults, update ours to match — the
`test_retention_policy_defaults_match_qfa` test will flag the drift if you
forget.

### D-002 — Probe SIGTERM is a hard kill on Windows (RA-007)

QFA's `capture-rithmic-probe.py` has no `signal.signal` handlers and only
catches `KeyboardInterrupt` at `main()` level. The asyncio `run_probe()` loop
runs to `--duration-sec` and exits naturally. There is no graceful-shutdown
hook a parent can use to stop it cleanly.

**Decision.** The wrapper relies on `--duration-sec` for termination. On
wrapper SIGINT, we call `proc.terminate()`, wait 5 seconds, then `proc.kill()`
if needed. On Windows `terminate()` is effectively `kill()`, so the JSONL
output may be missing its last line. RA-009's gap detector will surface this
as a terminal-gap alert; not silently lost.

### D-003 — Trading-date partitioning for file layout (RA-007)

Capture files land at `data/captures/{trading_date}/{root}_{session}.jsonl`
where `trading_date` is the date the session **ends on**, not the wall-clock
date the wrapper launched on:

- RTH 2026-05-15 09:25 ET → 16:05 ET → `data/captures/2026-05-15/MNQ_rth.jsonl`
- Globex 2026-05-14 17:55 ET → 2026-05-15 09:30 ET → `data/captures/2026-05-15/MNQ_globex.jsonl`

`ls data/captures/<date>/` gives all data for that trading day, regardless of
wall-clock dates. Analytics queries always work in trading days.

### D-004 — Canonical timestamp is `payload.exchange_event_ts_ns` (all tickets)

Every analytics feature buckets by `event_ts_ns` (the loader-renamed alias for
`payload.exchange_event_ts_ns`), never by `recv_ts_ns`. Mixing produces
subtle off-by-microseconds bugs at session boundaries. Enforced by
`core/loader.py`'s rename step; documented inline at every feature
docstring that performs binning.

### D-010 — Adaptive `bin_size_ticks` per ATR regime is opt-in (RA-039)

**Context.** A fixed 20-tick bin width (5 pts on MNQ) works well in
typical-volatility sessions but degrades in either direction: a 12-pt
ATR session is over-binned (whole HVN clusters merge into one bin), a
55-pt session is under-binned (one structural support spans 3+ bins).

**Decision.** Add `bin_size_mode={"fixed", "adaptive", "adaptive_fallback"}`
to `compute_vp`. Default is `"fixed"` (byte-exact backward-compatible).
Adaptive resolves `effective_bin_size_ticks = clamp(round(atr_14/4),
[4, 40])`. The `/4` factor is calibrated so the value area sits at
roughly 16 bins across volatility regimes — a uniform value-area
resolution regardless of ATR.

**Why opt-in default.** The whole zone-emit pipeline + all downstream
consumers (zone JSON, retrofit `vp_*.py`, multi-session aggregation)
encode bin-low arithmetic. Flipping default to adaptive would silently
change every operator's chart geometry overnight; defensive emit pattern
demands the new behavior be a kwarg, never automatic.

**Provenance.** `VolumeProfile.effective_bin_size_ticks` and
`bin_size_mode` are persisted on the dataclass so downstream tooling can
audit what was actually used (and ZoneEnvelope reports the effective
ticks rather than the kwarg value).

**Fallback policy.** NaN ATR (e.g. early-session capture with <14 bars)
falls back to the legacy 20-tick default, emits a WARN log, and marks
the profile with `bin_size_mode="adaptive_fallback"` — failure mode is
"behave like fixed" rather than "raise."

### D-009 — MBO-derived pressure as lean-stack alternative to MBP10 heatmap (RA-035)

**Context.** Bookmap's heatmap visualisation gives traders an immediate
read on resting-order intent: where the queue is building, where it's
thinning, where spoofers are throwing in size only to pull it. The most
direct way to replicate this would be MBP10 (top-10 depth snapshots,
~1 update per ms). MBP10 captures the full visible book but costs
~28 GB per RTH session — operationally prohibitive for daily storage.

**The MBO alternative.** Rithmic's MBO stream carries per-order
lifecycle events (Add / Modify / Cancel / Fill / Trade) — every
individual order placed, modified, or removed at any depth. From this
event tape we can extract the same signals a heatmap conveys:

- **add_cancel_ratio** = order arrival rate ÷ cancel rate per level →
  is this level being pulled faster than offered?
- **depletion_velocity_per_sec** = (cancels + fills) / window → how
  fast is the queue at this level shrinking?
- **spoof_score** ∈ [0, 1] = fraction of adds that cancel within
  500ms without filling → "shown but withdrawn" signature.

MBO is ~3-4 GB/session uncompressed (no depth-snapshot cost) — within
the lean stack's storage budget already.

**Decision.** Build ``features/order_pressure.py`` as the canonical
order-flow pressure signal. **Do NOT add MBP10 to the lean stack.** If
a future need for true depth visualisation arises (chart rendering,
heatmap export), MBP10 capture is opt-in per RA-017's documented
storage tradeoff.

**Implications.**
- The MBO normalizer (RA-035 extension to ``ops/normalize_probe.py``)
  produces a third sibling ``.mbo.jsonl`` alongside ``.obs01.jsonl``
  and ``.mbp1.jsonl``. Single-pass routing — symmetric with the
  L1_QUOTE→MBP1 path established in RA-030.
- Action enum translation: probe-parity ``{"new","change","delete"}``
  → databento-flat ``{"A","M","C"}``. Forward-compat passthrough for
  ``F``/``T`` if/when the probe schema grows.
- Sweep detection (RA-016) already consumes the raw MBO action="T"
  events. Pressure detection consumes the non-T lifecycle events.
  These are independent dimensions of the same MBO stream — no
  cross-contamination.

**Out of scope (deferred to future tickets).**
- Real-time / streaming pressure (this is a post-capture batch feature).
- Chart heatmap rendering (would be its own RA-019-style HTML viewer).
- Cross-source attribution (joining pressure to absorption events
  at fill-time) — RA-028's job once ≥5 paired sessions accumulate.

### D-008 — VWAP anchor choices (RA-031)

**Context.** RA-031 ships session-anchored VWAP + σ bands as the canonical
band reference. Three anchor types are supported — anything more
flexible (rolling N-session, user-anchored) is operator ergonomics, not a
daily-zones primitive.

**Decision.** Three fixed anchors:

- ``"rth"`` — 09:30 ET session open (the day the last trade falls in).
- ``"globex"`` — 17:00 ET prior business day (Globex open).
- ``"weekly"`` — Sunday 17:00 ET (week open).

Anchor resolution uses the **last trade's** timestamp, not the first.
This ensures a capture spanning Globex-pre-open through RTH correctly
anchors at today's 09:30, excluding the few pre-open prints. A capture
entirely before the day's RTH falls back to the prior business day's
anchor.

**Why these three.** The `grade_zone` HIGH conviction tier requires a
band source overlapping an HVN zone — pre-RA-031 there were zero band
sources in Phase-1 output, so HIGH was effectively unreachable. RTH and
Globex match the operator's session-prep workflow; weekly catches
swing-trade structural references.

**Out of scope.** AVWAP from arbitrary user-chosen anchors (TradingView
ergonomic, not daily-zones primitive). Multi-session rolling anchors
(can layer later if the simple anchors prove insufficient).

### D-007 — L1_QUOTE is the Rithmic-native top-of-book stream (RA-030)

**Context.** The live Rithmic probe doesn't support ``--streams MBP1``
— allowed values are ``LAST_TRADE, L1_QUOTE, MBP10, MBO``. The lean
stack captures ``L1_QUOTE`` instead, which carries the same top-of-book
information (``bid_px``, ``ask_px``, ``bid_sz``, ``ask_sz``, ``bid_orders``,
``ask_orders``) per ``--parity-payload`` mode.

**Problem.** The downstream OBS-01 / MBP1 / MBO loaders are the
analytics-layer contract. ``load_mbp1()`` expects databento-flat
records with ``bid_px_00`` / ``ask_px_00`` etc. Pre-RA-030, the
normalizer routed L1_QUOTE records to ``skipped_wrong_stream`` —
``load_mbp1()`` returned empty against live captures, ``absorption``
fell back to ``mbp1_stale=True`` with ``displacement_factor=0``, and
the four-factor detector silently ran in three-factor degraded mode.

**Decision.** Add a second output path to ``normalize_probe``: a
``.mbp1.jsonl`` sibling produced in the same pass as the
``.obs01.jsonl``. L1_QUOTE records route there via
``parity_l1quote_record_to_mbp1_dict``. Field map is a straight rename:

| parity | MBP1 |
|---|---|
| ``exchange_event_ts_ns`` | ``ts_event_ns`` |
| ``sidecar_recv_ts_ns`` | ``ts_recv_ns`` |
| ``bid_px`` | ``bid_px_00`` |
| ``bid_sz`` | ``bid_sz_00`` |
| ``bid_orders`` | ``bid_ct_00`` |
| ``ask_px`` | ``ask_px_00`` |
| ``ask_sz`` | ``ask_sz_00`` |
| ``ask_orders`` | ``ask_ct_00`` |

**Why MBP1 isn't a capture-time stream.** Because the probe doesn't
accept it. The L1_QUOTE → MBP1 transformation is normalize-time, not
capture-time. This decoupling lets us keep the analytics-layer loader
contract (``load_mbp1`` reads databento-flat) without forcing the probe
to grow a new stream type.

**Implications for future readers.**
- One-sided quotes (only bid OR only ask) are emitted with the missing
  side as 0/0.0 by the pure converter; **RA-041 then forward-fills the
  unchanged side from cached prior state at the normalize loop** so
  ``load_mbp1`` reads a snapshot stream (>95% two-sided coverage on real
  Globex post-fix; 100% on 2026-05-20 measured). See the RA-041 update
  below.
- Pre-RA-030 captures need re-normalization to restore four-factor
  absorption scores (separate ad-hoc reprocessing; not auto-backfilled).
- Default absorption thresholds (``min_onesidedness=0.6``,
  ``min_displacement=0.5``) were calibrated against synthetic fixtures;
  real-data calibration is the B2 follow-up that was explicitly blocked
  on RA-030 to avoid calibrating against the degraded three-factor signal.

**RA-041 update — delta-stream → snapshot-stream conversion.**

The L1_QUOTE parity stream is **delta-shaped**: when only the bid moves,
the input JSON omits ``ask_px``, ``ask_sz``, ``ask_orders`` entirely.
The original D-007 implementation filled the missing side with
``0.0``/``0``/``0`` and treated the result as a snapshot — silently
shipping 99.8% one-sided rows in the on-disk MBP1 sibling on real MNQ
Globex captures (empirically measured on 2026-05-20 via the RA-037 spread
diagnostic). The asof-merge inside ``compute_absorption_events`` was
masking this by pulling forward whatever sparse two-sided rows existed
(0.03% of records), producing displacement values minutes stale of the
trade bar.

RA-041 inserts a session-scoped ``_L1QuoteForwardFiller`` between the
pure converter and the JSONL writer. State per side is a triple
``(px, sz, ct)``; when a side is absent from input AND we have prior
state → substitute; otherwise (first records) emit JSON ``null`` for the
price (loader→NaN; RA-040 filter handles correctly). Two diagnostic
counters land on ``NormalizeReport`` (``mbp1_forward_filled``,
``mbp1_first_record_one_sided``) so ops can verify the steady-state
regime is what's expected (~99% filled, 1-5 first-record edges per session).

**Forward-fill is unconditional across reconnects.** Stale cache after a
long gap is preferred over NaN — downstream consumers already treat MBP1
as best-effort and stale-but-plausible depth is more useful than no
depth. Gap-detection + reset is a v2 candidate; if the diagnostic
counters reveal a real problem in production we'll add it then.

**Cached-sibling invalidation.** Existing ``<root>_<session>.obs01.jsonl``
files paired with pre-RA-041 ``.mbp1.jsonl`` siblings carry delta-shaped
MBP1 data. To pick up RA-041's forward-fill, operators delete the cached
OBS-01 sibling — the next ``daily_zones`` run re-normalizes from the raw
parity capture and produces both fresh siblings together (mirrors the
RA-035 MBO sibling invalidation workflow). See ``operations.md``.

### D-006 — Capture pipeline runs probe-parity → normalize → OBS-01 (RA-029)

**Context.** QFA's `capture-rithmic-probe.py` writes JSONL records with a
flat per-stream envelope (`stream`, `exchange_event_ts_ns`, `template_id`,
…). It exposes two flags that change what trade-level data lands in those
records:

- **`--raw`** appends a base64-encoded protobuf to each record (`raw_b64`).
- **`--parity-payload`** appends extracted JSON fields (`price`, `size`,
  `aggressor`, etc.) using the probe's own `normalize_*_payload`
  functions.

Neither is on by default. The wrapper before RA-029 invoked the probe with
neither flag, producing **metadata-only** captures — `raw_present: false`,
no parity fields — which the downstream `load_obs01_trades()` couldn't
consume. The 2026-05-19 live-validation capture is in this state and is
unrecoverable.

**Decision.** Enable `--parity-payload` by default in the wrapper, and
ship a thin `ops/normalize_probe.py` bridge that transforms parity-mode
records into the OBS-01 envelope shape (`type: "TRADE"`, `payload: {...}`)
the rest of the analytics layer reads. Storage cost measured at +39% over
bare (~6.6 GB/RTH for the lean stack, well under the 25 GB ceiling).

**Why `--parity-payload` over `--raw`:**
- The validated OBS-01 fixtures shipped with the repo came through this
  code path — proven shape, no schema surprises.
- Pure JSON transformation in the normalizer — no protobuf decode, no
  base64, no rProtocol SDK dependency in the analytics layer.
- Slightly cheaper storage than `--raw` for the lean stack.
- `--raw` remains available on the probe for forensic debugging; we just
  don't make it the default.

**Pipeline shape:**

```
probe (--parity-payload) → raw JSONL → normalize_probe → *.obs01.jsonl → analytics
                              ↑                              ↑
                  data/captures/YYYY-MM-DD/    same dir, .obs01.jsonl sibling
                  <ROOT>_<session>.jsonl       (cached; idempotent reuse)
```

`cli/daily_zones.py` runs the normalizer automatically on the morning
sweep — operators don't have to invoke `cli/normalize.py` manually for
the nightly pipeline. Manual invocation is for one-off backfills.

**Implications for future readers.**
- The 2026-05-19 capture is **unrecoverable** for trade-level analytics
  (raw_present:false + no parity = price/qty data was never persisted).
  `normalize_probe` detects this case and refuses to produce empty output.
- A future probe schema change that drops a parity field would surface as
  a `skipped_missing_payload` count in the `NormalizeReport`; downstream
  tests guard the canonical field set via the golden-file parity test.
- If we ever need to add MBP10 to the lean stack, `--parity-payload`
  already covers it — `normalize_mbp10_payload` runs inside the probe.

### D-005 — `Gap` dataclass repurposed for operational alerts (RA-011)

Heartbeat misses (`CAPTURE_HEARTBEAT_MISSING`) write to the same
`alerts.ndjson` file as gap-stream alerts (RA-009). They use
`stream="HEARTBEAT"`, `gap_type="missing_capture"`, `gap_value_ns=null`,
`threshold_ns=null`. The field names `stream` and `gap_type` are historical
(RA-009 origin); the nullable numeric fields signal "operational alert, not
gap-stream measurement."

Why broaden rather than introduce a separate `OperationalAlert` dataclass:
- Single NDJSON file, single consumer shape for the RA-012 dashboard
- Zero migration risk on the existing `alerts.ndjson` schema
- The `StreamName` `Literal` carries the category tag cleanly

When we add a third alert category (e.g., disk-full, prop-limit-warning),
refactor to a unified `Alert` dataclass with `category` / `alert_type`
field names. For now, the nullable numeric fields are operationally fine.
The drift-detection test (`test_gap_thresholds_defaults_match_qfa`) covers
the QFA-defaults invariant.
