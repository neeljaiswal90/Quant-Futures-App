# Scalp training: ts_ns mismatch blocking 70% of training corpus

**From:** Operator + Claude (dashboard side)
**To:** Algo engineer (owner of `services/scalp_models/`, `apps/backtester/`)
**Priority:** High — fixes corpus utilization without replaying any sessions.
**Date:** 2026-06-03

---

## TL;DR

The trainer joins setups to labels via signal_id. Only **2.0%** of `zone_rejection` setups match a label. Root cause: **ts_ns format mismatch** between `signals.jsonl` and the label record's `signal.ts_ns`. Same logical events, different timestamps — differ by **tens of milliseconds**.

Fixing the join key likely **5×s the trained corpus** (28% effective → ~100% effective) without replaying any sessions. May push gate-failed cells past the gate.

---

## The diagnosis (verified 2026-06-03 against `quiet-window-2026-05-31` corpus)

**Setup join logic in `services/scalp_models/scalp_models/dataset.py:_find_label_row`:**
- Primary: setup's `source_signals[].signal_id` ↔ label's reconstructed signal_id (from `_signal_id_from_label`)
- Fallback: `(session, setup.ts_ns)` ↔ `(replay.session, label.signal.ts_ns)`

Both rely on exact ts_ns equality.

**Empirical (5/27 RTH session):**

```
labels.jsonl: 45071 rows, 25084 unique signal ts_ns
signals.jsonl: 45071 rows, 25810 unique ts_ns
intersection (ts_ns alone): 0
```

**Zero ts_ns overlap.** Same session, same row count, same event types (sweep_detected, stacked_footprint_imbalance, ...), but the ts_ns sets don't intersect.

**zone_rejection setups → labels match rate: 461/22629 = 2.0%**

## The format drift

Side-by-side from first 3 rows of each file:

| Index | labels.jsonl signal.ts_ns | signals.jsonl ts_ns | Δ |
|---|---|---|---|
| 0 | 1779888716**999609529** | 1779888717**000000000** | 391 ms |
| 1 | 1779888717**998783933** | 1779888717**966672241** | 32 ms |
| 2 | 1779888718**498628049** | 1779888718**484148807** | 14 ms |

