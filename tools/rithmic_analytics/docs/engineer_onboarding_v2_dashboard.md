# Engineer Onboarding — v2 Real-Time Dashboard

> ⚠ **STACK SUPERSEDED (2026-05-28).** Frontend and transport decisions in
> this doc (HTMX, Server-Sent Events, "consume JSONL", keep-v1-HTML) are
> **out of date**. The v2 build was re-scoped to a contract-first,
> parallel-agent plan on **React + TypeScript + WebSocket +
> detectors-as-library** with a TradingView lightweight-charts surface.
>
> Authoritative stack + architecture:
> [`v2_realtime_architecture.md`](./v2_realtime_architecture.md).
> Fan-out playbook:
> [`executor_prompts/v2_realtime_parallel_dispatch.md`](./executor_prompts/v2_realtime_parallel_dispatch.md).
> Ticket set: RA-067 (contract unblock) → RA-060/061/062/063 (parallel) →
> RA-068 (hardening) in [`tickets.md`](./tickets.md).
>
> **The sections below remain current and reusable:** the signal pipeline
> (RA-046–RA-059), where-things-live, the RA-052 memory contract, the
> RA-050 schema-extensibility contract, operational discipline, and the
> definition of done. The "v2 target architecture" and per-ticket backlog
> sections that described the old stack have been removed — see the
> architecture doc instead.

You're inheriting a production analytics + signal-generation pipeline for
intraday MNQ futures trading. The v1 dashboard (HTML, 5-min refresh cycle)
has served its purpose; v2 transforms it into a real-time, prioritized,
alert-driven decision surface.

This document gives you the pipeline + operational context for the v2 work.
The build plan itself lives in the architecture doc and parallel dispatch
linked above.

---

## TL;DR — What you're building

A real-time browser dashboard with native desktop notifications that:

1. **Pushes signal updates in real time** (replaces the 5-min HTML refresh) —
   transport is **WebSocket** per the architecture doc, not SSE.
2. **Prioritizes by current price + signal urgency** (replaces undifferentiated displays)
3. **Fires audio + browser + Windows-toast notifications on confluence-validated alerts**
4. **Reuses the existing detectors as an in-process library** (RA-046 through
   RA-059) — no changes to detection logic; the backend imports
   `rithmic_dashboard.features.*` directly, with a parity gate proving the
   library path matches the historical JSONL path.

The detection layer is COMPLETE. You're building the alert + display layer.

---

## Read these first (in order)

1. **`tickets.md`** — search for RA-046 onwards. Skim the spec for each shipped
   ticket to understand what signals exist.
2. **`incident_5_27_memory_blowup.md`** — explains the RA-052 memory contract
   that all live-path code must respect (< 2GB peak RSS).
3. **`ewma_calibration_methodology.md`** — example of the documentation style
   expected for new modules.
4. **`run_local_probe_refresh.ps1`** — the operational loop that drives the
   current dashboard. Your v2 server will run alongside it, not replace it.
5. **Existing dispatch prompts** (`ra046_dispatch.md` through `ra059_dispatch.md`)
   — read 2-3 to absorb the pre-build sweep discipline. Your v2 work follows
   the same pattern.

---

## The signal pipeline (what already exists)

All signals are produced by Python modules in `tools/rithmic_dashboard/rithmic_dashboard/features/`
and persisted to `data/live_analysis/<date>_<session>_<signal_type>.jsonl`.

The v2 backend reuses these detectors as an in-process library (importing
`rithmic_dashboard.features.*`) and pushes results to browsers over
WebSocket. The JSONL files remain the historical/replay artifact and the
parity reference — see [`v2_realtime_architecture.md`](./v2_realtime_architecture.md)
for the library-path-vs-JSONL-path parity gate.

### Detection layer (DO NOT MODIFY without explicit approval)

