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
  type FeatureAvailabilityTier,
} from '../../apps/strategy_runtime/src/features/availability-mask.js';
import { forEachJsonlLine, sha256File } from '../sim/streaming-jsonl.js';
import type { Rel01aManifest, Rel01aSessionInput } from './rel-01a-aggregate-validator.js';

export const REL_01D_REPORT_SCHEMA_VERSION = 1 as const;
export const REL_01D_TICKET_ID = 'REL-01D' as const;

const DEFAULT_OUT_JSON = 'reports/rel/rel01d_feature_surface_audit.json';
const DEFAULT_OUT_MD = 'reports/rel/rel01d_feature_surface_audit.md';
const EXPECTED_MASK_VERSION = 4;
const EXPECTED_MASK_ID = 'feature-availability-mask-v4-adr0002-data03ps-mbo-shadow';
const NO_RAW_DATA_STATEMENT =
  'REL-01D indexes journal paths, SHA-256 hashes, event counts, field names, feature tiers, contexts, and usage counts only. It does not embed raw market-data rows, payload values, order payload values, DBN files, or runtime journal payloads.';

type Rel01dStatus = 'pass' | 'fail';
type Rel01dExitCode = 0 | 2 | 3;
type FeatureContext = 'values' | 'diagnostic_values' | 'shadow_values' | 'decision_payload';
type FeaturePartition =
  | 'authoritative'
  | 'diagnostic'
  | 'shadow'
  | 'restricted'
  | 'blocked'
  | 'invalid_diagnostic'
  | 'invalid_shadow'
  | 'unknown';

const FEATURE_SURFACE_EVENT_TYPES = new Set(['FEATURES', 'MICROSTRUCTURE']);
const DECISION_EVENT_TYPES = new Set([
  'STRAT_EVAL',
  'CANDIDATE',
  'RANK',
  'RISK_GATE',
  'SIZING',
  'ORDER_INTENT',
  'SIM_FILL',
]);

export interface Rel01dOptions {
  readonly cwd?: string;
  readonly manifest: string;
  readonly out_json?: string;
  readonly out_md?: string;
}

type MutableRel01dOptions = {
  -readonly [K in keyof Rel01dOptions]?: Rel01dOptions[K];
};

export interface Rel01dReport {
  readonly schema_version: typeof REL_01D_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof REL_01D_TICKET_ID;
  readonly status: Rel01dStatus;
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
  readonly sessions: readonly Rel01dSessionSummary[];
  readonly aggregate: Rel01dAggregateSummary;
  readonly check_groups: {
    readonly packet_checks: Rel01dCheckGroup;
    readonly mask_binding_checks: Rel01dCheckGroup;
    readonly decision_surface_checks: Rel01dCheckGroup;
    readonly shadow_diagnostic_checks: Rel01dCheckGroup;
    readonly parse_checks: Rel01dCheckGroup;
  };
  readonly reasons: readonly string[];
  readonly no_raw_data_statement: typeof NO_RAW_DATA_STATEMENT;
  readonly next_blocker: string;
}

interface Rel01dSessionSummary {
  readonly session_id: string;
  readonly run_id: string;
  readonly journal_path: string;
  readonly journal_sha256: string | null;
  readonly journal_exists: boolean;
  readonly total_events: number;
  readonly checked_feature_events: number;
  readonly checked_decision_events: number;
  readonly parse_error_count: number;
  readonly embedded_mask_events: number;
  readonly embedded_mask_missing_events: number;
  readonly embedded_mask_mismatch_count: number;
  readonly unsafe_shadow_or_diagnostic_decision_use_event_count: number;
  readonly partition_counts: Record<FeaturePartition, number>;
  readonly field_usage_by_partition: Rel01dFieldUsageByPartition;
  readonly reasons: readonly string[];
}

interface Rel01dAggregateSummary {
  readonly session_count: number;
  readonly total_events: number;
  readonly checked_feature_events: number;
  readonly checked_decision_events: number;
  readonly parse_error_count: number;
  readonly embedded_mask_mismatch_count: number;
  readonly unsafe_shadow_or_diagnostic_decision_use_event_count: number;
  readonly partition_counts: Record<FeaturePartition, number>;
  readonly field_usage_by_partition: Rel01dFieldUsageByPartition;
}

