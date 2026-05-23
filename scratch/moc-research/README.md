# MOC-R1 event-day manifest methodology

This scratch directory contains the research-tier MOC-R1 event-anchor
calendar and day-classification manifest.

## Authority

- Master plan Appendix A and MOC Family A Plan A section 7 supplied in the
  dispatch context.
- ADR-0016 is unchanged; this ticket is descriptive research only.
- Operator half-day catalog authority:
  - no half-days in the current `sim03_corpus` date range.
  - `2026-02-16` Presidents Day full closure, outside the current corpus range.
  - `2026-04-03` Good Friday full closure, inside the current corpus range.
- Operator macro policy:
  - `day_class` is only `full`, `half`, or `holiday_observed`.
  - macro information is represented by `is_macro_day`,
    `macro_event_categories`, `macro_event_offset_minutes`, and
    `event_notes`.

## Determinism

`event-day-manifest.json` uses `generated_at_note` instead of a wall-clock
timestamp, sorted JSON object keys, integer UTC nanoseconds, and LF line
endings. Running `build-event-day-manifest.py` twice with the same inputs must
produce byte-identical output.

## C0/I0 semantics

`C0` is the cash-equity close anchor. `I0` is the imbalance anchor and is always
`C0 - 10 minutes`. Storage is UTC nanoseconds. Computation uses
`America/New_York`. Human-readable notes avoid hard-coded PST/PDT language.

The `2026-04-03` Good Friday row is a closed-market row with
`data_present=false` and `is_rth=false`. It retains nominal `C0/I0` anchors
for calendar alignment only; no market data is expected for that date.
