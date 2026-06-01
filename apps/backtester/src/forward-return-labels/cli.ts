import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeForwardReturnLabels } from './writer.js';

interface LabelCliArgs {
  readonly datasetPath: string;
  readonly tradeTapePath?: string;
  readonly outputJsonlPath: string;
  readonly manifestPath?: string;
  readonly tickSize?: number;
  readonly horizonsSeconds?: readonly number[];
}

export function parseForwardReturnLabelCliArgs(argv: readonly string[]): LabelCliArgs {
  const values = new Map<string, string>();
  const flags = new Set(['--dataset', '--trade-tape', '--out', '--manifest', '--tick-size', '--horizons']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.has(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }

  const datasetPath = values.get('--dataset');
  const outputJsonlPath = values.get('--out');
  if (datasetPath === undefined) {
    throw new Error('missing required --dataset <signals.jsonl>');
  }
  if (outputJsonlPath === undefined) {
    throw new Error('missing required --out <labels.jsonl>');
  }

  const tickSizeValue = values.get('--tick-size');
  const horizonsValue = values.get('--horizons');
  return Object.freeze({
    datasetPath,
    tradeTapePath: values.get('--trade-tape'),
    outputJsonlPath,
    manifestPath: values.get('--manifest'),
    tickSize: tickSizeValue === undefined ? undefined : parsePositiveNumber('--tick-size', tickSizeValue),
    horizonsSeconds: horizonsValue === undefined ? undefined : parseHorizons(horizonsValue),
  });
}

export function runForwardReturnLabelCli(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    const args = parseForwardReturnLabelCliArgs(argv);
    const result = writeForwardReturnLabels(args);
    console.log(
      [
        'forward_return_labels_written:',
        `rows=${result.rows.length}`,
        `sha256=${result.manifest.label_jsonl_sha256}`,
        `labels=${args.outputJsonlPath}`,
        args.manifestPath === undefined ? undefined : `manifest=${args.manifestPath}`,
      ].filter((part): part is string => part !== undefined).join(' '),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`forward_return_labels_failed: ${message}`);
    return 2;
  }
}

function parsePositiveNumber(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

function parseHorizons(value: string): readonly number[] {
  const horizons = value.split(',').map((item) => parsePositiveNumber('--horizons', item.trim()));
  if (horizons.length === 0) {
    throw new Error('--horizons must include at least one horizon');
  }
  return Object.freeze(horizons);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = runForwardReturnLabelCli();
}
