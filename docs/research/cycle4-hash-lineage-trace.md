# CYCLE4 hash-lineage trace

## Status

`RESEARCH_TIER_TRACE`. This memo documents a hash-lineage investigation
of the QFA-611 selection pipeline's audit-chain hashes
(`strategy_fingerprint_sha256`, `final_phase2_hash`, `final_phase4_hash`)
as they relate to whether schema-only additions to
`StrategyFeatureSnapshotContext` can be made mid-paper-observation
without disrupting v2's audit chain.

The investigation was triggered by the planned Cycle3 closure-memo
amendment that scopes the existing "Cycle4 dispatch: DEFERRED" clause.
This memo is the evidence pack the amendment cites.

## Authority

- Substrate: `origin/main` at commit `4ec0377` (the latest at trace
  time; verifiable via `git log --oneline origin/main -1`).
- Investigation method: direct read of the hash-computation source
  files with file:line citations; no inference from secondary sources.
- Cross-references: Cycle3 closure memo, ADR-0024, ADR-0023, CF-30 /
  CF-41 / CF-44, the proposed CYCLE4-S1 schema PR
  (`vix_prior_close_percentile` field addition).

## Three hash surfaces examined

### 1. `strategy_fingerprint_sha256` — per-strategy selective

File: `apps/backtester/src/strategy-fingerprint/strategy-fingerprint.ts`
Lines 22-52, function `computeStrategyFingerprint`.

```typescript
export function computeStrategyFingerprint(
  strategyId: StrategyId,
  decisions: readonly StrategyFingerprintDecision[],
): StrategyFingerprint {
  // ...
  const decisionPayload = {
    algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
    strategy_id: strategyId,
    decisions,
  };
  const decisionsSha256 = hashCanonicalPayload(decisionPayload);
  const fingerprintPayload = {
    fingerprint_schema_version: 1,
    algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
    strategy_id: strategyId,
    decision_count: decisions.length,
    decisions_sha256: decisionsSha256,
  };
  // ...
}
```

The `decisions` array is the strategy's emitted decisions — what the
strategy produced when run against the replay. The fingerprint depends
ONLY on the strategy's outputs, not on the shape of the input snapshot
context.

**Implication.** Adding a new field to `StrategyFeatureSnapshotContext`
that a given strategy does NOT consume → that strategy's emitted
decisions are unchanged → its `strategy_fingerprint_sha256` is
unchanged.

### 2. `final_phase2_hash` — composes over active-set strategies' outputs

File: `scripts/backtester/check-determinism.mts`
Lines 61-66 (active-set declaration for the determinism check),
108-116 (artifact composition), 341 (hash field in run summary).

```typescript
const PHASE2_DETERMINISM_STRATEGY_IDS = [
  'trend_pullback_long',
  'trend_pullback_short',
  'breakout_retest_long',
  'breakdown_retest_short',
] as const satisfies readonly StrategyId[];
```

```typescript
interface Phase2DeterminismArtifactHashes {
  readonly strategy_replay_result: string;
  readonly strategy_fingerprint_set: string;
  readonly capability_assessment_set: string;
  readonly validation_gate_result_set: string;
}
```

