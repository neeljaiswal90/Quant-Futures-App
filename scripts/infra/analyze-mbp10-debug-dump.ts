#!/usr/bin/env tsx

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import { stableJsonStringify, type JsonValue } from '../../apps/strategy_runtime/src/contracts/index.js';

export const MBP10_DEBUG_DUMP_ANALYSIS_SCHEMA_VERSION = 1 as const;

type AnalysisStatus = 'analysis_only' | 'fail';
type Recommendation =
  | 'adjust_price_scaling_after_manual_review'
  | 'inspect_side_level_field_semantics'
  | 'require_debug_dump_with_l1_context'
  | 'require_direct_proto_debug_dump'
  | 'rerun_data_parity_04_audit_after_extraction_change';

interface ScaleCandidateSummary {
  readonly divide_price_by: number;
  readonly comparable_price_count: number;
  readonly within_1_tick_of_l1_mid_count: number;
  readonly within_1_tick_pct: number | null;
  readonly within_100_points_of_l1_mid_count: number;
  readonly within_100_points_pct: number | null;
  readonly avg_distance_from_l1_mid_points: number | null;
}

interface FieldPathSummary {
  readonly field_path: string;
  readonly observed_count: number;
  readonly min_raw_value: number | null;
  readonly max_raw_value: number | null;
}

interface ImplausibleExtractedLevel {
  readonly debug_index: number | null;
  readonly side: 'bid' | 'ask';
  readonly level: number | null;
  readonly px: number;
  readonly distance_from_l1_mid_points: number | null;
}

export interface Mbp10DebugDumpAnalysisReport {
  readonly schema_version: typeof MBP10_DEBUG_DUMP_ANALYSIS_SCHEMA_VERSION;
  readonly ticket_id: 'DATA-PARITY-04B';
  readonly status: AnalysisStatus;
  readonly data01b_eligible: false;
  readonly data01_status: 'blocked';
  readonly inputs: {
    readonly debug_dump_path: string;
  };
  readonly row_counts: {
    readonly total_rows: number;
    readonly descriptor_rows: number;
    readonly raw_message_rows: number;
    readonly raw_message_rows_with_l1_context: number;
  };
  readonly descriptor: JsonValue | null;
  readonly field_path_summaries: readonly FieldPathSummary[];
  readonly scale_candidates: readonly ScaleCandidateSummary[];
  readonly likely_price_scale: number | null;
  readonly normalized_extraction: {
    readonly extracted_level_count: number;
    readonly implausible_extracted_level_count: number;
    readonly first_implausible_extracted_levels: readonly ImplausibleExtractedLevel[];
  };
  readonly recommendation: Recommendation;
}

interface CliArgs {
  readonly debug_dump_path: string;
  readonly out_path: string;
}

const DEFAULT_OUT_PATH = 'reports/infra/mbp10_debug_dump_analysis.json';
const IMPLAUSIBLE_LIMIT = 50;

export function analyzeMbp10DebugDump(debugDumpPath: string): Mbp10DebugDumpAnalysisReport {
  const absolutePath = resolve(debugDumpPath);
  const rows = parseJsonl(absolutePath);
  const descriptorRows = rows.filter((row) => row.debug_record_type === 'mbp10_descriptor');
  const rawRows = rows.filter((row) => row.debug_record_type === 'mbp10_raw_message');
  const rawRowsWithL1 = rawRows.filter((row) => row.nearby_l1_quote !== null && row.nearby_l1_quote !== undefined);
  const scaleCandidates = summarizeScaleCandidates(rawRows);
  const likelyScale = selectLikelyScale(scaleCandidates);
  const fieldPathSummaries = summarizeFieldPaths(rawRows);
  const normalizedExtraction = summarizeNormalizedExtraction(rawRows);
  const recommendation = recommend({
    raw_message_count: rawRows.length,
    raw_with_l1_count: rawRowsWithL1.length,
    likely_scale: likelyScale,
    scale_candidates: scaleCandidates,
    implausible_extracted_level_count: normalizedExtraction.implausible_extracted_level_count,
  });

  return {
    schema_version: MBP10_DEBUG_DUMP_ANALYSIS_SCHEMA_VERSION,
    ticket_id: 'DATA-PARITY-04B',
    status: recommendation === 'rerun_data_parity_04_audit_after_extraction_change' ? 'analysis_only' : 'fail',
    data01b_eligible: false,
    data01_status: 'blocked',
    inputs: {
      debug_dump_path: absolutePath,
    },
    row_counts: {
      total_rows: rows.length,
      descriptor_rows: descriptorRows.length,
      raw_message_rows: rawRows.length,
      raw_message_rows_with_l1_context: rawRowsWithL1.length,
    },
    descriptor: (descriptorRows[0]?.descriptor as JsonValue | undefined) ?? null,
    field_path_summaries: fieldPathSummaries,
    scale_candidates: scaleCandidates,
    likely_price_scale: likelyScale,
    normalized_extraction: normalizedExtraction,
    recommendation,
  };
}