interface Rel01dFieldUsageByPartition {
  readonly authoritative: readonly Rel01dFieldUsage[];
  readonly diagnostic: readonly Rel01dFieldUsage[];
  readonly shadow: readonly Rel01dFieldUsage[];
  readonly restricted: readonly Rel01dFieldUsage[];
  readonly blocked: readonly Rel01dFieldUsage[];
  readonly invalid_diagnostic: readonly Rel01dFieldUsage[];
  readonly invalid_shadow: readonly Rel01dFieldUsage[];
  readonly unknown: readonly Rel01dFieldUsage[];
}

interface Rel01dFieldUsage {
  readonly event_type: string;
  readonly context: FeatureContext;
  readonly field: string;
  readonly canonical_field: string;
  readonly tier: FeatureAvailabilityTier | 'unknown';
  readonly count: number;
  readonly sessions: readonly string[];
}

interface MutableFieldUsage {
  readonly event_type: string;
  readonly context: FeatureContext;
  readonly field: string;
  readonly canonical_field: string;
  readonly tier: FeatureAvailabilityTier | 'unknown';
  count: number;
  readonly sessions: Set<string>;
}

interface Rel01dCheck {
  readonly name: string;
  readonly status: Rel01dStatus;
  readonly detail?: string;
}

interface Rel01dCheckGroup {
  readonly status: Rel01dStatus;
  readonly checks: readonly Rel01dCheck[];
}

interface SessionScanState {
  readonly session: Rel01aSessionInput;
  readonly cwd: string;
  readonly journalPath: string;
  readonly mask: FeatureAvailabilityMask;
  totalEvents: number;
  checkedFeatureEvents: number;
  checkedDecisionEvents: number;
  parseErrorCount: number;
  embeddedMaskEvents: number;
  embeddedMaskMissingEvents: number;
  embeddedMaskMismatchCount: number;
  unsafeDecisionUseEventCount: number;
  readonly fieldUses: Map<string, MutableFieldUsage>;
  readonly reasons: Set<string>;
}

export async function runRel01dFeatureSurfaceAudit(
  options: Rel01dOptions,
): Promise<{ readonly report: Rel01dReport; readonly exit_code: Rel01dExitCode }> {
  const cwd = resolve(options.cwd ?? processCwd());
  const manifestPath = resolve(cwd, options.manifest);
  const outJson = resolve(cwd, options.out_json ?? DEFAULT_OUT_JSON);
  const outMd = resolve(cwd, options.out_md ?? DEFAULT_OUT_MD);
  mkdirSync(dirname(outJson), { recursive: true });
  mkdirSync(dirname(outMd), { recursive: true });

  try {
    const manifest = readManifest(manifestPath);
    const mask = buildFeatureAvailabilityMask();
    const sessions = manifest.sessions.map((session) => scanSession({
      cwd,
      session,
      mask,
      journalPath: resolve(cwd, session.journal),
    }));
    const aggregate = aggregateSessions(sessions);
    const checkGroups = buildCheckGroups({
      manifest,
      sessions,
      aggregate,
      mask,
    });
    const reasons = Object.entries(checkGroups).flatMap(([groupName, group]) =>
      group.checks
        .filter((check) => check.status === 'fail')
        .map((check) => `${groupName}:${check.name}: ${check.detail ?? 'failed'}`),
    );
    const report: Rel01dReport = {
      schema_version: REL_01D_REPORT_SCHEMA_VERSION,
      ticket_id: REL_01D_TICKET_ID,
      status: reasons.length === 0 ? 'pass' : 'fail',
      manifest: {
        path: toReportPath(cwd, manifestPath),
        sha256: sha256File(manifestPath),
        rel01_run_id: manifest.rel01_run_id,
        session_count: manifest.sessions.length,
      },
      audit_mask: {
        mask_version: mask.mask_version,
        mask_id: mask.mask_id,
        mask_hash: mask.mask_hash,
      },
      sessions,
      aggregate,
      check_groups: checkGroups,
      reasons,
      no_raw_data_statement: NO_RAW_DATA_STATEMENT,
      next_blocker: reasons.length === 0
        ? 'REL-01D feature-surface audit passed; continue REL-01 packet collection or run REL-01E before enabling MBO shadow producers.'
        : 'Resolve failed feature-surface audit checks before accepting the affected REL-01 sessions.',
    };
    writeOutputs(outJson, outMd, report);
    return { report, exit_code: report.status === 'pass' ? 0 : 2 };
  } catch (error) {
    const report = invalidReport(cwd, manifestPath, errorMessage(error));
    writeOutputs(outJson, outMd, report);
    return { report, exit_code: 3 };
  }
}

