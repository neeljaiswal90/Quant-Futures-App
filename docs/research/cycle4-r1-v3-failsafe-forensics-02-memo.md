# CYCLE4-R1-V3-FAILSAFE-FORENSICS-02 Memo

Date: 2026-05-29

Substrate: `9869e1d047e4f60c9f9f175c91e1ab5c56ee69e3`

Status: research forensics only

## 1. Context

`CYCLE4-R1-V3-FAILSAFE-FORENSICS-01` identified fail-safe exits as the dominant remaining loss bucket for `regime_shock_reversion_short_v3`.

PR #269 extended the held-out validation evidence surface so exact fail-safe reasons remain available at `trades[].exits[].management_action_reason`, while new `exits[].fail_safe_context` fields expose runtime context around each fail-safe exit.

This ticket reran v3 held-out replay against that extended schema and rebuilt the fail-safe forensic artifact.

## 2. Source artifact provenance

| Item | Value |
|---|---|
| Held-out artifact | `artifacts/held-out-validation/cycle4-r1-v3-failsafe-forensics-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json` |
| Held-out artifact SHA-256 | `30383348fbf6d3f014a1df09b05120e14f63fdedb832fb2ea053f9651a8a2329` |
| Lock manifest | `artifacts/strategy-selection/qfa611-cycle4-r1-v3-failsafe-forensics-02-parameter-locks.json` |
| Lock manifest SHA-256 | `9fad559cb5e4617e0fa63b0ff5360748f0d3d9b257169fdcc39d7d6853d3c62d` |
| Metadata | `config/research/cycle4-r1-v3-failsafe-forensics-02-metadata.json` |
| Metadata SHA-256 | `3b910fb836c6706d1814e4fcf00bb29c0bb274ae376de4a6201e489c3aa7b9aa` |
| Forensics JSON | `artifacts/research/cycle4-r1-v3-failsafe-forensics-02/v3-failsafe-trade-forensics.json` |
| Forensics JSON SHA-256 | `9bafc4a4e9f895f56a4b1ed43f4dccf5d0076550f25b96b150b0a7959597705c` |
| Forensics Markdown | `artifacts/research/cycle4-r1-v3-failsafe-forensics-02/v3-failsafe-trade-forensics.md` |
| Forensics Markdown SHA-256 | `516e1f749ef54ac9f96638887844378857f49dda76a66313a8e49bd4f34a2942` |

The lock manifest, metadata, held-out artifact, forensics JSON, and forensics Markdown were each generated with byte-equality checks where applicable.

## 3. Schema/evidence surface recap

The generated held-out artifact keeps `schema_version: 1`.

The exact fail-safe reason path is:

```text
trades[].exits[].management_action_reason
```

The extended context path is:

```text
trades[].exits[].fail_safe_context
```

Every fail-safe trade in this rerun has a `FAIL_SAFE_EXIT` exit record with:

- `management_action_reason` beginning with `fail_safe:`
- non-null `fail_safe_context`

Non-fail-safe exits keep `fail_safe_context: null`.

## 4. Anchor-count reconciliation

The rerun matches the prior anchor exactly.

| Anchor | Expected | Generated | Status |
|---|---:|---:|---|
| Total trades | `889` | `889` | matched |
| Fail-safe exits | `262` | `262` | matched |
| Net PnL cents | `-102600` | `-102600` | matched |

This supports the claim that PR #269 changed evidence projection, not strategy behavior, replay behavior, or PnL accounting.

## 5. Fail-safe subtype findings

The fail-safe bucket splits into two runtime reason families:

| Fail-safe reason | Trades | Net PnL cents | Avg net PnL cents |
|---|---:|---:|---:|
| `fail_safe:max_adverse_r_exceeded` | `245` | `-580100` | `-2367.76` |
| `fail_safe:max_spread_ticks_exceeded` | `17` | `47650` | `2802.94` |

Interpretation:

- The fail-safe loss problem is overwhelmingly the max-adverse-R path.
- `max_spread_ticks_exceeded` is not the loss driver in this replay; it is net-positive in aggregate.
- There is no evidence here that stale-market, invalid-price, missing-stop, invalid-quantity, profile-mismatch, or invalid-target-position fail-safes drove the v3 loss bucket.

## 6. Fail-safe runtime context findings

All `262` fail-safe exits carry `market_authority = authoritative`.

| Context field | Finding |
|---|---|
| `market_authority` | `authoritative` for all fail-safe exits |
| `market_is_stale` | null for all fail-safe exits |
| `validation_path` | null for all fail-safe exits |
| profile mismatch | no profile-mismatch fail-safe reason observed |
| invalid target position | no invalid-target-position fail-safe reason observed |

The extended surface therefore points toward genuine adverse excursion / spread-threshold exits rather than data-quality or profile-integrity failures.

## 7. VIX/session/spread/queue findings

VIX bucket signal is mixed:

| Bucket example | Trades | Net PnL cents |
|---|---:|---:|
| `fail_safe:0.25-0.50` | `101` | `-188000` |
| `fail_safe:>=0.85` | `83` | `-193000` |
| `fail_safe:0.50-0.67` | `42` | `-92200` |
| `target:>=0.85` | `92` | `382000` |
| `target:0.25-0.50` | `94` | `197000` |

The existing v3 overfire band continues to prevent trades in the blocked `0.67-0.85` band, but fail-safe losses remain on both sides of that band. This does not support a simple "raise/lower VIX band and the fail-safes disappear" conclusion.

Queue and spread context:

