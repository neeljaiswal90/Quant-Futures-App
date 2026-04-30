import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  stableJsonStringify,
  type JsonValue,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import { sha256File } from '../sim/streaming-jsonl.js';

export const REL_01_SHORT_FINAL_PACKET_SCHEMA_VERSION = 1 as const;
export const REL_01_SHORT_FINAL_PACKET_TICKET_ID = 'REL-01-SHORT' as const;

const DEFAULT_REQUIRED_SESSIONS = 2;
const DEFAULT_OUT_JSON = 'reports/rel/rel01_short_final_packet_report.json';
const DEFAULT_OUT_MD = 'reports/rel/rel01_short_final_packet_report.md';
const NO_RAW_DATA_STATEMENT =
  'REL-01-Short indexes manifest/report paths, SHA-256 hashes, validator statuses, counts, and scope decisions only. It does not embed raw market-data rows, feature payload values, order payload values, MBO records, DBN files, or runtime journal payloads.';

const SAFETY_POSTURE = {
  rel01_short_interim_pilot_only: true,
  formal_rel01_10_session_gate_replaced: false,
  real_money_execution_allowed: false,
  mbo_decision_use_allowed: false,
  mbo_shadow_telemetry_included_in_comparable_packet: false,
  data01b_full_promotion_allowed: false,
  runtime_trading_behavior_changed: false,
  execution_mode: 'unchanged_simulated_only',
} as const;

type Rel01ShortFinalStatus = 'pass' | 'fail';
type CheckStatus = 'pass' | 'fail';
type JsonObject = { readonly [key: string]: JsonValue };

export interface Rel01ShortFinalPacketOptions {
  readonly cwd?: string;
  readonly manifest: string;
  readonly rel01a_report: string;
  readonly rel01d_report: string;
  readonly rel01e_report: string;
  readonly policy_note: string;
  readonly out_json?: string;
  readonly out_md?: string;
  readonly required_sessions?: number;
}

type MutableOptions = {
  -readonly [K in keyof Rel01ShortFinalPacketOptions]?: Rel01ShortFinalPacketOptions[K];
};

export interface Rel01ShortFinalPacketReport {
  readonly schema_version: typeof REL_01_SHORT_FINAL_PACKET_SCHEMA_VERSION;
  readonly ticket_id: typeof REL_01_SHORT_FINAL_PACKET_TICKET_ID;
  readonly status: Rel01ShortFinalStatus;
  readonly scope_decision: typeof SAFETY_POSTURE;
  readonly evidence: {
    readonly manifest: EvidenceFileSummary;
    readonly rel01a_report: EvidenceFileSummary;
    readonly rel01d_report: EvidenceFileSummary;
    readonly rel01e_report: EvidenceFileSummary;
    readonly policy_note: EvidenceFileSummary;
  };
  readonly summary: {
    readonly required_sessions: number;
    readonly session_count: number;
    readonly distinct_rth_sessions: number;
    readonly rel01a_status: string | null;
    readonly rel01d_status: string | null;
    readonly rel01e_status: string | null;
    readonly total_source_events: number;
    readonly order_intents: number;
    readonly sim_fills: number;
    readonly real_order_event_types: number;
    readonly provenance_spot_checks: {
      readonly requested: number;
      readonly attempted: number;
      readonly passed: number;
    };
    readonly feature_surface: {
      readonly restricted_uses: number;
      readonly blocked_uses: number;
      readonly shadow_uses: number;
      readonly invalid_diagnostic_uses: number;
      readonly invalid_shadow_uses: number;
      readonly unsafe_decision_use_event_count: number;
    };
    readonly mbo_shadow_lineage: {
      readonly status: string | null;
      readonly shadow_events: number;
      readonly shadow_field_occurrences: number;
      readonly missing_source_event_count: number;
      readonly lookahead_source_event_count: number;
      readonly recompute_mismatch_count: number;
    };
  };
  readonly check_groups: {
    readonly packet_checks: CheckGroup;
    readonly validator_status_checks: CheckGroup;
    readonly accepted_surface_checks: CheckGroup;
    readonly scope_guardrail_checks: CheckGroup;
  };
  readonly reasons: readonly string[];
  readonly no_raw_data_statement: typeof NO_RAW_DATA_STATEMENT;
  readonly next_blocker: string;
}

