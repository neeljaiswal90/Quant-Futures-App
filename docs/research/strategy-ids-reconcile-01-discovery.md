# STRATEGY-IDS-RECONCILE-01 discovery memo

## 1. Context

This memo maps the implementation plan for reconciling strategy ID rosters with the post-REDERIVATION and Cycle4 verdict reality.

Scope is discovery only. This memo does not change `ACTIVE_STRATEGY_IDS`, `REGISTERED_INACTIVE_STRATEGY_IDS`, `CANDIDATE_STRATEGY_IDS`, strategy YAMLs, management profiles, runtime behavior, selection behavior, artifacts, paper-observation status, broker dispatch, or any ADR.

Execution substrate:

| Field | Value |
|---|---|
| `origin/main` | `8892dae9c63d170c187646256e74124c8424a729` |
| Required memo present | `docs/research/cycle4-v5-verdict-reconcile-01.md` |
| Discovery packet | `docs/plan/strategy-ids-reconcile-01-dispatch-packet.md` |

The motivating mismatch is simple: the codebase still lists three strategies as active, but the current governance evidence says all current active strategies are rejected and no v5 replacement is authorized.

## 2. Current roster inventory

Current roster declarations in `apps/strategy_runtime/src/contracts/strategy-ids.ts`:

| Roster | Count | IDs |
|---|---:|---|
| `ACTIVE_STRATEGY_IDS` | 3 | `vwap_overnight_reversal_long`, `vwap_overnight_reversal_short`, `regime_shock_reversion_short_v2` |
| `CANDIDATE_STRATEGY_IDS` | 0 | none |
| `REGISTERED_INACTIVE_STRATEGY_IDS` | 11 | `trend_pullback_long`, `trend_pullback_short`, `breakout_retest_long`, `breakdown_retest_short`, `regime_mean_reversion_long`, `regime_mean_reversion_short`, `liquidity_sweep_reversal_long`, `liquidity_sweep_reversal_short`, `regime_shock_reversion_short_v3`, `regime_shock_reversion_short_v5_strict_deadline`, `regime_shock_reversion_short_v5_trail_at_deadline` |
| `ALL_STRATEGY_IDS` | 14 | concatenation of active, candidate, and registered inactive IDs |

Registry behavior in `apps/strategy_runtime/src/strategies/registry.ts`:

| Surface | Current meaning |
|---|---|
| `STRATEGY_REGISTRY` | Has one entry for every `StrategyId`; all entries currently use `implementation_status: 'active'` even when registered inactive. |
| `ACTIVE_STRATEGY_GENERATORS` | Contains only the three active IDs. |
| `STRATEGY_GENERATORS` | Contains all generator-backed IDs, including registered inactive generator-backed strategies. |
| `listStrategyRegistryEntries()` | Returns only `ACTIVE_STRATEGY_IDS`. |
| `listAllStrategyRegistryEntries()` | Returns all IDs. |
| `listExecutableStrategyIds()` | Returns `ACTIVE_STRATEGY_IDS.filter(id => id in ACTIVE_STRATEGY_GENERATORS)`. Current executable means active roster intersected with active-generator map. |
| `getStrategyGenerator()` | Returns any generator-backed strategy, active or registered inactive. This is the correct forensic/research replay path for inactive strategies. |
| `getActiveStrategyGenerator()` | Currently also consults `STRATEGY_GENERATORS`, not just `ACTIVE_STRATEGY_GENERATORS`; the name is broader than its implementation. |

No generator-backed orphaned IDs were found. Every current `StrategyId` has a registry entry, and every registry entry whose `implementation_status` is `active` has a generator.

Important taxonomy:

| Term | Current code meaning |
|---|---|
| Active | Member of `ACTIVE_STRATEGY_IDS`; participates in runtime executable roster, default replay surfaces, active management YAML parsing, and selection defaults. |
| Candidate | `CANDIDATE_STRATEGY_IDS`; currently empty and not a meaningful execution state. |
| Registered inactive | Known `StrategyId` not in active roster; can still be generator-backed and used for explicit research replay. |
| Executable | Currently active plus active-generator-backed for runtime list purposes. |
| Paper-authorized | Not represented as a code roster. It is a governance verdict/coord/operator state. |
| Rejected | Not represented as a code roster. It is currently encoded only in evidence memos/artifacts. |

