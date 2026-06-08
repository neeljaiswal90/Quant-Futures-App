# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-OBSERVATION-DAY-SCOPE-01

Determination: `OBSERVATION_DAY_SCOPE_BLOCKED_REQUIRES_FULL_SESSION_RUNTIME`

## Decision

The bounded 2026-06-04 paper-runtime candidate smoke does not count as an observation day by itself. It proves source-backed candidate plumbing, but it is a single-snapshot control proof rather than a full-session/window paper-runtime accounting unit.

| Field | Value |
|---|---|
| candidate_only_smoke_sufficient_for_day_credit | `false` |
| observation_day_eligible | `false` |
| observation_day_increment | `0` |
| implementation_authorized_by_this_ticket | `false` |
| order_path_simulation_required_by_this_scope | `false` |

## PR #325 evidence

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
| 322 | `feature_snapshot_compat_repair` | `f5992f535007f7f6270f657693e0ac026386b59f099d1944c25e896a0feae7a1` |
| 323 | `candidate_strat_eval_smoke_rerun` | `8bbb593d9a81272d91de033c479bff0c9fb563212dff77be243a3c222b2b5917` |
| 324 | `paper_runtime_candidate_smoke_scope` | `912fc3807b5fdc31317ea363710c364afab26b146d0b1fd8e617e412fb68659c` |
| 325 | `paper_runtime_candidate_smoke_impl` | `098fb6d8e5e9a9da450bd43b6653dbf51bf74560218207c83430998a12ad44c2` |

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded JSONL | `aa3dabc4f38bee3f764b815b24b316833ae12733cef66fb0b3a0bdfff2f77aac` |
| report JSON | `9c3fd4e8c5d247ef435553797fad6ff51ce719b54333ec9c814888ca87cce7c5` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-SCOPE-01`