| Ticket | Module | What it detects | JSONL output |
|---|---|---|---|
| RA-015 | `compute_absorption` | True absorption from MBP1 (4-factor) | (legacy artifact) |
| RA-031 | `vwap.py` | Session VWAP + 1σ/2σ bands | (in zones JSON) |
| RA-046 | `sweep_detector.py` | 3-tick clearing through structural levels | `*_sweeps.jsonl` |
| RA-046 | `absorption_proxy.py` | Volume + delta divergence | `*_absorption_proxy.jsonl` |
| RA-046 | `live_signals.py` | CVD breakdown (session/60m/15m), volume velocity | (in state JSON) |
| RA-047 | `delta_dislocation.py` | Candle-vs-delta divergence at zones | `*_delta_dislocations.jsonl` |
| RA-049 | `trade_size_classifier.py` | retail/mixed/institutional/block | (in flow data) |
| RA-049 | `institutional_flow.py` | Concentration events + block trades | `*_institutional_flow.jsonl` |
| RA-053 | `ewma_volatility.py` | Adaptive σ + LOW/NORMAL/HIGH regime | `*_aggressor_flow_state.json` |
| RA-058 | `aggressor_metrics.py` | liftAsk/hitBid/vDelta windowed | `*_aggressor_flow.jsonl` |
| RA-058 | `footprint_aggregator.py` | Per-price per-bar imbalance | `*_footprint.jsonl` |
| RA-059 | `iceberg_detector.py` | MBO refill pattern + OBS confirmation | `*_icebergs.jsonl` |

### Prominence layer (RA-050 — the architectural seam you'll integrate with)

`recent_signals_panel.py`, `multi_signal_stack_alert.py`, `zone_signal_badges.py` —
these read from ALL the JSONL files via a generic event-type schema:

```jsonl
{"timestamp_pt": "...", "event_type": "...", "level_id": "...|null",
 "description": "...", "intensity": float, "confidence": "high|medium|low",
 "metadata": {...}}
```

**This generic event-type schema is the basis of the v2 wire contract.**
The WebSocket message envelope (frozen in RA-067, dual-typed Pydantic ⇄
TypeScript with a parity test) carries events shaped like this. New signal
families (registered in the family map) auto-flow through the prominence
layer and out over the wire without renderer changes.

Currently registered families: `sweep`, `absorption`, `delta_dislocation`,
`institutional_flow`, `aggressor_flow`, `vol_regime`, `iceberg`.

### Probability multiplier framework (RA-046 → RA-059)

`probability_adjuster.py` composes multipliers additively under [0.4, 1.6] cap.
Each multiplier has provenance (which event triggered it) for tooltip display.
v2 surfaces these in the new prioritized scenario panel.

### Operational layer (RA-052)

`run_local_probe_refresh.ps1` runs every 5 minutes:
1. Incremental normalize (`normalize_probe_incremental`)
2. Light daily_zones compute (`daily_zones --mode light`)
3. Dashboard HTML generation
4. **All under 2GB peak RSS**

Your v2 server runs IN ADDITION TO this loop, not as a replacement: the
RA-052 refresh loop keeps producing the detector JSONL + per-session state
the v2 backend reads. (Whether the v1 HTML view is retired or retained is a
stack decision — see [`v2_realtime_architecture.md`](./v2_realtime_architecture.md);
the current plan retires it in favor of the realtime UI.)

---

## v2 target architecture + ticket backlog → moved

The v2 stack, the architecture diagram, the dependency graph, the
file-ownership map, and the per-ticket backlog now live in the
authoritative docs (the old HTMX/SSE/FastAPI-only design that was here has
been removed to prevent wrong-stack builds):

- **Stack + architecture + parallel-execution plan:**
  [`v2_realtime_architecture.md`](./v2_realtime_architecture.md)
  (React + TypeScript + WebSocket + detectors-as-library + lightweight-charts).
- **Fan-out playbook (how to launch the parallel agents):**
  [`executor_prompts/v2_realtime_parallel_dispatch.md`](./executor_prompts/v2_realtime_parallel_dispatch.md).
- **Ticket specs:** [`tickets.md`](./tickets.md) — RA-067 (contract unblock,
  serial P0) → RA-060 / RA-061 / RA-062 / RA-063 (parallel, disjoint
  directories) → RA-068 (integration + hardening). RA-064 (MBO F/T
  warm-up) shipped; RA-065 / RA-066 are the iceberg-data follow-ups.

Everything below this point — operational discipline, contracts, where
things live, definition of done — is current and applies to the v2 build
as written.

---

## Operational discipline (non-negotiable)

Every ticket follows the same pattern. **Do not skip steps.**

### Pre-build sweep (REQUIRED before any source edit)

1. Read the ticket spec and dispatch prompt in full
2. Investigate the existing codebase (file paths, integration points, schemas)
3. Surface 7-9 ambiguity points with recommended defaults
4. Document phase estimates with time budgets
5. **Wait for green-light from the technical lead before writing code**

This catches design issues at design time, not build time. It works.

### Memory contract (RA-052 — sacred)

- Light path (5-min loop): **peak RSS < 2GB**
- Full/EOD path: peak RSS < 30GB
- Memory regression test in CI catches violations
- New code must respect this. No exceptions.

