# Python-owned YAML snapshots — placeholder

This directory is reserved for snapshots of YAML configs that are
authored and consumed by Python tooling today, but live under
`config/` and are syntactically parsable by `simple-yaml.ts` after
QFA-114's sequence support landed.

At the time of QFA-114, the four files that fit this description are:

- `config/sim03/session-list.yaml` (gitignored — operator artifact)
- `config/research/tier-a-trial-feb-2026.yaml` (untracked)
- `config/research/tier-a-trial-mar-2026.yaml` (untracked)
- `config/research/tier-a-trial-sessions-feb-mar-2026.yaml` (untracked)

None of these are committed to git, so a clean branch checkout does not
contain them. Snapshots of files that don't exist in the tree would be
orphans — there is nothing in CI to compare against. This directory is
therefore intentionally empty.

## When to populate

If a future ticket either (a) commits any of the above YAMLs to git, or
(b) introduces a new committed YAML that uses block sequences and is
authored by Python rather than TS, that ticket may capture an advisory
snapshot here. Drift in advisory snapshots should be treated as a
notification — not a hard test failure — until the file gains a TS
caller and is graduated to `../ts-consumed/`.

## Why not synthetic fixtures here

Synthetic sequence fixtures used to exercise the parser live under
`apps/strategy_runtime/tests/fixtures/simple-yaml/`. Those are
authored specifically for the parser test suite. This directory is
reserved for snapshots of real configs that exist but are not yet
TS-owned.
