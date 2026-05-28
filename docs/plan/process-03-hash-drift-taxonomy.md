# PROCESS-03 hash-drift taxonomy

## Purpose

PROCESS-03 codifies the coordinator review pattern for deterministic hash drift. It is process guidance for worker reports and coordinator PR-gate review. It does not change hash algorithms, expected hashes, artifacts, ADR authority, or strategy selection rules.

This guidance extends the parent PROCESS-02 / PROCESS-02-A1 discipline:

- Workers still run the verification gates required by the ticket.
- Draft PRs still require coordinator or operator review before un-draft and merge.
- CI status still remains a PR-gate requirement when GitHub creates checks.
- Hash drift still requires evidence, not intuition.

## Hash surfaces

`final_chain_hash`

The final reproducibility chain hash covers the run spec hash and the ordered artifact hash set. It is intentionally sensitive to `run_spec_hash`, `journal_jsonl`, `trade_ledger`, `trade_pnl`, `equity_curve`, and `metrics_summary`.

`final_phase2_hash`

The Phase 2 determinism hash covers the strategy replay, strategy fingerprint set, capability assessment set, and validation gate result set used by the determinism check. For process-only, docs-only, test-only, and code changes that do not intentionally regenerate Phase 2 substrate artifacts, this hash should remain pinned.

`final_phase4_hash`

The Phase 4 hash covers the regime substrate inputs used by the determinism check. For process-only, docs-only, test-only, and code changes that do not intentionally regenerate the Phase 4 regime substrate, this hash should remain pinned.

Artifact-level SHA-256s

Artifact-level SHA-256s identify which component moved before coordinators classify the drift. The fixed repro manifest artifact order is:

1. `journal_jsonl`
2. `trade_ledger`
3. `trade_pnl`
4. `equity_curve`
5. `metrics_summary`

When `final_chain_hash` moves, workers should inspect this component list before concluding whether the shift is behavior-significant.

## Same-worktree baseline method

Use a same-worktree baseline whenever a ticket needs to compare a pre-change hash to a post-change hash:

1. Start from the intended substrate in the same checkout path.
2. Capture the baseline command, working directory, and output hashes before applying the patch.
3. Apply the patch in the same worktree path.
4. Re-run the same command from the same path.
5. Compare baseline versus branch hashes and component SHA-256s.
6. Preserve the exact command and path in the worker Step 7 report.

If a clean comparison is taken from a separate worktree, say so explicitly. A separate clean worktree can be useful, but it has not eliminated path sensitivity. Do not require cross-worktree equality as a universal gate.

Common no-drift case:

If same-worktree baseline and branch outputs are byte-equal for `final_chain_hash`, `final_phase2_hash`, and `final_phase4_hash`, record the hashes and state that no drift class is needed.

## Drift taxonomy

### Runtime / journal drift

Runtime / journal drift means emitted runtime evidence changed. Examples include event order, event payloads, decoded records, trades, fills, ledger rows, PnL, or metrics.

Default review posture:

- Treat as behavior-significant unless the ticket intentionally changed decode/runtime behavior.
- Inspect `journal_jsonl`, `trade_ledger`, `trade_pnl`, `equity_curve`, and `metrics_summary`.
- Confirm whether trade count, order, prices, exit reasons, MFE/MAE, PnL, or metrics moved.

Acceptable cases require a narrow explanation. For example, an archive decode fix may legitimately change decoded record coverage and downstream replay evidence.

### Config-input lineage drift

Config-input lineage drift means config identity changed while behavior outputs remain unchanged. Examples include management config hashes, strategy shared config hashes, roster lineage, run spec hash, derived run ID, event IDs derived from run ID, or config input lineage embedded in `BACKTEST_RUN_META`.

Default review posture:

- Require same-worktree baseline.
- Require proof that behavior outputs are unchanged.
- Check that `trade_pnl`, `equity_curve`, `metrics_summary`, cached trades, trade order, prices, exits, and PnL remain pinned when the claim is config-lineage-only drift.

This class can be acceptable when a ticket intentionally changes config shape, roster shape, or management profile lineage without changing runtime behavior.

### Evidence-surface drift

Evidence-surface drift means the emitted artifact schema, projection, content surface, or artifact set changed. It may occur without changing strategy decisions.

Default review posture:

- Require explicit PR-body or memo explanation because downstream selection, audit, or replay tooling may consume the surface.
- Identify the changed artifact and fields.
- Confirm whether selection logic consumes the new or changed fields.
- Do not use evidence-surface drift as a vague catch-all. It can coexist with runtime / journal drift or config-input lineage drift.

Evidence-surface drift can be acceptable for additive audit projection tickets, but workers must not repin artifacts silently.

## Coordinator review checklist

Recommended analysis order:

