# Iceberg Detection Methodology

RA-059 detects iceberg-like refill behavior from the active MNQ bounded tails.
It is an inference layer, not direct hidden-size visibility.

## Data Sources

The detector combines two normalized siblings of the same probe capture:

- `MNQ_<session>.mbo.jsonl`: order lifecycle rows with `action`, `side`,
  `price`, `size`, and `order_id`.
- `MNQ_<session>.obs01.jsonl`: trade rows with price, quantity, timestamp, and
  `aggressor_side`.

The current normalized MBO feed commonly contains add/modify/cancel actions
(`A/M/C`) but not fill/trade actions (`F/T`). Because of that, RA-059 does not
treat every disappearing order as consumption. A disappearing MBO order is
counted only when a same-price OBS trade with the expected aggressor side occurs
inside the confirmation window.

## Consumption Confirmation

For each active MBO order:

1. `A` creates or replaces the tracked visible order.
2. `M` updates the visible price/size and last-seen timestamp.
3. `C/F/T` removes the order from the active map.
4. The removal becomes a consumed order only if an OBS trade matches:
   - Same tick price.
   - Expected aggressor side.
   - Timestamp within +/- 50 ms of the MBO removal event.

Side mapping is MNQ-specific:

- MBO `B` means bid-side refill. Expected OBS aggressor is `sell`, and the
  signal direction is `long`.
- MBO `A` means ask-side refill. Expected OBS aggressor is `buy`, and the
  signal direction is `short`.

The 50 ms tolerance is intentionally small but not nanosecond-strict; it allows
minor clock skew between normalized MBO and OBS streams. If future calibration
shows false positives or missed events, this is the first knob to tune.

Matched OBS volume is consumed from an internal index, so the same trade volume
cannot be reused to confirm multiple MBO removals beyond its available
quantity.

## Event Definition

An `iceberg_detected` event fires when the detector sees repeated
OBS-confirmed consumed-and-refilled orders at the same tick price and same side.
Default thresholds:

- `min_refills = 3`
- `refill_window_seconds = 30`
- `size_consistency_pct = 0.40`
- `min_total_consumed = 50` MNQ contracts
- `aggressor_side_consistent = true`
- `level_proximity_pts = 5`

The `min_total_consumed` default is calibrated for MNQ. Larger contracts or
different symbols should recalibrate rather than copy the MNQ threshold.

If the refill price is within 5 points of a displayed structural level, the
event attaches to that level. Otherwise it uses a synthetic iceberg level id
based on side and price.

## Probability Semantics

Scenario multipliers apply only when an iceberg event is inside the scenario
entry zone or within 5 points of the entry midpoint:

- `iceberg_at_entry x1.20`: iceberg direction aligns with the scenario.
- `iceberg_opposing_entry x0.75`: iceberg direction opposes the scenario.
- `iceberg_high_intensity_stack x1.30`: at least two same-direction iceberg
  events hit the entry zone inside 30 minutes. This replaces
  `iceberg_at_entry`; it does not stack with it.

The match/oppose factors are mutually exclusive. All iceberg factors compose
with the existing additive multiplier framework and the global `[0.4, 1.6]`
cap.

## Dashboard Semantics

Canonical events are written to:

```text
data/live_analysis/<date>_<session>_icebergs.jsonl
```

Rows map to the RA-050 family `iceberg`, use the ice badge in Recent Signals
and the Distance Grid, and can participate in same-zone stack banners with
other families such as absorption, sweep, dislocation, institutional flow, or
aggressor flow.

Orderflow Pulse shows active iceberg count, total OBS-confirmed consumed
quantity, dominant direction, and the latest event description.

## Limits

This detector does not prove hidden reserve quantity. It detects the footprint
that reserve-style behavior often leaves: visible size gets consumed, then a
similar visible order refills at the same price quickly and repeatedly.

False negatives can occur when:

- OBS aggressor side is missing or misclassified.
- MBO/OBS timestamps drift by more than the tolerance.
- A participant refills with visibly different sizes.
- The refill spans more than 30 seconds.

False positives can occur when:

- Multiple unrelated orders at the same price refill similarly.
- A trade bundle consumes many visible orders and timing makes them appear like
  a single participant.
- Future normalizer changes add true `F/T` actions but they are not yet
  separately reconciled.

RA-064 should investigate why normalized MBO currently lacks `F/T` action types.
If those actions can be restored, a future RA-059 v2 can simplify the OBS
confirmation bridge.