function scanSession(input: {
  readonly cwd: string;
  readonly session: Rel01aSessionInput;
  readonly journalPath: string;
  readonly mask: FeatureAvailabilityMask;
}): Rel01dSessionSummary {
  const state: SessionScanState = {
    session: input.session,
    cwd: input.cwd,
    journalPath: input.journalPath,
    mask: input.mask,
    totalEvents: 0,
    checkedFeatureEvents: 0,
    checkedDecisionEvents: 0,
    parseErrorCount: 0,
    embeddedMaskEvents: 0,
    embeddedMaskMissingEvents: 0,
    embeddedMaskMismatchCount: 0,
    unsafeDecisionUseEventCount: 0,
    fieldUses: new Map<string, MutableFieldUsage>(),
    reasons: new Set<string>(),
  };

  if (!existsSync(input.journalPath)) {
    state.reasons.add('journal_missing');
    return sessionSummary(state, null);
  }

  forEachJsonlLine(input.journalPath, (line) => {
    if (line.trim() === '') {
      return;
    }
    let event: JournalEventEnvelope;
    try {
      event = journalEventFromJsonLine(line);
    } catch {
      state.parseErrorCount += 1;
      return;
    }
    state.totalEvents += 1;
    scanEvent(state, event);
  });

  if (state.parseErrorCount > 0) {
    state.reasons.add('journal_parse_errors');
  }
  if (state.embeddedMaskMismatchCount > 0) {
    state.reasons.add('embedded_mask_mismatch');
  }
  if (state.unsafeDecisionUseEventCount > 0) {
    state.reasons.add('shadow_or_diagnostic_payload_missing_decision_use_false');
  }
  const partitions = partitionFieldUses(state.fieldUses);
  if (partitions.restricted.length > 0) state.reasons.add('restricted_fields_in_decision_context');
  if (partitions.blocked.length > 0) state.reasons.add('blocked_fields_present');
  if (partitions.invalid_diagnostic.length > 0) state.reasons.add('invalid_diagnostic_payload_fields');
  if (partitions.invalid_shadow.length > 0) state.reasons.add('invalid_shadow_payload_fields');

  return sessionSummary(state, sha256File(input.journalPath));
}

function scanEvent(state: SessionScanState, event: JournalEventEnvelope): void {
  const payload = jsonObject(event.payload) ?? {};
  if (FEATURE_SURFACE_EVENT_TYPES.has(event.type)) {
    state.checkedFeatureEvents += 1;
    scanEmbeddedMask(state, payload);
    scanFieldMap(state, event.type, 'values', jsonObject(payload.values));
    const diagnosticValues = jsonObject(payload.diagnostic_values);
    const shadowValues = jsonObject(payload.shadow_values);
    const hasDiagnosticOrShadow =
      (diagnosticValues !== null && Object.keys(diagnosticValues).length > 0) ||
      (shadowValues !== null && Object.keys(shadowValues).length > 0);
    if (hasDiagnosticOrShadow && payload.decision_use !== false) {
      state.unsafeDecisionUseEventCount += 1;
    }
    scanFieldMap(state, event.type, 'diagnostic_values', diagnosticValues);
    scanFieldMap(state, event.type, 'shadow_values', shadowValues);
  }

  if (DECISION_EVENT_TYPES.has(event.type)) {
    state.checkedDecisionEvents += 1;
    scanDecisionPayload(state, event.type, payload);
  }
}

