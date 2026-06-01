# QFA-402C-FIDELITY-COVERAGE-EXTEND-01 memo

## 1. Context

PR #287 showed that the standing qfa-611 `RESEARCH_FURTHER` verdict for `regime_shock_reversion_short_v2_utc_16_18_exclusion` was dominated by qfa-402c zero-probe coverage, not observed low-fidelity fragility. This ticket extends the shared qfa-402c fidelity substrate with real low-regime source observations and reruns qfa-611 explicitly against the updated fidelity artifact.

## 2. Source observation inventory

The old qfa-402c artifact had zero probes in the seven low-regime cells used by the variant's low-regime trades. The local source corpus contains 11 confirmed-low April sessions with available source schemas. The committed extension selects `2026-04-16-rth`, a real full-RTH low-regime session with available `mbo`, `mbp-1`, and `trades` inputs. No synthetic probes are used.

## 3. qfa-402c substrate change

The qfa-402c generator now reads the April manifest and adds `apr16_low_full_rth` to `SESSION_CONFIGS`. The artifact schema remains `schema_version: 1`; the cell shape is unchanged.

## 4. Target cell before / after

| Cell | Before probes | After probes | After share ppm | After status | Strategy trades |
|---|---:|---:|---:|---|---:|
| low|1-tick|1-5 | 0 | 14095 | 932742 | clean | 62 |
| low|1-tick|6-20 | 0 | 2733 | 881814 | clean | 6 |
| low|2-tick|1-5 | 0 | 8868 | 841339 | clean | 84 |
| low|2-tick|6-20 | 0 | 20027 | 874319 | clean | 156 |
| low|2-tick|21+ | 0 | 75 | 560000 | low_fidelity | 1 |
| low|3+ ticks|1-5 | 0 | 564 | 739361 | low_fidelity | 20 |
| low|3+ ticks|6-20 | 0 | 383 | 592689 | low_fidelity | 22 |

## 5. qfa-611 rerun

qfa-611 was rerun with explicit fidelity input:

`python scripts/strategy-selection/qfa-611-strategy-selection.py --strategy-ids regime_shock_reversion_short_v2_utc_16_18_exclusion --held-out-dir artifacts/held-out-validation/v2-pf-c-late-am-registered-inactive-impl-01 --lock-manifest artifacts/strategy-selection/qfa611-v2-pf-c-late-am-registered-inactive-impl-01-parameter-locks.json --fidelity artifacts/regime-fidelity/qfa-402c-stratified-cells-v1.json --json-out artifacts/strategy-selection/strategy-selection-qfa-402c-fidelity-coverage-extend-01.json --md-out artifacts/strategy-selection/strategy-selection-qfa-402c-fidelity-coverage-extend-01.md`

The rerun is byte-stable. JSON SHA-256 is `580b09f2db2bb10d3c1e4072ec7c6f85d6da9319f15d426c3f5fefc2c289724b`; Markdown SHA-256 is `e55473a46b7c336ff8bb35622387d76438bec478b38f7dffadf520aca7cb628a`.

## 6. Verdict interpretation

The qfa-611 rerun changes the variant from `RESEARCH_FURTHER` to `ADVANCE_TO_PAPER`. The sensitivity audit now passes: unknown-cell trade count falls from `351` to `0`, and low-fidelity trade count is `43` / `5.82%`, below the qfa-611 concentration threshold. qfa-611 also emits `phase_6_dispatch_authorized: true`.

Additional outcome fields: qfa611_outcome: `ADVANCE_TO_PAPER`; authority_created: `false`.

This is evidence, not authority. The strategy remains registered inactive unless a separate governance ticket mutates rosters or dispatch authority.

## 7. PROCESS-03 expectation

This is an evidence-surface substrate change. The expected drift class is qfa-402c evidence-surface drift plus qfa-611 selection-output drift. It should not imply runtime, strategy, roster, management, or journal drift.

## 8. Verification

Required verification commands are reported in the worker Step 7 report. The qfa-402c artifact and qfa-611 selection outputs were each generated twice and compared byte-for-byte.

## 9. Recommended next ticket

Recommended next ticket: `V2-PF-C-LATE-AM-GOVERNANCE-DECISION-01`. The decision should review the updated qfa-611 `ADVANCE_TO_PAPER` evidence and decide whether any paper-observation or Phase 6 authority should be granted. This PR itself grants none.

## 10. Authority caveat

This PR does not activate any strategy, does not mutate `ACTIVE_STRATEGY_IDS`, does not authorize paper observation, does not authorize broker/live dispatch, and does not create Phase 6 authority by itself.
