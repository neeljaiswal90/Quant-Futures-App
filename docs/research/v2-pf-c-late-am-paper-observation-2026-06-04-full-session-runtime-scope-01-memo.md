# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-SCOPE-01 memo

Determination: `FULL_SESSION_RUNTIME_SCOPE_READY_FOR_IMPL`

This ticket defines the bounded 2026-06-04 full-session/window paper-runtime evidence contract. It does not run the full session, emit order intent, or increment observation-day credit.

Contract: 390 RTH accounting slots from `13:30:00Z` inclusive to `20:00:00Z` exclusive. PR #320 proves `source_ready_slots = 390`, `warmup_excluded_slots = 13`, and `feature_computable_slots = 377`; therefore the next implementation should ingest 377 source-backed feature snapshots while reporting all 390 accounting slots and the 13 warmup exclusions.

The stop-after-candidate guard remains required: STRAT_EVAL and CANDIDATE may emit, while RANK, SIZING, RISK_GATE, ORDER_INTENT, SIM_FILL, POSITION, order translation, adapters, broker/live, fills, and observation-day credit remain suppressed.

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-IMPL-01`.

Output hashes: bounded `c74b61c1b9f408b3e2c42b92f2c9d0f07a2d0811009951a0189e5c76a2f126ee`, report JSON `78752d28dfd24d811c5373a3fa0b219eef5cf72f5cb2f8f76d01fc7c8a4a2e13`, report MD `1203751e6d1ac80c3b764f1c83337074b61db797175ee7ddfce5def707b4e653`.