interface EvidenceFileSummary {
  readonly path: string;
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly parseable_json: boolean | null;
  readonly status: string | null;
}

interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
}

interface CheckGroup {
  readonly status: CheckStatus;
  readonly checks: readonly Check[];
}

interface LoadedEvidence {
  readonly manifest: JsonObject | null;
  readonly rel01a: JsonObject | null;
  readonly rel01d: JsonObject | null;
  readonly rel01e: JsonObject | null;
}

interface ResolvedOptions {
  readonly cwd: string;
  readonly manifest: string;
  readonly rel01a_report: string;
  readonly rel01d_report: string;
  readonly rel01e_report: string;
  readonly policy_note: string;
  readonly out_json: string;
  readonly out_md: string | null;
  readonly required_sessions: number;
}

export async function runRel01ShortFinalPacket(
  options: Rel01ShortFinalPacketOptions,
): Promise<{ readonly report: Rel01ShortFinalPacketReport; readonly exit_code: 0 | 2 | 3 }> {
  try {
    const resolved = resolveOptions(options);
    const report = buildReport(resolved);
    writeReport(resolved, report);
    return {
      report,
      exit_code: report.status === 'pass' ? 0 : 2,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cwd = options.cwd ?? processCwd();
    const outJson = options.out_json ?? DEFAULT_OUT_JSON;
    const outMd = options.out_md ?? DEFAULT_OUT_MD;
    const invalidReport = invalidReportForOptions(options, message);
    writeFile(resolve(cwd, outJson), `${stableJsonStringify(invalidReport as unknown as JsonValue)}\n`);
    if (outMd !== undefined) {
      writeFile(resolve(cwd, outMd), renderMarkdown(invalidReport));
    }
    return { report: invalidReport, exit_code: 3 };
  }
}

function resolveOptions(options: Rel01ShortFinalPacketOptions): ResolvedOptions {
  return {
    cwd: options.cwd ?? processCwd(),
    manifest: options.manifest,
    rel01a_report: options.rel01a_report,
    rel01d_report: options.rel01d_report,
    rel01e_report: options.rel01e_report,
    policy_note: options.policy_note,
    out_json: options.out_json ?? DEFAULT_OUT_JSON,
    out_md: options.out_md ?? DEFAULT_OUT_MD,
    required_sessions: normalizeRequiredSessions(options.required_sessions),
  };
}

function buildReport(options: ResolvedOptions): Rel01ShortFinalPacketReport {
  const paths = {
    manifest: resolve(options.cwd, options.manifest),
    rel01a_report: resolve(options.cwd, options.rel01a_report),
    rel01d_report: resolve(options.cwd, options.rel01d_report),
    rel01e_report: resolve(options.cwd, options.rel01e_report),
    policy_note: resolve(options.cwd, options.policy_note),
  };
  const loaded: LoadedEvidence = {
    manifest: readJsonIfPresent(paths.manifest),
    rel01a: readJsonIfPresent(paths.rel01a_report),
    rel01d: readJsonIfPresent(paths.rel01d_report),
    rel01e: readJsonIfPresent(paths.rel01e_report),
  };
  const evidence = {
    manifest: evidenceSummary(options.cwd, paths.manifest, loaded.manifest),
    rel01a_report: evidenceSummary(options.cwd, paths.rel01a_report, loaded.rel01a),
    rel01d_report: evidenceSummary(options.cwd, paths.rel01d_report, loaded.rel01d),
    rel01e_report: evidenceSummary(options.cwd, paths.rel01e_report, loaded.rel01e),
    policy_note: policyNoteSummary(options.cwd, paths.policy_note),
  };

  const manifestSessions = arrayAt<JsonObject>(loaded.manifest, ['sessions']);
  const sessionIds = manifestSessions.map((session) => stringAt(session, ['session_id']) ?? '');
  const distinctRthSessions = uniqueSorted(sessionIds.filter((sessionId) => sessionId.endsWith('-rth'))).length;
  const rel01aProvenance = objectAt(loaded.rel01a, ['provenance_spot_checks']);
  const rel01dPartitionCounts = objectAt(loaded.rel01d, ['aggregate', 'partition_counts']);
  const rel01eAggregate = objectAt(loaded.rel01e, ['aggregate']);
  const summary = {
    required_sessions: options.required_sessions,
    session_count: manifestSessions.length,
    distinct_rth_sessions: distinctRthSessions,
    rel01a_status: stringAt(loaded.rel01a, ['status']),
    rel01d_status: stringAt(loaded.rel01d, ['status']),
    rel01e_status: stringAt(loaded.rel01e, ['status']),
    total_source_events: numberAt(loaded.rel01a, ['aggregate_counts', 'total_source_events']),
    order_intents: numberAt(loaded.rel01a, ['aggregate_counts', 'order_intents']),
    sim_fills: numberAt(loaded.rel01a, ['aggregate_counts', 'sim_fills']),
    real_order_event_types: numberAt(loaded.rel01a, ['aggregate_counts', 'real_order_event_types']),
    provenance_spot_checks: {
      requested: numberAt(rel01aProvenance, ['requested']),
      attempted: numberAt(rel01aProvenance, ['attempted']),
      passed: numberAt(rel01aProvenance, ['passed']),
    },
    feature_surface: {
      restricted_uses: numberAt(rel01dPartitionCounts, ['restricted']),
      blocked_uses: numberAt(rel01dPartitionCounts, ['blocked']),
      shadow_uses: numberAt(rel01dPartitionCounts, ['shadow']),
      invalid_diagnostic_uses: numberAt(rel01dPartitionCounts, ['invalid_diagnostic']),
      invalid_shadow_uses: numberAt(rel01dPartitionCounts, ['invalid_shadow']),
      unsafe_decision_use_event_count: numberAt(
        loaded.rel01d,
        ['aggregate', 'unsafe_shadow_or_diagnostic_decision_use_event_count'],
      ),
    },
    mbo_shadow_lineage: {
      status: stringAt(loaded.rel01e, ['status']),
      shadow_events: numberAt(rel01eAggregate, ['shadow_events']),
      shadow_field_occurrences: numberAt(rel01eAggregate, ['shadow_field_occurrences']),
      missing_source_event_count: numberAt(rel01eAggregate, ['missing_source_event_count']),
      lookahead_source_event_count: numberAt(rel01eAggregate, ['lookahead_source_event_count']),
      recompute_mismatch_count: numberAt(rel01eAggregate, ['recompute_mismatch_count']),
    },
  };

  const check_groups = buildCheckGroups({
    evidence,
    loaded,
    manifestSessions,
    manifestSha256: evidence.manifest.sha256,
    policyNoteText: readTextIfPresent(paths.policy_note),
    summary,
  });
  const reasons = collectReasons(check_groups);

  return {
    schema_version: REL_01_SHORT_FINAL_PACKET_SCHEMA_VERSION,
    ticket_id: REL_01_SHORT_FINAL_PACKET_TICKET_ID,
    status: reasons.length === 0 ? 'pass' : 'fail',
    scope_decision: SAFETY_POSTURE,
    evidence,
    summary,
    check_groups,
    reasons,
    no_raw_data_statement: NO_RAW_DATA_STATEMENT,
    next_blocker:
      reasons.length === 0
        ? 'Continue the formal REL-01 10-session controlled live-sim capture; keep MBO decision-use blocked.'
        : 'Fix the REL-01-Short final packet evidence and rerun this finalizer.',
  };
}

function buildCheckGroups(input: {
  readonly evidence: Rel01ShortFinalPacketReport['evidence'];
  readonly loaded: LoadedEvidence;
  readonly manifestSessions: readonly JsonObject[];
  readonly manifestSha256: string | null;
  readonly policyNoteText: string | null;
  readonly summary: Rel01ShortFinalPacketReport['summary'];
}): Rel01ShortFinalPacketReport['check_groups'] {
  const manifestRunId = stringAt(input.loaded.manifest, ['rel01_run_id']);
  const rel01aManifestSha = stringAt(input.loaded.rel01a, ['manifest', 'sha256']);
  const rel01dManifestSha = stringAt(input.loaded.rel01d, ['manifest', 'sha256']);
  const rel01eManifestSha = stringAt(input.loaded.rel01e, ['manifest', 'sha256']);
  const packetChecks = group([
    check('manifest_exists_and_parses', input.evidence.manifest.exists && input.evidence.manifest.parseable_json === true),
    check('rel01a_report_exists_and_parses', input.evidence.rel01a_report.exists && input.evidence.rel01a_report.parseable_json === true),
    check('rel01d_report_exists_and_parses', input.evidence.rel01d_report.exists && input.evidence.rel01d_report.parseable_json === true),
    check('rel01e_report_exists_and_parses', input.evidence.rel01e_report.exists && input.evidence.rel01e_report.parseable_json === true),
    check('policy_note_exists', input.evidence.policy_note.exists),
    check('policy_note_declares_formal_rel01_still_required', policyNoteDeclaresFormalRel01StillRequired(input.policyNoteText)),
    check('policy_note_declares_mbo_decision_use_blocked', policyNoteDeclaresMboDecisionUseBlocked(input.policyNoteText)),
    check('manifest_schema_version_is_1', numberAt(input.loaded.manifest, ['schema_version']) === 1),
    check('short_packet_has_exact_required_sessions', input.summary.session_count === input.summary.required_sessions, `${input.summary.session_count}/${input.summary.required_sessions}`),
    check('short_packet_sessions_are_distinct_rth', input.summary.distinct_rth_sessions === input.summary.required_sessions, `${input.summary.distinct_rth_sessions}/${input.summary.required_sessions}`),
    check('rel01_run_id_declares_short_packet', manifestRunId?.includes('short') === true, manifestRunId ?? 'missing'),
    check('validator_reports_bind_to_manifest_hash', hashesMatchRequired(input.manifestSha256, [rel01aManifestSha, rel01dManifestSha, rel01eManifestSha]), manifestHashDetail(input.manifestSha256, [rel01aManifestSha, rel01dManifestSha, rel01eManifestSha])),
  ]);
  const validatorStatusChecks = group([
    check('rel01a_status_pass', input.summary.rel01a_status === 'pass', input.summary.rel01a_status ?? 'missing'),
    check('rel01d_status_pass', input.summary.rel01d_status === 'pass', input.summary.rel01d_status ?? 'missing'),
    check('rel01e_status_no_shadow_telemetry', input.summary.rel01e_status === 'no_shadow_telemetry', input.summary.rel01e_status ?? 'missing'),
    check('provenance_spot_checks_passed', input.summary.provenance_spot_checks.passed === input.summary.provenance_spot_checks.requested && input.summary.provenance_spot_checks.requested > 0, `${input.summary.provenance_spot_checks.passed}/${input.summary.provenance_spot_checks.requested}`),
  ]);
  const acceptedSurfaceChecks = group([
    check('no_real_order_event_types', input.summary.real_order_event_types === 0, String(input.summary.real_order_event_types)),
    check('no_restricted_feature_uses', input.summary.feature_surface.restricted_uses === 0, String(input.summary.feature_surface.restricted_uses)),
    check('no_blocked_feature_uses', input.summary.feature_surface.blocked_uses === 0, String(input.summary.feature_surface.blocked_uses)),
    check('no_invalid_diagnostic_feature_uses', input.summary.feature_surface.invalid_diagnostic_uses === 0, String(input.summary.feature_surface.invalid_diagnostic_uses)),
    check('no_invalid_shadow_feature_uses', input.summary.feature_surface.invalid_shadow_uses === 0, String(input.summary.feature_surface.invalid_shadow_uses)),
    check('no_shadow_or_diagnostic_decision_use', input.summary.feature_surface.unsafe_decision_use_event_count === 0, String(input.summary.feature_surface.unsafe_decision_use_event_count)),
  ]);
  const scopeGuardrailChecks = group([
    check('mbo_shadow_telemetry_not_in_comparable_packet', input.summary.feature_surface.shadow_uses === 0 && input.summary.mbo_shadow_lineage.shadow_field_occurrences === 0, `surface_shadow=${input.summary.feature_surface.shadow_uses}, lineage_shadow=${input.summary.mbo_shadow_lineage.shadow_field_occurrences}`),
    check('rel01e_has_no_missing_source_events', input.summary.mbo_shadow_lineage.missing_source_event_count === 0, String(input.summary.mbo_shadow_lineage.missing_source_event_count)),
    check('rel01e_has_no_lookahead_source_events', input.summary.mbo_shadow_lineage.lookahead_source_event_count === 0, String(input.summary.mbo_shadow_lineage.lookahead_source_event_count)),
    check('rel01e_has_no_recompute_mismatches', input.summary.mbo_shadow_lineage.recompute_mismatch_count === 0, String(input.summary.mbo_shadow_lineage.recompute_mismatch_count)),
    check('formal_rel01_gate_not_replaced', SAFETY_POSTURE.formal_rel01_10_session_gate_replaced === false),
    check('mbo_decision_use_remains_blocked', SAFETY_POSTURE.mbo_decision_use_allowed === false),
    check('real_money_execution_remains_blocked', SAFETY_POSTURE.real_money_execution_allowed === false),
    check('data01b_full_promotion_remains_blocked', SAFETY_POSTURE.data01b_full_promotion_allowed === false),
  ]);
  return {
    packet_checks: packetChecks,
    validator_status_checks: validatorStatusChecks,
    accepted_surface_checks: acceptedSurfaceChecks,
    scope_guardrail_checks: scopeGuardrailChecks,
  };
}

function invalidReportForOptions(
  options: Rel01ShortFinalPacketOptions,
  reason: string,
): Rel01ShortFinalPacketReport {
  const cwd = options.cwd ?? processCwd();
  const evidence = {
    manifest: evidenceSummary(cwd, resolve(cwd, options.manifest), null),
    rel01a_report: evidenceSummary(cwd, resolve(cwd, options.rel01a_report), null),
    rel01d_report: evidenceSummary(cwd, resolve(cwd, options.rel01d_report), null),
    rel01e_report: evidenceSummary(cwd, resolve(cwd, options.rel01e_report), null),
    policy_note: policyNoteSummary(cwd, resolve(cwd, options.policy_note)),
  };
  const check_groups = {
    packet_checks: group([check('finalizer_input_parseable', false, reason)]),
    validator_status_checks: group([]),
    accepted_surface_checks: group([]),
    scope_guardrail_checks: group([]),
  };
  return {
    schema_version: REL_01_SHORT_FINAL_PACKET_SCHEMA_VERSION,
    ticket_id: REL_01_SHORT_FINAL_PACKET_TICKET_ID,
    status: 'fail',
    scope_decision: SAFETY_POSTURE,
    evidence,
    summary: {
      required_sessions: options.required_sessions ?? DEFAULT_REQUIRED_SESSIONS,
      session_count: 0,
      distinct_rth_sessions: 0,
      rel01a_status: null,
      rel01d_status: null,
      rel01e_status: null,
      total_source_events: 0,
      order_intents: 0,
      sim_fills: 0,
      real_order_event_types: 0,
      provenance_spot_checks: { requested: 0, attempted: 0, passed: 0 },
      feature_surface: {
        restricted_uses: 0,
        blocked_uses: 0,
        shadow_uses: 0,
        invalid_diagnostic_uses: 0,
        invalid_shadow_uses: 0,
        unsafe_decision_use_event_count: 0,
      },
      mbo_shadow_lineage: {
        status: null,
        shadow_events: 0,
        shadow_field_occurrences: 0,
        missing_source_event_count: 0,
        lookahead_source_event_count: 0,
        recompute_mismatch_count: 0,
      },
    },
    check_groups,
    reasons: [`packet_checks:finalizer_input_parseable: ${reason}`],
    no_raw_data_statement: NO_RAW_DATA_STATEMENT,
    next_blocker: 'Fix the REL-01-Short final packet evidence and rerun this finalizer.',
  };
}

function normalizeRequiredSessions(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_REQUIRED_SESSIONS;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`required_sessions must be a positive integer, got ${value}`);
  }
  return value;
}