## 3. Verdict authority inventory

REDERIVATION-02 Track B evidence:

| Strategy | Current roster | Corrected-engine verdict | Notes |
|---|---|---|---|
| `vwap_overnight_reversal_long` | active | `REJECT` | selection-v4 total trades 67, `phase_6_dispatch_authorized=false` at run level |
| `vwap_overnight_reversal_short` | active | `REJECT` | selection-v4 total trades 37, `phase_6_dispatch_authorized=false` at run level |
| `regime_shock_reversion_short_v2` | active | `REJECT` | selection-v3 `ADVANCE_TO_PAPER` changed to selection-v4 `REJECT` under corrected management runtime |

Cycle4 v5 evidence:

| Strategy | Current roster | Verdict | Notes |
|---|---|---|---|
| `regime_shock_reversion_short_v5_strict_deadline` | registered inactive | informational `REJECT` | `effective_trial_count=2`, failed 7 of 9 Stage 1 thresholds |
| `regime_shock_reversion_short_v5_trail_at_deadline` | registered inactive | informational `REJECT` | Identical 2MNQ outputs; zero deadline-extension exposure |

Authority summary:

| Authority | Current state |
|---|---|
| Paper-observation authority | none found |
| Broker-dispatch authority | none found |
| Promotion authority | none found |
| Forensic/research replay authority | registered inactive generator-backed IDs remain usable by explicit `--strategy-ids` or `getStrategyGenerator()` paths |

No strategy currently has valid paper-observation, broker-dispatch, or promotion authority in the reviewed verdict memos. Operator countersign remains a governance decision for any roster mutation.

## 4. Contract surface inventory

The following surfaces are load-bearing for a zero-active implementation.

