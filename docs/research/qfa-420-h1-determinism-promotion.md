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
final_phase4_hash:        ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090
```

## Pinned hash values

```text
regime_labels_json_sha256:
  f90e3e6df588a60756c675befe7fd77adf1a33ed3878fbb8900d519b79f0a41a

vix_vxn_snapshot_sha256:
  3f42904f0d57a00dee37489fbafc69aff9466b63d14115dfddd8e0df23cad9ef

manifest_feb_2026_sha256:
  91bcfbf523b8d9129e67478c82cfebdb29bb353fa63ea1fc54bb06415cf833e9

manifest_mar_2026_sha256:
  1f8319cf8a40b8b4256b65499e46c8e5e6676e4f738e9a41708332a0ddfb558f

manifest_apr_2026_sha256:
  5ba1ec230982ae2bc409fa5f21278dd84715cab62753f20b0988b4e0ddd8e965
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
  expected f90e3e6df588a60756c675befe7fd77adf1a33ed3878fbb8900d519b79f0a41a
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
run A final_phase4_hash: ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090
run B final_phase4_hash: ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090
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
## CF-28 LF-canonical hash basis

Path X is adopted for the manifest hash-basis discrepancy. Historical hashes
in QFA-119b / QFA-119d research notes were computed against workstation
on-disk bytes, which can include CRLF on Windows. The determinism contract now
uses LF-canonical bytes for all pinned text inputs, so it is stable across
Windows, Linux, and macOS checkouts.

This PR adds a two-layer defense:

- `.gitattributes` forces LF checkout for the pinned regime-label, VIX/VXN, and
  manifest JSON paths.
- `check-determinism.mts` strips carriage returns before SHA-256 hashing.

The pinned JSON content is unchanged; only the hash basis changes. QFA-420-h1 is
the canonical source for the LF-canonical hashes used by the determinism gate.
No retroactive ADR or QFA-119b / QFA-119d artifact amendment is required.


