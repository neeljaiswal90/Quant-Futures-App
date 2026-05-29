# Future Work — deferred items + enhancement notes

Items here are **out of scope for the current sprint** but called out so they
aren't lost. Each item should be promotable to its own ticket if/when the time
comes.

## Deferred validation passes

These are real-data checks that depend on external reference material (Bookmap
screenshots, R|Trader replays, annotated absorption events). The structural and
synthetic-fixture tests gate ticket completion; these are the operational
validation that follows once reference data is available.

1. **RA-002 OBS-01 loader — 5-timestamp spot checks against Bookmap reference.**
   Stub: [`tests/test_loader_spot_checks.py`](../tests/test_loader_spot_checks.py).
   Currently marked `@pytest.mark.skip`. To activate:
   - Capture 5 Bookmap screenshots at well-spaced timestamps inside the loaded
     fixture's window (2026-04-27 10:50–11:25 EDT).
   - Read off `(event_ts_ns, price, signed_qty)` for one trade visible in each.
   - Fill `SPOT_CHECKS` and remove the `pytest.mark.skip` decorator.

2. **RA-015 absorption detector — real-data annotated cases.**
   Synthetic fixture gates the ticket. Once a captured session contains a
   confirmed absorption event, document the timestamp in
   `docs/known_absorption_cases.md` and add a second fixture test against it.

## Documentation gaps closed in RA-024

Items 3–5 below were doc gaps surfaced during build-out. RA-024 closed all
three. Kept here as a paper trail; see the listed destination for current
content.

