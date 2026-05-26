# QFA-611 Cycle3 REDERIVATION-02 Track B memo

## 1. Status

Status: RESEARCH_TIER evidence artifact for ADR-0024 LD-024-3 Step 3. Execution substrate: `0a39938` / `0a39938031fe74eacba2a75e46c4c301d2407e96` after PR #248. Track B was originally packet-pinned to `590acac` (`MGMT-DEADLINE-EXTENSION-01: implement deadline extension modes (#247)`) and then refreshed onto `0a39938`; PR #248 is methodology-orthogonal v5 registration work and does not change the Cycle3 roster, parameter locks, held-out manifests, or Track B trial accounting. Invocation memo: `docs/research/qfa-611-cycle3-rederivation-02-invocation-memo.md` (PR #241 / `41beaaf`).

## 2. Authority

This memo executes ADR-0024 LD-024-3 Step 3 only. LD-024-3 Step 4 verdict reconciliation remains coord+operator authority after merge. Roster discipline follows ADR-0024 LD-024-4: all Cycle3 roster strategies were regenerated, including REGISTERED_INACTIVE v3 as informational evidence.

## 3. Engine substrate

Engine correction source: MGMT-BUG-FIX-02 (`d1d7461`, PR #240). Runtime surfaces changed since `e985b10` include fail-safe enforcement, time-stop enforcement, ADR-0027 deadline-extension schema/wiring, BREAKEVEN_ARMED event schema, and profile wiring manifest updates. Strategy YAMLs and strategy decision generators were not changed by this rederivation.

Selection-v4 input invariants:

- `input_phase2_hash`: `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b`
- `input_phase4_hash`: `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090`
- `input_substrate_hash`: `f90e3e6df588a60756c675befe7fd77adf1a33ed3878fbb8900d519b79f0a41a`
- `effective_trial_count`: `3`
- `methodology_id`: `adr-0016-v1`

## 4. Per-strategy held-out evidence comparison

This section separates two views. Section 4a is the verdict-relevant comparison: canonical Cycle3 closure selection-v3 at `e985b10` versus Track B selection-v4, both with `input_substrate_hash=f90e3e6df588a60756c675befe7fd77adf1a33ed3878fbb8900d519b79f0a41a`. Section 4b is an operational continuity view from the held-out artifacts present at `590acac` immediately before Track B; that view can conflate substrate/provenance changes with engine changes and is not the load-bearing LD-024-3 Step 4 comparison.

### 4a. Verdict-relevant comparison: selection-v3 vs selection-v4

| Strategy | Metric | selection-v3 (`e985b10`) | selection-v4 Track B |
|---|---:|---:|---:|
| `regime_shock_reversion_short_v2` | total_trades | 528 | 572 |
| `regime_shock_reversion_short_v2` | win_rate | 0.397727 | 0.493006 |
| `regime_shock_reversion_short_v2` | profit_factor | 1.395150 | 0.973182 |
| `regime_shock_reversion_short_v2` | annualized_sharpe | 4.756375 | -0.311122 |
| `regime_shock_reversion_short_v2` | dsr_statistic | 3.621692 | -1.008717 |
| `regime_shock_reversion_short_v2` | dsr_probability | 0.999854 | 0.156555 |
| `regime_shock_reversion_short_v2` | psr_zero_null | 0.999996 | 0.438051 |
| `regime_shock_reversion_short_v2` | threshold_results | `{"drawdown_pass": true, "dsr_pass": true, "hurdle_pass": true, "pf_pass": true, "psr_zero_pass": true, "regime_trade_pass": true, "sensitivity_audit_pass": true, "sharpe_pass": true, "trade_count_pass": true}` | `{"drawdown_pass": true, "dsr_pass": false, "hurdle_pass": false, "pf_pass": false, "psr_zero_pass": false, "regime_trade_pass": true, "sensitivity_audit_pass": true, "sharpe_pass": false, "trade_count_pass": true}` |
| `regime_shock_reversion_short_v2` | verdict | ADVANCE_TO_PAPER | REJECT |
| `vwap_overnight_reversal_long` | total_trades | 65 | 67 |
| `vwap_overnight_reversal_long` | win_rate | 0.153846 | 0.208955 |
| `vwap_overnight_reversal_long` | profit_factor | 0.778298 | 0.571733 |
| `vwap_overnight_reversal_long` | annualized_sharpe | -1.050384 | -2.210980 |
| `vwap_overnight_reversal_long` | dsr_statistic | -1.418476 | -2.287815 |
| `vwap_overnight_reversal_long` | dsr_probability | 0.078026 | 0.011074 |
| `vwap_overnight_reversal_long` | psr_zero_null | 0.285808 | 0.075642 |
| `vwap_overnight_reversal_long` | threshold_results | `{"drawdown_pass": true, "dsr_pass": false, "hurdle_pass": false, "pf_pass": false, "psr_zero_pass": false, "regime_trade_pass": true, "sensitivity_audit_pass": true, "sharpe_pass": false, "trade_count_pass": false}` | `{"drawdown_pass": true, "dsr_pass": false, "hurdle_pass": false, "pf_pass": false, "psr_zero_pass": false, "regime_trade_pass": true, "sensitivity_audit_pass": true, "sharpe_pass": false, "trade_count_pass": false}` |
| `vwap_overnight_reversal_long` | verdict | REJECT | REJECT |
| `vwap_overnight_reversal_short` | total_trades | 39 | 37 |
| `vwap_overnight_reversal_short` | win_rate | 0.307692 | 0.270270 |
| `vwap_overnight_reversal_short` | profit_factor | 1.363791 | 1.177745 |
| `vwap_overnight_reversal_short` | annualized_sharpe | 2.328149 | 1.275619 |
| `vwap_overnight_reversal_short` | dsr_statistic | 0.635148 | -0.192944 |
| `vwap_overnight_reversal_short` | dsr_probability | 0.737334 | 0.423502 |
| `vwap_overnight_reversal_short` | psr_zero_null | 0.931618 | 0.745328 |
| `vwap_overnight_reversal_short` | threshold_results | `{"drawdown_pass": true, "dsr_pass": true, "hurdle_pass": false, "pf_pass": true, "psr_zero_pass": true, "regime_trade_pass": false, "sensitivity_audit_pass": true, "sharpe_pass": true, "trade_count_pass": false}` | `{"drawdown_pass": true, "dsr_pass": false, "hurdle_pass": false, "pf_pass": false, "psr_zero_pass": false, "regime_trade_pass": false, "sensitivity_audit_pass": true, "sharpe_pass": true, "trade_count_pass": false}` |
| `vwap_overnight_reversal_short` | verdict | REJECT | REJECT |

### 4b. Operational delta: 590acac held-out artifacts vs Track B

| Strategy | 590acac total_trades | Track B total_trades | 590acac win_rate | Track B win_rate | 590acac profit_factor | Track B profit_factor |
|---|---:|---:|---:|---:|---:|---:|
| `regime_shock_reversion_short_v2` | 571 | 572 | 0.506129 | 0.493006 | 1.418043 | 0.973182 |
| `vwap_overnight_reversal_long` | 69 | 67 | 0.217391 | 0.208955 | 0.791514 | 0.571733 |
| `vwap_overnight_reversal_short` | 40 | 37 | 0.325000 | 0.270270 | 1.293814 | 1.177745 |
| `regime_shock_reversion_short_v3` | n/a | 363 | n/a | 0.509641 | n/a | 1.215465 |

## 5. v3 informational subsection

`regime_shock_reversion_short_v3` remains REGISTERED_INACTIVE and is not included in selection-v4. Its corrected-engine held-out artifact is archival consistency evidence only.

| Strategy | total_trades | profit_factor | annualized_sharpe | dsr_statistic | dsr_probability | verdict if evaluated alone |
|---|---:|---:|---:|---:|---:|---:|
| `regime_shock_reversion_short_v3` | 363 | 1.215465 | 2.194210 | 1.084301 | 0.860884 | REJECT |

Footnote: the solo informational v3 evaluation used `effective_trial_count=1` with a temporary v3-only lock manifest, solely to describe what the corrected v3 artifact would do if evaluated alone. Passed Stage 1 checks: `['drawdown_pass', 'dsr_pass', 'psr_zero_pass', 'regime_trade_pass', 'sharpe_pass', 'trade_count_pass']`. Failed Stage 1 checks: `['hurdle_pass', 'pf_pass', 'sensitivity_audit_pass']`. This verdict does not enter selection-v4 and does not activate v3 from Cycle3.

## 6. Exit-reason taxonomy shift

This section uses the same verdict-relevant `e985b10` selection-v3 baseline as §4a. Matched shifts are keyed by `(entry_ts_ns, side)`. Old-only and new-only counts are reported separately because corrected management exits can alter subsequent trade availability.

| Strategy | selection-v3 total | Track B total | matched entry+side | old-only | new-only | Track B histogram | matched exit_reason shifts |
|---|---:|---:|---:|---:|---:|---|---|
| `regime_shock_reversion_short_v2` | 528 | 572 | 474 | 54 | 98 | `{"fail_safe": 156, "session_close": 3, "stop_loss": 234, "target": 179}` | `{"session_close->stop_loss": 1, "stop_loss->fail_safe": 118, "target->fail_safe": 6, "target->stop_loss": 23}` |
| `vwap_overnight_reversal_long` | 65 | 67 | 62 | 3 | 5 | `{"fail_safe": 27, "stop_loss": 33, "target": 7}` | `{"stop_loss->fail_safe": 21, "target->fail_safe": 2, "time_stop->fail_safe": 1}` |
| `vwap_overnight_reversal_short` | 39 | 37 | 34 | 5 | 3 | `{"fail_safe": 14, "session_close": 3, "stop_loss": 14, "target": 5, "time_stop": 1}` | `{"stop_loss->fail_safe": 12, "target->stop_loss": 1, "time_stop->fail_safe": 1, "time_stop->target": 2}` |
| `regime_shock_reversion_short_v3` | n/a | 363 | n/a | n/a | n/a | `{"fail_safe": 103, "session_close": 2, "stop_loss": 128, "target": 130}` | `"post-fix only"` |

## 7. Verdict reconciliation deferral

Selection-v4 reports all 3 active strategies as REJECT and `phase_6_dispatch_authorized=false` in the driver summary. This memo does not recommend a verdict-set change. ADR-0024 LD-024-3 Step 4 reconciliation is deferred to coord+operator authority after this Track B evidence PR merges.

## 8. Risk register

- Runtime-correction materiality: realized; active-strategy held-out totals and exit taxonomies changed under the corrected management engine.
- Roster integrity: preserved; 3 active strategies drive selection-v4 and v3 is informational only.
- Parameter-lock drift: cleared; active hashes match LD-RD2-2 and v3 lock was added for artifact provenance.
- Trial-count integrity: cleared via LD-RD2-11 temp active-only lock snapshot; `effective_trial_count == 3`.
- Reproducibility risk from untracked metadata: resolved by `config/research/qfa611-cycle3-rederivation-02-metadata.json`.
- Verdict authority risk: controlled by explicit Step 4 deferral; worker memo reports evidence only.

## 9. Reproducibility

Substrate and commands:

```bash
git rev-parse origin/main  # 0a39938031fe74eacba2a75e46c4c301d2407e96
npx tsx scripts/qfa-410b-execute.mts --run-id qfa-611-cycle3-rederivation-02 --strategy-ids vwap_overnight_reversal_long vwap_overnight_reversal_short regime_shock_reversion_short_v2 regime_shock_reversion_short_v3 --output-dir artifacts/held-out-validation/cycle3 --manifests config/research/manifests/manifest-feb-2026.json config/research/manifests/manifest-mar-2026.json config/research/manifests/manifest-apr-2026.json --regime-labels artifacts/regime/regime-labels.json --metadata-by-strategy config/research/qfa611-cycle3-rederivation-02-metadata.json
git show 590acac:artifacts/strategy-selection/qfa611-cycle3-parameter-locks.json > artifacts/strategy-selection/.tmp/qfa611-cycle3-active-roster-locks-for-v4.json
python scripts/strategy-selection/qfa-611-strategy-selection.py --held-out-dir artifacts/held-out-validation/cycle3 --lock-manifest artifacts/strategy-selection/.tmp/qfa611-cycle3-active-roster-locks-for-v4.json --json-out artifacts/strategy-selection/strategy-selection-v4.json --md-out artifacts/strategy-selection/strategy-selection-v4.md
```

Tracked metadata:

- `config/research/qfa611-cycle3-rederivation-02-metadata.json` SHA256: `7d4ea0f5331bb0fa7664bbe76e2907b46420512ff62cee5b41bc0d058b6e88d2`
- All four metadata entries set `strategy_family="mean_reversion"` and `parameter_lock_source="qfa611-cycle3-parameter-locks"`.

LD-RD2-11 temp lock-manifest recipe:

- `git show 590acac:artifacts/strategy-selection/qfa611-cycle3-parameter-locks.json` SHA256: `50262f22d77b83a9d2a650c95398491865fd97675ab3b55f2ddf795f05e10629`
- Snapshot contains exactly the 3 active strategies and no v3.
- The `590acac` reference is intentionally a content-pinning reference for the pre-extension 3-entry Cycle3 active lock-manifest source, not the execution substrate. Execution substrate is `0a39938`.
- Rationale: the committed Cycle3 lock manifest is extended to 4 entries for v3 artifact provenance, but selection-v4 trial accounting must remain 3 per ADR-0024 LD-024-4 and strategy-selection-v3 precedent.

Artifact SHAs:

- `regime_shock_reversion_short_v2` held-out artifact: `b86b147aa5d3d3f7e43f0e5f7153f6516ff30125175f89660cc689c7469daed9`
- `vwap_overnight_reversal_long` held-out artifact: `d96216769e9bdfbf94a5c25922cf217ecac639617080d7461c4fe4b5e76ca18d`
- `vwap_overnight_reversal_short` held-out artifact: `2c24530c53b06135e57632fc7727310a1535f01ab635690fc3be5b4d81c3d84f`
- `regime_shock_reversion_short_v3` held-out artifact: `a059086754187e8c98889c130606c0c77720a4f13ae61394439bc3b73e0ff69c`
- `strategy-selection-v4.json`: `f59793975f4c78a7ef43b515965806a1b6c4ff7d032d974af3d636350e70e24e`
- `strategy-selection-v4.md`: `59dbe1babbeb801ee5fd55a08515747dc35a0430b351401065ad033571b68dd9`
- `qfa611-cycle3-parameter-locks.json` (4-entry extended manifest): `c6bd3eb282b498f177eb918f4edb51123ccd015d4d3b8954d2efb5949b031348`

The current selection driver does not emit a `final_chain_hash` field in selection-v3 or selection-v4. The selection-v4 file SHA above is therefore the surfaced Track B output hash for this PR.

## 10. Cross-references

- `docs/research/qfa-611-cycle3-rederivation-02-invocation-memo.md`
- PR #240 / `d1d7461` (MGMT-BUG-FIX-02)
- PR #244 / `0ba6a48` (ADR-0027)
- PR #247 / `590acac` (deadline-extension implementation)
- PR #248 / `0a39938` (methodology-orthogonal v5 registration substrate context)
- `artifacts/strategy-selection/strategy-selection-v3.json`
- `artifacts/strategy-selection/strategy-selection-v4.json`
- `docs/research/qfa-611-cycle3-closure-memo.md`
- `docs/research/cycle4-hash-lineage-trace.md`