export function writeMbp10DebugDumpAnalysisReport(
  report: Mbp10DebugDumpAnalysisReport,
  outPath: string,
): void {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
}

function parseJsonl(path: string): readonly Record<string, unknown>[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
  const rows: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    const parsed = JSON.parse(line) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid debug JSONL row in ${path}`);
    }
    rows.push(parsed as Record<string, unknown>);
  }
  return rows;
}

function summarizeScaleCandidates(rows: readonly Record<string, unknown>[]): readonly ScaleCandidateSummary[] {
  const byScale = new Map<number, { count: number; withinTick: number; within100: number; distanceSum: number }>();
  for (const row of rows) {
    const diagnostics = arrayOfObjects(row.price_scaling_diagnostics);
    for (const diagnostic of diagnostics) {
      const candidates = arrayOfObjects(diagnostic.scale_candidates);
      for (const candidate of candidates) {
        const factor = numberOrNull(candidate.divide_by);
        const distance = numberOrNull(candidate.distance_from_l1_mid_points);
        if (factor === null || distance === null) {
          continue;
        }
        const summary = byScale.get(factor) ?? { count: 0, withinTick: 0, within100: 0, distanceSum: 0 };
        summary.count += 1;
        summary.distanceSum += distance;
        if (candidate.within_1_tick_of_l1_mid === true) {
          summary.withinTick += 1;
        }
        if (candidate.within_100_points_of_l1_mid === true) {
          summary.within100 += 1;
        }
        byScale.set(factor, summary);
      }
    }
  }

  return [...byScale.entries()]
    .map(([factor, summary]) => ({
      divide_price_by: factor,
      comparable_price_count: summary.count,
      within_1_tick_of_l1_mid_count: summary.withinTick,
      within_1_tick_pct: pct(summary.withinTick, summary.count),
      within_100_points_of_l1_mid_count: summary.within100,
      within_100_points_pct: pct(summary.within100, summary.count),
      avg_distance_from_l1_mid_points: summary.count === 0 ? null : round6(summary.distanceSum / summary.count),
    }))
    .sort((left, right) => left.divide_price_by - right.divide_price_by);
}

function selectLikelyScale(candidates: readonly ScaleCandidateSummary[]): number | null {
  if (candidates.length === 0) {
    return null;
  }
  const ordered = [...candidates].sort((left, right) => {
    const byTick = (right.within_1_tick_pct ?? -1) - (left.within_1_tick_pct ?? -1);
    if (byTick !== 0) {
      return byTick;
    }
    const byHundred = (right.within_100_points_pct ?? -1) - (left.within_100_points_pct ?? -1);
    if (byHundred !== 0) {
      return byHundred;
    }
    return left.divide_price_by - right.divide_price_by;
  });
  return ordered[0]?.divide_price_by ?? null;
}

function summarizeFieldPaths(rows: readonly Record<string, unknown>[]): readonly FieldPathSummary[] {
  const byPath = new Map<string, number[]>();
  for (const row of rows) {
    const diagnostics = arrayOfObjects(row.price_scaling_diagnostics);
    for (const diagnostic of diagnostics) {
      const fieldPath = stringOrNull(diagnostic.field_path);
      const rawValue = numberOrNull(diagnostic.raw_value);
      if (fieldPath === null || rawValue === null) {
        continue;
      }
      const values = byPath.get(fieldPath) ?? [];
      values.push(rawValue);
      byPath.set(fieldPath, values);
    }
  }
  return [...byPath.entries()]
    .map(([fieldPath, values]) => ({
      field_path: fieldPath,
      observed_count: values.length,
      min_raw_value: Math.min(...values),
      max_raw_value: Math.max(...values),
    }))
    .sort((left, right) => compareStrings(left.field_path, right.field_path));
}

function summarizeNormalizedExtraction(rows: readonly Record<string, unknown>[]): Mbp10DebugDumpAnalysisReport['normalized_extraction'] {
  let extractedLevelCount = 0;
  let implausibleCount = 0;
  const firstImplausible: ImplausibleExtractedLevel[] = [];
  for (const row of rows) {
    const debugIndex = numberOrNull(row.debug_index);
    const normalized = objectOrNull(row.normalized_extracted_fields);
    if (normalized === null) {
      continue;
    }
    for (const [sideKey, side] of [
      ['bids', 'bid'],
      ['asks', 'ask'],
    ] as const) {
      const levels = arrayOfObjects(normalized[sideKey]);
      for (const level of levels) {
        const price = numberOrNull(level.px);
        if (price === null) {
          continue;
        }
        extractedLevelCount += 1;
        const sanity = objectOrNull(level.debug_price_sanity);
        if (sanity?.plausible_against_l1 === false) {
          implausibleCount += 1;
          if (firstImplausible.length < IMPLAUSIBLE_LIMIT) {
            firstImplausible.push({
              debug_index: debugIndex,
              side,
              level: numberOrNull(level.level),
              px: price,
              distance_from_l1_mid_points: numberOrNull(sanity.distance_from_l1_mid_points),
            });
          }
        }
      }
    }
  }
  return {
    extracted_level_count: extractedLevelCount,
    implausible_extracted_level_count: implausibleCount,
    first_implausible_extracted_levels: firstImplausible,
  };
}

function recommend(args: {
  readonly raw_message_count: number;
  readonly raw_with_l1_count: number;
  readonly likely_scale: number | null;
  readonly scale_candidates: readonly ScaleCandidateSummary[];
  readonly implausible_extracted_level_count: number;
}): Recommendation {
  if (args.raw_message_count === 0) {
    return 'require_direct_proto_debug_dump';
  }
  if (args.raw_with_l1_count === 0) {
    return 'require_debug_dump_with_l1_context';
  }
  const scaleOne = args.scale_candidates.find((candidate) => candidate.divide_price_by === 1);
  const likely = args.scale_candidates.find((candidate) => candidate.divide_price_by === args.likely_scale);
  if (
    likely !== undefined &&
    likely.divide_price_by !== 1 &&
    (likely.within_100_points_pct ?? 0) >= 80 &&
    (likely.within_100_points_pct ?? 0) > (scaleOne?.within_100_points_pct ?? 0) + 25
  ) {
    return 'adjust_price_scaling_after_manual_review';
  }
  if (args.implausible_extracted_level_count > 0) {
    return 'inspect_side_level_field_semantics';
  }
  return 'rerun_data_parity_04_audit_after_extraction_change';
}

function arrayOfObjects(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> => (
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  ));
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator === 0) {
    return null;
  }
  return round6((numerator / denominator) * 100);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  let debugDumpPath: string | undefined;
  let outPath = DEFAULT_OUT_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--debug-dump') {
      debugDumpPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--out') {
      outPath = argv[index + 1] ?? outPath;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      processStdout.write(
        'Usage: npm run infra:analyze-mbp10-debug -- --debug-dump <debug.jsonl> --out <report.json>\n',
      );
      processExit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (debugDumpPath === undefined) {
    throw new Error('--debug-dump is required');
  }
  return {
    debug_dump_path: debugDumpPath,
    out_path: outPath,
  };
}

function main(): void {
  try {
    const args = parseCliArgs(processArgv.slice(2));
    const report = analyzeMbp10DebugDump(args.debug_dump_path);
    writeMbp10DebugDumpAnalysisReport(report, args.out_path);
    processStdout.write(`MBP10 debug dump analysis: ${report.status}\n`);
    processStdout.write(`likely_price_scale=${report.likely_price_scale ?? 'unknown'}\n`);
    processStdout.write(`recommendation=${report.recommendation}\n`);
    processStdout.write(`raw_message_rows=${report.row_counts.raw_message_rows}\n`);
    processStdout.write(
      `implausible_extracted_levels=${report.normalized_extraction.implausible_extracted_level_count}\n`,
    );
    processStdout.write('DATA-01B remains blocked.\n');
    processExit(report.status === 'fail' ? 2 : 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    processStderr.write(`${message}\n`);
    processExit(3);
  }
}

if (processArgv[1] === fileURLToPath(import.meta.url)) {
  main();
}