function evidenceSummary(cwd: string, path: string, parsed: JsonObject | null): EvidenceFileSummary {
  const exists = existsSync(path);
  return {
    path: toPortablePath(cwd, path),
    exists,
    sha256: exists ? sha256File(path) : null,
    parseable_json: exists ? parsed !== null : null,
    status: parsed === null ? null : stringAt(parsed, ['status']),
  };
}

function policyNoteSummary(cwd: string, path: string): EvidenceFileSummary {
  const exists = existsSync(path);
  return {
    path: toPortablePath(cwd, path),
    exists,
    sha256: exists ? sha256File(path) : null,
    parseable_json: null,
    status: null,
  };
}

function readJsonIfPresent(path: string): JsonObject | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
  } catch {
    return null;
  }
}

function readTextIfPresent(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, 'utf8');
}

function hashesMatchRequired(actual: string | null, expectedValues: readonly (string | null)[]): boolean {
  if (actual === null) {
    return false;
  }
  return expectedValues.every((expected) => expected !== null && expected === actual);
}

function manifestHashDetail(actual: string | null, expectedValues: readonly (string | null)[]): string {
  return `manifest=${actual ?? 'missing'}, reports=${expectedValues.map((value) => value ?? 'missing').join(',')}`;
}

function policyNoteDeclaresFormalRel01StillRequired(policyNote: string | null): boolean {
  if (policyNote === null) {
    return false;
  }
  return /formal REL-01/i.test(policyNote) && /10-session/i.test(policyNote);
}

