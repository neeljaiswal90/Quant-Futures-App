# INFRA-03 Import Guard

INFRA-03 prevents active V1 code from drifting back into the legacy application shell.

The guard scans active TypeScript, JavaScript, and Python files under:

- `apps`
- `services`
- `research`

It fails on imports from:

- `legacy_seed`
- `legacy_reference`
- old `src/autotrade`
- `dashboard`
- `bookmap-addon` or Bookmap modules
- old `src/core/tradingview` or TradingView modules

`legacy_seed` and `legacy_reference` remain available as read-only source material, but active runtime, sidecar, research, and tests must not import from them. The CI workflow runs `npm run lint`, `npm run build`, `npm test`, and `npm run check:python`.

Missing default scan roots are skipped with a warning so early repo slices can run before every planned directory exists. Explicit `--root` arguments remain strict and fail if the requested path is absent; the guard also fails if no scan roots remain.

The Python syntax check follows the same early-slice principle for default roots: absent default Python roots are reported and skipped instead of silently relying on `compileall` behavior. Explicit `--root` arguments are strict.