3. **`atr_14: null` is a real wire-format value.** ✅ Closed —
   [`feature_reference.md` → `core.schema`](./feature_reference.md#atr_14-null-is-a-real-wire-value-not-a-test-edge-case)
   documents the null-check requirement and recommended fallback.

4. **Phase 1 zones default to `type="support"` regardless of price.** ✅ Closed —
   [`feature_reference.md` → `core.schema`](./feature_reference.md#phase-1-zone-type-resolution)
   documents the rationale + consumer-side type-flip pattern. `Zone.type`
   docstring updated.

5. **Link `absorption_methodology.md` from the main docs index.** ✅ Closed —
   [`docs/README.md`](./README.md) lists the methodology doc in its "Read in
   this order" section alongside `architecture.md` and
   `jsonl-inspection-report.md`.

## Operational gaps (deferred — track if they bite in practice)

6. **External monitoring of heartbeat task itself.** Current design
   (RA-011): `RithmicHeartbeat` fires daily at 10:00 ET and checks past
   weekdays for missing heartbeat files. If the heartbeat task entry
   itself is deleted (e.g., Windows Update wipes Task Scheduler entries),
   no alert generates because there's no fire to check. Mitigations
   ordered by cost:
   - **(a)** Cross-check from `daily_zones`: at 17:30 ET, if yesterday's
     heartbeat file is missing, log a warning. ~5 lines to add. Cheapest.
   - **(b)** Weekly summary email digest of recent heartbeats.
   - **(c)** External pingback service (UptimeRobot, healthchecks.io)
     hits a webhook each heartbeat run; alerts if the webhook goes silent.
   Defer pending operational experience. If Windows Update doesn't
   actually clobber tasks in practice, this is hypothetical.

## Cataloged hardcodes in `D:\MNQ-Futures\tools\vp_*.py` (RA-020 retrofit)

Pre-existing operational quirks Neel updates by hand for each trading day.
NOT in scope for RA-020 — surfacing here so a future generalization ticket
can address them as a group.

7. **`vp_multi_tf_full.py`**: ET timezone hardcoded to UTC-4 (EDT only — will
   produce off-by-one-hour timing during EST winter months). RTH/Globex
   window datetimes (lines ~170-178) hardcoded to 2026-05-13/14. Weekly
   summary string (line ~214) hardcoded H/L/Close values.
8. **`vp_15m_compute.py`**: `CURRENT_PRICE = 29720.0`. `EXISTING_ZONES` list
   (5m demand/supply + HTF support) hardcoded for a specific trading day.
   `REFERENCE_LINES` dict (Prior D H/C/L, Today H, Weekly AVWAP, etc.)
   hardcoded to a specific date. `ET_OFFSET = -4` (EDT-only).
9. **`vp_htf_globex_prep.py`**: `CURRENT_PRICE = 29729.0`. Daily bar
   timestamps (e.g. `1778623200` for Prior Day, `1778709600` for today)
   hardcoded. ET offset hardcoded to UTC-4.

A future ticket could parameterize these via a daily `prep.toml` config
file that's regenerated each morning from market state. Out of scope here
because the existing manual-update workflow is functional and Neel hasn't
identified it as a pain point.

## Matched-fixture build for TV-vs-Rithmic comparison (RA-020 follow-up)

10. **Multi-dimensional TV-vs-Rithmic tolerance test (RA-020 skipped).** The
    test `test_multi_dimensional_tolerance_tv_vs_rithmic` is `@pytest.mark.skip`
    pending matched fixtures. To activate:
    - Build a synthetic TV-cache JSON file covering the same 37-min window as
      the validated OBS-01 fixture (2026-04-27 RTH).
    - Run each script against both sources for that window.
    - Compare VPOC/VAH/VAL within ±1 bin, top-3 HVN set overlap ≥ 2 of 3,
      ATR(14) within 5%, total volume within 10%.
    - The synthetic-TV-cache builder is the bulk of the work; the comparison
      itself is straightforward.

## Plotly bundle deduplication for archived reports

11. **Shared `plotly.min.js` for daily reports.** RA-022 inlines the full
    Plotly bundle in each report (`include_plotlyjs=True` default) for
    portability — Neel can review reports on a flight without internet.
    Real-fixture render produces ~10.5 MB per report (Plotly bundle +
    inlined chart data). At ~30 reports/month over years, this adds up.
    Optimization for later: drop a shared `plotly.min.js` into
    `data/reports/_assets/` once; each report uses
    `<script src="../_assets/plotly.min.js">` and ships ~5 KB instead of
    ~3 MB. Net: 3 MB once + 5 KB per report. Don't build now — current
    cost is operationally trivial; revisit if archive size becomes an
    issue.

## Incremental MBP10 processing for memory efficiency

13. **Incremental MBP10 join + aggregate.** RA-017's `load_mbp10` uses
    chunked streaming during the parse (peak ~500 MB), but the resulting
    DataFrame is still ~5 GB for the full RTH session. A fully incremental
    design processes MBP10 in chunks and performs the `merge_asof` join +
    aggregation **per chunk**, never holding the full set in memory.
    Significantly more complex — chunk boundaries need careful handling
    so a trade near the chunk edge can still find its pre-trade MBP10
    snapshot from the prior chunk. Out of scope for RA-017 v1. Revisit
    if Neel's machine starts swapping during hidden-liquidity analysis.

## Enhancement notes (non-blocking)

- **Footprint hover: per-cell buys/sells split (RA-019 follow-up).** Current
  footprint viewer's hover shows net delta only. The buys/sells per-cell
  breakdown is more diagnostic ("+523/-187 = +336 net" vs just "+336") but
  requires either extending `Footprint` (`buys` + `sells` matrices alongside
  `deltas`) or recomputing in the viewer. Defer until operator feedback
  confirms it's worth the extra ~50 lines.

- **MBP10 loader.** Not part of RA-002 — only needed by RA-017
  (hidden-liquidity inference) which is P2 and opt-in due to storage cost.
  When implemented, follow the same naming convention (`event_ts_ns`,
  `recv_ts_ns`) and put the loader in `core/loader.py`.
- **Chunked streaming for very large files.** Current loaders read the whole
  file. Adequate for OBS-01 (36 MB), MBP1 (342 MB), MBO (520 MB). For MBP10
  (2.69 GB) we'll want `pd.read_json(..., chunksize=N)` or pyarrow streaming.
- **Memory budget enforcement.** RA-002 acceptance specifies <500 MB RAM.
  Current tests use `tracemalloc` (Python-tracked allocations only) with a
  generous 1000 MB proxy threshold. A proper RSS check would add psutil as a
  dev dep — defer until we see an actual memory regression.
