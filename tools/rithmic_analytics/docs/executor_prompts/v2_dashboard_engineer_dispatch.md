> ⚠ **SUPERSEDED (2026-05-28)** by
> [`executor_prompts/v2_realtime_parallel_dispatch.md`](./v2_realtime_parallel_dispatch.md).
>
> This dispatch describes the original **serial** build on the
> **HTMX / SSE / JSONL-consume / keep-v1** stack. The v2 build was
> re-scoped to a **contract-first, parallel-agent** plan on
> **React + WebSocket + detectors-as-library** (RA-067 contract unblock →
> RA-060/061/062/063 in parallel → RA-068 hardening). The stack and
> fan-out are authoritative in
> [`v2_realtime_architecture.md`](../v2_realtime_architecture.md).
>
> Do **not** dispatch from this file. It is retained only for historical
> context on how the v2 effort was first framed.

---

# v2 Dashboard Engineer Onboarding Dispatch

Send this to the new engineer's Codex session as their FIRST message. It
gives them complete context to read the onboarding doc, then surface a
pre-build sweep on whichever ticket they start with.

The work spans 5 tickets (RA-064 warm-up + RA-060 through RA-063 v2 build).
Total estimate: ~35-50 hours of work over 1-2 weeks of focused engineering.

---

# Copy-paste below

```
You're inheriting a production analytics + signal-generation pipeline for
intraday MNQ futures trading. The current dashboard (v1, HTML, 5-min
refresh) has served its purpose. Your work is to build v2 — a real-time,
prioritized, alert-driven decision surface.

The detection layer is COMPLETE. You're building the alert + display
layer on top of it.

# Start here (in order)

1. Read the onboarding doc in full:
   D:\Quant-futures-app\tools\rithmic_analytics\docs\engineer_onboarding_v2_dashboard.md

   This covers:
   - What you're building
   - The signal pipeline (RA-046 through RA-059) — what already exists
   - v2 target architecture (FastAPI + SSE + HTMX + native notifications)
   - Where things live
   - Operational discipline (mandatory)
   - Definition of done

2. Read these specific tickets in tickets.md (search for the IDs):
   D:\Quant-futures-app\tools\rithmic_analytics\docs\tickets.md

   - RA-064: MBO F/T investigation (your WARM-UP — start here, ~2-3h)
   - RA-060: Real-time backend (FastAPI + SSE, ~12-16h)
   - RA-061: Tiered UI frontend (HTMX + notifications, ~12-16h)
   - RA-062: Native Windows notification daemon (~4-6h)
   - RA-063: Alert configuration system (~3-4h)

3. Read at least 2 prior dispatches to absorb the pre-build sweep
   discipline:
   D:\Quant-futures-app\tools\rithmic_analytics\docs\executor_prompts\
   - ra058_dispatch.md (recent, similar scope)
   - ra053_dispatch.md (slightly bigger scope, similar discipline)

4. Read the post-mortem from the most recent operational incident:
   D:\Quant-futures-app\tools\rithmic_analytics\docs\incident_5_27_memory_blowup.md

   This explains the RA-052 memory contract (< 2GB peak RSS on light
   path). All v2 code must respect this.

# Recommended ticket order

**Week 1**:
1. RA-064 warm-up (2-3h) — learn the capture/normalize pipeline
2. RA-060 backend (12-16h) — foundation for everything else

**Week 2**:
3. RA-061 frontend (12-16h) — the visible product
4. RA-062 native notifications (4-6h)
5. RA-063 alert config (3-4h)

Each ticket follows this protocol:

1. Read the ticket spec + dispatch prompt in tickets.md and
   executor_prompts/
2. Investigate the codebase (file paths, integration points, schemas)
3. Surface a pre-build sweep AS A SINGLE MESSAGE containing:
   - Plan paragraph
   - 7-9 ambiguity points with recommended defaults
   - Phase estimates with time budgets
   - Anything you found reading the code
4. WAIT for the technical lead to green-light the picks
5. Build phases sequentially. Surface ambiguities mid-build if new ones
   arise.
6. Ship when verification passes (tests + ruff + mypy + visual smoke +
   memory regression).
7. Post a ship report with verification numbers.

The discipline is real. The pipeline ships ~6-7 hours per ticket
consistently when the protocol is followed. Don't compress it.

# Critical contracts to preserve

1. **RA-052 memory contract**: light-path code stays under 2GB peak RSS.
   Tests in CI enforce this.

2. **RA-050 schema-extensibility contract**: new event types flow into
   the prominence layer (Recent Signals panel, multi-stack banner, zone
   badges) without renderer changes. Test this explicitly with a
   synthetic never-before-seen event_type.

3. **Backward compatibility**: the existing HTML generator (RA-045/046)
   must continue to work. v2 ADDS, doesn't subtract.

4. **No source code in cron-scheduled paths without commit boundary**.
   The git baseline is bd1e8c5 — your work continues from there.

# What NOT to do

- Don't modify RA-046 through RA-059 detection logic. Those are
  production. Your v2 server CONSUMES their JSONL outputs.
- Don't bypass the pre-build sweep. It catches design errors at design
  time.
- Don't compress the test or smoke verification. The memory budget +
  schema-extensibility contract are non-negotiable.
- Don't touch credentials, scheduler entries, env files, or active
  capture/refresh processes.
- Don't add WebSocket bidirectional support to v1 (one-way SSE is
  sufficient and simpler).

# What to do first

After reading the onboarding doc and the prior dispatches, post a
pre-build sweep for **RA-064 (the warm-up ticket)** as your first
message. Surface:

- Plan paragraph
- 5-6 ambiguity points minimum (smaller ticket = fewer points needed)
- Phase estimate (probably 1 hour investigation + 1-2 hours fix +
  verification = 2-3h total)
- Anything you found reading normalize_probe.py

Wait for green-light before writing any source code.

# Standing by

The technical lead reviews pre-build sweeps and ship reports. Operational
patterns are documented. The codebase rewards careful reading.

Welcome aboard.
```
