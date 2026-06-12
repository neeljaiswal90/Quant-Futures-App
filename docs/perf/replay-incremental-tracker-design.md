# Replay incremental MBO tracker — Phase 4 design (byte-exact)

**Status:** designed + de-risked, NOT implemented. Phase 2 (parse caches) shipped
in `8fdc1c1` (515s→254s, -51%, byte-exact). This doc is the implementation spec
for Phase 4, the remaining ~52% (`detect_icebergs` = 133s of the post-Phase-2 254s).

## The bottleneck

`compute_live_signals` runs every 500ms replay step. For icebergs it calls
`detect_icebergs(mbo_events=<20MB window>, trades=<window>, ...)`
(`live_signals.py:181`), which builds a **fresh `MboOrderTracker` every step**
(`iceberg_detector.py:63`) and re-`process()`es the entire window from an empty
book. Over a session that is O(steps × window) — the remaining quadratic. The
parse is already cached (Phase 2), so this 133s is pure book reconstruction +
trade-matching, not parsing.

## Target design — one persistent tracker, fed incrementally

Thread an optional stateful object from the runner down through
`compute_live_signals` → `detect_icebergs`. Prod keeps the fresh-per-call path
(state=None); replay supplies persistent state and feeds only NEW events per step.

State object (replay-owned, one per session):
- `tracker: MboOrderTracker` — persistent active book (`self.active`, indices).
- `trade_index: _TradeIndex` — persistent, **depleting** (see coupling below).
- `rolling_consumed: list[ConsumedOrder]` — consumptions still inside the window.
- `last_key: (ts_ns, sequence)` — high-water mark of processed events.

Per step, given the step's `mbo_events` (sorted asc) and `trades`:
1. `window_back = mbo_events[0].timestamp_ns` (oldest event in the 20MB tail).
2. `new = mbo_events[i:]` where `i` = first index with `(ts, seq) > last_key`
   (binary search; the window is sorted). Update `last_key`.
3. **Window-back eviction** on the book: drop active orders with
   `add_ts_ns < window_back`. (New method `MboOrderTracker.evict_before(ts)`.)
4. Process `new` on `tracker` (book updates + its existing 120s TTL evict),
   matching against the **persistent** `trade_index`; collect `newly_consumed`.
5. `rolling_consumed += newly_consumed`; then evict entries with
   `order.add_ts_ns < window_back`.
6. Return `_events_from_consumed(rolling_consumed, levels, config)` — identical
   shape to the fresh path, so the downstream append-dedupe (icebergs.jsonl) and
   `diff_signals` (signals.jsonl) are unchanged.

## Why it is byte-exact (inductive)

Claim: after step k, the persistent book == the book a fresh-per-window tracker
builds from empty over `window_k`.

- Base: step 0 processes `window_0` from empty on both. Equal.
- Step: assume equal after k-1. At step k the window slides forward;
  `window_back_k ≥ window_back_{k-1}`. Evicting active orders with
  `add_ts < window_back_k` turns the (inductively-equal) `window_{k-1}` book into
  exactly the orders added in `[window_back_k, now_{k-1}]`. Processing `new`
  (events in `(now_{k-1}, now_k]`) extends it to `[window_back_k, now_k]` — which
  is precisely the set a fresh build over `window_k` produces. TTL eviction is
  applied identically (per-event, by event ts) in both. ∎

Consumption detection matches because a removal consumes its order iff the ADD is
present, and the ADD is present iff `add_ts ≥ window_back_k` in both paths.
`rolling_consumed` evicts by the order's `add_ts` (not the consume ts) because the
fresh path re-detects a consumption every step **only while its ADD is still in
the window** — so the per-step returned set (which drives `diff`/signals.jsonl)
matches exactly.

## The three couplings that must all be persistent (or it diverges)

1. **Book** — obvious; the active orders.
2. **`rolling_consumed`** — the fresh path returns ALL window-consumed each step,
   not just new; dedupe keeps first-appearance. Must mirror with window-back evict.
3. **`_TradeIndex` depletion** — `consume_matching_volume` does
   `trade.quantity_remaining -= take` (`mbo_order_tracker.py:415`), so two orders
   can't double-count one trade. The fresh index depletes across ALL window orders
   in one pass; an incremental index over only `new` events would NOT see prior
   depletion and would over-match. So the trade index must be **persistent and
   depleting**, with old trades evicted (`ts < window_back` — they can't match new
   orders anyway via `tolerance_ns`, but must be pruned for memory/RA-052 <2GB).
   This one the QUIET gate catches, so it's self-validating.

