# CYCLE4-V4-INFERENCE-01 memo

## 1. Context

This informational Cycle4 run evaluates the two v4 registered-inactive variants added by CYCLE4-V4-COMBINED-01:

- `regime_shock_reversion_short_v4_delay`
- `regime_shock_reversion_short_v4_persist`

The variants consume producer-owned `signed_shock_vwap_recent_values` and remain research hypotheses. This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, and does not mutate ACTIVE_STRATEGY_IDS.

Execution substrate: `7da97077fb9bb802f456694184af7d908445ec3b` or later current `origin/main` including PR #264.

## 2. Input roster and substrate

| Field | Value |
|---|---|
| Roster | `regime_shock_reversion_short_v4_delay`, `regime_shock_reversion_short_v4_persist` |
| ACTIVE_STRATEGY_IDS | `[]` |
| CANDIDATE_STRATEGY_IDS | `[]` |
| Registration status | REGISTERED_INACTIVE |
| Sizing | Standard qfa-410b default, no `--research-fixed-contracts` override |
| Initial equity | `5000000` cents |

No v2, v3, v5, MOC, active, or candidate strategies were included.

## 3. Parameter locks and metadata

Parameter locks:

```powershell
python scripts/strategy-selection/qfa-611-emit-lock-manifest.py --cycle-id qfa611-cycle4-v4-inference-01 --strategy-ids regime_shock_reversion_short_v4_delay regime_shock_reversion_short_v4_persist --out artifacts/strategy-selection/qfa611-cycle4-v4-inference-01-parameter-locks.json
```

Metadata was generated from the lock manifest, February/March/April 2026 corpus manifest hashes, and `artifacts/regime/regime-labels.json` substrate hash into `config/research/cycle4-v4-inference-01-metadata.json`.

| Artifact | SHA-256 |
|---|---|
| Parameter lock manifest | `21f26fff6875b1a9db58b586ece3acef6995ef2418e8ecb58effe2a56efffbe2` |
| Metadata | `c4bf58b7203030bcdaf021d5d38ae1d8cf69b7d544748bdda034bdf278d1766f` |

| Strategy | Parameter lock hash |
|---|---|
| `regime_shock_reversion_short_v4_delay` | `56027a892eb2279554e3de8d1b073413e24f8201fde25b2212a9bb33f2b80461` |
| `regime_shock_reversion_short_v4_persist` | `f061b73272df4fb27aa1cd761ed72d885905d04fe257c1e7f65d820af0c84e0f` |

## 4. No-artifact diagnostic

Before artifact generation, a bounded no-artifact orchestrator diagnostic was run with `executeHeldOutValidationAgainstArchive`, qfa-410b archive sessions, qfa-410b default walk-forward policy, exact v4 roster, `artifact_output: undefined`, and standard sizing.

The diagnostic completed in `1390s` (`23m10s`) under the 45-minute cap.

| Strategy | Executed windows | Failed windows | Skipped windows |
|---|---:|---:|---:|
| `regime_shock_reversion_short_v4_delay` | 6 | 0 | 0 |
| `regime_shock_reversion_short_v4_persist` | 6 | 0 | 0 |

This diagnostic established clean 6/6 execution coverage. The verdict-bearing trade counts and PnL metrics below come from the committed qfa-410b artifact generation path.

### Diagnostic-vs-production evidence reconciliation

The temporary `.tmp` no-artifact diagnostic reported zero candidates, fills, and closed trades while proving 6/6 window execution coverage. That runtime-metric surface is not used as the verdict-bearing trade evidence for this memo.

The committed evidence source is the production qfa-410b artifact path. It was run twice from clean output directories and produced byte-identical held-out artifacts. A separate qfa-410b single-strategy reproduction for `regime_shock_reversion_short_v4_delay` produced the same artifact SHA-256 and the same 1031-trade count as the committed artifact. The qfa-611 selection driver consumed the committed artifacts, not the temporary diagnostic output.

Therefore, this memo treats the no-artifact diagnostic as an execution-coverage gate only (`6/6` windows, no failures or skips), and treats the byte-stable qfa-410b artifacts as the authoritative evidence surface for trades, PnL, and selection verdicts. The mismatch is preserved here as a diagnostic-script-shape caveat; it does not change the committed artifact counts or qfa-611 verdict inputs.

## 5. Held-out artifact reproducibility

Held-out validation was generated twice from clean output directories and matched byte-for-byte.

```powershell
npx tsx scripts/qfa-410b-execute.mts --run-id cycle4-v4-inference-01 --strategy-ids regime_shock_reversion_short_v4_delay regime_shock_reversion_short_v4_persist --metadata-by-strategy config/research/cycle4-v4-inference-01-metadata.json --output-dir artifacts/held-out-validation/cycle4-v4-inference-01
```

| Held-out artifact | SHA-256 |
|---|---|
| `regime_shock_reversion_short_v4_delay-feb-mar-apr-2026.json` | `7e7520484d270ebc30e56743578d5232e7b7bddaaf65ccb5ee8b66b337a31c52` |
| `regime_shock_reversion_short_v4_persist-feb-mar-apr-2026.json` | `e38be9e98539752b08076c32e08a47547bfa8b23f8d25fd9be7891bf35925695` |

## 6. Selection output

Selection was generated twice and matched byte-for-byte.