Phase 2 hash composes four artifact hashes computed over the
determinism-check active set. The fingerprint set itself is
per-strategy (see #1).

**Implication.** A REGISTERED_INACTIVE strategy (e.g., a hypothetical
v3 added to the registry but not to `PHASE2_DETERMINISM_STRATEGY_IDS`
nor to the broader `ACTIVE_STRATEGY_IDS` set declared in
`apps/strategy_runtime/src/contracts/strategy-ids.ts`) does NOT enter
this hash composition. `final_phase2_hash` is unchanged.

Note on set identity: `PHASE2_DETERMINISM_STRATEGY_IDS` is the
determinism-check fixture set, distinct from but parallel to
`ACTIVE_STRATEGY_IDS` used by the selection pipeline at large. For the
closure-memo amendment scope the relevant set is `ACTIVE_STRATEGY_IDS`
(which currently includes v2 plus Cycle1/Cycle2 REGISTERED_INACTIVE
strategies). Adding v3 to the registry without adding it to
`ACTIVE_STRATEGY_IDS` preserves the hash composition by the same
mechanism shown above.

### 3. `final_phase4_hash` — entirely upstream of strategy execution

File: `scripts/backtester/check-determinism.mts`
Lines 386-397, function `computePhase4DeterminismSummary`.

```typescript
const finalHashInput = [
  PHASE4_REGIME_SUBSTRATE_DETERMINISM_ALGORITHM,
  ...PHASE4_HASH_ORDER.map((name) => `${name}=${artifactHashes[name]}`),
  `quality_exclusions=${JSON.stringify(qualityExclusions)}`,
  `secondary_percentile_basis=${secondaryPercentileBasis}`,
].join('\n') + '\n';
```

Where `PHASE4_HASH_ORDER` (lines 68-74) is:

```typescript
const PHASE4_HASH_ORDER = [
  'regime_labels_json',
  'vix_vxn_snapshot',
  'manifest_feb_2026',
  'manifest_mar_2026',
  'manifest_apr_2026',
] as const;
```

Phase 4 hash is over the regime substrate inputs (regime labels + VIX
snapshot + monthly bar manifests) plus quality exclusions and the
secondary percentile basis. No strategy code is hashed.

**Implication.** Neither schema additions to
`StrategyFeatureSnapshotContext` nor REGISTERED_INACTIVE strategy
implementations touch any input to this hash. `final_phase4_hash` is
unchanged by either action.

The pinned hashes are additionally gated by `assertPinnedHashes()`
(lines 401-408), which throws if any substrate artifact changes —
protecting against accidental Phase 4 drift.

## Enforcement mechanism: byte-equal regression gate

The selectivity demonstrated above is the *expected* behavior. The
*enforcement* discipline that ensures schema-only PRs preserve
selectivity is the byte-identical regression gate per QFA-7xx-A
discipline (PR #182). Specifically:

1. Schema PR adds the new field.
2. Run the standard replay against all then-active strategies with the
   new field present (`null` for strategies that don't consume it).
3. Assert byte-equal output against the pre-schema-addition baseline.
4. If ANY strategy's output changes: STOP. The schema addition is not
   actually schema-only for that strategy — there's an indirect
   dependency that must be resolved before the PR can land.

This gate is the canonical audit answer to "what changed about v2
mid-paper?": v2's outputs were byte-equal pre/post; v2's fingerprint
is the same; the phase2/phase4 hash composition is the same.
Three-line answer.

## Implication scope for the Cycle3 closure-memo amendment

The selectivity findings + byte-equal regression discipline together
support:

- **Schema PRs adding fields to `StrategyFeatureSnapshotContext` are
  structurally safe to land mid-paper-observation** PROVIDED they pass
  the byte-equal regression gate on v2 (and all other then-active
  strategies).
- **REGISTERED_INACTIVE new strategy_id implementations are
  structurally safe to land mid-paper-observation** because they do
  not enter `ACTIVE_STRATEGY_IDS` or `PHASE2_DETERMINISM_STRATEGY_IDS`,
  so no hash composition includes them.

The selectivity findings do NOT license:

- Adding a new strategy_id to `ACTIVE_STRATEGY_IDS` (would change
  phase2 hash composition).
- Modifying any field that v2 currently consumes (would change v2's
  decisions, fingerprint, phase2 hash).
- Modifying any input to phase4 substrate (regime labels, VIX
  snapshot, monthly manifests — all gated by `assertPinnedHashes`).
- Live execution of REGISTERED_INACTIVE strategies (separate decision
  surface entirely; CF-52 paper-observation window applies).

## Reproducibility

To verify this trace against `origin/main` at commit `4ec0377`:

```bash
git fetch origin
git show 4ec0377:apps/backtester/src/strategy-fingerprint/strategy-fingerprint.ts | sed -n '22,52p'
git show 4ec0377:scripts/backtester/check-determinism.mts | sed -n '61,66p'
git show 4ec0377:scripts/backtester/check-determinism.mts | sed -n '108,116p'
git show 4ec0377:scripts/backtester/check-determinism.mts | sed -n '341,341p'
git show 4ec0377:scripts/backtester/check-determinism.mts | sed -n '386,397p'
git show 4ec0377:scripts/backtester/check-determinism.mts | sed -n '68,74p'
git show 4ec0377:scripts/backtester/check-determinism.mts | sed -n '401,408p'
```

Each citation in this memo resolves to the exact lines via the commands
above. Any future reader can verify the assertions independently
without reading the trace conversation.

## Cross-references

- `apps/backtester/src/strategy-fingerprint/strategy-fingerprint.ts`
  (per-strategy fingerprint algorithm)
- `scripts/backtester/check-determinism.mts` (phase2 + phase4 hash
  composition; pinned substrate enforcement)
- `apps/strategy_runtime/src/contracts/strategy-ids.ts`
  (`ACTIVE_STRATEGY_IDS` declaration; the set that the broader
  selection pipeline composes over is parallel to but distinct from
  `PHASE2_DETERMINISM_STRATEGY_IDS`)
- PR #182 (QFA-7xx-A schema discipline; canonical byte-equal
  regression gate pattern)
- `docs/research/qfa-611-cycle3-closure-memo.md` (the amendment target
  for which this trace is the evidence pack)
- ADR-0023 (anti-pattern lock; fail-closed discipline for
  REGISTERED_INACTIVE strategies)
- ADR-0024 (post-verdict bug-rederivation protocol; the analog for
  joint-sign-off authority on closure-memo amendments)
