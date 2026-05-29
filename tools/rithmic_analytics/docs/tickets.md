# Rithmic Analytics — Engineering Ticket Backlog (v2, post-review)

**Project**: Build a Python analytics layer on top of QFA's Rithmic capture + sidecar pipeline.
**Estimated total effort**: 5.5 engineering weeks (1 engineer) for Phases 1–4.
**Prerequisites for engineer**: Python 3.11+, pandas/numpy proficiency, basic understanding of futures market microstructure (trades, depth, MBO/MBP10). Read `docs/architecture.md` AND `docs/jsonl-inspection-report.md` first.

**Source of truth references**:
- Architectural plan: `C:\Users\Neel\.claude\plans\toasty-scribbling-pinwheel.md`
- JSONL data samples: `D:\Quant-futures-app\data\probes\infra01\full\`
- JSONL schema reference (read first!): `D:\Quant-futures-app\tools\rithmic_analytics\docs\jsonl-inspection-report.md`
- Rithmic probe: `D:\Quant-futures-app\scripts\infra\capture-rithmic-probe.py`
- Existing analysis scripts (plaintext output — no JSON IO path): `D:\MNQ-Futures\tools\vp_*.py`

**Important framing correction**: `D:\MNQ-Futures\tools\vp_multi_tf_full.py` and siblings print plaintext tables to stdout. **There is no existing zone JSON schema or render pipeline to "drop into."** Phase 1 ships a *new* canonical zone JSON; Phase 3 (RA-020) is where we add JSON output to Neel's existing scripts so the two systems can interoperate.

---

# Phase 1 — Core VP from Rithmic data

## RA-001 · Repo scaffolding + dependencies + contract metadata
**Priority**: P0 (blocker for everything)
**Estimate**: 4 hours
**Dependencies**: none

**Description**: Create the `tools/rithmic_analytics/` directory tree per the architectural plan. Set up `pyproject.toml`, configure pytest, ruff, mypy. Pin dependencies: pandas≥2.0, numpy≥1.24, pyarrow≥12 (parquet support), plotly≥5.0, matplotlib≥3.7, pytest≥7.

**Also build `core/contracts.py`** — a small module providing per-symbol metadata (tick size, $/tick, contract specs). Initial config covers MNQ (tick=0.25, $0.50/tick, point=$2), NQ (tick=0.25, $5/tick, point=$20), MES, ES. Used throughout features so `bin_size`, ATR calculations etc. are tick-aware not hardcoded.

**Files to create**:
- `tools/rithmic_analytics/pyproject.toml`
- `tools/rithmic_analytics/.gitignore`
- `tools/rithmic_analytics/__init__.py` (and in every subdir per architecture)
- `tools/rithmic_analytics/core/contracts.py`
- `tools/rithmic_analytics/tests/test_contracts.py`
- `tools/rithmic_analytics/docs/README.md` (one-paragraph project summary + setup instructions)

**Acceptance criteria**:
- `pip install -e .` from `tools/rithmic_analytics/` succeeds in a clean venv
- `pytest tools/rithmic_analytics/tests/` runs (even if empty) and exits 0
- `ruff check tools/rithmic_analytics/` passes
- `mypy tools/rithmic_analytics/` passes (strict mode disabled initially)
- `from rithmic_analytics.core.contracts import get_contract; spec = get_contract("MNQ"); assert spec.tick_size == 0.25 and spec.dollars_per_point == 2.0`

---

## RA-002 · OBS-01 JSONL loader (corrected schema)
**Priority**: P0
**Estimate**: 5 hours
**Dependencies**: RA-001

**Description**: Build `core/loader.py` with three loaders. Each must handle the actual on-disk schemas documented in `docs/jsonl-inspection-report.md`.

**OBS-01 trades** — `load_obs01_trades(path: Path) -> pd.DataFrame`. The on-disk envelope nests trade fields inside `payload`:
```json
{"event_id":"...", "run_id":"...", "schema_version":1, "session_id":"mnq-2026-04-27-rth",
 "ts_ns":"1777301422098008205", "type":"TRADE",
 "payload": {"aggressor_side":"sell", "exchange_event_ts_ns":"...",
             "sidecar_recv_ts_ns":"...", "price":27381.25, "quantity":1,
             "trade_id":"6875892387204"}}
