# V2-PF-REGISTERED-INACTIVE-VARIANT-SCOPE-01

## 1. Context

This scope note converts the PR #284 corrected-engine v2 PF-improvement finding into an implementation-ready follow-up ticket. It is scope-only: no strategy, registry, config, runtime, held-out artifact, selection artifact, roster, ADR, paper, broker/live, or Phase 6 authority change is made here.

The current governance state remains:

| Item | State |
| --- | --- |
| Existing v2 strategy | `regime_shock_reversion_short_v2` |
| v2 roster state | `REGISTERED_INACTIVE` |
| Active roster | `[]` |
| Candidate roster | `[]` |
| Explicit replay | available through `STRATEGY_GENERATORS` |
| Authority created by this scope | none |

## 2. Source evidence from PR #284

PR #284 (`V2-PF-IMPROVEMENT-MECHANISM-SCOPE-01`) found one eligible non-coverage-dependent pre-entry mechanism:

```text
exclude_time_tier_C_late_am
```

The implementable mechanism is fixed UTC time exclusion:

```text
Block entries where 16:00:00 <= entry timestamp UTC < 18:00:00.
```

Source evidence:

| Metric | Value |
| --- | ---: |
| Baseline corrected-engine v2 PF | 1.241954 |
| ADR-0016 PF threshold | 1.35 |
| Remaining PF after exclusion | 1.359500 |
| Remaining trades | 736 / 1098 |
| Removed trades | 362 / 1098 |
| Removed fraction | 32.969% |
| PR #284 determination | `REGISTERED_INACTIVE_VARIANT_SCOPE_JUSTIFIED` |

Coverage-dependence proof from PR #284:

| Split | Trades | PF | Net |
| --- | ---: | ---: | ---: |
| Removed clean | 220 | 1.094125 | +15700 cents |
| Removed unknown zero-probe | 142 | 0.880952 | -11250 cents |
| Remaining clean | 387 | 1.549666 | +168500 cents |
| Remaining unknown zero-probe | 349 | 1.058155 | +11250 cents |

The candidate is not justified by qfa-402c coverage status alone. It removes and retains both clean and unknown zero-probe trades, and no low-fidelity or unknown-missing-cell trades appear in the split.

## 3. Proposed future strategy ID

Recommended future strategy ID:

```text
regime_shock_reversion_short_v2_utc_16_18_exclusion
```

Rationale:

| Option | Disposition | Reason |
| --- | --- | --- |
| `regime_shock_reversion_short_v2_utc_16_18_exclusion` | preferred | names the implementable fixed UTC mechanism directly |
| `regime_shock_reversion_short_v2_exclude_c_late_am` | acceptable fallback | preserves PR #284 analysis vocabulary, but is less explicit |

The future implementation ticket may refine the exact ID to match repository naming constraints, but it should preserve two facts:

1. The variant is v2-derived.
2. The variant blocks UTC hour 16 and UTC hour 17 entries.

The future variant must be added to `REGISTERED_INACTIVE_STRATEGY_IDS` only. It must not mutate `regime_shock_reversion_short_v2`, `ACTIVE_STRATEGY_IDS`, or `CANDIDATE_STRATEGY_IDS`.

## 4. Proposed gate semantics

Future gate semantics:

```typescript
const entryHourUtc = getUtcHour(entrySignalTimestamp);
if (entryHourUtc === 16 || entryHourUtc === 17) {
  blockEntry();
}
```

Timestamp-source guardrail:

| Source | Disposition |
| --- | --- |
| Strategy decision / snapshot timestamp available at entry-signal generation time | required |
| Fill timestamp | not allowed |
| Exit timestamp | not allowed |
| `session_id` | diagnostic context only |
| Exchange-local time | not allowed |
| DST-adjusted local clock | not allowed |
| Post-entry data | not allowed |

Implementation preflight item: identify the exact existing timestamp field that is causally available at entry-signal generation time, then derive the UTC hour from that field. If no such timestamp is available without runtime/schema changes, the implementation worker should stop and request scope review.

This gate is fixed UTC logic. It is not "late morning" in local exchange time, not session memorization, and not DST-adjusted.

Boundary semantics:

| Entry timestamp UTC | Expected |
| --- | --- |
| 15:59:59.999 | allow |
| 16:00:00.000 | block |
| 17:59:59.999 | block |
| 18:00:00.000 | allow |

## 5. Implementation surface map

Expected future implementation surfaces:

| Surface | Likely file(s) | Expected action |
| --- | --- | --- |
| Strategy IDs | `apps/strategy_runtime/src/contracts/strategy-ids.ts` | add new ID to `REGISTERED_INACTIVE_STRATEGY_IDS` only |
| Run ID abbreviation | `apps/strategy_runtime/src/contracts/run-id.ts` | add deterministic abbreviation for the new ID |
| Strategy config typing | `apps/strategy_runtime/src/config/strategy-config.ts`, `apps/strategy_runtime/src/config/index.ts` | register config key and parser wiring if the variant has its own YAML |
| Strategy YAML | `config/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml` | define variant config, likely mirroring v2 plus the UTC exclusion parameter |
| Generator | new strategy generator file or shared v2 wrapper | preserve v2 behavior except for the UTC entry block |
| Registry | `apps/strategy_runtime/src/strategies/registry.ts` | register generator for explicit lookup, not active execution |
| Backtester config map | `apps/backtester/src/run-spec-builder.ts` | map the new ID to its config path if required |
| Tests/fixtures | existing strategy ID, registry, config, YAML, run-id, and strategy unit tests | prove registration, explicit replay, UTC boundaries, and active-roster isolation |

Do not implement any of these surfaces in this scope ticket.

## 6. Test plan for future implementation

Required future tests:

| Case | Expected |
| --- | --- |
| UTC hour 15 | allows |
| UTC hour 16 | blocks |
| UTC hour 17 | blocks |
| UTC hour 18 | allows |
| Boundary 15:59:59.999 UTC | allows |
| Boundary 16:00:00.000 UTC | blocks |
| Boundary 17:59:59.999 UTC | blocks |
| Boundary 18:00:00.000 UTC | allows |
| DST-sensitive calendar date | still uses fixed UTC hour, not exchange-local time |
| Existing v2 generator | unchanged |
| New variant roster state | registered inactive only |
| Explicit generator lookup | works through `STRATEGY_GENERATORS` |
| Active executable list | remains empty |
| qfa-611 selection driver | consumes future additive artifacts without strategy-authority change |

The DST-sensitive test does not need to model local time. It should simply prove that the UTC hour is used directly on dates where local time would be tempting to reinterpret.

## 7. Held-out replay / qfa-611 plan for future implementation

The future implementation ticket must rerun evidence for the new registered-inactive ID. PR #284 is proxy evidence only; it is not verdict evidence for an implemented variant.

Expected future evidence plan:

1. Run explicit registered-inactive qfa-410b held-out replay for the new variant ID.
2. Use standard sizing unless a separately approved packet says otherwise.
3. Generate held-out artifacts twice from clean output directories and assert byte equality.
4. Generate qfa-611 selection JSON and Markdown twice and assert byte equality.
5. Record parameter locks and metadata as committed evidence inputs if the established workflow requires them.
6. Compare the implemented variant against the PR #284 proxy expectation, including trade count, PF, verdict, and threshold table.
7. Preserve the no-authority caveat even if qfa-611 improves.

The future implementation ticket must not rely solely on PR #284's exclusion proxy.

## 8. Coverage-dependence caveat

PR #284 established that `exclude_time_tier_C_late_am` is not justified solely by qfa-402c coverage status. The candidate removes both clean and unknown zero-probe trades and leaves both clean and unknown zero-probe trades.

However, qfa-402c coverage gaps remain a separate unresolved issue. They should not be converted into strategy logic. In particular:

| Coverage item | Treatment |
| --- | --- |
| Unknown zero-probe cells | fidelity substrate issue, not strategy gate |
| Low-regime coverage gaps | fidelity substrate issue, not strategy gate |
| `session_id` concentration | diagnostic context only |
| UTC 16-18 exclusion | the only scoped candidate mechanism |

The future implementation should preserve this distinction in both the PR body and research memo.

## 9. Risks and overfit controls

| Risk | Control |
| --- | --- |
| Time-window overfit | fixed PR #284 mechanism only; do not mine new windows |
| Session memorization | use timestamp-derived UTC hour, not `session_id` |
| Local-time ambiguity | fixed UTC semantics; no DST adjustment |
| Coverage proxy leakage | retain qfa-402c caveat and do not encode coverage category |
| Existing v2 behavior drift | implement as a new registered-inactive ID only |
| Proxy-to-implementation mismatch | rerun qfa-410b/qfa-611 for the implemented variant |
| Authority creep | no active, candidate, paper, broker/live, Phase 6, or ADR authority |

## 10. Recommended next ticket

Recommended next ticket:

```text
V2-PF-C-LATE-AM-REGISTERED-INACTIVE-IMPL-01
```

Recommended title:

```text
Implement registered-inactive v2 UTC 16-18 exclusion variant and rerun held-out evidence
```

Expected class:

```text
Code/config/test/evidence implementation, registered-inactive only, no authority change
```

Minimum locked decisions for that ticket:

1. Add exactly one new v2-derived registered-inactive ID.
2. Preserve existing v2 behavior.
3. Block entries only for UTC hours 16 and 17.
4. Use entry-signal timestamp, not fill timestamp, local time, session ID, or post-entry data.
5. Keep active and candidate rosters empty.
6. Rerun explicit qfa-410b/qfa-611 evidence for the new ID.

## 11. Authority caveat

This scope memo does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, does not authorize Phase 6, does not mutate `ACTIVE_STRATEGY_IDS`, and does not mutate `CANDIDATE_STRATEGY_IDS`.

The proposed future variant, if implemented, must remain registered inactive until a separate governance decision says otherwise.
