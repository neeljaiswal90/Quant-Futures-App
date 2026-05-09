# QFA-420-h1 determinism promotion

## Status

PASS: QFA-420-h1 promotes the validated QFA-420 regime substrate into
the determinism gate per ADR-0015 LD-420-7.

QFA-420 produced Outcome A in PR #161: high-vs-low queue fidelity is
practically equivalent within the +/-50,000 ppm SESOI. ADR-0015
therefore authorizes pinning the regime substrate inputs as a
determinism contract.

## Scope discipline

- `artifacts/regime/regime-labels.json` consumed only; not modified.
- `config/research/vix-vxn-daily-2025-09-to-2026-04.json` consumed
  only; not modified.
- Feb / Mar / Apr Tier A manifests consumed only; not modified.
- ADRs 0010-0015 preserved unchanged.
- No QFA-420, QFA-212, QFA-105, QFA-402, RunSpec, journal, or source
  contract changes.

## Path decision

Chosen path: Path B, separate Phase 4 determinism fixture.

Rationale: the existing `final_phase2_hash` is explicitly scoped to
the QFA-211b Phase 2 synthetic artifact aggregate and uses the
`qfa_phase2_determinism_artifacts_sha256_v1` algorithm marker. Adding
regime substrate hashes to that chain would blur the Phase 2 audit
boundary. QFA-420-h1 therefore introduces a separate
`final_phase4_hash` under
`qfa_phase4_regime_substrate_determinism_sha256_v1`.

Result:

```text
final_phase2_hash before: dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b
final_phase2_hash after:  dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b
final_phase4_hash:        59f31389748a1eef5d5aeb379380eb6bac241267c306d0af8e9a4f9f2c41ff5c
```

## Pinned hash values

```text
regime_labels_json_sha256:
  f49c2ac2c94b77fede4dbffa2c785d04c11c5d974901621c97f43f5d2f82e5c9

vix_vxn_snapshot_sha256:
  1f4cf55f82657a1aaa9b2dd293886c8498cdaf3743207fcdd8089e7de1940036

manifest_feb_2026_sha256:
  05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c

manifest_mar_2026_sha256:
  cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f

manifest_apr_2026_sha256:
  e37d01b3a3976f2f2614c2a85171ce4cc8b6b5ad069bf782f55285b0e7721a2c
```

## Pinned contract fields

```text
quality_exclusions:
  - 2026-03-17-rth
  - 2026-03-18-rth
  - 2026-03-19-rth
  - 2026-03-20-rth
  - 2026-04-10-rth

secondary_percentile_basis:
  within_window
```

The quality-exclusion sessions are read from
`artifacts/regime/regime-labels.json` where `quality_excluded == true`.
The April exclusion is the Databento degraded-warning session. The March
exclusions are the documented H-cycle expiry-thinning / migration
sessions.

## Determinism gate behavior

The determinism checker now verifies:

1. SHA-256 of `artifacts/regime/regime-labels.json`.
2. SHA-256 of the pinned VIX/VXN snapshot.
3. SHA-256 of `manifest-feb-2026.json`.
4. SHA-256 of `manifest-mar-2026.json`.
5. SHA-256 of `manifest-apr-2026.json`.
6. Exact quality-exclusion session list.
7. `secondary_percentile_basis == "within_window"`.

Any drift fails `npm run check:determinism` with a targeted error.

## Perturbation check

Manual perturbation: appended whitespace to
`artifacts/regime/regime-labels.json`, then ran
`npm run check:determinism`.

Result:

```text
perturb_exit_code=1
QFA determinism check failed before comparison
Phase 4 substrate hash drift for regime_labels_json:
  expected f49c2ac2c94b77fede4dbffa2c785d04c11c5d974901621c97f43f5d2f82e5c9
  actual   a355980d8993da280883c4aaff30137dd3a84d2090204908d1ece5e7cdb7d748
```

The perturbation was not committed; `regime-labels.json` was restored
from HEAD immediately afterward.

## Verification

Baseline determinism run:

```text
QFA determinism check passed
run A final_chain_hash: 260e9c0fd725b941b33937c6a8cd6bc51878f614efdcb7c0c883d3244ff02321
run B final_chain_hash: 260e9c0fd725b941b33937c6a8cd6bc51878f614efdcb7c0c883d3244ff02321
run A final_phase2_hash: dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b
run B final_phase2_hash: dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b
run A final_phase4_hash: 59f31389748a1eef5d5aeb379380eb6bac241267c306d0af8e9a4f9f2c41ff5c
run B final_phase4_hash: 59f31389748a1eef5d5aeb379380eb6bac241267c306d0af8e9a4f9f2c41ff5c
```

## Recommendation

Merge QFA-420-h1 once gates are green. Phase 4 substrate will then be
validated and audit-locked, with QFA-510 methodology walkthrough as the
next coordinator decision.

## CF-27 CI portability follow-up

The initial implementation pinned Feb / Mar / Apr manifest hashes from the
operational archive path (`D:/qfa-cache/databento/tier-a-feb-mar-2026`). That
path is valid on the research workstation but unavailable on Linux CI runners,
so the determinism gate must consume repo-internal manifest copies.

QFA-420-h1 therefore tracks byte-identical pinned manifest snapshots under
`config/research/manifests/`:

- `manifest-feb-2026.json`
- `manifest-mar-2026.json`
- `manifest-apr-2026.json`

The SHA-256 values are unchanged from the operational source copies. This is a
portability fix only; it does not alter the Phase 4 determinism contract or the
computed `final_phase4_hash`.