| Surface | Current behavior | Zero-active implication |
|---|---|---|
| `apps/strategy_runtime/src/contracts/strategy-ids.ts` | Declares active, candidate, registered inactive, and all IDs. | The three currently active IDs would move to `REGISTERED_INACTIVE_STRATEGY_IDS`; `ACTIVE_STRATEGY_IDS` would become empty. |
| `apps/strategy_runtime/src/strategies/registry.ts` | Active IDs have `enabled_in_v1: true` and active generators. | The three demoted IDs need `enabled_in_v1: false`; `ACTIVE_STRATEGY_GENERATORS` should become empty; `STRATEGY_GENERATORS` must retain the three generators for explicit forensic replay. |
| `apps/strategy_runtime/src/management/management-config.ts` | YAML profiles are parsed only over `ACTIVE_STRATEGY_IDS`; unknown keys under `profiles` are rejected. | If active becomes empty, current active entries in `config/management/profiles.yaml` become invalid unless the YAML is reduced to an empty active-profile map or parser semantics change. |
| `apps/strategy_runtime/src/management/management-profiles.ts` | `V1_MANAGEMENT_PROFILES` contains profiles for all `StrategyId`s, including inactive research variants. | Likely no profile constant removal is needed; explicit replay can continue to resolve profiles through this TS map. |
| `apps/strategy_runtime/src/orchestration/runner.ts` | Runtime evaluates `listExecutableStrategyIds()` on each snapshot. | With zero executable IDs, runtime should emit zero strategy evaluations and no candidates. This likely works mechanically but needs a focused unit test. |
| `scripts/qfa-410b-execute.mts` | Omitted `--strategy-ids` defaults to `ACTIVE_STRATEGY_IDS`. | If active is empty, the script currently returns an empty run summary without artifacts. Implementation should fail closed on omitted strategy IDs when active is empty, while preserving explicit `--strategy-ids` research replay. |
| `scripts/strategy-selection/qfa-611-strategy-selection.py` | Omitted `--strategy-ids` parses `ACTIVE_STRATEGY_IDS` and raises if empty. | Already fail-closed for default active selection. Explicit `--strategy-ids` remains usable. |
| `scripts/strategy-selection/qfa-611-emit-lock-manifest.py` | Omitted `--strategy-ids` parses `ACTIVE_STRATEGY_IDS` and raises if empty. | Already fail-closed for default active lock-manifest emission. Explicit `--strategy-ids` remains usable. |
| `apps/backtester/src/strategy-replay/strategy-replay.ts` | Default replay IDs are `ACTIVE_STRATEGY_IDS`. | Default replay becomes empty; implementation should decide whether that is acceptable or should fail closed. |
| `apps/backtester/src/oos-replay/oos-replay-framework.ts` | Default OOS strategy order is `ACTIVE_STRATEGY_IDS`; validation rejects empty explicit orders. | Default order becomes empty; explicit empty orders remain invalid. Tests need zero-active coverage. |
| `apps/backtester/src/held-out-validation/held-out-validation-runner.ts` | Some defaults still use `ACTIVE_STRATEGY_IDS` for fingerprint/capability ordering. Real-archive execution accepts explicit strategy order. | Explicit research replay remains possible; default/no-active behavior needs tests so empty active does not silently produce misleading complete evidence. |
| `apps/backtester/src/strategy-fingerprint/strategy-fingerprint.ts` | Default strategy order is present active IDs; omitted-strategy validation references `ACTIVE_STRATEGY_IDS`. | Empty active yields empty default fingerprint sets; explicit strategy orders still work. |
| `apps/backtester/src/validation-gate/validation-gate.ts` | Default order for gate results is `ACTIVE_STRATEGY_IDS`. | With nonempty inputs and empty default order, caller should provide explicit order or receive ordering issues. |
| `apps/backtester/src/run-spec-builder.ts` | Maps all `StrategyId`s to strategy YAMLs. | No direct change required for demotion because demoted IDs remain valid `StrategyId`s with config paths. |

Likely affected tests:

| Test surface | Expected implementation update |
|---|---|
| `apps/strategy_runtime/tests/unit/contracts.test.ts` | Update exact active/inactive roster assertions. |
| `apps/strategy_runtime/tests/unit/strategy-foundation.test.ts` | Update active registry/list-executable assertions to empty active; assert demoted IDs are registered inactive but generator-backed via `getStrategyGenerator()`. |
| `apps/strategy_runtime/tests/unit/management-profiles.test.ts` | Avoid vacuous active-only coverage; add explicit assertions that demoted IDs still resolve profiles through `V1_MANAGEMENT_PROFILES`. |
| `apps/strategy_runtime/tests/unit/runner.test.ts` | Add or update zero-executable runtime test: no strategy evaluations/candidates, no crash. |
| `apps/strategy_runtime/tests/unit/risk-management-config.test.ts` | Update active management YAML expectations if `profiles.yaml` becomes empty under active keys. |
| `apps/strategy_runtime/tests/unit/simple-yaml.test.ts` | Update snapshot/fixture expectations for management YAML if profile keys are removed. |
| `apps/backtester/tests/unit/held-out-validation/qfa-410b-execute-cli.test.ts` | Add fail-closed default-empty-active behavior or update default summary expectations, depending implementation decision. |
| `apps/backtester/tests/unit/capability-assessment/capability-assessment.test.ts` | Remove assumptions that `ACTIVE_STRATEGY_IDS[0..2]` exist; add explicit-order tests. |
| `apps/backtester/tests/unit/strategy-fingerprint/*.test.ts` | Update default active-order expectations; assert explicit inactive/demoted strategy order still works. |
| `apps/backtester/tests/unit/strategy-replay/strategy-replay.test.ts` | Update default replay behavior for zero active; keep explicit strategy replay tests. |
| `apps/backtester/tests/unit/oos-replay/oos-replay-framework.test.ts` | Update default order and explicit-order assumptions. |
| `scripts/strategy-selection/_lib/tests/test_qfa611_driver.py` | Add/adjust default-empty-active behavior tests for selection driver and explicit roster path. |