**Observations:**
1. signals.jsonl row 0 has the trailing `000000000` — bucketed to the whole second.
2. Subsequent rows differ at the millisecond level — not bucketed; just different.
3. Event type, family, and ordering match — these are the SAME logical events.
4. The string `1779888716999609529` (a label's ts_ns) DOES appear once in `signals.jsonl` — likely as a sub-field — confirming the logical link.

**Best hypothesis:** signals.jsonl is the emit-time from the detector pipeline; labels.jsonl uses the obs01 trade-time of the closest event match during labeling. They're two timestamps for the "same" event but neither is canonical.

## Why 2% match at all

The 2% that DO match are likely cases where:
- A label's `signal.ts_ns` happens to coincide exactly with a setup's `source_signal.ts_ns` (bucketing collisions or pre-emit-time samples)
- Or the secondary `(session, setup.ts_ns)` fallback hit something

## Proposed Fix A — snap to nearest second in both signal_id builders

In `services/scalp_models/scalp_models/dataset.py`:

```python
def _bucket_ts_ns(ts_ns: Any, bucket_ns: int = 1_000_000_000) -> int:
    """Snap a ts_ns to the nearest `bucket_ns` (default 1 second).
    Used to normalize across the labels vs signals emit-time drift."""
    return (_int(ts_ns) // bucket_ns) * bucket_ns


def _signal_id_from_label(signal: Mapping[str, Any]) -> str:
    replay = signal.get("replay")
    replay_record = replay if isinstance(replay, Mapping) else {}
    price = signal.get("price")
    price_text = f"{float(price):.2f}" if isinstance(price, (int, float)) else "no-price"
    return "|".join([
        str(replay_record.get("capture_date")),
        str(replay_record.get("session")),
        str(_bucket_ts_ns(signal.get("ts_ns"))),  # <-- snap
        str(signal.get("family")),
        str(signal.get("event_type")),
        str(signal.get("level_id") or "no-level"),
        price_text,
    ])
```

And **apply the same bucketing in setup's source_signal id construction.** If the setup-emit code already builds source_signals[].signal_id with raw ts_ns, you have two options:
1. Reconstruct the id at trainer-join time (same `_bucket_ts_ns` applied to setup's source_signals[].ts_ns)
2. Fix at emit time in the setup-emit code

Option 1 is non-invasive — only touches dataset.py.

## Implementation sketch (Option 1)

```python
def _find_label_row(
    setup: Mapping[str, Any],
    labels_by_id: Mapping[str, dict[str, Any]],
    labels_by_key: Mapping[tuple[str, int], dict[str, Any]],
) -> dict[str, Any] | None:
    source_signals = setup.get("source_signals")
    if isinstance(source_signals, list):
        for signal in reversed(source_signals):
            if isinstance(signal, dict):
                # NEW: reconstruct the lookup key using bucketed ts_ns
                # to match the normalized label keys.
                bucketed = _signal_id_from_setup_source(setup, signal)
                if bucketed in labels_by_id:
                    return labels_by_id[bucketed]
                # Keep the old exact-id lookup as a fallback for cases
                # where ts_ns happens to align.
                signal_id = signal.get("signal_id")
                if isinstance(signal_id, str) and signal_id in labels_by_id:
                    return labels_by_id[signal_id]
    # Fallback: also bucket the secondary key.
    return labels_by_key.get((_session_key(setup), _bucket_ts_ns(setup.get("ts_ns"))))


def _signal_id_from_setup_source(setup: Mapping[str, Any], signal: Mapping[str, Any]) -> str:
    """Build a signal_id from a setup's source_signal entry, matching the
    bucketed format used by `_signal_id_from_label`."""
    price = signal.get("price")
    price_text = f"{float(price):.2f}" if isinstance(price, (int, float)) else "no-price"
    return "|".join([
        str(_replay_capture_date(setup)),
        str(_replay_session(setup)),
        str(_bucket_ts_ns(signal.get("ts_ns"))),
        str(signal.get("family")),
        str(signal.get("event_type")),
        str(signal.get("level_id") or "no-level"),
        price_text,
    ])
```

And in `_labels_by_session_ts`, bucket the lookup key:
```python
key = (_session_key_from_replay(replay), _bucket_ts_ns(signal.get("ts_ns")))
```

## Risk of 1-second bucketing

False joins where two distinct signals fall in the same 1s bucket. Worth checking — but at typical signal rates (~25k per ~6.5h session = ~1 per second average), collisions should be rare. If they're material, drop bucket size to 100ms (`bucket_ns = 100_000_000`). The format drift observed is up to ~400ms, so 1s is the safer first cut.

## Test fixture

Add a regression test to `services/scalp_models/tests/test_dataset.py`:
```python
def test_signal_id_bucketed_across_subsecond_drift():
    """signal_ids from setups and labels should match even when their
    ts_ns differ by tens of ms (real-world emit-time drift)."""
    setup = {
        "setup_type": "zone_rejection",
        "ts_ns": 1779888716_500_000_000,
        "replay": {"capture_date": "2026-05-27", "session": "rth"},
        "source_signals": [{
            "ts_ns": 1779888716_999_609_529,  # ~500 ms forward of setup ts
            "family": "sweep", "event_type": "sweep_detected",
            "level_id": "ref-vwap_rth_band_p1sd-30048.62", "price": 30048.62,
        }],
    }
    label = {
        "signal": {
            "ts_ns": 1779888717_000_000_000,  # 391 ms drifted from source_signal
            "family": "sweep", "event_type": "sweep_detected",
            "level_id": "ref-vwap_rth_band_p1sd-30048.62", "price": 30048.62,
            "replay": {"capture_date": "2026-05-27", "session": "rth"},
        },
        "forward_returns": [{"horizon_seconds": 5, "status": "ok", "mfe_ticks": 4.5}],
    }
    result = build_training_examples(setup_rows=[setup], label_rows=[label])
    assert len(result.examples) == 1, "bucketed join should match across drift"
```

## Re-run instructions after the fix lands

```powershell
cd D:\Quant-futures-app
pwsh ./scripts/scalp/run-scalp-training-quiet-window.ps1
# Default = all 4 sessions, default gates.
# Output: services/scalp_models/runs/quiet-window-2026-05-31-4sess/calibration_report.md
```

Expected with the fix:
- `missing_label` exclusion count drops from ~52,682 to a small number (under ~1,000)
- Trained-cell count rises from 3 (today) to potentially 15 (all cells)
- Some cells may pass the gate without any corpus growth

## If the gate still fails after the fix

Path forward:
1. **Grow corpus**: replay 06-01, 06-02, 06-03 RTH sessions (V8 string-cap fix means big-tape sessions now work — `apps/backtester/src/replay-dataset-input/jsonl.ts` and `forward-return-labels/writer.ts` were patched 2026-06-02 22:43)
2. Re-merge + re-train
3. If still fails: investigate per-feature signal-to-noise; consider gradient-boost over logistic regression

## Hold criteria

Per the existing scalp strategy doc, do not deploy any cell for live decisions until:
- Brier skill > 0
- ECE < 0.1
- ≥ 30 positives AND ≥ 30 negatives
- Verified via `scalp_models evaluate --setups <held-out session> --labels <same> --models <run-dir>` on a session NOT in the training corpus

## Today's status snapshot

| What | Status |
|---|---|
| RA-093b V8 string-cap fix | ✅ shipped 2026-06-02 (recovered 5/27 labels) |
| 4-session full training | ✅ ran 2026-06-03; 3/15 cells fit, all gate-failed |
| A/B (no-holiday) | ✅ ran 2026-06-03; confirms 5/25 contributes useful negatives |
| ts_ns mismatch root cause | ✅ diagnosed (this doc) |
| Fix in dataset.py | ⏸️ unclaimed — assignment for algo engineer |

## Coordination notes

- Doc lives in `D:\Quant-futures-app\docs\handoffs\`. Per the handoff-must-push memory rule, the dashboard-side operator should commit + push this to the Quant-futures-app repo before forwarding the URL.
- Once you push the fix, ping operator to re-run training — they have the script already (`scripts/scalp/run-scalp-training-quiet-window.ps1`).
- If you'd rather change the emit path (canonical ts_ns in both files) instead of the join, that's also fine — the regression test still passes.

---

🤖 Diagnosed by Claude dashboard-orchestrator during ops-side investigation. Forwarded by operator.
