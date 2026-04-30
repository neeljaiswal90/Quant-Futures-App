# REL-01 Tooling Hardening

REL-01 tooling hardening tracks operational issues found during the first two-session controlled live-sim packet. These are tooling defects or metadata-contract gaps; they do not change strategy, risk, management, simulation, or live-order behavior.

## Status

Addressed by the REL-01 tooling hardening follow-up after PR #98.

## Findings

1. REL-01B nested npm command runner fails in the Codex Windows shell. Addressed.

   During the April 30, 2026 RTH session, REL-01B correctly captured/validated the raw probe audit, but its nested `npm.cmd` invocation returned an `EINVAL` spawn error from Node in this shell. Running the same normalization command manually succeeded and produced valid DATA-01A output. REL-01B should use a Windows-safe command invocation path or a direct script entrypoint so the wrapper is reliable in the same terminal environment used for operations.

   Resolution: REL-01B now routes Windows `.cmd` commands through a shell-safe command line in the default command runner, with a regression test that runs `npm.cmd --version` in the same Windows environment.

2. REL-01A app-level `config_hash` is path-sensitive. Addressed.

   REL-00C currently loads app config with `QFA_JOURNAL_DIR` set to the output journal directory. Because that path participates in the app-level `config_hash`, otherwise comparable sessions generated into different directories can fail REL-01A's packet-level config-hash check. Strategy, risk, and management hashes remain the better behavioral comparability anchors. REL-01A should continue reporting app `config_hash`, but packet comparability should gate on `strategy_config_hash`, `risk_config_hash`, and `management_config_hash` unless the app-level hash is made path-stable.

   Resolution: REL-01A now reports app-level journal config hashes without using them as the packet comparability gate. Strategy and risk config hashes are required to match the manifest. Management config hashes are checked when runtime journals emit them, and management profile hashes are reported when present.

## Acceptance

- REL-01B can run capture-skip and full daily-session flows in the Codex Windows shell without `spawnSync npm.cmd EINVAL`.
- REL-01A documents the distinction between app environment hash and behavioral config hashes.
- REL-01A packet comparability gates on stable behavioral hashes while reporting app config hashes separately.
- Regression tests cover large journals without array-spread stack overflow.
- No generated reports, journals, raw probes, or credentials are committed.

## Safety Boundary

This ticket is tooling-only. It must not enable MBO decision-use, real order execution, or changes to strategy/risk/management behavior.