Additional active-roster test surfaces to inspect/update in `STRATEGY-IDS-RECONCILE-02`:

| Test surface | Why it is in scope |
|---|---|
| `apps/backtester/tests/unit/validation-report/validation-report.test.ts` | Uses indexed `ACTIVE_STRATEGY_IDS` fixtures for report ordering/content. |
| `apps/backtester/tests/unit/validation-report/markdown.test.ts` | Uses indexed `ACTIVE_STRATEGY_IDS` fixtures for markdown ordering/content. |
| `apps/backtester/tests/unit/validation-gate/validation-gate.test.ts` | Uses indexed `ACTIVE_STRATEGY_IDS` fixtures for validation gate inputs and ordering. |
| `apps/backtester/tests/unit/validation-gate/trial-accounting.test.ts` | Uses indexed `ACTIVE_STRATEGY_IDS` fixtures for trial-accounting validation. |
| `apps/backtester/tests/integration/real-archive-monotonic.test.ts` | Uses `ACTIVE_STRATEGY_IDS[0]` for real-archive integration fixture strategy selection. |
| `apps/backtester/tests/unit/held-out-validation/held-out-validation-real-archive.test.ts` | Uses indexed `ACTIVE_STRATEGY_IDS` fixtures for real-archive held-out validation. |
| `apps/backtester/tests/unit/held-out-validation/held-out-artifact-v1-roundtrip.test.ts` | Uses indexed `ACTIVE_STRATEGY_IDS` fixtures for artifact path and projection assertions. |

## 5. Zero-active-roster feasibility

Conclusion: zero-active roster is feasible, but it should be implemented as an explicit code/test ticket, not as a blind roster edit.

Mechanically feasible:

| Area | Feasibility |
|---|---|
| TypeScript roster type | `ACTIVE_STRATEGY_IDS = [] as const` is mechanically representable, but `ActiveStrategyId` becomes `never`. |
| Runtime runner | `listExecutableStrategyIds()` would return `[]`; the runtime loop should produce no strategy evaluations/candidates. Needs a dedicated unit test to make the no-active posture intentional. |
| Explicit research replay | Registered inactive generator-backed IDs can still run through `getStrategyGenerator()` and explicit `--strategy-ids`. |
| Strategy config paths | Existing `STRATEGY_CONFIG_PATHS` covers all current IDs, so demoted IDs keep config lineage. |

Required hardening:

| Area | Required hardening |
|---|---|
| `qfa-410b-execute.mts` default | Must not silently emit an empty successful summary when `--strategy-ids` is omitted and active is empty. Recommended behavior: throw a clear error requiring explicit `--strategy-ids`. |
| Management YAML | Current `config/management/profiles.yaml` active entries become invalid under the active-only parser. Implementation must either empty that active YAML surface or explicitly change parser semantics. Prefer empty active YAML plus TS fallback profiles for inactive replay, matching current v3/v5 precedent. |
| Tests using active indexes | Multiple tests use `ACTIVE_STRATEGY_IDS[0]`, `[1]`, or `[2]`; these must switch to explicit strategy IDs or explicit fixtures. |
| Selection defaults | Python selection and lock-manifest scripts already fail on empty active default; tests should preserve that fail-closed behavior and explicit roster override. |
| Evidence language | Documentation should state that no active deployable strategies exist until a future cycle explicitly promotes one. |

Zero-active does not require an ADR if it is treated as implementation of existing verdict authority: rejected strategies are moved out of active execution, and registered inactive remains the forensic replay state. A new ADR becomes likely only if the project wants a new governance state such as `REJECTED_STRATEGY_IDS`.

## 6. Implementation options

### Option A: demote all three current active IDs to registered inactive

