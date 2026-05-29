# Rithmic Dashboard Feature Reference

## Envelope Loading

`rithmic_dashboard.data_sources.load_envelope()` loads the requested zones JSON
and overlays same-date RTH statistical reference lines when available.

- Primary source: selected volume-profile envelope, including combined-session
  VPOC/VAH/VAL/HVN/LVN.
- Overlay source: same-date `*_MNQ_rth.json` VWAP and sigma reference lines.
- Derived lines: missing `vwap_rth_band_p2sd` and `vwap_rth_band_m2sd` are
  derived from VWAP and the available `+/-1sd` lines.
- Metadata: the merged envelope includes `dashboard_sources` with primary path,
  overlay path, merge mode, and statistical reference count.

## Scenario State

`rithmic_dashboard.scenario_state.compute_scenario_states()` maps the structural
envelope to scenarios A/B1/B2/C/D/E/G. RA-045 tightened stops so displayed
R-multiples are interpretable:

- A: nearby support below the VPOC entry, capped at 1.5 ATR risk.
- B1/B2: `+/-2sd` scalp stops with 1.5 ATR cap.
- C: tight cycle-high fade stop capped at 0.5 ATR.
- D/E: tight continuation/breakdown stops capped below 0.75 ATR.
- G: stab-and-reverse stop capped at 1.5 ATR.

State hysteresis uses `2.0 ATR` to promote DORMANT to WATCHING and `2.2 ATR` to
demote WATCHING back to DORMANT. ACTIVE states keep a five-point exit buffer.

## Orderflow Pulse

`rithmic_dashboard.features.orderflow_pulse.compute_orderflow_pulse()` reads
completed local artifacts and returns an `OrderflowPulse`:

- Session CVD from normalized OBS-01 trades.
- Last-60-minute CVD from the same trade tape.
- Buy-volume percentage.
- Recent MBP1 spread mean, p99, and crossed-quote count from a bounded tail read.
- Latest absorption event from `data/absorption`.
- Top spoof bins from `data/order_pressure/*_summary.json`.

The pulse is cached in `data/dashboard/_orderflow_cache.json` by artifact
signature. Missing artifacts produce warnings and `n/a` fields instead of page
failure.

## Live Signals

`rithmic_dashboard.features.live_signals.compute_live_signals()` prefers the
normalized active OBS-01 capture and falls back to the active raw capture when
the normalized sibling is unavailable. It reads a bounded tail and never scans
the full multi-GB file. The default tail budget is 20 MB per generator run so
the 60-minute CVD dislocation window has enough trade history during high
velocity sessions.

It computes:

- Rolling 60-minute live VWAP and one-standard-deviation bands.
- Live CVD windows: tail-session, last 60 minutes, and last 15 minutes.
- Volume velocity: last-15-minute trades/min versus the earlier tail baseline,
  classified as `active`, `normal`, `quiet`, or `unknown`.
- Recent structural sweeps through VPOC/VAH/VAL/VWAP/sigma/HIGH/SUPER zones.
- Absorption proxy events from heavy-volume, balanced-delta fixed-price
  clusters.
- Delta dislocations: candle direction versus 60-minute CVD divergence at the
  nearest key level, persisted with `high` or `low_tail_span` confidence.
- Institutional-flow events: trade-size-classified concentration and block
  prints near structural levels, persisted with `high` or `low_tail_span`
  confidence.
- Aggressor-flow metrics: liftAsk, hitBid, net, ratio across 60s, 5m, 15m,
  and 60m windows; 30-second vDelta with 10-second flip hysteresis; and a
  tick-level 5-minute footprint table.
- Day-type events: RTH initial-balance classification, revisions, IB breaks,
  and IB extension touches persisted as the `day_type` signal family.
- EWMA volatility regime: a 15-minute Parkinson sigma observation updates the
  persisted EWMA variance every 5-minute dashboard tick. The resulting
  `LOW`/`NORMAL`/`HIGH` regime is classified versus the calibrated corpus median
  sigma and rendered in Orderflow Pulse.

Signal logs persist under `data/live_analysis/`:

- `<date>_<session>_cvd.jsonl`
- `<date>_<session>_sweeps.jsonl`
- `<date>_<session>_absorption_proxy.jsonl`
- `<date>_<session>_delta_dislocations.jsonl`
- `<date>_<session>_delta_dislocation_alerts.jsonl`
- `<date>_<session>_institutional_flow.jsonl`
- `<date>_<session>_aggressor_flow.jsonl`
- `<date>_<session>_aggressor_flow_state.json`
- `<date>_<session>_footprint.jsonl`
- `<date>_<session>_vol_regime.jsonl`
- `ewma_volatility_state.json`
- `<date>_<session>_day_type.json`
- `<date>_<session>_day_type.jsonl`
- `dislocation_thresholds.json`
- `trade_size_thresholds.json`
- `session_overrides.json`

These are dashboard-owned live-analysis logs, separate from the post-session
`rithmic_analytics` artifacts.

## Aggressor Flow And Footprint

`rithmic_dashboard.features.aggressor_metrics` computes Bookmap-style
aggressor metrics directly from the normalized OBS-01 trade tail:

- `liftAsk`: volume from aggressive market buys lifting the ask.
- `hitBid`: volume from aggressive market sells hitting the bid.
- `net`: `liftAsk - hitBid`.
- `ratio`: `liftAsk / max(hitBid, 1)`.
- `total_volume`: `liftAsk + hitBid`.

The dashboard computes the windows `[60s, 5m, 15m, 60m]` every refresh. These
windowed reads are deliberately separate from session CVD: CVD is the slow
session regime read, while aggressor windows show who is winning the tape now.

`vDelta` is the signed volume over the last 30 seconds. A
`v_delta_sign_flip` event fires only when the new sign has remained stable for
10 seconds, which prevents zero-line noise from creating repeated alerts.

The footprint aggregator builds the most recent completed 5-minute bar at MNQ
tick granularity. Per price:

- `bid_volume`: aggressive sells at that price.
- `ask_volume`: aggressive buys at that price.
- `imbalance`: `(ask_volume - bid_volume) / max(total_volume, 1)`.

`stacked_footprint_imbalance` fires when at least three consecutive prices have
same-side imbalance magnitude greater than `0.30`. The event carries the
midpoint as `level_price`, so RA-050 can attach it to the nearest displayed
level and let it participate in same-zone stack banners.

Canonical event file:

- `<date>_<session>_aggressor_flow.jsonl`

Event types:

- `aggressor_imbalance_extreme`: any aggressor window has ratio `>= 3.0` or
  `<= 0.33`.
- `v_delta_sign_flip`: 30-second vDelta changes sign with 10-second
  confirmation.
- `stacked_footprint_imbalance`: 3+ adjacent tick prices show same-side
  footprint imbalance.

Footprint rows persist separately to `<date>_<session>_footprint.jsonl`. Those
rows are rendered in Orderflow Pulse but are not Recent Signals rows by
themselves; only the derived events enter the RA-050 signal strip.

## Institutional Flow

`rithmic_dashboard.features.trade_size_classifier` classifies each normalized
trade by quantity. Defaults are intentionally conservative and transparent:
retail `1-9`, mixed `10-49`, institutional `50-99`, and block `>=100`
contracts. `trade_size_thresholds.json` can override those cutoffs per symbol.

`rithmic_dashboard.features.institutional_flow.compute_institutional_flow()`
reads the live trade tail, keeps institutional and block prints near displayed
structural levels, and emits two canonical event types:

- `institutional_concentration_detected`: at least three institutional/block
  trades in 15 minutes at the same zone with `abs(net_delta) > 100`.
- `block_trade_at_zone`: one trade at or above the block threshold.

Both map to the canonical `institutional_flow` family for RA-050. A
concentration plus block at the same zone is still one family for stack-alert
purposes; it needs a different family, such as sweep or absorption, before the
sticky multi-signal banner fires.

`rithmic_dashboard.cli.calibrate_trade_size_thresholds` calibrates the size
thresholds from recent OBS sessions using the `p50/p75/p95` trade-size
distribution. It writes atomically to
`data/live_analysis/trade_size_thresholds.json` and exits with code `2` when
there are too few sessions.

## Day Type And Initial Balance

