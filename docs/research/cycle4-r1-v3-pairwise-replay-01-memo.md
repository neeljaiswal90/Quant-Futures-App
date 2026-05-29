# CYCLE4-R1-V3-PAIRWISE-REPLAY-01 Memo

## 1. Context

This memo records an explicit registered-inactive pairwise held-out replay comparing `regime_shock_reversion_short_v2` against `regime_shock_reversion_short_v3`. PR #266 established that v3 already implements the VIX overfire-band gate, so this ticket measures the existing v3 gate against the v2 baseline instead of implementing a duplicate variant.

This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, and does not mutate `ACTIVE_STRATEGY_IDS`.

## 2. Substrate and roster

| Item | Value |
|---|---|
| Base substrate | `d3f6a4cbabd40fc9f9ca957f77eb263e8de102e8` or later |
| Active roster | `[]` |
| Candidate roster | `[]` |
| Replay roster | `regime_shock_reversion_short_v2`, `regime_shock_reversion_short_v3` |
| Roster status | Both strategies are `REGISTERED_INACTIVE` and generator-backed for explicit replay |
| Sizing | Standard qfa-410b fill policy, default order quantity `1` |

## 3. Lock manifest and metadata

| Artifact | SHA-256 |
|---|---|
| Parameter lock manifest | `23ce85c736671c3a027e2509595c811e1bec5d6b0b03714d990b86c384372af5` |
| Metadata | `2c191b4687ecb6be51ecca4c6b67030aa7d702de32fcb5ab30fc63aa173939cf` |

| Strategy | Parameter lock hash | Parameter lock source |
|---|---|---|
| `regime_shock_reversion_short_v2` | `b66db14a2346a34b9992982450aacb3e064c6611943006573390fef8cfe94492` | `qfa611-cycle4-r1-v3-pairwise-replay-01-parameter-locks` |
| `regime_shock_reversion_short_v3` | `f3d99466c5ff8e464c421d13008d5cce57beec02141f483c6f4e633baf1cfe52` | `qfa611-cycle4-r1-v3-pairwise-replay-01-parameter-locks` |

Both the lock manifest and metadata were generated twice from clean temporary paths and were byte-identical before the final files were written.

## 4. No-artifact diagnostic

The no-artifact diagnostic was run through `executeHeldOutValidationAgainstArchive` with qfa-410b archive sessions, the default walk-forward policy, explicit v2/v3 strategy IDs, standard fill policy, and `artifact_output: undefined`. Per Rev-1, this diagnostic is a coverage gate only; it is not the verdict evidence surface.

| Strategy | Executed windows | Failed windows | Skipped windows | Diagnostic closed trades |
|---|---:|---:|---:|---:|
| `regime_shock_reversion_short_v2` | 6 | 0 | 0 | 1098 |
| `regime_shock_reversion_short_v3` | 6 | 0 | 0 | 889 |

Per-window diagnostic matrix:

| Strategy | Window | Test range | Status | Trades | Elapsed seconds |
|---|---|---|---|---:|---:|
| `regime_shock_reversion_short_v2` | `wf-1-1` | 2026-03-17-rth to 2026-03-24-rth | `executed` | 71 | 64.229 |
| `regime_shock_reversion_short_v2` | `wf-1-2` | 2026-03-24-rth to 2026-03-31-rth | `executed` | 60 | 152.05 |
| `regime_shock_reversion_short_v2` | `wf-1-3` | 2026-03-31-rth to 2026-04-08-rth | `executed` | 301 | 161.21 |
| `regime_shock_reversion_short_v2` | `wf-1-4` | 2026-04-08-rth to 2026-04-15-rth | `executed` | 175 | 102.649 |
| `regime_shock_reversion_short_v2` | `wf-1-5` | 2026-04-15-rth to 2026-04-22-rth | `executed` | 140 | 108.022 |
| `regime_shock_reversion_short_v2` | `wf-1-6` | 2026-04-22-rth to 2026-04-29-rth | `executed` | 351 | 128.52 |
| `regime_shock_reversion_short_v3` | `wf-1-1` | 2026-03-17-rth to 2026-03-24-rth | `executed` | 71 | 62.788 |
| `regime_shock_reversion_short_v3` | `wf-1-2` | 2026-03-24-rth to 2026-03-31-rth | `executed` | 60 | 149.801 |
| `regime_shock_reversion_short_v3` | `wf-1-3` | 2026-03-31-rth to 2026-04-08-rth | `executed` | 92 | 134.322 |
| `regime_shock_reversion_short_v3` | `wf-1-4` | 2026-04-08-rth to 2026-04-15-rth | `executed` | 175 | 100.48 |
| `regime_shock_reversion_short_v3` | `wf-1-5` | 2026-04-15-rth to 2026-04-22-rth | `executed` | 140 | 106.414 |
| `regime_shock_reversion_short_v3` | `wf-1-6` | 2026-04-22-rth to 2026-04-29-rth | `executed` | 351 | 129.341 |