Move `vwap_overnight_reversal_long`, `vwap_overnight_reversal_short`, and `regime_shock_reversion_short_v2` out of `ACTIVE_STRATEGY_IDS` and into `REGISTERED_INACTIVE_STRATEGY_IDS`. Keep them generator-backed through `STRATEGY_GENERATORS` for explicit forensic replay. Result: zero active strategies.

Likely implementation files:

| File | Change |
|---|---|
| `apps/strategy_runtime/src/contracts/strategy-ids.ts` | Empty `ACTIVE_STRATEGY_IDS`; append/demote the three IDs into `REGISTERED_INACTIVE_STRATEGY_IDS`; keep `CANDIDATE_STRATEGY_IDS` empty. |
| `apps/strategy_runtime/src/strategies/registry.ts` | Set the three demoted entries `enabled_in_v1: false`; empty `ACTIVE_STRATEGY_GENERATORS`; explicitly keep the three generators in `STRATEGY_GENERATORS`. |
| `config/management/profiles.yaml` | Remove active profile entries or make `profiles` an empty active map; keep fallback profile. |
| `scripts/qfa-410b-execute.mts` | Add fail-closed behavior for omitted `--strategy-ids` when active roster is empty. Explicit `--strategy-ids` must continue to work for registered inactive research replay. |
| Tests listed in section 4 | Update active/inactive assertions, zero-active runtime behavior, default fail-closed behavior, and explicit replay paths. |

Pros:

| Pro | Rationale |
|---|---|
| Governance-aligned | Active execution no longer advertises rejected strategies. |
| Minimal new semantics | Uses existing active vs registered-inactive taxonomy. |
| Preserves research replay | Demoted IDs remain valid `StrategyId`s with generators, config paths, management profiles, run-id abbreviations, and artifacts. |
| Clear safety posture | Default active execution becomes empty/fail-closed until a future strategy earns activation. |

Cons:

| Con | Rationale |
|---|---|
| Broad test update | Many tests intentionally used active IDs as convenient fixtures. |
| Default replay behavior changes | Some default no-arg workflows must fail closed or return empty; this needs explicit tests. |
| Config lineage shifts | Management YAML and roster constants change, so config/evidence lineage surfaces shift even with no trade behavior. |

### Option B: keep active list but add explicit governance block elsewhere

Leave `ACTIVE_STRATEGY_IDS` unchanged and introduce a separate guard that prevents paper/broker dispatch or production activation for rejected strategies.

Likely implementation files:

| File | Change |
|---|---|
| New or existing governance/config surface | Encode a blocked-for-paper/promotion status outside strategy IDs. |
| Runtime/paper/broker dispatch surfaces | Consult the block before dispatch. |
| Tests | Add blocked-dispatch assertions while keeping active defaults unchanged. |

Pros:

| Pro | Rationale |
|---|---|
| Lower test churn | Existing active-roster assumptions remain mostly intact. |
| Keeps historical defaults runnable | No-arg replay and selection still target the old active set. |

Cons:

| Con | Rationale |
|---|---|
| Semantically confusing | Rejected strategies remain "active" despite no authority. |
| Higher safety risk | Future code may treat active as executable/eligible and bypass the new block. |
| Duplicated authority | Governance state moves away from the primary roster contract. |

### Option C: introduce rejected/quarantined strategy status

Add a new explicit status such as `REJECTED_STRATEGY_IDS` or a richer registry lifecycle enum.

Likely implementation files:

| File | Change |
|---|---|
| `apps/strategy_runtime/src/contracts/strategy-ids.ts` | Add new roster/status surface. |
| `apps/strategy_runtime/src/strategies/types.ts` | Extend registry lifecycle/status type. |
| `apps/strategy_runtime/src/strategies/registry.ts` | Encode rejected/quarantined entries and validation rules. |
| Multiple runtime/backtester/selection tests | Define whether rejected IDs can be explicitly replayed, fingerprinted, configured, or selected. |
| ADR / governance docs | Likely required because this introduces new governance semantics. |

Pros:

| Pro | Rationale |
|---|---|
| Most explicit semantics | Rejected is first-class rather than overloaded onto registered inactive. |
| Future-proof | Could separate archived baselines, rejected post-verdict strategies, and inactive hypotheses. |

