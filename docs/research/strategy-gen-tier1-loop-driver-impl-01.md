# STRATEGY-GEN-TIER1-LOOP-DRIVER-IMPL-01

## Determination

`STRATEGY_GEN_TIER1_LOOP_DRIVER_IMPLEMENTED`

## Purpose

This ticket adds a repeatable Tier-1 strategy-generation loop command surface.
It connects the already-scoped candidate emitter, generated strategy registry,
held-out archive execution, and QFA-611 trial-accounted selection path.

The driver is intentionally an orchestration layer. It does not invent new
strategy families, promote candidates, mutate active rosters, or authorize
paper/live/broker execution.

## Command surface

```powershell
npm run strategy-gen:run-tier1 -- --spec config/strategy-gen/regime_shock_reversion_short_v2.search.yaml
```

Optional flags:

```text
--archive-root <path>
--manifests <feb> <mar> <apr>
--regime-labels <path>
--strategy-config-dir <path>
--initial-equity-cents <integer>
--emit-only
--skip-held-out
--skip-selection
```

## Loop stages

1. Emit bounded Tier-1 generated candidates from the committed search spec.
2. Write generated candidate config YAML under `config/strategies/_candidates/`.
3. Write generated candidate contract under `apps/strategy_runtime/src/contracts/generated-candidate-strategy-ids.ts`.
4. Emit candidate and trial-accounting manifests under `artifacts/strategy-generation/<generation_run_id>/`.
5. Emit QFA-611 parameter-lock manifest for generated candidate configs.
6. Emit QFA-410B held-out metadata keyed by generated candidate strategy id.
7. Run QFA-410B held-out archive execution with the generated `strategy_config` wired through to real-archive strategy generation.
8. Run QFA-611 selection using the trial-accounting manifest, parameter-lock manifest, and generated-candidate roster.

## Key implementation details

`HeldOutValidationRealArchiveOptions` now carries optional `strategy_config`.
`executeHeldOutValidationAgainstArchive(...)` forwards that config into
`runRealArchiveBacktest(...)`.

This is load-bearing. Without it, generated candidate IDs could be registered
and selected while the held-out archive path still evaluated stale base
parameters.

`scripts/strategy-gen/run-tier1-loop.ts` writes the glue artifacts that QFA-410B
and QFA-611 expect:

```text
artifacts/strategy-generation/<generation_run_id>/candidate-manifest.json
artifacts/strategy-generation/<generation_run_id>/trial-accounting-manifest.json
artifacts/strategy-generation/<generation_run_id>/parameter-locks.json
artifacts/strategy-generation/<generation_run_id>/held-out-metadata-by-strategy.json
artifacts/held-out-validation/<generation_run_id>/
artifacts/strategy-generation/<generation_run_id>/strategy-selection.json
artifacts/strategy-generation/<generation_run_id>/strategy-selection.md
```

## Guardrails

```text
no ACTIVE_STRATEGY_IDS mutation
no CANDIDATE_STRATEGY_IDS hand editing
no Phase 6 authority
no paper/live/broker authority
no roster promotion
no qfa-410b/qfa-611 bypass around trial accounting
```

Generated candidates remain candidate-only until a separate review/promotion
ticket explicitly accepts a candidate and updates the appropriate roster surface.

## Validation

Not run in this fold.

Recommended scoped validation:

```powershell
npm run strategy-gen:emit-tier1 -- --dry-run
npx tsx scripts/strategy-gen/run-tier1-loop.ts --emit-only
npx tsc -b tsconfig.json
python -m pytest scripts/strategy-selection/_lib/tests/test_qfa611_driver.py
```

Full loop validation requires the held-out archive manifests and source corpus
to be present:

```powershell
npm run strategy-gen:run-tier1 -- --spec config/strategy-gen/regime_shock_reversion_short_v2.search.yaml
```

## Recommended next ticket

`STRATEGY-GEN-TIER1-LOOP-RUN-AND-REVIEW-01`

Run the loop against the intended 12-month archive surface, inspect the emitted
candidate selection output, and decide whether any generated candidate merits a
separate promotion proposal.
