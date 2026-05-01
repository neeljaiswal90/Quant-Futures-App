import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  argv as processArgv,
  cwd as processCwd,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  journalEventFromJsonLine,
  stableJsonStringify,
  type JournalEventEnvelope,
  type JsonValue,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import {
  buildFeatureAvailabilityMask,
  type FeatureAvailabilityMask,
} from '../../apps/strategy_runtime/src/features/availability-mask.js';
import { forEachJsonlLine, sha256File } from '../sim/streaming-jsonl.js';
import type { Rel01aManifest, Rel01aSessionInput } from './rel-01a-aggregate-validator.js';

export const REL_01E_REPORT_SCHEMA_VERSION = 1 as const;
export const REL_01E_TICKET_ID = 'REL-01E' as const;

const DEFAULT_OUT_JSON = 'reports/rel/rel01e_mbo_shadow_lineage_report.json';
const DEFAULT_OUT_MD = 'reports/rel/rel01e_mbo_shadow_lineage_report.md';
const EXPECTED_MASK_VERSION = 5;
const EXPECTED_MASK_ID = 'feature-availability-mask-v5-adr0003-data-mbo03-advisory-policy';
const DEFAULT_NUMERIC_TOLERANCE = 1e-9;
const NO_RAW_DATA_STATEMENT =
  'REL-01E indexes journal paths, SHA-256 hashes, event identifiers, shadow field names, derivation methods, counts, and pass/fail reasons only. It does not embed raw MBO records, market-data payload values, shadow payload values, DBN files, or runtime journal payloads.';

type Rel01eStatus = 'pass' | 'fail' | 'no_shadow_telemetry';
type Rel01eExitCode = 0 | 2 | 3;
type DerivationStatus = 'pass' | 'fail' | 'unsupported' | 'not_applicable';
type SupportedShadowField =
  | 'cancel_add_ratio_shadow'
  | 'mbo_action_imbalance_shadow'
  | 'order_lifetime_shadow';

const SHADOW_FIELDS = new Set([
  'cancel_add_ratio_shadow',
  'order_lifetime_shadow',
  'absorption_score_shadow',
  'sweep_score_shadow',
  'mbo_action_imbalance_shadow',
]);

const SUPPORTED_METHODS: Readonly<Record<SupportedShadowField, string>> = {
  cancel_add_ratio_shadow: 'mbo_cancel_add_ratio_v1',
  mbo_action_imbalance_shadow: 'mbo_action_imbalance_v1',
  order_lifetime_shadow: 'mbo_order_lifetime_mean_ms_v1',
};

export interface Rel01eOptions {
  readonly cwd?: string;
  readonly manifest: string;
  readonly out_json?: string;
  readonly out_md?: string;
  readonly numeric_tolerance?: number;
}

type MutableRel01eOptions = {
  -readonly [K in keyof Rel01eOptions]?: Rel01eOptions[K];
};

interface Rel01eManifestSession extends Rel01aSessionInput {
  readonly mbo_source_journal?: string;
  readonly mbo_source_journal_sha256?: string;
}

interface Rel01eManifest extends Omit<Rel01aManifest, 'sessions'> {
  readonly sessions: readonly Rel01eManifestSession[];
}

export interface Rel01eReport {
  readonly schema_version: typeof REL_01E_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof REL_01E_TICKET_ID;
  readonly status: Rel01eStatus;
  readonly manifest: {
    readonly path: string;
    readonly sha256: string | null;
    readonly rel01_run_id: string | null;
    readonly session_count: number;
  };
  readonly audit_mask: {
    readonly mask_version: number;
    readonly mask_id: string;
    readonly mask_hash: string;
  };
  readonly numeric_tolerance: number;
  readonly sessions: readonly Rel01eSessionSummary[];
  readonly aggregate: Rel01eAggregateSummary;
  readonly check_groups: {
    readonly packet_checks: Rel01eCheckGroup;
    readonly shadow_presence_checks: Rel01eCheckGroup;
    readonly source_binding_checks: Rel01eCheckGroup;
    readonly causality_checks: Rel01eCheckGroup;
    readonly derivation_checks: Rel01eCheckGroup;
    readonly parse_checks: Rel01eCheckGroup;
  };
  readonly reasons: readonly string[];
  readonly no_raw_data_statement: typeof NO_RAW_DATA_STATEMENT;
  readonly next_blocker: string;
}

interface Rel01eSessionSummary {
  readonly session_id: string;
  readonly run_id: string;
  readonly journal_path: string;
  readonly journal_sha256: string | null;
  readonly journal_exists: boolean;
  readonly mbo_source_journal_path: string | null;
  readonly mbo_source_journal_sha256: string | null;
  readonly mbo_source_journal_exists: boolean | null;
  readonly mbo_source_events_indexed: number;
  readonly total_events: number;
  readonly shadow_events: number;
  readonly shadow_field_occurrences: number;
  readonly lineage_records: number;
  readonly missing_lineage_count: number;
  readonly missing_source_event_count: number;
  readonly lookahead_source_event_count: number;
  readonly source_hash_mismatch_count: number;
  readonly unsupported_shadow_field_count: number;
  readonly recompute_mismatch_count: number;
  readonly unsafe_decision_use_event_count: number;
  readonly parse_error_count: number;
  readonly malformed_source_count: number;
  readonly field_counts: readonly Rel01eFieldCount[];
  readonly derivation_results: readonly Rel01eDerivationResult[];
  readonly violation_examples: readonly Rel01eViolationExample[];
  readonly reasons: readonly string[];
}