```
Loader **must flatten** `payload.*` keys into the returned DataFrame, filter to `type == "TRADE"`, and emit columns: `event_ts_ns` (int64, from `payload.exchange_event_ts_ns`), `recv_ts_ns` (int64, from `payload.sidecar_recv_ts_ns`), `session_id` (str), `price` (float64), `quantity` (int32), `aggressor_side` (categorical), `trade_id` (str), `signed_qty` (int32 = quantity × {+1 if aggressor=buy, −1 if sell, 0 if unknown}).

**MBP1** — `load_mbp1(path)` reads databento-flat schema with columns `ts_event_ns, ts_recv_ns, bid_px_00, bid_sz_00, bid_ct_00, ask_px_00, ask_sz_00, ask_ct_00`.

**MBO** — `load_mbo(path)` reads schema `ts_event_ns, ts_recv_ns, sequence, action ∈ {A,M,C,F,T}, side ∈ {B,A}, price, size, order_id`.

**Files to create**:
- `core/loader.py`
- `tests/test_loader.py`
- `tests/fixtures/` (symlink or `.gitignore` redirect to `D:\Quant-futures-app\data\probes\infra01\full\`)

**Acceptance criteria**:
- Loading test fixture `l1-trade-post04d.obs01.jsonl` (104,694 trade rows) completes in <5 seconds and uses <500MB RAM
- All 104,694 trade rows present after flattening + filtering
- **aggressor_side coverage ≥99%** of rows (per Rithmic spec, every aggressed trade has a side)
- **Signed-qty convention matches Rithmic spec**: buy aggression → positive, sell aggression → negative, unknown → 0
- **Manual spot check at 5 timestamps** against external reference (Bookmap screenshot or Rithmic R|Trader replay) — engineer to capture these during dev
- Returns empty DataFrame (not error) on a 0-byte JSONL
- Returns empty DataFrame with a warning when `type` field absent or unknown — does not crash

---

## RA-003 · Volume Profile compute
**Priority**: P0
**Estimate**: 6 hours
**Dependencies**: RA-002

**Description**: Build `features/volume_profile.py` with `compute_vp(trades: pd.DataFrame, contract: ContractSpec, bin_size_ticks: int = 20, va_pct: float = 0.70, hvn_dedup_ticks: int = 60) -> VolumeProfile`. Bin size is expressed in TICKS (use `core/contracts.py` for tick→price conversion); MNQ defaults to 20 ticks = 5 points.

Returns dataclass with: `vpoc: float`, `vah: float`, `val: float`, `total_volume: int`, `bins: pd.Series`, `hvn_list: list[HVNBin]`, `lvn_list: list[LVNBin]`.

VAH/VAL algorithm: expand outward from VPOC bin until cumulative volume ≥ `va_pct × total`. HVN: top-volume bins, deduplicate within `hvn_dedup_ticks` (keep higher-volume). LVN: lowest-volume bins among bins with any volume.

**Files to create**:
- `features/volume_profile.py`
- `tests/test_volume_profile.py`

**Acceptance criteria**:
- Synthetic data with known VPOC at price X → output VPOC == X (deterministic)
- VAH ≥ VPOC ≥ VAL always
- Sum of volume in [VAL, VAH] inclusive ≥ 70% of total
- HVN dedup: no two HVN entries within `hvn_dedup_ticks` of each other
- Test fixture run: outputs VPOC/VAH/VAL and 6 top HVNs in <2 seconds
- Manual sanity check (non-blocking): VPOC for the test fixture matches Neel's reading from the chart for that window within 1 bin

---

## RA-004 · Zone JSON schema (new design)
**Priority**: P0
**Estimate**: 5 hours
**Dependencies**: RA-003

**Description**: Design and commit the canonical zone JSON schema. **This is a new design, not a port** — Neel's existing `vp_*.py` scripts print plaintext to stdout and have no JSON IO. Build `core/schema.py` defining the format that downstream tooling (RA-020 retrofit of MNQ-Futures scripts, RA-022 HTML report, future chart-rendering MCP payloads) will consume.

Required top-level keys: `schema_version` (start at 1), `symbol`, `timeframe` (e.g., `"rth"`, `"globex"`, or bar size), `bars_used`, `computed_at` (ISO 8601), `data_source` (`"rithmic"` or `"tradingview"`), `vpoc`, `vah`, `val`, `atr_14`, `bin_size_ticks`, `zones` (array), `reference_lines` (array).

Zone object: `{id, top, bot, type ∈ {support, resistance}, conviction ∈ {SUPER, HIGH, MED, LOW}, text, sources: list[str], volume_pct: float, multi_tf_count: int (optional)}`.

Reference line: `{price, text, source: str}`.

Conviction grading rules: SUPER = 4-TF HVN confluence; HIGH = HVN + statistical band (W AVWAP ±σ etc) + structural element (EMA50/100/200 or swing); MED = single HVN OR statistical band alone OR VAH/VAL; LOW = EMA cluster or round number without HVN backing. See handoff doc §3.3 for the source.

**Files to create**:
- `core/schema.py` (the dataclasses + serializer)
- `core/zone_schema.json` (JSON Schema spec for external validators)
- `tests/test_schema.py`

**Acceptance criteria**:
- All output JSON validates against `zone_schema.json` (use `jsonschema` lib in tests)
- Round-trip: dataclass → JSON → dataclass produces identical structure
- Conviction grader is deterministic given the same input rule set
- Schema versioning works: adding a new field with default doesn't break v1 parser

---

## RA-005 · ATR(14) from tick data
**Priority**: P1
**Estimate**: 3 hours
**Dependencies**: RA-002

**Description**: Build `features/atr.py` with `compute_atr_from_ticks(trades: pd.DataFrame, period: int = 14, bar_size_ns: int = 5 * 60 * 10**9) -> float`. Resamples tick data into bar_size buckets using `event_ts_ns`, computes Wilder ATR.

**Files to create**:
- `features/atr.py`
- `tests/test_atr.py`

**Acceptance criteria**:
- **Synthetic OHLC unit test (primary)**: feed a known OHLC sequence where Wilder ATR can be computed by hand or against a known-good library (e.g., `pandas_ta.atr`). Assert output matches to 4 decimal places.
- Returns NaN if fewer than `period` bars available — no division-by-zero
- Supports 1m / 5m / 15m / 1h bar resampling via `bar_size_ns` parameter
- Performance: <500ms on 104K trades
- **Soft sanity check (non-blocking, document only)**: ATR magnitude is "plausible" vs TV's chart for the same window. TV's exact value will not match due to RTH-only filtering, bar alignment, and timezone offsets — this is expected, not a bug.

---

## RA-006 · CLI: compute_vp.py
**Priority**: P0
**Estimate**: 3 hours
**Dependencies**: RA-002, RA-003, RA-004, RA-005

**Description**: Build `cli/compute_vp.py` — one-shot CLI: `python -m rithmic_analytics.cli.compute_vp --input <obs01.jsonl> [--output zones.json] [--symbol MNQ] [--bin-size-ticks 20] [--va-pct 0.70]`. Reads JSONL, computes VP + ATR, emits zone JSON. Defaults to stdout if `--output` omitted.

**Files to create**:
- `cli/compute_vp.py`
- `tests/test_cli_compute_vp.py`

**Acceptance criteria**:
- `python -m rithmic_analytics.cli.compute_vp --input data/probes/infra01/full/l1-trade-post04d.obs01.jsonl --output /tmp/zones.json --symbol MNQ` succeeds, exit code 0
- Resulting `/tmp/zones.json` validates against `zone_schema.json`
- `--help` documents all flags including `--symbol`
- Exit codes: 0 on success, 1 on bad input file, 2 on schema validation failure

**Phase 1 milestone (revised)**: At completion, the engineer can produce a canonical zone JSON from any Rithmic OBS-01 capture. This JSON is the contract that all downstream tooling builds against. Integration with Neel's existing `vp_*.py` scripts is a Phase 3 retrofit (RA-020), not a Phase 1 deliverable.

---

# Phase 2 — Continuous capture + automation

## RA-007 · Probe wrapper CLI with rollover-aware symbol resolution
**Priority**: P0
**Estimate**: 8 hours
**Dependencies**: RA-001

**Description**: Build `cli/start_capture.py` — wrapper around `scripts/infra/capture-rithmic-probe.py`. Handles: (a) reading credentials from env vars or `~/.rithmic_creds.toml`, (b) computing session-aware output paths (`data/captures/YYYY-MM-DD/<symbol>_<session>.jsonl`), (c) running probe for a specified session window, (d) catching probe failures and emitting structured error logs.

**Symbol resolution**: do NOT hardcode `MNQM6`. Build `ops/rollover_calendar.py` with the CME futures rollover schedule. CLI takes `--root-symbol MNQ` (NOT `--symbol MNQM6`) and resolves to the active front-month contract at runtime based on today's date and the rollover calendar. Rollover rule for E-mini Nasdaq: roll on the Thursday before expiration (8 calendar days before the third Friday). Document the heuristic; allow `--contract-override MNQU6` for manual control.

**CLI**: `python -m rithmic_analytics.cli.start_capture --root-symbol MNQ --session rth --streams L1_QUOTE,LAST_TRADE,MBP1,MBO`

**Files to create**:
- `cli/start_capture.py`
- `ops/credentials.py`
- `ops/rollover_calendar.py`
- `tests/test_start_capture.py` (mocks subprocess call)
- `tests/test_rollover_calendar.py`

**Acceptance criteria**:
- `--dry-run` prints the probe invocation, does not launch
- Real run launches probe as subprocess, captures stdout/stderr to log
- On SIGTERM, probe gets graceful-shutdown signal
- Session window defaults: RTH = 09:25–16:05 ET; Globex = 17:55 prior day → 09:30 ET
- Rollover calendar test cases: in May 2026 with date 2026-05-15, `MNQ` resolves to `MNQM6`. After 2026-06-12 (Thursday before 2026-06-19 expiry), resolves to `MNQU6` (Sept 2026)
- Calendar covers MNQ rolls through end of 2027
- Output path includes session_id stamp matching sidecar conventions

---

## RA-008 · File rotation + retention
**Priority**: P1
**Estimate**: 4 hours
**Dependencies**: RA-007

**Description**: Build `ops/rotation.py` — runs nightly. For each completed session in `data/captures/`: gzip-compress raw JSONL, move to archive subdirectory, delete files older than retention policy.

Reuse `services/market_data_sidecar/retention.py::L1TradeRetentionPolicy` defaults (keep_raw=2 sessions, compressed_hot=14 days).

**Files to create**:
- `ops/rotation.py`
- `tests/test_rotation.py`

**Acceptance criteria**:
- Sessions older than 2 days get compressed (`.gz` suffix)
- Compressed files older than 14 days get deleted
- Idempotent: running twice in same day causes no side effects

---

## RA-009 · Gap detection alerter (NDJSON output)
**Priority**: P1
**Estimate**: 5 hours
**Dependencies**: RA-008

**Description**: Build `ops/alerts.py`. After each capture completes, scan JSONL for sequence gaps and time gaps using `services/market_data_sidecar/gap_detection.py::L1TradeGapReport`. If a gap exceeds threshold (1s for L1, 60s for trades), **append a structured JSON line** to `data/alerts/alerts.ndjson` (single file, append-mode) and optionally send a notification.

NDJSON format: `{ts_iso, session_id, stream, gap_type, gap_value_ns, threshold_ns, severity ∈ {WARN, FAIL}}`. This format lets RA-012 dashboard query alerts trivially.

**Files to create**:
- `ops/alerts.py`
- `tests/test_alerts.py`

**Acceptance criteria**:
- Synthetic 2-second L1 gap → one new line in `alerts.ndjson` with `gap_type="time"`, `severity="WARN"`
- No gaps → file unchanged
- Threshold configurable per stream via config file
- Webhook delivery (Pushover/Discord) opt-in via config, off by default

---

## RA-010 · Daily zones orchestrator
**Priority**: P0
**Estimate**: 5 hours
**Dependencies**: RA-006, RA-007, RA-008

**Description**: Build `cli/daily_zones.py` — runs nightly after capture rotation. For the most recent fully-captured session: load OBS-01, compute VP + ATR, emit `data/zones/YYYY-MM-DD_<symbol>_rth.json` and `_globex.json`.

**Optional drop-to flag** writes a copy to a path Neel's existing scripts will read once RA-020 lands. Without RA-020 the JSON is read-only by `rithmic_analytics` itself — *no automatic integration with `vp_*.py` exists yet*.

**Files to create**:
- `cli/daily_zones.py`
- `tests/test_daily_zones.py`

**Acceptance criteria**:
- Running against existing test fixture produces a valid zone JSON
- `--drop-to <path>` flag copies output to specified location
- Handles missing sessions gracefully (logs warning, exits 0)
- Logs to `logs/daily_zones_YYYY-MM-DD.log`

---

## RA-011 · Windows Task Scheduler setup script
**Priority**: P1
**Estimate**: 3 hours
**Dependencies**: RA-007, RA-010

**Description**: PowerShell script that registers Windows Task Scheduler jobs (RTH capture, Globex capture, daily zones, rotation).

**Files to create**:
- `ops/install_scheduled_tasks.ps1`
- `ops/uninstall_scheduled_tasks.ps1`
- `docs/task_scheduler_setup.md`

**Acceptance criteria**: as previously stated.

---

## RA-012 · Capture quality monitoring dashboard
**Priority**: P2
**Estimate**: 6 hours
**Dependencies**: RA-009

**Description**: HTML dashboard summarizing last 30 days of captures, reading from `alerts.ndjson` and the captures dir directly. Output: `docs/capture_dashboard.html` regenerated nightly.

**Files to create**: `viewer/capture_dashboard.py`, `tests/test_capture_dashboard.py`.

**Phase 2 milestone**: continuous nightly captures, rotated and gap-checked. Daily zones JSON regenerates each evening for the previous session.

---

# Phase 3 — Orderflow features

## RA-013 · True CVD
**Priority**: P0
**Estimate**: 4 hours
**Dependencies**: RA-002

**Description**: Build `features/cvd.py` with `compute_cvd(trades: pd.DataFrame) -> pd.DataFrame`. Adds columns: `cvd` (cumulative signed qty), `cvd_rth` (RTH-anchored cumulative), `cvd_minute` (signed qty per 1m bucket). **Bucket using `event_ts_ns` (exchange-time), not `recv_ts_ns`** — this is the canonical timestamp throughout the analytics layer.

Also `detect_divergence(trades, price_window=500, cvd_window=500) -> pd.DataFrame` returning rows where price-percentile-rank diverges from CVD-percentile-rank.

**Files to create**:
- `features/cvd.py`
- `tests/test_cvd.py`

**Acceptance criteria**:
- `cvd[-1] == signed_qty.cumsum().iloc[-1]` (self-consistency)
- **External validation**: at 5 timestamps in the test fixture, compute CVD then compare against a Bookmap screenshot Neel captured at the same time (~±10 tick tolerance — Bookmap is read via screen OCR in his current workflow, hence the loose tolerance)
- Divergence detector flags at least one event in test fixture; Neel will spot-check labels
- Performance: <2 seconds on 104K trades

---

## RA-014 · Footprint chart compute
**Priority**: P1
**Estimate**: 5 hours
**Dependencies**: RA-013

**Description**: Build `features/footprint.py` with `compute_footprint(trades, time_bin: str = "30s", price_bin_ticks: int = 1) -> pd.DataFrame`. Pivot indexed by `event_ts_ns` bucketed into `time_bin`, columns = price levels (in tick increments per contract spec), cells = net delta.

Returns also: `total_volume_per_bin`, `imbalance_per_level`.

**Files to create**:
- `features/footprint.py`
- `tests/test_footprint.py`

**Acceptance criteria**:
- Pivot output correctly shaped
- Sum of cells in a time bin equals net delta from CVD for same bin
- NaN for cells with no trades (not 0)
- Handles 30s, 1m, 5m via parameter; uses `event_ts_ns` for binning

---

## RA-015 · Absorption detection
**Priority**: P0
**Estimate**: 12 hours
**Dependencies**: RA-013, RA-014, RA-002 (MBP1 loader)

**Description**: Build `features/absorption.py`. Algorithm:
1. Bucket trades into time bins (default 5s) by `event_ts_ns`.
2. For each bin: total volume, net delta, price range, MBP1 size at dominant trade price just BEFORE bin.
3. Flag ABSORPTION if: volume ≥ X (threshold scaling with session avg), price range ≤ N ticks (default 4 ticks), AND either (buy volume but no break above pre-bin offer) OR (sell volume but no break below pre-bin bid).

Returns DataFrame: `start_ts, end_ts, price_center, volume, net_delta, range_ticks, side ∈ {buy_absorbed, sell_absorbed}, score ∈ [0,1]`.

**Files to create**:
- `features/absorption.py`
- `tests/test_absorption.py`
- `tests/fixtures/synthetic_absorption.jsonl` (engineer builds this; canonical absorption pattern injected into a small synthetic OBS-01)
- `docs/absorption_methodology.md`

**Acceptance criteria**:
- **Primary (deterministic)**: against `tests/fixtures/synthetic_absorption.jsonl` (engineer constructs: a 30-second window with 500 contracts traded at the offer + price range of 2 ticks), the detector flags exactly 1 absorption event with `side="buy_absorbed"` and `score > 0.7`
- Score correlates with confidence: synthetic edge cases at scores 0.5 / 0.6 / 0.8 / 0.95 produce expected ordering
- Performance: <10 seconds on a full RTH session
- **Real-fixture validation (deferred)**: Once Neel has at least one nightly capture containing a confirmed absorption event (he'll annotate the timestamp in `docs/known_absorption_cases.md`), engineer adds it as a second fixture. This is a follow-up, not a Phase 3 gate.
- Documented: when absorption fires, suggested zone-conviction adjustments are computable (helper function `suggest_conviction_upgrade(absorption_event, existing_zones)`)

---

## RA-016 · Sweep detection
**Priority**: P2
**Estimate**: 6 hours
**Dependencies**: RA-002

**Description**: Build `features/sweep.py`. Sweep = multiple price levels traded through in short window with no resting size left. Use MBO `action=T` bursts joined with MBP1.

**Files to create**: `features/sweep.py`, `tests/test_sweep.py`.

**Acceptance criteria**: 
- Synthetic sweep fixture flagged correctly (engineer constructs: 5 price levels each with 10-contract resting size, then a 50-contract aggressive order — should fire as a sweep)
- False-positive rate <10% on the real test fixture

---

## RA-017 · Hidden liquidity inference
**Priority**: P2
**Estimate**: 8 hours
**Dependencies**: RA-002 (LAST_TRADE + MBP10 — *requires MBP10 capture, not in lean stack*)

**Description**: For each trade, compare traded qty at price P against visible MBP10 size at P just before trade. If traded > visible → hidden liquidity. **Document the storage cost trade-off**: enabling MBP10 capture adds ~25 GB/RTH session over lean stack. Provide a config flag `enable_mbp10_capture: bool` so this is opt-in.

**Files to create**: `features/hidden_liquidity.py`, `tests/test_hidden_liquidity.py`.

---

## RA-018 · CVD viewer (HTML)
**Priority**: P1
**Estimate**: 4 hours
**Dependencies**: RA-013

**Description**: Plotly-based HTML chart: CVD line + price overlay + divergence markers.

**Files to create**: `viewer/cvd_plot.py`, `tests/test_cvd_plot.py`.

**Acceptance criteria**: as previously specified.

---

## RA-019 · Footprint viewer (HTML)
**Priority**: P1
**Estimate**: 8 hours
**Dependencies**: RA-014

**Description**: Heatmap-style HTML footprint viewer with zoom/pan.

**Files to create**: `viewer/footprint_html.py`, `tests/test_footprint_html.py`.

---

## RA-020 · Retrofit JSON output to Neel's existing scripts (NEW scope)
**Priority**: P0
**Estimate**: 10 hours
**Dependencies**: RA-010, RA-013, RA-015

**Description**: Neel's existing `D:\MNQ-Futures\tools\vp_multi_tf_full.py`, `vp_htf_globex_prep.py`, and `vp_15m_compute.py` currently emit plaintext tables to stdout. They have no JSON output path.

This ticket **adds JSON output to those scripts** so they emit zone JSON in the same canonical schema (`core/zone_schema.json`) that Phase 1 introduced. Also adds an optional `--source rithmic` mode that reads from `rithmic_analytics.cli.compute_vp` output instead of TradingView MCP.

Backward compat: existing plaintext output remains the default. New `--emit-json <path>` and `--source` flags are additive.

**Files to modify**:
- `D:\MNQ-Futures\tools\vp_multi_tf_full.py`
- `D:\MNQ-Futures\tools\vp_htf_globex_prep.py`
- `D:\MNQ-Futures\tools\vp_15m_compute.py`

**Acceptance criteria**:
- `python vp_multi_tf_full.py --emit-json zones.json` produces a file validating against `zone_schema.json`
- `python vp_multi_tf_full.py --source rithmic --rithmic-jsonl <path>` reads from Rithmic JSONL and produces zones within ±5 tick of the TradingView-sourced version for the same window
- Existing plaintext output unchanged when no new flags passed
- Diffing TV-sourced JSON vs Rithmic-sourced JSON is human-readable (sorted keys, indented)

**Phase 3 milestone**: Neel now has a unified canonical zone JSON across both data sources. Bookmap-equivalent signals (CVD, footprint, absorption) computed and viewable.

---

# Phase 4 — Multi-session + viewer polish

## RA-021 · Multi-session VP aggregator
**Priority**: P1
**Estimate**: 6 hours
**Dependencies**: RA-003, RA-010

**Description**: `features/multi_session.py`. Aggregates VPs across N most recent sessions. HVN clusters persisting across days flagged "STRUCTURAL".

**Files to create**: `features/multi_session.py`, `tests/test_multi_session.py`.

---

## RA-022 · Daily HTML report
**Priority**: P1
**Estimate**: 8 hours
**Dependencies**: RA-018, RA-019, RA-021

**Description**: Self-contained HTML combining VP + CVD + footprint + absorption events + gap report + multi-session HVN.

**Files to create**: `viewer/vp_report.py`, `viewer/templates/daily_report.html.j2`, `tests/test_daily_report.py`.

---

## RA-023 · Interactive notebook viewer
**Priority**: P2
**Estimate**: 6 hours
**Dependencies**: All above features

**Description**: Jupyter notebook with ipywidgets filters for time/price/event review.

**Files to create**: `viewer/notebooks/trade_review.ipynb`, `viewer/notebooks/README.md`.

---

## RA-024 · Documentation pass + handoff
**Priority**: P0
**Estimate**: 12 hours
**Dependencies**: All above

**Description**: Final documentation pass. Realistic estimate: 12h, not 8h — five docs × ~1.5h each + docstring sweep across ~40 public functions × ~5 min each = ~3h.

**Files**: all `docs/*.md` files; every module's public API gets a docstring with type hints, example, known limitations.

---

# NEW: Contract rollover playbook (cross-cutting)

## RA-025 · Pre-go-live rollover playbook
**Priority**: P1
**Estimate**: 4 hours
**Dependencies**: RA-007, RA-008

**Description**: Document the manual playbook for handling a quarterly contract rollover before continuous capture goes live. Even though RA-007's calendar handles automatic resolution, Neel needs to know:
- When the next roll happens (next is **2026-06-12 → MNQU6** based on Thursday-before-expiration rule)
- What changes in his existing chart-drawing tools that reference `MNQ1!` (TradingView's continuous contract)
- How session_id naming handles the rollover crossover
- Whether to keep the old contract's archived JSONL files (yes, for historical replay)
- The CME calendar reference and where to update `rollover_calendar.py` for future rolls

**Files to create**: `docs/rollover_playbook.md`.

---

# Sprint 7 — Quick wins + decision-time signal conditioning

> **Status (2026-05-20):** RA-037, RA-039, RA-038 all shipped in build order.
> Full suite 866 passed / 2 long-standing skips; ruff + mypy clean.
> See architecture.md D-010 for the RA-039 adaptive-bins decision record.

## RA-037 · Bid/ask spread series extraction (MBP1 derived columns) — SHIPPED 2026-05-20
**Priority**: P1
**Estimate**: 2 hours
**Dependencies**: RA-002 (MBP1 loader), RA-030 (live MBP1 sibling production)

**Description**: Extend the existing MBP1 loader to produce derived spread columns inline. Per MBP1 record, compute `spread_ticks = (ask_px_00 - bid_px_00) / tick_size` and `spread_bps = (ask_px_00 - bid_px_00) / mid_price × 10000`. Expose as columns on the DataFrame returned by `load_mbp1()`. Add a session-level summary helper: `summarize_spread(mbp1_df) -> SpreadSummary` returning `{mean_ticks, p50_ticks, p95_ticks, p99_ticks, max_ticks, mean_bps, time_above_1tick_pct, time_above_2tick_pct}`. Tier 2.5 (slippage-vs-zone-distance regression) consumes these directly when it ships; in the meantime, the summary lets us diagnose MBP1 anomalies (e.g., today's 64K-record sparsity).

**Why now**: smallest possible "flip from deferred" — pre-stages Tier 2.5, gives us a diagnostic for the MBP1 ratio tracking issue, and the data path is already there (just extraction). No new file capture cost. The agent's research report ranked this as "add when Tier 2.5 ships" but I'm flipping it earlier because (a) cost is trivial and (b) MBP1 anomaly tracking is an active operational concern.

**Files to create/modify**:
- `rithmic_analytics/core/loader.py::load_mbp1` — add `spread_ticks` and `spread_bps` as computed columns. Use `np.where` for the bps calculation to avoid divide-by-zero on bid==ask==0 cases (one-sided pre-open prints).
- `rithmic_analytics/core/loader.py::summarize_spread` — new module-level function returning `SpreadSummary` frozen dataclass.
- `rithmic_analytics/core/loader.py::SpreadSummary` — frozen dataclass with the 8 fields above + `n_records: int`.
- `rithmic_analytics/cli/daily_zones.py` — log the spread summary line at the end of every run (cheap diagnostic). NOT a new artifact JSON — just an INFO log entry: `"MBP1 spread: mean=1.2t p95=2.0t time>2t=12%"`.
- `tests/test_loader.py` — add cases: (1) zero-spread synthetic (locked market) → 0.0 ticks, (2) 1-tick synthetic → 1.0, (3) crossed-book synthetic (ask < bid) → negative spread tolerated but flagged via `n_crossed_quotes` field, (4) one-sided record (bid=0 or ask=0) → spread fields are `NaN`, (5) summary aggregation on a 100K-row synthetic with controlled spread mix.
- `docs/feature_reference.md` — extend `core.loader` section with the new columns + SpreadSummary.

**Critical design decisions**:

1. **Handle one-sided quotes**: when `bid_px == 0` or `ask_px == 0`, the spread is undefined. Recommend `NaN` (not 0, not `-1`) — pandas handles `NaN` gracefully in downstream consumers. Filter from summary aggregations.

2. **Crossed book**: rare but real (e.g., during fast moves, recorded ask can lag bid by one update). Record as a flag column `is_crossed: bool` and a counter in SpreadSummary. Do NOT abs() the spread — let consumers see the actual sign.

3. **No new artifact JSON**: this is loader-level infrastructure, not a per-session emitted artifact. The diagnostic INFO log in daily_zones is enough. Tier 2.5 will produce its own artifact when it ships.

**Acceptance criteria**:
- `load_mbp1()` returns DataFrame with new `spread_ticks`, `spread_bps`, `is_crossed` columns.
- `summarize_spread()` produces meaningful stats on the 50,681-record MBP1 from tonight's Globex; mean/p50 should be in the 1-2 tick range for normal market hours.
- daily_zones INFO log includes the spread summary line.
- All existing loader tests still pass.

**Out of scope**:
- Spread-based filtering of MBP1 (deferred until consumer needs it).
- Visualizing spread distribution (Plotly chart) — defer to Tier 2.5 ticket.

---

## RA-038 · Conviction-conditioned zone probability card (Tier 1.1 from research report) — SHIPPED 2026-05-20
**Priority**: P1
**Estimate**: 3 hours
**Dependencies**: RA-027 (HistoryReport with Wilson CIs already shipped)

**Description**: The agent's research report identified this as the **#1 highest-leverage method** because the Wilson CI math is already shipped in `features/zone_quality.py::wilson_ci`, and the `HistoryReport.hit_rate_by_conviction` is being emitted nightly — but nothing in the morning workflow reads it back. This ticket closes that loop.

Build a morning artifact that annotates each live zone with `P(hold | conviction tier, role)` and a Wilson 95% CI, recomputed from the trailing-30 `HistoryReport`. Output a markdown card readable in 30 seconds + a JSON sidecar for any downstream consumer.

**Why this is the right next**: turns the abstract SUPER/HIGH/MED/LOW conviction labels into literal numbers ("MED at lower CI bound is 53.5%, expected R-multiple on a 2:1 target = -0.07R → skip"). Directly drives Rule-3 sizing. Ships in one afternoon. Improves every entry from the next session onward, no data-accumulation wait.

**Files to create**:
- `rithmic_analytics/features/zone_probability.py` — `annotate_zones_with_probability(envelope: ZoneEnvelope, history: HistoryReport) -> AnnotatedZoneEnvelope`. Frozen dataclass `AnnotatedZoneEnvelope(envelope: ZoneEnvelope, annotations: list[ZoneProbabilityAnnotation])`. `ZoneProbabilityAnnotation(zone_id, conviction_tier, functional_role, p_hold, ci_low, ci_high, n_trials, insufficient_data: bool)`. The `insufficient_data` flag fires when `n_trials < 5` (matching RA-027's Wilson floor).
- `rithmic_analytics/viewer/probability_card.py` — `render_probability_card(annotated: AnnotatedZoneEnvelope) -> str` (markdown). One row per zone with conviction tier, P(hold), CI, n, expected-R-at-2:1 (helper inline), and a final "skip if expected R < threshold" flag for clarity.
- `rithmic_analytics/cli/daily_zones.py` — add `--emit-probability-card` flag (default OFF, mirrors RA-030.1's pattern). When ON: reads the trailing-30 HistoryReport from `data/reports/history_30session.json`, annotates today's zones, writes both `data/probability_cards/YYYY-MM-DD_MNQ_<session>.md` (markdown card for human reading) and `data/probability_cards/YYYY-MM-DD_MNQ_<session>.json` (machine-readable for confluence scorer or future RA-028 attribution work).
- `tests/test_zone_probability.py` — annotate zones against a synthetic HistoryReport with known per-tier rates, verify CIs match `wilson_ci()` output, verify `insufficient_data` flag fires correctly, verify markdown card renders with no errors on empty-history case.
- `docs/feature_reference.md` — new `features.zone_probability` section.
- `docs/operations.md` — daily routine update: where the probability card fits.

**Critical design decisions**:

1. **History-not-found gracefully degrades to "bootstrap mode"**: if `data/reports/history_30session.json` doesn't exist yet (first 30 sessions of operation), the card renders with all zones flagged `insufficient_data=True` and `p_hold=None`. Don't crash, don't synthesize fake numbers. Document this in the markdown card header.

2. **Markdown card format must be 30-second-readable**: prioritize "which zones do I size up / skip?" not exhaustive stats. Recommend:
   ```
   # Zone Probability Card — 2026-05-21 MNQ rth
   
   Based on trailing-30 history (sessions 2026-04-22 → 2026-05-20, n=N).
   
   | Zone | Conviction | Role | P(hold) | 95% CI | n | Expected R | Action |
   |---|---|---|---|---|---|---|---|
   | hvn-29310 | SUPER | support | 0.68 | [0.54, 0.80] | 47 | +0.61R | **Trade full size** |
   | hvn-29250 | MED | support | 0.54 | [0.41, 0.66] | 38 | -0.07R | **Skip — below threshold** |
   ...
   ```

3. **Expected-R calculation**: assume 2:1 R target unless config says otherwise. Expected R = `p_hold × 2 - (1 - p_hold) × 1`. Highlight zones with expected_r > 0.3 as "trade full size", 0.1-0.3 as "trade half size", < 0.1 as "skip".

4. **Functional role determines which history bucket**: per RA-027 design, `functional_role` (derived, not declared) is what was scored. Match annotation to the same role.

**Acceptance criteria**:
- Run against any envelope + matching trailing-30 HistoryReport → produces annotated envelope + markdown card + JSON sidecar.
- Markdown card readable in <30 seconds, structurally identical for SUPER/HIGH/MED/LOW tiers (with empty rows when no zones of that tier exist).
- `insufficient_data=True` zones never report a P(hold) number (None, displayed as "—").
- daily_zones integration mirrors RA-030.1's defensive try/except — failure NEVER gates zones JSON.
- Full test suite green (821+ tests); ruff + mypy clean.

**Out of scope**:
- Multi-conviction-tier joint probability (P(SUPER hold AND HIGH hold)) — defer to RA-028.
- Calibration plot (predicted vs realized) — defer to Tier 3 methods.
- Auto-sizing recommendations beyond the markdown card's "trade full/half/skip" tag — discretionary trader keeps the decision; we annotate, don't decide.

---

## RA-039 · Adaptive `bin_size_ticks` per ATR regime (audit B1) — SHIPPED 2026-05-20
**Priority**: P2
**Estimate**: 2 hours
**Dependencies**: RA-003 (VP compute, already shipped), RA-005 (ATR(14), already shipped)

**Description**: Today's `compute_volume_profile` uses fixed `bin_size_ticks=20` (5pt for MNQ). On a 25-pt-ATR day this collapses 5 distinct HVN levels into 1 mega-HVN; on a 12-pt-ATR day VAH/VAL shrink to noise. Auto-scale bin size against session ATR with a hard floor/ceiling. The audit identified this as a "quality win that improves every downstream zone-based feature."

**Why now**: trivial cost (2h), no data dependencies, immediate quality improvement to RA-027 hit-rate signal that RA-038 will consume + RA-028 will cross-reference. Fast follower to the probability card.

**Formula**: `bin_size_ticks = max(4, min(40, round(atr_14 / 4 / tick_size)))`. The 4-tick floor matches RA-035's price-bin width for join compatibility; the 40-tick ceiling prevents pathological collapse on extreme-volatility days.

**Files to modify**:
- `rithmic_analytics/features/volume_profile.py::compute_volume_profile` — add `bin_size_mode: Literal["fixed", "adaptive"] = "fixed"` kwarg (default `"fixed"` preserves existing behavior). When `"adaptive"`, override the `bin_size_ticks` parameter with the computed value. Surface the effective bin size in the output `VolumeProfile` dataclass via new field `effective_bin_size_ticks: int` + `bin_size_mode: str`.
- `rithmic_analytics/cli/compute_vp.py` — add `--bin-size-mode {fixed,adaptive}` flag. Default `fixed` for backward compatibility.
- `rithmic_analytics/cli/daily_zones.py` — wire `--adaptive-bins` flag → passes `bin_size_mode="adaptive"` to VP compute. Default OFF; flip ON in production once smoke-tested.
- `tests/test_volume_profile.py` — three new cases: (1) low-ATR (ATR=12) → bin_size_ticks=4 (floor), (2) typical-ATR (ATR=29 like today's RTH) → bin_size_ticks=7, (3) extreme-ATR (ATR=80) → bin_size_ticks=20, (4) backward-compat: `bin_size_mode="fixed"` matches existing behavior exactly.
- `docs/feature_reference.md` — extend `features.volume_profile` section with the new mode + formula.
- `docs/architecture.md` — add **D-010** entry: adaptive binning rationale (sub-VP granularity for low-vol days, anti-collapse ceiling for high-vol).

**Critical design decisions**:

1. **Formula tuning conservatism**: the `atr_14 / 4 / tick_size` formula divides ATR by 4 to get the "natural" bin width that puts ~4-6 bins inside the value area on a typical day. Verifiable post-ship by running against the validated 2026-04-27 fixture (ATR ≈ 29) and confirming HVN clusters look qualitatively similar to the fixed-20-tick output.

2. **Backward compatibility is absolute**: existing zone JSONs and consumers must not break. The `bin_size_mode="fixed"` default + the test asserting byte-exact match preserves the contract.

3. **Output schema**: `effective_bin_size_ticks` and `bin_size_mode` are new optional fields on VolumeProfile output JSON. Existing consumers that didn't expect them ignore them; new consumers can read them for diagnostic clarity.

**Acceptance criteria**:
- `compute_vp --bin-size-mode adaptive` against today's RTH OBS-01 produces a zone JSON with effective_bin_size_ticks reflecting today's ATR (29 → ~7 ticks).
- Against the validated 4.1 GB OBS-01 fixture (ATR ≈ 29), HVN clusters look qualitatively similar — same 5-6 top HVNs by volume_pct, possibly with finer granularity inside each cluster.
- All 4 unit test cases pass.
- Full test suite green; ruff + mypy clean.

**Out of scope**:
- Per-tick-bucket optimization (some HFT desks use sub-tick bins) — not relevant for MNQ futures (tick size 0.25 already fine).
- Time-of-day adaptive binning (different bins for opening vs midday) — defer; ATR conditioning is the right first cut.

---

## RA-048 · Tail-span correctness audit across RA-046 signal modules
**Priority**: P2
**Estimate**: 2-3 hours
**Dependencies**: RA-046, RA-047

**Description**: Audit every RA-046 live-signal multiplier that presents a
"session" or 60-minute interpretation while reading from a bounded raw-capture
tail. RA-047 explicitly degrades delta-dislocation confidence when the tail spans
less than the required 60-minute window; this ticket applies the same discipline
to the rest of the live signal stack.

**Why now**: RA-047 surfaced that `DEFAULT_TAIL_BYTES = 750_000` may cover less
than a full 60 minutes during high-velocity RTH or active Globex periods. Existing
RA-046 CVD multipliers (`cvd_direction_match`, `cvd_direction_oppose`,
`cvd_momentum_flip`) can therefore fire on partial-window data while their labels
read as session/60-minute context. That is an input-quality issue, not a detector
bug, and should be handled visibly.

**Scope**:
- Add a tail-coverage measurement to `LiveSignals` (span minutes, first/last
  timestamp, coverage state).
- Audit `live_signals.py` CVD, VWAP, velocity, sweep, and absorption-proxy logic
  for implicit minimum-window assumptions.
- Decide per signal whether to increase `DEFAULT_TAIL_BYTES`, degrade the
  multiplier, rename the displayed label, or add a warning.
- Update scenario tooltips so any degraded live-signal multiplier explains the
  tail span behind it.
- Add tests for short-tail behavior and full-window behavior.

**Acceptance criteria**:
- Dashboard clearly indicates when live CVD/session labels are computed from
  less than the intended window.
- Probability multipliers that rely on incomplete windows are either degraded or
  renamed to avoid implying full-session evidence.
- No raw full-file scans are introduced; per-run I/O remains within the
  dashboard budget.
- Tests cover high-tail-span and low-tail-span paths; ruff and mypy clean.

**Out of scope**:
- Rebuilding RA-046 detectors from post-session normalized siblings.
- Replacing heuristic multipliers with Wilson-CI calibrated values (future
  RA-050-style calibration pass).

---

## RA-050 · Dashboard prominence upgrade for sweep + absorption signals
**Priority**: P1
**Estimate**: 3-4 hours
**Dependencies**: RA-045 (dashboard hardening shipped), RA-046 (live signals + audit trail shipped)

**Description**: RA-046 added sweep + absorption detectors and surfaces them in the Orderflow Pulse subsection + audit trail. In practice, these signals get buried — a trader scanning the dashboard quickly may miss a recent sweep cluster at their target zone. This ticket makes sweeps and absorption **explicit, top-of-mind signals** with visual prominence, cross-references to scenarios, and time-decay highlighting.

**Project**: `tools/rithmic_dashboard/` (extend existing renderer).

### Phase 1: New top-of-dashboard "Recent Signals" panel

Add a dedicated panel positioned BETWEEN the Active Posture sentence and the Distance Grid. Always-visible header with:

- **Recent significant signals (last 30 min)**: count of sweeps + absorption events + dislocations
- Color-coded urgency:
  - 🔴 RED chip — high-intensity (sweep intensity = 5.00 OR absorption confidence = high OR dislocation fired)
  - 🟡 AMBER chip — medium (sweep intensity 3-5 OR absorption confidence medium)
  - ⚪ GRAY chip — low/noise

Per-signal row format:
```
[ICON] HH:MM PT | SWEEP DOWN at VAH 29,885 (intensity 5.00) | affects: Scenario B2 (short)
[ICON] HH:MM PT | BUY_ABSORBED at 30,000.50 score 0.62 | affects: Scenario A (long)
[ICON] HH:MM PT | DELTA DISLOCATION LONG at W-1σ demand | affects: Scenario A, S2
```

Sort newest-first. Cap at last 10 events to avoid overflow.

### Phase 2: Cross-reference to scenarios

For each event, compute "affects" by:
1. Look up which scenario zones the event price falls within (using zone bounds from current state)
2. Match scenario bias direction with signal direction (UP sweep favors long scenarios)
3. Output the list as chips: "affects: Scenario A (long), Scenario E (long)"

This makes the trader's mental connection explicit: "the sweep at 29,885 is RELEVANT to my B2 short setup at the W+1σ supply zone."

### Phase 3: Time-decay highlighting

- Events < 5 min old: **highlighted background** (e.g., glow effect)
- Events 5-15 min old: normal
- Events 15-30 min old: faded (40% opacity)
- Events > 30 min: not shown (rolled off)

This makes "fresh signals" pop visually.

### Phase 4: Zone-level signal badges

In the Distance Grid section, each zone row gets a small badge column:
- 🔵 — sweep fired at this level in last 30 min
- 🟠 — absorption proxy event fired
- 🔴 — delta dislocation fired
- 💎 — multi-signal stack (≥2 distinct signal types in last 30 min)

Badge tooltip shows "Last sweep: 14:23 PT (DOWN, intensity 5.00)".

This connects the signals to the levels they reference, in-line with the level itself.

### Phase 5: Sticky alert for multi-signal stacks

When ≥2 distinct signal types fire at the SAME zone within 30 minutes (e.g., sweep + absorption at the W+2σ short zone), emit a **sticky banner** at top of dashboard:

```
⚠️ MULTI-SIGNAL STACK at W+2σ 30,112-30,128
   • DOWN sweep at VAH (14:18 PT, intensity 5.00)
   • SELL_ABSORBED at 30,118.75 (14:21 PT, score 0.58)
   → Highest-conviction reaction zone right now
```

Banner persists until either: 30 min elapse OR price moves > 30pt away from the zone.

### Files to modify

- `rithmic_dashboard/features/orderflow_pulse.py` — extend with signal-aggregation helper
- `rithmic_dashboard/features/recent_signals_panel.py` — NEW module (~150 LOC) for top-of-dashboard panel
- `rithmic_dashboard/features/zone_signal_badges.py` — NEW module (~100 LOC) for badge column
- `rithmic_dashboard/features/multi_signal_stack_alert.py` — NEW module (~80 LOC) for sticky banner
- `rithmic_dashboard/templates/dashboard.html.j2` — render new panel + badges + sticky banner
- `rithmic_dashboard/static/dashboard.css` (or inline styles in template) — color/glow/badge styles
- `tests/test_recent_signals_panel.py` — synthetic signal mix + 30-min decay test
- `tests/test_zone_signal_badges.py` — multi-signal stack at same zone test
- `tests/test_multi_signal_stack_alert.py` — banner-trigger-and-decay test
- `docs/operations.md` — how to read the new signals panel

### Acceptance criteria

- Recent Signals panel renders at top of dashboard between Active Posture and Distance Grid
- All signal events from last 30 min appear, sorted newest-first, capped at 10
- Color-coded urgency works (red/amber/gray)
- "affects" cross-reference lists ALL scenarios whose entry zone contains the signal price
- Time-decay highlighting visually distinguishes <5min, 5-15min, 15-30min, >30min
- Zone-level badges appear in Distance Grid for any level with signals in last 30 min
- Multi-signal stack banner fires when ≥2 distinct signal types at same zone in 30-min window
- Multi-signal stack banner correctly decays after 30 min OR when price moves >30pt away
- Tests: ~10 new test cases; ruff + mypy clean
- Visual smoke: dashboard renders correctly when current 5/26 audit data is loaded (50 events on 5/26 should produce filled-out panel)

### Pre-build sweep expectation

1. **Position of Recent Signals panel**: between Active Posture and Distance Grid (recommended) vs at the very top (more prominent but pushes existing content down). Recommend below Active Posture for context continuity.
2. **Time-decay window**: 30 min default vs 60 min (longer = more events visible but stale ones distracting). Recommend 30 min with configurable knob.
3. **Multi-signal stack threshold**: ≥2 distinct signal types (sweep + absorption) at same zone counts as stack. What if 3 sweeps at same zone in 5 min? Recommend: only count when signal types differ; 3 same-type signals = single "intensified" entry, not a multi-stack.
4. **Badge styling in Distance Grid**: small unicode icons (low-effort) vs proper SVG badges (more polished). Recommend unicode for shipped speed.
5. **Cross-reference scope**: scenarios only, or also drawn user-zones? Recommend scenarios only for v1; user-zones would require RA-051 to share zone state cleanly.
6. **Sticky banner placement**: top of dashboard above Active Posture (most prominent) vs floating overlay (more disruptive). Recommend: above Active Posture, full-width, dismissible with X.
7. Anything else surfaced when reading the renderer code.

### Out of scope

- Email/Slack alerts on multi-signal stacks (P3 defer — could be a future RA-052)
- Sound alerts (P3 defer)
- Mobile-responsive layout for new panel (defer)
- New signal types beyond what RA-046/047 already produce (future RA-049/051 will add some)

### Relationship to RA-049, RA-051

RA-049 (trade-size profiling / institutional flow) and RA-051 (day-type classification) will produce NEW signal event types. RA-050's Recent Signals panel + zone badges + multi-stack alerts should accept new event types without re-rendering work — the schema is `(timestamp, event_type, level_id, description, intensity, confidence)` which extends cleanly. If RA-050 ships first, RA-049/051's signals automatically appear in the new panel.

### Dispatch protocol

Per RA-040 through RA-047 discipline:
1. Executor's first response: pre-build sweep (7 points above) + plan paragraph + phase estimates
2. Wait for green-light before writing source files

---

## RA-049 · Trade-size profiling + institutional flow detection
**Priority**: P1
**Estimate**: 4-5 hours
**Dependencies**: RA-046 (live signal infrastructure)

**Description**: Currently absorption events fire when volume × delta meet thresholds, but the underlying TRADE composition is not differentiated. 500 contracts of buy_aggressor volume traded as 100 retail orders (5 lots each) is very different from 500 contracts traded as 5 institutional orders (100 lots each). The latter is smart money showing up; the former is noise.

This ticket adds **trade-size classification** to the obs01 stream and aggregates institutional flow per zone. Output is consumed by the probability adjuster as a new high-conviction multiplier and surfaced in the dashboard via RA-050's signal panel.

**Project**: `tools/rithmic_dashboard/` (consumer of obs01).

### Phase 1: Trade-size classifier

New module `features/trade_size_classifier.py`. For each obs01 trade:

| Size | Class | Why |
|---|---|---|
| 1-9 contracts | `retail` | Discretionary retail / mini-prop traders |
| 10-49 | `mixed` | Could be retail or small institutional |
| 50-99 | `institutional` | Algorithmic execution or mid-size institutional |
| ≥100 | `block` | Almost certainly institutional / iceberg execution |

Thresholds configurable via `config/trade_size_thresholds.json` (recompute every N sessions based on rolling size distribution to adapt to symbol's typical activity).

### Phase 2: Institutional flow aggregator

Per drawn zone, aggregate institutional+block volume over rolling windows:
- Last 15 min
- Last 60 min
- Session

Detect "institutional concentration events":
- ≥3 institutional/block trades at same zone within 15 min
- Net delta of institutional trades > 100 (directional commitment)
- → Emit `InstitutionalConcentrationEvent(timestamp, zone_id, side, count, net_delta, confidence)`

Persist to `data/live_analysis/<date>_<session>_institutional_flow.jsonl`.

### Phase 3: Probability multiplier integration

Extend `probability_adjuster.py` with:

| Multiplier | Trigger | Effect | Rationale |
|---|---|---|---|
| `institutional_flow_match` | ≥3 institutional events at scenario's entry zone in last 60min with matching direction | +20% | Smart-money commitment at level is highest-conviction confluence |
| `institutional_flow_oppose` | Same but OPPOSING scenario direction | -20% | Smart money on the other side reduces edge |
| `block_trade_at_entry` | ≥1 block trade (≥100 contracts) at scenario entry zone in last 30min, matching direction | +15% | Single block = institutional initiation |

Cap composition with existing [0.4, 1.6] cap.

### Phase 4: Threshold auto-calibration

Build a CLI (similar to RA-047's `calibrate_thresholds.py`) that:
- Reads last 20 sessions of obs01
- Computes 25th, 50th, 75th, 95th percentile of trade sizes
- Sets `retail < p50`, `mixed < p75`, `institutional < p95`, `block ≥ p95`
- Writes to `data/live_analysis/trade_size_thresholds.json` (atomic write)
- Recompute on-demand (no scheduler added; runnable weekly externally)

### Phase 5: Renderer + audit trail

**Orderflow Pulse**: new subsection "Institutional flow (last 60min)":
- Total institutional volume
- Net institutional delta
- Count of block trades
- Per-zone breakdown (% concentration)

**Audit trail event types**:
- `institutional_concentration_detected` — at zone X, count N, net delta D
- `block_trade_at_zone` — at zone X, size S, direction

**Active Posture**: append sentence when relevant: "Institutional buying concentrated at W-1σ demand (12 trades, +452 delta) — long scenarios up-weighted +20%."

**RA-050 integration**: institutional_concentration events appear in Recent Signals panel + as 💎 multi-signal stack contributors.

### Files to create/modify

- `rithmic_dashboard/features/trade_size_classifier.py` — new (~180 LOC)
- `rithmic_dashboard/features/institutional_flow.py` — new (~200 LOC)
- `rithmic_dashboard/features/probability_adjuster.py` — extend with 3 new multipliers
- `rithmic_dashboard/features/orderflow_pulse.py` — add institutional flow subsection
- `rithmic_dashboard/features/posture_synthesis.py` — incorporate institutional events
- `rithmic_dashboard/features/audit_trail.py` — new event types
- `rithmic_dashboard/cli/calibrate_trade_size_thresholds.py` — new CLI
- `rithmic_dashboard/cli/generate.py` — wire detector into main flow
- `rithmic_dashboard/templates/dashboard.html.j2` — render institutional subsection
- `tests/test_trade_size_classifier.py` — classification + threshold edge cases
- `tests/test_institutional_flow.py` — concentration detection + zone matching
- `tests/test_threshold_calibration_v2.py` — verify rolling percentile computation
- `docs/feature_reference.md` — add trade-size + institutional-flow sections
- `docs/operations.md` — interpretation + calibration cadence

### Acceptance criteria

- Trade-size classifier correctly assigns class on synthetic test trades at threshold boundaries (1, 9, 10, 49, 50, 99, 100)
- Threshold calibration produces values within 20% of expected when fed 20 days of MNQ obs01 (expected MNQ p50≈3, p75≈8, p95≈45 in this regime)
- Institutional concentration detector fires on synthetic: 4 trades of 75 contracts each at zone in 10min → `InstitutionalConcentrationEvent`
- `institutional_flow_match` multiplier applies when scenario zone matches detected concentration; tooltip shows "+20% (12 institutional trades net +452 delta at W-1σ demand)"
- Block trade detector fires on single 150-contract trade at scenario zone
- Active Posture surfaces relevant institutional-flow sentence
- Recent Signals panel (from RA-050) shows institutional_concentration events with correct cross-reference
- Tests: ~15 new test cases; ruff + mypy clean
- Visual smoke: dashboard renders institutional subsection populated with real 5/26 data (or synthetic if 5/26 RTH obs01 not yet normalized)

### Pre-build sweep expectation

1. **Threshold defaults**: 1-9 retail, 10-49 mixed, 50-99 institutional, ≥100 block (recommended starting values). Calibration adjusts per-symbol.
2. **Concentration threshold**: 3 trades + net delta 100 default. Configurable. Too tight = misses subtle flow; too loose = noisy.
3. **Multiplier values**: +20% match / -20% oppose / +15% block. Conservative starting values; calibration log will refine.
4. **Aggregation window**: 60min default. Shorter = more responsive but noisier; longer = misses flow that paid out then exited.
5. **Block trade definition**: ≥100 contracts is a reasonable single-trade institutional threshold for MNQ. Could be raised to ≥200 if there's too much noise.
6. **Zone matching scope**: scenarios only, or also user-drawn zones? Recommend scenarios only for v1 consistency.
7. Anything surfaced from reading obs01 schema.

### Out of scope

- Real-time order book imbalance (separate scope, MBP1-based)
- Iceberg detection (separate ticket, needs MBO)
- Trade size profiling for non-MNQ symbols (defer; MNQ is testbed)
- Hidden-volume estimation (research-grade, defer)
- Auto-trade execution (never)

### Relationship to RA-046, RA-047, RA-050

- Reuses RA-046's bounded-tail-read pattern for obs01 input
- Reuses RA-046's calibration_log.py pattern for threshold persistence
- Multipliers compose additively with RA-046/047 multipliers (test co-firing in QA)
- Events feed into RA-050's Recent Signals panel + multi-signal-stack alerting

### Dispatch protocol

Pre-build sweep first (7 points above + anything from code reading), then green-light, then phases 1-5 sequentially. Ship when 97+15 = ~112 tests green + ruff + mypy clean + visual smoke.

---

## RA-064 · Investigate missing MBO F/T action types in normalized output — SHIPPED 2026-05-28

> SHIPPED 2026-05-28. Outcome: F/T absence is structural and worked around correctly; priority drop is the actual unblock — followups RA-065 + RA-066. See docs/incident_mbo_ft_gap.md.

**Priority**: P1
**Estimate**: 2 hours
**Dependencies**: RA-035 MBO normalization, RA-052 incremental normalize, RA-059 iceberg detector

**Description**: RA-059 shipped a principled MBO+OBS hybrid iceberg detector because the current normalized MBO siblings appear to contain `A/M/C` lifecycle rows but no `F/T` fill/trade action rows. That makes OBS timing confirmation the load-bearing consumption source and likely explains the initial iceberg calibration result of `0.00` events/session across the sampled MBO/OBS pairs.

This ticket investigates whether `F/T` rows are missing because the Rithmic probe does not capture them, the raw stream encodes fills differently than expected, or the normalization path drops/filters them. The output is an evidence-backed diagnosis and a recommendation for RA-059 v2, not a detector rewrite.

### Background — why this matters

RA-059 correctly avoids treating every MBO order disappearance as a fill. Without `F/T`, an `A → C → A` sequence could be real consumption or a cancel/repost. The shipped v1 uses OBS trade confirmation inside ±50ms to disambiguate:

- MBO supplies visible order lifecycle/refill state.
- OBS supplies trade/aggressor confirmation.
- MBO disappearance without matching OBS trade is treated as cancel.

That is safe, but lossy. Restoring true MBO fill/trade actions would improve iceberg yield and reduce reliance on cross-stream timestamp matching.

### Investigation plan

1. **Probe config trace**
   - Inspect `scripts/infra/capture-rithmic-probe.py` and wrapper invocation paths.
   - Confirm requested streams include the MBO feed needed for fill/trade lifecycle rows.
   - Verify no capture-side filter keeps only add/modify/cancel actions.

2. **Raw capture sampling**
   - Sample recent raw captures with MBO enabled before normalization.
   - Count raw action-like fields and stream/type labels.
   - Determine whether raw records ever contain `F`, `T`, fill, trade, execute, or equivalent fields.

3. **Normalizer trace**
   - Inspect `rithmic_analytics` normalization code paths that write `*.mbo.jsonl`.
   - Trace action mapping from raw payload/envelope to normalized `action`.
   - Verify whether unknown action values are dropped, coerced, or filtered.

4. **Incremental normalize parity**
   - Confirm RA-052 incremental normalize and full normalize produce identical MBO action distributions on the same raw fixture.
   - If only one path drops `F/T`, identify the divergent branch.

5. **Evidence artifact**
   - Write a short markdown note under `docs/` with:
     - raw sample counts
     - normalized sample counts
     - files/functions inspected
     - root-cause conclusion
     - recommendation for RA-059 v2

### Acceptance criteria

- Counts action distribution for at least two recent sessions, including one Globex and one RTH when available.
- Demonstrates whether `F/T` are absent in raw capture, present in raw but dropped in normalization, or encoded under another field/name.
- Confirms whether full normalize and incremental normalize agree on MBO action distribution.
- Adds or updates a focused regression test if the root cause is a normalizer mapping/filter bug.
- Does not modify RA-059 detector behavior unless the investigation finds a one-line normalization bug with an obvious test.
- Produces a concrete recommendation:
  - "capture config fix required",
  - "normalizer bug, fix in follow-up",
  - "Rithmic retail MBO does not expose F/T; keep OBS hybrid",
  - or "F/T equivalent exists under alternate field; draft RA-059.1 to consume it."

### Out of scope

- Rewriting the iceberg detector.
- Changing RA-059 thresholds.
- Building a heatmap renderer.
- Adding new trading signals.
- Auto-trade execution.

### Relationship to RA-059

RA-059 v1 is correct and should remain in production. RA-064 determines whether the input data can be improved so RA-059 v2 can use direct MBO consumption events instead of relying primarily on OBS timing confirmation.

---

## RA-057 · EOD session-combined CLI for next-day prep
**Priority**: P2
**Estimate**: 2-3 hours
**Dependencies**: RA-052

**Description**: RA-052's EOD full analytics script needs a canonical
`session_combined` CLI hook for next-day prep, but no
`rithmic_analytics.cli.session_combined` module exists today. Current EOD
prep relies on manual analyst synthesis and dashboard-side combined-zone
loading behavior.

Build a narrow CLI that combines completed Globex + RTH zone/profile context
for one trading date, writes the canonical combined artifact expected by the
dashboard and chart-prep docs, and exits clearly when one leg is missing.

**Acceptance criteria**:
- `python -m rithmic_analytics.cli.session_combined --trading-date YYYY-MM-DD --root-symbol MNQ` writes the documented combined-session artifact.
- Missing Globex or RTH input exits non-zero with a clear message unless an
  explicit `--allow-partial` flag is passed.
- `run_eod_full_analytics.ps1` can call it without warning once shipped.
- Docs in `operations.md` identify this as the final EOD prep step.

---

## RA-065 · Surface MBO `priority` field through to MboOrderTracker (independent iceberg-confirmation channel)
**Priority**: P1 — unlocks RA-059 v2 without depending on OBS-trade alignment.
**Estimate**: 4-6 hours
**Dependencies**: RA-064 investigation (root-cause + drop-point trace).
RA-035 (MBO sibling production — extends its schema).
RA-059 (iceberg detector v1 — adds priority channel; v1 stays as fallback).

**Description**: The Rithmic probe emits `depth_order_priority` on every
MBO order (verified 100% population across 326K orders sampled in
RA-064). The field is dropped by four downstream layers and never
reaches the iceberg detector. Plumbing it through enables two new
detection signals that don't depend on OBS-trade-tail correlation:

- **Queue-position consumption test**: a `delete` event at queue-position-1
  on its price level is almost certainly a fill (FIFO consumption),
  independent of whether a LAST_TRADE printed within `match_tolerance_ms`.
- **Refill-by-priority-jump detection**: when a `new` order appears at a
  price within the refill window of a `delete` at the front of that
  queue, a non-contiguous priority jump above the previous tail is the
  canonical iceberg-refresh fingerprint.

Both signals compute without LAST_TRADE. OBS confirmation becomes a third
corroborator instead of the single load-bearing input.

**Files to modify** (four sequential plumbing points + tracker
extension):

1. `rithmic_analytics/ops/normalize_probe.py::parity_mbo_record_to_mbo_dicts`
   (lines 580-589 + fallback at 541-547) — add
   `"priority": order.get("priority")` to output dicts.
2. `rithmic_analytics/core/loader.py::_MBO_DTYPES` — add
   `"priority": "string"`.
3. `rithmic_dashboard/rithmic_dashboard/models.py::MboOrderEvent` —
   add `priority: str | None = None` (default keeps pre-fix siblings
   loadable).
4. `rithmic_dashboard/rithmic_dashboard/features/mbo_order_tracker.py::_event_from_record`
   (lines 272-283) — read `rec.get("priority")` into the constructor;
   add `priority` to `_TrackedOrder` (lines 44-52); maintain per-(price,
   side) priority-ordered active-orders state.
5. Extend `MboOrderTracker._remove` with the queue-position consumption
   test; extend `MboOrderTracker._add` (or the append path after a
   recent `_remove` at the same price) with the priority-jump check.

**Tests required**:
- Backward-compat byte-exact on existing test cases — `priority=None`
  path must produce numerically identical iceberg output to pre-fix.
- Queue-position consumption test on synthetic FIFO scenario.
- Refill-by-priority-jump test on a synthetic iceberg pattern.
- Regenerated `.mbo.jsonl` carries the priority field populated.
- Cached sibling invalidation: pre-fix siblings carry no priority;
  delete-cached + re-normalize regenerates with the field (mirrors
  the RA-035 / RA-041 invalidation workflow — document in
  operations.md).

**Acceptance**:
- All RA-035 and RA-059 tests pass (byte-exact numerics on the
  no-priority path).
- New priority-channel tests green.
- ruff + mypy clean.
- Smoke against today's regenerated capture: iceberg event count > 0
  on the same fixture that produced 0.00 events in RA-059 calibration.

**Out of scope**:
- Modifying the OBS-trade-tail confirmation logic (that's RA-066's
  domain).
- Multi-vendor MBO support (Rithmic-specific for v1).
- Heatmap rendering of priority-ordered ladder state.

---

## RA-066 · Walk-forward calibrate `match_tolerance_ms` for RA-059 OBS-trade confirmation
**Priority**: P2 — fallback half of the iceberg detector; becomes diagnostic-only if RA-065 ships clean.
**Estimate**: 2 hours
**Dependencies**: RA-059 (iceberg detector v1). RA-053-era databento corpus
(96 sessions Feb-Apr 2026) for the walk-forward fixture base.

**Description**: The RA-059 calibration result of 0.00 events/session on
the sampled corpus may reflect a mis-tuned `match_tolerance_ms` (default
50ms) for the OBS-trade-tail confirmation, not just the priority gap
that RA-065 addresses. Sweep `match_tolerance_ms` across
`[5, 10, 25, 50, 100, 250]ms` against the 96-session databento corpus,
plot iceberg event yield per tier, pick the knee.

If RA-065 ships first and yields healthy event counts on its own
(priority channel is decisive), RA-066 becomes a diagnostic confirming
the OBS half also works — still worth running to retire the calibration
question, but no longer load-bearing for production.

**Files to modify** / create:
- `rithmic_analytics/scripts/calibrate_iceberg_tolerance.py` — new
  one-shot walk-forward script (not under cli/ since it's not part
  of the daily loop).
- `docs/iceberg_tolerance_calibration.md` — methodology + results note
  (mirrors the `ewma_calibration_methodology.md` documentation style).
- Update RA-059 default `match_tolerance_ms` if the knee differs
  meaningfully from 50ms.

**Acceptance**:
- Calibration script runs against the corpus without error.
- Per-tolerance event-yield table documented.
- If the knee shifts the default, the RA-059 test suite is rerun to
  confirm numerics remain consistent at the new default.

**Out of scope**:
- Detector logic changes beyond the threshold default.
- Production rollout of the new threshold without an A/B comparison
  window.

---

> **v2 REALTIME TRACK — stack locked 2026-05-28** (see `docs/v2_realtime_architecture.md`):
> React 18 + TypeScript + TradingView lightweight-charts v5.2 frontend ·
> FastAPI + WebSocket backend importing detectors **as a library** ·
> greenfield view + serving layer (v1 HTML view is retired, signal
> pipeline RA-046–RA-059 is retained). Built **contract-first** so RA-060/
> 061/062/063 fan out to parallel agents after RA-067 lands. Each ticket
> owns a disjoint directory — see the file-ownership map in the arch doc.

## RA-067 · Realtime event contract + mock emitter + app skeleton (SERIAL — unblocks the fan-out) — SHIPPED 2026-05-28

> **Shipped.** `contracts/realtime/` landed: `events.py` (Pydantic v2 source
> of truth) + `events.ts` (hand-kept TS mirror) + `config.py`/`config.ts`
> (alert-config stub for RA-063) + `mock_emitter.py` (FastAPI WS server,
> synthetic CRITICAL/HIGH/MEDIUM on a timer). 25 tests green; ruff + mypy
> clean (9 files). Parity tripwire **verified firing** on injected TS drift
> then reverted. Live uvicorn+websockets round-trip confirms a client
> receives snapshot→heartbeat→CRITICAL. Skeleton dirs + ownership READMEs
> created for RA-060/061/062/063. Decisions taken (both spec-permitted):
> hand-keep+assert for TS⇄Py parity (no codegen toolchain), synthetic mock
> (no capture-replay fixture dependency). **The fan-out is unblocked** —
> RA-060/061/062/063 can launch in parallel against the mock.

**Priority**: P0 — nothing in the realtime track starts until this lands.
**Estimate**: 4-6 hours
**Dependencies**: RA-046–RA-059 detector modules (the contract describes their outputs).
**Owns (no other ticket writes here)**: `contracts/realtime/` + the skeleton dirs it creates.

**Why first**: backend, frontend, notifications, and config all bind to one wire format. Define it once, freeze it, and four agents build against it in parallel without colliding. Ships a mock so downstream work needs zero access to a running backend or live capture.

**Deliverables**:
1. **Wire schema, dual-typed** — single source of truth as Pydantic v2 (`contracts/realtime/events.py`) + TypeScript (`contracts/realtime/events.ts`), kept in sync by a parity test (generate TS via `pydantic-to-typescript`, or hand-keep + assert). Envelope: `type` (snapshot|event|heartbeat|regime|error), `seq` (monotonic; client detects gaps → resync), `ts_ns`/`ts_pt`, `tier` (CRITICAL|HIGH|MEDIUM|null), `schema_version`, `payload` (discriminated union by family: signal, iceberg, absorption, sweep, vol_regime, price_tick, zone_update, …). RA-050 extensibility contract holds: an unknown family round-trips through the envelope and reaches the feed without crashing the renderer.
2. **Snapshot shape** — full current state for initial load + reconnect resync (price, EWMA σ/regime, all active zones, last N signals, open scenarios).
3. **Mock emitter** (`contracts/realtime/mock_emitter.py`) — replays a recorded capture OR generates synthetic CRITICAL/HIGH/MEDIUM events on a timer over the same WS interface RA-060 will implement. Frontend + daemon develop entirely against this.
4. **Repo skeleton** — `services/realtime_backend/`, `apps/dashboard_ui/`, `services/notification_daemon/` stubs, each with a README declaring file ownership.

**Acceptance**:
- `events.py` and `events.ts` are provably in sync (parity test fails on drift).
- Mock serves a WS endpoint; a trivial client receives snapshot + heartbeats + a scripted CRITICAL within 60s.
- Unknown event family round-trips without error (extensibility gate).
- Disjoint-ownership map documented.

**Out of scope**: real detector wiring (RA-060), any UI (RA-061).

---

## RA-060 · Realtime WebSocket backend — FastAPI, detectors-as-library [parallel after RA-067]
**Priority**: P1
**Estimate**: 12-16 hours
**Dependencies**: RA-067 (contract + skeleton). Imports RA-046–RA-059 feature modules as a library.
**Owns**: `services/realtime_backend/` only.

**Description**: Greenfield FastAPI + uvicorn service that runs the existing detector modules **in-process as a library** (per the locked scope decision — import `rithmic_dashboard.features.*` directly rather than re-reading JSONL) over the live capture tail, classifies confluence/tier, and pushes contract-shaped events over WebSocket. The RA-067 mock emitter is its functional spec.

**Phases**:
1. FastAPI + uvicorn scaffold; WS endpoint implementing the RA-067 envelope; connection manager (multi-client, per-client send queue) (~3h)
2. Capture-tail watcher (watchdog) → in-process detector invocation on append; debounce (~3h)
3. REST snapshot endpoint (initial load + post-reconnect resync); seq/gap protocol (~2h)
4. Confluence + tier classification (extends RA-050 multi-stack; CRITICAL/HIGH/MEDIUM) (~3h)
5. Heartbeat emitter + staleness detection (no capture activity → degraded event) (~1h)
6. Tests + memory regression (RA-052 < 2GB) + docs (~3h)

**Acceptance criteria**:
- `python -m realtime_backend.server` boots; WS clients receive snapshot then live events.
- Detector-as-library path is numerically consistent with the JSONL path on a fixed fixture (parity gate vs existing RA-058/059 outputs).
- New capture lines reflected in pushed events within 1s.
- Multi-client; per-client backpressure (drop-oldest, never block the producer).
- Memory < 2GB after 1h continuous (RA-052 contract).
- ruff + mypy clean; ~30 tests.
- New deps: `fastapi`, `uvicorn[standard]`, `websockets`, `watchdog`.

**Out of scope**: auth (localhost tool), multi-symbol (MNQ only), the UI, native toasts.

---

## RA-061 · React + TypeScript realtime UI — lightweight-charts v5 [parallel after RA-067]
**Priority**: P1
**Estimate**: 14-18 hours
**Dependencies**: RA-067 (contract + mock — develop entirely against the mock; zero dependency on RA-060 landing).
**Owns**: `apps/dashboard_ui/` only.

**Description**: Greenfield SPA. **Vite + React 18 + TypeScript**, importing the RA-067 TS types. WebSocket client with reconnect-with-backoff + seq-gap resync. Price surface uses **TradingView lightweight-charts v5.2** (`npm i lightweight-charts`, Apache-2.0). Replaces the v1 HTML view entirely.

**lightweight-charts mapping (evaluated 2026-05-28 against v5.2.0)**:
- **Candlestick series** for MNQ price — v5 API `chart.addSeries(CandlestickSeries, {...})` (not the old `addCandlestickSeries()`).
- **Price lines** (`series.createPriceLine({price, color, lineStyle, title})`) for every horizontal level: ±1σ/±2σ bands, VPOC/VAH/VAL, multi-day demand zones, W-VWAP. RED=short / GREEN=long / YELLOW=no-trade convention carries over.
- **Series markers** (v5 `createSeriesMarkers` primitive) for discrete events: iceberg, absorption, sweep, CRITICAL confluence.
- **Second pane** (v5 native panes) for volume + CVD histogram below price.
- **Realtime via `series.update()`** for per-tick — NOT `setData()` (setData is initial snapshot/resync only; it full-redraws and tanks perf). Maps 1:1 onto the WS `price_tick` family.
- React integration is the documented `useRef`+`useEffect` lifecycle pattern (no official React component; `chart.remove()` on cleanup). Custom price-scale formatter for the 0.25 tick.

**The 5 tiers** (React components):
- **Tier 1 ALERT BANNER** (CRITICAL): Web Audio chime + browser Notification; auto-decays on >50pt move or after 30min.
- **Tier 2 ACTIVE SCENARIOS**: ≤3 within ±100pt, priority-sorted, live price-driven.
- **Tier 3 LIVE SIGNAL FEED**: last 10, recency+strength, time-decay opacity.
- **Tier 4 PRICE CONTEXT + CHART**: lightweight-charts surface + price/σ/regime/closest-zones/aggressor snapshot. Always visible.
- **Tier 5 COLLAPSED HISTORY + SETTINGS**: accordion; full audit + the RA-063 alert-config panel.

**Phases**:
1. Vite+React+TS scaffold; WS client hook (reconnect/backoff, seq-gap → REST resync); contract types wired (~3h)
2. lightweight-charts: candles + volume pane + realtime `update()` path (~3h)
3. Price-line + marker layer driven by zone_update / signal families (~2.5h)
4. Tier 4 price context + Tier 1 alert banner (audio + Notification) (~3h)
5. Tier 2 scenarios + Tier 3 feed (~3h)
6. Tier 5 history + settings panel (RA-063 config) (~2h)
7. Reconnect/empty/degraded UI states; cross-browser Chrome/Edge/Firefox (~1.5h)

**Acceptance criteria**:
- Boots `npm run dev`; connects to RA-067 mock; renders snapshot + live updates.
- Chart: candles render; price lines for all zone types; markers for signals; volume pane; realtime via `update()` (verified — no full redraw per tick).
- Tier 1 fires within 2s of mock CRITICAL; audio + browser notification.
- WS drop → visible degraded state → auto-reconnect → seq-gap resync (no stale silent UI).
- TS strict clean; eslint clean; production build succeeds.

**Out of scope**: native mobile, multi-user/auth, re-deriving signals client-side (backend owns logic).

---

## RA-062 · Native Windows notification daemon [parallel after RA-067]
**Priority**: P2
**Estimate**: 4-6 hours
**Dependencies**: RA-067 (consumes the WS contract; dev against the mock).
**Owns**: `services/notification_daemon/` only.

**Description**: Headless Python daemon — a second WS client on the RA-067/RA-060 stream. Fires native Windows toasts on CRITICAL. Solves "browser backgrounded, missed the alert."

**Implementation**: `windows-toasts` / `win11toast` (modern, supports actions) over the unmaintained `win10toast`. WS client with reconnect. CRITICAL-only by default (RA-063 config). Toast = zone price + families + 1-line posture. Optional tray icon (regime + connection status).

**Acceptance criteria**:
- `python -m notification_daemon.run` boots; toast on mock CRITICAL within 3s.
- Reconnects on WS drop without crash.
- ~10 subprocess-lifecycle tests; install-as-startup-task doc.

**Out of scope**: Mac/Linux, click-to-act.

---

## RA-063 · Alert configuration system [parallel after RA-067]
**Priority**: P2
**Estimate**: 3-4 hours
**Dependencies**: RA-067 (config schema lives in the contract). Consumed by RA-061 (settings UI), RA-062 (daemon), RA-060 (tier gating).
**Owns**: `services/realtime_backend/config/` + the config type in `contracts/realtime/`. RA-061 renders it; this ticket defines + serves it.

**Description**: JSON-backed single source of truth for alert prefs, declared as a contract type so frontend + daemon + backend share it without drift. Controls which tiers fire, sound, proximity thresholds, quiet hours.

**Config schema**:
```json
{
  "alerts": {
    "critical": {"enabled": true, "audio_file": "critical_alert.wav", "browser_notif": true, "windows_toast": true},
    "high": {"enabled": true, "audio_file": "high_alert.wav", "browser_notif": true, "windows_toast": false},
    "medium": {"enabled": false, "audio_file": null, "browser_notif": false, "windows_toast": false}
  },
  "proximity": {"critical_pt": 50, "high_pt": 100, "medium_pt": 50},
  "quiet_hours": {"enabled": false, "start_pt": "22:00", "end_pt": "06:00", "audio_only": true}
}
```

**Phases**:
1. Schema in contract + persistence (~1h)
2. REST get/put endpoint + hot-reload into tier gating (~1.5h)
3. TS/Py schema parity test (~0.5h)
4. Docs (~0.5h). (The settings UI itself is RA-061 Phase 6.)

**Acceptance criteria**:
- Persists to `data/dashboard/alert_config.json`.
- Changes take effect on next event (no restart).
- Quiet hours silence audio while keeping visual banners.
- TS/Py schema parity test green.

---

## RA-068 · Integration + production hardening (CONVERGENCE — after RA-060/061/062/063)
**Priority**: P1
**Estimate**: 8-12 hours
**Dependencies**: RA-060, RA-061, RA-062, RA-063 all merged.
**Owns**: end-to-end wiring + ops; runs alone (no parallel peer), so it may touch any integration seam.

**Description**: Swap the RA-067 mock for the real RA-060 backend and harden to production. This is where "robust/production-ready" is earned.

**Scope**:
- Wire real backend ↔ React UI ↔ daemon; remove the mock from the runtime path (keep it as a test fixture).
- Resilience: reconnect-with-exponential-backoff on every client; heartbeat + staleness banner; seq-gap → snapshot resync verified end-to-end; backpressure under a slow consumer.
- Failure-mode tests: kill backend mid-stream, drop the capture feed, throttle a client, restart — UI degrades visibly and recovers, daemon survives, no crash/leak.
- Load: sustained busy-open event rate without UI jank or memory growth.
- Packaging: backend + daemon as Windows startup tasks; single `run_realtime_stack.ps1`; health endpoint.
- Full memory regression (RA-052) on the long-running backend.
- E2E smoke doc + ops runbook in `docs/operations.md`.

**Acceptance criteria**:
- Cold start via `run_realtime_stack.ps1` brings up backend + UI + daemon.
- Scripted chaos (kill / drop / throttle) recovers automatically.
- 1h soak < 2GB, no leak.
- E2E + failure-mode tests green.

**Out of scope**: auth, multi-symbol, cloud deploy.

---

## RA-059 · Iceberg / hidden-order detector (MBO-based institutional flow signal)
**Priority**: P1
**Estimate**: 6-8 hours
**Dependencies**: RA-046 (live signal infrastructure + audit trail), RA-050 (Recent Signals panel for surfacing), RA-049 (institutional_flow family — iceberg is a related family but distinct), MBO captures (already enabled in rithmic capture pipeline)

**Description**: RA-049 added trade-size profiling and institutional concentration detection, but couldn't detect ICEBERGS — institutional orders deliberately split into smaller visible chunks that refill at the same price level after each consumption. Icebergs are the highest-conviction institutional commitment signal available in retail-accessible data: they explicitly say "an institutional player wants to fill at THIS price and is willing to wait." Currently these signals are only readable on Bookmap's heatmap; this ticket builds the detector from the existing MBO stream so the signal lands in your dashboard without depending on Bookmap.

This is one of the two "bookmap-equivalent" tickets surfaced after the user reviewed Bookmap data alongside the dashboard during 2026-05-28's session. The other is RA-058 (aggressor flow metrics + tabular footprint). Both are unblocked by the shipped RA-046 / RA-049 infrastructure.

**Project**: `tools/rithmic_dashboard/` (extend existing live signals).

### Background — why this matters

The 2026-05-28 cascade and recovery exposed the gap. We could see on Bookmap:
- 30,200-30,222 bid wall held during the cascade (visible as orange/red persistent stacks)
- Visible buyer at 30,260+ during the V-recovery (iceberg-like refilling)
- Persistent sell stack at dPOC 30,300 (institutional defender)

The dashboard couldn't tag any of these because absorption detection looks at trade-flow patterns, not order-lifecycle patterns. Icebergs are detected by watching the ORDER BOOK refill behavior, not the trade tape — they show up in MBO data but not in trade-only streams.

### Phase 1: MBO order-lifecycle tracker

New module `rithmic_dashboard/features/mbo_order_tracker.py`:

- Streams MBO records from bounded-tail (~5-10 min of recent activity)
- Tracks per-order_id lifecycle: `add → modify → cancel → execute` sequences
- Maintains a price-level index: per price, list of (order_id, size, add_time, execute_time, cancel_time)
- Memory budget: must respect RA-052 < 2GB contract; bounded by recent-tail-only reads + LRU eviction
- Exposed query: "give me all orders that hit price P in last N seconds with their lifecycle stages"

This is the foundational structure; downstream detectors consume it.

### Phase 2: Iceberg pattern detector

New module `rithmic_dashboard/features/iceberg_detector.py`:

Iceberg pattern definition (configurable thresholds):

| Threshold | Default | What it means |
|---|---|---|
| `min_refills` | 3 | Same price level shows N+ distinct order_ids added → fully executed within window |
| `refill_window_seconds` | 30 | Refill events must occur within N seconds of prior execution |
| `size_consistency_pct` | 0.40 | Each refill size must be within 40% of the median refill size at that level |
| `aggressor_side_consistent` | True | All executes must hit from the same side (consistent direction) |
| `min_total_consumed` | 50 | Total volume consumed across refills (avoid micro patterns) |

When pattern matches, emit `iceberg_detected` event:

```jsonl
{"timestamp_pt": "2026-05-28 13:58:35 PT",
 "event_type": "iceberg_detected",
 "level_id": "iceberg-30220.00",
 "description": "Iceberg detected at 30,220.00: 5 refills, 145 consumed, side=SELL (sellers absorbing)",
 "intensity": 4.5,
 "confidence": "high",
 "metadata": {"price": 30220.0, "refill_count": 5, "total_consumed": 145, "side": "SELL", "median_refill_size": 28, "window_seconds": 30}}
```

`intensity` scales with `refill_count` (3-5 = medium, 6-9 = high, 10+ = very high).
`confidence` = `"high"` when `min_refills` exceeded by 50%+ AND aggressor side fully consistent.

Persist to `data/live_analysis/<date>_<session>_icebergs.jsonl`.

### Phase 3: Probability multiplier integration

Extend `probability_adjuster.py`:

| Multiplier | Trigger | Effect | Rationale |
|---|---|---|---|
| `iceberg_at_entry` | ≥1 iceberg event at scenario's entry zone in last 60min, matching scenario direction (institutional commitment in same direction as the trade) | +20% | Confirmed institutional commitment — strongest single-event signal for the level's validity |
| `iceberg_opposing_entry` | Iceberg at entry zone but OPPOSITE direction (institutional player committed against your scenario) | -25% | Smart money is on the other side; do not fade institutional commitment |
| `iceberg_high_intensity_stack` | ≥2 distinct iceberg events at same zone within 30min | +30% (replaces `iceberg_at_entry`) | Multi-iceberg = sustained institutional defense |

Cap composition with existing [0.4, 1.6] cap. Co-firing tests required:
- `iceberg_at_entry` + RA-049's `institutional_flow_match` (both can fire — different signal types)
- `iceberg_at_entry` + RA-047's `delta_dislocation_at_entry` (rare confluence — should clip cleanly)
- `iceberg_opposing_entry` vs `iceberg_at_entry` guard (mutually exclusive — only one can fire)

### Phase 4: Renderer + RA-050 integration

**Orderflow Pulse**: new subsection "Recent Icebergs":
- Per-event row: timestamp, price, refill count, total consumed, side
- Sticky badge for currently-active icebergs (refills in last 60 sec)
- Color-coded by side (sell-side red, buy-side green)

**Active Posture**: append iceberg sentence when relevant:
- "Iceberg detected at W+2σ SHORT zone (30,365): 5 sell-side refills, 145 consumed in 30 sec. Short scenarios at this level up-weighted +20%."

**Audit trail event types**:
- `iceberg_detected` — standard event
- `iceberg_high_intensity_stack_detected` — multi-iceberg cluster

**RA-050 integration**:
- Family map: register `"iceberg"` family in `multi_signal_stack_alert.py` and `zone_signal_badges.py` (same PR)
- Icon for zone badge: `🧊` (ice cube — visually distinct from existing badges)
- Multi-signal stack: icebergs combined with sweep/absorption at same zone trigger sticky banner

### Phase 5: Calibration log + threshold auto-tuning

Persistent logging for empirical calibration:
- Every iceberg event logs with full metadata to `data/live_analysis/iceberg_outcomes.jsonl`
- When scenario completes (target_hit / stop_hit), log realized outcome alongside whether iceberg multiplier was applied
- After 30+ outcomes, Wilson-CI calibration can replace the heuristic +20% / +30% values with empirical estimates

Threshold auto-calibration CLI: `rithmic_dashboard/cli/calibrate_iceberg_thresholds.py`
- Reads last N sessions of MBO captures
- Tunes `min_refills` and `size_consistency_pct` to balance precision vs recall (target: ~5-10 events per session)
- Atomic write to `data/live_analysis/iceberg_thresholds.json`
- Same idempotent pattern as RA-049's threshold calibration

### Files to create/modify

- `rithmic_dashboard/features/mbo_order_tracker.py` — NEW (~250 LOC)
- `rithmic_dashboard/features/iceberg_detector.py` — NEW (~200 LOC)
- `rithmic_dashboard/features/probability_adjuster.py` — extend with 3 new multipliers
- `rithmic_dashboard/features/orderflow_pulse.py` — add Recent Icebergs subsection
- `rithmic_dashboard/features/posture_synthesis.py` — incorporate iceberg context
- `rithmic_dashboard/features/audit_trail.py` — new event types
- `rithmic_dashboard/features/multi_signal_stack_alert.py` — add `"iceberg"` family
- `rithmic_dashboard/features/zone_signal_badges.py` — add `🧊` icon for iceberg badge
- `rithmic_dashboard/cli/calibrate_iceberg_thresholds.py` — NEW CLI
- `rithmic_dashboard/cli/generate.py` — wire iceberg detector into main flow
- `rithmic_dashboard/templates/dashboard.html.j2` — render iceberg subsection
- `tests/test_mbo_order_tracker.py` — order lifecycle tracking + memory bounds
- `tests/test_iceberg_detector.py` — pattern matching (positive + negative cases)
- `tests/test_iceberg_multipliers.py` — co-firing with RA-047/049, opposing-direction guard
- `tests/test_iceberg_calibration.py` — threshold sweep behavior
- `tests/test_iceberg_ra050_integration.py` — verify event appears in Recent Signals panel
- `docs/feature_reference.md` — iceberg detector section
- `docs/operations.md` — when to run iceberg calibration CLI
- `docs/iceberg_detection_methodology.md` — NEW DOC explaining the pattern + thresholds + edge cases

### Acceptance criteria

- MBO order tracker reads bounded-tail without violating RA-052 memory contract (< 2GB peak)
- Iceberg detector fires on synthetic: 5 sequential add→full-execute events at price 30,220 within 30 sec, sizes 25/30/28/27/32 (within size_consistency tolerance), all aggressor SELL → emit iceberg_detected with `confidence: "high"`, `refill_count: 5`
- Negative test: 3 events at same price but with mixed aggressor sides → does NOT emit (consistent_side guard)
- Negative test: 3 events within 60s (above refill_window_seconds=30) → does NOT emit
- `iceberg_at_entry` multiplier visible in scenario tooltip: "+20% (5 sell refills, 145 consumed at W+2σ SHORT zone)"
- `iceberg_opposing_entry` correctly negates scenarios in the wrong direction
- `iceberg_high_intensity_stack` replaces (not stacks on) `iceberg_at_entry` when multi-iceberg cluster fires
- Co-firing test: iceberg + institutional_flow_match + cvd_direction_match all firing on same scenario → cap clips cleanly without dropping multipliers
- RA-050 integration: iceberg events appear in Recent Signals panel with 🧊 icon via schema-extensibility contract (no renderer code changes needed in RA-050)
- Multi-signal stack banner fires when iceberg + absorption or iceberg + sweep at same zone within 30min
- Calibration CLI produces threshold file with target 5-10 events per session
- Tests: ~18 new test cases; ruff + mypy clean
- Visual smoke: dashboard renders icebergs subsection populated with real 5/28 MBO data if any patterns fired

### Pre-build sweep expectation

Per established discipline, surface ambiguity before coding. 8+ points:

1. **Order tracker memory bound**: LRU evict orders older than 10min vs keep all in tail window. Recommend LRU (cap memory growth).
2. **Refill window default 30 sec vs 60 sec**: 30 sec matches typical institutional execution cadence; 60 sec is more permissive. Recommend 30 sec default, configurable.
3. **Size consistency threshold 40% vs 30%**: 40% tolerates more execution variance; 30% is stricter. Recommend 40% default.
4. **`min_total_consumed` value (50 default)**: prevents micro-iceberg false positives. Calibrate per symbol — 50 for MNQ is small; ES would need ~200.
5. **Aggressor side consistency**: strict (all same) vs permissive (≥80% same). Recommend strict for v1.
6. **Multi-iceberg stack threshold**: 2 distinct events within 30min for `iceberg_high_intensity_stack`. Could be 3 within 60min — tradeoff between alpha and rarity.
7. **Calibration log retention**: keep all-time vs trailing N sessions. Recommend all-time (cheap, builds corpus).
8. **iceberg_opposing_entry guard semantics**: applies when the OPPOSING-side iceberg is within 0.25σ of scenario entry zone (very close) — not when it's just somewhere in the chart. Confirm what defines "at entry zone."
9. **Anything found reading MBO record schema** — especially how rithmic encodes order types (limit, hidden, iceberg-displayed-size vs total-size).

Surface as single message. Wait for green-light before coding.

### Out of scope

- True iceberg detection (knowing the actual total size hidden vs displayed) — requires exchange-side data not in retail MBO stream
- Spoofing detection (orders added then quickly cancelled with no execution intent) — different pattern, future ticket
- Cross-symbol iceberg correlation (e.g., iceberg in ES vs MNQ) — multi-symbol scope
- Heatmap visualization rendering — that's RA-062 (deferred)
- Auto-trade execution — never

### Relationship to RA-046, RA-049, RA-050, RA-058

- Reuses RA-046's bounded-tail-read pattern for MBO input
- Distinct from RA-049's institutional_flow (RA-049 detects flow concentration from trade data; RA-059 detects refilling pattern from order book)
- Both can fire together at same zone (additive multipliers, no conflict)
- Family `"iceberg"` registers in RA-050 alongside RA-049's `"institutional_flow"`
- Integrates with RA-058's tabular footprint: footprint shows the per-price aggression density that explains WHY the iceberg level is being defended

### Dispatch protocol

Per established discipline:
1. Executor's first response: pre-build sweep (9 ambiguity points + plan paragraph + per-phase time estimates)
2. Wait for green-light before writing source
3. Critical invariants:
   - RA-052 memory contract (< 2GB peak on light path)
   - RA-050 schema-extensibility contract (events flow into panel without renderer changes)
   - `iceberg_opposing_entry` vs `iceberg_at_entry` mutual exclusion guard

---

## RA-058 · Aggressor flow metrics + tabular footprint chart
**Priority**: P1
**Estimate**: 6-8 hours
**Dependencies**: RA-046 (live signal infrastructure)

**Description**: Replicate the bookmap-equivalent aggressor flow metrics (liftAsk / hitBid / vDelta windowed) and per-price-per-bar tabular footprint from the existing rithmic obs01 trade stream. Surfaced during 2026-05-28's session when the user was reading these metrics off Bookmap screenshots to validate scenarios — the same data is computable from the local capture without external dependency.

This is the lighter of the two "bookmap-equivalent" tickets (paired with RA-059 iceberg detector). Quick win — most of the computations are simple aggregations over the existing trade stream.

**Project**: `tools/rithmic_dashboard/` (extend existing Orderflow Pulse).

### Background — what these metrics give you

The user verified during the 2026-05-28 session that bookmap's `liftAsk` / `hitBid` / `vDelta` show order-flow conviction with finer granularity than session CVD:

| Bookmap metric | What it measures | Why it matters |
|---|---|---|
| **liftAsk** | Volume of aggressive market-BUY orders (lifting the ask) in window | Bull aggression intensity |
| **hitBid** | Volume of aggressive market-SELL orders (hitting the bid) in window | Bear aggression intensity |
| **liftAsk - hitBid** | Net aggression | Who's winning order flow right now |
| **vDelta / StopRun** | Short-window delta with directional bias | Momentum indicator |
| **Tabular footprint** | Per-price-per-5min-bar bid_vol vs ask_vol with imbalance | Where buyers absorb vs where sellers absorb |

Currently the dashboard's Orderflow Pulse shows `session_cvd` and `last_60m_cvd` but not the breakdown into aggressor-side components. Adding these surfaces real-time order flow at higher granularity.

### Phase 1: Windowed aggressor metrics

New module `rithmic_dashboard/features/aggressor_metrics.py`:

For each window in `[60sec, 5min, 15min, 60min]`:
```python
def compute_aggression(trades, window_seconds, now):
    cutoff = now - window_seconds
    lift_ask = sum(t.size for t in trades if t.aggressor_side == 'B' and t.ts > cutoff)
    hit_bid = sum(t.size for t in trades if t.aggressor_side == 'S' and t.ts > cutoff)
    return AggressionMetrics(
        window_seconds=window_seconds,
        lift_ask=lift_ask,
        hit_bid=hit_bid,
        net=lift_ask - hit_bid,
        ratio=lift_ask / max(hit_bid, 1),
        total_volume=lift_ask + hit_bid,
    )
```

Compute on every 5-min dashboard tick. Persist most-recent values in session-state JSON for display.

### Phase 2: vDelta (short-window momentum CVD)

The vDelta metric is essentially a sliding-window CVD bounded to recent activity. Distinct from `session_cvd` (which accumulates from session open) because it captures momentum direction NOW.

Implementation:
```python
def compute_v_delta(trades, window_seconds=30):
    # Net signed volume over last N seconds
    return sum(
        t.size * (1 if t.aggressor_side == 'B' else -1)
        for t in trades if t.ts > now - window_seconds
    )
```

Default window 30 sec (matches bookmap's typical display cadence). Configurable.

### Phase 3: Tabular footprint chart per 5-min bar

For each completed 5-min bar (rolling tail-based):
- Compute per-price-level aggregates:
  - `bid_volume`: sum of `aggressor_side == 'S'` trades at that price (market sells = took the bid)
  - `ask_volume`: sum of `aggressor_side == 'B'` trades at that price (market buys = took the ask)
  - `total_volume`: bid_volume + ask_volume
  - `imbalance`: `(ask_volume - bid_volume) / total_volume` (range: -1 to +1)
- Persist per-bar to `data/live_analysis/<date>_<session>_footprint.jsonl`:

```jsonl
{"bar_start_pt": "2026-05-28 13:55:00 PT",
 "bar_end_pt": "2026-05-28 14:00:00 PT",
 "levels": [
   {"price": 30245.00, "bid_volume": 32, "ask_volume": 78, "imbalance": 0.41},
   {"price": 30247.50, "bid_volume": 41, "ask_volume": 65, "imbalance": 0.23},
   ...
 ]}
```

Render as table in dashboard (no canvas/heatmap — pure HTML table with color-coded cells). Stacked imbalances (3+ consecutive prices with same-side > 0.3 imbalance) flagged in audit.

### Phase 4: Renderer + audit + posture wiring

**Orderflow Pulse**: new subsection "Aggressor Flow":
- liftAsk / hitBid / net / ratio across the 4 windows (60s, 5min, 15min, 60min)
- vDelta with directional arrow + magnitude
- Color-coded chips (green for net positive, red for net negative)

**New Orderflow Pulse subsection**: "Footprint (current bar)":
- Tabular display of last completed 5-min bar's per-price activity
- Color: green-to-red gradient based on imbalance
- Top 10 most-imbalanced prices highlighted

**Active Posture**: extend sentence to mention aggressor balance when extreme:
- "Aggressor flow strongly bullish last 60s (liftAsk 139 vs hitBid 41 = net +98). Bears appear to be losing initiative."

**Audit trail events**:
- `aggressor_imbalance_extreme` — when ratio > 3.0 or < 0.33 in any window (one-sided dominance)
- `stacked_footprint_imbalance` — 3+ consecutive prices with same-side > 0.3 imbalance in current bar
- `v_delta_sign_flip` — when 30-sec vDelta crosses zero (momentum direction change)

### Phase 5: RA-050 integration + tests + docs

**RA-050 integration**:
- Register `"aggressor_flow"` family in `multi_signal_stack_alert.py` + `zone_signal_badges.py`
- Icon: 🌊 (waves — represents flow)
- Events from Phase 4 flow into Recent Signals panel via schema-extensibility

### Files to create/modify

- `rithmic_dashboard/features/aggressor_metrics.py` — NEW (~150 LOC)
- `rithmic_dashboard/features/footprint_aggregator.py` — NEW (~200 LOC)
- `rithmic_dashboard/features/orderflow_pulse.py` — add Aggressor Flow + Footprint subsections
- `rithmic_dashboard/features/posture_synthesis.py` — include aggressor sentence
- `rithmic_dashboard/features/audit_trail.py` — new event types
- `rithmic_dashboard/features/multi_signal_stack_alert.py` — add `"aggressor_flow"` family
- `rithmic_dashboard/features/zone_signal_badges.py` — add 🌊 icon
- `rithmic_dashboard/cli/generate.py` — wire aggressor + footprint into main flow
- `rithmic_dashboard/templates/dashboard.html.j2` — render Aggressor Flow + Footprint subsections
- `tests/test_aggressor_metrics.py` — windowed computation correctness
- `tests/test_v_delta.py` — sign flip detection
- `tests/test_footprint_aggregator.py` — per-bar per-price aggregation
- `tests/test_aggressor_imbalance_audit.py` — audit event firing
- `tests/test_aggressor_ra050_integration.py` — event flows to Recent Signals
- `docs/feature_reference.md` — aggressor flow + footprint sections
- `docs/operations.md` — how to interpret aggressor metrics

### Acceptance criteria

- liftAsk / hitBid computed correctly for synthetic trade sequence (verifies aggregation math)
- Multiple window computations consistent (60s subset of 5min subset of 15min)
- vDelta correctly signs (+/-) directional momentum
- Footprint aggregator produces per-price-per-bar table with imbalance values in [-1, +1]
- `aggressor_imbalance_extreme` fires on synthetic 3:1 ratio
- `stacked_footprint_imbalance` fires on synthetic 3 consecutive prices with same-side > 0.3
- `v_delta_sign_flip` fires on synthetic sign-cross
- Active Posture sentence appears when extreme imbalance
- Dashboard renders Aggressor Flow + Footprint subsections without breaking existing layout
- Events appear in RA-050's Recent Signals panel with 🌊 icon (schema-extensibility verified)
- Memory: light path peak RSS stays < 2GB (RA-052 contract)
- Tests: ~15 new test cases; ruff + mypy clean
- Visual smoke: dashboard renders against real 5/28 trade data showing per-window aggressor breakdown

### Pre-build sweep expectation

Per established discipline, 8 ambiguity points minimum:

1. **vDelta window default**: 30 sec (recommended) vs 60 sec. 30 sec matches bookmap; 60 sec captures more macro.
2. **Aggressor windows**: [60s, 5m, 15m, 60m] (recommended). Could swap 60s for 30s. 4 windows balance display vs noise.
3. **Footprint price granularity**: per-tick (0.25pt for MNQ) vs per-large-bucket (e.g., 5pt). Recommend per-tick for precision.
4. **Footprint bar window**: 5-min (recommended, matches dashboard tick) vs 1-min (more granular, noisier).
5. **Imbalance threshold for audit event**: 0.3 (recommended) vs 0.5 (stricter). 0.3 catches genuine flow tilts.
6. **Stacked imbalance count**: 3 consecutive prices (recommended) vs 4. 3 matches RA-046's existing sweep pattern.
7. **vDelta sign-flip cooldown**: emit event only if signed CVD reverses for ≥10 seconds (avoid noise flapping). Recommend 10-sec hysteresis.
8. **Display formatting**: format with separators (e.g., "139.18") matching bookmap convention vs raw integers. Recommend separators for readability.
9. **Anything surfaced reading existing orderflow_pulse code** — especially how `session_cvd` is currently computed (avoid duplication).

Surface as single message. Wait for green-light before coding.

### Out of scope

- Live aggressor microstructure analytics (e.g., sub-second flow toxicity) — research-grade, defer
- Order book heatmap visualization rendering (canvas/WebGL) — RA-062
- Multi-symbol correlation of aggressor metrics — multi-symbol scope
- Predictive flow modeling (ML) — separate ticket

### Relationship to RA-046, RA-047, RA-049, RA-050, RA-059

- Reuses RA-046's bounded-tail-read pattern for trade input
- Distinct from RA-046's `session_cvd` (which accumulates from session open) — windowed metrics show momentum NOW
- vDelta is a shorter-window CVD complementing RA-046's longer-window values
- Footprint aggregation distinct from RA-049's institutional_flow concentration (footprint is per-price stats; institutional_flow is per-zone)
- RA-050 integration via `"aggressor_flow"` family — events visible in Recent Signals panel
- Together with RA-059 (iceberg detector), provides 95% of bookmap's trading-relevant signals

### Dispatch protocol

Per established discipline:
1. Executor's first response: pre-build sweep (9 ambiguity points + plan paragraph + per-phase time estimates)
2. Wait for green-light before writing source
3. Critical invariants:
   - RA-052 memory contract (< 2GB peak on light path)
   - RA-050 schema-extensibility contract (events flow without renderer changes)
   - Existing `session_cvd` semantics unchanged (RA-058 metrics are ADDITIVE, not replacing)

---

## RA-053 · Adaptive σ via EWMA + databento corpus calibration (day-trading framework)
**Priority**: P1
**Estimate**: 4-6 hours
**Dependencies**: RA-052 (incremental normalize + light-path memory contract), databento corpus at `D:\qfa-cache\databento\` + `D:\Quant-futures-app\data\databento\sim03_corpus\`
**Context shift**: User has committed to day-trading discipline (no overnight holds). Multi-day σ frameworks become contextual; intraday σ becomes primary. Empirical calibration replaces heuristic regime multipliers (the manual `×1.7` / `×2.0` adjustments applied on 2026-05-27 and 2026-05-28).

**Description**: Replace the heuristic regime σ multiplier with an empirically-calibrated EWMA (exponentially weighted moving average) volatility estimator trained on a 96-session databento corpus. Output is a per-session `σ_effective` that auto-adapts to current volatility regime without manual intervention. Feeds the σ-band framework computations, the probability adjuster's distance multipliers, and the Distance Grid zone widths.

This is the foundation for day-trading-suitable signal generation. Subsequent tickets (RA-055 day-type calibration, RA-056 IB extension priors) consume RA-053's EWMA σ output.

**Project**: `tools/rithmic_analytics/` (calibration CLI + corpus loader) + `tools/rithmic_dashboard/` (live consumer).

### Background — why this is needed

Through 2026-05-26 to 2026-05-28, the σ-band framework failed twice as regime shifts blew through the assumed ±3σ bounds:

- 5/27 daily range: 504pt vs 89pt session σ = **5.7σ event** (statistically should occur once per ~10,000 days)
- 5/28 daily range: 587pt vs 174pt regime-adjusted σ = **3.37σ event** (still beyond ±3σ)

Manual recalibration applied: `σ × 1.7` then `× 2.0`. Both reactive and ad-hoc. This ticket replaces reactive multipliers with predictive EWMA estimation that adapts automatically.

The 96-session databento corpus provides:
- Per-session realized volatility distribution (statistical baseline)
- Validation set for EWMA decay parameter (`λ`) optimization
- Empirical regime distribution (what % of sessions are HIGH-vol historically)

### Phase 1: Databento corpus loader + per-session σ aggregates

New module `rithmic_analytics/data_loader/databento_loader.py`:

- Reads `.dbn.zst` files (using `databento` Python package — confirm pin in `pyproject.toml`)
- Per session, computes:
  - **Realized session σ via Parkinson estimator** (uses high/low; more robust for trending sessions than close-to-close):
    ```
    σ_P = (1 / (4 × ln(2))) × √(mean[(ln(H/L))²])
    ```
  - **Session VWAP** (volume-weighted)
  - **Session range** (H−L in points)
  - **Session VPOC, VAH, VAL** (volume profile via existing `compute_vp` adapter)
  - **Bar count, total volume, time-of-day activity profile**
- Output: `data/calibration_corpus/per_session_stats.parquet` (one row per session, ~96 rows)
- Schema: `session_date, symbol, vwap, sigma_parkinson, range_pts, vpoc, vah, val, total_volume, bar_count, ib_high, ib_low, ib_range`

Must respect RA-052's memory contract: streaming reads, not full-load to RAM. Budget: < 2GB peak even on largest sessions in corpus.

### Phase 2: EWMA decay calibration CLI

New module `rithmic_analytics/cli/calibrate_ewma.py`:

- Loads `per_session_stats.parquet` from Phase 1
- Sweeps decay parameter `λ ∈ [0.85, 0.99]` in 0.01 steps (15 candidates)
- For each `λ`, computes RMSE of predicted σ_next vs realized σ_next using walk-forward validation:
  ```
  σ²_t = λ × σ²_{t-1} + (1 − λ) × σ²_realized_{t-1}
  prediction_error = (σ_predicted_t − σ_realized_t)²
  ```
- Train/validation split: first 80% sessions train, last 20% validate (walk-forward, NOT random)
- Output: `data/calibration_corpus/ewma_decay.json`:
  ```json
  {
    "symbol": "MNQ",
    "lambda_optimal": 0.94,
    "rmse_train": 12.3,
    "rmse_validation": 14.7,
    "calibrated_at": "2026-05-28T...",
    "sessions_used": 96,
    "validation_split": 0.2,
    "candidates": [{"lambda": 0.85, "rmse_val": 18.2}, ...]
  }
  ```
- Atomic write. Idempotent (re-running on same corpus produces same `λ`).
- Exit non-zero if corpus has < 30 sessions (insufficient data).

### Phase 3: EWMA σ integration into live signals

Extend `rithmic_dashboard/features/live_signals.py`:

- Load `ewma_decay.json` at startup; cache `λ` value
- Maintain rolling EWMA σ state in session-state JSON (per session)
- On each 5-min dashboard tick:
  ```
  σ²_t = λ × σ²_{t-1} + (1 − λ) × σ²_observed_15min
  ```
- Cold-start: when no prior σ history (first tick of session), bootstrap from corpus median σ
- Persist `ewma_sigma_current` in session-state JSON
- Expose via dashboard API for downstream consumers

### Phase 4: Vol regime classifier (heuristic, NOT HMM)

New module `rithmic_dashboard/features/vol_regime_classifier.py`:

- Three-state classifier based on EWMA σ vs corpus median:
  - **LOW**: EWMA σ < 0.7 × corpus_median_σ
  - **NORMAL**: 0.7 × ≤ EWMA σ ≤ 1.3 × corpus_median_σ
  - **HIGH**: EWMA σ > 1.3 × corpus_median_σ
- Returns: `(regime_name, regime_factor)` where `regime_factor ∈ [1.0, 1.3, 1.6]` for LOW/NORMAL/HIGH
- `σ_effective = EWMA σ × regime_factor`
- This is heuristic — HMM regime detection deferred to a future regime-model ticket once 30+ session calibration corpus accumulates from live sessions

### Phase 5: Dashboard rendering + zone framework update

Extend `rithmic_dashboard/features/orderflow_pulse.py`:

- New subsection "Volatility regime":
  - Current EWMA σ (in points)
  - Current regime (LOW / NORMAL / HIGH) with color coding
  - σ_effective (used for zone widths)
  - Corpus median σ (for context)
  - Calibration version (which `λ` is in use)

Extend `rithmic_dashboard/features/distance_grid.py` (or zone-renderer):

- Zone widths auto-recompute using `σ_effective` instead of fixed session σ
- Display zone labels with current σ value: e.g., "W+2σ PRIMARY SHORT 30,358-30,374 (EWMA σ=204, regime HIGH)"
- When regime transitions (e.g., NORMAL → HIGH), emit audit event `vol_regime_changed`

Update `rithmic_dashboard/features/posture_synthesis.py`:

- Active Posture sentence includes regime context: "Volatility regime: HIGH (σ_effective 204pt, 1.6× corpus median). Zone widths scaled accordingly."

### Files to create/modify

- `rithmic_analytics/data_loader/databento_loader.py` — NEW (~200 LOC)
- `rithmic_analytics/cli/calibrate_ewma.py` — NEW (~150 LOC)
- `rithmic_dashboard/features/ewma_volatility.py` — NEW (~120 LOC)
- `rithmic_dashboard/features/vol_regime_classifier.py` — NEW (~80 LOC)
- `rithmic_dashboard/features/live_signals.py` — extend with EWMA hook
- `rithmic_dashboard/features/orderflow_pulse.py` — add regime subsection
- `rithmic_dashboard/features/posture_synthesis.py` — include regime context
- `rithmic_dashboard/features/distance_grid.py` (or equivalent) — auto-recompute zone widths
- `rithmic_dashboard/cli/generate.py` — wire EWMA into main flow
- `tests/test_databento_loader.py` — synthetic .dbn.zst fixture + Parkinson math validation
- `tests/test_calibrate_ewma.py` — known-output calibration (deterministic on fixed corpus)
- `tests/test_ewma_volatility.py` — rolling state correctness + cold-start
- `tests/test_vol_regime_classifier.py` — boundary cases (LOW/NORMAL/HIGH transitions)
- `tests/test_regime_change_audit.py` — verify audit event fires on transition
- `docs/feature_reference.md` — EWMA + regime sections
- `docs/operations.md` — calibration cadence, when to rerun CLI
- `docs/ewma_calibration_methodology.md` — NEW DOC explaining the math + λ choice

### Acceptance criteria

- Databento loader processes all 96 corpus sessions without error
- `calibrate_ewma.py` produces `λ` value with documented RMSE on validation set (target: validation RMSE within 20% of training RMSE — overfitting check)
- EWMA σ in live signals updates correctly: synthetic test with known input sequence produces expected EWMA trajectory
- Vol regime classifier correctly classifies 2026-05-28 session (current high-vol) as HIGH and a quiet baseline session as NORMAL when fed real data
- σ_effective replaces manual `×1.7` / `×2.0` adjustments — framework auto-adjusts on regime shifts
- `vol_regime_changed` audit event fires when regime transitions
- Dashboard shows EWMA σ + regime in Orderflow Pulse subsection
- Active Posture sentence includes regime context
- Memory: light path peak RSS stays < 2GB (RA-052 contract)
- Tests: ~20 new test cases; ruff + mypy clean
- Visual smoke: dashboard renders with regime "HIGH" displayed against 5/28 data fixture

### Pre-build sweep expectation

Per established discipline, surface ambiguity before coding. At minimum:

1. **EWMA calibration metric**: RMSE (recommended) vs MAE vs cross-entropy. RMSE penalizes large errors more — appropriate for vol prediction.
2. **Validation split**: walk-forward 80/20 (recommended) vs random k-fold. Walk-forward respects temporal ordering and prevents leak.
3. **Regime threshold values**: 0.7× and 1.3× corpus median (recommended) vs percentile-based (e.g., bottom 25% and top 25%). The ratio approach is more interpretable.
4. **Corpus loader memory**: stream per session (recommended) vs load all in pandas. Streaming respects RA-052 contract.
5. **Use both qfa-cache + Quant-futures-app corpora**: yes — combine for max calibration corpus. Treat as single 96-session set.
6. **Cold-start when no prior EWMA**: use corpus median σ (recommended) vs use first observed 15-min σ. Corpus median is stable.
7. **EWMA window**: 15-minute (recommended — matches dashboard tick cadence) vs 5-minute vs 60-minute. 15-min balances responsiveness and noise.
8. **Recalibration cadence**: monthly (recommended) vs weekly. λ should be stable over months given the 96-session base.
9. **Anything else surfaced when reading the databento package docs + `.dbn.zst` schema** (especially: trade vs MBO record structure for Parkinson σ).

Surface as single message. Wait for green-light before coding.

### Out of scope

- HMM regime detection (deferred to a future regime-model ticket)
- Multi-symbol calibration (MNQ only for v1; ES/RTY/YM would each need their own corpus pass)
- Real-time streaming databento ingestion (RA-053 uses cached corpus only)
- Backtesting framework (RA-060 territory)
- Changes to existing rithmic capture pipeline

### Relationship to other tickets

- **RA-052 (shipped)** — established the < 2GB memory contract for intraday loops. RA-053 must respect this.
- **RA-051 (queued)** — day-type classification. After RA-053 ships, RA-055 (corpus-calibrated day-type priors) can leverage both the corpus and EWMA σ to assign empirical probability priors per day type. Recommend dispatching RA-053 before RA-051 build.
- **RA-046 (shipped)** — calibration log machinery. Once RA-053 has been running for 30+ live sessions, the EWMA decay can be re-optimized using the calibration log. That's a future RA-053.1 / RA-060 territory.
- **Future HMM regime-model ticket** — full HMM regime model. Builds on RA-053's EWMA estimate as an observation input.

### Dispatch protocol

Per established discipline:

1. Executor's first response: pre-build sweep (9 ambiguity points + plan paragraph + per-phase time estimates)
2. Wait for green-light before writing source
3. Critical invariants to preserve:
   - RA-052 memory contract (< 2GB on light path)
   - Existing `_state.json` schema compatible (additive only)
   - Audit event schema unchanged (only new event types added)

When dispatched, this is the foundation for day-trading-suitable signal generation. Subsequent tickets (RA-055, RA-056) depend on its outputs.

---

## RA-052 · Intraday-light vs EOD-heavy analytics split + incremental normalize
**Priority**: P1
**Estimate**: 4-6 hours
**Dependencies**: None blocking; refactors existing CLI surface for `daily_zones` + `normalize_probe`
**Stopgap status**: Manual stopgap applied 2026-05-27 via `run_local_probe_refresh.ps1` `-EmitHeavyAnalytics` opt-in switch. This ticket formalizes the architecture, adds regression guards, and ships the incremental normalize phase.

**Description**: Operational crisis surfaced 2026-05-27 — the 5-min intraday refresh loop was invoking `daily_zones --emit-pressure-json --emit-cancellation-analysis` against a live-extending 21.7GB RTH capture, causing 40GB peak Python process memory (PID 6472) and degrading the trading machine. Root cause: 5-min loop calling heavyweight full-MBO scan that should only run EOD.

This ticket splits the analytics refresh into two operational tiers (intraday-light vs EOD-heavy), adds a memory regression guard, and ships an incremental normalize that avoids re-scanning the full obs01 file every 5 minutes.

**Project**: `tools/rithmic_analytics/` (CLI + ops scripts), with consumer-side dashboard validation in `tools/rithmic_dashboard/`.

### Background — what the stopgap fixed

Stopgap committed 2026-05-27:
- `run_local_probe_refresh.ps1` patched with explicit opt-in `-EmitHeavyAnalytics` switch
- Without the switch (default for 5-min loop): runs `daily_zones --emit-absorption-json --emit-probability-card --adaptive-bins` (light)
- With the switch (EOD only): adds `--emit-pressure-json --emit-cancellation-analysis` (heavy MBO scan)
- Memory immediately dropped from 40GB peak to ~2-3GB on light path
- Dashboard refresh loop restarted (PID 27272) under patched script

This stopgap MUST be preserved by RA-052. The new code must default to the light path.

### Phase 1: Codify intraday-light command + EOD-heavy command

Refactor `rithmic_analytics/cli/daily_zones.py` to introduce two explicit invocation patterns:

**`daily_zones-light`** (intraday — designed to run every 5 min):
- Reads existing volume profile zones if recent (< 60 min old)
- If stale, recomputes VP from latest normalized obs01 tail (bounded read)
- Always emits: `--emit-absorption-json` (cheap, obs01-based), `--emit-probability-card` (consumer-readable summary), `--adaptive-bins`
- **NEVER** invokes `--emit-pressure-json` or `--emit-cancellation-analysis` regardless of flags
- Memory budget: < 2GB peak even with 25GB+ capture files
- Runtime budget: < 30 seconds

**`daily_zones-full`** (EOD or hourly opt-in):
- Full MBO order-lifecycle scan
- Emits everything: pressure_json, cancellation_analysis, full VP recompute, session_combined for next-day prep
- Memory budget: < 30GB peak (still constrained — see Phase 3)
- Runtime budget: < 10 minutes
- Intended for: EOD post-RTH-close run + optional hourly opt-in

Add a single `cli/daily_zones.py` with `--mode light|full` flag OR introduce two explicit CLI modules. Recommend the `--mode` approach for backward compatibility — existing callers using `--emit-pressure-json` get the full path; new callers using `--mode light` get the bounded path.

The PowerShell script `-EmitHeavyAnalytics` switch should map directly to `--mode full` in the Python CLI.

### Phase 2: Add EOD-heavy scheduler entry + canonical schedule

Operational change — codify the cron/Task Scheduler configuration:

**Intraday loop** (already running, keep as-is):
- `run_local_probe_refresh.ps1` (no switches)
- Cadence: every 5 minutes during active session
- Invokes: `daily_zones --mode light`

**NEW: EOD heavy run**:
- New script `run_eod_full_analytics.ps1`
- Cadence: once at 13:15 PT (15 min after RTH close to allow capture quiescence)
- Invokes: `daily_zones --mode full --symbol MNQ --session rth`
- Then runs `session_combined` for next-day prep
- Documented in `docs/operations.md`

**Optional hourly opt-in** (defer, don't add yet):
- Could run `--mode full` on RTH hour boundaries IF a future analysis needs intra-session pressure data
- Out of scope for v1 — document as available pattern

### Phase 3: Memory regression guard

This is the load-bearing meta-requirement. Without a regression test, this problem recurs the next time someone adds an expensive flag to the intraday call.

Add `tests/test_intraday_memory_guard.py`:
- Synthetic fixture: generate a 5GB obs01.jsonl + 5GB MBO file (smaller than today's 21GB to keep CI feasible, but enough to expose memory blowup)
- Run `daily_zones --mode light` in a subprocess
- Measure peak RSS via `psutil` or `resource.getrusage`
- **Assert peak RSS < 2GB**
- Run `daily_zones --mode full` against same fixture
- Assert peak RSS < 8GB (scales with input size; this is a regression-only guard, not absolute ceiling)

Bonus: integrate into CI such that any future PR adding work to the light path that pushes peak > 2GB blocks merge.

### Phase 4: Incremental normalize

Current pain: `normalize_probe` re-scans the full raw `.jsonl` every 5 min. As today proved, this becomes prohibitive at 21GB+ files.

Add `rithmic_analytics/cli/normalize_probe_incremental.py`:
- Tracks last-normalized byte offset in `<capture>.obs01.normalize_state.json`
- On next invocation, opens raw `.jsonl` at last offset and continues normalizing from there
- Appends new records to `.obs01.jsonl`
- Atomic-update state file on success
- Falls back to full normalize if state file missing/corrupt (with audit log of fallback)

State file schema:
```json
{
  "source_file": "data/captures/2026-05-27/MNQ_rth.jsonl",
  "last_byte_offset": 19384721829,
  "last_record_ts_ns": 1779898500000000000,
  "last_normalized_at": "2026-05-27T08:45:12-07:00",
  "schema_version": 1
}
```

Wire into the intraday loop:
- `run_local_probe_refresh.ps1` calls `normalize_probe_incremental` instead of `normalize_probe`
- EOD heavy run uses full `normalize_probe` (sanity-check rebuild)

Memory impact: incremental normalize peak RSS scales with the new-data-only span (typically < 100MB per 5-min window vs ~5GB+ for full re-scan).

### Phase 5: Documentation + ops runbook

Update `docs/operations.md`:
- Two operational tiers: intraday-light (every 5 min) vs EOD-heavy (once at 13:15 PT)
- When to run each manually
- Memory expectations + monitoring guidance
- How to detect when the intraday loop is being mis-invoked (audit log markers)

Create `docs/incident_5_27_memory_blowup.md`:
- Post-mortem of the 40GB Python process incident
- Root cause: 5-min loop with `--emit-pressure-json` on 21GB file
- Stopgap applied via `-EmitHeavyAnalytics` switch
- Permanent fix: this ticket (RA-052)
- Lesson for future tickets: any new CLI flag that scans full MBO must be gated to EOD-only

### Files to create/modify

- `rithmic_analytics/cli/daily_zones.py` — add `--mode light|full` flag with hard guards
- `rithmic_analytics/cli/normalize_probe_incremental.py` — new module (~200 LOC)
- `rithmic_analytics/cli/normalize_probe.py` — unchanged, used for EOD sanity rebuild only
- `tools/rithmic_dashboard/scripts/run_local_probe_refresh.ps1` — call `--mode light` explicitly + `normalize_probe_incremental`
- `tools/rithmic_dashboard/scripts/run_eod_full_analytics.ps1` — NEW
- `tests/test_intraday_memory_guard.py` — NEW memory regression
- `tests/test_normalize_incremental.py` — NEW (correctness + state-file round-trip)
- `tests/test_daily_zones_mode_guard.py` — NEW (assert `--mode light` rejects pressure-json flag, or silently ignores with warning)
- `docs/operations.md` — update with two-tier ops model
- `docs/incident_5_27_memory_blowup.md` — NEW post-mortem
- `docs/feature_reference.md` — document incremental normalize + mode flag

### Acceptance criteria

- `daily_zones --mode light` against today's 25GB RTH capture: peak RSS < 2GB, runtime < 30s
- `daily_zones --mode full` against same: peak RSS < 30GB (today's actual was 40GB; this is a meaningful reduction)
- `normalize_probe_incremental` correctly resumes from saved offset: synthetic test with 1GB initial + 100MB append produces same obs01 output as full re-normalize
- Memory regression test in CI passes (synthetic 5GB fixture, light mode < 2GB)
- `run_local_probe_refresh.ps1` confirms light path by default + heavy path only with `-EmitHeavyAnalytics`
- New EOD script `run_eod_full_analytics.ps1` runs successfully against today's full capture
- All existing tests still pass; ruff + mypy clean
- 5-min refresh loop running for 2+ hours after deploy with peak memory < 2GB across all invocations
- Operations runbook + post-mortem published

### Pre-build sweep expectation

Per established discipline (RA-040 through RA-051), do a pre-build sweep BEFORE writing source. Surface 7 ambiguity points minimum:

1. **`--mode light|full` flag vs separate CLI modules**: single flag (recommended for backward compat) or two distinct modules (cleaner separation)?
2. **State-file location for incremental normalize**: alongside obs01.jsonl (recommended) or in a separate `data/normalize_state/` directory?
3. **Fallback behavior when state file missing**: full re-normalize with warning, OR refuse and require explicit `--full` flag (safer)?
4. **Memory ceiling for `--mode light`**: 2GB recommended; could be 1GB if we want tighter, but risks false positives on growing captures.
5. **EOD scheduler trigger**: cron-style fixed time (13:15 PT) vs file-watcher (when capture file stops growing for N minutes) — recommend fixed time for simplicity.
6. **Pressure-json/cancellation-analysis behavior in `--mode light`**: hard-reject with error message OR silently ignore with warning? Recommend hard-reject — silent ignoring is what caused the incident.
7. **Backward compatibility for existing scripts**: scripts currently calling `daily_zones --emit-pressure-json` should still work (route to `--mode full` implicitly) OR be updated to use new flags. Recommend implicit routing with deprecation warning.
8. Anything surfaced when reading current `daily_zones.py` + `normalize_probe.py` code.

### Out of scope

- Real-time streaming normalization (would require capture script change, much bigger scope)
- Distributed processing / sharding for multi-symbol expansion
- Changing the MBO scan algorithm itself to be memory-efficient (separate research-grade ticket)
- Migrating from pandas to polars/arrow for memory efficiency (big rewrite, defer)
- New analytics features

### Relationship to RA-046, RA-047, RA-049, RA-051

- **RA-046/047/049 (shipped)**: their live_signals computations use bounded-tail obs01 reads — already memory-light. Unaffected by RA-052 directly.
- **RA-051 (queued)**: day-type classification reads OHLCV + IB. Light. No memory impact. Should be tested in CI with the new memory guard once shipped.
- **Critical**: any FUTURE ticket that adds a new flag to `daily_zones` MUST verify whether it belongs in `--mode light` or `--mode full`. The hard-reject guard from Pick #6 enforces this at runtime; the docs should make it explicit.

### Dispatch protocol

Per established discipline:
1. Executor's first response: pre-build sweep (8 points above) + plan paragraph + per-phase time estimates
2. Wait for green-light before writing source
3. Critical: confirm the stopgap (`-EmitHeavyAnalytics` switch in `run_local_probe_refresh.ps1`) is NOT broken by the refactor — it should still work but route through the new code path.

This ticket has immediate operational value (formalizes the stopgap) and structural value (incremental normalize unblocks scaling beyond current capture sizes). Recommend dispatch when ready — no blocking dependencies.

---

## RA-051 · Day-type classification (auction market theory)
**Priority**: P1
**Estimate**: 4-6 hours
**Dependencies**: RA-031 (VWAP±σ + VPOC infrastructure), RA-046 (live signal infrastructure)

**Description**: Currently the dashboard treats every session the same — same scenario priors, same probability multipliers. In reality, **the character of the day** materially affects which setups have edge. Auction Market Theory classifies days into 5 types (trend day, normal day, normal variation, neutral day, double distribution), each with distinct trade probabilities:

- **Trend day**: fading either extreme is suicide; trend-follow only
- **Normal day**: IB extremes are high-probability fades
- **Neutral day**: mean-reversion to mid works
- **Double distribution**: trade between distributions, fade extremes
- **Normal variation**: 1× IB extensions are reaction levels

This ticket auto-classifies the day within first 90min of RTH and conditions scenario probabilities on day type.

**Project**: `tools/rithmic_dashboard/` (extend existing).

### Phase 1: IB computation + day-type classifier

New module `features/day_type_classifier.py`. Per session:

1. **Compute IB** (Initial Balance): first 60 min of RTH (06:30-07:30 PT for MNQ). Track high, low, range, midpoint.

2. **Wait for classification window**: at 90 min into RTH (08:00 PT), evaluate.

3. **Classify per Steidlmayer rules**:

| Type | Rule | Frequency |
|---|---|---|
| **Trend day (up)** | RTH open within 10pt of session low; price ≥ 1.5× IB range above IB high | 5-8% |
| **Trend day (down)** | RTH open within 10pt of session high; price ≤ 1.5× IB range below IB low | 5-8% |
| **Double distribution (up)** | Strong move up after IB, NEW value area forms above (not contiguous with IB) | 3-5% |
| **Double distribution (down)** | Same direction down | 3-5% |
| **Neutral day (extreme)** | Price extends both sides of IB AND closes near extreme | 3-5% |
| **Neutral day (center)** | Price extends both sides of IB AND closes near IB midpoint | 7-10% |
| **Normal variation (up)** | Extends 0.5×-1.5× IB above, doesn't extend below | 10-15% |
| **Normal variation (down)** | Same direction down | 10-15% |
| **Normal day** | Holds entirely in IB range OR extends < 0.5× IB either side | 30-40% |
| **Other / pre-classification** | Before 90 min of RTH | n/a |

Output: `DayType(name, ib_high, ib_low, ib_range, ib_extension_pts, classification_confidence)`.

Persist to `data/live_analysis/<date>_<session>_day_type.json`.

### Phase 2: Day-type-conditioned probability multipliers

Extend `probability_adjuster.py` with:

| Day type | Long-bias scenarios | Short-bias scenarios | Mean-reversion at extremes |
|---|---|---|---|
| Trend day (up) | +25% | -30% | -40% (don't fade trends) |
| Trend day (down) | -30% | +25% | -40% |
| Normal day | +5% | +5% | +20% (fades work well) |
| Normal variation (up) | +15% | -10% | +10% at IB extension |
| Normal variation (down) | -10% | +15% | +10% at IB extension |
| Neutral day (extreme) | -5% | -5% | -10% |
| Neutral day (center) | -10% | -10% | +30% (textbook mean-reversion) |
| Double distribution (up) | +20% | -10% | +15% between distributions |
| Double distribution (down) | -10% | +20% | +15% |

Multiplier name format: `day_type_<type>_<bias>` (e.g., `day_type_trend_up_long: +25%`).

Compose additively with existing multipliers, [0.4, 1.6] cap.

### Phase 3: IB-break scenario types

Add 2 new scenarios per session:

**Scenario IB-Long**: triggered when price breaks IB high after classification window
- Entry: IB high + 5pt buffer
- T1: IB high + 0.5×IB range
- T2: IB high + 1.0×IB range (statistical extension target)
- T3: IB high + 1.5×IB range (rare, normal-variation cap)
- Stop: IB midpoint
- Base probability: 55% (auction-theory prior); modified by day-type

**Scenario IB-Short**: mirror for IB low break.

Both scenarios populate the standard `_scenarios.json` state machine and follow the existing WATCHING → ACTIVE → IN_PROGRESS → COMPLETED transitions.

### Phase 4: Renderer + audit trail

**Active Posture**: add day-type sentence as first sentence when classified.
- E.g., "Day type: NORMAL VARIATION (UP) — IB 30,005-30,072, currently extended +45pt above IB high (~0.6× IB range). Long-continuation scenarios up-weighted +15%, fade scenarios down-weighted -10%."

**New top-of-Distance-Grid card**: "Today's Day Type" with:
- Type name (e.g., "TREND DAY (UP)")
- IB range (e.g., "29,675 - 29,902")
- Current extension from IB (in points AND IB-range multiples)
- Classification confidence (high / medium / low)
- Classification timestamp

**Audit trail event types**:
- `day_type_classified` — at 08:00 PT (or whenever classification triggers)
- `ib_high_break` / `ib_low_break` — when IB is broken
- `ib_extension_reached` — at 0.5× / 1× / 1.5× IB extensions
- `day_type_revised` — if classification changes due to mid-session pattern shift

### Phase 5: Calibration log integration

Per session at close, log:
- Classified day type
- Actual range (vs predicted by day type prior)
- Did the day-type-based multipliers correctly skew probabilities?
- For each completed scenario, was day-type multiplier applied + outcome

Persist to `data/live_analysis/day_type_outcomes.jsonl`. After 30+ sessions, RA-046's calibration machinery can compute realized vs predicted win-rates per day type.

### Files to create/modify

- `rithmic_dashboard/features/day_type_classifier.py` — new (~250 LOC)
- `rithmic_dashboard/features/ib_scenarios.py` — new (~150 LOC)
- `rithmic_dashboard/features/probability_adjuster.py` — extend with day-type multipliers
- `rithmic_dashboard/features/posture_synthesis.py` — incorporate day-type sentence
- `rithmic_dashboard/features/scenarios.py` — add IB-Long, IB-Short scenarios
- `rithmic_dashboard/features/audit_trail.py` — new event types
- `rithmic_dashboard/cli/generate.py` — wire day-type classifier into main flow
- `rithmic_dashboard/templates/dashboard.html.j2` — render day-type card
- `tests/test_day_type_classifier.py` — synthetic IB + extension scenarios for all 10 types
- `tests/test_ib_scenarios.py` — IB-break trigger + extension targets
- `tests/test_day_type_multipliers.py` — multiplier application per day type
- `tests/test_day_type_revision.py` — re-classification when pattern shifts mid-session
- `docs/feature_reference.md` — day-type section
- `docs/operations.md` — how to read day-type, classification reliability
- `docs/auction_market_theory_primer.md` — NEW DOC with the 10 types + rules

### Acceptance criteria

- Classifier correctly identifies all 10 day types on synthetic IB + extension scenarios
- IB computation matches manual calculation for 5/26 RTH (IB high ≈ 29,935, IB low ≈ 29,826, range ≈ 109pt)
- Day-type-conditioned multipliers apply correctly: e.g., on synthetic trend-up day, long scenarios get +25%, short get -30%, fade-mean-reversion gets -40%
- IB-Long and IB-Short scenarios correctly enter WATCHING state at 08:00 PT, transition to ACTIVE on IB break, COMPLETED at T1
- Active Posture sentence correctly references day type with current extension data
- Day-Type card in Distance Grid renders with all fields populated
- Tests: ~20 new test cases; ruff + mypy clean
- Visual smoke: dashboard renders day-type card against today's data (or synthetic trend-day fixture)

### Pre-build sweep expectation

1. **Classification window**: 90 min into RTH (recommended). Earlier (60 min = end of IB) is more responsive but lower confidence. Later (120 min) is more accurate but late for trade decisions.
2. **Trend day threshold**: 1.5× IB extension as default. Could be tighter (1.3×) or looser (1.7×). Affects how often trend day classifies.
3. **Re-classification frequency**: every 15min after initial classification, vs locked-at-90min. Recommend every 15min with `day_type_revised` event when changes (rare).
4. **Multiplier magnitudes**: starting heuristic values (table above). Calibration data will refine. Start conservative.
5. **IB-break scenarios**: as separate scenarios with own state vs as modifiers to existing scenarios? Recommend separate scenarios for clean attribution.
6. **Holiday / partial-session handling**: Memorial Day half-session (5/25) had different RTH hours. Classification rules assume normal 6.5h RTH session. Add `partial_session: bool` flag and skip classification if true (with audit event explaining).
7. Anything surfaced when reading the scenarios.py code.

### Out of scope

- Pre-RTH day-type prediction (research-grade, would need overnight pattern → day type model)
- Cross-day comparison (e.g., "today is most similar to 5/22 RTH which was a trend day")
- Multi-symbol day-type correlation (defer; MNQ is testbed)
- Historical backtest of day-type win-rates (will emerge from calibration log over time)

### Relationship to RA-046, RA-047, RA-049, RA-050

- Uses RA-046's session-state infrastructure for tracking IB development
- Multipliers compose additively with RA-046/047/049 multipliers (test co-firing extensively)
- Day-type classification events appear in RA-050's Recent Signals panel
- Day-type provides CONTEXTUAL conditioning on top of per-event signals (sweep at level on a trend day is read differently than same sweep on a normal day)

### Dispatch protocol

Pre-build sweep first (7 points above + anything from code reading), then green-light, then phases 1-5 sequentially. Per discipline, no source until green-lit.

This is the largest of the three new tickets (RA-049, 050, 051). Recommend building order: RA-050 first (UI upgrade — quick visual win), RA-049 second (institutional flow extends RA-046 signals), RA-051 third (day-type integrates everything).

---

## RA-047 · Delta dislocation detector (absorption-at-key-level pattern)
**Priority**: P1
**Estimate**: 3-4 hours
**Dependencies**: RA-046 (live CVD per-window infrastructure + multiplier framework)

**Description**: Operationalize the "positive delta dislocation at key level" pattern as a standalone detector + probability multiplier. The pattern is a textbook absorption signal — price moves one direction on a candle, but cumulative delta moves the opposite direction, indicating aggressive participation against the price move. At a drawn key level (zones from the standing ±σ zone convention or any HVN/VPOC/flip zone), this is a high-conviction reversal setup.

Trader's setup card (the operational definition):

**Long-side dislocation (all 4 required):**
1. Price is currently at or just beyond a key level (drawn zone — D/W σ band, VPOC, flip, DEEP DEMAND, etc.)
2. The last 1-hour candle close is negative (red — price went down on the hour)
3. Volume delta on that hour is positive (aggressive buyers stepping in)
4. Delta magnitude ≥ calibrated threshold (see § Threshold calibration)

→ Fire `DeltaDislocationLong` event.

**Short-side dislocation (mirror):**
1. Price is currently at or just beyond a key supply level
2. Last 1-hour candle close is positive (green)
3. Volume delta on that hour is negative
4. |Delta| ≥ calibrated threshold

→ Fire `DeltaDislocationShort` event.

The pattern is generic; what makes it actionable is the **at a key level** filter. Random candle/delta divergence in the middle of a chop range is noise. The same divergence at a multi-method confluence zone is a real liquidity event.

**Project**: `tools/rithmic_dashboard/` (extend existing).

### Phase 1: Detector module

New module `features/delta_dislocation.py`. Inputs:

- Latest 1-hour candle (close direction) — derive from live capture's last 60min of trades
- Hourly CVD (signed volume sum over that 60min window) — already computed in RA-046's `live_signals.py`
- Current price (live capture's last LAST_TRADE)
- Set of drawn key levels (from chart state file OR from dashboard's `_state.json` confluence levels)

Per 15-min dashboard tick:
1. Reconstruct most-recent completed 1-hour candle (or use rolling 60min window)
2. Compute candle direction: `(close - open) > 0` → positive
3. Compute hourly CVD: sum of signed volume in the 60min window
4. Check current price proximity to nearest key level: `abs(current_price - level) ≤ proximity_threshold` (suggest 0.5 × ATR_14 ≈ 14pt for MNQ)
5. If proximity met AND candle direction opposes CVD direction AND |CVD| ≥ threshold:
   - Long-side: red candle + bullish CVD + at demand zone → `DeltaDislocationLong`
   - Short-side: green candle + bearish CVD + at supply zone → `DeltaDislocationShort`

Emit `DislocationEvent(timestamp, side, level_id, candle_direction, hourly_cvd, threshold_used, proximity_pts, confidence)`.

Persist to `data/live_analysis/<date>_<session>_dislocations.jsonl`.

### Phase 2: Threshold calibration

**Don't hardcode the threshold** — calibrate per symbol/session from historical data:

- Compute the **median hourly |CVD|** over the last N=20 completed sessions for the symbol (from existing obs01 captures)
- Threshold = `1.5 × median_hourly_abs_cvd` (default coefficient, configurable via `threshold_multiplier` setting)
- Recompute weekly (cron or on-demand) and persist to `data/live_analysis/dislocation_thresholds.json`

Schema:
```json
{
  "MNQ": {
    "computed_at": "2026-05-22T...",
    "median_hourly_abs_cvd": 365,
    "threshold_multiplier": 1.5,
    "threshold": 547,
    "sessions_used": 20
  }
}
```

Rationale: in low-volatility regimes, 365 Δ/hour is the run-rate; +500 dislocation is meaningful. In high-volatility regimes, run-rate might be 1,200 Δ/hour; +500 is noise. Calibrated threshold prevents both false positives (over-firing in vol) and false negatives (under-firing in quiet).

The trader's card's "Δ ≥ +500" was author-and-symbol-specific; for MNQ it happens to be near our 5/22 calibration (547), which is reassuring but coincidental.

### Phase 3: Probability multiplier integration

Extend RA-046's `probability_adjuster.py` with:

| Multiplier | Trigger | Effect | Rationale |
|---|---|---|---|
| `delta_dislocation_at_entry` | DeltaDislocation event at scenario's entry zone in last 60min | +25% | Absorption at level is highest-quality intraday confluence signal |
| `delta_dislocation_at_entry_strong` | Above AND |CVD| ≥ 2.5 × threshold | +35% (replaces +25%) | Very strong absorption — institutional participation |

These compose additively with other multipliers per RA-046 spec, still bounded by [0.4, 1.6] cap.

### Phase 4: Renderer + audit trail

**Orderflow Pulse section**: add subsection "Recent dislocations (last 60min)" — list of events with side / level name / CVD magnitude.

**Audit trail event types**:
- `delta_dislocation_long_detected` — at level X, CVD=Δ, candle direction
- `delta_dislocation_short_detected` — at level X, CVD=Δ, candle direction
- `dislocation_threshold_updated` — periodic threshold recalibration

**Active Posture**: if a dislocation fired within last 30min at a near-current zone, add a sentence: e.g., "Long dislocation detected at D-1σ demand (29,510-29,520) on red 1H candle with +812 CVD. Long scenarios at this zone up-weighted +25%."

### Phase 5: Standalone alerting (optional, P2)

If `notification_settings.dislocation_alerts = true` in config, write to `data/live_analysis/dislocation_alerts.jsonl` with a one-line summary per event. The standing dashboard cron can surface these to a daily summary or push to Slack/email if that integration ships later.

### Files to create/modify

- `rithmic_dashboard/features/delta_dislocation.py` — new detector module (~250 LOC)
- `rithmic_dashboard/features/threshold_calibration.py` — new calibration module (~150 LOC)
- `rithmic_dashboard/features/probability_adjuster.py` — extend with 2 new multipliers
- `rithmic_dashboard/features/posture_synthesis.py` — incorporate dislocation events
- `rithmic_dashboard/features/orderflow_pulse.py` — add dislocations subsection
- `rithmic_dashboard/features/audit_trail.py` — new event types
- `rithmic_dashboard/cli/generate.py` — wire detector into main flow
- `rithmic_dashboard/cli/calibrate_thresholds.py` — new CLI for periodic recalibration
- `rithmic_dashboard/templates/dashboard.html.j2` — render dislocations subsection
- `tests/test_delta_dislocation.py` — synthetic-data fixtures for all 4 conditions + inversion
- `tests/test_threshold_calibration.py` — verify rolling median computation
- `docs/feature_reference.md` — add delta_dislocation section
- `docs/operations.md` — how to interpret dislocation events; calibration cadence

### Acceptance criteria

- Detector fires on synthetic: red 1H candle + bullish CVD (+800) at price within 14pt of a drawn demand zone → `DeltaDislocationLong` event in dislocations.jsonl
- Detector does NOT fire when conditions partially met (e.g., red candle + bullish CVD but NOT at a key level)
- Detector inverts cleanly: green candle + bearish CVD at supply zone → `DeltaDislocationShort`
- Threshold calibration produces a number within 20% of expected when fed 20 days of MNQ data (median hourly |CVD| ≈ 350-450 in this regime)
- Probability multiplier visible in tooltip when applied: "delta_dislocation_at_entry: +25% (CVD +812 on red 1H at D-1σ demand)"
- Active Posture surfaces the dislocation sentence when relevant
- **Co-firing test**: synthetic scenario where BOTH `cvd_direction_match` (+20%) AND `delta_dislocation_at_entry` (+25%) trigger simultaneously → verify final probability respects the [0.4, 1.6] additive cap (raw +45% may clip; assertion checks the clip applies cleanly, NOT that both multipliers are silently dropped). Tooltip must still show both multipliers individually with their unclipped contributions noted.
- **Co-firing with strong variant**: when `delta_dislocation_at_entry_strong` (+35%) fires, the base `delta_dislocation_at_entry` (+25%) MUST be suppressed (not stacked) — the strong variant REPLACES the base, per spec. Test asserts only the strong multiplier appears in tooltip when strong-condition met.
- **Dedup test**: same condition met across 3 consecutive 15-min ticks within a single rolling 60min window → exactly 1 event in dislocations.jsonl, keyed by `(level_id, side, rolling_window_start_ts)`. Then advance time past the window boundary while condition re-triggers → exactly 1 new event with a different window-start hash.
- Tests: ~15 new test cases (4 conditions × long/short variants + threshold edge cases + 3 co-firing/dedup tests above); ruff + mypy clean
- Visual smoke: dashboard renders dislocation events in Orderflow Pulse when synthetic event is injected

### Pre-build sweep expectation

Per the discipline pattern, surface ambiguity before coding. At minimum:

1. **Proximity threshold**: 0.5 × ATR_14 (suggested) vs fixed 10pt vs ±0.25σ (matching σ-zone convention). Recommend ±0.25σ for internal consistency with the standing convention.
2. **1H candle source**: rolling 60min window vs hour-boundary candle (snap to :00). Rolling = always fresh; boundary = matches trader's mental model of "the last 1H candle." Recommend rolling — fresher signal.
3. **Threshold multiplier**: 1.5× median (default) vs 2.0× (more selective) vs configurable per-zone. Recommend 1.5× as default with config override.
4. **Threshold recalibration cadence**: weekly cron vs on-demand vs every-session. Recommend weekly — stable, low overhead.
5. **Multi-zone proximity**: if price is within proximity of TWO zones (e.g., D-1σ demand AND VAL), does it fire once or twice? Recommend once, attributed to nearest zone.
6. **Event de-duplication**: same dislocation can persist across multiple 15-min dashboard ticks. Emit once per condition-met-window vs every-tick. **Dedup hash MUST be `(level_id, side, rolling_window_start_ts)` — NOT raw event timestamp and NOT `hour_bucket`.** Rationale: rolling 60min windows that span the same condition-met period are the same event; minute-level timing differences and hour-boundary crossings would otherwise generate spurious duplicates. The window-start anchor groups by the actual signal-generating period.
7. **Anything else surfaced when reading RA-046's code.**

### Out of scope

- Multi-timeframe dislocations (5min, 4H) — start with 1H, generalize later if useful
- Backtesting historical dislocation hit-rate — once 30+ events accumulate in dislocations.jsonl + outcomes in probability_outcomes.jsonl, a future ticket (RA-051+) can compute realized win-rate per dislocation strength bucket
- Auto-trade execution — never. This is a signal-generation ticket only
- Cross-symbol dislocations (MES, MGC) — defer; MNQ is the testbed

### Relationship to RA-046

RA-046 builds the live CVD infrastructure (`live_signals.py` computes hourly CVD already). RA-047 reuses that pipe + adds the pattern-matching layer. If RA-046's hourly CVD output isn't suitable, the first thing RA-047 should do is extend RA-046's signal module rather than reimplement.

If RA-046 has already added the `cvd_direction_match` and `cvd_direction_oppose` multipliers, RA-047's `delta_dislocation_at_entry` is a **stronger, more specific** version that fires when the CVD signal is paired with the candle-vs-delta divergence at a level — not just CVD direction in isolation. Both can coexist; the dislocation multiplier just adds on top in the rare conditions where it fires. **The combined-fire path must be explicitly tested** (see acceptance criteria) — the additive composition with the [0.4, 1.6] cap should clip cleanly rather than silently drop multipliers, and the tooltip should attribute both contributions so the trader can see why probability moved.

### Dispatch protocol (locked)

When this ticket is dispatched to an executor:

1. **No code until green-lit.** Executor's first response on dispatch must be the 7-point ambiguity sweep (per Pre-build sweep expectation above) + a plan paragraph + time estimate per phase.
2. Wait for explicit green-light reply before writing any source files.
3. Per the proven ~10× velocity discipline established across RA-040 through RA-046, this gating prevents wasted work on the wrong design choices.

---

## RA-046 · Live intra-session signal computation + quantifiable probability framework
**Priority**: P1
**Estimate**: 10-12 hours
**Dependencies**: RA-045 (dashboard hardening shipped), bounded-tail-read pattern from dashboard context prompt

**Description**: Tonight's Globex example exposes the limitation of the current dashboard: probabilities are static priors with heuristic distance/time multipliers, but the most actionable intra-session signals (real-time CVD trend, recent sweeps, ongoing absorption) aren't computed. Probability stays roughly constant within a session even when market regime shifts materially.

This ticket extends the dashboard with **live intra-session signal computation** (intra-15-min cadence, bounded I/O budget) and **expands the probability adjustment model** to use measurable signals instead of static heuristics. Result: probability becomes responsive to actual market behavior, not just price distance.

**Project**: `tools/rithmic_dashboard/` (extend existing).

### Phase 1: Live signal computation module

New module `features/live_signals.py`. Reads bounded-tail of live capture (per the I/O budget from prompt 1 — never full-file scan). Computes:

**1. Live VWAP + σ over rolling window**
- Default 60-min rolling window (configurable)
- Independent from session-anchored VWAP — measures RECENT behavior
- Compare to session VWAP: if live VWAP > session VWAP, recent bias = bullish

**2. CVD breakdown (session + last 60m + last 15m)**
- Already computed in orderflow_pulse but extend with 15m window
- Detect direction changes: "CVD flipped negative in last 15m" = momentum shift signal

**3. Volume velocity**
- Trades/min over last 15min vs baseline (Globex first-hour or RTH baseline)
- "Active" (>1.5× baseline) / "Normal" (0.7-1.5×) / "Quiet" (<0.7×)
- Quiet markets have less reliable signals — use to downweight probability

**4. Sweep detector**
- Sweep = 3+ ticks through a structural level (VPOC/VAH/VAL/VWAP/σ-bands/HIGH-conviction zones) within 60 seconds, with directional momentum
- Output: list of `SweepEvent(timestamp, level_id, direction, intensity_score, recovered_within_X_min)`
- Persist: append to `data/live_analysis/<date>_<session>_sweeps.jsonl` (rolling, per session)

**5. Absorption proxy**
- True RA-015 absorption needs MBP1 sibling (only post-session). For live, compute a PROXY:
  - At fixed price levels: aggregate trade volume over rolling 60-sec windows
  - If volume > N × per-bar median AND net aggressor delta < |0.3 × volume| (balanced)
  - = "absorption proxy event" (sticky resistance/support being defended)
- Output: list of `AbsorptionProxy(timestamp, price, volume, net_delta, side_inferred)`
- Quality flag: `confidence: "high"` if 4+ proxy events at same price within session; "low" otherwise
- Persist: `data/live_analysis/<date>_<session>_absorption_proxy.jsonl`

### Phase 2: Probability adjuster v2

Extend `features/probability_adjuster.py` with new multipliers (additive, transparent):

| Multiplier | Trigger | Effect | Rationale |
|---|---|---|---|
| `cvd_direction_match` | session CVD ≥ +500 net AND long scenario | +20% | Bullish CVD supports long bias |
| `cvd_direction_oppose` | session CVD opposes scenario direction (|net| ≥ 500) | -20% | Counter-trend setups have lower base rates |
| `cvd_momentum_flip` | last-15m CVD direction opposite of session | -10% | Active momentum shift signals reversal risk |
| `recent_sweep_at_entry` | Sweep at scenario's entry level in last 60min, NOT recovered | +10% | Confirms level's market significance |
| `absorption_proxy_at_entry` | ≥2 proxy events at entry zone in last 30min | +15% | Real defense being shown |
| `volume_velocity_quiet` | velocity < 0.7× baseline | -15% | Thin markets degrade signal reliability |
| `volume_velocity_active` | velocity > 1.5× baseline | +5% | Active participation = more trustworthy moves |
| `multi_method_confluence_bonus` | scenario's entry zone has ≥3 confluence methods | +5% per method beyond 2 | More methods agreeing = real level |
| (existing) distance, time, session-drift, state-stable | unchanged from RA-045 | varies | |

All multipliers clamped to keep final probability in [5%, 95%]. Display ALL applied multipliers in tooltip with trigger data shown (e.g., "cvd_direction_match: +20% (session CVD +1,419)").

### Phase 3: Quantifiability + reproducibility

This is the load-bearing meta-requirement. **Every multiplier must be empirically grounded once data accumulates.** For RA-046:

1. **Persistent signal logs**: every sweep, absorption proxy event, and CVD reading gets logged with timestamp. After 30+ sessions accumulate, RA-027's HistoryReport machinery can replace heuristic multiplier values with empirically-calibrated ones (using `wilson_ci` and `BinomialEstimate`).

2. **Multiplier provenance in output**: each scenario's adjusted probability JSON output includes the FULL list of applied multipliers + trigger data. This is the audit trail for "why did probability change this 15-min cycle?"

3. **Outcome tracking**: when a scenario transitions COMPLETED, log the outcome (target_hit / stop_hit) alongside the probability that was displayed AT THE TIME OF ENTRY. After 30+ outcomes, compute realized win-rate per probability bucket — calibration check.

Persist in `data/live_analysis/probability_outcomes.jsonl`. Schema: `{trading_date, session, scenario_id, displayed_prob_low, displayed_prob_high, outcome, entry_ts_ns, exit_ts_ns, applied_multipliers: [...]}`.

### Phase 4: Renderer updates

Dashboard sections affected:

**Active Posture**: add 1 sentence referencing live signals when relevant. E.g., "CVD bullish but last-15m flipped negative — signals possible reversal. Probability of bullish scenarios reduced by 10%."

**Scenario cards**: probability tooltip expanded with full multiplier breakdown including new fields. Visual: small icon next to probability if a "structural" multiplier (sweep/absorption) fired.

**Orderflow Pulse**: add subsections:
- Volume velocity gauge (active / normal / quiet)
- Recent sweeps (last 30min) with level names + direction
- Absorption proxy events (last 30min) with prices

**New audit trail entries**:
- Sweep detected at level X (direction)
- Absorption proxy event at level X
- CVD momentum flip (session vs last-15m diverge)

### Files to modify/create

- `rithmic_dashboard/features/live_signals.py` — new module (~400 LOC)
- `rithmic_dashboard/features/sweep_detector.py` — new module (~200 LOC)
- `rithmic_dashboard/features/absorption_proxy.py` — new module (~200 LOC)
- `rithmic_dashboard/features/probability_adjuster.py` — extend with new multipliers
- `rithmic_dashboard/features/posture_synthesis.py` — incorporate live signals
- `rithmic_dashboard/features/orderflow_pulse.py` — add velocity gauge + sweep/absorption sections
- `rithmic_dashboard/features/audit_trail.py` — new event types
- `rithmic_dashboard/cli/generate.py` — wire live_signals into main flow
- `rithmic_dashboard/templates/dashboard.html.j2` — render new sections
- `tests/test_live_signals.py` — synthetic capture tail fixtures
- `tests/test_sweep_detector.py` — controlled price-action patterns
- `tests/test_absorption_proxy.py` — heavy-volume-balanced-delta patterns
- `tests/test_probability_adjuster_v2.py` — all 8 multiplier combinations
- `tests/test_calibration_log.py` — outcome tracking persistence
- `docs/feature_reference.md` — new sections
- `docs/operations.md` — how to read live signals + how to use multiplier breakdown
- `docs/calibration_methodology.md` — NEW DOC explaining the empirical-grounding path

### Acceptance criteria

- All multipliers documented with trigger conditions + rationale
- Probability tooltip shows ALL applied multipliers (not just 3 as before)
- Sweep detector fires on synthetic test pattern: 5 ticks through 29,500 in <30sec → sweep_event detected
- Absorption proxy fires on synthetic: 500 contracts at 29,400 in 60sec with net delta < |150| → proxy event
- CVD-direction-match multiplier visibly changes probability when CVD swings ±2000 (e.g., scenario A probability 60-72% → 75-85% with strong bullish CVD)
- Outcome tracking logs all 7 scenarios at session close — verify entries in probability_outcomes.jsonl
- Tests: ~90 total (current 64 + ~26 new); ruff + mypy clean
- Visual smoke: dashboard rendering against tonight's Globex shows the new sections populated with real data

### Pre-build sweep expectation

Surface 5+ ambiguity questions before coding. At minimum:

1. **Live VWAP window**: 60min rolling vs 30min? Tradeoff: 60 = stable but laggy; 30 = responsive but jittery.
2. **Sweep definition**: 3 ticks in 60sec is one definition. Could be 5 ticks, could be 90sec window. Where to land?
3. **Absorption proxy threshold**: "volume > N × per-bar median" — what N? Suggest 3× as default.
4. **Multiplier composition**: multiplicative (all multiplied together) vs additive (sum the delta-adjustments)? Multiplicative compounds; additive caps cleanly. Recommend additive with [0.4, 1.6] cap.
5. **Calibration log retention**: keep all-time vs trailing-N-sessions? Recommend all-time (cheap; build the corpus).
6. **Anything else surfaced when reading the code.**

Recommend defaults; surface ambiguity; wait for green-light before coding.

### Out of scope

- Real-time pressure compute (RA-042 handles that)
- Empirical replacement of heuristic multipliers with calibrated values (that's a future ticket post-30-session accumulation, ~RA-049 or RA-050)
- Multi-symbol expansion (MNQ only for now)
- Sound alerts or chart embeds (P3 defer)
- Backtesting framework (out of scope per original plan)

---

## RA-045 · Dashboard hardening + orderflow integration (post-first-iteration review)
**Priority**: P1
**Estimate**: 8 hours
**Dependencies**: Dashboard MVP shipped per `docs/executor_prompts/dashboard_{context,analysis,automation}.md`; orderflow artifacts produced by RA-030.1/RA-035/RA-037

**Description**: First-iteration dashboard review (2026-05-21 15:40 PT) surfaced four P0 issues that make displayed numbers misleading, plus two P1 high-value additions that turn the dashboard from "infrastructure that works" into "infrastructure that influences trade decisions."

**Project**: `tools/rithmic_dashboard/` (sibling project; not part of rithmic_analytics).

### P0 — Load-bearing fixes (without these the dashboard misleads)

**1. Dual-source envelope merge**

Current: dashboard reads ONE zones JSON. When using the combined trading-day VP (`2026-05-21_MNQ_session_combined.json`), the statistical reference_lines (VWAP, ±1σ, ±2σ from RA-031) are MISSING because they only exist in the RTH-only zones JSON.

Fix: extend the envelope loader to merge data from BOTH JSONs same-date:
- Primary: trading-day combined VP for volume-derived zones (VPOC/VAH/VAL/HVN/LVN)
- Overlay: RTH-only JSON for statistical reference_lines (VWAP, ±1σ, ±2σ)
- If overlay missing, fall back to primary only with warning
- If primary missing but overlay exists, use overlay alone (RTH-only mode)

Add `EnvelopeSource` field to loaded envelope tracking which JSONs contributed. Display in dashboard header.

**2. Scenario stop tightening**

Current: Scenario A entry 29,230-29,240, stop 29,085 = 150pt risk. Stop is picking -2σ as fallback when the template's "stop = VAL or -2σ" logic fires. Result: meaningless R-multiples (Scenario A shows 0.00R for T1).

Fix: per-scenario stop policy:
- **A** (confluence reversion): stop = `min(entry_zone_low - 5pt, nearest_LVN_below_entry)`. Cap at 1.5× ATR risk.
- **B1/B2** (σ-band scalp): stop = `±2σ ± 5pt buffer`. Cap at 1.5× ATR.
- **C** (cycle-high fade): stop = `max(entry_zone_high + 5pt, recent_swing_high + 10pt)`. Cap at 0.5× ATR (tight fade).
- **D** (breakdown short): stop = `entry_zone_high + 1.5× tick`. Cap at 0.75× ATR.
- **E** (breakout continuation): stop = `entry_zone_low - 10pt`. Cap at 0.75× ATR.
- **G** (stab-and-reverse): stop = `entry_zone_low - 20pt`. Cap at 1.5× ATR.

All R-multiples recomputed against tighter stops. Update test fixtures.

**3. Audit trail dedup**

Current: "Zones JSON missing" event re-fires every 15 min (visible 6× in 7 minutes). Drowns signal.

Fix:
- Move data-quality warnings OUT of audit trail entirely — they belong in the warnings panel at top
- Audit trail keeps ONLY state-machine events (scenario transitions, level crossings at HIGH+, confluence breaks)
- Add `dedupe_window_minutes: int = 5` config — identical consecutive entries within the window collapse to "(repeated N times)"

**4. State-machine hysteresis**

Current: Scenario B2 flipped DORMANT↔WATCHING three times in 7 minutes. Boundary noise.

Fix: asymmetric ATR thresholds:
- DORMANT → WATCHING: distance ≤ 2.0 ATR
- WATCHING → DORMANT: distance > 2.2 ATR
- WATCHING → ACTIVE: entry zone touched
- ACTIVE → WATCHING: outside zone by >5pt (buffer)

Add `test_scenario_state_hysteresis.py` for both promotion and demotion edge cases.

### P1 — High-value enhancements

**5. Orderflow pulse section (NEW)**

New section between Distance Grid and Scenario Status. Reads existing artifacts (RA-030.1 absorption, RA-035 pressure, RA-037 spread). Displays:

```
ORDERFLOW PULSE (this session)
  CVD direction      BULLISH (+847 last hour, +6,259 session)   ↗
  Net volume bias    50.2% buy (neutral)
  Spread (MBP1)      1.9 ticks mean / 7 p99 / 0 crossed         HEALTHY
  Recent absorption  29,418 (score 0.62, sell side) at 13:42 PT
  Top spoof bins     29,265 (n=87, 0.94) · 29,141 (n=63, 0.91)
  Pressure compute   ✓ ran 13:18 PT
```

Color-code direction. Show "n/a" for missing artifacts with cause noted.

Module: `rithmic_dashboard/features/orderflow_pulse.py` (~200 LOC).

**6. Tonight's plan synthesis (NEW)**

New section directly below header. 2-4 sentence active posture:

```
ACTIVE POSTURE (15:40 PT)
  Globex trading 29,491 in upper extreme (+1.6 ATR from VWAP). 
  WATCHING B2 (short 29,410-29,420) and C (fade 29,545-29,555). 
  Confluence reversion long A (29,237) dormant 250pt below. 
  CVD bullish — suggests C is higher conviction than B2.
```

Synthesizer:
- Categorize current price: deep_below / lower_band / fair_value / upper_band / deep_above
- List ACTIVE and WATCHING scenarios in priority order
- Cross-reference CVD direction with scenario long/short bias
- Output 2-4 sentences via template

Module: `rithmic_dashboard/features/posture_synthesis.py` (~150 LOC).

**Acceptance criteria**:
- Distance Grid now includes VWAP, ±1σ, ±2σ rows
- Scenario A's R-multiple at T1 is ≥3R (vs current 0.00R)
- Audit trail shows zero "Zones JSON missing" entries
- Re-run dashboard 4× in quick succession with price near B2's 2-ATR boundary → B2 state changes at most 1× per session direction
- Orderflow Pulse renders with all 6 fields populated when artifacts exist
- Active Posture renders 2-4 sentences referencing current scenarios
- Full test suite green (~70 tests target); ruff + mypy clean

**Pre-build sweep expectation**: surface ambiguity on envelope merge precedence, CVD window, posture sentence count, pulse section position, hysteresis values. Recommend defaults; wait for green-light.

**Out of scope**:
- Embedded chart (P3 future)
- Sound alerts (P3 future)
- Trade journal integration (P3 future)
- Real-time intra-15-min updates (defer; 15-min cadence is the contract)

---

## RA-036 · Tradesea cancellation pattern analytics (Rule 7 measurement)
**Priority**: P1
**Estimate**: 5 hours
**Dependencies**: RA-026 (CancelledOrder records already loaded), RA-029 (OBS-01 trades for the "what happened next" lookup)

**Description**: RA-026 ingests Tradesea CancelledOrder records and surfaces a count in the replay HTML. It does NOT analyze what happened to the price after each cancel. Neel's Rule 7 ("post-regret window discipline") is the specific trading rule this measures: did you cancel a limit order at price X, then watch price reach X anyway within N minutes? That's a "regret cancel" — walking away from edge.

The cross-source join already has all the inputs landing daily:
- Tradesea CSV: `CancelledOrder` records with `limit_price`, `cancel_ts_ns`, `side`
- OBS-01 capture: live tape with `event_ts_ns`, `price`, `aggressor_side`

For each cancelled limit order, the analysis answers four diagnostic questions:
1. **Did price reach the limit?** Within N minutes of cancel, did the tape print at-or-through the cancelled limit price?
2. **Direction**: did the price move favorably (toward limit_price) or unfavorably (away) in the window?
3. **Magnitude**: how many points did price move in the favorable direction?
4. **Did you rebuy at worse?** If there's a subsequent fill on the same side within M minutes at a worse price, flag as "regret rebuy."

Output: per-cancel record with these four diagnostics + a session-level summary (`regret_cancel_rate`, `avg_regret_pts`, `regret_rebuy_count`).

**Why this is the right next**: orderflow stack just shipped (RA-035), so the natural next layer is cross-source attribution. RA-036 is a single-dimension version of RA-028 (which does multi-dimensional fill attribution); shipping RA-036 first proves the cross-join machinery, then RA-028 generalizes when ≥5 sessions accumulate. Plus it produces immediate-actionable signal for tomorrow's trading session ("here's how often you regret-cancel at SUPER zones") without waiting for the full attribution dataset.

**Files to create**:
- `rithmic_analytics/features/cancellation_analysis.py` — `analyze_cancellations(cancelled_orders: list[CancelledOrder], trades: pd.DataFrame, *, regret_window_minutes: int = 5, rebuy_window_minutes: int = 10, regret_tolerance_ticks: int = 1) -> CancellationAnalysisReport`. `CancellationAnalysisReport` dataclass with `per_cancel_outcomes: list[CancelOutcome]` + `session_summary: SessionSummary`. `CancelOutcome` per cancel: `cancel_ts_ns`, `limit_price`, `side`, `reached_limit: bool`, `direction: Literal["favorable", "unfavorable", "neutral"]`, `max_favorable_pts: float | None`, `regret_rebuy_at_worse_price: bool`.
- `rithmic_analytics/cli/analyze_cancellations.py` — `python -m rithmic_analytics.cli.analyze_cancellations --orders data/trades/YYYY-MM-DD/orders.csv --jsonl data/captures/YYYY-MM-DD/MNQ_<session>.obs01.jsonl --output data/cancellations/YYYY-MM-DD_MNQ_<session>.json [--window-minutes 5]`. Output is row-oriented JSON matching RA-035's pattern.
- `rithmic_analytics/viewer/trade_replay_report.py` — extend `render_trade_replay_html()` to include a "Cancellation Outcomes" section after the existing "Cancellations" count: table of per-cancel rows with reached/direction/max-favorable/rebuy columns, plus a session-summary callout box with regret_cancel_rate.
- `rithmic_analytics/cli/daily_zones.py` — add `--emit-cancellation-analysis` flag (default OFF, mirrors RA-030.1/RA-035 defensive pattern). When ON: if today's Tradesea CSV exists at the canonical path, run the analysis and persist. Try/except wrap so failure never gates zones JSON.
- `tests/test_cancellation_analysis.py` — synthetic CancelledOrder + tape pairs covering the four diagnostic questions. Cases: (1) cancel → price never reaches → no regret, (2) cancel → price reaches within 5min → regret flagged, (3) cancel buy at 28900 → price drops to 28850 → favorable direction unfavorable for buy, (4) cancel buy → rebuy buy at worse price within window → regret_rebuy_at_worse_price=True. Plus edge cases: cancel at session boundary, no tape data after cancel, tape gaps.
- `tests/test_analyze_cancellations_cli.py` — happy path, missing inputs, custom window minutes, force overwrite.
- `tests/test_trade_replay_report.py` — extend with assertions for the new "Cancellation Outcomes" section: table rendering, summary callout, empty-state when no cancellations.
- `docs/feature_reference.md` — new `features.cancellation_analysis` section: data model, diagnostic definitions, configurable windows.
- `docs/operations.md` — daily routine entry: how to read the analysis output, what regret_cancel_rate ranges mean (>20% = Rule 7 discipline alarm).

**Critical design decisions (engineer should sweep before building)**:

1. **"Reached limit" tolerance**: exact-price-reach vs within-N-ticks. A cancelled limit at 28,900.25 — if price prints at 28,900.00 (one tick away), was the limit "reached"? Recommend **`regret_tolerance_ticks: int = 1`** (within 1 tick = reached). Configurable knob.

2. **Direction definition for buy vs sell cancels**: a cancelled BUY at 28,900 — "favorable" means price drops below 28,900 (you would have bought lower if you'd held). A cancelled SELL at 28,900 — "favorable" means price rises above. Asymmetric per side. Build a clear helper, test both sides.

3. **`regret_rebuy_at_worse_price` semantics**: if Neel cancels a BUY at 28,900 then later fills a BUY at 28,920 within the rebuy window, that's a regret rebuy (he paid 20 worse). If the rebuy is at 28,880 (better), it's not regret. Recommend exposing `rebuy_window_minutes: int = 10` separately from `regret_window_minutes` — the windows answer different questions.

4. **Cross-session boundary handling**: a cancel late in RTH may have its "what happened next" window extend into Globex (if RTH capture stops). Recommend **clip the analysis window to the input tape's last bar** — flag the truncation in CancelOutcome with `window_truncated: bool` so consumers know to interpret carefully. Don't silently produce misleading "didn't reach limit" verdicts when the tape ran out.

5. **No-tape-data-after-cancel edge case**: cancel at 12:59:59 PT, RTH ends at 13:00:00 PT — only 1s of tape after. Recommend mark `CancelOutcome.has_sufficient_tape: bool = False` if `(last_tape_ts - cancel_ts) < min_window_seconds` (default 60s) — these are statistically meaningless, filter from session summary.

6. **Output schema versioning**: this is a NEW JSON shape. Add `schema_version: int = 1` at the top of the output so future versions can co-exist. Matches RA-035's pattern.

**Acceptance criteria**:
- Synthetic test case "cancel BUY at 28,900 → tape prints 28,895 within 5min" produces `reached_limit=True`, `direction="favorable"`, non-zero `max_favorable_pts`.
- Synthetic "cancel SELL at 28,900 → tape prints 28,905" produces `reached_limit=True`, `direction="favorable"`.
- Truncated-window case (cancel near session end) produces `window_truncated=True` and is excluded from `regret_cancel_rate` denominator.
- Run against today's `data/trades/2026-05-19/orders.csv` (which has 3 cancelled orders) + live tape → produces a non-empty analysis report with 3 CancelOutcome rows.
- Try/except wrap on the daily_zones integration mirrors RA-030.1's pattern — failure NEVER gates zones JSON.
- Full test suite green (782+ tests); ruff + mypy clean.
- Trade replay HTML renders the new "Cancellation Outcomes" section without disturbing the existing fills table or empty-state path.

**Out of scope**:
- Multi-day cancellation aggregation (single-session analysis for v1; rolling aggregator is a future ticket like RA-028's aggregate_history).
- Stop-loss order analysis (only limit-order cancels matter for Rule 7; stop cancels are a different discipline).
- Cancellation classification (e.g., "spread chase cancel" vs "structural change cancel") — defer; surface raw diagnostics first, let Neel categorize manually for a few weeks before automating.

---

## RA-035 · MBO add/cancel pressure detector (Bookmap-equivalent orderflow)
**Priority**: P1
**Estimate**: 8-10 hours
**Dependencies**: RA-002 (MBO loader, already shipped)

**Description**: Build `features/order_pressure.py` that consumes the MBO event lifecycle (add / modify / cancel / fill / trade) and produces per-price-level diagnostics: (a) rolling add/cancel ratio over the last N seconds, (b) queue depletion velocity from the A → M → C lifecycle, (c) "spoofing fingerprint" — adds that never fill before cancel. Today's lean Rithmic capture produces ~13.8M MBO events per overnight Globex session (verified 2026-05-20: 105K MBO action!=T, the remainder are full lifecycle), and the only feature consuming them is `sweep_detection`. This is the second-highest-information signal Rithmic gives us after trades themselves.

**Why this is the right next**: closes the orderflow gap that motivated the original Rithmic-pipeline project. Tells Neel whether the bid stack he sees at a HVN level is *real resting interest* or thinning fast (cancels accelerating). Closest equivalent to Bookmap's heatmap without paying MBP10's ~28 GB/day storage cost. Materially sharpens DCA timing at quant-graded support — the exact decision Rule 3 (signal hierarchy) is designed around.

**Files to create**:
- `rithmic_analytics/features/order_pressure.py` — `compute_order_pressure(mbo: pd.DataFrame, *, window_seconds: int = 30, price_bin_ticks: int = 4) -> OrderPressureSeries`. The series carries per-(time-bucket, price-bin) rows with: `add_count`, `cancel_count`, `modify_count`, `fill_count`, `add_cancel_ratio`, `depletion_velocity_per_sec`, `spoof_score` (0-1, "fraction of adds at this level that cancelled before filling, within `cancel_window_sec`"). Vectorized via pandas groupby + rolling. Must handle 13M rows in <60s on Neel's machine (already verified pandas+numpy can handle this scale for VP compute).
- `rithmic_analytics/features/order_pressure.py::aggregate_to_session_summary(pressure: OrderPressureSeries) -> dict` — collapses to per-price-bin totals over the full session, for chart overlay / morning report. Returns dict keyed by price-bin with summary stats.
- `tests/test_order_pressure.py` — synthetic MBO tapes with controlled patterns: (1) baseline calm orderflow → uniform pressure scores, (2) absorption pattern (heavy adds + slow cancels at one level) → low spoof_score, high depletion_velocity, (3) spoofing pattern (heavy adds that all cancel within 500ms, no fills) → high spoof_score, (4) breakout pattern (queue rapidly depletes from fills at top-of-book) → high depletion_velocity, normal add/cancel ratio. Plus performance test: 5M synthetic MBO rows complete in <30s.
- `rithmic_analytics/cli/compute_pressure.py` — `python -m rithmic_analytics.cli.compute_pressure --mbo data/captures/YYYY-MM-DD/MNQ_<session>.mbo.jsonl --output data/order_pressure/YYYY-MM-DD_MNQ_<session>.json`. Optional `--top-n-levels 10` for output filtering.
- `rithmic_analytics/cli/daily_zones.py` — add `--emit-pressure-json` flag (default OFF, mirrors RA-030.1's `--emit-absorption-json` pattern). When ON: load MBO sibling (if present), compute pressure, persist to `data/order_pressure/`. Wrap in try/except — failure doesn't gate zones JSON.
- `docs/feature_reference.md` — new `features.order_pressure` section: data model, definitions of each diagnostic, why MBO-derived ≠ MBP10-derived, performance notes.
- `docs/operations.md` — daily routine entry: where order_pressure fits, how to read the artifact (top-level high-spoof-score levels = real-time supply detection).
- `docs/architecture.md` — **D-009**: MBO-derived pressure as the lean-stack alternative to MBP10 heatmap. Rationale + scope.

**Critical design decisions (engineer should sweep before building)**:

1. **Time bucketing**: fixed-width windows (e.g., 30s bins) vs trade-time-aligned vs event-aligned. Recommend **fixed 30s bins by default with `--window-seconds` override**. Matches absorption's bin model + makes pressure series joinable with footprint + VP outputs.

2. **Price bin width**: matches VP's `bin_size_ticks` default (20 ticks = 5pt for MNQ) or finer (e.g., 4 ticks = 1pt)? Recommend **finer (4 ticks) for pressure** — order-level activity needs sub-VP granularity to be useful. Configurable via `--price-bin-ticks`.

3. **Spoof window**: 500ms is the audit's implied threshold. But spoofing patterns vary by participant — high-frequency spoofers cancel in <100ms; "fade-the-lurker" spoofs may hold for 1-2s. Recommend **expose `--spoof-cancel-window-ms` default 500ms** with a note that it's a tuning knob, surface the value in the output metadata.

4. **Memory budget**: 13.8M MBO rows at ~200 bytes pandas-wise ≈ 2.7GB peak. Acceptable for nightly batch but worth chunking if it grows. Recommend **defer chunking until we see actual OOM**; today's machine has headroom.

5. **Joining to existing outputs**: should pressure data flow into ZoneEnvelope as ReferenceLines (heavy-spoof levels = "watch for fade")? Recommend **NOT for v1** — pressure is dense per-bin data, not naturally a single reference line. Future ticket can extract "top 3 spoof-detected levels" as ReferenceLines if Neel finds it useful in practice.

6. **Cross-source attribution**: should the absorption events (RA-030.1) be enriched with the pressure metrics at fill time? Recommend **NOT for v1** — keep modules independent. RA-028's attribution layer will do the joining when it lands (~5 sessions out).

**Acceptance criteria**:
- Synthetic spoofing pattern (heavy adds at 28900 all cancelled within 500ms, zero fills) produces `spoof_score >= 0.9` at that price bin.
- Synthetic absorption pattern (heavy adds at 28900, slow cancels, gradual fills) produces `spoof_score <= 0.2` at that price bin and `depletion_velocity_per_sec > 0`.
- Tonight's live Globex MBO capture (~13.8M rows) processes in <60s on Neel's machine.
- `daily_zones --emit-pressure-json` against tonight's capture produces a non-empty pressure JSON with reasonable per-price-bin stats.
- Try/except wrap on the daily_zones integration mirrors RA-030.1's defensive pattern — failure here NEVER gates zones JSON emission.
- Full test suite green (729+ tests); ruff + mypy clean.
- `architecture.md` D-009 documents the MBO-pressure vs MBP10-heatmap rationale.

**Out of scope**:
- Real-time / streaming pressure (this is a post-capture batch feature).
- Per-order tracking (full A→M→C lifecycle traversal) — aggregated per-bin per-window is sufficient for v1. Future enrichment if needed.
- Visualization (chart rendering of pressure heatmap) — would be its own ticket (RA-019-style Plotly HTML output).
- MBP10 integration — explicitly chosen alternative path. Document the rationale.

---

## RA-034 · TV chart-sync from zones JSON (closes the EOD-cleanup loop)
**Priority**: P1
**Estimate**: 6-8 hours
**Dependencies**: RA-030.1 (absorption events JSON exists), TV MCP `draw_list` bug fix shipped 2026-05-20 (without which selective removal is impossible)

**Description**: Productionize the manual chart-cleanup workflow demonstrated end-to-end in the 2026-05-19/20 session. Neel currently does ~15 min of manual TV-zone drawing per session (read morning report's zone list → draw lines in TV → re-evaluate stales next session → repeat). The full loop is now scriptable: `draw_list` enumerates user-drawn shapes, `draw_get_properties` returns prices/labels, `draw_remove_one` selectively removes, `draw_shape` adds. Same API surface available on Tradesea via Chrome MCP iframe JS (`tradingViewApi.activeChart().getAllShapes()` etc. on the same-origin iframe).

The 5-step routine:
1. **Enumerate**: list user-drawn shapes on the target chart.
2. **Classify**: each shape gets KEEP / STALE / RELABEL based on the canonical zones JSON + a state file tracking what tv_sync previously created.
3. **Selective remove**: `draw_remove_one` (or `removeEntity`) for each STALE.
4. **Add**: for each new entry in the zones JSON without a matching live shape, create it with style-by-source-type (VPOC lime, VAH red dashed, VAL green dashed, LVN cyan dotted, HVN MED yellow rectangle, SUPER conviction bold, etc.).
5. **Verify + report**: re-enumerate, diff against expected, log what changed.

Two backends, one classification engine:
- **TV Desktop** via TV MCP tools (`draw_list`, `draw_shape`, `draw_remove_one`, `draw_get_properties`).
- **Tradesea iframe** via Chrome MCP `javascript_tool` injection into `iframe[id^="tradingview_"]`'s `tradingViewApi.activeChart()`.

**Files to create**:
- `rithmic_analytics/viewer/tv_publisher.py` — classification engine, state-file management, style policy. `class TVPublisher` with `plan(zones, current_shapes)` → list of `Operation` (Add/Remove/NoChange), `apply(operations, backend)` → execution.
- `rithmic_analytics/viewer/_tv_backend.py` — `TVBackend` Protocol (`list_shapes`, `add_shape`, `remove_shape`, `get_shape_properties`). Concrete `TVDesktopBackend` calls TV MCP tools; concrete `TradeseaBackend` injects iframe JS via Chrome MCP.
- `rithmic_analytics/cli/tv_sync.py` — orchestrator. `python -m rithmic_analytics.cli.tv_sync --zones <path> --target {tv_desktop, tradesea, both} --dry-run|--apply`. Default `--dry-run`. State file at `data/tv_sync_state/<chart_id>.json` mapping zone-source-id → shape-entity-id.
- `tests/test_tv_publisher.py` — classification logic against mock backend (synthetic zones JSON + synthetic shape inventory). Cover: add-only run, remove-stale run, idempotency (re-run produces no ops), state-file recovery after process restart, schema validation of input zones JSON.
- `tests/test_tv_publisher_backends.py` — backend Protocol compliance (mock impls verify the interface). Real backend tests are manual smoke (require live TV/Tradesea).
- `docs/feature_reference.md` — new `viewer.tv_publisher` section: classification rules, state-file format, style policy, dry-run vs apply.
- `docs/operations.md` — daily routine update: where to invoke tv_sync in the morning workflow.

**Critical design decisions (engineer should sweep before building)**:

1. **Stale-shape detection policy**: by state-file (recommended — only touch shapes tv_sync previously created, safe), by label prefix (medium safety), or by heuristic (least safe). State-file approach prevents accidentally nuking Neel's manually-drawn analyses.

2. **Run mode default**: `--dry-run` recommended as default. First run on a chart shows preview output ("would remove 3, would add 5") before any state change. Explicit `--apply` to commit. Mirrors `daily_zones`'s "smoke before flip" pattern.

3. **Tradesea iframe remount handling**: TV Charting Library remounts the iframe on chart-state changes (verified in 2026-05-19 session — `tradingview_d12f0` → `tradingview_1083c`). Backend must re-query `iframe[id^="tradingview_"]` every operation, never cache the ID.

4. **Time anchor for new shapes**: use `Math.floor(Date.now() / 1000)` rounded to bar resolution, NOT `getVisibleRange().to`. The 2026-05-20 incident showed `vr.to` placed labels 8 weeks in future-space (off-screen). Document this pattern in the backend code with a referencing comment.

5. **Color/style policy**: hardcoded `STYLE_BY_SOURCE` dict in `tv_publisher.py` keyed by `ReferenceLine.source` (`vpoc`, `vah`, `val`, `lvn_globex`, `lvn_rth`, etc.) and `Zone.conviction` (`SUPER`, `HIGH`, `MED`, `LOW`). External config can come later — opinionated defaults first.

6. **Indicator-emitted vs user-drawn**: TV Charting Library's `getAllShapes()` returns only user-drawn shapes. Indicator-emitted (Quant Regime + Zones [Neel v2.3]) are out of scope; the script can't touch them. Document this so operators know why some labeled zones don't show up in the enumerate output.

7. **What about the rectangle multipoint bug**: 2026-05-20 incident showed `_createMultipointShape` (underscore-prefix internal) only persisted 1 point. Tradesea backend must use `createMultipointShape` (no underscore) — verified working in the live session. Document the underscore-vs-no-underscore distinction.

**Acceptance criteria**:
- `--dry-run` on any zones JSON + live chart prints planned ops without mutating chart state. Same call twice produces identical output (idempotent).
- `--apply` executes the plan. Re-running immediately after produces zero ops (state file tracks last-applied state).
- After RA-030.1 emits tonight's `data/zones/2026-05-20_MNQ_rth.json` and `data/absorption/2026-05-20_MNQ_rth.json`, running `tv_sync --target both --apply` adds the zone entries to TV Desktop AND Tradesea with consistent styling.
- A manually-drawn shape that doesn't appear in the state file (e.g. a fib retracement Neel placed by hand) is **never** touched by remove-stale logic.
- Failure on one backend (e.g. Tradesea iframe missing because tab closed) doesn't gate the other backend — partial success is success.
- Full test suite green (677+ tests); ruff + mypy clean.

**Out of scope**:
- Multi-layout sync (TV Desktop supports multiple chart layouts per symbol — handle the currently-active layout only; multi-layout iteration is a v2 feature).
- Automatic conviction-tier upgrade based on confluence detection (that's RA-027 + RA-031 already handles `_band_*` substring matching; tv_sync just draws what the zone JSON says).
- Updating MNQ Alert Levels Pine script (separate Pine-source-update tool, not draw-API).
- Scheduling — operator invokes manually for now; can be added to the daily_zones scheduled task later as `--also-publish-tv`.

---

# Sprint 8 — Reactive: MBP1 data-quality fallout from RA-037 diagnostic

> **Context**: RA-037's spread-summary INFO log on 2026-05-20 surfaced an
> anomaly — Globex MBP1 reporting mean=115K ticks, 4M crossed quotes. A
> 10K-record diagnostic probe identified the root cause as 99.8% of records
> being one-sided with the un-updated side at `0.0` (not `NaN`). RA-040 is
> the immediate filter fix (shipped same night). RA-041 is the structural
> normalizer fix — load-bearing for absorption analytics quality.
>
> **Status (2026-05-21):** Sprint 8 closed.
> - RA-040 shipped 2026-05-20 (~30 min).
> - RA-041 shipped 2026-05-21 (~2.5h end-to-end). 872 passed / ruff clean /
>   mypy clean. Real-Globex smoke: **100.00% two-sided coverage** on the
>   2026-05-20 Globex capture (vs 0.03% pre-fix; >95% gate cleared with
>   margin). Absorption event quality on the same capture improved: 24→13
>   events post-fix (the 11 spurious events were stale-asof-pull artifacts
>   that the displacement calc could no longer manufacture once MBP1 was
>   actually contemporary to trade bars).

## RA-040 · MBP1 one-sided filter: treat `px == 0.0` as missing — SHIPPED 2026-05-20
**Priority**: P1
**Estimate**: 0.5 hours (shipped same night, ~30 min)
**Dependencies**: RA-037 (the diagnostic that surfaced the bug)

**Description**: RA-037 used `pd.notna()` to mark one-sided MBP1 rows, but
empirical Globex MBP1 records mark the un-updated side as literal `0.0`,
not NaN. The filter passed those through, yielding nonsense spreads
(28919.75 points = 115,679 ticks on the first record sampled). Tightened
the predicate in `_compute_spread_columns` to also treat `bid_px <= 0` or
`ask_px <= 0` as one-sided. Post-fix Globex summary: mean=2.09 ticks,
p99=10 ticks, max=37 ticks, 0 crossed (vs 4M before) — sane distribution
exposed once the spurious one-sided rows are filtered.

**Files modified**:
- `rithmic_analytics/core/loader.py::_compute_spread_columns` — predicate
  now `(bid <= 0) | (ask <= 0) | bid.isna() | ask.isna()`.
- `tests/test_loader.py::test_mbp1_spread_columns_one_sided_zero_price` —
  new case covering both bid==0 and ask==0 + control row.

**Verification**:
- 867 tests pass / ruff clean / mypy clean.
- Live smoke against `data/captures/2026-05-20/MNQ_globex.mbp1.jsonl`
  (8.3M records): 2,270 valid two-sided rows (0.03% coverage). The
  0.03% number is itself the input signal for RA-041.

---

## RA-041 · `normalize_probe` MBP1 forward-fill (structural fix for delta-stream) — SHIPPED 2026-05-21
**Priority**: P1
**Estimate**: 3 hours
**Dependencies**: RA-030 (normalize_probe → MBP1 sibling production)

**Description**: The Rithmic L1_QUOTE stream emits **delta updates** — each
record carries only the side that changed, with the unchanged side
serialized as `0.0`. The normalize_probe routing in
`ops/normalize_probe.py` currently writes these deltas verbatim into the
MBP1 sibling JSONL, treating each as a complete top-of-book snapshot. The
downstream contract for `load_mbp1` is "each row is a snapshot of bid+ask
at that timestamp" — RA-040's filter is now masking that contract violation
with NaN spreads, but the structural fix is to forward-fill the unchanged
side from prior state during normalization so the MBP1 sibling on disk
actually IS a snapshot stream.

**Empirical evidence (from RA-040 diagnostic probe)**:
- First 10K records of 2026-05-20 Globex MBP1:
  - 50.1% `bid_px=0, ask_px > 0` (ask-only delta)
  - 49.7% `ask_px=0, bid_px > 0` (bid-only delta)
  - 0.2% normal two-sided snapshot
- 99.8% of the stream is unusable for absorption / spread analytics until
  forward-filled.

**Why this is load-bearing**: per project memory, RA-015 absorption is
running degraded in prod (mbp1_stale=true, 3-factor instead of 4-factor).
RA-030 fixed the "MBP1 sibling is being produced" issue; RA-041 fixes the
"MBP1 sibling actually contains valid two-sided quotes" issue. Until this
ships, the absorption analytics layer has no usable depth context — every
non-trivial calibration of `mbp1_stale=false` will fail.

**Files to create/modify**:
- `rithmic_analytics/ops/normalize_probe.py::_route_l1_quote` (or wherever
  L1_QUOTE → MBP1 lives): maintain `_last_bid_px` / `_last_bid_sz` /
  `_last_bid_ct` and `_last_ask_*` state across records; when a delta
  arrives with one side at `0.0`, substitute the cached prior value for
  that side before writing. First-record edge case: if no prior state for
  the missing side, write `null` (loader handles NaN ⇒ one-sided).
- `tests/test_normalize_probe.py` — new cases:
  1. Sequence `[bid-only, ask-only, bid-only]` → second record's MBP1 row
     carries both sides (ask from prior, bid from current).
  2. First record one-sided → emitted with NaN for the missing side.
  3. Validated 4.1 GB fixture → smoke test that normalize output now has
     two-sided coverage >95% (vs current 0.03%).
- `docs/architecture.md` — extend D-007 with the delta-stream finding.
- `docs/feature_reference.md` — update `ops.normalize_probe` section.

**Critical design decisions**:

1. **Forward-fill happens at normalize time, NOT at load time.** The
   on-disk MBP1 sibling becomes the snapshot stream; downstream consumers
   keep treating it as such. Loader-side forward-fill would require every
   reader to carry state, defeating the loader's "stateless DataFrame
   producer" contract.

2. **NaN at the first delta-record edge** (no prior state for the missing
   side). Loader already handles NaN one-sided; preserve that contract.
   Don't substitute zero, don't substitute a "best guess."

3. **Cached OBS-01 invalidation**: after RA-041 ships, every existing
   `<root>_<session>.obs01.jsonl` cached file's matching `.mbp1.jsonl`
   sibling is stale (carries delta data, not snapshots). Document the
   delete-and-rerun workflow in operations.md — mirror RA-035's MBO
   sibling guidance.

**Acceptance criteria**:
- A normalize_probe run against the 2026-05-20 Globex parity capture
  produces an MBP1 sibling where >95% of records have both
  `bid_px_00 > 0` AND `ask_px_00 > 0`.
- The RA-037 spread summary on that re-normalized file shows
  n_records ≈ same, valid two-sided ≈ same (no longer 0.03%).
- All 867+ existing tests pass; new normalize_probe cases pass.
- Absorption emit can stop reporting mbp1_stale=true on a session
  re-normalized after the fix.

**Out of scope**:
- L1_QUOTE size/count delta semantics: assume sizes and counts also
  delta with the price. Verify in the diagnostic step before coding;
  if they don't co-update, may need separate forward-fill for each.
- Backfill of historical captures — operator deletes
  `<root>_<session>.obs01.jsonl` to force re-normalize on next
  daily_zones run, per the established MBO sibling invalidation pattern.

---

# Sprint 5 — Live capture, replay, and operational closure

## RA-030 · L1_QUOTE → MBP1 normalizer routing (absorption bug fix)
**Priority**: P0 (production bug — silently degrades RA-015 absorption since 2026-05-19)
**Estimate**: 5 hours
**Dependencies**: RA-029 (`normalize_probe.py`), RA-015 (absorption consumer)

**Description**: The live Rithmic probe does **not** support `--streams MBP1` (rejected with "Allowed values: LAST_TRADE, L1_QUOTE, MBP10, MBO"). The lean stack captures `L1_QUOTE` instead, which carries the same top-of-book information (`bid_px`, `ask_px`, `bid_sz`, `ask_sz` per parity-payload mode). Currently `ops/normalize_probe.py::parity_record_to_obs01_dict` drops L1_QUOTE records to `skipped_wrong_stream` — they never reach disk in normalized form. Consequence: `load_mbp1()` returns empty against live captures, `absorption.compute_absorption_events` falls back to `mbp1_stale=True`, and `displacement_factor` is pinned to 0.0 — a 25%-weighted factor in the four-factor score. The detector silently runs in degraded three-factor mode in production.

Tests pass because they exercise the Databento-normalized MBP1 fixture at `data/probes/infra01/full/databento/MNQM6_mbp1_post04d.normalized.jsonl` — a different pipeline output. The smoke test on 2026-05-19 didn't exercise absorption, so this wasn't surfaced until the post-RA-029 audit.

**Approach**: Route L1_QUOTE through the normalizer to produce MBP1-shaped envelopes that `load_mbp1()` can consume. L1_QUOTE → MBP1 is a field rename + envelope wrap (`bid_px` → `bid_px_00`, `bid_sz` → `bid_sz_00`, `ask_px` → `ask_px_00`, `ask_sz` → `ask_sz_00`) — no protobuf decode, no new data acquisition. Emit normalized records to a sibling `*.mbp1.jsonl` file alongside the existing `*.obs01.jsonl`; wire `daily_zones.py` to write both. Decision on whether to combine into a single `.obs01.jsonl` with mixed `type` field vs. separate files: engineer's call based on what `load_mbp1()` cleanly consumes (separate files is the safer default — keeps loader contracts unchanged).

**Files to modify/create**:
- `rithmic_analytics/ops/normalize_probe.py` — add `parity_l1quote_record_to_mbp1_dict()` pure helper; extend `normalize_probe_to_obs01` to optionally also write `*.mbp1.jsonl` (or split into `normalize_probe_to_mbp1` sibling). Update `NormalizeReport` to track L1_QUOTE records written.
- `rithmic_analytics/cli/normalize.py` — add `--mbp1-output` flag (optional; if omitted derive from `--output` by swapping suffix). Default: emit both `.obs01.jsonl` and `.mbp1.jsonl`.
- `rithmic_analytics/cli/daily_zones.py` — chain the MBP1 normalization step. `_resolve_capture_for_load` should sniff for the `.mbp1.jsonl` sibling and pass to absorption.
- `tests/test_normalize_probe.py` — add L1_QUOTE → MBP1 unit cases (field rename correctness, ns-precision preserved, missing-field handling, dropped-reason taxonomy).
- `tests/test_normalize_probe_parity.py` — extend the slow golden-file test: feed a parity capture with L1_QUOTE records → normalize → confirm `load_mbp1()` succeeds and returns expected schema columns. (Cannot directly diff against the Databento fixture since it's a different source pipeline, but schema-conformance + load-success is the meaningful gate.)
- `tests/test_absorption.py` — add a regression test: feed the smoke-test capture from `data/captures_smoketest/2026-05-19/` (where L1_QUOTE records exist) through the new normalizer, then through absorption, and assert `mbp1_stale=False` for at least one event with `displacement_factor > 0.0`. This is the production-correctness test.
- `docs/architecture.md` — add **D-007**: L1_QUOTE is the Rithmic-native top-of-book stream, MBP1 is the analytics-layer contract. Normalizer bridges them. Document why MBP1 isn't a capture-time stream (probe doesn't support it).
- `docs/operations.md` — remove any troubleshooting copy that treats `mbp1_stale=True` as expected default; add a note that post-RA-030 it should be `False` for live captures.

**Acceptance criteria**:
- Re-run absorption against `data/captures_smoketest/2026-05-19/MNQ_rth.jsonl` (after normalization) → `mbp1_stale=False` on majority of bars, `displacement_factor` non-zero on the events scoring >0.5.
- All existing absorption tests (Databento fixture path) still pass — no regression in the fixture-based pipeline.
- L1_QUOTE → MBP1 unit tests cover field rename + missing-field + ns-precision.
- Slow golden-file parity test confirms `load_mbp1()` cleanly consumes the produced `.mbp1.jsonl`.
- `daily_zones.py` produces both `.obs01.jsonl` and `.mbp1.jsonl` siblings; absorption finds and consumes both.
- Full suite green (614+ tests); ruff + mypy clean.
- `architecture.md` D-007 + `operations.md` correction shipped.

**Out of scope**:
- Backfilling absorption scores against pre-RA-030 captures (those need to be re-normalized and re-scored if Neel wants historical four-factor data — separate ad-hoc reprocessing run, not part of this ticket).
- Calibrating `min_emit_score` / `min_displacement` against the now-correct four-factor signal (that's B2 in the audit; explicitly blocked on RA-030 so it doesn't calibrate against the degraded signal).

---

## RA-031 · Session-anchored VWAP + σ bands as ReferenceLines
**Priority**: P1
**Estimate**: 4 hours
**Dependencies**: RA-002 (loader), RA-004 (zone schema), RA-010 (daily_zones orchestrator)

**Description**: Build `features/vwap.py` computing RTH-anchored, Globex-anchored, and weekly-anchored VWAPs with ±1σ/±2σ bands. Bucket on `event_ts_ns`. Emit each band as a `ReferenceLine` entry in the zone JSON envelope with `source` values like `"vwap_rth"`, `"vwap_rth_band_p1sd"`, `"vwap_rth_band_m1sd"`, `"vwap_rth_band_p2sd"`, `"vwap_rth_band_m2sd"`, `"vwap_globex"`, `"vwap_weekly"`, etc.

**Why now**: RA-027's `grade_zone` logic elevates a HVN to HIGH conviction when it overlaps "≥1 band + ≥1 structural" reference. Today no `*_band` sources contribute to the zone JSON, so HIGH is effectively unreachable. RA-027 HistoryReports show SUPER/HIGH as `insufficient_data` mostly because Phase 1 zones can't earn HIGH. This ticket resurrects the conviction tier the scorer was designed for.

**Files to create**:
- `rithmic_analytics/features/vwap.py` — `compute_vwap(trades: pd.DataFrame, anchor: Literal["rth", "globex", "weekly"]) -> VwapSeries`. `VwapSeries` dataclass has `event_ts_ns`, `vwap`, `vwap_p1sd`, `vwap_m1sd`, `vwap_p2sd`, `vwap_m2sd` arrays. Use Welford's online algorithm or compensated summation for numerical stability across 100K-event sessions (running `sum(p²·v)` can drift with naive float64 accumulation).
- `tests/test_vwap.py` — synthetic trade tapes with known cumulative `Σ(price·vol) / Σ(vol)` for end-of-session VWAP correctness; multi-session anchoring reset (Globex doesn't bleed into next-day RTH VWAP); numerical-stability test (100K bars with high-magnitude prices); empty-session edge case.
- `rithmic_analytics/cli/daily_zones.py` — wire VWAP band reference lines into the emitted zones JSON. Both current VWAP and ±1σ as `ReferenceLine` entries (skip ±2σ from main output unless explicitly enabled — keeps the morning chart-prep noise floor low).
- `docs/feature_reference.md` — new `features.vwap` section.
- `docs/architecture.md` — **D-008**: VWAP anchor choices (RTH/Globex/Weekly only, not arbitrary). Globex VWAP anchors at 17:00 ET prior day; weekly VWAP anchors at Sunday 17:00 ET.

**Acceptance criteria**:
- End-of-session VWAP matches `Σ(price × vol) / Σ(vol)` to within ±0.5pt across the validated 37-min fixture.
- σ bands compress on low-volatility days, expand on high-volatility — visible on 2-3 fixture days.
- Numerical stability: 100K-bar synthetic doesn't drift more than 0.1pt from analytical-truth VWAP.
- Reference lines appear in the emitted zones JSON; manual inspection of `grade_zone` on a HVN+band overlap returns `conviction="HIGH"`.
- Globex VWAP and RTH VWAP are independent (Globex events don't contribute to RTH-anchored VWAP and vice versa).

**Out of scope**:
- Multi-day session VWAP (rolling 5-session anchor, e.g.) — defer; can layer on later if the simple anchors prove insufficient.
- AVWAP from arbitrary user-chosen anchors — out of scope; that's a TradingView ergonomic, not a daily-zones feature.

---

## RA-032 · Push notifications for FAIL severity (Discord webhook)
**Priority**: P1
**Estimate**: 3 hours
**Dependencies**: RA-009 (gap detection alerter), RA-011 (heartbeat)

**Description**: The `send_discord_webhook` skeleton exists in `ops/alerts.py` but is off by default. Wire it on for FAIL-severity events only (gap, heartbeat-missing, normalize-unrecoverable). 30-min dedupe by `(severity, source_name)` key to prevent alert storms. Add a daily digest fired by `daily_zones` at the end of each run: one line summary of the day's capture state.

**Files to modify**:
- `rithmic_analytics/ops/alerts.py` — wire webhook for FAIL severity; add in-memory dedupe with 30-min TTL keyed by `(severity, source_name)`. Reload from a `.alerts_state.json` file on startup so dedupe survives process restarts. New env var `RITHMIC_DISCORD_WEBHOOK_URL` (Neel sets in `.env`); missing var → log INFO once, silently no-op subsequent calls (do NOT crash the pipeline).
- `rithmic_analytics/cli/daily_zones.py` — after the daily run completes, emit a digest line via the webhook: "RTH 2026-MM-DD: K trades captured, N zones (top HVN at PRICE), A alerts (S fail / W warn), absorption events: E."
- `tests/test_alerts.py` — dedupe behavior (second FAIL within 30min suppressed), severity filtering (WARN never fires), missing env var no-op, digest format.

**Acceptance criteria**:
- FAIL-severity gap event posts once to webhook; second identical FAIL within 30min is suppressed (logged but not posted).
- WARN-severity events never post.
- Missing `RITHMIC_DISCORD_WEBHOOK_URL` → INFO log on first attempt, silent no-op after; pipeline does not crash.
- Daily digest fires once per `daily_zones` run with the summary format above.
- Dedupe state survives process restart (next invocation respects the 30-min window).

**Out of scope**:
- Pushover, email, or other notification channels — Discord webhook is sufficient for Neel's setup. Add others only if specifically requested.
- Per-zone proximity alerts — those belong in the TradingView Pine Script alert system (already shipped separately).

---

## RA-033 · Heartbeat-of-heartbeat watchdog (item 6a mitigation)
**Priority**: P1
**Estimate**: 1 hour
**Dependencies**: RA-011 (heartbeat task), RA-010 (daily_zones)

**Description**: Cheapest mitigation from `future_work.md` item 6. At the end of each `daily_zones` run, check whether the prior trading day's heartbeat file exists; if absent, log WARNING and (if RA-032 has shipped) emit a FAIL-severity alert. Catches the Windows-Update-wipes-Task-Scheduler silent failure mode the deferred item flagged.

**Files to modify**:
- `rithmic_analytics/cli/daily_zones.py` — add ~5-line check at end of run: compute `expected_heartbeat_path(prior_trading_date)`; if not exists, log WARNING + (if alerts wired) emit FAIL alert with `source_name="heartbeat_watchdog"`. Skip the check on the first run after fresh install (no prior date to check) — gate via "is there ANY heartbeat file in the directory" check.
- `tests/test_daily_zones.py` — three cases: (1) missing prior-day heartbeat → WARNING fires, (2) present prior-day heartbeat → silent, (3) empty heartbeat directory (bootstrap case) → silent.

**Acceptance criteria**:
- Missing yesterday-heartbeat file → WARNING log line emitted; FAIL alert posted if RA-032 wired.
- Present yesterday-heartbeat → no log noise.
- Bootstrap (empty heartbeat dir) → no false alarm.

**Out of scope**:
- Mitigations 6b (weekly digest email) and 6c (external pingback service) — defer per `future_work.md`; 6a alone closes 80% of the failure-mode risk at 1% of the cost.

---

## RA-029 · Probe → OBS-01 normalization bridge (`--parity-payload`)
**Priority**: P0 (blocks RA-027, RA-028, and all live-data work)
**Estimate**: 5 hours
**Dependencies**: RA-007 (`start_capture.py` wrapper), RA-002 (OBS-01 loader contract)

**Description**: The live capture wrapper (`cli/start_capture.py::_build_probe_cmd`, lines 154–167) invokes the probe without `--parity-payload`, so today's `MNQ_rth.jsonl` contains only envelope metadata — `raw_present: false`, no `price`/`size`/`aggressor` fields. The downstream OBS-01 loader (`core/loader.py::load_obs01_trades`) finds zero TRADE envelopes and the entire analytics pipeline degrades to empty-state. The validated `*.obs01.jsonl` fixtures shipped with the repo were produced via the probe's existing `--parity-payload` mode (normalization implemented inside the probe by `normalize_last_trade_payload` / `normalize_l1_quote_payload` / `normalize_mbo_payload` / `normalize_mbp10_payload`). Storage delta measured at 6.62 GB/RTH (+39% over bare), within the 25 GB ceiling.

**Approach (Path A.5)**: flip `--parity-payload` on by default in the wrapper, and ship a thin normalizer that transforms parity-mode records → the OBS-01 envelope shape the loader speaks (`type: "TRADE"`, `payload: {exchange_event_ts_ns, sidecar_recv_ts_ns, price, quantity, aggressor_side, trade_id}`). No protobuf parsing — parity records already carry the fields as JSON.

**Files to create/modify**:
- `rithmic_analytics/cli/start_capture.py` — add `--parity-payload / --no-parity-payload` flag (default ON for new captures); thread through `_build_probe_cmd`. Log a clear WARNING when `--no-parity-payload` is set ("captures will be metadata-only; analytics pipeline will skip trade-level features").
- `rithmic_analytics/ops/normalize_probe.py` (new) — `normalize_probe_to_obs01(in_path: Path, out_path: Path) -> NormalizeReport` plus pure helper `parity_record_to_obs01_dict(rec: dict) -> dict | None` (returns None for non-trade streams, so caller can filter). Handle LAST_TRADE and MBO action=T as trade sources; L1_QUOTE and other MBO actions get dropped (with counts surfaced in the report).
- `rithmic_analytics/cli/normalize.py` (new) — `python -m rithmic_analytics.cli.normalize --input <raw.jsonl> --output <obs01.jsonl>`. Idempotent; refuses to overwrite output unless `--force`. Emits NormalizeReport summary to stderr.
- `rithmic_analytics/cli/daily_zones.py` — chain the normalizer between capture and zone compute, so `MNQ_rth.jsonl` → `MNQ_rth.obs01.jsonl` happens automatically each morning.
- `docs/architecture.md` — add **D-006**: capture pipeline is `probe (parity-payload) → raw JSONL → normalize_probe → *.obs01.jsonl → analytics`. Note: today's `2026-05-19` capture is metadata-only and unrecoverable; document as a known gap, do not retrofit.
- `docs/operations.md` — add troubleshooting entry: "live capture produced an empty replay report" → check `raw_present` on first record; if false, capture predates RA-029 or `--no-parity-payload` was set.

**Tests**:
- `tests/test_normalize_probe.py` — synthetic parity records covering each stream (LAST_TRADE, MBO action=T, MBO action=A/M/C, L1_QUOTE); confirm field renames, envelope wrap, `type` field, and `event_ts_ns` ns-precision preserved as int64. Edge cases: aggressor=None (unknown), zero quantity, missing parity fields → record dropped with reason logged.
- `tests/test_normalize_probe_parity.py` — **golden-file parity test**. Feed `D:\Quant-futures-app\data\probes\infra01\full\probe-parity-post04d.jsonl` (4.1 GB, validated capture) through `normalize_probe_to_obs01`. Diff first 1000 trade records against `l1-trade-post04d.obs01.jsonl` (the existing validated OBS-01 fixture). Schema fields must match exactly; floating-point prices compared at full precision (no rounding tolerance — both sides came from the same source). Mark `@pytest.mark.slow` since it touches a 4.1 GB file; gate via `pytest -m slow`.
- `tests/test_start_capture.py` — add a case asserting `--parity-payload` defaults to ON and shows up in the resolved probe command; add a case for `--no-parity-payload` opt-out with the warning log captured.

**Acceptance criteria**:
- `python -m rithmic_analytics.cli.normalize --input <bare-capture.jsonl> --output /tmp/out.jsonl` exits non-zero with an actionable error when input has `raw_present: false` AND no parity fields (today's 2026-05-19 file — confirms unrecoverable case is detected, not silently producing empty output).
- Same CLI against a parity-mode capture produces a JSONL whose first record passes `load_obs01_trades()` and whose trade count matches the input's LAST_TRADE + MBO-action=T count (±0).
- Golden-file parity test passes: 1000 normalized trades match the validated fixture's first 1000 trades, field-by-field.
- `start_capture.py --help` shows `--parity-payload` (default: on); a fresh capture run produces a JSONL with `parity_payload` fields populated.
- Full test suite still green (504+ tests); ruff + mypy clean.
- `docs/architecture.md` D-006 written; `docs/operations.md` troubleshooting entry added.

**Out of scope**:
- Backfilling 2026-05-19 capture (confirmed unrecoverable — `raw_present: false` and no parity).
- Adding a `--raw` opt-in flag for forensic debugging (defer; trivial follow-up if needed).
- Reconciliation of normalized output against the QFA sidecar's `event_journal.py` output beyond the golden-file fixture (the fixture *is* the QFA sidecar's output, so a passing parity test transitively validates against it).

---

# Risks (updated)

1. **Rithmic credentials / connection stability** — engineer needs test account access. Mock SDK for unit tests; integration tests need real connection.

2. **Schema drift** — `zone_schema.json` is the source of truth. Versioned via `schema_version` field; bump on incompatible change.

3. **Storage budget (empirical, corrected)** — Sizes per `docs/jsonl-inspection-report.md` (`wc -l` + `dir` against the validated 37-min RTH fixture):
   - obs01: 36 MB / 37 min ≈ 1.0 MB/min
   - MBP1: 342 MB / 37 min ≈ 9.3 MB/min
   - MBO: 520 MB / 37 min ≈ 14.1 MB/min
   - **Lean stack raw**: ~898 MB / 37 min ≈ 24.3 MB/min at RTH volume
   - **Daily (14h RTH+Globex, Globex ~⅓ RTH per-minute volume)**: ~14–18 GB/day raw
   - **30 days × 18 GB ≈ 540 GB raw worst case**
   - After gzip (MBO compresses ~5–8×, MBP1 ~3–4×, OBS-01 ~6×): warm tier ~80–110 GB for 30 days
   - **Full stack with MBP10** adds ~28 GB/session uncompressed → ~840 GB raw monthly, ~150 GB compressed
   - **Pre-go-live check**: validate Neel's disk has ≥250 GB free for lean stack with safety margin, ≥1.2 TB for full

4. **Absorption tuning iteration** — RA-015 has 12h estimate. Add ~1 day buffer for parameter sweep against real fixtures once captured.

5. **Contract rollover blind spot** — addressed by RA-007 + RA-025. Critical to validate before continuous capture goes live (today is 5/15/2026; next roll is 6/12/2026, ~4 weeks out).

6. **Timestamp source consistency** — all analytics features bucket by `payload.exchange_event_ts_ns`, NOT `payload.sidecar_recv_ts_ns`. Mixing causes subtle off-by-microseconds bugs. Documented in `feature_reference.md` and enforced by `core/loader.py` emitting `event_ts_ns` as the primary timestamp column.

---

# Ticket summary table (updated)

| ID | Title | Phase | Priority | Estimate | Dependencies |
|---|---|---|---|---:|---|
| RA-001 | Scaffolding + contract metadata | 1 | P0 | 4h | — |
| RA-002 | OBS-01 JSONL loader (corrected) | 1 | P0 | 5h | RA-001 |
| RA-003 | Volume Profile compute | 1 | P0 | 6h | RA-002 |
| RA-004 | Zone JSON schema (new design) | 1 | P0 | 5h | RA-003 |
| RA-005 | ATR(14) from ticks | 1 | P1 | 3h | RA-002 |
| RA-006 | CLI compute_vp | 1 | P0 | 3h | RA-002–RA-005 |
| RA-007 | Probe wrapper + rollover calendar | 2 | P0 | 8h | RA-001 |
| RA-008 | File rotation | 2 | P1 | 4h | RA-007 |
| RA-009 | Gap alerter (NDJSON) | 2 | P1 | 5h | RA-008 |
| RA-010 | Daily zones orchestrator | 2 | P0 | 5h | RA-006, RA-007, RA-008 |
| RA-011 | Task Scheduler setup | 2 | P1 | 3h | RA-007, RA-010 |
| RA-012 | Capture dashboard | 2 | P2 | 6h | RA-009 |
| RA-013 | True CVD | 3 | P0 | 4h | RA-002 |
| RA-014 | Footprint compute | 3 | P1 | 5h | RA-013 |
| RA-015 | Absorption detection | 3 | P0 | 12h | RA-013, RA-014 |
| RA-016 | Sweep detection | 3 | P2 | 6h | RA-002 |
| RA-017 | Hidden liquidity inference | 3 | P2 | 8h | RA-002 |
| RA-018 | CVD HTML viewer | 3 | P1 | 4h | RA-013 |
| RA-019 | Footprint HTML viewer | 3 | P1 | 8h | RA-014 |
| RA-020 | Retrofit JSON output to MNQ-Futures | 3 | P0 | 10h | RA-010, RA-013, RA-015 |
| RA-021 | Multi-session aggregator | 4 | P1 | 6h | RA-003, RA-010 |
| RA-022 | Daily HTML report | 4 | P1 | 8h | RA-018, RA-019, RA-021 |
| RA-023 | Interactive notebook | 4 | P2 | 6h | all above |
| RA-024 | Documentation pass | 4 | P0 | 12h | all above |
| RA-025 | Rollover playbook | x-cut | P1 | 4h | RA-007, RA-008 |

**Total**: 150 hours = ~4 weeks for a focused engineer; 5.5 weeks with normal overhead.

---

# Suggested execution order (revised)

## Sprint 1 (6 working days) — Phase 1 + Phase 2 core
RA-001 → RA-002 → RA-003 → RA-004 → RA-005 → RA-006 → RA-007 → RA-008 → RA-010

**38h across 9 tickets** — 6 days at ~6.5h productive coding/day. Adequate slack for tuning RA-003 against TV references and resolving the inevitable JSONL parsing edge cases in RA-002.

Outcome: automated nightly zone JSON generation from Rithmic captures.

## Sprint 2 (5 days) — Phase 2 polish + Phase 3 core
RA-009 → RA-011 → RA-013 → RA-014 → RA-015 → RA-025

**38h across 6 tickets** including the heavy RA-015. Adequate slack.

Outcome: continuous capture reliable; CVD + absorption flowing.

## Sprint 3 (5 days) — Phase 3 viewers + Phase 4 multi-session
RA-018 → RA-019 → RA-020 → RA-021 → RA-022

**42h across 5 tickets** — tight; RA-020 (10h) is the integration ticket and may stretch.

Outcome: daily HTML report; multi-session view; Neel's existing scripts emit canonical JSON.

## Sprint 4 (4 days) — P2 tickets + docs
RA-016 → RA-017 → RA-012 → RA-023 → RA-024

**38h across 5 tickets** including 12h docs ticket.

Outcome: feature-complete and handoff-ready.

---

# Sprint 9 — Reactive: scale + precision gaps surfaced by 2026-05-21 RTH analysis

> **Context**: post-RTH analysis on 2026-05-21 surfaced two real gaps in
> the orderflow stack. RA-035 pressure compute exceeded 15 minutes on
> today's high-MBO-cardinality RTH (synthetic perf test was 7.5s at
> 5M rows; yesterday's Globex ran in 40s at 4.4M rows — today's RTH
> blew up non-linearly, confirming the RA-035 sweep hypothesis about
> order_id cardinality dominating groupby fanout). Separately, the
> RA-041 ship report flagged that the existing absorption ``mbp1_stale``
> predicate is NaN-only; post-RA-041 the file has near-zero NaN so the
> predicate's "stale" signal is structurally unreachable — temporal
> recency is the real freshness check we want.

## RA-042 · MBO pressure compute performance fix (numpy.searchsorted lifecycle resolution)
**Priority**: P1 — operational gap (no usable pressure data on 2026-05-21 RTH).
**Estimate**: 3-4 hours
**Dependencies**: RA-035 (compute_order_pressure shipped; baseline numerics for regression check)

**Description**: The existing ``compute_order_pressure`` implementation
resolves order lifecycles via pandas groupby on ``order_id``. The
synthetic perf test uses ~10K unique orders / 5M rows (0.2% cardinality);
real RTH data on 2026-05-21 likely had 100K+ unique orders against
15-20M MBO rows (~1% cardinality), and the runtime exceeded 15 minutes
on standalone ``cli.compute_pressure``. daily_zones pressure emit also
failed, producing no spoof-score artifact for the session.

Replace the per-order groupby with a single-pass numpy.searchsorted-based
resolution: sort MBO events by ``order_id`` then ``event_ts_ns``,
identify lifecycle boundaries via index gaps, vectorize the add → cancel
duration calc. Target runtime: <60s on 20M-row MBO at 1% cardinality.

**Files to modify**:
- ``rithmic_analytics/features/order_pressure.py`` — lifecycle
  resolution rewrite. Keep the public API surface (``compute_order_pressure``
  signature, ``OrderPressureSeries`` shape) byte-exact.
- ``tests/test_order_pressure.py`` — add a regression case that
  byte-compares output against the current implementation on a
  fixture-scale input (~100K rows). All existing tests must still pass.
- ``tests/test_order_pressure.py`` — add a new perf gate at 20M-row
  synthetic input (skipif slow). Budget 60s.

**Critical design decisions**:

1. **Backward-compat byte-exact on numeric output** — the regression
   test against the validated 100K-row fixture is the load-bearing
   safety contract (mirrors the RA-039 byte-exact gate pattern).

2. **No external dependency** — numpy.searchsorted + numpy.diff are
   stdlib-via-numpy; don't reach for pyarrow or cython.

3. **Cardinality diagnostic** — add ``n_unique_order_ids /
   n_input_events`` to the INFO log so future perf regressions can be
   detected from the daily_zones audit trail.

**Acceptance**:
- All existing order_pressure tests pass (byte-exact numerics).
- New 20M-row perf test green at <60s.
- daily_zones pressure emit completes on 2026-05-21 RTH (re-run via
  delete-cached-sibling + force re-normalize workflow).
- ruff + mypy clean.

**Out of scope**:
- Streaming/chunked pressure compute (defer if the rewrite doesn't
  bound peak memory at full RTH scale).
- Changing the public OrderPressureSeries schema.

---

## RA-043 · Temporal-recency `mbp1_stale` predicate for absorption
**Priority**: P2 — precision improvement, not a blocker.
**Estimate**: 1 hour
**Dependencies**: RA-041 (clean two-sided MBP1 baseline so the NaN signal
is genuinely near-zero; without that we can't disentangle the two paths).

**Description**: ``compute_absorption_events`` currently defines
``mbp1_stale`` as ``merged["ask_px_00"].isna()``. Pre-RA-041 this was
already 0% on real captures (raw values were ``0.0``, not NaN — the
delta-stream artifact); post-RA-041 the file is ~100% two-sided so
``isna()`` is still ~0%. Either way the predicate's "stale" path is
structurally unreachable on real data.

The freshness check we actually want: did the asof-merge pull an MBP1
record more than ``mbp1_stale_seconds`` (default 5s, matching the
config) older than the trade bar? When yes → mbp1_stale=True →
displacement factor zeroed in the four-factor score.

Add an explicit temporal-recency check during the asof merge:
``trade_bar_ts - mbp1_record_ts > stale_threshold_ns``. Preserve the
existing NaN check as a secondary safety net.

**Files to modify**:
- ``rithmic_analytics/features/absorption.py`` — add the temporal check
  alongside the NaN check.
- ``tests/test_absorption.py`` — add cases: (1) stale MBP1 (gap > 5s)
  flagged, (2) fresh MBP1 (gap < 5s) not flagged, (3) NaN ask still
  flagged for backward compat, (4) regression on the synthetic fixture
  showing mbp1_stale counts shift sensibly.

**Acceptance**:
- New temporal-recency cases pass.
- Existing absorption tests pass (no regression in NaN-stale handling).
- ruff + mypy clean.

---

# Open questions (engineer should resolve early)

1. Zone JSON drop path — `D:\MNQ-Futures\tools\data\` or `rithmic_analytics\data\zones\`? (Affects RA-010 default)
2. Notification channel — Pushover, Discord webhook, email, none?
3. RTH/Globex zones separately or combined?
4. Multi-symbol support timeline (MNQ first; NQ/ES later?)
5. Backtest framework integration — separate project?

---

# Skills required

- **Strong Python** (typing, pandas, numpy, dataclasses)
- **Market microstructure** — MBO/MBP10, aggressor side, CVD, queue position
- **Futures markets** — ticks, sessions, **contract rollovers** (newly emphasized)
- **Windows tooling** — Task Scheduler, PowerShell (Phase 2)
- **HTML/Plotly** for viewer phase
- **Test discipline** — ≥80% coverage on `features/` and `core/`; synthetic fixtures for nondeterministic features (absorption, sweep)

**NOT needed**: Rust/Cython, real-time streaming, front-end frameworks.