`rithmic_dashboard.features.day_type_classifier.compute_day_type_classification()`
adds the RA-051 structural layer for RTH sessions. It waits until 08:00 PT for
MNQ, which is 90 minutes after the RTH open, so the first 60-minute initial
balance and a 30-minute confirmation window are both available. After the first
classification it rechecks every 15 minutes and emits `day_type_revised` only
when the type changes.

Capture sourcing is defensive: the classifier reads
`data/captures/<date>/MNQ_rth.obs01.jsonl` first, then falls back to
`data/captures/<date>/MNQ_rth.jsonl`. If neither exists, it emits
`day_type_skipped_no_capture_data`, leaves the status pending/skipped, and
applies no day-type multiplier. Partial sessions are controlled by
`data/live_analysis/session_overrides.json`, keyed by `<date>_<session>`, for
example `2026-05-25_rth`.

Persisted files:

- `<date>_rth_day_type.json`: current classification state.
- `<date>_rth_day_type.jsonl`: day-type classified/revised/skipped rows plus
  `ib_high_break`, `ib_low_break`, and `ib_extension_reached` events.
- `day_type_outcomes.jsonl`: session-close provenance for future calibration.

Supported day types are:

- `trend_day_up`
- `trend_day_down`
- `normal_day`
- `normal_variation_up`
- `normal_variation_down`
- `neutral_day_extreme`
- `neutral_day_center`
- `double_distribution_up`
- `double_distribution_down`
- `pending`

Double-distribution detection is a conservative proxy. Post-IB trades are binned
in 5-point price buckets. The classifier requires two volume modes separated by
at least 30 points, with each mode containing at least 20% of post-IB volume.
Confidence is `medium` by default and becomes `high` only when the mode gap is
at least `2.0x` the IB range.

`rithmic_dashboard.features.ib_scenarios.build_ib_templates()` adds `IB-Long`
and `IB-Short` only after day type is classified. The entries are IB high/low
breaks with standard `0.5x`, `1.0x`, and `1.5x` IB-range extension targets and
an IB-midpoint stop reference.

## Recent Signal Prominence

RA-050 adds a renderer-only prominence layer over the live signal logs:

- `rithmic_dashboard.features.recent_signals_panel.build_recent_signals()`
  reads canonical live-analysis JSONL files first:
  `<date>_<session>_sweeps.jsonl`,
  `<date>_<session>_absorption_proxy.jsonl`, and
  `<date>_<session>_delta_dislocations.jsonl`.
- The capped `_audit.json` is a fallback only when the matching live-analysis
  file is absent, which keeps current sessions sourced from the full event
  corpus instead of the deduped audit subset.
- Unknown future per-session JSONL files are normalized as generic signals when
  they include a timestamp. RA-049 institutional-flow events now use that
  schema-extensibility contract directly, and RA-051 day-type events use the
  same path without a renderer rewrite.
- Rows are filtered to a 30-minute window and time-decayed as fresh under
  5 minutes, normal from 5-15 minutes, and faded from 15-30 minutes.
- Scenario chips appear only when the signal price is inside a scenario entry
  zone and the signal bias matches the scenario direction. Absorption maps
  `sell_absorbed` to long and `buy_absorbed` to short.

`rithmic_dashboard.features.zone_signal_badges.build_zone_signal_badges()` adds
compact signal badges to Distance To Key Levels. Exact `level_id` matches are
preferred; otherwise events attach to the nearest displayed structural level
within 5 points.

`rithmic_dashboard.features.multi_signal_stack_alert.build_multi_signal_stack_alerts()`
creates the sticky same-zone banner only when at least two distinct signal
families fire in the 30-minute window and price remains within 30 points of the
zone. Same-family repeats, such as multiple sweeps, are intentionally ignored.

## Probability Adjuster

`rithmic_dashboard.probability_adjuster.adjust()` now composes transparent
additive multipliers with a final factor cap of `[0.4, 1.6]`. Existing
distance/session/time/state factors remain, and RA-046 adds live factors:

- `cvd_direction_match`: +20% factor when session CVD supports scenario bias.
- `cvd_direction_oppose`: -20% factor when session CVD opposes scenario bias.
- `cvd_momentum_flip`: -10% factor when last-15-minute CVD opposes session CVD.
- `recent_sweep_at_entry`: +10% factor for unrecovered sweep at entry.
- `absorption_proxy_at_entry`: +15% factor for repeated proxy defense at entry.
- `volume_velocity_quiet`: -15% factor in thin participation.
- `volume_velocity_active`: +5% factor in active participation.
- `multi_method_confluence_bonus`: +5% per method beyond two at entry.
- `delta_dislocation_at_entry`: +25% factor when candle direction and 60-minute
  CVD diverge at a matching entry level.
- `delta_dislocation_at_entry_strong`: +35% factor when the same event exceeds
  the strong threshold; this replaces, rather than stacks with, the base
  dislocation factor.
- `institutional_flow_match`: +20% factor when institutional concentration
  aligns with the scenario direction at entry.
- `institutional_flow_oppose`: -20% factor when institutional concentration
  opposes the scenario direction at entry. Match and oppose cannot both fire for
  the same scenario pass.
- `block_trade_at_entry`: +15% factor when a block trade at entry aligns with
  the scenario direction. It can compose with concentration at the same zone.
- Day-type factors apply last, after distance, session drift, time, CVD, sweep,
  absorption, dislocation, institutional-flow, and confluence factors. Tooltip
  text shows the unclipped composition and the clipped final factor whenever
  the `[0.4, 1.6]` cap binds.

Day-type multiplier matrix:

- `trend_day_up`: +25% long continuation, -30% short continuation, -40%
  mean-reversion/fade.
- `trend_day_down`: +25% short continuation, -30% long continuation, -40%
  mean-reversion/fade.
- `normal_day`: +20% mean-reversion, +5% directional.
- `normal_variation_up`: +15% long continuation, -10% short continuation, +10%
  mean-reversion.
- `normal_variation_down`: +15% short continuation, -10% long continuation,
  +10% mean-reversion.
- `neutral_day_extreme`: -10% mean-reversion, -5% directional.
- `neutral_day_center`: +30% mean-reversion, -10% directional.
- `double_distribution_up`: +20% long continuation, -10% short continuation,
  +15% mean-reversion.
- `double_distribution_down`: +20% short continuation, -10% long continuation,
  +15% mean-reversion.

Every factor includes name, multiplier, rationale, optional trigger text, and a
structural flag for the dashboard tooltip.

If the bounded capture tail spans less than 55 minutes, dislocation confidence is
`low_tail_span`. The multiplier still fires but is degraded: +25% becomes +15%,
and +35% becomes +25%. The tooltip names the degradation and the tail span.

## Calibration Logs

`rithmic_dashboard.features.calibration_log` writes probability provenance for
future calibration:

- `data/live_analysis/probability_snapshots.jsonl`: every displayed scenario
  probability and full multiplier list.
- `data/live_analysis/probability_outcomes.jsonl`: completed target/stop
  outcomes when a scenario resolves.
- `data/live_analysis/day_type_outcomes.jsonl`: session-close day-type state,
  IB references, and scenario multiplier provenance.

These logs are heuristic provenance today. After enough completed outcomes
accumulate, a future calibration pass can compare displayed probability buckets
against realized outcomes.

## Active Posture

`rithmic_dashboard.features.posture_synthesis.synthesize_active_posture()`
emits a deterministic summary:

1. Day-type prefix when RTH classification is available.
2. Current price regime versus VWAP and sigma bands.
3. ACTIVE/WATCHING scenarios, or nearest dormant scenario.
4. Live CVD/velocity confirmation or contradiction when active capture data is
   available; otherwise falls back to last-60-minute artifact CVD.

The text is a scan aid only; it is not an automated trading instruction.

## Audit Trail

`rithmic_dashboard.audit_trail` persists only actionable events:
scenario transitions, HIGH/SUPER level touches, and HIGH/SUPER confluence
crosses, plus live sweep, absorption proxy, delta-dislocation, institutional
flow, day-type, IB-break, IB-extension, and CVD momentum-flip events. Data
warnings are displayed in the header panel, not the audit trail. Identical
consecutive entries inside five minutes are collapsed.