function scanEmbeddedMask(state: SessionScanState, payload: Record<string, unknown>): void {
  const embedded = jsonObject(payload.feature_availability_mask);
  if (embedded === null) {
    state.embeddedMaskMissingEvents += 1;
    return;
  }
  state.embeddedMaskEvents += 1;
  if (
    embedded.mask_version !== state.mask.mask_version ||
    embedded.mask_id !== state.mask.mask_id ||
    embedded.mask_hash !== state.mask.mask_hash
  ) {
    state.embeddedMaskMismatchCount += 1;
  }
}

function scanFieldMap(
  state: SessionScanState,
  eventType: string,
  context: FeatureContext,
  values: Record<string, unknown> | null,
): void {
  if (values === null) {
    return;
  }
  for (const field of Object.keys(values).sort()) {
    recordFieldUse(state, eventType, context, field);
  }
}

function scanDecisionPayload(
  state: SessionScanState,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  const seen = new Set<string>();
  walkObjectKeys(payload, (path, key) => {
    const canonical = canonicalFeatureField(key);
    if (!(canonical in state.mask.field_tiers)) {
      return;
    }
    const marker = `${path}:${key}:${canonical}`;
    if (seen.has(marker)) {
      return;
    }
    seen.add(marker);
    recordFieldUse(state, eventType, 'decision_payload', key);
  });
}

function walkObjectKeys(
  value: unknown,
  visit: (path: string, key: string) => void,
  path = '$',
): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkObjectKeys(item, visit, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(path, key);
    walkObjectKeys(child, visit, `${path}.${key}`);
  }
}

function recordFieldUse(
  state: SessionScanState,
  eventType: string,
  context: FeatureContext,
  field: string,
): void {
  const canonical = canonicalFeatureField(field);
  const tier = canonical in state.mask.field_tiers
    ? state.mask.field_tiers[canonical as keyof typeof state.mask.field_tiers]
    : 'unknown';
  const key = `${eventType}:${context}:${field}:${canonical}:${tier}`;
  const existing = state.fieldUses.get(key);
  if (existing !== undefined) {
    existing.count += 1;
    existing.sessions.add(state.session.session_id);
    return;
  }
  state.fieldUses.set(key, {
    event_type: eventType,
    context,
    field,
    canonical_field: canonical,
    tier,
    count: 1,
    sessions: new Set([state.session.session_id]),
  });
}

function classifyPartition(use: MutableFieldUsage): FeaturePartition {
  if (use.tier === 'unknown') {
    return 'unknown';
  }
  if (use.tier === 'blocked') {
    return 'blocked';
  }
  if (use.context === 'diagnostic_values') {
    return use.tier === 'diagnostic_only' ? 'diagnostic' : 'invalid_diagnostic';
  }
  if (use.context === 'shadow_values') {
    return use.tier === 'shadow_only' ? 'shadow' : 'invalid_shadow';
  }
  if (use.tier === 'authoritative') {
    return 'authoritative';
  }
  return 'restricted';
}

function sessionSummary(state: SessionScanState, journalSha256: string | null): Rel01dSessionSummary {
  const fieldUsage = partitionFieldUses(state.fieldUses);
  return {
    session_id: state.session.session_id,
    run_id: state.session.run_id,
    journal_path: toReportPath(state.cwd, state.journalPath),
    journal_sha256: journalSha256,
    journal_exists: existsSync(state.journalPath),
    total_events: state.totalEvents,
    checked_feature_events: state.checkedFeatureEvents,
    checked_decision_events: state.checkedDecisionEvents,
    parse_error_count: state.parseErrorCount,
    embedded_mask_events: state.embeddedMaskEvents,
    embedded_mask_missing_events: state.embeddedMaskMissingEvents,
    embedded_mask_mismatch_count: state.embeddedMaskMismatchCount,
    unsafe_shadow_or_diagnostic_decision_use_event_count: state.unsafeDecisionUseEventCount,
    partition_counts: partitionCounts(fieldUsage),
    field_usage_by_partition: fieldUsage,
    reasons: [...state.reasons].sort(),
  };
}

