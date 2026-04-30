import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  journalEventFromJsonLine,
  stableJsonStringify,
  type JsonValue,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import { forEachJsonlLine, sha256File } from '../sim/streaming-jsonl.js';

export const MBO_SHADOW_EVIDENCE_01_SCHEMA_VERSION = 1 as const;
export const MBO_SHADOW_EVIDENCE_01_TICKET_ID = 'MBO-SHADOW-EVIDENCE-01' as const;

type MboShadowEvidenceStatus = 'pass' | 'fail' | 'no_sessions';
type CheckStatus = 'pass' | 'fail';
type JsonObject = { readonly [key: string]: JsonValue };

const SAFETY_POSTURE = {
  mbo_decision_use_allowed: false,
  mbo_derived_features_status: 'shadow_only',
  data01b_full_status: 'blocked',
  runtime_trading_behavior_changed: false,
  decision_surface_changed: false,
  execution_mode: 'unchanged_simulated_only',
} as const;

interface MboShadowEvidenceManifest {
  readonly schema_version: 1;
  readonly evidence_run_id: string;
  readonly runtime_commit?: string;
  readonly sessions: readonly MboShadowEvidenceSessionInput[];
}

interface MboShadowEvidenceSessionInput {
  readonly session_id: string;
  readonly run_id: string;
  readonly shadow_journal: string;
  readonly mbo_source_journal: string;
  readonly orch_report: string;
  readonly rel00_report: string;
  readonly rel01d_report: string;
  readonly rel01e_report: string;
}

interface MboShadowEvidenceOptions {
  readonly manifest: string;
  readonly outJson: string;
  readonly outMd?: string;
  readonly cwd?: string;
}

interface MboShadowEvidenceCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

interface MboShadowEvidenceCheckGroup {
  readonly name: string;
  readonly status: CheckStatus;
  readonly checks: readonly MboShadowEvidenceCheck[];
}

interface DistributionSummary {
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
}

interface SourceJournalScan {
  readonly parse_errors: number;
  readonly source_event_count: number;
  readonly action_counts: Record<string, number>;
  readonly side_counts: Record<string, number>;
}

interface ShadowJournalScan {
  readonly parse_errors: number;
  readonly shadow_events: number;
  readonly shadow_field_occurrences: number;
  readonly unsafe_decision_use_event_count: number;
  readonly values_by_field: Record<string, readonly number[]>;
}

interface SessionEvidenceSummary {
  readonly session_id: string;
  readonly run_id: string;
  readonly status: CheckStatus;
  readonly files: {
    readonly shadow_journal: string;
    readonly mbo_source_journal: string;
    readonly orch_report: string;
    readonly rel00_report: string;
    readonly rel01d_report: string;
    readonly rel01e_report: string;
  };
  readonly source_hash: string | null;
  readonly source_hashes_reported: readonly string[];
  readonly orch_status: string | null;
  readonly rel00_status: string | null;
  readonly rel01d_status: string | null;
  readonly rel01e_status: string | null;
  readonly source_mbo_events_indexed: number;
  readonly shadow_events: number;
  readonly shadow_field_occurrences: number;
  readonly action_counts: Record<string, number>;
  readonly side_counts: Record<string, number>;
  readonly distributions_by_field: Record<string, DistributionSummary>;
  readonly mask_binding: {
    readonly mask_versions: readonly number[];
    readonly mask_ids: readonly string[];
    readonly mask_hashes: readonly string[];
  };
  readonly cross_validator: {
    readonly local_shadow_field_occurrences: number;
    readonly rel01d_shadow_field_occurrences: number;
    readonly rel01e_shadow_field_occurrences: number;
  };
  readonly safety: {
    readonly real_order_event_types: number;
    readonly restricted_uses: number;
    readonly blocked_uses: number;
    readonly unsafe_decision_use_event_count: number;
    readonly unsafe_decision_use_validator_count_sum: number;
  };
  readonly lineage: {
    readonly missing_source_event_count: number;
    readonly lookahead_source_event_count: number;
    readonly recompute_mismatch_count: number;
    readonly source_hash_mismatch_count: number;
  };
  readonly reasons: readonly string[];
}

interface MboShadowEvidenceReport {
  readonly schema_version: 1;
  readonly ticket_id: typeof MBO_SHADOW_EVIDENCE_01_TICKET_ID;
  readonly status: MboShadowEvidenceStatus;
  readonly manifest: {
    readonly path: string;
    readonly sha256: string | null;
    readonly evidence_run_id: string | null;
    readonly runtime_commit: string | null;
    readonly session_count: number;
  };
  readonly safety_posture: typeof SAFETY_POSTURE;
  readonly aggregate: {
    readonly session_count: number;
    readonly generated_sessions: number;
    readonly rel00_pass_sessions: number;
    readonly rel01d_pass_sessions: number;
    readonly rel01e_pass_sessions: number;
    readonly source_mbo_events_indexed: number;
    readonly shadow_events: number;
    readonly shadow_field_occurrences: number;
    readonly action_counts: Record<string, number>;
    readonly side_counts: Record<string, number>;
    readonly source_hash_coverage: {
      readonly sessions_with_source_hash: number;
      readonly unique_source_hashes: readonly string[];
    };
    readonly mask_binding: {
      readonly mask_versions: readonly number[];
      readonly mask_ids: readonly string[];
      readonly mask_hashes: readonly string[];
    };
    readonly cross_validator: {
      readonly shadow_field_occurrence_mismatch_sessions: readonly string[];
    };
    readonly distributions_by_field: Record<string, DistributionSummary>;
    readonly safety: {
      readonly real_order_event_types: number;
      readonly restricted_uses: number;
      readonly blocked_uses: number;
      readonly unsafe_decision_use_event_count: number;
      readonly unsafe_decision_use_validator_count_sum: number;
    };
    readonly lineage: {
      readonly missing_source_event_count: number;
      readonly lookahead_source_event_count: number;
      readonly recompute_mismatch_count: number;
      readonly source_hash_mismatch_count: number;
    };
  };
  readonly sessions: readonly SessionEvidenceSummary[];
  readonly check_groups: readonly MboShadowEvidenceCheckGroup[];
  readonly reasons: readonly string[];
  readonly no_raw_data_statement: string;
  readonly next_blocker: string;
}

