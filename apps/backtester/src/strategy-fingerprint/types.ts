import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { UnixNs } from '../../../strategy_runtime/src/contracts/time.js';

// Future fingerprint readers must dispatch on this marker at read time; never
// assume v1 semantics for an unrecognized strategy fingerprint algorithm.
export const STRATEGY_FINGERPRINT_ALGORITHM =
  'qfa_strategy_fingerprint_sha256_v1' as const;

export interface StrategyFingerprintDecision {
  readonly sequence: number;
  readonly bar_id: string;
  readonly ts_ns: UnixNs;
  readonly strategy_id: StrategyId;
  readonly gate_state: string | null;
  readonly score: number | null;
  readonly candidate_present: boolean;
  readonly candidate_id: string | null;
  readonly reason_codes: readonly string[];
}

export interface StrategyFingerprint {
  readonly fingerprint_schema_version: 1;
  readonly algorithm: typeof STRATEGY_FINGERPRINT_ALGORITHM;
  readonly strategy_id: StrategyId;
  readonly decision_count: number;
  readonly decisions_sha256: string;
  readonly fingerprint_sha256: string;
}

export interface StrategyFingerprintSet {
  readonly fingerprint_set_schema_version: 1;
  readonly algorithm: typeof STRATEGY_FINGERPRINT_ALGORITHM;
  readonly fingerprints: readonly StrategyFingerprint[];
}