## 5. Held-out artifact reproducibility

qfa-410b artifact generation was run twice from clean output directories. The committed artifact files were byte-identical to the second run.

| Strategy | Artifact | SHA-256 | Windows | Trades | Capability |
|---|---|---|---:|---:|---|
| `regime_shock_reversion_short_v2` | `artifacts/held-out-validation/cycle4-r1-v3-pairwise-replay-01/regime_shock_reversion_short_v2-feb-mar-apr-2026.json` | `e5c764269f87cf5c0e5c52d552372dceef41c1937a479eedab0e3e6a9718e691` | 6 | 1098 | `ready_for_replay` |
| `regime_shock_reversion_short_v3` | `artifacts/held-out-validation/cycle4-r1-v3-pairwise-replay-01/regime_shock_reversion_short_v3-feb-mar-apr-2026.json` | `40c3941a3351fd915da9c40835268eaa076caac4e23f92fc985b47f69d6f83c2` | 6 | 889 | `ready_for_replay` |

## 6. Selection output

qfa-611 selection was run twice against the committed qfa-410b artifacts. JSON and Markdown outputs were byte-identical.

| Output | SHA-256 |
|---|---|
| Selection JSON | `f03c823129ff12b28f23b0d07893868e93c837b87f552b02fbc476d302c81df6` |
| Selection Markdown | `15f7ca86705ccbf7f34520b4d4b18eee601d750d0a57bc72f8ba4bc72f86b59d` |

| Summary field | Value |
|---|---:|
| `advance_count` | `0` |
| `phase_6_dispatch_authorized` | `False` |
| `reject_count` | `2` |
| `research_further_count` | `0` |
| `effective_trial_count` | `2` |
| `input_phase2_hash` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` |
| `input_phase4_hash` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` |

## 7. v2 vs v3 pairwise comparison

| Metric | v2 baseline | v3 VIX-gated | Directional read |
|---|---:|---:|---|
| Trades | 1098 | 889 | -209 |
| Profit factor | 0.815977 | 0.886126 | +0.070149 |
| Win rate | 0.444444 | 0.43982 | -0.004624 |
| Annualized Sharpe | -2.986798193 | -1.722508153 | +1.26429004 |
| DSR probability | 0.0155316215 | 0.0814956023 | +0.0659639808 |
| PSR zero | 0.0508668374 | 0.1906981795 | +0.1398313421 |
| PSR hurdle | 0.0027900914 | 0.0163915242 | +0.0136014328 |
| HAC t-stat | -1.094076775 | -0.6730668586 | +0.421009916 |
| Max drawdown | 0.073 | 0.05095 | -0.02205 |
| Annualized return | -0.1730264516 | -0.083403871 | +0.0896225806 |

| Strategy | Net PnL | Gross profit | Gross loss | Max drawdown cents | Exit taxonomy |
|---|---:|---:|---:|---:|---|
| `regime_shock_reversion_short_v2` | -$2,128.50 | $9,438.00 | -$11,566.50 | 365000 | fail_safe: 315, session_close: 6, stop_loss: 469, target: 308 |
| `regime_shock_reversion_short_v3` | -$1,026.00 | $7,984.00 | -$9,010.00 | 254750 | fail_safe: 262, session_close: 5, stop_loss: 363, target: 259 |

Window-level trade and PnL comparison:

| Window | Test range | v2 trades | v2 net PnL | v3 trades | v3 net PnL |
|---|---|---:|---:|---:|---:|
| 1 | 2026-03-17-rth to 2026-03-24-rth | 71 | $815.00 | 71 | $815.00 |
| 2 | 2026-03-24-rth to 2026-03-31-rth | 60 | $469.00 | 60 | $469.00 |
| 3 | 2026-03-31-rth to 2026-04-08-rth | 301 | -$1,575.50 | 92 | -$473.00 |
| 4 | 2026-04-08-rth to 2026-04-15-rth | 175 | -$639.00 | 175 | -$639.00 |
| 5 | 2026-04-15-rth to 2026-04-22-rth | 140 | $108.50 | 140 | $108.50 |
| 6 | 2026-04-22-rth to 2026-04-29-rth | 351 | -$1,306.50 | 351 | -$1,306.50 |

