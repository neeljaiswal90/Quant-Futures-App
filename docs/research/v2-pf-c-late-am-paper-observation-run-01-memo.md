# V2-PF-C-LATE-AM-PAPER-OBSERVATION-RUN-01 memo

## 1. Context and PR chain

PR #291 added the dedicated paper-observation entrypoint and config for `regime_shock_reversion_short_v2_utc_16_18_exclusion`. This ticket executes the first bounded mock-only startup/control paper run and captures the journal/diagnostics evidence.

## 2. Entrypoint/config used

The exact command run was:

```powershell
npx tsx scripts/paper/run-v2-pf-c-late-am-paper-observation.ts
```

The dedicated config is `config/paper/v2-pf-c-late-am-paper-observation.yaml`.

## 3. Runtime controls

| Control | Observed |
|---|---|
| Strategy | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| Explicit strategy ids | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| Adapter kind | `mock` |
| Market data source | `simulation` |
| Broker adapter | `MockOrderPlantAdapter` |
| Generic paper-session fallback | Not used |
| Run cap | 5 minutes |

## 4. Paper-only authority statement

This run does not authorize broker/live dispatch, does not create Phase 6 authority, does not mutate `ACTIVE_STRATEGY_IDS`, does not mutate `CANDIDATE_STRATEGY_IDS`, and does not activate the strategy. The strategy remains registered inactive.

## 5. Journal/diagnostics evidence

| Artifact | SHA-256 |
|---|---|
| `artifacts/paper-observation/v2-pf-c-late-am-paper-observation-run-01/paper-session-journal.jsonl` | `f862f026eb9f0aa5eaec73a40ff1857fa6e556f460e72c9f215859d9209863b1` |
| `artifacts/paper-observation/v2-pf-c-late-am-paper-observation-run-01/paper-session-diagnostics.json` | `e252b7609627c2f33b80af23c2e72923cc264125e00bb61f0ef6e18237e97715` |
| `artifacts/paper-observation/v2-pf-c-late-am-paper-observation-run-01/paper-session-summary.md` | `3be2431df5755a11d01e4fda1949b3d18a8d17061d3acd536fb1dd90d451c1e7` |

## 6. Event-count summary

| Event type | Count |
|---|---:|
| `SESSION_MANIFEST` | 2 |

Total events: 2.

## 7. Strategy-evaluation summary

No STRAT_EVAL events were emitted; classify this as startup/config/journal control evidence only, not strategy signal observation evidence.

This means the run is classified as `STARTUP_CONFIG_JOURNAL_CONTROL_ONLY`.

## 8. Low-fidelity monitoring reminder

The prior qfa-402c/qfa-611 evidence chain left residual low-fidelity exposure of 43 trades / 5.81867388%. Future paper-observation reporting should continue monitoring whether live/paper observations cluster in those fidelity cells.

## 9. 45/60 day observation policy

The minimum paper-observation target remains 45 trading days and the preferred target remains 60 trading days. This kickoff/control run does not complete those requirements and should not be counted toward them unless a future ticket defines concrete observation-day criteria and verifies they were met.

## 10. Recommended next ticket

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-DAILY-REPORT-01`.

If the operator wants automation instead, use `V2-PF-C-LATE-AM-PAPER-OBSERVATION-MONITOR-01`.

## 11. Verification

Commands run:

```powershell
npx vitest run apps/strategy_runtime/tests/unit/paper-trading-v2-pf-c-late-am-observation.test.ts
npx tsx scripts/paper/run-v2-pf-c-late-am-paper-observation.ts
git status --short
git diff --name-only
```

The focused guard test passed with 11 tests. The dedicated entrypoint completed under the 5-minute cap.

## 12. Hygiene

Transient `journals/` is removed after evidence capture. No staging, commit, push, or PR is authorized before coordinator approval at `STATE: PENDING-REVIEW`.
