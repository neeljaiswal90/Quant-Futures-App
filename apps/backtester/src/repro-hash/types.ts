import type {
  EquityCurvePoint,
  TradeMetricsSummary,
  TradePnl,
} from '../equity-metrics/index.js';
import type { TradeLedger } from '../trade-ledger/index.js';

// Future chain readers must dispatch on this marker at read time; never assume
// v1 semantics for an unrecognized reproducibility manifest algorithm.
export const REPRO_HASH_CHAIN_ALGORITHM = 'qfa_repro_chain_sha256_v1' as const;

export type ReproHashChainAlgorithm = typeof REPRO_HASH_CHAIN_ALGORITHM;

export const REPRO_ARTIFACT_ORDER = [
  'journal_jsonl',
  'trade_ledger',
  'trade_pnl',
  'equity_curve',
  'metrics_summary',
] as const;

export type ReproArtifactName = (typeof REPRO_ARTIFACT_ORDER)[number];

export type StructuredReproArtifactName = Exclude<ReproArtifactName, 'journal_jsonl'>;

export type ReproArtifactEncoding = 'raw_utf8_bytes' | 'canonical_json_v1';

export interface ReproArtifactHash {
  readonly name: ReproArtifactName;
  readonly encoding: ReproArtifactEncoding;
  readonly sha256: string;
  readonly byte_length: number;
}

export interface ReproducibilityManifest {
  readonly manifest_schema_version: 1;
  readonly algorithm: ReproHashChainAlgorithm;
  readonly run_id: string;
  readonly run_spec_hash: string;
  readonly artifacts: readonly ReproArtifactHash[];
  readonly final_chain_hash: string;
}

export interface ReproducibilityManifestInput {
  readonly run_id: string;
  readonly run_spec_hash: string;
  readonly journal_jsonl: string | Uint8Array;
  readonly trade_ledger: TradeLedger;
  readonly trade_pnl: readonly TradePnl[];
  readonly equity_curve: readonly EquityCurvePoint[];
  readonly metrics_summary: TradeMetricsSummary;
}