interface Rel01eAggregateSummary {
  readonly session_count: number;
  readonly total_events: number;
  readonly shadow_events: number;
  readonly shadow_field_occurrences: number;
  readonly lineage_records: number;
  readonly missing_lineage_count: number;
  readonly missing_source_event_count: number;
  readonly lookahead_source_event_count: number;
  readonly source_hash_mismatch_count: number;
  readonly unsupported_shadow_field_count: number;
  readonly recompute_mismatch_count: number;
  readonly unsafe_decision_use_event_count: number;
  readonly parse_error_count: number;
  readonly malformed_source_count: number;
  readonly field_counts: readonly Rel01eFieldCount[];
  readonly derivation_results: readonly Rel01eDerivationResult[];
}

interface Rel01eFieldCount {
  readonly field: string;
  readonly count: number;
  readonly sessions: readonly string[];
}

interface Rel01eDerivationResult {
  readonly field: string;
  readonly derivation_method: string;
  readonly status: DerivationStatus;
  readonly count: number;
  readonly sessions: readonly string[];
}

interface Rel01eViolationExample {
  readonly session_id: string;
  readonly event_id: string;
  readonly field: string | null;
  readonly reason: string;
}

interface Rel01eCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail';
  readonly detail?: string;
}

interface Rel01eCheckGroup {
  readonly status: 'pass' | 'fail';
  readonly checks: readonly Rel01eCheck[];
}

interface SourceMboEvent {
  readonly event_id: string;
  readonly ts_ns: bigint;
  readonly action: 'add' | 'modify' | 'cancel' | 'unknown';
  readonly order_id: string | null;
}

interface SourceIndex {
  readonly path: string;
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly events: Map<string, SourceMboEvent>;
  readonly parse_error_count: number;
  readonly malformed_source_count: number;
}

interface SessionScanState {
  readonly session: Rel01eManifestSession;
  readonly cwd: string;
  readonly journalPath: string;
  readonly sourceIndex: SourceIndex | null;
  readonly sourceExpectedHash: string | null;
  readonly mask: FeatureAvailabilityMask;
  readonly tolerance: number;
  totalEvents: number;
  shadowEvents: number;
  shadowFieldOccurrences: number;
  lineageRecords: number;
  missingLineageCount: number;
  missingSourceEventCount: number;
  lookaheadSourceEventCount: number;
  sourceHashMismatchCount: number;
  unsupportedShadowFieldCount: number;
  recomputeMismatchCount: number;
  unsafeDecisionUseEventCount: number;
  parseErrorCount: number;
  readonly fieldCounts: Map<string, MutableFieldCount>;
  readonly derivationResults: Map<string, MutableDerivationResult>;
  readonly violationExamples: Rel01eViolationExample[];
  readonly reasons: Set<string>;
}

interface MutableFieldCount {
  readonly field: string;
  count: number;
  readonly sessions: Set<string>;
}

interface MutableDerivationResult {
  readonly field: string;
  readonly derivation_method: string;
  readonly status: DerivationStatus;
  count: number;
  readonly sessions: Set<string>;
}

interface ShadowLineage {
  readonly source_journal_sha256: string | null;
  readonly fields: Readonly<Record<string, ShadowFieldLineage>>;
}

interface ShadowFieldLineage {
  readonly derivation_method: string | null;
  readonly source_event_ids: readonly string[];
  readonly source_window_start_ts_ns: bigint | null;
  readonly source_window_end_ts_ns: bigint | null;
}