function policyNoteDeclaresMboDecisionUseBlocked(policyNote: string | null): boolean {
  if (policyNote === null) {
    return false;
  }
  return /MBO decision-use blocked/i.test(policyNote) || /MBO decision use blocked/i.test(policyNote);
}

function collectReasons(groups: Rel01ShortFinalPacketReport['check_groups']): readonly string[] {
  const reasons: string[] = [];
  for (const [groupName, group] of Object.entries(groups)) {
    for (const checkItem of group.checks) {
      if (checkItem.status === 'fail') {
        reasons.push(`${groupName}:${checkItem.name}${checkItem.detail === undefined ? '' : `: ${checkItem.detail}`}`);
      }
    }
  }
  return reasons.sort();
}

function group(checks: readonly Check[]): CheckGroup {
  return {
    status: checks.every((checkItem) => checkItem.status === 'pass') ? 'pass' : 'fail',
    checks,
  };
}

function check(name: string, condition: boolean, detail?: string): Check {
  return {
    name,
    status: condition ? 'pass' : 'fail',
    ...(detail === undefined ? {} : { detail }),
  };
}

function arrayAt<T>(value: JsonObject | null, path: readonly string[]): readonly T[] {
  const found = unknownAt(value, path);
  return Array.isArray(found) ? (found as T[]) : [];
}