function aggregateSessions(sessions: readonly Rel01dSessionSummary[]): Rel01dAggregateSummary {
  const fieldUses = new Map<string, MutableFieldUsage>();
  for (const session of sessions) {
    for (const list of Object.values(session.field_usage_by_partition)) {
      for (const use of list) {
        const key = `${use.event_type}:${use.context}:${use.field}:${use.canonical_field}:${use.tier}`;
        const existing = fieldUses.get(key);
        if (existing !== undefined) {
          existing.count += use.count;
          for (const sessionId of use.sessions) existing.sessions.add(sessionId);
        } else {
          fieldUses.set(key, {
            event_type: use.event_type,
            context: use.context,
            field: use.field,
            canonical_field: use.canonical_field,
            tier: use.tier,
            count: use.count,
            sessions: new Set(use.sessions),
          });
        }
      }
    }
  }
  const fieldUsage = partitionFieldUses(fieldUses);
  return {
    session_count: sessions.length,
    total_events: sum(sessions.map((session) => session.total_events)),
    checked_feature_events: sum(sessions.map((session) => session.checked_feature_events)),
    checked_decision_events: sum(sessions.map((session) => session.checked_decision_events)),
    parse_error_count: sum(sessions.map((session) => session.parse_error_count)),
    embedded_mask_mismatch_count: sum(sessions.map((session) => session.embedded_mask_mismatch_count)),
    unsafe_shadow_or_diagnostic_decision_use_event_count: sum(sessions.map((session) => session.unsafe_shadow_or_diagnostic_decision_use_event_count)),
    partition_counts: partitionCounts(fieldUsage),
    field_usage_by_partition: fieldUsage,
  };
}

function buildCheckGroups(input: {
  readonly manifest: Rel01aManifest;
  readonly sessions: readonly Rel01dSessionSummary[];
  readonly aggregate: Rel01dAggregateSummary;
  readonly mask: FeatureAvailabilityMask;
}): Rel01dReport['check_groups'] {
  return {
    packet_checks: group([
      checkBoolean('manifest_schema_version_supported', input.manifest.schema_version === 1, `${input.manifest.schema_version}`),
      checkBoolean('manifest_has_sessions', input.sessions.length > 0, `${input.sessions.length}`),
      checkBoolean('all_journals_exist', input.sessions.every((session) => session.journal_exists), mismatchSessionDetail(input.sessions, (session) => !session.journal_exists)),
    ]),
    mask_binding_checks: group([
      checkBoolean('audit_mask_version_is_v4', input.mask.mask_version === EXPECTED_MASK_VERSION, `${input.mask.mask_version}`),
      checkBoolean('audit_mask_id_is_data03ps_shadow', input.mask.mask_id === EXPECTED_MASK_ID, input.mask.mask_id),
      checkBoolean('embedded_masks_match_audit_mask_when_present', input.aggregate.embedded_mask_mismatch_count === 0, `${input.aggregate.embedded_mask_mismatch_count}`),
    ]),
    decision_surface_checks: group([
      checkBoolean('no_blocked_fields_anywhere', input.aggregate.partition_counts.blocked === 0, fieldUsesDetail(input.aggregate.field_usage_by_partition.blocked)),
      checkBoolean('no_restricted_fields_in_decision_contexts', input.aggregate.partition_counts.restricted === 0, fieldUsesDetail(input.aggregate.field_usage_by_partition.restricted)),
    ]),
    shadow_diagnostic_checks: group([
      checkBoolean('diagnostic_values_are_diagnostic_only', input.aggregate.partition_counts.invalid_diagnostic === 0, fieldUsesDetail(input.aggregate.field_usage_by_partition.invalid_diagnostic)),
      checkBoolean('shadow_values_are_shadow_only', input.aggregate.partition_counts.invalid_shadow === 0, fieldUsesDetail(input.aggregate.field_usage_by_partition.invalid_shadow)),
      checkBoolean('shadow_or_diagnostic_payloads_have_decision_use_false', input.aggregate.unsafe_shadow_or_diagnostic_decision_use_event_count === 0, `${input.aggregate.unsafe_shadow_or_diagnostic_decision_use_event_count}`),
    ]),
    parse_checks: group([
      checkBoolean('journals_parse_as_jsonl', input.aggregate.parse_error_count === 0, `${input.aggregate.parse_error_count}`),
    ]),
  };
}

