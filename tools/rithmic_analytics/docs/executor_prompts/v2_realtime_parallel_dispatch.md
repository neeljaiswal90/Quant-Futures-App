# v2 Realtime — Parallel-Execution Dispatch

For the engineer building the v2 realtime dashboard. The build is
structured **contract-first** so most of it runs as parallel agents.
This dispatch tells you the order, the fan-out, and the rules that keep
parallel agents from colliding.

Read `docs/v2_realtime_architecture.md` first — it has the stack
decisions, the lightweight-charts evaluation, the dependency graph, and
the file-ownership map. This dispatch assumes you've read it.

---

## The shape of the work

```
RA-065 ──► RA-066                         (data track — runs the whole time)

RA-067 ──┬──► RA-060 ─┐
         ├──► RA-061 ─┤
         ├──► RA-062 ─┼──► RA-068
         └──► RA-063 ─┘
(serial)   (4 parallel agents)   (convergence)
```

- **RA-067 is serial and first.** It freezes the wire contract and ships
  a mock emitter. Until it lands, the fan-out cannot start without
  rework risk.
- **RA-060 / 061 / 062 / 063 run in parallel** once RA-067 merges. Each
  owns a disjoint directory (see the arch doc's ownership map) and builds
  against the RA-067 mock — not against each other.
- **RA-068 is the convergence.** It swaps the mock for the real backend
  and hardens to production. Runs alone, last.
- **RA-065 → RA-066** (the iceberg priority channel + tolerance
  calibration) are independent of the realtime track and run alongside
  the whole thing.

---

## How to run the parallel phase with Agents

After RA-067 merges, launch one agent per ticket **in a single message**
so they run concurrently. Required settings per agent:

- `isolation: "worktree"` — each agent gets its own git worktree so
  parallel file writes never race.
- Point each agent at its ticket in `docs/tickets.md` and at the
  arch doc.
- Tell each agent its **owned directory** (from the ownership map) and
  that writing outside it is forbidden.
- Tell each agent to develop against the RA-067 **mock emitter**.

Suggested fan-out (4 agents at once):

| Agent | Ticket | Worktree owns |
|---|---|---|
| backend | RA-060 | `services/realtime_backend/` |
| ui | RA-061 | `apps/dashboard_ui/` |
| daemon | RA-062 | `services/notification_daemon/` |
| config | RA-063 | `services/realtime_backend/config/` + config type |

Plus the data track as a 5th concurrent agent (RA-065), with RA-066
chained after it.

When all four parallel agents report done and their worktrees merge
cleanly (the contract parity test is the tripwire — see below), start
RA-068 as a single agent.

---

## Per-ticket protocol (every ticket, including the parallel ones)

1. Read the ticket spec in `docs/tickets.md` + the arch doc.
2. Investigate the owned directory + the contract.
3. **Pre-build sweep as a single message**: plan paragraph, ambiguity
   points with recommended defaults, phase estimates. Wait for
   green-light. (For the parallel agents, the sweeps can come back
   concurrently — review them together.)
4. Build phases sequentially within the ticket.
5. Ship when verification passes (tests + ruff/mypy or eslint/tsc +
   the relevant smoke).
6. Ship report with verification numbers.

---

## The rules that keep parallel agents safe

1. **Disjoint ownership is absolute.** An agent writes only its owned
   directory. The one shared file — the config type in
   `contracts/realtime/` — is stubbed by RA-067 and filled by RA-063
   only. No other agent touches `contracts/`.
2. **The contract is frozen after RA-067.** If a parallel agent thinks
   the wire shape must change, it STOPS and escalates — the change goes
   back through RA-067 and re-broadcasts to all agents. It does not
   edit the contract locally.
3. **The TS ⇄ Pydantic parity test is the integration tripwire.** It
   must stay green in every worktree. A red parity test means someone
   forked the contract — fix before merge.
4. **Build against the mock, not against siblings.** During the parallel
   phase no agent depends on another's running process.

---

## Critical contracts to preserve (all tickets)

- **RA-052 memory**: the long-running backend stays < 2GB peak RSS.
- **RA-050 schema-extensibility**: enforced at the contract layer — an
  unknown event family round-trips through the envelope and reaches the
  feed without renderer changes. RA-067 ships the test for this.
- **Detector reuse, not rewrite**: RA-060 imports
  `rithmic_dashboard.features.*` as a library. Do not modify detection
  logic (RA-046–RA-059). If a detector needs a change, that's a separate
  ticket.
- **Never** touch credentials, scheduler entries, env files, or the live
  capture/refresh processes. The realtime stack is strictly downstream of
  the capture siblings.
- **Never** add trade execution. Read-only decision support.

---

## What NOT to do

- Don't start the fan-out before RA-067 merges.
- Don't let two agents share a worktree.
- Don't edit the wire contract outside RA-067.
- Don't reuse the v1 HTML view or its generator — this is greenfield.
- Don't reach for SSE — transport is WebSocket (bidirectional is required
  for acks/config/dismissals).
- Don't pull in a lightweight-charts React wrapper dependency — use the
  documented `useRef`+`useEffect` pattern.

---

## First action

Post a **pre-build sweep for RA-067** as your first message (it's the
serial unblock — get it right and the fan-out is clean). Surface: the
envelope schema you propose, the mock-emitter approach (replay vs
synthetic), how you'll keep TS ⇄ Pydantic in sync, and the skeleton
directory layout. Wait for green-light before writing the contract.

Once RA-067 ships, post the four parallel pre-build sweeps together and
we review them as a batch.