### Schema-extensibility contract (RA-050)

When you add a new event type, it MUST flow through the family map without
renderer changes. Test this explicitly: inject a synthetic never-before-seen
event_type, verify it appears in Recent Signals panel + zone badges.

### Probability multiplier composition (RA-046)

Additive composition, [0.4, 1.6] cap. New multipliers must:
- Have explicit mutual-exclusion guards if applicable (see RA-047's strong-variant rule)
- Document trigger conditions
- Compose with all existing multipliers
- Co-firing tests required

### Backward compatibility

The **detection layer and the RA-052 refresh loop** (RA-046–RA-059) must
continue to work untouched — v2 reuses the detectors as a library and
consumes the same per-session outputs. What changes for the *view* layer
(retire vs. retain the v1 HTML generator) is a stack decision resolved in
[`v2_realtime_architecture.md`](./v2_realtime_architecture.md); the current
plan retires the v1 HTML UI. The non-negotiable invariant is: **don't break
the detectors or the 5-min loop they run in.**

---

## Key contracts to preserve

| Contract | What it means | Enforced by |
|---|---|---|
| < 2GB peak RSS on light path | 5-min refresh loop memory budget | CI regression test |
| Generic event_type schema | New families flow into RA-050 without renderer changes | RA-050 family map + extensibility tests |
| Audit trail event types schema | New events follow `(ts, type, level_id, description, intensity, confidence, metadata)` | RA-050 schema contract |
| Probability multiplier provenance | Each multiplier has trigger data in tooltip | RA-046 multiplier framework |
| `-EmitHeavyAnalytics` switch | EOD vs intraday analytics separation | RA-052's stopgap-then-formal-build |
| No source code in cron-scheduled paths | Manual deploy + git commit boundary | Operational discipline |

---

## Where things live

| Project | Path | Owns |
|---|---|---|
| `rithmic_analytics` | `D:\Quant-futures-app\tools\rithmic_analytics\` | Capture, normalize, compute_vp, daily_zones, calibration |
| `rithmic_dashboard` | `D:\Quant-futures-app\tools\rithmic_dashboard\` | Live signals, probability adjuster, renderer, scenario state |
| Data captures | `D:\Quant-futures-app\tools\rithmic_analytics\data\captures\<date>\` | Raw + normalized JSONL |
| Live analysis | `D:\Quant-futures-app\tools\rithmic_dashboard\data\live_analysis\` | Per-session detector outputs |
| Dashboard state | `D:\Quant-futures-app\tools\rithmic_dashboard\data\dashboard\` | Audit, scenarios, state, generated HTML |
| Calibration corpus | `D:\Quant-futures-app\tools\rithmic_analytics\data\calibration_corpus\` | EWMA decay, per-session stats |
| Databento corpus | `D:\qfa-cache\databento\` + `D:\Quant-futures-app\data\databento\sim03_corpus\` | 92 RTH sessions Feb-Apr 2026 |

---

## Definition of done (per ticket)

Every ticket ships when:

- All acceptance criteria met
- `python -m pytest -q` passes (no regressions)
- `python -m ruff check .` clean
- `python -m mypy rithmic_dashboard` clean (and/or `rithmic_analytics`)
- Visual smoke against real data fixture passes
- Memory regression: peak RSS within ticket's stated budget
- Docs updated in `feature_reference.md` + `operations.md`
- Commit message references the ticket number
- Ship report posted to technical lead with verification numbers

---

## Communication protocol with technical lead

- Every dispatch begins with a pre-build sweep posted as a single message
- Lead green-lights the picks (often with refinements)
- Build phases sequentially, surface ambiguities mid-build if they arise
- Ship report posts verification results (test counts, smoke output, memory)
- Lead reviews + closes the ticket
- Operational hygiene (commits, .gitignore boundaries, no stale runtime state)
  follows the bd1e8c5 baseline pattern

---

## When you're stuck

1. **Read the relevant prior dispatch + ticket** — most architectural decisions are documented
2. **Investigate the codebase** — the existing patterns are the right patterns
3. **Surface as ambiguity in the pre-build sweep** — better to ask before than rework after
4. **Don't break existing pipelines** — RA-046 through RA-059 are production; v2 adds, doesn't subtract

---

## Final note

This is a real-money trading tool. The discipline matters. The contracts
matter. The pre-build sweep is not paperwork — it's the seam where good
software meets the trader's edge.

Build with care. Ship with verification. The pipeline ships ~6-7 hours per
ticket consistently when the protocol is followed. Don't compress the
protocol.

Welcome aboard.
