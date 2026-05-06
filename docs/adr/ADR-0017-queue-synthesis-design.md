# ADR-0017: Queue Synthesis Design

## Status

Accepted.

## Context

QFA-105 introduces the deterministic queue-synthesis layer after DBN loading,
parquet caching, and bar building. The design intentionally starts with
contracts, validation, source metadata, capability gates, and deterministic
merge ordering before adding the full synthesis driver.

The layer feeds later backtester and fill-model work. It must therefore make
queue and passive-fill contracts replay-stable before any strategy-specific
order simulation or slippage behavior is added. QFA-102 exposes enough MBO
fields for reconstruction (`order_id`, `action`, `side`, `price`, `size`), but
does not expose explicit queue position or priority rank fields. That means
QFA-105 can define an `mbo_reconstruction` mode, not an `mbo_ground_truth`
mode.

## Decision

QFA-105 uses a deterministic synthesized queue model with these boundaries:

- Queue-state outputs are estimates, not exchange-certified ground truth.
- Passive fill estimates are emitted only for caller-supplied probes.
- Queue and fill quantities use `bigint` values.
- Fill probabilities use integer ppm values in `[0, 1_000_000]`, not floats.
- Unknown queue ahead is represented as `null`, not `0n`.
- Probe-before-evidence cases emit an unverified zero-fill placeholder instead
  of failing a valid warmup probe.
- Multi-source record ordering is deterministic by `ts_event`, schema priority,
  source index, and record index.
- Each source must be monotonic by `ts_event`; non-monotonic input fails closed.
- OHLCV-only and BBO-only inputs fail closed for queue synthesis.
- QFA-105 does not model slippage, stochastic latency, persistent strategy
  orders, cancel/replace behavior, live execution, or journal events.

The supported evidence modes are:

- `mbo_reconstruction`: strongest available reconstruction from MBO records.
- `mbp_proxy`: visible-depth proxy from MBP-1 or MBP-10 levels.
- `tbbo_trade_proxy`: touch/depletion proxy from TBBO plus trades.

## Consequences

Session 2a can land a stable contract surface without committing Session 2b to a
specific passive-fill formula. Session 2b can focus on the synthesis driver and
per-mode reconstruction logic while preserving the numeric, merge-order, and
probe-validation contracts locked here.

This design deliberately excludes live/paper execution behavior and journal
event types. Later backtester work may consume queue-synthesis outputs, but any
strategy-order lifecycle, cancel/replace behavior, stochastic latency, or
slippage model must be introduced by a separate decision.