export async function runRel01eMboShadowLineage(
  options: Rel01eOptions,
): Promise<{ readonly report: Rel01eReport; readonly exit_code: Rel01eExitCode }> {
  const cwd = resolve(options.cwd ?? processCwd());
  const manifestPath = resolve(cwd, options.manifest);
  const outJson = resolve(cwd, options.out_json ?? DEFAULT_OUT_JSON);
  const outMd = resolve(cwd, options.out_md ?? DEFAULT_OUT_MD);
  const tolerance = options.numeric_tolerance ?? DEFAULT_NUMERIC_TOLERANCE;
  mkdirSync(dirname(outJson), { recursive: true });
  mkdirSync(dirname(outMd), { recursive: true });

  try {
    const manifest = readManifest(manifestPath);
    const mask = buildFeatureAvailabilityMask();
    const sourceIndexes = new Map<string, SourceIndex>();
    const sessions = manifest.sessions.map((session) => {
      const sourcePath = optionalSourcePath(cwd, session);
      const sourceIndex = sourcePath === null
        ? null
        : getSourceIndex(sourceIndexes, sourcePath);
      return scanSession({
        cwd,
        session,
        journalPath: resolve(cwd, session.journal),
        sourceIndex,
        sourceExpectedHash: session.mbo_source_journal_sha256 ?? null,
        mask,
        tolerance,
      });
    });
    const aggregate = aggregateSessions(sessions);
    const checkGroups = buildCheckGroups({ manifest, mask, sessions, aggregate });
    const reasons = Object.entries(checkGroups).flatMap(([groupName, group]) =>
      group.checks
        .filter((check) => check.status === 'fail')
        .map((check) => `${groupName}:${check.name}${check.detail === undefined ? '' : `: ${check.detail}`}`),
    );
    const status = classifyStatus(reasons, aggregate.shadow_field_occurrences);
    const report: Rel01eReport = {
      schema_version: REL_01E_REPORT_SCHEMA_VERSION,
      ticket_id: REL_01E_TICKET_ID,
      status,
      manifest: {
        path: toReportPath(cwd, manifestPath),
        sha256: sha256File(manifestPath),
        rel01_run_id: manifest.rel01_run_id ?? null,
        session_count: manifest.sessions.length,
      },
      audit_mask: {
        mask_version: mask.mask_version,
        mask_id: mask.mask_id,
        mask_hash: mask.mask_hash,
      },
      numeric_tolerance: tolerance,
      sessions,
      aggregate,
      check_groups: checkGroups,
      reasons,
      no_raw_data_statement: NO_RAW_DATA_STATEMENT,
      next_blocker: nextBlocker(status),
    };
    writeReport(outJson, outMd, report);
    return { report, exit_code: status === 'pass' ? 0 : 2 };
  } catch (error) {
    const report = invalidReport({
      cwd,
      manifestPath,
      tolerance,
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport(outJson, outMd, report);
    return { report, exit_code: 3 };
  }
}

function scanSession(input: {
  readonly cwd: string;
  readonly session: Rel01eManifestSession;
  readonly journalPath: string;
  readonly sourceIndex: SourceIndex | null;
  readonly sourceExpectedHash: string | null;
  readonly mask: FeatureAvailabilityMask;
  readonly tolerance: number;
}): Rel01eSessionSummary {
  const state: SessionScanState = {
    ...input,
    totalEvents: 0,
    shadowEvents: 0,
    shadowFieldOccurrences: 0,
    lineageRecords: 0,
    missingLineageCount: 0,
    missingSourceEventCount: 0,
    lookaheadSourceEventCount: 0,
    sourceHashMismatchCount: 0,
    unsupportedShadowFieldCount: 0,
    recomputeMismatchCount: 0,
    unsafeDecisionUseEventCount: 0,
    parseErrorCount: 0,
    fieldCounts: new Map(),
    derivationResults: new Map(),
    violationExamples: [],
    reasons: new Set(),
  };

  if (!existsSync(input.journalPath)) {
    state.reasons.add('runtime_journal_missing');
    return sessionSummary(state, null);
  }

  forEachJsonlLine(input.journalPath, (line) => {
    try {
      scanEvent(state, journalEventFromJsonLine(line));
    } catch {
      state.parseErrorCount += 1;
    }
  });

  if (state.parseErrorCount > 0) {
    state.reasons.add('runtime_journal_parse_errors');
  }
  if (input.sourceIndex !== null) {
    if (!input.sourceIndex.exists) state.reasons.add('mbo_source_journal_missing');
    if (input.sourceIndex.parse_error_count > 0) state.reasons.add('mbo_source_journal_parse_errors');
    if (input.sourceIndex.malformed_source_count > 0) state.reasons.add('mbo_source_journal_has_no_mbo_events');
    if (
      input.sourceExpectedHash !== null &&
      input.sourceIndex.sha256 !== null &&
      input.sourceExpectedHash !== input.sourceIndex.sha256
    ) {
      state.sourceHashMismatchCount += 1;
      state.reasons.add('manifest_mbo_source_hash_mismatch');
    }
  }
  if (state.shadowFieldOccurrences > 0 && input.sourceIndex === null) {
    state.reasons.add('mbo_source_journal_required_for_shadow_values');
  }
  if (state.missingLineageCount > 0) state.reasons.add('shadow_lineage_missing');
  if (state.missingSourceEventCount > 0) state.reasons.add('shadow_lineage_source_event_missing');
  if (state.lookaheadSourceEventCount > 0) state.reasons.add('shadow_lineage_lookahead_bias');
  if (state.sourceHashMismatchCount > 0) state.reasons.add('shadow_lineage_source_hash_mismatch');
  if (state.unsupportedShadowFieldCount > 0) state.reasons.add('unsupported_shadow_field');
  if (state.recomputeMismatchCount > 0) state.reasons.add('shadow_derivation_mismatch');
  if (state.unsafeDecisionUseEventCount > 0) state.reasons.add('shadow_payload_missing_decision_use_false');

  return sessionSummary(state, sha256File(input.journalPath));
}

function scanEvent(state: SessionScanState, event: JournalEventEnvelope): void {
  state.totalEvents += 1;
  const payload = jsonObject(event.payload);
  const shadowValues = jsonObject(payload?.shadow_values);
  if (shadowValues === null || Object.keys(shadowValues).length === 0) {
    return;
  }

  state.shadowEvents += 1;
  if (payload?.decision_use !== false) {
    state.unsafeDecisionUseEventCount += 1;
    addViolation(state, event, null, 'shadow_payload_missing_decision_use_false');
  }

  const lineage = parseShadowLineage(jsonObject(payload?.mbo_shadow_lineage));
  const sourceJournalSha256 = state.sourceIndex?.sha256 ?? null;
  const sourceHashMatches =
    lineage.source_journal_sha256 !== null &&
    sourceJournalSha256 !== null &&
    lineage.source_journal_sha256 === sourceJournalSha256;
  if (!sourceHashMatches) {
    state.sourceHashMismatchCount += 1;
    addViolation(state, event, null, 'shadow_lineage_source_hash_mismatch');
  }

  for (const field of Object.keys(shadowValues).sort()) {
    const value = shadowValues[field];
    state.shadowFieldOccurrences += 1;
    recordFieldCount(state, field);
    if (!SHADOW_FIELDS.has(field) || state.mask.field_tiers[field as keyof typeof state.mask.field_tiers] !== 'shadow_only') {
      state.unsupportedShadowFieldCount += 1;
      recordDerivation(state, field, 'unsupported', 'unsupported');
      addViolation(state, event, field, 'field_is_not_shadow_only');
      continue;
    }

    const fieldLineage = lineage.fields[field];
    if (fieldLineage === undefined) {
      state.missingLineageCount += 1;
      recordDerivation(state, field, 'missing', 'fail');
      addViolation(state, event, field, 'shadow_field_lineage_missing');
      continue;
    }
    state.lineageRecords += 1;
    validateFieldLineage(state, event, field, value, fieldLineage);
  }
}

function validateFieldLineage(
  state: SessionScanState,
  event: JournalEventEnvelope,
  field: string,
  value: unknown,
  lineage: ShadowFieldLineage,
): void {
  const method = lineage.derivation_method ?? 'missing';
  if (!isSupportedShadowField(field)) {
    state.unsupportedShadowFieldCount += 1;
    recordDerivation(state, field, method, 'unsupported');
    addViolation(state, event, field, 'unsupported_shadow_field');
    return;
  }

  if (method !== SUPPORTED_METHODS[field]) {
    state.unsupportedShadowFieldCount += 1;
    recordDerivation(state, field, method, 'unsupported');
    addViolation(state, event, field, 'unsupported_derivation_method');
    return;
  }

  const sourceEvents: SourceMboEvent[] = [];
  for (const sourceEventId of lineage.source_event_ids) {
    const sourceEvent = state.sourceIndex?.events.get(sourceEventId);
    if (sourceEvent === undefined) {
      state.missingSourceEventCount += 1;
      addViolation(state, event, field, 'source_event_missing');
      continue;
    }
    sourceEvents.push(sourceEvent);
    if (sourceEvent.ts_ns > event.ts_ns) {
      state.lookaheadSourceEventCount += 1;
      addViolation(state, event, field, 'source_event_after_shadow_event');
    }
    if (!sourceEventInDeclaredWindow(sourceEvent, lineage)) {
      state.lookaheadSourceEventCount += 1;
      addViolation(state, event, field, 'source_event_outside_declared_window');
    }
  }
  if (sourceEvents.length === 0) {
    recordDerivation(state, field, method, 'fail');
    return;
  }

  if (lineage.source_window_end_ts_ns !== null && lineage.source_window_end_ts_ns > event.ts_ns) {
    state.lookaheadSourceEventCount += 1;
    addViolation(state, event, field, 'source_window_end_after_shadow_event');
  }
  if (
    lineage.source_window_start_ts_ns !== null &&
    lineage.source_window_end_ts_ns !== null &&
    lineage.source_window_start_ts_ns > lineage.source_window_end_ts_ns
  ) {
    state.lookaheadSourceEventCount += 1;
    addViolation(state, event, field, 'source_window_start_after_end');
  }

  const recomputed = recomputeShadowField(field, sourceEvents);
  if (!sameShadowValue(value, recomputed, state.tolerance)) {
    state.recomputeMismatchCount += 1;
    recordDerivation(state, field, method, 'fail');
    addViolation(state, event, field, 'shadow_derivation_mismatch');
    return;
  }
  recordDerivation(state, field, method, 'pass');
}

function sourceEventInDeclaredWindow(sourceEvent: SourceMboEvent, lineage: ShadowFieldLineage): boolean {
  if (lineage.source_window_start_ts_ns !== null && sourceEvent.ts_ns < lineage.source_window_start_ts_ns) {
    return false;
  }
  if (lineage.source_window_end_ts_ns !== null && sourceEvent.ts_ns > lineage.source_window_end_ts_ns) {
    return false;
  }
  return true;
}

function recomputeShadowField(field: SupportedShadowField, sourceEvents: readonly SourceMboEvent[]): number | null {
  const addCount = sourceEvents.filter((event) => event.action === 'add').length;
  const cancelCount = sourceEvents.filter((event) => event.action === 'cancel').length;
  if (field === 'cancel_add_ratio_shadow') {
    return cancelCount / Math.max(1, addCount);
  }
  if (field === 'mbo_action_imbalance_shadow') {
    return (addCount - cancelCount) / Math.max(1, addCount + cancelCount);
  }

  const starts = new Map<string, bigint>();
  const lifetimesMs: number[] = [];
  for (const event of sourceEvents.slice().sort(compareSourceMboEvents)) {
    if (event.order_id === null) continue;
    if (event.action === 'add' && !starts.has(event.order_id)) {
      starts.set(event.order_id, event.ts_ns);
    }
    if (event.action === 'cancel') {
      const start = starts.get(event.order_id);
      if (start !== undefined && event.ts_ns >= start) {
        lifetimesMs.push(Number(event.ts_ns - start) / 1_000_000);
      }
    }
  }
  if (lifetimesMs.length === 0) return null;
  return lifetimesMs.reduce((total, value) => total + value, 0) / lifetimesMs.length;
}

function sameShadowValue(actual: unknown, expected: number | null, tolerance: number): boolean {
  if (expected === null) {
    return actual === null;
  }
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function getSourceIndex(cache: Map<string, SourceIndex>, sourcePath: string): SourceIndex {
  const existing = cache.get(sourcePath);
  if (existing !== undefined) return existing;
  const index = scanSourceMboJournal(sourcePath);
  cache.set(sourcePath, index);
  return index;
}

function scanSourceMboJournal(sourcePath: string): SourceIndex {
  const events = new Map<string, SourceMboEvent>();
  const index: SourceIndex = {
    path: sourcePath,
    exists: existsSync(sourcePath),
    sha256: existsSync(sourcePath) ? sha256File(sourcePath) : null,
    events,
    parse_error_count: 0,
    malformed_source_count: 0,
  };
  if (!index.exists) return index;

  let parseErrorCount = 0;
  let malformedSourceCount = 0;
  forEachJsonlLine(sourcePath, (line) => {
    try {
      const event = journalEventFromJsonLine(line);
      const source = sourceMboEventFromJournalEvent(event);
      if (source === null) {
        malformedSourceCount += 1;
        return;
      }
      events.set(source.event_id, source);
    } catch {
      parseErrorCount += 1;
    }
  });
  return {
    ...index,
    parse_error_count: parseErrorCount,
    malformed_source_count: events.size === 0 ? malformedSourceCount : 0,
  };
}

function sourceMboEventFromJournalEvent(event: JournalEventEnvelope): SourceMboEvent | null {
  const payload = jsonObject(event.payload);
  if (payload === null) return null;
  const source = stringValue(payload.source);
  const kind = stringValue(payload.microstructure_kind);
  if (
    event.type !== 'MICROSTRUCTURE' ||
    ![source, kind].some((value) => value !== null && value.startsWith('mbo_'))
  ) {
    return null;
  }
  return {
    event_id: String(event.event_id),
    ts_ns: BigInt(event.ts_ns),
    action: normalizeMboAction(payload.action ?? payload.raw_action),
    order_id: stringValue(payload.order_id),
  };
}

function normalizeMboAction(value: unknown): SourceMboEvent['action'] {
  if (value === 'add' || value === 'new') return 'add';
  if (value === 'modify' || value === 'change') return 'modify';
  if (value === 'cancel' || value === 'delete') return 'cancel';
  return 'unknown';
}

function parseShadowLineage(lineage: Record<string, unknown> | null): ShadowLineage {
  if (lineage === null) {
    return { source_journal_sha256: null, fields: {} };
  }
  const fields = jsonObject(lineage.fields);
  const parsedFields: Record<string, ShadowFieldLineage> = {};
  if (fields !== null) {
    for (const field of Object.keys(fields).sort()) {
      const value = jsonObject(fields[field]);
      if (value === null) continue;
      parsedFields[field] = {
        derivation_method: stringValue(value.derivation_method),
        source_event_ids: stringArray(value.source_event_ids),
        source_window_start_ts_ns: optionalBigInt(value.source_window_start_ts_ns),
        source_window_end_ts_ns: optionalBigInt(value.source_window_end_ts_ns),
      };
    }
  }
  return {
    source_journal_sha256: stringValue(lineage.source_journal_sha256),
    fields: parsedFields,
  };
}

function sessionSummary(state: SessionScanState, journalSha256: string | null): Rel01eSessionSummary {
  return {
    session_id: state.session.session_id,
    run_id: state.session.run_id,
    journal_path: toReportPath(state.cwd, state.journalPath),
    journal_sha256: journalSha256,
    journal_exists: existsSync(state.journalPath),
    mbo_source_journal_path: state.sourceIndex === null ? null : toReportPath(state.cwd, state.sourceIndex.path),
    mbo_source_journal_sha256: state.sourceIndex?.sha256 ?? null,
    mbo_source_journal_exists: state.sourceIndex?.exists ?? null,
    mbo_source_events_indexed: state.sourceIndex?.events.size ?? 0,
    total_events: state.totalEvents,
    shadow_events: state.shadowEvents,
    shadow_field_occurrences: state.shadowFieldOccurrences,
    lineage_records: state.lineageRecords,
    missing_lineage_count: state.missingLineageCount,
    missing_source_event_count: state.missingSourceEventCount,
    lookahead_source_event_count: state.lookaheadSourceEventCount,
    source_hash_mismatch_count: state.sourceHashMismatchCount,
    unsupported_shadow_field_count: state.unsupportedShadowFieldCount,
    recompute_mismatch_count: state.recomputeMismatchCount,
    unsafe_decision_use_event_count: state.unsafeDecisionUseEventCount,
    parse_error_count: state.parseErrorCount,
    malformed_source_count: state.sourceIndex?.malformed_source_count ?? 0,
    field_counts: sortedFieldCounts(state.fieldCounts),
    derivation_results: sortedDerivationResults(state.derivationResults),
    violation_examples: state.violationExamples,
    reasons: [...state.reasons].sort(),
  };
}

function aggregateSessions(sessions: readonly Rel01eSessionSummary[]): Rel01eAggregateSummary {
  const fieldCounts = new Map<string, MutableFieldCount>();
  const derivationResults = new Map<string, MutableDerivationResult>();
  for (const session of sessions) {
    for (const field of session.field_counts) {
      const existing = fieldCounts.get(field.field) ?? {
        field: field.field,
        count: 0,
        sessions: new Set<string>(),
      };
      existing.count += field.count;
      for (const sessionId of field.sessions) existing.sessions.add(sessionId);
      fieldCounts.set(field.field, existing);
    }
    for (const result of session.derivation_results) {
      const key = derivationResultKey(result.field, result.derivation_method, result.status);
      const existing = derivationResults.get(key) ?? {
        field: result.field,
        derivation_method: result.derivation_method,
        status: result.status,
        count: 0,
        sessions: new Set<string>(),
      };
      existing.count += result.count;
      for (const sessionId of result.sessions) existing.sessions.add(sessionId);
      derivationResults.set(key, existing);
    }
  }
  return {
    session_count: sessions.length,
    total_events: sum(sessions.map((session) => session.total_events)),
    shadow_events: sum(sessions.map((session) => session.shadow_events)),
    shadow_field_occurrences: sum(sessions.map((session) => session.shadow_field_occurrences)),
    lineage_records: sum(sessions.map((session) => session.lineage_records)),
    missing_lineage_count: sum(sessions.map((session) => session.missing_lineage_count)),
    missing_source_event_count: sum(sessions.map((session) => session.missing_source_event_count)),
    lookahead_source_event_count: sum(sessions.map((session) => session.lookahead_source_event_count)),
    source_hash_mismatch_count: sum(sessions.map((session) => session.source_hash_mismatch_count)),
    unsupported_shadow_field_count: sum(sessions.map((session) => session.unsupported_shadow_field_count)),
    recompute_mismatch_count: sum(sessions.map((session) => session.recompute_mismatch_count)),
    unsafe_decision_use_event_count: sum(sessions.map((session) => session.unsafe_decision_use_event_count)),
    parse_error_count: sum(sessions.map((session) => session.parse_error_count)),
    malformed_source_count: sum(sessions.map((session) => session.malformed_source_count)),
    field_counts: sortedFieldCounts(fieldCounts),
    derivation_results: sortedDerivationResults(derivationResults),
  };
}

function buildCheckGroups(input: {
  readonly manifest: Rel01eManifest;
  readonly mask: FeatureAvailabilityMask;
  readonly sessions: readonly Rel01eSessionSummary[];
  readonly aggregate: Rel01eAggregateSummary;
}): Rel01eReport['check_groups'] {
  return {
    packet_checks: group([
      check('manifest_schema_version_is_1', input.manifest.schema_version === 1),
      check('session_count_positive', input.manifest.sessions.length > 0),
      check('all_runtime_journals_exist', input.sessions.every((session) => session.journal_exists), missingSessions(input.sessions, (session) => !session.journal_exists)),
    ]),
    shadow_presence_checks: group([
      check('shadow_telemetry_present', input.aggregate.shadow_field_occurrences > 0, `shadow_fields=${input.aggregate.shadow_field_occurrences}`),
      check('all_shadow_fields_have_lineage', input.aggregate.missing_lineage_count === 0, `missing=${input.aggregate.missing_lineage_count}`),
    ]),
    source_binding_checks: group([
      check('audit_mask_version_is_v5', input.mask.mask_version === EXPECTED_MASK_VERSION, `mask_version=${input.mask.mask_version}`),
      check('audit_mask_id_is_data_mbo03_advisory_policy', input.mask.mask_id === EXPECTED_MASK_ID, input.mask.mask_id),
      check('mbo_source_journals_exist_when_shadow_present', input.sessions.every((session) => session.shadow_field_occurrences === 0 || session.mbo_source_journal_exists === true), missingSessions(input.sessions, (session) => session.shadow_field_occurrences > 0 && session.mbo_source_journal_exists !== true)),
      check('source_journal_hashes_match_manifest_and_lineage', input.aggregate.source_hash_mismatch_count === 0, `mismatches=${input.aggregate.source_hash_mismatch_count}`),
      check('all_lineage_source_events_exist', input.aggregate.missing_source_event_count === 0, `missing=${input.aggregate.missing_source_event_count}`),
    ]),
    causality_checks: group([
      check('source_events_do_not_look_ahead', input.aggregate.lookahead_source_event_count === 0, `lookahead=${input.aggregate.lookahead_source_event_count}`),
      check('shadow_payloads_have_decision_use_false', input.aggregate.unsafe_decision_use_event_count === 0, `unsafe=${input.aggregate.unsafe_decision_use_event_count}`),
    ]),
    derivation_checks: group([
      check('all_shadow_fields_are_supported', input.aggregate.unsupported_shadow_field_count === 0, `unsupported=${input.aggregate.unsupported_shadow_field_count}`),
      check('all_shadow_values_recompute', input.aggregate.recompute_mismatch_count === 0, `mismatches=${input.aggregate.recompute_mismatch_count}`),
    ]),
    parse_checks: group([
      check('runtime_journals_parse', input.aggregate.parse_error_count === 0, `parse_errors=${input.aggregate.parse_error_count}`),
      check('mbo_source_journals_parse_and_contain_mbo_events', input.aggregate.malformed_source_count === 0, `malformed=${input.aggregate.malformed_source_count}`),
    ]),
  };
}

function classifyStatus(reasons: readonly string[], shadowFieldOccurrences: number): Rel01eStatus {
  if (reasons.some((reason) => !reason.includes('shadow_telemetry_present'))) return 'fail';
  return shadowFieldOccurrences > 0 ? 'pass' : 'no_shadow_telemetry';
}

function invalidReport(input: {
  readonly cwd: string;
  readonly manifestPath: string;
  readonly tolerance: number;
  readonly reason: string;
}): Rel01eReport {
  const mask = buildFeatureAvailabilityMask();
  return {
    schema_version: REL_01E_REPORT_SCHEMA_VERSION,
    ticket_id: REL_01E_TICKET_ID,
    status: 'fail',
    manifest: {
      path: toReportPath(input.cwd, input.manifestPath),
      sha256: existsSync(input.manifestPath) ? sha256File(input.manifestPath) : null,
      rel01_run_id: null,
      session_count: 0,
    },
    audit_mask: {
      mask_version: mask.mask_version,
      mask_id: mask.mask_id,
      mask_hash: mask.mask_hash,
    },
    numeric_tolerance: input.tolerance,
    sessions: [],
    aggregate: emptyAggregate(),
    check_groups: {
      packet_checks: group([check('valid_input', false, input.reason)]),
      shadow_presence_checks: group([]),
      source_binding_checks: group([]),
      causality_checks: group([]),
      derivation_checks: group([]),
      parse_checks: group([]),
    },
    reasons: [`invalid_input:${input.reason}`],
    no_raw_data_statement: NO_RAW_DATA_STATEMENT,
    next_blocker: 'Fix REL-01E audit input and rerun.',
  };
}

function readManifest(path: string): Rel01eManifest {
  if (!existsSync(path)) {
    throw new Error(`REL-01E manifest not found: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Rel01eManifest>;
  if (parsed.schema_version !== 1) {
    throw new Error('REL-01E manifest schema_version must be 1');
  }
  if (!Array.isArray(parsed.sessions)) {
    throw new Error('REL-01E manifest sessions must be an array');
  }
  for (const [index, session] of parsed.sessions.entries()) {
    if (
      typeof session.session_id !== 'string' ||
      typeof session.run_id !== 'string' ||
      typeof session.journal !== 'string'
    ) {
      throw new Error(`REL-01E manifest session ${index} must include session_id, run_id, and journal`);
    }
  }
  return parsed as Rel01eManifest;
}

function optionalSourcePath(cwd: string, session: Rel01eManifestSession): string | null {
  return typeof session.mbo_source_journal === 'string'
    ? resolve(cwd, session.mbo_source_journal)
    : null;
}

function recordFieldCount(state: SessionScanState, field: string): void {
  const existing = state.fieldCounts.get(field) ?? {
    field,
    count: 0,
    sessions: new Set<string>(),
  };
  existing.count += 1;
  existing.sessions.add(state.session.session_id);
  state.fieldCounts.set(field, existing);
}

function recordDerivation(
  state: SessionScanState,
  field: string,
  method: string,
  status: DerivationStatus,
): void {
  const key = derivationResultKey(field, method, status);
  const existing = state.derivationResults.get(key) ?? {
    field,
    derivation_method: method,
    status,
    count: 0,
    sessions: new Set<string>(),
  };
  existing.count += 1;
  existing.sessions.add(state.session.session_id);
  state.derivationResults.set(key, existing);
}

function derivationResultKey(field: string, method: string, status: DerivationStatus): string {
  return `${field}:${method}:${status}`;
}

function sortedFieldCounts(fieldCounts: Map<string, MutableFieldCount>): readonly Rel01eFieldCount[] {
  return [...fieldCounts.values()]
    .map((field) => ({
      field: field.field,
      count: field.count,
      sessions: [...field.sessions].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
}

function sortedDerivationResults(results: Map<string, MutableDerivationResult>): readonly Rel01eDerivationResult[] {
  return [...results.values()]
    .map((result) => ({
      field: result.field,
      derivation_method: result.derivation_method,
      status: result.status,
      count: result.count,
      sessions: [...result.sessions].sort(),
    }))
    .sort((a, b) =>
      a.field.localeCompare(b.field) ||
      a.derivation_method.localeCompare(b.derivation_method) ||
      a.status.localeCompare(b.status)
    );
}

function addViolation(
  state: SessionScanState,
  event: JournalEventEnvelope,
  field: string | null,
  reason: string,
): void {
  if (state.violationExamples.length >= 20) return;
  state.violationExamples.push({
    session_id: state.session.session_id,
    event_id: String(event.event_id),
    field,
    reason,
  });
}

function group(checks: readonly Rel01eCheck[]): Rel01eCheckGroup {
  return {
    status: checks.every((item) => item.status === 'pass') ? 'pass' : 'fail',
    checks,
  };
}

function check(name: string, condition: boolean, detail?: string): Rel01eCheck {
  return {
    name,
    status: condition ? 'pass' : 'fail',
    ...(detail === undefined || detail === '' ? {} : { detail }),
  };
}

function missingSessions(
  sessions: readonly Rel01eSessionSummary[],
  predicate: (session: Rel01eSessionSummary) => boolean,
): string {
  return sessions.filter(predicate).map((session) => session.session_id).sort().join(',');
}

function emptyAggregate(): Rel01eAggregateSummary {
  return {
    session_count: 0,
    total_events: 0,
    shadow_events: 0,
    shadow_field_occurrences: 0,
    lineage_records: 0,
    missing_lineage_count: 0,
    missing_source_event_count: 0,
    lookahead_source_event_count: 0,
    source_hash_mismatch_count: 0,
    unsupported_shadow_field_count: 0,
    recompute_mismatch_count: 0,
    unsafe_decision_use_event_count: 0,
    parse_error_count: 0,
    malformed_source_count: 0,
    field_counts: [],
    derivation_results: [],
  };
}

function nextBlocker(status: Rel01eStatus): string {
  if (status === 'pass') {
    return 'REL-01E MBO shadow lineage is valid; keep MBO decision-use blocked until policy promotion.';
  }
  if (status === 'no_shadow_telemetry') {
    return 'Generate lineage-rich MBO shadow telemetry before claiming REL-01E coverage.';
  }
  return 'Resolve failed REL-01E MBO shadow lineage checks, then rerun.';
}

function isSupportedShadowField(field: string): field is SupportedShadowField {
  return Object.hasOwn(SUPPORTED_METHODS, field);
}

function compareSourceMboEvents(a: SourceMboEvent, b: SourceMboEvent): number {
  return a.ts_ns < b.ts_ns ? -1 : a.ts_ns > b.ts_ns ? 1 : a.event_id.localeCompare(b.event_id);
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

function optionalBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value);
  return null;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function writeReport(outJson: string, outMd: string, report: Rel01eReport): void {
  writeFileSync(outJson, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
  writeFileSync(outMd, formatRel01eSummary(report), 'utf8');
}

export function formatRel01eSummary(report: Rel01eReport): string {
  const lines = [
    '# REL-01E MBO Shadow Lineage Report',
    '',
    `status: ${report.status}`,
    `manifest: ${report.manifest.path}`,
    `sessions: ${report.aggregate.session_count}`,
    `shadow_events: ${report.aggregate.shadow_events}`,
    `shadow_field_occurrences: ${report.aggregate.shadow_field_occurrences}`,
    `lineage_records: ${report.aggregate.lineage_records}`,
    `missing_lineage_count: ${report.aggregate.missing_lineage_count}`,
    `missing_source_event_count: ${report.aggregate.missing_source_event_count}`,
    `lookahead_source_event_count: ${report.aggregate.lookahead_source_event_count}`,
    `recompute_mismatch_count: ${report.aggregate.recompute_mismatch_count}`,
    `unsupported_shadow_field_count: ${report.aggregate.unsupported_shadow_field_count}`,
    '',
    '## Field Counts',
    ...report.aggregate.field_counts.map((field) => `- ${field.field}: ${field.count} (${field.sessions.join(', ')})`),
    '',
    '## Derivations',
    ...report.aggregate.derivation_results.map((result) =>
      `- ${result.field} / ${result.derivation_method} / ${result.status}: ${result.count}`,
    ),
    '',
    '## Checks',
    ...Object.entries(report.check_groups).map(([name, group]) => `- ${name}: ${group.status}`),
    '',
    '## Reasons',
    ...(report.reasons.length === 0 ? ['- none'] : report.reasons.map((reason) => `- ${reason}`)),
    '',
    `next_blocker: ${report.next_blocker}`,
    '',
    report.no_raw_data_statement,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function toReportPath(cwd: string, path: string): string {
  return relative(cwd, path).replace(/\\/gu, '/');
}

function parseArgs(argv: readonly string[]): Rel01eOptions {
  const options: MutableRel01eOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--manifest':
        options.manifest = next();
        break;
      case '--out-json':
        options.out_json = next();
        break;
      case '--out-md':
        options.out_md = next();
        break;
      case '--numeric-tolerance':
        options.numeric_tolerance = Number(next());
        break;
      case '--help':
        processStdout.write([
          'Usage: npm run rel:01e:mbo-shadow-lineage -- --manifest <rel01_manifest.json> [--out-json <path>] [--out-md <path>]',
          '',
        ].join('\n'));
        processExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.manifest === undefined) {
    throw new Error('--manifest is required');
  }
  if (options.numeric_tolerance !== undefined && (!Number.isFinite(options.numeric_tolerance) || options.numeric_tolerance < 0)) {
    throw new Error('--numeric-tolerance must be a non-negative finite number');
  }
  return options as Rel01eOptions;
}

async function main(): Promise<void> {
  try {
    const result = await runRel01eMboShadowLineage(parseArgs(processArgv.slice(2)));
    processStdout.write(`REL-01E MBO shadow lineage: ${result.report.status}\n`);
    processStdout.write(`next_blocker=${result.report.next_blocker}\n`);
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
