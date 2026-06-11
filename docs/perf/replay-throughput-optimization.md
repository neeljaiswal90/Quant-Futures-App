# Replay throughput optimization

**Status:** orjson quick-win landed; incremental-parse rewrite scoped (not started).
**Context:** the scalp-model retrain pipeline replays the live detectors over
captured obs01/mbo to produce setup firings + forward-return labels. At current
throughput a full multi-session retrain is infeasible (one 56 MB RTH session
took 5h+; the 27-session corpus would take days). This documents the profile,
the root cause, and the path to a practical retrain.

## Profile (py-spy, 30 s @ 200 Hz on a live single-session replay)

| hotspot | self-time | file |
|---|---|---|
| JSON decoding (`json.loads`) | ~26% | stdlib json on every obs01/mbo line |
| MBO order tracker (`consume_matching_volume` + index build + object churn) | ~25% | `mbo_order_tracker.py` |
| sweep detector (per-step level scan) | ~8% | `sweep_detector.py` |

## Root cause — per-step quadratic re-read

`replay/runner.py:_compute_step` runs every **500 ms of market time**
(`STEP_NS = 500_000_000`). Each step calls
`live_signals.compute_live_signals(capture_path, tail_bytes=...)`, which
**re-reads and re-parses the data tail + MBO tail from scratch, rebuilds the
`_TradeIndex`, and re-reads its own growing detector-output files**.

- One RTH session ≈ 6.5 h ≈ **~46,800 steps**; globex ≈ **~165,600 steps**.
- Cost ≈ O(steps × tail_bytes) → roughly **quadratic in session length**.
- The 26% JSON cost is a *symptom*: the same lines are parsed once per step
  they fall inside the tail window, not once total.

## Tier 1 — orjson (LANDED)

Swapped the two hot per-line `json.loads` sites (`replay/sources.py`,
`mbo_order_tracker.py`) to orjson with a stdlib fallback (optional dependency;
`orjson.JSONDecodeError` subclasses `json.JSONDecodeError` so existing handlers
are safe). Measured **4.0× parse speedup** on real obs01 lines (421k → 1672k
lines/s). Expected end-to-end ≈ **1.24×** (26% bucket → ~6.5%). Byte-exact:
replay (6) + detector (49) tests green.

This does NOT make the full retrain feasible on its own — it shaves the symptom,
not the quadratic.

## Tier 2 — incremental tail parsing (THE UNLOCK, scoped, not started)

Make the replay parse each input line **once** and maintain detector state
across steps instead of re-reading tails. Target **3–10×** end-to-end.

### Approach
1. **Incremental tick/MBO reader** — parse only bytes appended since the last
   step (byte-bounded, torn-line safe). The dashboard already has an
   `IncrementalTailReader` pattern to mirror.
2. **Persist detector state across steps** — `compute_live_signals` currently
   reloads its own output files (`load_sweeps`, `load_absorption_proxy_events`,
   …) every step. Keep these in memory keyed by session, append-only.
3. **Reuse the `_TradeIndex`** — built per call today; build once and extend.

### Hard constraints (why this is careful work, not a quick edit)
- `compute_live_signals` + detectors are **shared with the live dashboard**.
  Any change must preserve live behavior.
- Detector outputs must stay **byte-identical** or the training setups/labels
  shift. Gate every change with a recorded-replay diff: replay a fixed session
  before/after and assert the `*_sweeps.jsonl`, `*_absorption_proxy.jsonl`,
  `setups.jsonl`, and forward-return labels are byte-equal.
- Step-boundary timestamps drive setup `ts_ns`; cadence must not change.

### Suggested sequence
1. Build a small recorded-replay golden harness (one short session → frozen
   detector-output hashes) as the regression gate.
2. Land the incremental reader behind the existing `compute_live_signals`
   surface, asserting golden-hash parity at each step.
3. Persist detector-output state in memory; drop the per-step file reloads.
4. Re-profile; if MBO `consume_matching_volume` is still dominant, optimize the
   index (slots, drop per-event lambdas).

### Fallback if Tier 2 is deferred
Run a **curated multi-regime subset** (~6 sessions: trend selloff 6/9–6/10,
quiet 5/31, balanced days) 4-parallel overnight — achieves regime diversity +
per-regime stratification without the full corpus. orjson alone makes this ~1.24×
faster; it's the pragmatic path until Tier 2 lands.
