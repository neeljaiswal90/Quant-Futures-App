# RA-064 — MBO F/T gap investigation

## TL;DR

F/T action absence is structural at the Rithmic API layer — the OrderBook protobuf only carries `update_type ∈ {1,2,3}` (new/change/delete), so the probe cannot emit F/T even though the analytics normalizer and dashboard consumer both accept those codes as defensive passthroughs. The `{C, F, T}` branches in `MboOrderTracker` are correct cross-vendor futureproofing and require no change. The real find is that `depth_order_priority` is exposed at 100% population by Rithmic but dropped at the analytics normalizer; threading it through unlocks an independent iceberg-confirmation channel (queue-position consumption + priority-jump refill) — filed as RA-065 (priority through-flow) and RA-066 (`match_tolerance_ms` calibration).

## Root cause: F/T absence

The Rithmic OrderBook protobuf carries `update_type ∈ {1, 2, 3}` only — a closed three-value enum mapped at `D:\Quant-futures-app\scripts\infra\capture-rithmic-probe.py:1083-1086` via `{1: "new", 2: "change", 3: "delete"}`. There is no fill/trade code in the wire format, so the probe cannot emit F/T regardless of normalization downstream.

The analytics normalizer's `_MBO_ACTION_MAP` at `D:\Quant-futures-app\tools\rithmic_analytics\rithmic_analytics\ops\normalize_probe.py:455-465` maps `new→A`, `change→M`, `delete→C`, and additionally carries `F→F`, `T→T`, `A→A`, `M→M`, `C→C` as forward-compatible passthroughs. These passthroughs never fire on Rithmic input because the probe never produces F or T tokens.

The dashboard consumer's `_action()` helper at `D:\Quant-futures-app\tools\rithmic_dashboard\rithmic_dashboard\features\mbo_order_tracker.py:292-296` accepts the literal set `{A, M, C, F, T}` on `MboOrderEvent.action`. In production, the F and T branches are dead but correct — they cover a future Rithmic protobuf revision or a databento corpus replay.

Two-session empirical sample confirms the structural absence:
- RTH `D:\Quant-futures-app\tools\rithmic_analytics\data\captures\2026-05-28\MNQ_rth.jsonl` — 200,000 sampled, action distribution `new=89,807 change=20,631 delete=89,562`, zero F or T tokens.
- Globex `data\captures\2026-05-29\MNQ_globex.jsonl` — 200,000 sampled, action distribution `new=89,820 change=21,692 delete=88,488`, zero F or T tokens.

Normalized output (`MNQ_rth.mbo.jsonl`, 100,000 records sampled) carries `A=44,484 M=11,054 C=44,462`, zero F or T — consistent with the upstream protobuf shape.

## The actual missed signal: priority

Rithmic exposes `depth_order_priority` (the FIFO queue position) on every MBO order at 100% population on the wire. Four downstream layers drop it before it reaches the iceberg detector:

1. **Probe writes priority correctly**: `D:\Quant-futures-app\scripts\infra\capture-rithmic-probe.py:1093-1094` reads both `exchange_order_id` and `depth_order_priority`; lines 1102-1104 write the latter as `priority` on the normalized record.
2. **Normalizer drops priority**: `D:\Quant-futures-app\tools\rithmic_analytics\rithmic_analytics\ops\normalize_probe.py:580-589` constructs an 8-key dict literal (`ts_event_ns, ts_recv_ns, sequence, action, side, price, size, order_id`) and never reads `order.get("priority")` or `rec.get("priority")`. The hoisted-fields fallback at lines 540-547 also omits priority. The incremental path at `D:\Quant-futures-app\tools\rithmic_analytics\rithmic_analytics\cli\normalize_probe_incremental.py:462-480` imports and calls `parity_mbo_record_to_mbo_dicts` (line 27, invoked at line 463) and inherits the same drop — there is one transform function, so one fix repairs both paths.
3. **`MboOrderEvent` has no priority field**: `D:\Quant-futures-app\tools\rithmic_dashboard\rithmic_dashboard\models.py:378-389` is a frozen dataclass with exactly 8 fields (`timestamp_ns, recv_ts_ns, sequence, action, side, price, size, order_id`) and no `priority`.
4. **`_TrackedOrder` has no priority field**: `D:\Quant-futures-app\tools\rithmic_dashboard\rithmic_dashboard\features\mbo_order_tracker.py:44-51` (slots=True, mutable) carries `order_id, side, price, size, add_ts_ns, last_ts_ns` — no `priority`.

Empirical priority population: RTH 100.0% (200,000 sampled), Globex 100.0% (200,000 sampled).

## Why priority unblocks the v2 iceberg work

Threading priority end-to-end gives the detector two independent confirmation paths that do not require OBS-trade alignment:

1. **Queue-position consumption test** — an order observed at queue-position-1 on its side at delete time is almost certainly a FIFO fill. High-priority orders that delete from the back of the queue are likely cancels, not consumption.

2. **Refill-by-priority-jump** — when a `new` order appears at the same price within `refill_window_seconds` of a `delete` and its priority value is non-contiguous from the prior queue tail, this is the canonical iceberg-refresh signature (a child slice surfacing behind any orders that joined the back during the gap).

The current RA-059 mechanism (OBS-trade-tail correlation inside `match_tolerance_ms`) becomes a third corroborator instead of the single load-bearing signal.

## Empirical evidence

### Per-session populations

| Session | Sampled | order_id % | priority % | Source path |
|---|---|---|---|---|
| RTH | 200,000 | 100.0% | 100.0% | data/captures/2026-05-28/MNQ_rth.jsonl |
| Globex | 200,000 | 100.0% | 100.0% | data/captures/2026-05-29/MNQ_globex.jsonl |

### Action distribution

| Session | new | change | delete |
|---|---|---|---|
| RTH | 89,807 | 20,631 | 89,562 |
| Globex | 89,820 | 21,692 | 88,488 |

Two-session evidence: zero F or T tokens in either raw or normalized output.

### Top-of-book churn signature (RTH)

| Price | Full-lifecycle orders |
|---|---|
| 30076.00 | 1,162 |
| 30080.25 | 1,162 |
| 30080.00 | 1,138 |
| 30075.75 | 1,084 |
| 30075.50 | 1,069 |

Of 92,047 unique order IDs sampled, 87,562 (95.1%) have both a `new` and a `delete` event observed within the window. The iceberg fingerprint (1,000+ full-lifecycle orders concentrated at the inside) is visible in raw data with no detector running.

## Code-path trace

- Probe protobuf decode: `D:\Quant-futures-app\scripts\infra\capture-rithmic-probe.py:1067-1113` (`normalize_mbo_payload`).
- Probe `update_type` enum map: `D:\Quant-futures-app\scripts\infra\capture-rithmic-probe.py:1083-1086`.
- Probe priority extraction: `D:\Quant-futures-app\scripts\infra\capture-rithmic-probe.py:1093-1094`, written at lines 1102-1104.
- Normalizer action map: `D:\Quant-futures-app\tools\rithmic_analytics\rithmic_analytics\ops\normalize_probe.py:455-465`.
- Normalizer parity transform: `D:\Quant-futures-app\tools\rithmic_analytics\rithmic_analytics\ops\normalize_probe.py:490-593` (`parity_mbo_record_to_mbo_dicts`); drop site at lines 580-589.
- Incremental normalize path: `D:\Quant-futures-app\tools\rithmic_analytics\rithmic_analytics\cli\normalize_probe_incremental.py:462-480` (`_route_record` MBO branch).
- Consumer `MboOrderEvent` model: `D:\Quant-futures-app\tools\rithmic_dashboard\rithmic_dashboard\models.py:378-389`.
- Consumer order tracker: `D:\Quant-futures-app\tools\rithmic_dashboard\rithmic_dashboard\features\mbo_order_tracker.py:30-41` (`ConsumedOrder`), lines 44-51 (`_TrackedOrder`), lines 292-296 (`_action` helper).
- Detector entry: `D:\Quant-futures-app\tools\rithmic_dashboard\rithmic_dashboard\features\iceberg_detector.py:40-55` (`detect_icebergs`).
- Dashboard wiring: `D:\Quant-futures-app\tools\rithmic_dashboard\rithmic_dashboard\features\live_signals.py:175-192`.

## Recommendations

1. **F/T gap**: no action. The defensive `{C, F, T}` passthroughs in the normalizer action map and the consumer `_action()` helper are correct cross-vendor futureproofing.
2. **Priority drop**: file RA-065 (P1, 4-6h) — thread priority through `parity_mbo_record_to_mbo_dicts` → `MboOrderEvent` → `_TrackedOrder` → `MboOrderTracker`, then add the queue-position-1 consumption test and the priority-jump refill detection.
3. **OBS-trade tolerance**: file RA-066 (P2, 2h) — walk-forward calibrate `match_tolerance_ms` across `[5, 10, 25, 50, 100, 150, 250]ms` on the 96-session databento corpus. May become diagnostic-only after RA-065 ships.

## Operational notes

Pre-RA-065 normalized `.mbo.jsonl` siblings lack `priority`. When RA-065 ships, the cached-sibling invalidation pattern from RA-035 / RA-041 applies: delete `<date>/MNQ_<session>.obs01.jsonl` (or the `.mbo.jsonl` sibling) and the next normalize refresh regenerates the file with priority populated.

No probe-config coordination required — the fix is entirely downstream of the probe layer; the probe already emits priority correctly.
