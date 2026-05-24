# MOC-R3 trigger-conditional simulator methodology

MOC-R3 reads R2's `event-stream.parquet`, verified against
`scratch/moc-research/event-stream.sha256.txt` before simulation. The
input stream is regenerated locally because it is intentionally gitignored.
The expected R2 stream SHA is
`f9effd810b609c03394e96c69e473e9d388eec82accdcbf8975494a307c330cb`.

The simulator processes the 30 R1 manifest rows where `data_present=true`
and `is_rth=true`; the synthesized Good Friday row is excluded. For each
session it emits the full 720-cell grid: 3 arm times, 5 trigger offsets, 3
reference choices, 4 stop-limit protections, and 4 latency buckets.

Trigger detection uses event-level MBP-1 quotes only. Buy stops trigger on
the first quote with ask >= stop price; sell stops trigger on the first quote
with bid <= stop price. Stop-limit fills use event-level trade prints from
the trigger timestamp through I0+300s.

Slippage is deterministic. The seed is sha256(session_date|arm_time_s|
trigger_offset_pts|reference|stop_limit_protection_pts|latency_bucket_ms),
truncated to a uint32 and passed to FixedSeedRandomSource before calling
sampleMarketableAdverseSlippage. Byte-equal parquet output across two runs is
the load-bearing determinism gate.

For outcome=both_sides, both trigger timestamp fields are populated. The Plan
A R3 schema has singular fill and excursion fields, so those fields summarize
the earliest trigger side deterministically; production atomic OCO cancellation
is out of scope for this research-tier simulator.

Rows are sorted by session_date, arm_time_s, trigger_offset_pts, reference,
stop_limit_protection_pts, and latency_bucket_ms. Parquet metadata is static
and contains no wall-clock timestamp.
