# Price Spike + Dashboard Lag Review - 2026-06-01 Globex

## Summary

The decision-map price line spiked because the realtime backend was emitting
some raw MBO order-lifecycle prices as `price_tick` frames. The line is intended
to represent latest traded price only, bucketed client-side into a 1-second
display line.

The dashboard lag was mostly a symptom of the same bug: the fast-price poller
was reading the raw capture tail and treating every record with a `price` field
as trade-like. During active MBO flow this created extra bogus `price_tick`
frames, forcing chart updates and React store updates.

## Evidence

Live websocket sampling showed impossible price ticks relative to current BBO:

- `price=32400.00` while bid/ask were approximately `30417.00 / 30417.50`
- `price=30517.25` while bid/ask were approximately `30416.50 / 30417.50`
- Several additional ticks were 20-100+ points away from the quoted market.

Searching the raw capture for those `ts_ns` values showed they were MBO records,
not trades. Example:

```json
{
  "stream": "MBO",
  "payload_kind": "DepthByOrder",
  "action": "new",
  "side": "sell",
  "price": 32400.0,
  "size": 1
}
```

The backend bug was in `services/realtime_backend/price_ticks.py`: `_latest_trade`
accepted records with any top-level or payload `price` field, even when
`stream` was `MBO` or `L1_QUOTE`.

## Fixed

1. `_latest_trade` now accepts only explicit trade records:
   - `stream in {"LAST_TRADE", "TRADE"}`
   - or `type == "TRADE"`

2. Added a display safety guard:
   - if bid/ask context is available, reject a trade tick more than 5 points
     outside the current quote context.

3. Added tests proving:
   - raw MBO `DepthByOrder` prices are ignored even when they appear after a
     real trade in the raw capture tail.
   - trade-looking records far outside bid/ask context are rejected.

## Remaining Watch Item

The frontend still routes accepted `price_tick` and `depth` frames through the
React reducer for panel state. With valid trade-only ticks this should be much
lighter, but a future optimization should throttle React-facing price/depth
state while keeping chart drawing imperative.

Suggested follow-up if lag persists: move high-rate depth/price display state
to a small external store/ref and update React panels at 2-4 Hz, while the chart
continues to draw directly from refs.