| Context slice | Trades | Net PnL cents |
|---|---:|---:|
| `fail_safe:1-5` queue bucket | `140` | `-254950` |
| `fail_safe:6-20` queue bucket | `122` | `-277500` |
| `fail_safe:2-tick` spread bucket | `173` | `-389850` |
| `fail_safe:3+ ticks` spread bucket | `57` | `-81650` |
| `fail_safe:1-tick` spread bucket | `32` | `-60950` |

The 2-tick spread bucket has the largest fail-safe net loss concentration, but it also has the most trades. The current evidence does not by itself justify a spread-only filter.

Session concentration is visible through `session_id`; the largest trade-count sessions include `2026-04-09-rth`, `2026-04-24-rth`, and `2026-03-31-rth`. Per-window fail-safe concentration remains unavailable because per-trade `window_id` is not serialized and the walk-forward windows overlap.

## 8. Hold-time and MFE/MAE findings

Hold-time profile:

| Exit reason | Count | Avg minutes | Median minutes | P90 minutes |
|---|---:|---:|---:|---:|
| `fail_safe` | `262` | `1.66` | `1` | `3` |
| `stop_loss` | `363` | `2.06` | `2` | `4` |
| `target` | `259` | `2.28` | `2` | `4` |

MFE/MAE profile:

| Exit reason | Avg MFE cents | Avg MAE cents | Median MFE cents | Median MAE cents |
|---|---:|---:|---:|---:|
| `fail_safe` | `1031.11` | `-2980.34` | `700` | `-2300` |
| `stop_loss` | `1254.82` | `-1489.94` | `1000` | `-1300` |
| `target` | `4113.9` | `-491.89` | `3450` | `-400` |

Interpretation:

- Fail-safe losses tend to occur quickly.
- Fail-safe exits show much worse adverse excursion than stop-loss exits.
- Fail-safe trades still often had some favorable excursion, but not enough to offset the adverse-R path.

## 9. Avoidable-loss and PF target framing

Prior framing remains unchanged:

| Target | Meaning |
|---|---|
| `+$1,026.00` | Approximate improvement needed to reach break-even PF near `1.0` |
| `11.4%` gross-loss reduction | Equivalent break-even loss reduction |
| `PF = 1.35` | Recorded qfa-611 `pf_pass` threshold |
| `~$3,095.93` | Estimated additional improvement needed to reach the PF pass threshold |

PF near `1.0` is break-even only. It is not an ADR-0016 pass.

Because `max_adverse_r_exceeded` accounts for `245` fail-safe exits and `-$5,801.00`, any future lever should quantify whether it reduces that path without removing too many target winners.

## 10. Evidence gaps

Remaining gaps:

| Gap | Impact |
|---|---|
| Per-trade `window_id` unavailable | Cannot assign fail-safe exits to overlapping walk-forward windows without ambiguity. |
| `vix_value` unavailable per trade | Percentile is available, raw VIX value is not. |
| `vix_fresh` unavailable per trade | Cannot distinguish stale VIX feature state. |
| `signed_shock_vwap` unavailable per trade | Cannot directly separate shock magnitude at entry. |
| `signed_shock_vwap_recent_values` unavailable per trade | Cannot analyze v4-style persistence/delay context for v3 entries. |
| `primary_percentile` / `vxn_percentile` unavailable per trade | Cannot join full regime percentile context without another evidence extension. |

The current evidence is enough to classify fail-safe subtype and runtime fail-safe context. It is not enough to justify tuning based on signed-shock or raw volatility feature context.

## 11. Recommended next ticket

Recommended next ticket:

```text
CYCLE4-R1-V3-MAX-ADVERSE-R-DIAGNOSTIC-01
```

Suggested scope:

- Discovery or controlled diagnostic only.
- Focus on `fail_safe:max_adverse_r_exceeded`.
- Quantify candidate levers against target winners.
- Preserve registered-inactive status.
- No tuning or variant creation until the diagnostic identifies a concrete, testable gate or management hypothesis.

Alternative:

```text
CYCLE4-R1-V3-EVIDENCE-SURFACE-EXTEND-02
```

Use this only if coordinators decide signed-shock/VIX freshness/per-window attribution is required before any max-adverse-R diagnostic.

## 12. Verification

Completed verification:

| Command / gate | Result |
|---|---|
| Lock manifest generated twice | byte-identical |
| Metadata generated twice | byte-identical |
| qfa-410b held-out artifact generated twice | byte-identical |
| Forensics JSON generated twice | byte-identical |
| Forensics Markdown generated twice | byte-identical |
| Anchor counts | `889 / 262 / -102600`, matched |
| `npx tsx scripts/research/cycle4-r1-v3-failsafe-forensics-02.mts` | PASS |
| `npx tsc -b tsconfig.json` | PASS |
| `npm run lint --if-present` | PASS |
| `npx tsx scripts/backtester/check-determinism.mts` | PASS |

PROCESS-03 same-substrate comparison:

| Hash | Baseline at `9869e1d` | Branch |
|---|---|---|
| `final_chain_hash` | `4f8fd6ce844b3e273ae72402c5985c3695f838d5a6bc8f2b7f09cce018750e58` | `b1e80fab0529fb1a8aafc0f51bcf0f8ff708a54811eb39312fe84dc0d880049d` |
| `final_phase2_hash` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` |
| `final_phase4_hash` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` |

Classification: evidence-surface drift.

Phase 2 and phase 4 are pinned, while the final chain changes because this ticket commits new research evidence inputs/outputs and a deterministic research extractor. No runtime or journal behavior drift is indicated.

## 13. Authority caveat

This ticket does not change strategy behavior, replay behavior, management behavior, PnL accounting, strategy YAMLs, registry status, ACTIVE roster state, paper observation, broker/live dispatch, or Phase 6 authority.

`regime_shock_reversion_short_v3` remains registered inactive and explicit-replay only.
