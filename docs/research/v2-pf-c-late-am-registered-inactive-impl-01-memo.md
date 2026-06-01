# V2-PF-C-LATE-AM-REGISTERED-INACTIVE-IMPL-01 memo

## 1. Context

`V2-PF-C-LATE-AM-REGISTERED-INACTIVE-IMPL-01` implements the registered-inactive variant scoped by `V2-PF-REGISTERED-INACTIVE-VARIANT-SCOPE-01`.

The implemented strategy ID is:

```text
regime_shock_reversion_short_v2_utc_16_18_exclusion
```

The variant preserves the v2 regime-shock-reversion short entry stack and adds one deterministic UTC entry exclusion:

```text
16:00:00 <= snapshot.created_ts_ns UTC time < 18:00:00
```

This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, and does not mutate `ACTIVE_STRATEGY_IDS`.

## 2. Implementation summary

The new generator reuses the v2 gate/target construction through a shared parameter-injected helper and blocks only candidates whose causal snapshot timestamp falls in the UTC 16:00-17:59:59.999999999 interval.

The variant loads runtime parameters from:

```text
getStrategyParameters(input.strategy_config, 'regime_shock_reversion_short_v2_utc_16_18_exclusion')
```

That makes the variant YAML and parameter lock behavior-bearing rather than lineage-only. A focused test intentionally diverges base v2 and variant config values and proves the variant follows the variant config.

The timestamp source is:

```text
input.snapshot.created_ts_ns
```

The gate does not use fill timestamp, exit timestamp, local time, exchange-local time, DST adjustment, `session_id`, or post-entry information.

The UTC hour helper uses integer nanosecond arithmetic rather than `Date` construction so the gate remains deterministic and independent of host locale.

## 3. Registered-inactive governance state

Roster state after the change:

| Surface | State |
|---|---|
| `ACTIVE_STRATEGY_IDS` | `[]` |
| `CANDIDATE_STRATEGY_IDS` | `[]` |
| `regime_shock_reversion_short_v2_utc_16_18_exclusion` | `REGISTERED_INACTIVE` only |
| Explicit generator lookup | available through `STRATEGY_GENERATORS` |
| Active generator listing | not included |

The variant has a distinct mirrored management profile:

```text
regime_shock_reversion_short_v2_utc_16_18_exclusion_management_v1
```

That profile mirrors the existing v2 management behavior. The lineage identity differs, but stop behavior, target behavior, time-stop behavior, fail-safe behavior, sizing/fill policy, and management thresholds are unchanged.

## 4. UTC gate semantics and timestamp source

The gate blocks candidate entries when the UTC hour derived from `snapshot.created_ts_ns` is `16` or `17`.

Boundary behavior:

| Timestamp condition | Result |
|---|---|
| before `16:00:00` UTC | inherited v2 behavior |
| `16:00:00 <= ts < 18:00:00` UTC | blocked |
| `18:00:00` UTC or later | inherited v2 behavior |

The block reason is:

```text
regime_shock_reversion_short_v2_utc_16_18_exclusion:utc_16_18_exclusion
```

## 5. Test coverage

Focused coverage was added or updated for:

| Surface | Coverage |
|---|---|
| strategy generator | inherited v2 behavior outside the UTC exclusion window, boundary behavior, blocked reason, candidate retargeting, deterministic helper behavior |
| variant config source | base v2 and variant configs can diverge; the variant follows the variant config |
| strategy IDs | registered-inactive parsing and zero-active state |
| run IDs | new abbreviation |
| registry | explicit generator lookup succeeds without active listing |
| strategy config | config parsing, defaults, YAML consumption, snapshot hash |
| qfa-410b CLI | explicit registered-inactive strategy replay path includes the new ID |
| management profile | `allow_fallback: false` resolution succeeds, v2 semantics are mirrored except lineage identity, existing v2 profile unchanged |

## 6. qfa-410b artifact evidence

The qfa-410b held-out replay was run twice from clean output paths and the held-out JSON was byte-identical.

Command shape:

```powershell
npx tsx scripts/qfa-410b-execute.mts `
  --run-id v2-pf-c-late-am-registered-inactive-impl-01 `
  --strategy-ids regime_shock_reversion_short_v2_utc_16_18_exclusion `
  --metadata-by-strategy config/research/v2-pf-c-late-am-registered-inactive-impl-01-metadata.json `
  --output-dir artifacts/held-out-validation/v2-pf-c-late-am-registered-inactive-impl-01
```

Committed evidence outputs:

| Output | SHA-256 |
|---|---|
| lock manifest | `ab292bd3b7f3b8777d7adf081b908b661e8685bc5e98d04927a38fade9f7277c` |
| metadata | `e336982ae4b19b0ace558a29f785f0421c5800b0e9ac29613ea52889900bee2a` |
| held-out artifact | `e77e7eef8b0dc588029fbb4318de399253dd64f1277ed4f0c05c5ba9b5192817` |

Held-out artifact summary:

| Metric | Value |
|---|---:|
| schema version | 1 |
| executed windows | 6 |
| failed windows | 0 |
| total trades | 739 |
| entries in UTC 16:00-17:59 | 0 |
| non-single-contract trades | 0 |
| net PnL cents | 178400 |
| gross profit cents | 681300 |
| gross loss cents | -502900 |
| profit factor | 1.354742 |
| win rate | 0.484438 |
| max drawdown pct | 0.00595 |

