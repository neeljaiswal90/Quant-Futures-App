# CONSOLE-04A Verification Log

This ticket verifies server/web behavior against known fixtures and documents local evidence sources when
CI-only artifacts are unavailable.

## Commands

```powershell
npm run console:test
npm run console:web -- --host 127.0.0.1 --port 5173
```

## Fixture checks

| Item | Source | Status | Evidence |
|---|---|---:|---|
| OBS-00 mini-journal | `apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl` | ✅ available | `fixtureJournal` and server REST tests |
| REL-00A fixture transport mini-journal | `reports/rel/rel00a/fixture-transport/mini-journal.jsonl` | ⚪ not present in this workspace | `it.todo` marks missing path |
| Latest `reports/rel` controlled live-sim journal | `reports/rel` selector path | ⚪ not present in this workspace | selection logic validated via `journal-discovery` tests; local evidence pending |
| REL-01-SHORT journal | `reports/rel/rel01_short_packet_current/rel00_controlled_live_sim_journal.jsonl` | ⚪ not present in this workspace | `it.todo` marks missing path |
| MBO shadow diagnostic journal | `reports/rel/.../diagnostic_current_main/rel00_controlled_live_sim_shadow_journal.jsonl` | ⚪ not present in this workspace | `it.todo` marks missing path |
| 600k+ REL-scale journal | `OPERATOR_CONSOLE_VERIFY_600K_FIXTURE=<local-path>` | ⚪ gated by local path | set env var to run optional stress check |

## What CONSOLE-04A now verifies in code

- REST API contracts: `/healthz`, `/snapshot`, bounded `/history`, CORS, range grammar, and auth behavior.
- Malformed-row tolerance: malformed JSON and schema-invalid rows surface via alert pathways and do not block snapshots.
- Feature policy violations: blocked/invalid feature usage rows propagate into `snapshot.alerts` and `feature_surface.recent_violations`.
- P&L safety: realized P&L remains `unavailable` unless explicit lifecycle facts are present.
- Memory guardrail: per-panel history store is bounded (`max_rows_per_panel`), defaulting to `1000` (same bound as `max` limit).

## Notes for future runs

- If any missing fixture becomes available locally, rerun `npm run console:test` and replace the `it.todo`
  entries in `apps/operator_console/server/tests/rest-api.test.ts` by removing the missing-workflow gaps.
- For a larger REL-scale run, export:
  - `OPERATOR_CONSOLE_VERIFY_600K_FIXTURE=<absolute-or-relative-journal-path>`

