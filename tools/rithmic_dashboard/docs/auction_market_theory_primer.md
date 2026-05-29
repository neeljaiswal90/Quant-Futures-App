# Auction Market Theory Day-Type Primer

RA-051 uses auction market theory as a structural conditioning layer for MNQ
RTH. It does not replace live signals. It tells the dashboard how to weight the
same sweep, absorption, dislocation, or institutional-flow event after the
initial balance reveals the character of the day.

## Initial Balance

The initial balance, or IB, is the first 60 minutes of RTH. For MNQ this is
06:30-07:30 PT. The dashboard waits until 08:00 PT before classifying because it
uses the IB plus a 30-minute confirmation window.

The classifier rechecks every 15 minutes after the first classification. It
emits `day_type_revised` only when the day type changes.

Globex sessions stay `pending`; there is no RTH initial balance yet.

## Classification Priority

Classification is exclusive. When multiple rules could match, the classifier
uses this priority:

1. `trend_day_up`
2. `trend_day_down`
3. `double_distribution_up`
4. `double_distribution_down`
5. `neutral_day_extreme`
6. `neutral_day_center`
7. `normal_variation_up`
8. `normal_variation_down`
9. `normal_day`
10. `pending`

## Day Types

| Type | Rule | Trader read |
|---|---|---|
| `trend_day_up` | RTH open is within 10 points of the session low, and price extends at least `1.5x` IB range above IB high. | Continuation structure dominates; fading strength is penalized. |
| `trend_day_down` | RTH open is within 10 points of the session high, and price extends at least `1.5x` IB range below IB low. | Downside continuation structure dominates; fading weakness is penalized. |
| `double_distribution_up` | Post-IB value separates into a new upper distribution. | Market accepted higher value after an initial auction; continuation is favored, but pullback longs can also matter. |
| `double_distribution_down` | Post-IB value separates into a new lower distribution. | Market accepted lower value after an initial auction. |
| `neutral_day_extreme` | Price breaks both sides of IB and trades near a session extreme. | Two-sided auction with late extreme acceptance; directional conviction is mixed. |
| `neutral_day_center` | Price breaks both sides of IB and returns near the IB midpoint. | Two-sided auction resolving toward balance; mean reversion gets priority. |
| `normal_variation_up` | Price extends `0.5x` to less than `1.5x` IB range above IB high without a lower IB break. | Upward extension without full trend-day proof. |
| `normal_variation_down` | Price extends `0.5x` to less than `1.5x` IB range below IB low without an upper IB break. | Downward extension without full trend-day proof. |
| `normal_day` | Price stays inside IB or extends less than `0.5x` IB range on both sides. | Balance day; fades and magnets generally deserve more respect. |
| `pending` | Before 08:00 PT, outside RTH, partial-session override is active, or RTH capture data is missing. | No day-type multiplier applies. |

## Double-Distribution Proxy

Classical double distribution requires recognizing two separated value areas.
The dashboard uses a conservative price-volume proxy:

- Only post-IB trades are considered.
- Trades are grouped into 5-point price buckets.
- A value mode must contain at least 20% of post-IB volume.
- Two modes must be separated by at least 30 points.
- `medium` confidence is the default when the rule passes.
- `high` confidence is reserved for clear separation: mode gap at least `2.0x`
  the IB range.

Known caveat: this is a volume-mode approximation, not a full TPO profile
classification. It is intentionally conservative so a marginal two-mode shape
does not over-weight the probability stack.

## Partial-Session Overrides

Half days and holiday sessions can prevent a valid day-type read. Use:

`D:\Quant-futures-app\tools\rithmic_dashboard\data\live_analysis\session_overrides.json`

Schema:

```json
{
  "YYYY-MM-DD_session": {
    "partial_session": true,
    "reason": "Human-readable reason"
  }
}
```

Example for Memorial Day 2026:

```json
{
  "2026-05-25_rth": {
    "partial_session": true,
    "reason": "Memorial Day holiday half-session"
  }
}
```

When this override is active, the classifier emits
`day_type_skipped_partial_session`, keeps the day type pending/skipped, and
applies no day-type multiplier.

If neither `data/captures/<date>/MNQ_rth.obs01.jsonl` nor
`data/captures/<date>/MNQ_rth.jsonl` exists at classification time, the
classifier emits `day_type_skipped_no_capture_data` and applies no day-type
multiplier.

## Multiplier Matrix

Day-type factors apply last, after distance, session drift, time, CVD, sweep,
absorption, dislocation, institutional flow, and confluence factors. The final
factor is clipped to `[0.4, 1.6]`, but the tooltip keeps the unclipped
contributions visible.

| Day type | Long continuation | Short continuation | Mean reversion / fade |
|---|---:|---:|---:|
| `trend_day_up` | `x1.25` | `x0.70` | `x0.60` |
| `trend_day_down` | `x0.70` | `x1.25` | `x0.60` |
| `normal_day` | `x1.05` | `x1.05` | `x1.20` |
| `normal_variation_up` | `x1.15` | `x0.90` | `x1.10` |
| `normal_variation_down` | `x0.90` | `x1.15` | `x1.10` |
| `neutral_day_extreme` | `x0.95` | `x0.95` | `x0.90` |
| `neutral_day_center` | `x0.90` | `x0.90` | `x1.30` |
| `double_distribution_up` | `x1.20` | `x0.90` | `x1.15` |
| `double_distribution_down` | `x0.90` | `x1.20` | `x1.15` |
| `pending` | `x1.00` | `x1.00` | `x1.00` |

See `docs/feature_reference.md` for the implementation-level probability
adjuster details.

## IB Scenarios

After classification, the dashboard adds two auction-theory scenarios:

- `IB-Long`: break and acceptance above IB high, with `0.5x`, `1.0x`, and
  `1.5x` IB range extension targets.
- `IB-Short`: break and acceptance below IB low, with matching downside
  extension targets.

Both scenarios use the same lifecycle as the existing dashboard scenarios and
then receive the same live-signal and day-type probability conditioning.

## Reference

The terminology follows J. Peter Steidlmayer's market profile framing: the IB
describes the first auction, and the day type describes how later auction
activity accepts, rejects, or extends beyond that initial range. RA-051 encodes
those definitions as transparent heuristics so the dashboard can explain every
probability adjustment instead of treating all sessions as structurally equal.