## 7. qfa-611 selection evidence

The qfa-611 selection driver was run twice and emitted byte-identical JSON and Markdown.

Command shape:

```powershell
python scripts/strategy-selection/qfa-611-strategy-selection.py `
  --strategy-ids regime_shock_reversion_short_v2_utc_16_18_exclusion `
  --held-out-dir artifacts/held-out-validation/v2-pf-c-late-am-registered-inactive-impl-01 `
  --lock-manifest artifacts/strategy-selection/qfa611-v2-pf-c-late-am-registered-inactive-impl-01-parameter-locks.json `
  --json-out artifacts/strategy-selection/strategy-selection-v2-pf-c-late-am-registered-inactive-impl-01.json `
  --md-out artifacts/strategy-selection/strategy-selection-v2-pf-c-late-am-registered-inactive-impl-01.md
```

Selection output hashes:

| Output | SHA-256 |
|---|---|
| selection JSON | `97b2e5dd1bbbfd6faa48762a755b9fe023321096572ac6449034a8c4b3a32e15` |
| selection Markdown | `e6b4864499b4a6c310231bbd0ea770973a5fdeffbdfc183150ae1bf231dea75c` |

qfa-611 result:

| Field | Value |
|---|---|
| verdict | `RESEARCH_FURTHER` |
| verdict reason | `one_or_two_thresholds_failed_within_20pct` |
| evidence package status | `complete` |
| advance count | 0 |
| reject count | 0 |
| research further count | 1 |
| phase 6 dispatch authorized | `false` |

Threshold results:

| Threshold | Pass |
|---|---|
| profit factor | true |
| Sharpe | true |
| DSR | true |
| PSR zero | true |
| hurdle | true |
| drawdown | true |
| regime trade | true |
| trade count | true |
| sensitivity audit | false |

The sensitivity failure is a zero-probe coverage issue:

| Sensitivity field | Value |
|---|---:|
| unknown-cell trades | 351 |
| unknown-cell fraction | 0.4749661705 |
| low-fidelity trades | 0 |
| low-fidelity fraction | 0 |
| reason | `missing_cell_concentration` |

## 8. Proxy-vs-implemented comparison against PR #284

PR #284 scoped the UTC exclusion from proxy analysis. The implemented replay remains directionally consistent but is not byte-identical to the proxy, as expected because it uses committed strategy/runtime replay rather than table-level filtering.

| Metric | PR #284 proxy | Implemented replay |
|---|---:|---:|
| remaining trades | 736 | 739 |
| profit factor | 1.359500 | 1.354742 |
| qfa-611 route | scope justified | `RESEARCH_FURTHER` |

The implemented variant clears the qfa-611 PF threshold of `1.35`, but qfa-611 does not advance it because the sensitivity audit remains failed due unknown zero-probe coverage. This is evidence for continued research, not activation authority.

## 9. PROCESS-03 determinism/hash classification

Baseline determinism on the clean substrate:

| Hash | Value |
|---|---|
| baseline `final_chain_hash` | `801bf2a83cdb04b06c70e9c76707a4259abfc8b76efbca095f29b09ceb663c46` |
| baseline `final_phase2_hash` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` |
| baseline `final_phase4_hash` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` |

Post-change determinism:

| Hash | Value |
|---|---|
| branch `final_chain_hash` | `3fd91857bd5139b4b87d52d11f1d7d260de6743144e67075f5d21d87021c6112` |
| branch `final_phase2_hash` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` |
| branch `final_phase4_hash` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` |

PROCESS-03 classification:

```text
config-input lineage / evidence-surface drift
```

The `final_chain_hash` changes because the branch adds a new registered-inactive strategy ID, mirrored management-profile lineage, strategy config, and generated held-out/selection evidence. `final_phase2_hash` and `final_phase4_hash` remain pinned, which supports the interpretation that the substrate behavior phases did not drift.

## 10. Risks and caveats

The implemented variant is evidence-positive but not governance-positive.

The main caveat is the sensitivity audit:

```text
sensitivity_audit_pass = false
```

The failure is driven by missing-cell concentration in zero-probe fidelity coverage, not observed low-fidelity fragility. That means the variant should not be treated as passing until fidelity substrate coverage is extended and qfa-611 is rerun.

The mirrored management profile was added only because qfa-410b resolves management by exact strategy ID with `allow_fallback: false`. It is lineage plumbing, not a management behavior change.

## 11. Recommended next ticket

Recommended next ticket:

```text
V2-PF-C-LATE-AM-FIDELITY-COVERAGE-RECHECK-01
```

Purpose:

```text
Extend or re-check fidelity coverage for the UTC 16-18 exclusion variant's unknown zero-probe cells, then rerun qfa-611 sensitivity gating without changing strategy behavior or authority.
```

## 12. Authority caveat

This PR creates no strategy authority.

It does not:

| Forbidden authority | Status |
|---|---|
| activate the strategy | not authorized |
| add candidate roster authority | not authorized |
| authorize paper observation | not authorized |
| authorize broker/live dispatch | not authorized |
| authorize Phase 6 | not authorized |
| change sizing policy | not authorized |
| change v2 or other existing strategy behavior | not authorized |
