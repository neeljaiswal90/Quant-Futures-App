# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-OBSERVATION-DAY-SCOPE-01

Determination: `OBSERVATION_DAY_SCOPE_BLOCKED_REQUIRES_FULL_SESSION_RUNTIME`

## Decision

The bounded 2026-06-02 paper-runtime candidate smoke does not count as an observation day by itself. It proves source-backed candidate plumbing, but it is a single-snapshot control proof rather than a full-session/window paper-runtime accounting unit.

| Field | Value |
|---|---|
| candidate_only_smoke_sufficient_for_day_credit | `false` |
| observation_day_eligible | `false` |
| observation_day_increment | `0` |
| implementation_authorized_by_this_ticket | `false` |
| order_path_simulation_required_by_this_scope | `false` |

## PR #314 evidence

| Marker | Count |
|---|---:|
| STRAT_EVAL | 1 |
| CANDIDATE | 1 |
| ORDER_INTENT | 0 |

## Minimum evidence contract before increment may become 1

- Full-session/window paper-runtime manifest is required.
- Observation window must be explicit and cannot be a single snapshot.
- Source-backed feature snapshots must cover the declared window sufficiently for accounting.
- Strategy-runtime marker accounting must cover the declared window.
- ORDER_INTENT/order translation/adapter/broker/fill paths remain suppressed unless separately authorized.
- qfa-410b/qfa-611, broker/live, Phase 6, and roster authority remain outside this ticket.

## Source anchors

| PR | Label | LF SHA-256 |
|---:|---|---|
| 311 | `candidate_eligible_source_backed_snapshot` | `5984e170f795f5c96309407bd262c473d6e59f347145d8ef8284d82bf9350784` |
| 312 | `candidate_strat_eval_smoke` | `765ba5a666cc0f3712d55add72dc899836d2bfbd7be5a146b61f8823a0f72a7b` |
| 313 | `paper_runtime_candidate_smoke_scope` | `ddb8195b26df162b5f0c45173edb59e8afd5e80c9e679355f4551e2b38d48a59` |
| 314 | `paper_runtime_candidate_smoke_impl` | `c443e34f3c724e2b4ec962e4f05f77b5ed7ddc6f0591622d9ae888888801b52f` |

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded JSONL | `c04d54964923b77dbc8c6d94fc7dd4e974e79facd9e0449e635f12e311b71e06` |
| report JSON | `bce140ece37f237d561f2d37289f85f703d91645250b44d3bdddf4e3fe33500d` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-SCOPE-01`
