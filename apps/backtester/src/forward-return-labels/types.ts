import type {
  NormalizedSignalDirection,
  ReplaySignalCandidateSeed,
  ReplaySignalRowJson,
} from '../replay-dataset-input/index.js';

export const FORWARD_RETURN_LABEL_SCHEMA_VERSION = 1 as const;
export const FORWARD_RETURN_HORIZONS_SECONDS = Object.freeze([1, 5, 15, 60, 300] as const);

export type ForwardReturnHorizonSeconds = (typeof FORWARD_RETURN_HORIZONS_SECONDS)[number];

export const FORWARD_RETURN_STATUSES = Object.freeze([
  'ok',
  'no_trades_in_horizon',
  'no_post_signal_trade',
  'neutral_direction',
  'tape_eof_before_horizon',
  'invalid_signal',
] as const);

export type ForwardReturnStatus = (typeof FORWARD_RETURN_STATUSES)[number];

export interface ForwardReturnHorizonLabel {
  readonly horizon_seconds: number;
  readonly status: ForwardReturnStatus;
  readonly direction: NormalizedSignalDirection;
  readonly entry_ts_ns: string | null;
  readonly entry_price: number | null;
  readonly exit_ts_ns: string | null;
  readonly exit_price: number | null;
  readonly realized_pts: number | null;
  readonly realized_ticks: number | null;
  readonly mfe_pts: number | null;
  readonly mfe_ticks: number | null;
  readonly mae_pts: number | null;
  readonly mae_ticks: number | null;
  readonly max_favorable_price: number | null;
  readonly max_adverse_price: number | null;
  readonly trade_count: number;
}

export interface LabeledReplaySignalRow {
  readonly label_schema_version: 1;
  readonly signal: ReplaySignalRowJson;
  readonly candidate_seed: Omit<ReplaySignalCandidateSeed, 'ts_ns'> & {
    readonly ts_ns: string;
  };
  readonly forward_returns: readonly ForwardReturnHorizonLabel[];
}

export interface ForwardReturnLabelOptions {
  readonly tickSize?: number;
  readonly horizonsSeconds?: readonly number[];
}

export interface ForwardReturnLabelManifest {
  readonly manifest_schema_version: 1;
  readonly label_schema_version: 1;
  readonly dataset_path: string;
  readonly trade_tape_path: string;
  readonly dataset_sha256: string;
  readonly trade_tape_sha256: string;
  readonly label_jsonl_sha256: string;
  readonly row_count: number;
  readonly horizons_seconds: readonly number[];
  readonly tick_size: number;
  readonly generated_by: 'ra091_forward_return_labels_v1';
}

