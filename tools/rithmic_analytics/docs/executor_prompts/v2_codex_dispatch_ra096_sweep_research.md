# Codex Dispatch — RA-096: empirical sweep-continuation research (EDA on captured corpus)

Coordinator dispatch. Read `v2_codex_handoff.md` for invariants. Pre-build sweep → green-light → build → verify → ship.

**Status:** Independent of RA-093b training; can run in parallel. Uses existing capture JSONL on disk. No live data dependency, no contract change, no detector change.

## Why this exists

Operator intuition: "price moves quick after a sweep." That intuition is partly right (continuation sweeps) and partly wrong (liquidity-grab sweeps that immediately fade). Today, the dashboard fires sweep events with `intensity_score` + `recovered_within_5min` but there is **no empirical answer** to:

1. **Per-level continuation rates**: does a sweep through VPOC continue more often than a sweep through VWAP+1σ? Through an LVN? The dashboard treats all structural levels uniformly; the data may say otherwise.
2. **Imbalance-conditional rates**: when a sweep fires aligned with CVD direction (and/or aggressor-flow direction), does its continuation rate rise meaningfully? The operator has both signals but no way to combine them quantitatively.
3. **Cluster effect (compression-to-break)**: when a level has been swept N times in the last 10 minutes (compression pattern), does the (N+1)th sweep continue more often than an isolated sweep?
4. **Intensity saturation magnitude**: `intensity_score` caps at 5.0. A 15-tick sweep and a 50-tick sweep both score 5.0 in the display. Does the raw `moved_ticks` predict continuation differently than the capped score?
5. **Time-of-day effect**: open vs morning vs lunch vs close — do continuation rates differ by session bucket?

RA-093b will eventually answer these implicitly via a calibrated model, but (a) it needs months of data for statistical power per cell, and (b) the per-question EDA gives operator-readable answers in ways a logistic-regression coefficient table never will. This ticket produces the empirical baseline that RA-093b's model design should be informed by, AND the operator-readable narrative document that's the actual product.

## Build

### 1. Module location + CLI

New module: `services/scalp_models/scalp_models/research/sweep_strategy.py` (importable), plus `python -m scalp_models research sweep ...` subcommand wired through `cli.py`.

CLI shape:

```
python -m scalp_models research sweep \
  --pair 2026-05-19:rth --pair 2026-05-25:rth --pair 2026-05-27:rth ... \
  --out-root D:/Quant-futures-app/scratch/ra096-sweep-research \
  --target-ticks 4 \
  --horizons-seconds 1,5,15,60,300 \
  --min-cell-samples 30
```

Repeats `--pair` for each `(date, session)` to include. The CLI parses, builds a `SweepResearchConfig`, calls `run_research(config)`, writes a run-dir + report.

Reuse existing helpers from `pipeline.py` where possible: `parse_pair`, `sessions_from_date_range`, the capture-not-active guard, the run-id hashing. No new orchestration patterns.

### 2. Data ingestion

For each session pair:

- Read normalized obs01 from `tools/rithmic_analytics/data/captures/<date>/MNQ_<session>.obs01.jsonl` (already on disk for all captured sessions; do not re-normalize).
- Load the daily zones JSON for that date (`tools/rithmic_analytics/data/daily_zones/...` — confirm exact path during sweep) to get VPOC, VWAP, VAH, VAL, HVN, LVN, σ-shelf levels.
- Run the dashboard's `sweep_detector.detect_sweeps()` over the obs01 tick stream + zone level set. Reuse — do NOT re-implement detection. Use the existing dashboard detector even though the analytics detector also exists; the dashboard detector is what's shipping to operators and what RA-094 will score.
- Collect: list of `SweepEvent` rows enriched with the structural level metadata (level type: VPOC/VWAP/VAH/VAL/LVN/HVN/σ-shelf; tick-distance from session VPOC; etc).

#### Session-completeness provenance (forensic-integrity gate)

Every ingested session MUST carry an `is_complete_session` boolean provenance flag, set during ingestion. The check is the conjunction of:

1. **Capture not currently active** (the existing `_assert_capture_not_active` guard handles the live-conflict case at config time; redundant here is fine for defense-in-depth).
2. **Capture mtime stale** beyond a session-end threshold: for `rth` sessions, the obs01.jsonl file's last write must be after the session's official close + a buffer (e.g., 13:15 PT + 5 min for RTH); for `globex` sessions, the file's last write must be after the next day's RTH open OR explicitly flagged complete.
3. **No mid-session gap detected**: scan the obs01 timestamps; if there's a contiguous gap of > 60 seconds during regular session hours (i.e., a capture interruption that didn't auto-recover), mark incomplete.
4. **Expected event-count floor**: a completed RTH session has thousands of obs01 records; a truncated one has hundreds. Per-session-type heuristic floor (Codex sweep proposes the exact threshold based on observing complete sessions). Below the floor → `is_complete_session=False`.

All four checks pass → `is_complete_session=True`. ANY check fails → `is_complete_session=False` with a `completeness_reasons: list[str]` recording which.

Propagation:
- Every emitted sweep event row carries `is_complete_session` + `completeness_reasons` from its source session.
- `sweep_events.jsonl` (the per-event provenance file) records both fields per row.
- `pipeline_manifest.json` records per-session: `is_complete_session`, `completeness_reasons`, `obs01_record_count`, `obs01_first_ts_ns`, `obs01_last_ts_ns`.

Default behavior:
- Partial sessions are **EXCLUDED** from the main analysis tables in `sweep_research_report.md`.
- An optional CLI flag `--include-partial-sessions` re-enables them, BUT they appear ONLY in a clearly-labeled SEPARATE section titled "Preliminary findings — partial sessions" that does NOT mix into the main tables. Sample counts and rates are reported separately so the operator can spot the contamination.
- The default report header lists "Sessions analyzed: N complete, M partial (excluded)" so the operator sees at a glance how much data the headlines are computed on.

Rationale: a partial session can't compute forward-return labels for sweeps near its truncated end (a sweep at 22:50 PT can't be labeled at τ=300s if the capture stops at 23:10). Even if forward-returns are computable for early-session sweeps, the truncation systematically biases the sample — late-session events are missing AND structural levels derived from the full session (VPOC, VAH/VAL) are recomputed from incomplete data. Mixing partial + complete sessions in the same table without a flag would silently bias every headline rate in this report.

### 3. Forward-return labeling

For each sweep event, compute forward returns at each horizon `τ ∈ {1s, 5s, 15s, 60s, 300s}`:

- `forward_return_ticks(τ) = (price_at_t+τ - price_at_t) / TICK_SIZE`, signed by sweep direction (so a buy-sweep that goes up gives a positive value).
- `continued(τ) = forward_return_ticks(τ) ≥ target_ticks` (default 4).
- `reversed(τ) = forward_return_ticks(τ) ≤ -target_ticks`.
- `pushed(τ) = neither continued nor reversed`.

