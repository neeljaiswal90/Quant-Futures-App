# V2-PF-C-LATE-AM-PAPER-OBSERVATION-RUN-01 paper session summary

## Runtime controls

| Field | Value |
|---|---|
| Strategy | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| Entrypoint | `npx tsx scripts/paper/run-v2-pf-c-late-am-paper-observation.ts` |
| Adapter kind | `mock` |
| Market data source | `simulation` |
| Broker/live dispatch | Not authorized |
| Phase 6 authority | Not created |
| Run cap | 5 minutes |

## Evidence files

| Artifact | SHA-256 |
|---|---|
| `paper-session-journal.jsonl` | `f862f026eb9f0aa5eaec73a40ff1857fa6e556f460e72c9f215859d9209863b1` |
| `paper-session-diagnostics.json` | `e252b7609627c2f33b80af23c2e72923cc264125e00bb61f0ef6e18237e97715` |

## Event counts

| Event type | Count |
|---|---:|
| `SESSION_MANIFEST` | 2 |

## Strategy-evaluation reconciliation

No STRAT_EVAL events were emitted; classify this as startup/config/journal control evidence only, not strategy signal observation evidence.

## Observation policy

This kickoff/control run does not complete or claim progress against the 45 trading day minimum or 60 trading day preferred paper-observation policy. It is startup/config/journal control evidence only unless later runs define and satisfy observation-day criteria.

## Raw journal caveat

Raw journal timestamps are captured run evidence and are not claimed as byte-stable reproducibility outputs. Diagnostics and summaries are deterministic derivations from this captured journal where practical.
