# SIM-02 - Queue-Aware Simulated Fill Model

Status: implemented

## Scope

SIM-02 extends the simulation-only execution adapter with queue-aware post-only limit
fills. It consumes the provider-internal MBO sub-scope accepted by ADR-0002 and
INFRA-01F, plus DATA-02-MBO queue estimates and DATA-04 microstructure context.

This ticket does not add live execution, broker order routing, sockets, SIM-03
calibration, ML/research dataset generation, or REL gate advancement.

## Version

`SIMULATED_EXECUTION_VERSION = simulated_execution_v2`

The adapter still supports SIM-01 order types:

- `market`
- `limit`
- `stop_market`

SIM-02 adds:

- `limit_post_only`

## Queue-Aware Post-Only Fills

`limit_post_only` orders are rejected if they would cross the current BBO. Resting
post-only orders use provider-internal queue estimates:

- `queue_position_estimate`
- `queue_ahead_size_estimate`
- `queue_ahead_order_count_estimate`
- `expected_trade_through_size`
- `recent_ofi_rate`

The model fills only when expected trade-through volume reaches the queue ahead of the
order. If volume reaches part of the order, the result is `partially_filled`; otherwise
the order remains accepted for day/GTC time-in-force or is cancelled for IOC.

Queue-aware fills are tagged:

- `fill_model = queue_aware_limit_post_only`
- `input_tier = subscope` when DATA-02-MBO queue estimates are consumed
- `calibration_status = placeholder_pending_sim03`

Queue position remains an estimate within one provider feed. It is not a provider-neutral
fact and must not be used as cross-feed truth.

## Marketable Slippage

Market, marketable limit, and triggered stop-market orders continue to fill against BBO.
SIM-02 adds an injected deterministic RNG for adverse-tick sampling. The default extra
adverse-tick probability is `0`, preserving SIM-01 behavior until SIM-03 calibrates the
distribution.

The injected RNG is deterministic and caller-controlled. The execution layer does not use
wall-clock time, `Math.random`, locale formatting, sockets, or external services.

## Event Payload

`SIM_FILL` payloads may include SIM-02 diagnostics:

- `execution_model_version`
- `fill_model`
- `input_tier`
- `fill_probability`
- `time_to_fill_estimate_ms`
- `queue_position_estimate`
- `queue_ahead_size_estimate`
- `queue_ahead_order_count_estimate`
- `queue_consumed_size`
- `partial_fill_reason`
- `adverse_tick_draw`
- `adverse_ticks`
- `calibration_status`

These fields are model diagnostics. Downstream consumers should respect `input_tier` and
must not treat `queue_position_estimate` as `queue_position_as_fact`.

## SIM-03 Carry-Forward

SIM-02 ships placeholder queue-drain and adverse-tick constants. SIM-03 calibrates:

- per-bucket fill-probability curves;
- adverse-tick distributions;
- queue-position residuals;
- no-fill and partial-fill behavior.

Until SIM-03 lands, queue-aware fills are suitable for deterministic simulation plumbing
and provider-internal replay, not final calibrated execution-quality claims.
