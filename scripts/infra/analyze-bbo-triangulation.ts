#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import { stableJsonStringify, type JsonValue } from '../../apps/strategy_runtime/src/contracts/index.js';
import {
  analyzeBboTriangulationFromPaths,
  DATABENTO_OVERLAP_PARITY_SCHEMA_VERSION,
  type BboTriangulationComparisonReport,
  type BboTriangulationReport,
  type UnavailableCrossCheck,
} from './analyze-databento-overlap-parity.js';

interface CliArgs {
  readonly rithmic_probe_path: string;
  readonly databento_mbp10_path: string;
  readonly databento_mbp1_path: string;
  readonly out_path: string;
}

interface BboTriangulationCliReport {
  readonly schema_version: typeof DATABENTO_OVERLAP_PARITY_SCHEMA_VERSION;
  readonly ticket_id: 'DATA-PARITY-08';
  readonly status: 'analysis_only';
  readonly data01b_eligible: false;
  readonly inputs: {
    readonly rithmic_probe_path: string;
    readonly databento_mbp10_path: string;
    readonly databento_mbp1_path: string;
  };
  readonly bbo_triangulation: BboTriangulationReport;
}

const DEFAULT_OUT_PATH = 'reports/infra/databento_bbo_triangulation_report.json';

function usage(): string {
  return [
    'Usage: npm run infra:analyze-bbo-triangulation -- --rithmic-probe <probe.jsonl> --databento-mbp10 <mbp10.jsonl> --databento-mbp1 <mbp1.jsonl> --out <report.json>',
    '',
    `Default --out: ${DEFAULT_OUT_PATH}`,
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliArgs {
  let rithmicProbePath: string | undefined;
  let databentoMbp10Path: string | undefined;
  let databentoMbp1Path: string | undefined;
  let outPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
    }
    if (arg === '--rithmic-probe') {
      rithmicProbePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--databento-mbp10') {
      databentoMbp10Path = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--databento-mbp1') {
      databentoMbp1Path = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--out') {
      outPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }

  if (!rithmicProbePath) {
    throw new Error(`--rithmic-probe is required\n${usage()}`);
  }
  if (!databentoMbp10Path) {
    throw new Error(`--databento-mbp10 is required\n${usage()}`);
  }
  if (!databentoMbp1Path) {
    throw new Error(`--databento-mbp1 is required\n${usage()}`);
  }

  return {
    rithmic_probe_path: rithmicProbePath,
    databento_mbp10_path: databentoMbp10Path,
    databento_mbp1_path: databentoMbp1Path,
    out_path: outPath ?? DEFAULT_OUT_PATH,
  };
}

function buildReport(args: CliArgs): BboTriangulationCliReport {
  const rithmicPath = resolve(args.rithmic_probe_path);
  const databentoMbp10Path = resolve(args.databento_mbp10_path);
  const databentoMbp1Path = resolve(args.databento_mbp1_path);
  return {
    schema_version: DATABENTO_OVERLAP_PARITY_SCHEMA_VERSION,
    ticket_id: 'DATA-PARITY-08',
    status: 'analysis_only',
    data01b_eligible: false,
    inputs: {
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoMbp10Path,
      databento_mbp1_path: databentoMbp1Path,
    },
    bbo_triangulation: analyzeBboTriangulationFromPaths({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoMbp10Path,
      databento_mbp1_path: databentoMbp1Path,
    }),
  };
}

function writeReport(report: BboTriangulationCliReport, outPath: string): void {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
}

function formatSummary(report: BboTriangulationCliReport): string {
  const triangulation = report.bbo_triangulation;
  return [
    'DATA-PARITY-08 BBO triangulation: analysis_only',
    `classification=${triangulation.classification}`,
    comparisonLine('rithmic_l1_quote_vs_databento_mbp1', triangulation.comparisons.rithmic_l1_quote_vs_databento_mbp1),
    comparisonLine(
      'rithmic_mbp10_top_vs_rithmic_l1_quote',
      triangulation.comparisons.rithmic_mbp10_top_vs_rithmic_l1_quote,
    ),
    comparisonLine(
      'databento_mbp10_top_vs_databento_mbp1',
      triangulation.comparisons.databento_mbp10_top_vs_databento_mbp1,
    ),
    comparisonLine(
      'rithmic_mbp10_top_vs_databento_mbp10',
      triangulation.comparisons.rithmic_mbp10_top_vs_databento_mbp10,
    ),
    'DATA-01B remains blocked.',
    '',
  ].join('\n');
}

function comparisonLine(
  label: string,
  comparison: BboTriangulationComparisonReport | UnavailableCrossCheck,
): string {
  if (comparison.status === 'not_available') {
    return `${label}=not_available`;
  }
  return [
    `${label}=`,
    `policy:${comparison.best_lookup_policy}`,
    `compared:${comparison.compared_samples}`,
    `both_px_1tick_pct:${comparison.both_sides_within_1_tick_pct}`,
    `bid_px_1tick_pct:${comparison.bid_price_within_1_tick_pct}`,
    `ask_px_1tick_pct:${comparison.ask_price_within_1_tick_pct}`,
  ].join('');
}

function main(): void {
  try {
    const args = parseArgs(processArgv.slice(2));
    const report = buildReport(args);
    writeReport(report, args.out_path);
    processStdout.write(formatSummary(report));
    processExit(0);
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