## 8. VIX-gate interpretation

v3 gates on `vix_prior_close_percentile` and blocks the overfire band `0.67 <= percentile < 0.85`. The pairwise replay shows the gate was active only where the corpus exposed that band in the test window.

| Window | Test range | Test sessions | Overfire-band sessions | Sessions in blocked band |
|---|---|---:|---:|---|
| 1 | 2026-03-17-rth to 2026-03-24-rth | 6 | 0 | none |
| 2 | 2026-03-24-rth to 2026-03-31-rth | 6 | 0 | none |
| 3 | 2026-03-31-rth to 2026-04-08-rth | 6 | 4 | 2026-04-01-rth, 2026-04-02-rth, 2026-04-06-rth, 2026-04-07-rth |
| 4 | 2026-04-08-rth to 2026-04-15-rth | 6 | 0 | none |
| 5 | 2026-04-15-rth to 2026-04-22-rth | 6 | 0 | none |
| 6 | 2026-04-22-rth to 2026-04-29-rth | 6 | 0 | none |

The trade-count delta is concentrated in window 3: v2 emitted 301 trades while v3 emitted 92. The four overfire-band sessions in that test window were `2026-04-01-rth`, `2026-04-02-rth`, `2026-04-06-rth`, and `2026-04-07-rth`. Other windows have identical v2/v3 trade counts, which is consistent with no overfire-band exposure in those test windows.

This is comparative evidence, not promotion evidence. v3 improved several aggregate risk/performance values relative to v2 in this pairwise run, but qfa-611 still rejects both strategies.

## 9. Threshold pass/fail comparison

| Threshold | v2 baseline | v3 VIX-gated |
|---|---|---|
| Trade count | passed | passed |
| Regime trade | passed | passed |
| Profit factor | failed | failed |
| Sharpe | failed | failed |
| DSR | failed | failed |
| PSR zero | failed | failed |
| Hurdle | failed | failed |
| Drawdown | passed | passed |
| Sensitivity audit | failed | failed |

| Strategy | Verdict | Verdict reason | Phase 6 dispatch authorized |
|---|---|---|---|
| `regime_shock_reversion_short_v2` | `REJECT` | `three_or_more_stage1_thresholds_failed` | `false` |
| `regime_shock_reversion_short_v3` | `REJECT` | `three_or_more_stage1_thresholds_failed` | `false` |

Both strategies fail six of nine Stage 1 threshold fields: profit factor, Sharpe, DSR, PSR zero, hurdle, and sensitivity audit. Both pass trade count, regime trade, and drawdown. The verdict for both is `REJECT` with reason `three_or_more_stage1_thresholds_failed`.

## 10. Authority and governance caveat

This evidence does not authorize activation, paper observation, broker/live dispatch, Phase 6, or any roster mutation. Both strategies remain registered-inactive research surfaces. Any future implementation or authority change requires a separate governance ticket and operator countersign.

## 11. Verification

Verification commands to run before PENDING-REVIEW report:

- `npx vitest run`
- `npx tsc -b tsconfig.json`
- `npm run lint --if-present`
- `python -m pytest scripts/strategy-selection/_lib/tests`
- `npx tsx scripts/backtester/check-determinism.mts`

Byte-equality checks already completed for lock manifest, metadata, qfa-410b artifacts, and qfa-611 JSON/MD outputs.

## 12. Open coordinator/operator decisions

- Whether v3 deserves a targeted follow-up despite a pairwise `REJECT` verdict, based on its risk improvement relative to v2.
- Whether any future v3 work should remain memo-only, create another registered-inactive variant, or be closed as rejected research.
- No authority decision is implied by this memo.

## 13. Diagnostic-vs-production evidence reconciliation

The final no-artifact diagnostic and qfa-410b production artifacts agree on coverage and trade counts: v2 has `6/6` executed windows and `1098` closed trades; v3 has `6/6` executed windows and `889` closed trades. The authoritative verdict evidence remains the byte-stable qfa-410b artifacts consumed by qfa-611. The diagnostic is retained only as an execution-coverage gate.
