# CYCLE4-V5-INFERENCE-02-2MNQ memo

## 1. Context

This informational Cycle4 run evaluates the two ADR-0027 v5 deadline-extension variants registered inactive by STRAT-V5-DEADLINE-VARIANTS-01. It runs after REDERIVATION-02, PR #247 (deadline-extension runtime), PR #248 (v5 registered-inactive variants), PR #250 (2 MNQ replay sizing harness), PR #252 (held-out evidence projection), PR #253 (multi-exit PnL accounting), and PR #254 (archive frame decode). It does not promote either strategy, mutate ACTIVE_STRATEGY_IDS, or authorize paper observation.

Execution substrate: `98a4af24bca9621528e8a063bcc34a1c2cd3daa0`.

## 2. Roster

- `regime_shock_reversion_short_v5_strict_deadline`
- `regime_shock_reversion_short_v5_trail_at_deadline`

Both remain REGISTERED_INACTIVE.

## 3. Command lineage

Parameter locks:

```powershell
python scripts/strategy-selection/qfa-611-emit-lock-manifest.py --cycle-id qfa611-cycle4-v5-02-2mnq --strategy-ids regime_shock_reversion_short_v5_strict_deadline regime_shock_reversion_short_v5_trail_at_deadline --out artifacts/strategy-selection/qfa611-cycle4-v5-02-2mnq-parameter-locks.json
```

Metadata was generated from the lock manifest, manifest hashes, and `artifacts/regime/regime-labels.json` substrate hash into `config/research/cycle4-v5-inference-02-2mnq-metadata.json`.

Held-out validation (run twice from clean output dir; byte-equal):

```powershell
npx tsx scripts/qfa-410b-execute.mts --run-id cycle4-v5-inference-02-2mnq --strategy-ids regime_shock_reversion_short_v5_strict_deadline regime_shock_reversion_short_v5_trail_at_deadline --metadata-by-strategy config/research/cycle4-v5-inference-02-2mnq-metadata.json --output-dir artifacts/held-out-validation/cycle4-v5-inference-02-2mnq --research-fixed-contracts 2
```

Selection (run twice; byte-equal):

```powershell
python scripts/strategy-selection/qfa-611-strategy-selection.py --strategy-ids regime_shock_reversion_short_v5_strict_deadline regime_shock_reversion_short_v5_trail_at_deadline --held-out-dir artifacts/held-out-validation/cycle4-v5-inference-02-2mnq --lock-manifest artifacts/strategy-selection/qfa611-cycle4-v5-02-2mnq-parameter-locks.json --json-out artifacts/strategy-selection/strategy-selection-cycle4-v5-02-2mnq.json --md-out artifacts/strategy-selection/strategy-selection-cycle4-v5-02-2mnq.md
```

## 4. Determinism and hashes

| Artifact | SHA-256 |
|---|---|
| lock manifest | `baffc39aa9bd5dfa82763f377ed6c77a4b7ab0b9976cfd193672118f82cf50ed` |
| metadata | `efe9522503411aa5ce6c5172bc47b71011771f1b203a9bcd62dff6184e6c2c86` |
| strict held-out artifact | `520977c9939957d51fb528f451728cd5bfe4c1c06b3d1cb22996df479ad073e8` |
| trail held-out artifact | `2f6120f12b34bd2d95d7987fc5e846b9a7fa07b0a2aba48c996239ae37244c03` |
| selection JSON | `00febc278832b364fe61e5095d18d1081fb166f4e68456f2f341d07f4dbd5027` |
| selection MD | `df0ecadb331d24fe05b064b2f7dcec6dfb5aa9de35e2633e89783f3cd2c87c7c` |

Held-out artifacts and selection outputs were each generated twice from clean output locations and matched byte-for-byte.

## 5. Quantity and partial-exit audit

The emitted held-out trade artifact exposes quantity at `trades[].entry_quantity`, `trades[].exit_quantity`, and per-close quantities at `trades[].exits[].exit_quantity`. Every emitted trade distinguishes 2 MNQ from 1 MNQ directly.

| Strategy | entry_quantity=2 trades | exit_quantity=2 trades | PT1 partial exits | PT2 final exits | single-contract trades |
|---|---:|---:|---:|---:|---:|
| `regime_shock_reversion_short_v5_strict_deadline` | 1129 | 1129 | 520 | 187 | 0 |
| `regime_shock_reversion_short_v5_trail_at_deadline` | 1129 | 1129 | 520 | 187 | 0 |

