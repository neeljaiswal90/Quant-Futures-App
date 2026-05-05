/**
 * QFA-115 BACKTEST_RUN_META event payload type.
 *
 * Embedded as the first event of every backtest run's journal so downstream
 * consumers (formatter, journal-query, replay parity checks) can reconstruct
 * full lineage from the journal alone.
 *
 * Shape note: the payload extends `RunSpec` (so all RunSpec fields are
 * present in the journal verbatim) and adds two envelope-adjacent fields:
 *   - `run_spec_hash`: the canonical hash of the RunSpec (anchors lineage).
 *   - `run_started_at_ns`: bigint nanosecond timestamp captured by the
 *     runner at run start. This is the ONLY bigint field anywhere in the
 *     payload, and it lives outside the RunSpec proper so RunSpec hashing
 *     remains bigint-free (Q-3.3).
 *
 * JournalEventEnvelope already owns `event_id`, `type`, `ts_ns`, `run_id`,
 * `session_id`, `schema_version`, `causation_id`, `correlation_id`, and an
 * optional `config` lineage ref. This payload does NOT duplicate those
 * envelope fields.
 *
 * Wiring this payload into the runtime event registry (event-types.ts,
 * payloads.ts, schema.ts, channels.ts, contracts/index.ts, formatter.ts) is
 * Session 2b's deliverable. Session 2a ships the payload type only.
 */

import type { RunSpec } from './run-spec.js';

/**
 * Payload of the `BACKTEST_RUN_META` runtime event. Self-contained lineage
 * for a backtest run; includes the entire RunSpec plus the run-spec hash and
 * the runner's start timestamp.
 */
export interface BacktestRunMetaPayload extends RunSpec {
  /**
   * Lower-case 64-character hex sha256 of the canonicalized RunSpec. Equal
   * to `computeRunSpecHash(<this payload's RunSpec fields>)`.
   */
  readonly run_spec_hash: string;
  /**
   * Nanosecond Unix-epoch timestamp captured by the runner at run start.
   * Envelope-adjacent: NOT part of RunSpec, NOT included in
   * `run_spec_hash`. The only bigint field in the payload.
   */
  readonly run_started_at_ns: bigint;
}