interface LoadedReports {
  readonly orch: JsonObject | null;
  readonly rel00: JsonObject | null;
  readonly rel01d: JsonObject | null;
  readonly rel01e: JsonObject | null;
}

interface SessionEvidenceWork {
  readonly summary: SessionEvidenceSummary;
  readonly values_by_field: Record<string, readonly number[]>;
}

interface SessionResolvedPaths {
  readonly shadow_journal: string;
  readonly mbo_source_journal: string;
  readonly orch_report: string;
  readonly rel00_report: string;
  readonly rel01d_report: string;
  readonly rel01e_report: string;
}

function defaultOptionsFromArgv(argv: readonly string[]): MboShadowEvidenceOptions {
  const args = parseArgs(argv);
  const manifest = requiredArg(args, 'manifest');
  const outJson = requiredArg(args, 'out-json');
  return {
    manifest,
    outJson,
    outMd: args['out-md'],
  };
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function requiredArg(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function resolveFromCwd(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

function reportPath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, '/');
  return relative === '' || relative.startsWith('..') ? absolutePath.replace(/\\/gu, '/') : relative;
}

function readJsonObject(filePath: string): JsonObject | null {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as JsonValue;
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

function readManifest(manifestPath: string): MboShadowEvidenceManifest {
  const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as JsonValue;
  if (!isJsonObject(value)) {
    throw new Error('manifest must be a JSON object');
  }
  if (value.schema_version !== 1) {
    throw new Error('manifest.schema_version must be 1');
  }
  if (typeof value.evidence_run_id !== 'string' || value.evidence_run_id.trim() === '') {
    throw new Error('manifest.evidence_run_id must be a non-empty string');
  }
  if (!Array.isArray(value.sessions)) {
    throw new Error('manifest.sessions must be an array');
  }
  const sessions = value.sessions.map((session, index) => parseManifestSession(session, index));
  return {
    schema_version: 1,
    evidence_run_id: value.evidence_run_id,
    runtime_commit: typeof value.runtime_commit === 'string' ? value.runtime_commit : undefined,
    sessions,
  };
}

function parseManifestSession(value: JsonValue, index: number): MboShadowEvidenceSessionInput {
  if (!isJsonObject(value)) {
    throw new Error(`manifest.sessions[${index}] must be an object`);
  }
  return {
    session_id: nonEmptyString(value.session_id, `manifest.sessions[${index}].session_id`),
    run_id: nonEmptyString(value.run_id, `manifest.sessions[${index}].run_id`),
    shadow_journal: nonEmptyString(value.shadow_journal, `manifest.sessions[${index}].shadow_journal`),
    mbo_source_journal: nonEmptyString(value.mbo_source_journal, `manifest.sessions[${index}].mbo_source_journal`),
    orch_report: nonEmptyString(value.orch_report, `manifest.sessions[${index}].orch_report`),
    rel00_report: nonEmptyString(value.rel00_report, `manifest.sessions[${index}].rel00_report`),
    rel01d_report: nonEmptyString(value.rel01d_report, `manifest.sessions[${index}].rel01d_report`),
    rel01e_report: nonEmptyString(value.rel01e_report, `manifest.sessions[${index}].rel01e_report`),
  };
}

function nonEmptyString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function resolveSessionPaths(
  cwd: string,
  session: MboShadowEvidenceSessionInput,
): SessionResolvedPaths {
  return {
    shadow_journal: resolveFromCwd(cwd, session.shadow_journal),
    mbo_source_journal: resolveFromCwd(cwd, session.mbo_source_journal),
    orch_report: resolveFromCwd(cwd, session.orch_report),
    rel00_report: resolveFromCwd(cwd, session.rel00_report),
    rel01d_report: resolveFromCwd(cwd, session.rel01d_report),
    rel01e_report: resolveFromCwd(cwd, session.rel01e_report),
  };
}

function scanSourceJournal(filePath: string): SourceJournalScan {
  let parseErrors = 0;
  let sourceEventCount = 0;
  const actionCounts = new Map<string, number>();
  const sideCounts = new Map<string, number>();

  forEachJsonlLine(filePath, (line) => {
    try {
      const event = journalEventFromJsonLine(line);
      if (event.type !== 'MICROSTRUCTURE') {
        return;
      }
      sourceEventCount += 1;
      const payload = isJsonObject(event.payload) ? event.payload : {};
      incrementCount(actionCounts, normalizeKey(stringFromPayload(payload, 'action')));
      incrementCount(sideCounts, normalizeKey(stringFromPayload(payload, 'side')));
    } catch {
      parseErrors += 1;
    }
  });

  return {
    parse_errors: parseErrors,
    source_event_count: sourceEventCount,
    action_counts: mapToSortedRecord(actionCounts),
    side_counts: mapToSortedRecord(sideCounts),
  };
}

function scanShadowJournal(filePath: string): ShadowJournalScan {
  let parseErrors = 0;
  let shadowEvents = 0;
  let shadowFieldOccurrences = 0;
  let unsafeDecisionUseEventCount = 0;
  const valuesByField = new Map<string, number[]>();

  forEachJsonlLine(filePath, (line) => {
    try {
      const event = journalEventFromJsonLine(line);
      const payload = isJsonObject(event.payload) ? event.payload : {};
      const shadowValues = isJsonObject(payload.shadow_values) ? payload.shadow_values : null;
      if (shadowValues === null || Object.keys(shadowValues).length === 0) {
        return;
      }
      shadowEvents += 1;
      if (payload.decision_use !== false) {
        unsafeDecisionUseEventCount += 1;
      }
      for (const field of Object.keys(shadowValues).sort()) {
        shadowFieldOccurrences += 1;
        const value = shadowValues[field];
        if (typeof value === 'number' && Number.isFinite(value)) {
          const values = valuesByField.get(field) ?? [];
          values.push(value);
          valuesByField.set(field, values);
        }
      }
    } catch {
      parseErrors += 1;
    }
  });

  return {
    parse_errors: parseErrors,
    shadow_events: shadowEvents,
    shadow_field_occurrences: shadowFieldOccurrences,
    unsafe_decision_use_event_count: unsafeDecisionUseEventCount,
    values_by_field: valuesMapToRecord(valuesByField),
  };
}

function stringFromPayload(payload: JsonObject, key: string): string | null {
  const direct = payload[key];
  if (typeof direct === 'string' && direct.trim() !== '') {
    return direct;
  }
  const values = payload.values;
  if (isJsonObject(values)) {
    const nested = values[key];
    if (typeof nested === 'string' && nested.trim() !== '') {
      return nested;
    }
  }
  return null;
}

function normalizeKey(value: string | null): string {
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined || normalized === '' ? 'unknown' : normalized;
}

function incrementCount(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function mapToSortedRecord(map: Map<string, number>): Record<string, number> {
  const record: Record<string, number> = {};
  for (const key of Array.from(map.keys()).sort()) {
    record[key] = map.get(key) ?? 0;
  }
  return record;
}

function valuesMapToRecord(map: Map<string, number[]>): Record<string, readonly number[]> {
  const record: Record<string, readonly number[]> = {};
  for (const key of Array.from(map.keys()).sort()) {
    record[key] = [...(map.get(key) ?? [])];
  }
  return record;
}

function mergeCountRecords(...records: readonly Record<string, number>[]): Record<string, number> {
  const merged = new Map<string, number>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      incrementCount(merged, key, record[key] ?? 0);
    }
  }
  return mapToSortedRecord(merged);
}

function mergeValueRecords(
  ...records: readonly Record<string, readonly number[]>[]
): Record<string, readonly number[]> {
  const merged = new Map<string, number[]>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      const values = merged.get(key) ?? [];
      for (const value of record[key] ?? []) {
        values.push(value);
      }
      merged.set(key, values);
    }
  }
  return valuesMapToRecord(merged);
}