## Validation — what each gate covers

- `golden_gate.py --check` (800 steps): book/consumed/trade-index incremental
  machinery, TTL-binding regime. File is 12.9MB, **never slides**.
- `golden_gate.py --check --steps 1600` (NEW slide baseline, this commit): MBO
  file ~26MB > 20MB tail, so the reader/parse-cache slide + the `last_key` suffix
  logic are exercised. But 2026-05-25 is QUIET: 20MB spans ~620s >> 120s TTL, so
  the TTL still binds first and `evict_before(window_back)` **never actually
  removes a non-TTL order**. The window-back path stays unexercised.
- **MISSING — busy-session fixture.** To exercise `evict_before` binding (where
  20MB < 120s, e.g. a slice of 2026-06-11 whose MBO is ~16MB/min), capture a
  third baseline on a busy session BEFORE implementing, then gate against it.
  Without this, the window-back eviction is correct-by-proof but unvalidated
  empirically, and its failure mode is **silent training-label corruption**.

## Implementation order (when picked up)

1. Build the busy-session golden fixture + baseline (prerequisite — do NOT skip).
2. `MboOrderTracker.evict_before(window_back_ts)` + make `_TradeIndex` support
   incremental `extend(new_trades)` + `evict_before(ts)`.
3. State object + optional `iceberg_state` param on `detect_icebergs` and
   `compute_live_signals` (default None = today's fresh path, prod untouched).
4. Runner owns the state, computes `window_back`/`new` per step.
5. Iterate to green on ALL THREE gates (800, 1600-slide, busy). Re-profile.

Expected win: detect_icebergs 133s → ~5s; full ~254s → ~120s on the 800-step
fixture, and a far larger multiple on full sessions (the quadratic is removed).

## UPDATE 2026-06-12 — built the foundation, found the trade-depletion wall

Implemented the pure-incremental approach (commit pending): `consume_events`
refactor, `evict_before((ts, seq))`, `_TradeIndex.extend/evict_before`, and
`RollingConsumeState`. A step-by-step equivalence test
(`tests/test_incremental_tracker.py`) vs the fresh path PASSES for the quiet
(TTL-binds), busy (window-back-binds), and full-batch regimes — the inductive
ORDER-BOOK proof holds, and the `(ts, seq)` window-back edge (NOT ts alone) is
required to split adds that share a tail timestamp.

BUT the test's adversarial tiny window exposed a wall the original proof missed:
**the trade-index depletion does not decompose incrementally.** `_TradeIndex`
depletes matched volume (`quantity_remaining -= take`) so competing same-price
consumptions don't double-count one trade. The fresh path REBUILDS the index
every step, so when a depleting consumption scrolls out of the window it
effectively "un-depletes" that trade for the remaining competitor. A persistent
depleting index cannot reproduce that without a re-computation cascade. Concrete
failure: two bids at one price, one sell trade of 22 lots → fresh gives (20, 2);
once the first consumption's window scrolls past, fresh re-gives the survivor 20,
incremental is stuck at 2. Alignment-dependent (needs the window-back to fall
between a competing group), so it passes on lucky windows and WOULD silently
corrupt labels on others. Marked `xfail(strict)`.

### The byte-exact fix: incremental book + re-match the coupled part each step

Split `_remove` into (a) BOOK removal + candidate capture (order side/price/size,
`add_ts/seq`, `consume_ts`, `at_queue_front`, `priority`, `visible_size` — all
book-derived, frozen at removal) and (b) the TRADE MATCH (index-derived qty +
`obs_confirmed`/source/inclusion). Keep the book persistent/incremental (the 115s
of `_add/_remove/_evict`), but each step REBUILD a fresh `_TradeIndex` from the
window trades and RE-RUN (b) over the in-window candidates in `consume_ts` order.
This reproduces the fresh per-step depletion exactly (only C/F/T events deplete,
matched in ts order against a fresh index) while skipping the book rebuild.
Profile says the match half is ~18s vs ~115s book ops, so the win survives:
detect_icebergs 133s → ~25s. Validate on tiny + busy + quiet equivalence AND the
golden gates (remove the xfail). This is the next concrete step.
