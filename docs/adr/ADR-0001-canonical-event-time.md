# ADR-0001: Canonical Event Time For V1

## Status

Accepted

## Context

The INFRA-01 Rithmic RProtocol collector proved that V1 can capture the required market-data streams, including `L1_QUOTE`, `LAST_TRADE`, `MBP10`, and `MBO`. The Windows capture host clock evidence did not satisfy the original strict local receive-time discipline gate: observed `w32tm` stripchart offsets were approximately +136 ms to +190 ms.

The original timestamp gate exists to make timestamp-dependent replay, first-passage labels, feature alignment, candidate lineage, and gap detection safe before `DATA-01`. For sim-first V1, those paths should depend on source/exchange event time, not the local receive clock.

## Decision

For V1, `exchange_event_ts_ns` is the canonical event clock for market-data events.

`exchange_event_ts_ns` is authoritative for:

- replay ordering;
- first-passage labels;
- feature alignment;
- candidate lineage;
- gap detection where exchange time is populated;
- Databento parity checks.

`sidecar_recv_ts_ns` is preserved but treated as non-authoritative telemetry only.

`sidecar_recv_ts_ns` may be used for:

- receive-latency diagnostics;
- runtime health;
- feed delay monitoring;
- operational troubleshooting.

`sidecar_recv_ts_ns` must not be used as the canonical event timestamp for V1 replay, labels, feature alignment, candidate lineage, or first-passage logic.

When checking exchange-time ordering, the invariant is non-decreasing per stream. Multiple exchange events may legitimately share the same nanosecond timestamp.

## Consequences

`DATA-01` may proceed without requiring the Windows capture host clock to meet sub-5 ms local receive-time discipline, provided the revised timestamp gate passes:

- `exchange_event_ts_ns` coverage is at least 99.9% for market-data records, excluding documented startup/control records;
- `exchange_event_ts_ns` is non-decreasing per stream;
- `sidecar_recv_ts_ns - exchange_event_ts_ns` telemetry has non-negative p50 and p99 below 500 ms;
- Databento overlap parity confirms exchange-time-aligned live capture and historical data reconstruct comparable market state.

This decision applies to sim-first V1 only. It does not remove the need for better clock discipline before live execution or future order-routing work.

Live execution remains out of scope for V1, and no Rithmic order-plant implementation is implied by this ADR.