function invalidReport(cwd: string, manifestPath: string, reason: string): Rel01dReport {
  const mask = buildFeatureAvailabilityMask();
  const packetChecks = group([checkBoolean('manifest_parseable', false, reason)]);
  return {
    schema_version: REL_01D_REPORT_SCHEMA_VERSION,
    ticket_id: REL_01D_TICKET_ID,
    status: 'fail',
    manifest: {
      path: toReportPath(cwd, manifestPath),
      sha256: existsSync(manifestPath) ? sha256File(manifestPath) : null,
      rel01_run_id: null,
      session_count: 0,
    },
    audit_mask: {
      mask_version: mask.mask_version,
      mask_id: mask.mask_id,
      mask_hash: mask.mask_hash,
    },
    sessions: [],
    aggregate: {
      session_count: 0,
      total_events: 0,
      checked_feature_events: 0,
      checked_decision_events: 0,
      parse_error_count: 0,
      embedded_mask_mismatch_count: 0,
      unsafe_shadow_or_diagnostic_decision_use_event_count: 0,
      partition_counts: emptyPartitionCounts(),
      field_usage_by_partition: emptyFieldUsageByPartition(),
    },
    check_groups: {
      packet_checks: packetChecks,
      mask_binding_checks: group([]),
      decision_surface_checks: group([]),
      shadow_diagnostic_checks: group([]),
      parse_checks: group([]),
    },
    reasons: [`packet_checks:manifest_parseable: ${reason}`],
    no_raw_data_statement: NO_RAW_DATA_STATEMENT,
    next_blocker: 'Fix REL-01D audit input and rerun.',
  };
}

function partitionFieldUses(uses: Map<string, MutableFieldUsage>): Rel01dFieldUsageByPartition {
  const partitions: Record<FeaturePartition, Rel01dFieldUsage[]> = emptyMutableFieldUsageByPartition();
  for (const use of uses.values()) {
    partitions[classifyPartition(use)].push({
      event_type: use.event_type,
      context: use.context,
      field: use.field,
      canonical_field: use.canonical_field,
      tier: use.tier,
      count: use.count,
      sessions: [...use.sessions].sort(),
    });
  }
  return {
    authoritative: sortFieldUses(partitions.authoritative),
    diagnostic: sortFieldUses(partitions.diagnostic),
    shadow: sortFieldUses(partitions.shadow),
    restricted: sortFieldUses(partitions.restricted),
    blocked: sortFieldUses(partitions.blocked),
    invalid_diagnostic: sortFieldUses(partitions.invalid_diagnostic),
    invalid_shadow: sortFieldUses(partitions.invalid_shadow),
    unknown: sortFieldUses(partitions.unknown),
  };
}

function partitionCounts(fieldUsage: Rel01dFieldUsageByPartition): Record<FeaturePartition, number> {
  return {
    authoritative: sum(fieldUsage.authoritative.map((use) => use.count)),
    diagnostic: sum(fieldUsage.diagnostic.map((use) => use.count)),
    shadow: sum(fieldUsage.shadow.map((use) => use.count)),
    restricted: sum(fieldUsage.restricted.map((use) => use.count)),
    blocked: sum(fieldUsage.blocked.map((use) => use.count)),
    invalid_diagnostic: sum(fieldUsage.invalid_diagnostic.map((use) => use.count)),
    invalid_shadow: sum(fieldUsage.invalid_shadow.map((use) => use.count)),
    unknown: sum(fieldUsage.unknown.map((use) => use.count)),
  };
}

