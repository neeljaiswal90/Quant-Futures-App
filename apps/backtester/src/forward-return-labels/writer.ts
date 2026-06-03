import { mkdirSync, openSync, closeSync, writeSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalizeReproJson } from '../repro-hash/index.js';
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
  readonly manifest: ForwardReturnLabelManifest;
}

/**
 * Small-data convenience helper: builds the JSONL as a single string.
 * Kept for tests + ad-hoc callers; NOT used by writeForwardReturnLabels.
 * Will hit V8's ~512 MB string-length cap on big inputs (RA-093b labels
 * stage observed crashing here historically — see writer.ts streaming impl).
 */
export function buildForwardReturnLabelJsonl(
  rows: readonly ReplaySignalRow[],
  trades: readonly ReplayTradeTick[],
  options: ForwardReturnLabelOptions = {},
): string {
  const labeledRows = rows.map((row) => labelReplaySignalRow(row, trades, options));
  return labeledRows.map((row) => canonicalizeReproJson(row)).join('\n') + (labeledRows.length > 0 ? '\n' : '');
}

/**
 * Streaming SHA-256 of a file. Reads in 1 MB chunks via fs.readSync so the
 * entire file content never exists as a single string. Used in place of
 * `sha256Utf8(readFileSync(path, 'utf8'))` because the latter hits V8's
 * single-string cap on files > 512 MB. Hash output is identical because
 * sha256 is content-stable regardless of how the bytes are fed in.
 */
function sha256OfFileSync(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20); // 1 MB
    let bytesRead: number;
    // readSync returns 0 at EOF.
    // eslint-disable-next-line no-constant-condition
    while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * RA-093b labels stage. Streams labeled rows to disk + hashes incrementally
 * so no single in-memory string ever holds the full labeled output.
 *
 * Previous implementation concatenated all canonicalized rows into one
 * giant JSONL string before writing — hit V8's ~512 MB single-string cap
 * on the 5/27 session's 517 MB trade tape input.
 *
 * Output format is byte-identical to the previous implementation: one
 * canonicalized JSON per row, separated by '\n', with a trailing '\n' iff
 * at least one row was emitted.
 */
export function writeForwardReturnLabels(
  options: WriteForwardReturnLabelsOptions,
): WriteForwardReturnLabelsResult {
  const input = loadReplayDatasetInput({
    datasetPath: options.datasetPath,
    tradeTapePath: options.tradeTapePath,
  });

  mkdirSync(dirname(options.outputJsonlPath), { recursive: true });

  // Stream the labeled output to disk + hash incrementally. Keep the
  // labeled rows in an array for the return value (caller may need them
  // for inspection) — that array IS one allocation per labeled row, but
  // each row is small (~2-3 KB), so memory pressure is from the row count
  // not from a single huge string allocation.
  const labeledRows: LabeledReplaySignalRow[] = [];
  const labelHash = createHash('sha256');
  const fd = openSync(options.outputJsonlPath, 'w');
  try {
    for (const row of input.rows) {
      const labeled = labelReplaySignalRow(row, input.trade_tape, options);
      const line = canonicalizeReproJson(labeled) + '\n';
      // writeSync with utf8 encoding handles arbitrary-length strings
      // because Buffer-backed writes don't trigger V8's string cap on
      // each call (each call writes a small per-row chunk).
      writeSync(fd, line, null, 'utf8');
      labelHash.update(line, 'utf8');
      labeledRows.push(labeled);
    }
  } finally {
    closeSync(fd);
  }
  const labelJsonlSha256 = labelHash.digest('hex');

  const manifest = Object.freeze({
    manifest_schema_version: 1,
    label_schema_version: 1,
    dataset_path: options.datasetPath,
    trade_tape_path: input.trade_tape_path,
    // Stream-hash the source files. The previous impl read the entire
    // file as one UTF-8 string before passing to sha256Utf8, which is
    // exactly the trap that crashed the 5/27 run (the trade tape was
    // 517 MB).
    dataset_sha256: sha256OfFileSync(options.datasetPath),
    trade_tape_sha256: sha256OfFileSync(input.trade_tape_path),
    label_jsonl_sha256: labelJsonlSha256,
    row_count: labeledRows.length,
    horizons_seconds: Object.freeze([...(options.horizonsSeconds ?? FORWARD_RETURN_HORIZONS_SECONDS)]),
    tick_size: options.tickSize ?? 0.25,
    generated_by: 'ra091_forward_return_labels_v1',
  } satisfies ForwardReturnLabelManifest);

  if (options.manifestPath !== undefined) {
    mkdirSync(dirname(options.manifestPath), { recursive: true });
    // The manifest itself is small (a handful of fields) — safe to write
    // as a single canonicalized string.
    const manifestPath = options.manifestPath;
    const mfd = openSync(manifestPath, 'w');
    try {
      writeSync(mfd, `${canonicalizeReproJson(manifest)}\n`, null, 'utf8');
    } finally {
      closeSync(mfd);
    }
  }

  return Object.freeze({
    rows: Object.freeze(labeledRows),
    manifest,
  });
}