1. Rule out runtime / journal drift first.
2. Then inspect config-input lineage drift.
3. Then inspect evidence-surface drift.

Checklist:

- Confirm the baseline and branch commands were run from the same path, or record that a separate path was used.
- Confirm `final_phase2_hash` and `final_phase4_hash` are pinned unless the ticket explicitly authorizes their source substrate to change.
- If `final_chain_hash` is byte-equal, record the hash and stop classification.
- If `final_chain_hash` drifts, inventory changed components before assigning a class.
- For config-input lineage drift, verify behavior outputs remain unchanged.
- For runtime / journal drift, identify whether it is intended by ticket scope.
- For evidence-surface drift, verify downstream compatibility and document the schema/projection change.
- Reject or escalate any report that says only "hash changed" without component evidence.

## Worker Step 7 reporting template

For tickets that run determinism or compare reproducibility hashes, include:

- Baseline command and working directory.
- Baseline `final_chain_hash`, `final_phase2_hash`, and `final_phase4_hash`.
- Branch command and working directory.
- Branch `final_chain_hash`, `final_phase2_hash`, and `final_phase4_hash`.
- Drift class: none, runtime / journal, config-input lineage, evidence-surface, or multiple.
- Changed-component evidence when drift occurs.
- Behavior-preservation evidence when claiming config-input lineage-only drift.
- STOP / escalation note if phase hashes move unexpectedly or behavior surfaces move outside ticket scope.

For docs-only tickets with no determinism gate, state that no determinism command was required by scope.

## Recent examples

### PR #253: no-drift case

Ticket: `CYCLE4-MULTI-EXIT-PNL-ACCOUNTING-01`

Observed hashes:

- `final_chain_hash`: `99b94ae4685230bd6288f4672d58ad2eef0b0fc32accd80c2c1027251c6f878d`
- `final_phase2_hash`: `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b`
- `final_phase4_hash`: `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090`

Classification: none.

Reason: same-worktree baseline at `c18ed742722ff4b48c96f257fdf7212c1324e08f` matched the branch exactly. The PR renamed `TradePnl` fields and fixed multi-exit PnL accounting, but the default determinism fixture's `trade_pnl` artifact was empty, so the field rename did not materialize in that fixture.

### PR #254: runtime / journal drift from intended decode coverage

Ticket: `CYCLE4-ARCHIVE-FRAME-DECODE-01`

Observed hash:

- Branch `final_chain_hash`: `11d0a75746e364655903bab49196fc60d5a886f1b2e3512970f536f1933d5fe9`
- `final_phase2_hash`: `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b`
- `final_phase4_hash`: `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090`

Changed components:

- `2026-04-10-rth/mbp-1.dbn.zst` decoded `10,961,288` records.
- `2026-04-22-rth/mbp-1.dbn.zst` decoded `11,443,276` records.
- Formerly failed windows produced non-zero closed trades: `wf-1-4 = 177`, `wf-1-6 = 360`.

Classification: runtime / journal drift.

Reason: the ticket intentionally changed archive frame decoding. More records became available to replay, so downstream runtime evidence could change. This is not a config-lineage-only case.

### PR #260: config-input lineage drift

Ticket: `STRATEGY-IDS-RECONCILE-02`

Observed hashes:

- Same-path baseline `final_chain_hash`: `25a61d9007bafff7b3e161ea32d69e47bcc39feb133b1b73508414eb941bb77f`
- Branch `final_chain_hash`: `206e3eb1b4b37015dd9d998edd2cf9afac38f9f82801d3b66b1d3ee5e91e25bb`
- `final_phase2_hash`: `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b`
- `final_phase4_hash`: `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090`

Changed components:

- Management config / run-spec lineage changed after the active roster was reconciled to zero-active and the management profile YAML became an explicit zero-active shape.
- Cached trades, `trade_pnl`, `equity_curve`, and `metrics_summary` remained unchanged.

Classification: config-input lineage drift.

Reason: the ticket intentionally changed governance/config shape while preserving explicit registered-inactive replay behavior. Behavior summaries were pinned, so the chain shift was attributable to run-spec/config identity rather than trade behavior.

### PR #247 / PR #248 note

The PR #247 and PR #248 discussions established the same-worktree comparison habit and separated runtime/journal drift from config-input lineage drift. They are useful background, but the PROCESS-03 examples above are the concrete examples workers should use as the current template.

## Abort conditions

STOP and ask before continuing if:

- A docs-only or process-only ticket appears to require hash repinning.
- `final_phase2_hash` or `final_phase4_hash` moves without explicit source-substrate authorization.
- A claimed config-input lineage drift also changes trade count, trade order, prices, exits, PnL, or metrics.
- The changed component cannot be identified.
- A report requires cross-worktree equality despite path-sensitive material.
- The guidance would change ADR authority instead of documenting review practice.