function emptyFieldUsageByPartition(): Rel01dFieldUsageByPartition {
  return {
    authoritative: [],
    diagnostic: [],
    shadow: [],
    restricted: [],
    blocked: [],
    invalid_diagnostic: [],
    invalid_shadow: [],
    unknown: [],
  };
}

function emptyMutableFieldUsageByPartition(): Record<FeaturePartition, Rel01dFieldUsage[]> {
  return {
    authoritative: [],
    diagnostic: [],
    shadow: [],
    restricted: [],
    blocked: [],
    invalid_diagnostic: [],
    invalid_shadow: [],
    unknown: [],
  };
}

function emptyPartitionCounts(): Record<FeaturePartition, number> {
  return {
    authoritative: 0,
    diagnostic: 0,
    shadow: 0,
    restricted: 0,
    blocked: 0,
    invalid_diagnostic: 0,
    invalid_shadow: 0,
    unknown: 0,
  };
}

function canonicalFeatureField(field: string): string {
  const aliases: Record<string, string> = {
    bid_px: 'l1_quote_bid_px',
    ask_px: 'l1_quote_ask_px',
    last_price: 'last_trade_price',
    last_trade_px: 'last_trade_price',
    trade_size: 'last_trade_size',
    aggressor_side: 'last_trade_aggressor_side',
    spread_points: 'microstructure_spread_points',
    spread_ticks: 'microstructure_spread_ticks',
    mid_px: 'microstructure_mid_px',
    microprice_offset_ticks: 'mbo_microprice_offset_ticks',
    ofi_short: 'mbo_ofi_short',
    ofi_medium: 'mbo_ofi_medium',
    ofi_blend: 'mbo_ofi_blend',
    queue_imbalance: 'mbo_queue_imbalance',
    queue_ahead_fraction: 'queue_ahead_fraction_estimate',
  };
  return aliases[field] ?? field;
}

function readManifest(path: string): Rel01aManifest {
  const parsed = readJson(path) as Partial<Rel01aManifest>;
  if (parsed.schema_version !== 1) {
    throw new Error('REL-01D manifest schema_version must be 1');
  }
  if (!Array.isArray(parsed.sessions)) {
    throw new Error('REL-01D manifest sessions must be an array');
  }
  for (const [index, session] of parsed.sessions.entries()) {
    if (!isString(session.session_id) || !isString(session.run_id) || !isString(session.journal)) {
      throw new Error(`REL-01D manifest session ${index + 1} must include session_id, run_id, and journal`);
    }
  }
  return parsed as Rel01aManifest;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeOutputs(outJson: string, outMd: string, report: Rel01dReport): void {
  writeFileSync(outJson, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
  writeFileSync(outMd, markdownReport(report), 'utf8');
}

function markdownReport(report: Rel01dReport): string {
  return [
    '# REL-01D Feature Surface Audit',
    '',
    `Status: ${report.status}`,
    `Run ID: ${report.manifest.rel01_run_id ?? 'unavailable'}`,
    `Sessions: ${report.manifest.session_count}`,
    `Audit mask: ${report.audit_mask.mask_id}`,
    `Audit mask hash: ${report.audit_mask.mask_hash}`,
    '',
    '## Aggregate Field Counts',
    '',
    `- Authoritative decision uses: ${report.aggregate.partition_counts.authoritative}`,
    `- Diagnostic telemetry uses: ${report.aggregate.partition_counts.diagnostic}`,
    `- Shadow telemetry uses: ${report.aggregate.partition_counts.shadow}`,
    `- Restricted decision uses: ${report.aggregate.partition_counts.restricted}`,
    `- Blocked uses: ${report.aggregate.partition_counts.blocked}`,
    `- Invalid diagnostic uses: ${report.aggregate.partition_counts.invalid_diagnostic}`,
    `- Invalid shadow uses: ${report.aggregate.partition_counts.invalid_shadow}`,
    '',
    '## Top Fields',
    '',
    ...topFieldLines(report.aggregate.field_usage_by_partition),
    '',
    '## Reasons',
    '',
    ...(report.reasons.length === 0 ? ['- none'] : report.reasons.map((reason) => `- ${reason}`)),
    '',
    '## Next Blocker',
    '',
    report.next_blocker,
    '',
    '## Raw Data',
    '',
    report.no_raw_data_statement,
    '',
  ].join('\n');
}

function topFieldLines(fieldUsage: Rel01dFieldUsageByPartition): readonly string[] {
  const lines: string[] = [];
  for (const partition of [
    'authoritative',
    'diagnostic',
    'shadow',
    'restricted',
    'blocked',
    'invalid_diagnostic',
    'invalid_shadow',
  ] as const) {
    const top = fieldUsage[partition].slice(0, 5);
    lines.push(`- ${partition}: ${top.length === 0 ? 'none' : top.map((use) => `${use.canonical_field}=${use.count}`).join(', ')}`);
  }
  return lines;
}

function group(checks: readonly Rel01dCheck[]): Rel01dCheckGroup {
  return {
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    checks,
  };
}

function checkBoolean(name: string, passed: boolean, detail?: string): Rel01dCheck {
  return {
    name,
    status: passed ? 'pass' : 'fail',
    ...(detail === undefined ? {} : { detail }),
  };
}

function fieldUsesDetail(uses: readonly Rel01dFieldUsage[]): string {
  return uses.length === 0
    ? 'none'
    : uses.map((use) => `${use.event_type}.${use.context}.${use.field}->${use.canonical_field}:${use.tier}=${use.count}`).join(',');
}

function sortFieldUses(uses: readonly Rel01dFieldUsage[]): readonly Rel01dFieldUsage[] {
  return [...uses].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return `${left.event_type}:${left.context}:${left.canonical_field}:${left.field}`.localeCompare(
      `${right.event_type}:${right.context}:${right.canonical_field}:${right.field}`,
    );
  });
}