Cons:

| Con | Rationale |
|---|---|
| Likely ADR-required | Adds governance semantics beyond a roster cleanup. |
| Larger implementation | Every consumer must learn the new status. |
| Not necessary for immediate hygiene | Registered inactive already supports explicit research replay without active authority. |

## 7. Hash and artifact impact expectations

Three-class taxonomy:

| Class | Option A expectation | Option B expectation | Option C expectation |
|---|---|---|---|
| Class 1, runtime/journal | Default live/runtime candidate evaluation changes from three active strategies to zero. Any runtime journal produced under default active execution changes intentionally. Explicit replay of demoted IDs should preserve strategy behavior. | Runtime/journal behavior remains unchanged unless the new governance block is consulted in runtime/paper paths. | Depends on semantics; rejected status may alter runtime filtering and journal surfaces. |
| Class 2, config-input lineage | `strategy-ids.ts`, registry, and likely `config/management/profiles.yaml` change. Management config hashes and config lineage can shift. Strategy YAML hashes should remain pinned if YAMLs are untouched. | New governance config or code lineage shifts, but active roster lineage remains unchanged. | New roster/status config and registry schema lineage shifts. |
| Class 3, evidence-surface | Default emitted artifact sets change if tools default to active roster; no-arg selection/lock-manifest should fail closed when active is empty. Explicit `--strategy-ids` artifacts remain possible. | Evidence surfaces remain default-active unless governance block is applied to artifact emission. | Evidence surfaces depend on whether rejected IDs are excluded by default but allowed explicitly. |

Specific hash surfaces:

| Surface | Expected Option A impact |
|---|---|
| Strategy fingerprints for demoted IDs | Behavior-level fingerprints for explicit demoted-ID replay should remain pinned if generators/YAML/management runtime are untouched. |
| Strategy fingerprint set for default active roster | Changes to an empty set by design. |
| `strategy_config_hash` | Strategy YAML hashes should remain pinned. Shared/management config lineage may shift if management YAML active profiles are emptied. |
| `final_phase2_hash` / `final_phase4_hash` | Should remain pinned; roster cleanup should not alter regime substrate or phase inputs. |
| `final_chain_hash` | May shift if determinism check includes active-roster-derived config/evidence surfaces. Needs same-worktree baseline and narrow-diff proof. |
| Existing committed artifacts | Must not be hand-edited. Any future artifact changes must be regenerated by explicit evidence tickets. |

Verification gates for Option A should include:

| Gate | Purpose |
|---|---|
| Focused strategy ID / registry tests | Prove zero active, demoted registered inactive, generator-backed explicit replay. |
| Focused management config tests | Prove active YAML parsing works with zero active profiles. |
| Focused qfa-410b CLI tests | Prove omitted default fails closed with empty active, explicit demoted IDs still run. |
| Focused qfa-611 Python tests | Preserve empty-active fail-closed default and explicit roster override. |
| Full monorepo `npx vitest run` | Catch active-index test assumptions. |
| `npx tsc -b tsconfig.json` | Catch `ActiveStrategyId=never` fallout. |
| Python selection tests | Catch selection/lock-manifest default behavior. |
| Determinism A/B | Confirm same-PR byte-equality. |
| Same-worktree baseline hash comparison | Classify any final-chain drift using runtime/journal, config-input lineage, or evidence-surface classes. |

## 8. Recommendation

Recommended next implementation ticket: `STRATEGY-IDS-RECONCILE-02`.

Preferred option: Option A, demote all three current active strategies to registered inactive, yielding zero active strategies.

Rationale:

| Reason | Explanation |
|---|---|
| Aligns code with verdict reality | The active roster should not advertise rejected strategies as active. |
| Uses existing taxonomy | Registered inactive already means known strategy, not active, still available for explicit research replay. |
| Avoids new governance semantics | Option C is cleaner in theory but likely ADR-requiring and not necessary for immediate safety. |
| Fail-closed posture | Empty active defaults make accidental paper/broker/selection dispatch harder, provided qfa-410b default is hardened. |

