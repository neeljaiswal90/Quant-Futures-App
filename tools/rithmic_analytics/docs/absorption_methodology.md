# Absorption methodology (RA-015)

Operational reference for [`rithmic_analytics.features.absorption`](../rithmic_analytics/features/absorption.py).
This document is the source of truth for what "absorption" means in this
project: the score formula, the hard gates, the parameters, and the calibration
tied to the synthetic fixture set in [`tests/test_absorption.py`](../tests/test_absorption.py).

## What is absorption?

A bar is *absorbed* when a slug of one-sided aggression trades against the
available resting size at the dominant price **without breaking that price
level**. The defining pattern is institutional refill: the offer (or bid) gets
eaten, replenished, eaten again, and price holds. Distinguishing this from a
breakout is the entire point of the detector — high one-sided volume at a tight
range is necessary but not sufficient; it has to *fail to push through*.

## The four factors

Each factor is computed per bar, normalized to `[0, 1]`, then combined as a
weighted sum:

```
score = 0.30 · volume
      + 0.25 · range
      + 0.20 · onesidedness
      + 0.25 · displacement
```

| Factor | Formula | Captures |
|---|---|---|
| `volume` | `min(bar_volume / session_avg, cap) / cap` (default cap = 5×) | The bar had real volume. A quiet bar can't absorb anything. |
| `range` | `max(0, 1 - range_ticks / max_range_ticks)` (default max = 4 ticks) | Price didn't move much despite the volume. |
| `onesidedness` | `\|net_delta\| / total_volume` ∈ `[0, 1]` | The volume was directional — one side dominated. |
| `displacement` | `min(bar_volume / pre_bin_resting_size, cap) / cap` (default cap = 5×) | The bar traded more than was visibly resting; the resting size had to refill. |

**Independence note.** The four factors are not fully independent. `range` and
`displacement` are the *defining* signals (50% combined weight). `volume` and
`onesidedness` are *corroborating* (50% combined weight). The synthetic fixture's
expected score of ~0.94 calibrates this formula; production tuning happens
through the `AbsorptionConfig` weights kwarg without re-architecture.

## The four hard gates

An event is **not emitted** unless all four pre-conditions clear:

1. **Range gate** — `range_ticks ≤ max_range_ticks` (default 4 ticks). Wider
   means it's a breakout, not absorption. This is what catches Tier 5
   (anti-test).
2. **No-break gate** — `bar_high ≤ pre_bin_offer + grace` (for `buy_absorbed`)
   or `bar_low ≥ pre_bin_bid - grace` (for `sell_absorbed`). Grace defaults to
   1 tick (contract-aware via `ContractSpec.tick_size`). A bar that broke past
   the offer is not absorption regardless of how heavy it was.
3. **One-sidedness gate** — `|net_delta| / volume ≥ min_onesidedness` (default
   0.6). Balanced delta isn't absorption; it's just normal two-way flow.
4. **Displacement gate** — `displacement_factor ≥ min_displacement` (default
   0.5, i.e. bar volume ≥ 2.5× resting size). The presence of resting size
   has to be meaningfully overwhelmed. If MBP1 is stale (no snapshot within
   the lookback window), `displacement_factor = 0` and this gate rejects.

After the gates pass, the score is computed and the event is emitted only if
`score ≥ min_emit_score` (default 0.5).

## The synthetic fixture set

Five tiers, all built programmatically in
[`tests/test_absorption.py`](../tests/test_absorption.py):

| Tier | Builder | What it tests |
|---|---|---|
| 1 | `_build_tier1_primary_clean` | Textbook absorption (no next-bar). 1 event, `score > 0.7`, `confirmed=False`. |
| 2 | `_build_tier2_confirmation_holds` | Tier 1 + next-bar stays at/below grace. `confirmed=True`. |
| 3 | `_build_tier3_confirmation_breaks` | Tier 1 + next-bar breaks above grace. `confirmed=False`. |
| 4 | (in-test, score-formula directly) | Score ordering across 0.5/0.6/0.8/0.95 + weighting robustness. |
| 5 | `_build_tier5_breakout` | Wide-range high-volume bar (range = 20 ticks). **MUST NOT** be flagged. |

Tier 1's volumes / ratios are calibrated to produce score ≈ 0.94:

```
session_avg = (10 baseline bars × 50 contracts + 1 abs bar × 500) / 11 ≈ 91
volume_factor      = min(500 / 91, 5) / 5 = 1.00
range_factor       = max(0, 1 - 1 / 4)    = 0.75
onesidedness       = 500 / 500            = 1.00
displacement       = min(500 / 100, 5) / 5= 1.00
score              = 0.3·1.0 + 0.25·0.75 + 0.20·1.0 + 0.25·1.0 = 0.9375
```

## Tunable parameters

Every threshold and weight lives in `AbsorptionConfig`. Default values are
calibrated against the synthetic fixtures. Production tuning happens via:

```python
custom = AbsorptionConfig(
    min_emit_score=0.6,        # narrow the funnel
    max_range_ticks=6,         # widen the range tolerance
    no_break_grace_ticks=2,    # tolerate two-tick pokes
)
events = compute_absorption_events(trades, mbp1, MNQ, config=custom)
```

Weights MUST sum to 1.0 — enforced at construction time via `__post_init__`.

## Two-pass confirmation

`compute_absorption_events` always returns events with `confirmed=False`. Call
`apply_next_bar_confirmation(events, trades, contract)` to flip the flag based
on next-bar behavior:

- `buy_absorbed` → `confirmed=True` iff `next_bar_high ≤ dominant_price + grace`
- `sell_absorbed` → `confirmed=True` iff `next_bar_low ≥ dominant_price - grace`
- No next-bar data → keep `confirmed=False`

This separation matters because the immediate score is the actionable signal;
confirmation is the after-the-fact validator. Operationally, an unconfirmed
absorption is still a candidate — confirmation is "this held; trust it more".

## Conviction-upgrade helper

`suggest_conviction_upgrade(event, zones)` returns `"HIGH"` when the event's
`dominant_price` overlaps an HVN-sourced zone whose current conviction is
`LOW` or `MED`. Use it in the daily report (RA-022) to flag levels where
absorption fired at structural HVN — a strong upgrade signal.

## Known limitations vs Bookmap

This is ~80% functional parity for absorption. The Bookmap-proprietary signals
we don't reproduce:

- **Hidden iceberg detection** — Bookmap infers icebergs from trade flow
  exceeding visible size by extreme ratios. Our `displacement_factor` captures
  the same intuition but doesn't sustain across multiple bars.
- **Queue-position decay** — Bookmap tracks individual order flicker. We use
  MBP1 aggregate size; finer-grained MBO analysis is future work (RA-017).

## Deferred validations

Real-data annotated cases gate is documented in
[`docs/future_work.md`](./future_work.md) — once Neel populates
`docs/known_absorption_cases.md` with a confirmed real-fixture absorption
event, that becomes a second canonical test alongside the synthetic Tier 1.
