# MOC-R4 expectancy-table methodology

MOC-R4 consumes R3 `triggered-events.parquet` and the locally regenerated R2
`event-stream.parquet`. Inputs are verified against their SHA attestations:
R3 `7da601066b958e484238a7fe767f6aead80df83ea38d54bbba1616b6b5dead3f`; R2
`f9effd810b609c03394e96c69e473e9d388eec82accdcbf8975494a307c330cb`.

Scope is MNQ-only: `mnq_low`, `mnq_mid`, and `mnq_high`. `nq_*` cost scenarios
are deferred to MOC-R4-NQ after QFA-119f supplies the NQ corpus. The emitted
research-grid manifest records `cost_cells=3` and `total_screened_cells_max=90,720`.

For R3 `outcome=both_sides`, R4 follows the MOC-R3 carry-forward: the
first-touch walk starts from the earliest trigger side. Aggregate both-fill cost
modeling is out of scope because Plan A R4 has singular fill/excursion fields.

Expectancy formula per row: `p_pt*pt_pts + p_stop*(-stop_pts) +
p_time*avg_close_pnl_at_300s`, converted to USD using MNQ point value $2.00,
then subtracting commission and two-sided slippage cost. `expected_daily_pnl_usd`
multiplies per-trade expectancy by `n_triggered_one_side / 30`.

Heatmaps fix `(cost_scenario, latency_bucket_ms, instrument, arm_time_s,
reference)`. The projection over `(trigger_offset_pts, stop_limit_protection)`
chooses the row with best `expected_daily_pnl_usd` for each `(pt_pts, stop_pts)`
cell. This best-of projection matches R4's screening purpose and is not a
production selection rule.

Matplotlib uses Agg, fixed figsize/DPI/font/cmap normalization, and explicit PNG
metadata. Parquet and JSON outputs carry deterministic no-wall-clock metadata;
PNG byte-equality is checked and documented in the PR test plan.