```powershell
python scripts/strategy-selection/qfa-611-strategy-selection.py --strategy-ids regime_shock_reversion_short_v4_delay regime_shock_reversion_short_v4_persist --held-out-dir artifacts/held-out-validation/cycle4-v4-inference-01 --lock-manifest artifacts/strategy-selection/qfa611-cycle4-v4-inference-01-parameter-locks.json --json-out artifacts/strategy-selection/strategy-selection-cycle4-v4-inference-01.json --md-out artifacts/strategy-selection/strategy-selection-cycle4-v4-inference-01.md
```

| Selection artifact | SHA-256 |
|---|---|
| `strategy-selection-cycle4-v4-inference-01.json` | `483a9e6e6a5955dc915000e2ea8bf56c7d6265e5a28ddbd464b002dbb1d6df85` |
| `strategy-selection-cycle4-v4-inference-01.md` | `c82cab6021fa26ed7ddc26308113a0dd14ee572f5dfebab5d755f29dc05581be` |

| Summary field | Value |
|---|---:|
| `advance_count` | 0 |
| `research_further_count` | 0 |
| `reject_count` | 2 |
| `phase_6_dispatch_authorized` | false |
| `effective_trial_count` | 2 |

Input hashes:

| Hash | Value |
|---|---|
| `input_phase2_hash` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` |
| `input_phase4_hash` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` |
| `input_substrate_hash` | `f90e3e6df588a60756c675befe7fd77adf1a33ed3878fbb8900d519b79f0a41a` |

## 7. Per-strategy metrics

| Strategy | Verdict | Reason | Trades | PF | Win rate | Sharpe | DSR | PSR zero | Max drawdown | Net PnL cents |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `regime_shock_reversion_short_v4_delay` | REJECT | `three_or_more_stage1_thresholds_failed` | 1031 | 0.787309 | 43.7439% | -3.3016671241 | 0.0062045913 | 0.0238217652 | 7.3440% | -226250 |
| `regime_shock_reversion_short_v4_persist` | REJECT | `three_or_more_stage1_thresholds_failed` | 985 | 0.794334 | 44.4670% | -3.6085875423 | 0.0028657030 | 0.0124481040 | 6.2620% | -203650 |

Threshold results:

| Strategy | PF | Sharpe | DSR | PSR zero | Drawdown | Sensitivity | Hurdle | Trade count | Regime trade |
|---|---|---|---|---|---|---|---|---|---|
| `regime_shock_reversion_short_v4_delay` | failed | failed | failed | failed | passed | failed | failed | passed | passed |
| `regime_shock_reversion_short_v4_persist` | failed | failed | failed | failed | passed | failed | failed | passed | passed |

Both strategies fail 6 of 9 ADR-0016 Stage 1 thresholds.

## 8. Delay vs persistence comparison

The persistence variant is slightly less negative on net PnL, profit factor, max drawdown, and win rate in this run, while both variants are decisively rejected by the ADR-0016 selection driver.

| Metric | v4 delay | v4 persist |
|---|---:|---:|
| Total trades | 1031 | 985 |
| Net PnL cents | -226250 | -203650 |
| Profit factor | 0.787309 | 0.794334 |
| Win rate | 43.7439% | 44.4670% |
| Annualized Sharpe | -3.3016671241 | -3.6085875423 |
| Max drawdown | 7.3440% | 6.2620% |
| DSR probability | 0.0062045913 | 0.0028657030 |

This is observed-metric framing only. It does not imply strategy superiority, paper-observation readiness, or promotion authority.

## 9. CYCLE4-R2 caveats and what changed under real replay

CYCLE4-R2 hold-time evidence was an upper-bound research read and was partially forward-looking. CYCLE4-R2 errata required any v4-delay or v4-persist implementation to consume producer-owned state rather than strategy-local timers or wall-clock assumptions.

This run is the first real held-out replay check of committed v4 logic using `signed_shock_vwap_recent_values`. The real replay outcome is materially weaker than the hypothesis screen: both variants produce negative net PnL, fail six ADR-0016 Stage 1 thresholds, and receive `REJECT`.

Gate-specific blocked-evaluation counts are not serialized by the held-out artifact schema. Emitted trades necessarily passed the variant-specific gate for their strategy ID, but the artifacts do not expose a per-evaluation delay-confirmation or persistence-confirmation flag. Therefore, this memo does not fabricate unavailable blocked-reason counts.

| Strategy | Emitted trades that passed variant gate | Serialized blocked gate counts |
|---|---:|---|
| `regime_shock_reversion_short_v4_delay` | 1031 | Not serialized |
| `regime_shock_reversion_short_v4_persist` | 985 | Not serialized |

## 10. Governance interpretation

Both v4 variants remain REGISTERED_INACTIVE. This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, and does not mutate ACTIVE_STRATEGY_IDS.

The qfa-611 verdicts are informational governance evidence only. Any future activation, paper observation, broker dispatch, strategy roster mutation, or Phase 6 authorization would require separate operator/governance authorization and a separate implementation ticket.

## 11. Verification

Completed generation checks:

| Check | Result |
|---|---|
| Lock manifest generated twice from clean state | byte-identical |
| No-artifact diagnostic | 6/6 executed windows for both strategies |
| Held-out qfa-410b artifacts generated twice | byte-identical |
| qfa-611 selection JSON/MD generated twice | byte-identical |
| Standard sizing | no `--research-fixed-contracts` override |

Required PROCESS-02 verification is reported in the worker Step 7 report.

## 12. Open decisions / next steps

The selection driver rejected both v4 variants. A governance reconciliation memo may be useful if the operator wants an explicit Cycle4 v4 closure record mirroring the v5 reconciliation pattern.

No follow-up implementation is authorized by this memo.
