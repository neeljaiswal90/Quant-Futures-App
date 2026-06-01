# QFA-402C-FIDELITY-COVERAGE-EXTEND-01 diagnostic artifact

## Determination

SENSITIVITY_PASS_AFTER_COVERAGE_EXTENSION

The qfa-402c coverage gap for the v2 UTC 16-18 registered-inactive variant is resolved by adding real observed probes from `2026-04-16-rth`. qfa-611 now reports `ADVANCE_TO_PAPER` and `phase_6_dispatch_authorized: true`, but this artifact creates no roster, paper, broker/live, or Phase 6 authority. Extra nuance is preserved as qfa611_outcome: `ADVANCE_TO_PAPER`; authority_created: `false`.

## Source observation inventory

- Synthetic probes used: `false`
- Selected real source session: `2026-04-16-rth`
- Confirmed label: `low`
- Primary percentile: `0.266667`
- VXN percentile: `0.183333`

## qfa-402c byte equality

| Item | Value |
|---|---|
| Old qfa-402c SHA-256 | `fe17a87886ad7282292d4e1ed9e99fb51bb6c0e8a572475364568715614b8866` |
| New qfa-402c SHA-256 | `548f11c4f2213026484b238ad0246abbc2987d66387b3dcf589ec20a79663ab3` |
| A/B byte-equal | `true` |

## Target cell reconciliation

| Cell | Before probes | After probes | After share ppm | After status | Strategy trades |
|---|---:|---:|---:|---|---:|
| low|1-tick|1-5 | 0 | 14095 | 932742 | clean | 62 |
| low|1-tick|6-20 | 0 | 2733 | 881814 | clean | 6 |
| low|2-tick|1-5 | 0 | 8868 | 841339 | clean | 84 |
| low|2-tick|6-20 | 0 | 20027 | 874319 | clean | 156 |
| low|2-tick|21+ | 0 | 75 | 560000 | low_fidelity | 1 |
| low|3+ ticks|1-5 | 0 | 564 | 739361 | low_fidelity | 20 |
| low|3+ ticks|6-20 | 0 | 383 | 592689 | low_fidelity | 22 |

## qfa-611 before / after

| Field | Before | After |
|---|---:|---:|
| Unknown-cell trades | 351 | 0 |
| Unknown-cell fraction | 47.50% | 0.00% |
| Low-fidelity trades | 0 | 43 |
| Low-fidelity fraction | 0.00% | 5.82% |
| Sensitivity audit pass | false | true |
| Verdict | RESEARCH_FURTHER | ADVANCE_TO_PAPER |
| Phase 6 dispatch authorized in qfa-611 output | false | true |

## Authority caveat

This diagnostic and qfa-611 rerun are governance evidence only. They do not mutate `ACTIVE_STRATEGY_IDS`, do not authorize paper observation, do not authorize broker/live dispatch, and do not create Phase 6 authority by PR alone.
