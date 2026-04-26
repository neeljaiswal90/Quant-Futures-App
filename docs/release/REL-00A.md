# REL-00A - Offline Readiness Checker

Status: implemented

## Scope

`REL-00A` is an offline-only readiness check for the in-process runtime substrate. It does not use live Rithmic, Databento overlap validation, sockets, live execution, or `ORDER_PLANT`.

Run:

```powershell
npm run rel:00a
```

The command writes:

```text
reports/rel/rel00a_offline_readiness_report.json
reports/rel/rel00a/rel00a_runtime_a.jsonl
reports/rel/rel00a/rel00a_runtime_b.jsonl
```

## Checks

The checker validates:

- APP/STRAT/RISK/MGMT config loads and hash lineage are available.
- MNQ session and roll calendars load.
- OBS-00 mini-journal manifest, LF-normalized checksum, event count, redaction statement, and schema version are valid.
- OBS-00 and emitted runtime journals pass OBS-01 schema validation plus EVT-00/EVT-01 transport invariants with no quarantine records.
- The deterministic runner emits a fixture-backed journal for candidate, risk/sizing, simulated fill, position open, management action, simulated close fill, and position close.
- TUI-04 journal-query can reconstruct at least one candidate chain and one position lifecycle chain.
- Two repeated offline runs produce byte-identical journal output.

## Exit Codes

- `0`: offline readiness passed.
- `2`: readiness checks failed.
- `3`: invalid input, config, or environment prevented the checker from running.

## Boundary

Passing `REL-00A` does not unblock `DATA-01`, `REL-00`, or `REL-01`. It only proves the offline substrate is healthy.

The next blocker remains:

```text
INFRA-01 verification / DATA-01
```

`DATA-01` unlocks only after the revised INFRA-01 verification report says:

```text
data01_eligible = true
route_to = DATA-01
```
