import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { canonicalizeReproJson, sha256Utf8 } from '../repro-hash/index.js';
import {
  loadReplayDatasetInput,
  type ReplaySignalRow,
  type ReplayTradeTick,
} from '../replay-dataset-input/index.js';
import { labelReplaySignalRow } from './labeler.js';
import {
  FORWARD_RETURN_HORIZONS_SECONDS,
  type ForwardReturnLabelManifest,
  type ForwardReturnLabelOptions,
  type LabeledReplaySignalRow,
} from './types.js';

export interface WriteForwardReturnLabelsOptions extends ForwardReturnLabelOptions {
  readonly datasetPath: string;
  readonly tradeTapePath?: string;
  readonly outputJsonlPath: string;
  readonly manifestPath?: string;
}

export interface WriteForwardReturnLabelsResult {
  readonly rows: readonly LabeledReplaySignalRow[];
  readonly jsonl: string;
  readonly manifest: ForwardReturnLabelManifest;
}

export function buildForwardReturnLabelJsonl(
  rows: readonly ReplaySignalRow[],
  trades: readonly ReplayTradeTick[],
  options: ForwardReturnLabelOptions = {},
): string {
  const labeledRows = rows.map((row) => labelReplaySignalRow(row, trades, options));
  return labeledRows.map((row) => canonicalizeReproJson(row)).join('\n') + (labeledRows.length > 0 ? '\n' : '');
}

export function writeForwardReturnLabels(
  options: WriteForwardReturnLabelsOptions,
): WriteForwardReturnLabelsResult {
  const input = loadReplayDatasetInput({
    datasetPath: options.datasetPath,
    tradeTapePath: options.tradeTapePath,
  });
  const rows = input.rows.map((row) => labelReplaySignalRow(row, input.trade_tape, options));
  const jsonl = rows.map((row) => canonicalizeReproJson(row)).join('\n') + (rows.length > 0 ? '\n' : '');
  mkdirSync(dirname(options.outputJsonlPath), { recursive: true });
  writeFileSync(options.outputJsonlPath, jsonl, 'utf8');

  const manifest = Object.freeze({
    manifest_schema_version: 1,
    label_schema_version: 1,
    dataset_path: options.datasetPath,
    trade_tape_path: input.trade_tape_path,
    dataset_sha256: sha256Utf8(readFileSync(options.datasetPath, 'utf8')),
    trade_tape_sha256: sha256Utf8(readFileSync(input.trade_tape_path, 'utf8')),
    label_jsonl_sha256: sha256Utf8(jsonl),
    row_count: rows.length,
    horizons_seconds: Object.freeze([...(options.horizonsSeconds ?? FORWARD_RETURN_HORIZONS_SECONDS)]),
    tick_size: options.tickSize ?? 0.25,
    generated_by: 'ra091_forward_return_labels_v1',
  } satisfies ForwardReturnLabelManifest);

  if (options.manifestPath !== undefined) {
    mkdirSync(dirname(options.manifestPath), { recursive: true });
    writeFileSync(options.manifestPath, `${canonicalizeReproJson(manifest)}\n`, 'utf8');
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    jsonl,
    manifest,
  });
}