function objectAt(value: JsonObject | null, path: readonly string[]): JsonObject | null {
  const found = unknownAt(value, path);
  if (typeof found !== 'object' || found === null || Array.isArray(found)) {
    return null;
  }
  return found as JsonObject;
}

function numberAt(value: JsonObject | null, path: readonly string[]): number {
  const found = unknownAt(value, path);
  return typeof found === 'number' && Number.isFinite(found) ? found : 0;
}

function stringAt(value: JsonObject | null, path: readonly string[]): string | null {
  const found = unknownAt(value, path);
  return typeof found === 'string' ? found : null;
}

function unknownAt(value: JsonObject | null, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function writeReport(options: ResolvedOptions, report: Rel01ShortFinalPacketReport): void {
  writeFile(resolve(options.cwd, options.out_json), `${stableJsonStringify(report as unknown as JsonValue)}\n`);
  if (options.out_md !== null) {
    writeFile(resolve(options.cwd, options.out_md), renderMarkdown(report));
  }
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function renderMarkdown(report: Rel01ShortFinalPacketReport): string {
  const lines: string[] = [
    '# REL-01-Short Final Packet Report',
    '',
    `status: ${report.status}`,
    `ticket_id: ${report.ticket_id}`,
    '',
    '## Scope Decision',
    '',
    `- interim pilot only: ${report.scope_decision.rel01_short_interim_pilot_only}`,
    `- formal REL-01 10-session gate replaced: ${report.scope_decision.formal_rel01_10_session_gate_replaced}`,
    `- real-money execution allowed: ${report.scope_decision.real_money_execution_allowed}`,
    `- MBO decision use allowed: ${report.scope_decision.mbo_decision_use_allowed}`,
    `- DATA-01B full promotion allowed: ${report.scope_decision.data01b_full_promotion_allowed}`,
    '',
    '## Summary',
    '',
    `- sessions: ${report.summary.session_count}/${report.summary.required_sessions}`,
    `- REL-01A: ${report.summary.rel01a_status ?? 'missing'}`,
    `- REL-01D: ${report.summary.rel01d_status ?? 'missing'}`,
    `- REL-01E: ${report.summary.rel01e_status ?? 'missing'}`,
    `- source events: ${report.summary.total_source_events}`,
    `- order intents / fills: ${report.summary.order_intents}/${report.summary.sim_fills}`,
    `- provenance spot checks: ${report.summary.provenance_spot_checks.passed}/${report.summary.provenance_spot_checks.requested}`,
    `- restricted / blocked / shadow uses: ${report.summary.feature_surface.restricted_uses}/${report.summary.feature_surface.blocked_uses}/${report.summary.feature_surface.shadow_uses}`,
    `- REL-01E shadow field occurrences: ${report.summary.mbo_shadow_lineage.shadow_field_occurrences}`,
    '',
    '## Checks',
    '',
  ];
  for (const [groupName, groupItem] of Object.entries(report.check_groups)) {
    lines.push(`### ${groupName}: ${groupItem.status}`, '');
    for (const checkItem of groupItem.checks) {
      lines.push(`- ${checkItem.name}: ${checkItem.status}${checkItem.detail === undefined ? '' : ` (${checkItem.detail})`}`);
    }
    lines.push('');
  }
  lines.push('## Evidence', '');
  for (const [name, file] of Object.entries(report.evidence)) {
    lines.push(`- ${name}: ${file.path} sha256=${file.sha256 ?? 'missing'} exists=${file.exists}`);
  }
  lines.push('', '## Reasons', '');
  if (report.reasons.length === 0) {
    lines.push('- none');
  } else {
    for (const reason of report.reasons) {
      lines.push(`- ${reason}`);
    }
  }
  lines.push('', '## Next Blocker', '', report.next_blocker, '', report.no_raw_data_statement, '');
  return `${lines.join('\n')}\n`;
}

function toPortablePath(cwd: string, path: string): string {
  return relative(cwd, path).replace(/\\/gu, '/');
}

function parseArgs(argv: readonly string[]): MutableOptions {
  const parsed: MutableOptions = {};
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
    switch (key) {
      case 'manifest':
        parsed.manifest = value;
        break;
      case 'rel01a-report':
        parsed.rel01a_report = value;
        break;
      case 'rel01d-report':
        parsed.rel01d_report = value;
        break;
      case 'rel01e-report':
        parsed.rel01e_report = value;
        break;
      case 'policy-note':
        parsed.policy_note = value;
        break;
      case 'out-json':
        parsed.out_json = value;
        break;
      case 'out-md':
        parsed.out_md = value;
        break;
      case 'required-sessions':
        parsed.required_sessions = Number(value);
        break;
      default:
        throw new Error(`Unknown option --${key}`);
    }
    index += 1;
  }
  return parsed;
}

function requireString(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(processArgv.slice(2));
  const result = await runRel01ShortFinalPacket({
    manifest: requireString(args.manifest, 'manifest'),
    rel01a_report: requireString(args.rel01a_report, 'rel01a-report'),
    rel01d_report: requireString(args.rel01d_report, 'rel01d-report'),
    rel01e_report: requireString(args.rel01e_report, 'rel01e-report'),
    policy_note: requireString(args.policy_note, 'policy-note'),
    out_json: args.out_json ?? DEFAULT_OUT_JSON,
    out_md: args.out_md ?? DEFAULT_OUT_MD,
    required_sessions: args.required_sessions ?? DEFAULT_REQUIRED_SESSIONS,
  });
  processStdout.write(`REL-01-Short final packet: ${result.report.status}\n`);
  processStdout.write(`report=${args.out_json ?? DEFAULT_OUT_JSON}\n`);
  processStdout.write(`next_blocker=${result.report.next_blocker}\n`);
  processExit(result.exit_code);
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    processStderr.write(`${message}\n`);
    processExit(3);
  });
}