Reuse `apps/backtester/src/forward-return-labels/` as the canonical labeler IF practical from Python (it's TS — confirm in sweep whether the Python research script calls it via subprocess or re-implements the same math). Coordinator lean: **call the TS labeler via subprocess to keep the canonical reference single-source**. Per-event overhead is fine; this is research, not a live path.

### 4. Five analytical questions — each produces a Markdown section + a JSON table

**Q1. Per-level continuation rates**

Group sweeps by `level_type` (VPOC, VWAP, VAH, VAL, +1σ, -1σ, HVN, LVN). For each group × horizon:
- Sample count (drop cells with `n < min_cell_samples`)
- `P(continued | level_type, τ)` with Wilson 95% CI
- `P(reversed | level_type, τ)` with Wilson 95% CI
- Difference vs baseline (all-levels-pooled rate)

Report table: rows = level types, columns = horizons. Cells = `0.62 [0.55, 0.69] n=78`.

**Q2. Imbalance-conditional rates**

For each sweep, sample the pre-sweep imbalance signals over a lookback window (default 60s before sweep):
- `cvd_direction_aligned`: did pre-sweep CVD move in the same direction as the sweep? (Bool)
- `cvd_magnitude_quartile`: |Δ CVD over 60s pre-sweep| quartile, session-normalized
- `aggressor_flow_aligned`: was the dominant aggressor flow (liftAsk vs hitBid) over 1m pre-sweep aligned with sweep direction? (Bool)
- `aggressor_ratio_quartile`: aggressor-flow ratio quartile, session-normalized
- `footprint_imbalance_aligned`: was the stacked-footprint imbalance (if any in last 30s) aligned? (Bool, can be None)

For each binary alignment × horizon: `P(continued | aligned=True, τ)` vs `P(continued | aligned=False, τ)`, with confidence intervals and a chi-squared independence test (with Bonferroni correction across the 5 conditions).

Output: a 2×2 contingency table per condition + a "ranked-by-edge" summary.

**Q3. Cluster effect (compression-to-break)**

For each sweep, compute `prior_sweep_count_10m_same_level` = number of sweeps in same direction at the same `level_id` (or within ±2 ticks of `level_price`) in the prior 10 minutes.

Bucket: `isolated (0)`, `compression (1-2)`, `cluster (3-4)`, `heavy_cluster (5+)`.

For each bucket × horizon: continuation rate with CI. Coordinator hypothesis: continuation rate rises monotonically with cluster size. Confirm or refute empirically.

**Q4. Intensity saturation magnitude**

The `intensity_score` is `clip(moved_ticks / 3.0, 1.0, 5.0)`. Bucket sweeps by `moved_ticks` (not by `intensity_score`):
- `small`: 3-6 ticks
- `medium`: 7-11 ticks
- `large`: 12-19 ticks
- `extreme`: 20-50 ticks
- `flush`: 50+ ticks (likely session events, may exclude via `max_levels_swept=50` gate already in detector)

For each bucket × horizon: continuation rate with CI. Coordinator hypothesis: continuation rate keeps rising past intensity=5.0; the saturation is hiding signal. Test it.

Bonus output: a scatter plot script (`matplotlib`, save PNG to run dir) of `moved_ticks` vs `forward_return_ticks(60s)` to visualize the relationship.

**Q5. Time-of-day effect**

Bucket sweeps by session timestamp in America/Los_Angeles (operator timezone):
- `pre_market` (RTH only): before 06:30 PT
- `open` (RTH only): 06:30 - 07:30 PT
- `morning`: 07:30 - 10:00 PT
- `lunch`: 10:00 - 12:00 PT
- `afternoon`: 12:00 - 13:00 PT
- `close` (RTH only): 13:00 - 13:15 PT
- For Globex: similar buckets adapted to session structure

For each bucket × horizon: continuation rate with CI. Operator interest is identifying time windows where sweeps are systematically more (or less) reliable.

### 5. Output: `sweep_research_report.md`

Run-dir layout:
```
scratch/ra096-sweep-research/<run-id>/
├── sweep_research_report.md          ← the operator deliverable
├── conditional_tables.json           ← machine-readable tables for all 5 Qs
├── sample_counts.json                ← per-cell n's, for sample-size auditing
├── sweep_events.jsonl                ← all enriched events used in the analysis (provenance)
├── scatter_intensity_vs_return.png   ← Q4 visual
└── pipeline_manifest.json            ← provenance chain (reuse pattern from pipeline.py)
```

Report structure:
1. **Run metadata**: dates analyzed, **N complete sessions + M partial sessions (excluded by default)**, total sweeps in main analysis, total sweeps in preliminary section (if `--include-partial-sessions`), model commit, sklearn version
2. **Session-completeness summary table**: per-session row with `(date, session, is_complete, completeness_reasons, sweep_count)`. Operator reads this first to know which sessions contributed.
3. **Summary findings** (the operator-readable top): 5 bullet headlines, one per question, written in plain English ("VPOC sweeps continue 62% of the time vs 47% for VWAP±σ at 60s horizon — empirical edge."). Each headline notes the underlying complete-session sample count.
4. **Per-question section** (one per Q1-Q5): tables + brief interpretation + sample-size warnings where applicable. **Main tables use complete sessions ONLY.** If `--include-partial-sessions` was set, a clearly-labeled "Preliminary — partial sessions" sub-section follows.
5. **Statistical hygiene section**: which cells crossed `min_cell_samples` threshold, which didn't, multiple-comparison corrections applied, confidence interval methodology (Wilson scores)
6. **Actionable next steps**: which findings warrant a model feature, which warrant a separate ticket, which need more data

### 6. Statistical hygiene (non-negotiable)

- **Wilson 95% confidence intervals** for all proportions, not normal-approximation intervals. The proportions are bounded [0,1] and sample sizes will often be small — Wilson is correct there.
- **Bonferroni correction** for the chi-squared independence tests in Q2 (5 alignment conditions × 5 horizons = 25 tests; α / 25 ≈ 0.002 for family-wise α=0.05).
- **`min_cell_samples` floor** (default 30): cells below this are reported as `n=K (below floor)` with the rate but NO confidence claim. Do NOT hide these — they're informative for "how much data do we need?"
- **Baseline rate** for each question: report the all-sweeps-pooled rate as the comparison anchor. Edge is measured relative to baseline, not absolute.
- **Distinguish "no edge" from "insufficient data"**: a cell with n=200 and rate matching baseline is informative (no edge there). A cell with n=8 is not. Don't conflate them.

### 7. Tests

- `services/scalp_models/tests/research/test_sweep_research.py` (new):
  - Fixture: synthetic obs01 JSONL with 10 known sweeps, 5 continuing + 5 reversing, scattered across 2 levels.
  - Assert: continuation rate computed = 0.5, per-level rates differ as designed, Wilson CI brackets the true rate within the fixture's bounds.
  - Smoke test: end-to-end CLI invocation produces all 5 output files without crash.
- No test for the actual numerical findings on real data — those ARE the deliverable, not the test.

## Hard invariants

- **Read-only on captures.** Never touch `capture-rithmic-probe.py`, scheduler, `.env`, normalization. This is a pure analysis pass.
- **No detector changes.** Reuse `rithmic_dashboard.features.sweep_detector` verbatim. If the detector has bugs, fix in a separate ticket — this ticket measures what the live shipping detector emits.
- **No contract change.** Research script consumes existing JSONL on disk.
- **Reuse the canonical forward-return labeler.** Subprocess to `apps/backtester/src/forward-return-labels/` CLI (which RA-093b's pipeline already proved works). Do NOT re-implement label math in Python.
- **Surgical path-scoped commit.** Stage only `services/scalp_models/scalp_models/research/`, `services/scalp_models/scalp_models/cli.py` (subcommand wiring), `services/scalp_models/tests/research/`, and `tools/rithmic_analytics/docs/executor_prompts/v2_codex_dispatch_ra096_sweep_research.md` (this file, if updated).
- **Provenance chain.** Hash-chain the inputs → outputs same way `pipeline.py` does. The `pipeline_manifest.json` must record the SHA-256 of every input obs01 + the produced report. Re-running the same command over the same data produces byte-identical report content (modulo timestamps in the run metadata header).

## Pre-build sweep gate

Sweep must cover:

1. **CLI shape final** — confirm `python -m scalp_models research sweep --help` is the right invocation. If it conflicts with the existing `pipeline` subcommand structure, propose an alternative.
2. **Daily zones location + schema** — point to the exact path + JSON schema for the zone files. If `level_type` taxonomy isn't already in the zone JSON (VPOC/VAH/VAL/HVN/LVN naming), this ticket needs a small schema audit first.
3. **Subprocess shape for label CLI** — show the exact `apps/backtester/src/forward-return-labels/cli.ts` invocation, including how sweep events become its input format. If a shim is needed (the labeler expects RA-092 setup format, not sweep events), document the shim.
4. **Statistical methodology confirmation** — Wilson CI library (`statsmodels.stats.proportion.proportion_confint` with `method='wilson'` is canonical), chi-squared test source (`scipy.stats.chi2_contingency`), Bonferroni application point.
5. **Sample size reality check** — given 5-7 sessions of data, what's the expected sweep count per session? Per level type? Per (level, alignment, horizon) cell? If most cells will be below the `min_cell_samples=30` floor, recommend lowering to 15 with explicit "preliminary" flag, OR running the analysis at coarser bucketing (drop the Q5 time-of-day split until more data exists).
6. **Session-completeness check exact threshold values** — propose the per-session-type mtime cutoff (e.g., RTH session: obs01 mtime > 13:20 PT same day), the mid-session gap threshold (60s default), and the obs01 record-count floor by observing the already-captured complete sessions on disk. Show the values + the reasoning. ALL captured sessions on disk at sweep-time must be auditable as complete/partial before the main analysis runs.
7. **Confirmation no detector/contract/capture/probe touch.**

## Acceptance

- `sweep_research_report.md` exists in the run dir.
- **Session-completeness summary table** appears at the top of the report, listing every input session with its `is_complete_session` flag + reasons. Operator can audit which sessions contributed to which numbers.
- Main analysis tables use **complete sessions only by default**. Partial-session inclusion requires `--include-partial-sessions` AND those results appear in a separately-labeled "Preliminary findings" section that does NOT mix into main tables.
- `sweep_events.jsonl` records `is_complete_session` + `completeness_reasons` per row.
- `pipeline_manifest.json` records per-session `is_complete_session`, `completeness_reasons`, `obs01_record_count`, `obs01_first_ts_ns`, `obs01_last_ts_ns`.
- All 5 questions have a section, with tables, sample sizes, and a plain-English headline.
- The summary findings at the top of the report contain at least 5 bullet sentences an operator can read in 30 seconds. Each headline's underlying sample count is from complete sessions only (unless explicitly labeled preliminary).
- `conditional_tables.json` is parseable + complete.
- `pipeline_manifest.json` records the SHA-256 chain.
- `pytest services/scalp_models/tests/research/` passes (the fixture smoke test, including a test that asserts a synthetically-truncated session ingestion → `is_complete_session=False`).
- `ruff` clean, `mypy` targeted clean, `pytest` clean.
- Ship report includes the **actual `sweep_research_report.md`** content in the PR description (the operator reads this; the dispatch isn't done if the file is empty).
- Ship report explicitly states which findings are statistically significant vs which are below sample threshold, AND how many complete vs partial sessions contributed.

## Coordinator review focus

The headline of the ship report is the **summary findings** section of the produced report. The coordinator wants to see operator-actionable empirical statements, not statistical jargon. Examples of acceptable findings:

- "**VPOC sweeps continue at 62% (95% CI [55%, 69%]) vs 47% baseline** at the 60s horizon. Strongest level identity edge in the dataset (n=78)."
- "Sweep + aligned-CVD continues 71% vs sweep + opposing-CVD at 39%. The chi-squared difference is significant at α=0.002 (Bonferroni-corrected)."
- "Cluster effect confirmed: isolated sweep continues 51%, after 3+ prior sweeps at same level the rate is 68%."
- "Intensity-saturation hides signal: above moved_ticks=20 the continuation rate is 74% vs the capped intensity=5.0 cohort's 62%. The cap is throwing away data."
- "Time-of-day effect: morning sweeps (07:30-10:00 PT) continue 65%; lunch sweeps (10:00-12:00 PT) continue 41%. Significant difference, but n's are small per session."

Examples of UNacceptable findings:
- "The chi-squared statistic was 4.7, p < 0.05." — operator can't act on this.
- "P(continued | x) = 0.62." — without CI + sample size + comparison to baseline, meaningless.
- "Results were not significant." — without showing what the rate WAS and how big a sample would be needed.

The report should also be **honest about insufficient data**. Many cells WILL be underpowered with 5-7 sessions. List them by name + estimated sample size needed.

## Priority

Independent of RA-093b training. Independent of RA-094 dispatch. Codex can ship in parallel.

Coordinator priority: **HIGH for operator strategy research**, MEDIUM for the critical scalping path. The report is actionable on its own (operator can adjust live decisions based on findings) AND informs RA-093b's feature-set design + RA-094a's threshold lock-in (e.g., if VPOC sweeps are systematically different, the model may benefit from per-level-type sub-models).

## Future option (out of scope; for the operator)

If Q1 (per-level rates) shows strong heterogeneity, RA-097 could implement **per-level-type sub-models** in the RA-093 trainer — separate calibrated logistic per `(setup, level_type, horizon)` instead of just `(setup, horizon)`. This would 5-10x the parameter count and require 5-10x more data per cell to populate, but if the findings justify it, the model improvement is real.

If Q4 (intensity saturation) confirms data loss, a fast follow could either (a) desaturate the `intensity_score` formula or (b) add a separate `moved_ticks_raw` field on the dashboard's `SweepEvent`. Contract decision — defer to a separate dispatch.