function distributionSummary(values: readonly number[]): DistributionSummary {
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p90: null,
      p99: null,
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: roundMetric(sorted[0]),
    max: roundMetric(sorted[sorted.length - 1]),
    mean: roundMetric(sum / sorted.length),
    p50: roundMetric(nearestRank(sorted, 50)),
    p90: roundMetric(nearestRank(sorted, 90)),
    p99: roundMetric(nearestRank(sorted, 99)),
  };
}

function nearestRank(sortedValues: readonly number[], percentile: number): number {
  const index = Math.max(
    0,
    Math.min(sortedValues.length - 1, Math.ceil((percentile / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index];
}

function roundMetric(value: number): number {
  return Number(value.toFixed(12));
}

function distributionsByField(
  valuesByField: Record<string, readonly number[]>,
): Record<string, DistributionSummary> {
  const record: Record<string, DistributionSummary> = {};
  for (const field of Object.keys(valuesByField).sort()) {
    record[field] = distributionSummary(valuesByField[field] ?? []);
  }
  return record;
}

function validateSession(
  cwd: string,
  input: MboShadowEvidenceSessionInput,
): SessionEvidenceWork {
  const paths = resolveSessionPaths(cwd, input);
  const reasons: string[] = [];
  const missingFiles = Object.entries(paths)
    .filter(([, filePath]) => !existsSync(filePath))
    .map(([name]) => name)
    .sort();

  for (const missing of missingFiles) {
    reasons.push(`missing_file:${missing}`);
  }

  const sourceHash = existsSync(paths.mbo_source_journal) ? sha256File(paths.mbo_source_journal) : null;
  const sourceScan = existsSync(paths.mbo_source_journal)
    ? scanSourceJournal(paths.mbo_source_journal)
    : emptySourceScan();
  const shadowScan = existsSync(paths.shadow_journal)
    ? scanShadowJournal(paths.shadow_journal)
    : emptyShadowScan();
  const reports: LoadedReports = {
    orch: existsSync(paths.orch_report) ? readJsonObject(paths.orch_report) : null,
    rel00: existsSync(paths.rel00_report) ? readJsonObject(paths.rel00_report) : null,
    rel01d: existsSync(paths.rel01d_report) ? readJsonObject(paths.rel01d_report) : null,
    rel01e: existsSync(paths.rel01e_report) ? readJsonObject(paths.rel01e_report) : null,
  };

  const orchStatus = stringAt(reports.orch, ['status']);
  const rel00Status = stringAt(reports.rel00, ['status']);
  const rel01dStatus = stringAt(reports.rel01d, ['status']);
  const rel01eStatus = stringAt(reports.rel01e, ['status']);

  if (reports.orch === null && !missingFiles.includes('orch_report')) reasons.push('malformed_report:orch');
  if (reports.rel00 === null && !missingFiles.includes('rel00_report')) reasons.push('malformed_report:rel00');
  if (reports.rel01d === null && !missingFiles.includes('rel01d_report')) reasons.push('malformed_report:rel01d');
  if (reports.rel01e === null && !missingFiles.includes('rel01e_report')) reasons.push('malformed_report:rel01e');

  if (orchStatus !== 'generated') reasons.push(`orch_status_not_generated:${orchStatus ?? 'missing'}`);
  if (rel00Status !== 'pass') reasons.push(`rel00_status_not_pass:${rel00Status ?? 'missing'}`);
  if (rel01dStatus !== 'pass') reasons.push(`rel01d_status_not_pass:${rel01dStatus ?? 'missing'}`);
  if (rel01eStatus !== 'pass') reasons.push(`rel01e_status_not_pass:${rel01eStatus ?? 'missing'}`);

  const sourceHashesReported = uniqueSorted([
    stringAt(reports.orch, ['input', 'mbo_source_journal', 'sha256']),
    stringAt(reports.rel01e, ['aggregate', 'source_journal_sha256']),
    ...stringsAtArray(reports.rel01e, ['sessions'], 'source_journal_sha256'),
  ]);
  if (sourceHash !== null) {
    if (sourceHashesReported.length === 0) {
      reasons.push('source_hash_reports_missing');
    }
    for (const reportedHash of sourceHashesReported) {
      if (reportedHash !== sourceHash) {
        reasons.push(`source_hash_mismatch:${reportedHash}`);
      }
    }
  }

  const realOrderEventTypes = numberAt(reports.orch, ['real_order_event_types_emitted'])
    + sumNumberRecord(objectAt(reports.rel00, ['raw_scan_summary', 'real_order_event_type_counts']));
  const rel01dPartitionCounts = objectAt(reports.rel01d, ['aggregate', 'partition_counts']);
  const restrictedUses = numberValue(rel01dPartitionCounts?.restricted)
    + numberValue(rel01dPartitionCounts?.invalid_diagnostic)
    + numberValue(rel01dPartitionCounts?.invalid_shadow);
  const blockedUses = numberValue(rel01dPartitionCounts?.blocked);
  const localUnsafeDecisionUseCount = shadowScan.unsafe_decision_use_event_count;
  const rel01dUnsafeDecisionUseCount = numberAt(
    reports.rel01d,
    ['aggregate', 'unsafe_shadow_or_diagnostic_decision_use_event_count'],
  );
  const rel01eUnsafeDecisionUseCount = numberAt(reports.rel01e, ['aggregate', 'unsafe_decision_use_event_count']);
  const unsafeDecisionUseEventCount = Math.max(
    localUnsafeDecisionUseCount,
    rel01dUnsafeDecisionUseCount,
    rel01eUnsafeDecisionUseCount,
  );
  const unsafeDecisionUseValidatorCountSum = localUnsafeDecisionUseCount
    + rel01dUnsafeDecisionUseCount
    + rel01eUnsafeDecisionUseCount;
  const missingSourceEventCount = numberAt(reports.rel01e, ['aggregate', 'missing_source_event_count']);
  const lookaheadSourceEventCount = numberAt(reports.rel01e, ['aggregate', 'lookahead_source_event_count']);
  const recomputeMismatchCount = numberAt(reports.rel01e, ['aggregate', 'recompute_mismatch_count']);
  const sourceHashMismatchCount = numberAt(reports.rel01e, ['aggregate', 'source_hash_mismatch_count']);
  const rel01dShadowFieldOccurrences = numberValue(rel01dPartitionCounts?.shadow);
  const rel01eShadowFieldOccurrences = numberAt(reports.rel01e, ['aggregate', 'shadow_field_occurrences']);
  const maskVersions = uniqueSortedNumbers([
    optionalNumberAt(reports.rel01d, ['audit_mask', 'mask_version']),
    optionalNumberAt(reports.rel01e, ['audit_mask', 'mask_version']),
  ]);
  const maskIds = uniqueSorted([
    stringAt(reports.rel01d, ['audit_mask', 'mask_id']),
    stringAt(reports.rel01e, ['audit_mask', 'mask_id']),
  ]);
  const maskHashes = uniqueSorted([
    stringAt(reports.rel01d, ['audit_mask', 'mask_hash']),
    stringAt(reports.rel01e, ['audit_mask', 'mask_hash']),
  ]);

  if (sourceScan.parse_errors > 0) reasons.push(`source_journal_parse_errors:${sourceScan.parse_errors}`);
  if (shadowScan.parse_errors > 0) reasons.push(`shadow_journal_parse_errors:${shadowScan.parse_errors}`);
  if (shadowScan.shadow_field_occurrences <= 0) reasons.push('shadow_field_occurrences_zero');
  if (
    shadowScan.shadow_field_occurrences !== rel01dShadowFieldOccurrences ||
    shadowScan.shadow_field_occurrences !== rel01eShadowFieldOccurrences
  ) {
    reasons.push(
      `shadow_field_occurrence_mismatch:local=${shadowScan.shadow_field_occurrences},rel01d=${rel01dShadowFieldOccurrences},rel01e=${rel01eShadowFieldOccurrences}`,
    );
  }
  if (maskVersions.length === 0) reasons.push('mask_version_missing');
  if (maskVersions.length > 1) reasons.push(`mask_version_mismatch:${maskVersions.join(',')}`);
  if (maskIds.length === 0) reasons.push('mask_id_missing');
  if (maskIds.length > 1) reasons.push(`mask_id_mismatch:${maskIds.join(',')}`);
  if (maskHashes.length === 0) reasons.push('mask_hash_missing');
  if (maskHashes.length > 1) reasons.push(`mask_hash_mismatch:${maskHashes.join(',')}`);
  if (realOrderEventTypes > 0) reasons.push(`real_order_event_types:${realOrderEventTypes}`);
  if (restrictedUses > 0) reasons.push(`restricted_uses:${restrictedUses}`);
  if (blockedUses > 0) reasons.push(`blocked_uses:${blockedUses}`);
  if (unsafeDecisionUseEventCount > 0) {
    reasons.push(`unsafe_decision_use_event_count:${unsafeDecisionUseEventCount}`);
  }
  if (missingSourceEventCount > 0) reasons.push(`missing_source_event_count:${missingSourceEventCount}`);
  if (lookaheadSourceEventCount > 0) reasons.push(`lookahead_source_event_count:${lookaheadSourceEventCount}`);
  if (recomputeMismatchCount > 0) reasons.push(`recompute_mismatch_count:${recomputeMismatchCount}`);
  if (sourceHashMismatchCount > 0) reasons.push(`source_hash_mismatch_count:${sourceHashMismatchCount}`);

  const orchActionCounts = objectToNumberRecord(objectAt(reports.orch, ['input', 'mbo_source_journal', 'action_counts']));
  const actionCounts = Object.keys(sourceScan.action_counts).length > 0
    ? sourceScan.action_counts
    : orchActionCounts;

  const summary: SessionEvidenceSummary = {
    session_id: input.session_id,
    run_id: input.run_id,
    status: reasons.length === 0 ? 'pass' : 'fail',
    files: {
      shadow_journal: reportPath(cwd, paths.shadow_journal),
      mbo_source_journal: reportPath(cwd, paths.mbo_source_journal),
      orch_report: reportPath(cwd, paths.orch_report),
      rel00_report: reportPath(cwd, paths.rel00_report),
      rel01d_report: reportPath(cwd, paths.rel01d_report),
      rel01e_report: reportPath(cwd, paths.rel01e_report),
    },
    source_hash: sourceHash,
    source_hashes_reported: sourceHashesReported,
    orch_status: orchStatus,
    rel00_status: rel00Status,
    rel01d_status: rel01dStatus,
    rel01e_status: rel01eStatus,
    source_mbo_events_indexed: numberAt(reports.orch, ['generation', 'source_mbo_events_indexed'])
      || sourceScan.source_event_count,
    shadow_events: numberAt(reports.orch, ['generation', 'shadow_events_emitted'])
      || shadowScan.shadow_events,
    shadow_field_occurrences: numberAt(reports.orch, ['generation', 'shadow_field_occurrences'])
      || shadowScan.shadow_field_occurrences,
    action_counts: actionCounts,
    side_counts: sourceScan.side_counts,
    distributions_by_field: distributionsByField(shadowScan.values_by_field),
    mask_binding: {
      mask_versions: maskVersions,
      mask_ids: maskIds,
      mask_hashes: maskHashes,
    },
    cross_validator: {
      local_shadow_field_occurrences: shadowScan.shadow_field_occurrences,
      rel01d_shadow_field_occurrences: rel01dShadowFieldOccurrences,
      rel01e_shadow_field_occurrences: rel01eShadowFieldOccurrences,
    },
    safety: {
      real_order_event_types: realOrderEventTypes,
      restricted_uses: restrictedUses,
      blocked_uses: blockedUses,
      unsafe_decision_use_event_count: unsafeDecisionUseEventCount,
      unsafe_decision_use_validator_count_sum: unsafeDecisionUseValidatorCountSum,
    },
    lineage: {
      missing_source_event_count: missingSourceEventCount,
      lookahead_source_event_count: lookaheadSourceEventCount,
      recompute_mismatch_count: recomputeMismatchCount,
      source_hash_mismatch_count: sourceHashMismatchCount,
    },
    reasons: uniqueSorted(reasons),
  };
  return {
    summary,
    values_by_field: shadowScan.values_by_field,
  };
}

function emptySourceScan(): SourceJournalScan {
  return {
    parse_errors: 0,
    source_event_count: 0,
    action_counts: {},
    side_counts: {},
  };
}

function emptyShadowScan(): ShadowJournalScan {
  return {
    parse_errors: 0,
    shadow_events: 0,
    shadow_field_occurrences: 0,
    unsafe_decision_use_event_count: 0,
    values_by_field: {},
  };
}

function stringAt(object: JsonObject | null, pathParts: readonly string[]): string | null {
  const value = valueAt(object, pathParts);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function numberAt(object: JsonObject | null, pathParts: readonly string[]): number {
  return numberValue(valueAt(object, pathParts));
}

function optionalNumberAt(object: JsonObject | null, pathParts: readonly string[]): number | null {
  const value = valueAt(object, pathParts);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function objectAt(object: JsonObject | null, pathParts: readonly string[]): JsonObject | null {
  const value = valueAt(object, pathParts);
  return isJsonObject(value) ? value : null;
}

function valueAt(object: JsonObject | null, pathParts: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = object ?? undefined;
  for (const part of pathParts) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function stringsAtArray(object: JsonObject | null, pathParts: readonly string[], field: string): readonly string[] {
  const value = valueAt(object, pathParts);
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (isJsonObject(item) ? item[field] : null))
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sumNumberRecord(record: JsonObject | null): number {
  if (record === null) {
    return 0;
  }
  return Object.values(record).reduce<number>((total, value) => total + numberValue(value), 0);
}

function objectToNumberRecord(object: JsonObject | null): Record<string, number> {
  const record: Record<string, number> = {};
  if (object === null) {
    return record;
  }
  for (const key of Object.keys(object).sort()) {
    const value = numberValue(object[key]);
    if (value > 0) {
      record[key] = value;
    }
  }
  return record;
}

function uniqueSorted(values: readonly (string | null | undefined)[]): readonly string[] {
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === 'string' && value.trim() !== '')),
  ).sort();
}

function uniqueSortedNumbers(values: readonly (number | null | undefined)[]): readonly number[] {
  return Array.from(
    new Set(values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))),
  ).sort((left, right) => left - right);
}

function buildAggregate(sessionWork: readonly SessionEvidenceWork[]): MboShadowEvidenceReport['aggregate'] {
  const sessions = sessionWork.map((work) => work.summary);
  const valuesByField = mergeValueRecords(...sessionWork.map((work) => work.values_by_field));
  const allSourceHashes = uniqueSorted(sessions.map((session) => session.source_hash));
  const maskVersions = uniqueSortedNumbers(sessions.flatMap((session) => session.mask_binding.mask_versions));
  const maskIds = uniqueSorted(sessions.flatMap((session) => session.mask_binding.mask_ids));
  const maskHashes = uniqueSorted(sessions.flatMap((session) => session.mask_binding.mask_hashes));
  const shadowFieldOccurrenceMismatchSessions = sessions
    .filter(
      (session) =>
        session.cross_validator.local_shadow_field_occurrences !==
          session.cross_validator.rel01d_shadow_field_occurrences ||
        session.cross_validator.local_shadow_field_occurrences !==
          session.cross_validator.rel01e_shadow_field_occurrences,
    )
    .map((session) => session.session_id)
    .sort();
  return {
    session_count: sessions.length,
    generated_sessions: sessions.filter((session) => session.orch_status === 'generated').length,
    rel00_pass_sessions: sessions.filter((session) => session.rel00_status === 'pass').length,
    rel01d_pass_sessions: sessions.filter((session) => session.rel01d_status === 'pass').length,
    rel01e_pass_sessions: sessions.filter((session) => session.rel01e_status === 'pass').length,
    source_mbo_events_indexed: sessions.reduce((total, session) => total + session.source_mbo_events_indexed, 0),
    shadow_events: sessions.reduce((total, session) => total + session.shadow_events, 0),
    shadow_field_occurrences: sessions.reduce((total, session) => total + session.shadow_field_occurrences, 0),
    action_counts: mergeCountRecords(...sessions.map((session) => session.action_counts)),
    side_counts: mergeCountRecords(...sessions.map((session) => session.side_counts)),
    source_hash_coverage: {
      sessions_with_source_hash: sessions.filter((session) => session.source_hash !== null).length,
      unique_source_hashes: allSourceHashes,
    },
    mask_binding: {
      mask_versions: maskVersions,
      mask_ids: maskIds,
      mask_hashes: maskHashes,
    },
    cross_validator: {
      shadow_field_occurrence_mismatch_sessions: shadowFieldOccurrenceMismatchSessions,
    },
    distributions_by_field: distributionsByField(valuesByField),
    safety: {
      real_order_event_types: sessions.reduce((total, session) => total + session.safety.real_order_event_types, 0),
      restricted_uses: sessions.reduce((total, session) => total + session.safety.restricted_uses, 0),
      blocked_uses: sessions.reduce((total, session) => total + session.safety.blocked_uses, 0),
      unsafe_decision_use_event_count: sessions.reduce(
        (max, session) => Math.max(max, session.safety.unsafe_decision_use_event_count),
        0,
      ),
      unsafe_decision_use_validator_count_sum: sessions.reduce(
        (total, session) => total + session.safety.unsafe_decision_use_validator_count_sum,
        0,
      ),
    },
    lineage: {
      missing_source_event_count: sessions.reduce(
        (total, session) => total + session.lineage.missing_source_event_count,
        0,
      ),
      lookahead_source_event_count: sessions.reduce(
        (total, session) => total + session.lineage.lookahead_source_event_count,
        0,
      ),
      recompute_mismatch_count: sessions.reduce(
        (total, session) => total + session.lineage.recompute_mismatch_count,
        0,
      ),
      source_hash_mismatch_count: sessions.reduce(
        (total, session) => total + session.lineage.source_hash_mismatch_count,
        0,
      ),
    },
  };
}

function checkBoolean(name: string, condition: boolean, detail: string): MboShadowEvidenceCheck {
  return {
    name,
    status: condition ? 'pass' : 'fail',
    detail,
  };
}

function group(name: string, checks: readonly MboShadowEvidenceCheck[]): MboShadowEvidenceCheckGroup {
  return {
    name,
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    checks,
  };
}

function buildCheckGroups(
  sessions: readonly SessionEvidenceSummary[],
  aggregate: MboShadowEvidenceReport['aggregate'],
): readonly MboShadowEvidenceCheckGroup[] {
  const failedSessions = sessions.filter((session) => session.status === 'fail').map((session) => session.session_id);
  return [
    group('packet_checks', [
      checkBoolean('sessions_present', sessions.length > 0, `${sessions.length} session(s)`),
      checkBoolean(
        'all_sessions_pass',
        failedSessions.length === 0,
        failedSessions.length === 0 ? 'all sessions pass' : `failed sessions: ${failedSessions.join(',')}`,
      ),
      checkBoolean(
        'all_session_files_exist_and_parse',
        failedSessions.length === 0 || sessions.some((session) => session.reasons.some((reason) => reason.startsWith('missing_file:') || reason.startsWith('malformed_report:'))) === false,
        failedSessions.length === 0 ? 'all session files loaded' : `failed sessions: ${failedSessions.join(',')}`,
      ),
    ]),
    group('validator_status_checks', [
      checkBoolean(
        'orch_mbo01_generated',
        aggregate.generated_sessions === sessions.length,
        `${aggregate.generated_sessions}/${sessions.length} generated`,
      ),
      checkBoolean(
        'rel00_passed',
        aggregate.rel00_pass_sessions === sessions.length,
        `${aggregate.rel00_pass_sessions}/${sessions.length} pass`,
      ),
      checkBoolean(
        'rel01d_passed',
        aggregate.rel01d_pass_sessions === sessions.length,
        `${aggregate.rel01d_pass_sessions}/${sessions.length} pass`,
      ),
      checkBoolean(
        'rel01e_passed',
        aggregate.rel01e_pass_sessions === sessions.length,
        `${aggregate.rel01e_pass_sessions}/${sessions.length} pass`,
      ),
    ]),
    group('safety_checks', [
      checkBoolean(
        'real_order_event_types_absent',
        aggregate.safety.real_order_event_types === 0,
        `${aggregate.safety.real_order_event_types} real-order event type(s)`,
      ),
      checkBoolean(
        'restricted_uses_absent',
        aggregate.safety.restricted_uses === 0,
        `${aggregate.safety.restricted_uses} restricted use(s)`,
      ),
      checkBoolean(
        'blocked_uses_absent',
        aggregate.safety.blocked_uses === 0,
        `${aggregate.safety.blocked_uses} blocked use(s)`,
      ),
      checkBoolean(
        'decision_use_violations_absent',
        aggregate.safety.unsafe_decision_use_event_count === 0,
        `${aggregate.safety.unsafe_decision_use_event_count} decision-use violation(s)`,
      ),
    ]),
    group('lineage_checks', [
      checkBoolean(
        'source_hashes_available',
        aggregate.source_hash_coverage.sessions_with_source_hash === sessions.length,
        `${aggregate.source_hash_coverage.sessions_with_source_hash}/${sessions.length} session(s) hash-bound`,
      ),
      checkBoolean(
        'missing_source_events_absent',
        aggregate.lineage.missing_source_event_count === 0,
        `${aggregate.lineage.missing_source_event_count} missing source event(s)`,
      ),
      checkBoolean(
        'lookahead_source_events_absent',
        aggregate.lineage.lookahead_source_event_count === 0,
        `${aggregate.lineage.lookahead_source_event_count} lookahead source event(s)`,
      ),
      checkBoolean(
        'recompute_mismatches_absent',
        aggregate.lineage.recompute_mismatch_count === 0,
        `${aggregate.lineage.recompute_mismatch_count} recompute mismatch(es)`,
      ),
      checkBoolean(
        'source_hash_mismatches_absent',
        aggregate.lineage.source_hash_mismatch_count === 0,
        `${aggregate.lineage.source_hash_mismatch_count} source hash mismatch(es)`,
      ),
    ]),
    group('mask_binding_checks', [
      checkBoolean(
        'mask_versions_present',
        aggregate.mask_binding.mask_versions.length > 0,
        `${aggregate.mask_binding.mask_versions.length} mask version(s)`,
      ),
      checkBoolean(
        'mask_versions_consistent',
        aggregate.mask_binding.mask_versions.length === 1,
        aggregate.mask_binding.mask_versions.join(',') || 'none',
      ),
      checkBoolean(
        'mask_ids_present',
        aggregate.mask_binding.mask_ids.length > 0,
        `${aggregate.mask_binding.mask_ids.length} mask id(s)`,
      ),
      checkBoolean(
        'mask_ids_consistent',
        aggregate.mask_binding.mask_ids.length === 1,
        aggregate.mask_binding.mask_ids.join(',') || 'none',
      ),
      checkBoolean(
        'mask_hashes_consistent',
        aggregate.mask_binding.mask_hashes.length === 1,
        aggregate.mask_binding.mask_hashes.join(',') || 'none',
      ),
    ]),
    group('cross_validator_checks', [
      checkBoolean(
        'shadow_field_occurrences_agree',
        aggregate.cross_validator.shadow_field_occurrence_mismatch_sessions.length === 0,
        aggregate.cross_validator.shadow_field_occurrence_mismatch_sessions.length === 0
          ? 'local scan, REL-01D, and REL-01E agree'
          : `mismatch sessions: ${aggregate.cross_validator.shadow_field_occurrence_mismatch_sessions.join(',')}`,
      ),
    ]),
    group('distribution_checks', [
      checkBoolean(
        'shadow_field_occurrences_present',
        aggregate.shadow_field_occurrences > 0,
        `${aggregate.shadow_field_occurrences} shadow field occurrence(s)`,
      ),
      checkBoolean(
        'shadow_distributions_present',
        Object.keys(aggregate.distributions_by_field).length > 0,
        `${Object.keys(aggregate.distributions_by_field).length} field distribution(s)`,
      ),
    ]),
  ];
}

function collectReasons(
  sessions: readonly SessionEvidenceSummary[],
  checkGroups: readonly MboShadowEvidenceCheckGroup[],
): readonly string[] {
  const reasons: string[] = [];
  for (const session of sessions) {
    for (const reason of session.reasons) {
      reasons.push(`${session.session_id}:${reason}`);
    }
  }
  for (const checkGroup of checkGroups) {
    for (const check of checkGroup.checks) {
      if (check.status === 'fail') {
        reasons.push(`${checkGroup.name}:${check.name}:${check.detail}`);
      }
    }
  }
  return uniqueSorted(reasons);
}

function classifyStatus(
  sessions: readonly SessionEvidenceSummary[],
  checkGroups: readonly MboShadowEvidenceCheckGroup[],
): MboShadowEvidenceStatus {
  if (sessions.length === 0) {
    return 'no_sessions';
  }
  return checkGroups.every((checkGroup) => checkGroup.status === 'pass') ? 'pass' : 'fail';
}

function buildMarkdown(report: MboShadowEvidenceReport): string {
  const lines = [
    '# MBO Shadow Evidence 01',
    '',
    `Status: ${report.status}`,
    '',
    'This report aggregates MBO shadow telemetry evidence only. It does not promote MBO fields to decision-use.',
    '',
    `MBO decision-use allowed: ${report.safety_posture.mbo_decision_use_allowed}`,
    `MBO derived feature status: ${report.safety_posture.mbo_derived_features_status}`,
    `Full DATA-01B status: ${report.safety_posture.data01b_full_status}`,
    '',
    '## Validator Chain',
    '',
    `- ORCH-MBO-01 generated sessions: ${report.aggregate.generated_sessions}/${report.aggregate.session_count}`,
    `- REL-00 pass sessions: ${report.aggregate.rel00_pass_sessions}/${report.aggregate.session_count}`,
    `- REL-01D pass sessions: ${report.aggregate.rel01d_pass_sessions}/${report.aggregate.session_count}`,
    `- REL-01E pass sessions: ${report.aggregate.rel01e_pass_sessions}/${report.aggregate.session_count}`,
    '',
    '## Key Metrics',
    '',
    `- Source MBO events indexed: ${report.aggregate.source_mbo_events_indexed}`,
    `- Shadow events: ${report.aggregate.shadow_events}`,
    `- Shadow field occurrences: ${report.aggregate.shadow_field_occurrences}`,
    `- Restricted uses: ${report.aggregate.safety.restricted_uses}`,
    `- Blocked uses: ${report.aggregate.safety.blocked_uses}`,
    `- Decision-use violations: ${report.aggregate.safety.unsafe_decision_use_event_count}`,
    `- Missing source events: ${report.aggregate.lineage.missing_source_event_count}`,
    `- Lookahead source events: ${report.aggregate.lineage.lookahead_source_event_count}`,
    `- Recompute mismatches: ${report.aggregate.lineage.recompute_mismatch_count}`,
    '',
    '## Shadow Distributions',
    '',
    '| Field | Count | Min | Mean | P50 | P90 | P99 | Max |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const field of Object.keys(report.aggregate.distributions_by_field).sort()) {
    const summary = report.aggregate.distributions_by_field[field];
    lines.push(
      `| ${field} | ${summary.count} | ${formatMetric(summary.min)} | ${formatMetric(summary.mean)} | ${formatMetric(summary.p50)} | ${formatMetric(summary.p90)} | ${formatMetric(summary.p99)} | ${formatMetric(summary.max)} |`,
    );
  }
  lines.push('', '## Sessions', '');
  for (const session of report.sessions) {
    lines.push(
      `- ${session.session_id}: ${session.status}, shadow_events=${session.shadow_events}, shadow_field_occurrences=${session.shadow_field_occurrences}`,
    );
  }
  if (report.reasons.length > 0) {
    lines.push('', '## Reasons', '');
    for (const reason of report.reasons) {
      lines.push(`- ${reason}`);
    }
  }
  lines.push('', `Next blocker: ${report.next_blocker}`, '');
  return lines.join('\n');
}

function formatMetric(value: number | null): string {
  return value === null ? '--' : String(value);
}

export function runMboShadowEvidence01(options: MboShadowEvidenceOptions): MboShadowEvidenceReport {
  const cwd = options.cwd ?? process.cwd();
  const manifestPath = resolveFromCwd(cwd, options.manifest);
  const outJsonPath = resolveFromCwd(cwd, options.outJson);
  const outMdPath = options.outMd === undefined ? undefined : resolveFromCwd(cwd, options.outMd);
  let manifest: MboShadowEvidenceManifest;
  let manifestHash: string | null = null;

  try {
    manifest = readManifest(manifestPath);
    manifestHash = sha256File(manifestPath);
  } catch (error) {
    const report = invalidReport(cwd, manifestPath, error instanceof Error ? error.message : String(error));
    writeReport(outJsonPath, outMdPath, report);
    return report;
  }

  const sessionWork = manifest.sessions.map((session) => validateSession(cwd, session));
  const sessions = sessionWork.map((work) => work.summary);
  const aggregate = buildAggregate(sessionWork);
  const checkGroups = buildCheckGroups(sessions, aggregate);
  const reasons = collectReasons(sessions, checkGroups);
  const status = classifyStatus(sessions, checkGroups);
  const report: MboShadowEvidenceReport = {
    schema_version: MBO_SHADOW_EVIDENCE_01_SCHEMA_VERSION,
    ticket_id: MBO_SHADOW_EVIDENCE_01_TICKET_ID,
    status,
    manifest: {
      path: reportPath(cwd, manifestPath),
      sha256: manifestHash,
      evidence_run_id: manifest.evidence_run_id,
      runtime_commit: manifest.runtime_commit ?? null,
      session_count: manifest.sessions.length,
    },
    safety_posture: SAFETY_POSTURE,
    aggregate,
    sessions,
    check_groups: checkGroups,
    reasons,
    no_raw_data_statement:
      'MBO-SHADOW-EVIDENCE-01 summarizes counts, hashes, statuses, and distribution statistics only; it does not embed raw MBO rows, raw journal payloads, or shadow source windows.',
    next_blocker:
      status === 'pass'
        ? 'Collect additional diagnostic sessions or proceed to MBO promotion-criteria review; MBO decision-use remains blocked.'
        : 'Fix MBO shadow evidence failures and rerun.',
  };
  writeReport(outJsonPath, outMdPath, report);
  return report;
}

function invalidReport(cwd: string, manifestPath: string, reason: string): MboShadowEvidenceReport {
  const aggregate: MboShadowEvidenceReport['aggregate'] = {
    session_count: 0,
    generated_sessions: 0,
    rel00_pass_sessions: 0,
    rel01d_pass_sessions: 0,
    rel01e_pass_sessions: 0,
    source_mbo_events_indexed: 0,
    shadow_events: 0,
    shadow_field_occurrences: 0,
    action_counts: {},
    side_counts: {},
    source_hash_coverage: {
      sessions_with_source_hash: 0,
      unique_source_hashes: [],
    },
    mask_binding: {
      mask_versions: [],
      mask_ids: [],
      mask_hashes: [],
    },
    cross_validator: {
      shadow_field_occurrence_mismatch_sessions: [],
    },
    distributions_by_field: {},
    safety: {
      real_order_event_types: 0,
      restricted_uses: 0,
      blocked_uses: 0,
      unsafe_decision_use_event_count: 0,
      unsafe_decision_use_validator_count_sum: 0,
    },
    lineage: {
      missing_source_event_count: 0,
      lookahead_source_event_count: 0,
      recompute_mismatch_count: 0,
      source_hash_mismatch_count: 0,
    },
  };
  const checkGroups = [
    group('packet_checks', [
      checkBoolean('manifest_valid', false, reason),
    ]),
  ];
  return {
    schema_version: MBO_SHADOW_EVIDENCE_01_SCHEMA_VERSION,
    ticket_id: MBO_SHADOW_EVIDENCE_01_TICKET_ID,
    status: 'fail',
    manifest: {
      path: reportPath(cwd, manifestPath),
      sha256: null,
      evidence_run_id: null,
      runtime_commit: null,
      session_count: 0,
    },
    safety_posture: SAFETY_POSTURE,
    aggregate,
    sessions: [],
    check_groups: checkGroups,
    reasons: [`manifest_invalid:${reason}`],
    no_raw_data_statement:
      'MBO-SHADOW-EVIDENCE-01 summarizes counts, hashes, statuses, and distribution statistics only; it does not embed raw MBO rows, raw journal payloads, or shadow source windows.',
    next_blocker: 'Fix MBO shadow evidence manifest and rerun.',
  };
}

function writeReport(outJsonPath: string, outMdPath: string | undefined, report: MboShadowEvidenceReport): void {
  mkdirSync(path.dirname(outJsonPath), { recursive: true });
  writeFileSync(outJsonPath, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
  if (outMdPath !== undefined) {
    mkdirSync(path.dirname(outMdPath), { recursive: true });
    writeFileSync(outMdPath, buildMarkdown(report), 'utf8');
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (processArgv[1] !== undefined && path.resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = runMboShadowEvidence01(defaultOptionsFromArgv(processArgv.slice(2)));
    processStdout.write(`MBO shadow evidence 01: ${report.status}\n`);
    processStdout.write(`manifest=${report.manifest.path}\n`);
    processStdout.write(`sessions=${report.aggregate.session_count}\n`);
    processStdout.write(`shadow_events=${report.aggregate.shadow_events}\n`);
    processStdout.write(`shadow_field_occurrences=${report.aggregate.shadow_field_occurrences}\n`);
    processExit(report.status === 'pass' ? 0 : 2);
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(2);
  }
}