function mismatchSessionDetail(
  sessions: readonly Rel01dSessionSummary[],
  predicate: (session: Rel01dSessionSummary) => boolean,
): string {
  return sessions.filter(predicate).map((session) => session.session_id).join(',') || 'none';
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function toReportPath(cwd: string, path: string): string {
  const rel = relative(cwd, path).replace(/\\/gu, '/');
  return rel.startsWith('..') ? path.replace(/\\/gu, '/') : rel;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRel01dArgs(args: readonly string[]): Rel01dOptions {
  const options: MutableRel01dOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    switch (arg) {
      case '--manifest':
        index += 1;
        options.manifest = requireArgValue(arg, args[index]);
        break;
      case '--out-json':
        index += 1;
        options.out_json = requireArgValue(arg, args[index]);
        break;
      case '--out-md':
        index += 1;
        options.out_md = requireArgValue(arg, args[index]);
        break;
      case '--help':
      case '-h':
        processStdout.write(`${usage()}\n`);
        processExit(0);
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  if (options.manifest === undefined) {
    throw new Error('missing required --manifest');
  }
  return options as Rel01dOptions;
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage(): string {
  return [
    'Usage: npm run rel:01d:feature-surface-audit -- --manifest path [--out-json path] [--out-md path]',
    '',
    'Audits REL-01 controlled live-sim runtime journals for accepted feature-surface use.',
  ].join('\n');
}

export function formatRel01dSummary(report: Rel01dReport): string {
  return [
    `REL-01D feature-surface audit: ${report.status}`,
    `manifest=${report.manifest.path}`,
    `sessions=${report.manifest.session_count}`,
    `authoritative_uses=${report.aggregate.partition_counts.authoritative}`,
    `restricted_uses=${report.aggregate.partition_counts.restricted}`,
    `blocked_uses=${report.aggregate.partition_counts.blocked}`,
    `shadow_uses=${report.aggregate.partition_counts.shadow}`,
    `next_blocker=${report.next_blocker}`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const result = await runRel01dFeatureSurfaceAudit(parseRel01dArgs(processArgv.slice(2)));
    processStdout.write(formatRel01dSummary(result.report));
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`${errorMessage(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(processArgv[1])) {
  void main();
}
