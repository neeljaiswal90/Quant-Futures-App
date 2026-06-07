# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-SCOPE-01 memo

Determination: `FULL_SESSION_RUNTIME_SCOPE_READY_FOR_IMPL`

This ticket defines the minimum bounded full-session/window paper-runtime evidence contract required before any observation-day accounting implementation may be authorized. It does not run the full session, emit order intent, or increment observation-day credit.

PR #314 proved candidate-only paper-runtime plumbing with `STRAT_EVAL = 1`, `CANDIDATE = 1`, `ORDER_INTENT = 0`, and `paper_observation_stop_after_candidate = true`. PR #315 then correctly rejected candidate-only day credit and required full-session/window runtime evidence. This scope converts that requirement into an implementation contract.

The next implementation may ingest source-backed snapshots through the paper runtime only under the explicit paper-observation strategy override and stop-after-candidate guard. The next implementation must still report `ORDER_INTENT = 0`, no order translation, no adapters, no broker/live, no fills, and no observation-day credit.

## Required full-session/window contract

- Observation window basis: `2026-06-02-rth`. The implementation must declare the exact bounded window and fail closed on source coverage gaps.
- Full-session cadence basis: one closed 1m accounting slot from `13:30:00Z` inclusive to `20:00:00Z` exclusive, which yields `390` RTH accounting slots before any explicitly reported warmup/source-gap exclusions.
- The PR #310 `245` bar-point count is diagnostic-only and must not be used as the full-session snapshot requirement.
- Warmup exclusions, skipped slots, missing slots, and failed-closed slots must be reported explicitly by the next implementation.
- Runtime manifest: required.
- Feature snapshot ingest accounting: required, one per source-backed source-ready bar point unless justified skips are reported.
- Strategy marker accounting: `STRAT_EVAL` required; `CANDIDATE` allowed/expected when predicates pass.
- Suppression accounting: `ORDER_INTENT`, `RANK`, `SIZING`, `RISK_GATE`, `SIM_FILL`, and `POSITION` must remain `0` while the stop-after-candidate guard is active.
- Observation accounting remains locked: `observation_day_eligible = false`, `observation_day_increment = 0`.

## Authority caveat

This ticket creates no ORDER_INTENT authority, order translation, order adapter, broker adapter, paper fill, qfa-410b/qfa-611, active/candidate roster mutation, broker/live authority, Phase 6 authority, or observation-day credit.

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded JSONL | `5899646431f908e7e5b78fdf97323869ad2817865359f76e8fff81a33c260e4f` |
| report JSON | `afab7b4fa1367e63ec4bf9797f4890cf9e91a561f941bb706152c58775820c1c` |
| report MD | `9dc61af1d516442c415ae24f62cd71355cd839e4937f8db30c9e10da752eabdd` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-IMPL-01`