Expected implementation scope:

| Category | Files |
|---|---|
| Roster and registry | `apps/strategy_runtime/src/contracts/strategy-ids.ts`, `apps/strategy_runtime/src/strategies/registry.ts` |
| Active management YAML | `config/management/profiles.yaml` |
| Default active replay hardening | `scripts/qfa-410b-execute.mts` |
| Tests | `apps/strategy_runtime/tests/unit/contracts.test.ts`, `apps/strategy_runtime/tests/unit/strategy-foundation.test.ts`, `apps/strategy_runtime/tests/unit/management-profiles.test.ts`, `apps/strategy_runtime/tests/unit/risk-management-config.test.ts`, `apps/strategy_runtime/tests/unit/runner.test.ts`, `apps/strategy_runtime/tests/unit/simple-yaml.test.ts`, `apps/backtester/tests/unit/held-out-validation/qfa-410b-execute-cli.test.ts`, `apps/backtester/tests/unit/held-out-validation/held-out-validation-real-archive.test.ts`, `apps/backtester/tests/unit/held-out-validation/held-out-artifact-v1-roundtrip.test.ts`, `apps/backtester/tests/unit/capability-assessment/capability-assessment.test.ts`, `apps/backtester/tests/unit/strategy-fingerprint/*.test.ts`, `apps/backtester/tests/unit/strategy-replay/strategy-replay.test.ts`, `apps/backtester/tests/unit/oos-replay/oos-replay-framework.test.ts`, `apps/backtester/tests/unit/validation-report/validation-report.test.ts`, `apps/backtester/tests/unit/validation-report/markdown.test.ts`, `apps/backtester/tests/unit/validation-gate/validation-gate.test.ts`, `apps/backtester/tests/unit/validation-gate/trial-accounting.test.ts`, `apps/backtester/tests/integration/real-archive-monotonic.test.ts`, `scripts/strategy-selection/_lib/tests/test_qfa611_driver.py` |

Implementation acceptance criteria:

| Criterion | Requirement |
|---|---|
| Active roster | `ACTIVE_STRATEGY_IDS` is empty. |
| Registered inactive roster | The three former active strategies are present in `REGISTERED_INACTIVE_STRATEGY_IDS`. |
| Candidate roster | Remains empty. |
| Runtime executable list | `listExecutableStrategyIds()` returns `[]`. |
| Generator-backed replay | `getStrategyGenerator()` succeeds for the three demoted IDs. |
| Active generator map | `ACTIVE_STRATEGY_GENERATORS` has no entries. |
| Registry entries | Demoted IDs have `enabled_in_v1: false`; registry validation passes. |
| qfa-410b default | Omitted `--strategy-ids` with empty active roster fails closed with a clear error. |
| qfa-410b explicit | Explicit demoted strategy IDs remain usable for research replay. |
| qfa-611 defaults | Existing empty-active fail-closed behavior remains intact. |
| Management config | Active YAML parsing is valid with zero active profiles. |
| Artifacts | No generated artifacts committed in the implementation PR. |

Operator countersign:

Option A changes the production active roster contract. It should require explicit operator countersign before implementation, even though the discovery evidence strongly supports it.

## 9. Open coordinator/operator decisions

| Decision | Owner | Status |
|---|---|---|
| Select Option A, B, or C | Operator with dual-coord recommendation | Pending |
| Authorize zero-active production roster | Operator | Pending |
| Decide whether `qfa-410b` omitted strategy IDs should fail closed or return empty summary when active is empty | Operator/coords | Recommended fail closed |
| Decide whether new rejected/quarantined status is worth ADR work | Operator/coords | Recommended no for immediate cleanup |
| Dispatch `STRATEGY-IDS-RECONCILE-02` | Coord-1 after operator selection | Pending |

Coord review: PENDING
Operator decision: PENDING - this memo recommends but does not authorize implementation