Example emitted surface for both strategies: first trade has `entry_quantity: 2`, `exit_quantity: 2`, `exits[0].management_action_type: TAKE_PARTIAL`, `exits[0].target_label: pt1`, `exits[0].exit_quantity: 1`, followed by a final one-contract exit.

## 6. Deadline-extension exposure audit

| Strategy | Expected profile mode | Emitted profile coverage | Emitted mode coverage | Deadline-action trades | Explanation |
|---|---|---:|---:|---:|---|
| `regime_shock_reversion_short_v5_strict_deadline` | `unconditional_exit` | 1129/1129 | 1129/1129 | 0 | No emitted action/reason contains deadline/time-stop/trail-at-deadline activation; outputs are identical because zero positions reached the deadline-extension branch. |
| `regime_shock_reversion_short_v5_trail_at_deadline` | `activate_trail` | 1129/1129 | 1129/1129 | 0 | No emitted action/reason contains deadline/time-stop/trail-at-deadline activation; outputs are identical because zero positions reached the deadline-extension branch. |

Profile resolution is 100% correct for each strategy. Strict emits `time_stop_at_deadline_extension: unconditional_exit`; trail emits `time_stop_at_deadline_extension: activate_trail`.

## 7. Metrics

| Strategy | PF | Win rate | Sharpe | Max drawdown | Trades | Mean R | Sigma R | DSR | PSR zero | HAC t-stat |
|---|---:|---:|---:|---:|---:|---|---|---:|---:|---:|
| `regime_shock_reversion_short_v5_strict_deadline` | 0.852573 | 44.9069% | -3.166923 | 10.4780% | 1129 | n/a | n/a | 0.0087173571 | 0.0316090615 | -1.2979430026 |
| `regime_shock_reversion_short_v5_trail_at_deadline` | 0.852573 | 44.9069% | -3.166923 | 10.4780% | 1129 | n/a | n/a | 0.0087173571 | 0.0316090615 | -1.2979430026 |

Mean R and sigma R are not serialized by the held-out artifact or selection driver for this evidence surface; the verdict-bearing statistics use net PnL/session-return metrics shown above.

## 8. Strict vs trail comparison

Both variants produced identical verdict-bearing metrics in this 2MNQ run. The management-profile distinction reached the artifact surface, but deadline-extension action exposure was zero.

| Metric | Strict deadline | Trail at deadline |
|---|---:|---:|
| Total trades | 1129 | 1129 |
| Profit factor | 0.852573 | 0.852573 |
| Win rate | 44.9069% | 44.9069% |
| Sharpe | -3.166923 | -3.166923 |
| Max drawdown | 10.4780% | 10.4780% |
| DSR probability | 0.0087173571 | 0.0087173571 |

## 9. Exit taxonomy

| Strategy | stop_loss | target | fail_safe | session_close | TAKE_PARTIAL | TAKE_PROFIT | EXIT_FULL | FAIL_SAFE_EXIT |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `regime_shock_reversion_short_v5_strict_deadline` | 618 | 187 | 319 | 5 | 520 | 187 | 618 | 319 |
| `regime_shock_reversion_short_v5_trail_at_deadline` | 618 | 187 | 319 | 5 | 520 | 187 | 618 | 319 |

## 10. Verdict input

| Strategy | Driver verdict | Reason | Trade-count pass | PF pass | Sharpe pass | DSR pass | Sensitivity pass |
|---|---|---|---|---|---|---|---|
| `regime_shock_reversion_short_v5_strict_deadline` | REJECT | three_or_more_stage1_thresholds_failed | true | false | false | false | false |
| `regime_shock_reversion_short_v5_trail_at_deadline` | REJECT | three_or_more_stage1_thresholds_failed | true | false | false | false | false |

These verdicts are informational inputs for coord/operator review. They are not automatic promotion or activation authority.

## 11. No-tuning and downstream note

Signal parameters are inherited from the registered v5 strategy YAMLs; no strategy parameter, YAML, management profile, runtime, schema, or ACTIVE roster was changed in this ticket. Any future promotion, paper observation, or strategy-ID reconciliation requires separate coord/operator authorization and a separate implementation ticket.
