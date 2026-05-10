# QFA-410b Real-Archive Held-Out Execution

## Status

QFA-410b extends QFA-410 from a framework-only held-out validation shell into an orchestrator that can execute QFA-201c real-archive strategy runs over walk-forward test windows.

The integration shape is Option B: `executeHeldOutValidationAgainstArchive()` is added alongside the existing `buildHeldOutValidationResult()` and `runHeldOutValidation()` surfaces. Existing framework-only behavior remains unchanged.

## Step 0 result

- Base: post-PR #166 main (`7d5025a`).
- ADR-0010 through ADR-0016 are present.
- Tier A operational archive and repo-internal manifest copies are present locally.
- `artifacts/regime/regime-labels.json` is present.
- Active roster remains the four Cycle1 strategies.
- QFA-201c real-archive execution is available through `apps/backtester/src/real-archive-execution/`.
- Held-out validation was still framework-only before this ticket.

## Architecture

`executeHeldOutValidationAgainstArchive()` accepts:

- `run_id`
- QFA-410 `input_spec`
- `walk_forward_plan`
- `strategy_order`
- archive session sources
- run timestamp and optional fill policy

For each strategy and each walk-forward test window, it:

1. Selects test-window sessions from the archive session source map.
2. Calls `runRealArchiveBacktest()` from QFA-201c.
3. Preserves full per-trade metadata emitted by QFA-201c.
4. Builds validation-window metrics from QFA-204 trade summaries.
5. Builds real-archive strategy fingerprints and ready-for-replay capability assessments.
6. Calls the existing QFA-410 framework builder so the result still carries OOS and validation-gate outputs.

## Per-trade metadata

QFA-410b preserves the QFA-201c per-trade schema needed by QFA-611-evidence and later PR-4 schema formalization:

- `strategy_id`
- `session_id`
- `regime_label`
- `side`
- `entry_ts_ns`
- `exit_ts_ns`
- `pnl_cents`
- `spread_bucket`
- `queue_ahead_bucket`
- `exit_reason`
- `exit_bar_index`
- `max_favorable_excursion_cents`
- `max_adverse_excursion_cents`

Gross/net PnL distinction is still formalized downstream in the QFA-611 evidence schema. QFA-410b preserves QFA-204 trade summaries and QFA-201c net per-trade PnL as the upstream source.

## Streaming compliance

QFA-410b delegates archive reading to QFA-201c, which streams DBN-backed trade and MBP-1 records per session. The held-out orchestrator holds only per-window execution results and summary artifacts in memory.

## Determinism

QFA-410b derives fingerprints with deterministic SHA-256 over stable JSON with bigint string normalization. The unit fixture invokes the real-archive path twice and verifies byte-stable strategy records.

## Limits

- The real archive integration test remains local-only because the operational Tier A cache is not present in CI.
- QFA-410b does not write final QFA-611 evidence artifacts; that remains QFA-611-evidence / PR-4 territory.
- QFA-410b does not change strategy parameters, validation thresholds, QFA-105, QFA-201c, QFA-203, QFA-204, or determinism CI.

