# Rithmic Analytics

Tick-accurate analytics layer for MNQ futures (CME E-mini Micro Nasdaq-100),
sourced from a Rithmic OBS-01 capture pipeline. Computes volume profile
(POC/VAH/VAL/HVN/LVN), true CVD, footprint deltas, absorption + sweep tagging,
hidden-liquidity inference, and multi-session HVN clustering. Emits a
canonical zone JSON envelope consumed by chart-drawing tooling and HTML
reports. Operates **offline against captured JSONL** — no live streaming
dependency in this layer.

## Read in this order

If you've never seen this project before, read these three documents
end-to-end. ~45 minutes total. After that you can act.

1. **[Architecture](./architecture.md)** — module map, data flow, decision
   log (why this codebase looks the way it does).
2. **[Feature reference](./feature_reference.md)** — public API surface,
   module by module. The companion to the docstrings.
3. **[Operations](./operations.md)** — daily routine + failure-mode
   playbook. *Rithmic disconnects mid-session, scheduled task didn't fire,
   disk pressure, etc.*

Then dip into the specialty references as needed:

- **[Absorption methodology](./absorption_methodology.md)** — full
  derivation of score factors, hard gates, calibration, tier-1-to-5 fixture
  set. Companion to [`features.absorption`](../rithmic_analytics/features/absorption.py).
- **[JSONL inspection report](./jsonl-inspection-report.md)** — on-disk
  schemas for each Rithmic stream. The loaders are validated against this.
- **[Task Scheduler setup](./task_scheduler_setup.md)** — one-time install
  runbook for the five Windows scheduled tasks.
- **[Rollover playbook](./rollover_playbook.md)** — front-month rollover
  procedures.
- **[Future work](./future_work.md)** — deferred items + enhancement notes
  surfaced during build-out.
- **[Engineering ticket backlog](./tickets.md)** — historical context for
  what was built when.

## Setup

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
```

## Verify

```powershell
pytest                          # tests pass
ruff check .                    # lint clean
mypy .                          # type-check clean
```

## CLI entry points

| CLI | Purpose | Reference |
|---|---|---|
| `python -m rithmic_analytics.cli.compute_vp` | One-shot VP → zone JSON | RA-006 |
| `python -m rithmic_analytics.cli.start_capture` | Probe supervision wrapper | RA-007 |
| `python -m rithmic_analytics.cli.daily_zones` | Nightly zone-JSON orchestrator | RA-010 |
| `python -m rithmic_analytics.cli.rotate` | Capture-file rotation | RA-008 |
| `python -m rithmic_analytics.cli.heartbeat` | Daily heartbeat task | RA-011 |

The full flags + exit codes for each are in the module docstrings; the daily
operational view is in [`operations.md`](./operations.md).

The capture-quality dashboard and daily HTML report are **library
callables**, not CLIs: `render_capture_dashboard(...)` in
`viewer.capture_dashboard` and `render_daily_report(...)` in `viewer.vp_report`.
Wire them up via `scripts/explore_session.py` or a thin wrapper.

## Interactive exploration

```powershell
python -i scripts/explore_session.py 2026-05-15
```

Opens an interactive Python shell pre-populating `trades`, `vp`, `cvd_df`,
`footprint`, `absorption_events`, `multi`, and `envelope` as locals for the
given trading day.

## Project layout

```
tools/rithmic_analytics/
├── pyproject.toml
├── docs/                       ← you are here
├── rithmic_analytics/
│   ├── core/                   ← loaders + schema
│   ├── features/               ← VP, ATR, CVD, footprint, absorption, sweep, hidden, multi
│   ├── ops/                    ← alerts, rotation, heartbeat, rollover, credentials
│   ├── viewer/                 ← HTML report + dashboard
│   └── cli/                    ← entry points
├── scripts/
│   └── explore_session.py
└── tests/
```

Data lives outside the package, addressable by relative path:

```
data/
├── captures/{YYYY-MM-DD}/{ROOT}_{rth,globex}.jsonl
├── captures_archive/{YYYY-MM-DD}/...gz
├── zones/{YYYY-MM-DD}_{ROOT}_{session}.json
├── alerts/alerts.ndjson
├── heartbeat/{YYYY-MM-DD}.txt
└── reports/...html
```

## Status

Sprint 4 complete. 24 of 24 tickets shipped (RA-023 descoped during sprint
planning). See [`tickets.md`](./tickets.md) for the full backlog and
[`future_work.md`](./future_work.md) for deferred items.
