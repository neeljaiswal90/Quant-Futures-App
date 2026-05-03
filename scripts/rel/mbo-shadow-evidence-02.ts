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
  journalEventFromJsonLine,
  stableJsonStringify,
  type JsonValue,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import { forEachJsonlLine, sha256File } from '../sim/streaming-jsonl.js';

export const MBO_SHADOW_EVIDENCE_02_SCHEMA_VERSION = 1 as const;
export const MBO_SHADOW_EVIDENCE_02_TICKET_ID = 'MBO-SHADOW-EVIDENCE-02' as const;

const DEFAULT_MIN_SESSIONS = 3;
const DEFAULT_IDEAL_SESSIONS = 5;
const DEFAULT_OUT_JSON = 'reports/rel/mbo_shadow_evidence_02_report.json';
const DEFAULT_OUT_MD = 'reports/rel/mbo_shadow_evidence_02_report.md';
const NO_RAW_DATA_STATEMENT =
  'MBO-SHADOW-EVIDENCE-02 indexes evidence report paths, SHA-256 hashes, validator statuses, aggregate counts, telemetry health summaries, and policy decisions only. It does not embed raw MBO rows, source windows, journal payloads, shadow payload values, DBN files, credentials, stdout, or stderr.';

const POLICY_POSTURE = {
  mbo_decision_use_allowed: false,
  mbo_advisory_use_allowed: false,
  mbo_derived_features_status: 'shadow_only',
  data01b_full_status: 'blocked',
  next_policy_ticket: 'DATA-MBO-ADR-01',
  queue_position_status: 'blocked',
  absorption_status: 'blocked',
  sweep_status: 'blocked',
  execution_mode: 'unchanged_simulated_only',
  runtime_trading_behavior_changed: false,
  decision_surface_changed: false,
} as const;

type CheckStatus = 'pass' | 'fail';
type Evidence02Status = 'pass' | 'fail';
type JsonObject = { readonly [key: string]: JsonValue };

export interface MboShadowEvidence02Options {
  readonly cwd?: string;
  readonly evidence01_report: string;
  readonly out_json?: string;
  readonly out_md?: string;
  readonly min_sessions?: number;
  readonly ideal_sessions?: number;
}

type MutableOptions = {
  -readonly [K in keyof MboShadowEvidence02Options]?: MboShadowEvidence02Options[K];
};

interface ResolvedOptions {
  readonly cwd: string;
  readonly evidence01_report: string;
  readonly out_json: string;
  readonly out_md: string | null;
  readonly min_sessions: number;
  readonly ideal_sessions: number;
}

interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

interface CheckGroup {
  readonly name: string;
  readonly status: CheckStatus;
  readonly checks: readonly Check[];
}

interface TelemetryHealthSummary {
  readonly source_mbo_event_count: number;
  readonly action_counts: Record<string, number>;
  readonly side_counts: Record<string, number>;
  readonly order_id_coverage: number | null;
  readonly order_id_present_count: number;
  readonly sequence_observed_count: number;
  readonly sequence_monotonic: boolean | null;
  readonly sequence_gap_count: number | null;
  readonly taxonomy_status: 'action_taxonomy_unresolved';
}

interface SessionSummary {
  readonly session_id: string;
  readonly run_id: string;
  readonly source_hash: string | null;
  readonly current_source_hash: string | null;
  readonly source_hash_matches_evidence01: boolean;
  readonly rel00_status: string | null;
  readonly rel01d_status: string | null;
  readonly rel01e_status: string | null;
  readonly shadow_events: number;
  readonly shadow_field_occurrences: number;
  readonly telemetry_health: TelemetryHealthSummary;
  readonly safety: {
    readonly real_order_event_types: number;
    readonly restricted_uses: number;
    readonly blocked_uses: number;
    readonly unsafe_decision_use_event_count: number;
  };
  readonly lineage: {
    readonly missing_source_event_count: number;
    readonly lookahead_source_event_count: number;
    readonly recompute_mismatch_count: number;
    readonly source_hash_mismatch_count: number;
  };
  readonly reasons: readonly string[];
}

export interface MboShadowEvidence02Report {
  readonly schema_version: typeof MBO_SHADOW_EVIDENCE_02_SCHEMA_VERSION;
  readonly ticket_id: typeof MBO_SHADOW_EVIDENCE_02_TICKET_ID;
  readonly status: Evidence02Status;
  readonly evidence01: {
    readonly path: string;
    readonly exists: boolean;
    readonly sha256: string | null;
    readonly ticket_id: string | null;
    readonly status: string | null;
    readonly session_count: number;
  };
  readonly policy_posture: typeof POLICY_POSTURE;
  readonly evidence_policy: {
    readonly minimum_sessions_required: number;
    readonly ideal_sessions: number;
    readonly current_stage: 'aggregate_shadow_evidence';
    readonly next_stage: 'mbo_taxonomy_policy_adr';
  };
  readonly aggregate: {
    readonly session_count: number;
    readonly source_mbo_event_count: number;
    readonly shadow_events: number;
    readonly shadow_field_occurrences: number;
    readonly action_counts: Record<string, number>;
    readonly side_counts: Record<string, number>;
    readonly order_id_coverage: number | null;
    readonly sequence_observed_sessions: number;
    readonly sequence_monotonic_sessions: number;
    readonly sequence_gap_count: number;
    readonly taxonomy_statuses: readonly string[];
    readonly rel00_pass_sessions: number;
    readonly rel01d_pass_sessions: number;
    readonly rel01e_pass_sessions: number;
    readonly source_hash_bound_sessions: number;
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
  readonly sessions: readonly SessionSummary[];
  readonly check_groups: readonly CheckGroup[];
  readonly reasons: readonly string[];
  readonly no_raw_data_statement: typeof NO_RAW_DATA_STATEMENT;
  readonly next_blocker: string;
}

interface SourceScan {
  readonly parse_errors: number;
  readonly source_mbo_event_count: number;
  readonly action_counts: Record<string, number>;
  readonly side_counts: Record<string, number>;
  readonly order_id_present_count: number;
  readonly sequence_observed_count: number;
  readonly sequence_monotonic: boolean | null;
  readonly sequence_gap_count: number | null;
}

export function runMboShadowEvidence02(
  options: MboShadowEvidence02Options,
): MboShadowEvidence02Report {
  const resolved = resolveOptions(options);
  const evidence01Path = resolve(resolved.cwd, resolved.evidence01_report);
  const evidence01 = readJsonObject(evidence01Path);
  const sessions = arrayAt<JsonObject>(evidence01, ['sessions'])
    .map((session) => buildSessionSummary(resolved.cwd, session));
  const aggregate = aggregateSessions(sessions, evidence01);
  const checkGroups = buildCheckGroups({
    evidence01,
    sessions,
    aggregate,
    minSessions: resolved.min_sessions,
  });
  const reasons = collectReasons(sessions, checkGroups);
  const report: MboShadowEvidence02Report = {
    schema_version: MBO_SHADOW_EVIDENCE_02_SCHEMA_VERSION,
    ticket_id: MBO_SHADOW_EVIDENCE_02_TICKET_ID,
    status: checkGroups.every((checkGroup) => checkGroup.status === 'pass') ? 'pass' : 'fail',
    evidence01: {
      path: toPortablePath(resolved.cwd, evidence01Path),
      exists: existsSync(evidence01Path),
      sha256: existsSync(evidence01Path) ? sha256File(evidence01Path) : null,
      ticket_id: stringAt(evidence01, ['ticket_id']),
      status: stringAt(evidence01, ['status']),
      session_count: numberAt(evidence01, ['aggregate', 'session_count']),
    },
    policy_posture: POLICY_POSTURE,
    evidence_policy: {
      minimum_sessions_required: resolved.min_sessions,
      ideal_sessions: resolved.ideal_sessions,
      current_stage: 'aggregate_shadow_evidence',
      next_stage: 'mbo_taxonomy_policy_adr',
    },
    aggregate,
    sessions,
    check_groups: checkGroups,
    reasons,
    no_raw_data_statement: NO_RAW_DATA_STATEMENT,
    next_blocker: checkGroups.every((checkGroup) => checkGroup.status === 'pass')
      ? 'Write DATA-MBO-ADR-01 before promoting any MBO shadow field beyond diagnostic collection.'
      : 'Collect enough passing MBO shadow diagnostic sessions and rerun MBO-SHADOW-EVIDENCE-02.',
  };
  writeReport(resolved, report);
  return report;
}

function resolveOptions(options: MboShadowEvidence02Options): ResolvedOptions {
  return {
    cwd: options.cwd ?? processCwd(),
    evidence01_report: options.evidence01_report,
    out_json: options.out_json ?? DEFAULT_OUT_JSON,
    out_md: options.out_md ?? DEFAULT_OUT_MD,
    min_sessions: normalizePositiveInteger(options.min_sessions ?? DEFAULT_MIN_SESSIONS, 'min_sessions'),
    ideal_sessions: normalizePositiveInteger(options.ideal_sessions ?? DEFAULT_IDEAL_SESSIONS, 'ideal_sessions'),
  };
}

function buildSessionSummary(cwd: string, session: JsonObject): SessionSummary {
  const sourcePath = resolve(cwd, stringAt(session, ['files', 'mbo_source_journal']) ?? '');
  const sourceExists = existsSync(sourcePath);
  const currentSourceHash = sourceExists ? sha256File(sourcePath) : null;
  const reportedSourceHash = stringAt(session, ['source_hash']);
  const sourceHashMatchesEvidence01 = currentSourceHash !== null
    && reportedSourceHash !== null
    && currentSourceHash === reportedSourceHash;
  const scan = sourceExists ? scanMboSourceJournal(sourcePath) : emptySourceScan();
  const reasons: string[] = [];
  if (!sourceExists) reasons.push('mbo_source_journal_missing');
  if (scan.parse_errors > 0) reasons.push(`mbo_source_parse_errors:${scan.parse_errors}`);
  if (!sourceHashMatchesEvidence01) reasons.push('mbo_source_hash_mismatch');
  const rel00Status = stringAt(session, ['rel00_status']);
  const rel01dStatus = stringAt(session, ['rel01d_status']);
  const rel01eStatus = stringAt(session, ['rel01e_status']);
  if (rel00Status !== 'pass') reasons.push(`rel00_status_not_pass:${rel00Status ?? 'missing'}`);
  if (rel01dStatus !== 'pass') reasons.push(`rel01d_status_not_pass:${rel01dStatus ?? 'missing'}`);
  if (rel01eStatus !== 'pass') reasons.push(`rel01e_status_not_pass:${rel01eStatus ?? 'missing'}`);

  return {
    session_id: stringAt(session, ['session_id']) ?? 'unknown-session',
    run_id: stringAt(session, ['run_id']) ?? 'unknown-run',
    source_hash: reportedSourceHash,
    current_source_hash: currentSourceHash,
    source_hash_matches_evidence01: sourceHashMatchesEvidence01,
    rel00_status: rel00Status,
    rel01d_status: rel01dStatus,
    rel01e_status: rel01eStatus,
    shadow_events: numberAt(session, ['shadow_events']),
    shadow_field_occurrences: numberAt(session, ['shadow_field_occurrences']),
    telemetry_health: {
      source_mbo_event_count: scan.source_mbo_event_count,
      action_counts: scan.action_counts,
      side_counts: scan.side_counts,
      order_id_coverage: scan.source_mbo_event_count === 0
        ? null
        : roundMetric(scan.order_id_present_count / scan.source_mbo_event_count),
      order_id_present_count: scan.order_id_present_count,
      sequence_observed_count: scan.sequence_observed_count,
      sequence_monotonic: scan.sequence_monotonic,
      sequence_gap_count: scan.sequence_gap_count,
      taxonomy_status: 'action_taxonomy_unresolved',
    },
    safety: {
      real_order_event_types: numberAt(session, ['safety', 'real_order_event_types']),
      restricted_uses: numberAt(session, ['safety', 'restricted_uses']),
      blocked_uses: numberAt(session, ['safety', 'blocked_uses']),
      unsafe_decision_use_event_count: numberAt(session, ['safety', 'unsafe_decision_use_event_count']),
    },
    lineage: {
      missing_source_event_count: numberAt(session, ['lineage', 'missing_source_event_count']),
      lookahead_source_event_count: numberAt(session, ['lineage', 'lookahead_source_event_count']),
      recompute_mismatch_count: numberAt(session, ['lineage', 'recompute_mismatch_count']),
      source_hash_mismatch_count: numberAt(session, ['lineage', 'source_hash_mismatch_count']),
    },
    reasons: reasons.sort(),
  };
}

function scanMboSourceJournal(filePath: string): SourceScan {
  let parseErrors = 0;
  let sourceMboEventCount = 0;
  let orderIdPresentCount = 0;
  let sequenceObservedCount = 0;
  let sequenceMonotonic: boolean | null = null;
  let sequenceGapCount: number | null = null;
  let previousSequence: bigint | null = null;
  const actionCounts = new Map<string, number>();
  const sideCounts = new Map<string, number>();

  forEachJsonlLine(filePath, (line) => {
    try {
      const event = journalEventFromJsonLine(line);
      if (event.type !== 'MICROSTRUCTURE') {
        return;
      }
      const payload = isJsonObject(event.payload) ? event.payload : {};
      sourceMboEventCount += 1;
      incrementCount(actionCounts, normalizeKey(stringFromPayload(payload, 'action')));
      incrementCount(sideCounts, normalizeKey(stringFromPayload(payload, 'side')));
      if (stringFromPayload(payload, 'order_id') !== null) {
        orderIdPresentCount += 1;
      }
      const sequence = bigintFromPayload(payload, 'sequence');
      if (sequence !== null) {
        sequenceObservedCount += 1;
        if (sequenceMonotonic === null) {
          sequenceMonotonic = true;
          sequenceGapCount = 0;
        }
        if (previousSequence !== null) {
          if (sequence < previousSequence) {
            sequenceMonotonic = false;
          }
          if (sequence > previousSequence + 1n) {
            sequenceGapCount = (sequenceGapCount ?? 0) + 1;
          }
        }
        previousSequence = sequence;
      }
    } catch {
      parseErrors += 1;
    }
  });

  return {
    parse_errors: parseErrors,
    source_mbo_event_count: sourceMboEventCount,
    action_counts: mapToSortedRecord(actionCounts),
    side_counts: mapToSortedRecord(sideCounts),
    order_id_present_count: orderIdPresentCount,
    sequence_observed_count: sequenceObservedCount,
    sequence_monotonic: sequenceMonotonic,
    sequence_gap_count: sequenceGapCount,
  };
}

function aggregateSessions(
  sessions: readonly SessionSummary[],
  evidence01: JsonObject | null,
): MboShadowEvidence02Report['aggregate'] {
  const totalSourceEvents = sessions.reduce(
    (total, session) => total + session.telemetry_health.source_mbo_event_count,
    0,
  );
  const totalOrderIds = sessions.reduce(
    (total, session) => total + session.telemetry_health.order_id_present_count,
    0,
  );
  const taxonomyStatuses = uniqueSorted(sessions.map((session) => session.telemetry_health.taxonomy_status));
  return {
    session_count: sessions.length,
    source_mbo_event_count: totalSourceEvents,
    shadow_events: sessions.reduce((total, session) => total + session.shadow_events, 0),
    shadow_field_occurrences: sessions.reduce((total, session) => total + session.shadow_field_occurrences, 0),
    action_counts: mergeCountRecords(...sessions.map((session) => session.telemetry_health.action_counts)),
    side_counts: mergeCountRecords(...sessions.map((session) => session.telemetry_health.side_counts)),
    order_id_coverage: totalSourceEvents === 0 ? null : roundMetric(totalOrderIds / totalSourceEvents),
    sequence_observed_sessions: sessions.filter((session) => session.telemetry_health.sequence_observed_count > 0).length,
    sequence_monotonic_sessions: sessions.filter((session) => session.telemetry_health.sequence_monotonic === true).length,
    sequence_gap_count: sessions.reduce((total, session) => total + (session.telemetry_health.sequence_gap_count ?? 0), 0),
    taxonomy_statuses: taxonomyStatuses,
    rel00_pass_sessions: numberAt(evidence01, ['aggregate', 'rel00_pass_sessions']),
    rel01d_pass_sessions: numberAt(evidence01, ['aggregate', 'rel01d_pass_sessions']),
    rel01e_pass_sessions: numberAt(evidence01, ['aggregate', 'rel01e_pass_sessions']),
    source_hash_bound_sessions: sessions.filter((session) => session.source_hash_matches_evidence01).length,
    safety: {
      real_order_event_types: numberAt(evidence01, ['aggregate', 'safety', 'real_order_event_types']),
      restricted_uses: numberAt(evidence01, ['aggregate', 'safety', 'restricted_uses']),
      blocked_uses: numberAt(evidence01, ['aggregate', 'safety', 'blocked_uses']),
      unsafe_decision_use_event_count: numberAt(evidence01, ['aggregate', 'safety', 'unsafe_decision_use_event_count']),
      unsafe_decision_use_validator_count_sum: numberAt(
        evidence01,
        ['aggregate', 'safety', 'unsafe_decision_use_validator_count_sum'],
      ),
    },
    lineage: {
      missing_source_event_count: numberAt(evidence01, ['aggregate', 'lineage', 'missing_source_event_count']),
      lookahead_source_event_count: numberAt(evidence01, ['aggregate', 'lineage', 'lookahead_source_event_count']),
      recompute_mismatch_count: numberAt(evidence01, ['aggregate', 'lineage', 'recompute_mismatch_count']),
      source_hash_mismatch_count: numberAt(evidence01, ['aggregate', 'lineage', 'source_hash_mismatch_count']),
    },
  };
}

function buildCheckGroups(input: {
  readonly evidence01: JsonObject | null;
  readonly sessions: readonly SessionSummary[];
  readonly aggregate: MboShadowEvidence02Report['aggregate'];
  readonly minSessions: number;
}): readonly CheckGroup[] {
  return [
    group('packet_checks', [
      checkBoolean('evidence01_report_exists_and_parses', input.evidence01 !== null, input.evidence01 === null ? 'missing_or_malformed' : 'ok'),
      checkBoolean('evidence01_ticket_id_matches', stringAt(input.evidence01, ['ticket_id']) === 'MBO-SHADOW-EVIDENCE-01', stringAt(input.evidence01, ['ticket_id']) ?? 'missing'),
      checkBoolean('evidence01_status_pass', stringAt(input.evidence01, ['status']) === 'pass', stringAt(input.evidence01, ['status']) ?? 'missing'),
      checkBoolean('minimum_session_count_met', input.sessions.length >= input.minSessions, `${input.sessions.length}/${input.minSessions}`),
      checkBoolean('session_ids_unique', uniqueSorted(input.sessions.map((session) => session.session_id)).length === input.sessions.length, String(input.sessions.length)),
      checkBoolean('source_hashes_bound_to_current_bytes', input.aggregate.source_hash_bound_sessions === input.sessions.length, `${input.aggregate.source_hash_bound_sessions}/${input.sessions.length}`),
    ]),
    group('validator_chain_checks', [
      checkBoolean('rel00_pass_all_sessions', input.aggregate.rel00_pass_sessions === input.sessions.length, `${input.aggregate.rel00_pass_sessions}/${input.sessions.length}`),
      checkBoolean('rel01d_pass_all_sessions', input.aggregate.rel01d_pass_sessions === input.sessions.length, `${input.aggregate.rel01d_pass_sessions}/${input.sessions.length}`),
      checkBoolean('rel01e_pass_all_sessions', input.aggregate.rel01e_pass_sessions === input.sessions.length, `${input.aggregate.rel01e_pass_sessions}/${input.sessions.length}`),
      checkBoolean('shadow_telemetry_present_all_sessions', input.sessions.every((session) => session.shadow_events > 0 && session.shadow_field_occurrences > 0), `shadow_events=${input.aggregate.shadow_events}`),
    ]),
    group('safety_checks', [
      checkBoolean('no_real_order_event_types', input.aggregate.safety.real_order_event_types === 0, String(input.aggregate.safety.real_order_event_types)),
      checkBoolean('no_restricted_uses', input.aggregate.safety.restricted_uses === 0, String(input.aggregate.safety.restricted_uses)),
      checkBoolean('no_blocked_uses', input.aggregate.safety.blocked_uses === 0, String(input.aggregate.safety.blocked_uses)),
      checkBoolean('no_decision_use_violations', input.aggregate.safety.unsafe_decision_use_event_count === 0, String(input.aggregate.safety.unsafe_decision_use_event_count)),
    ]),
    group('lineage_checks', [
      checkBoolean('no_missing_source_events', input.aggregate.lineage.missing_source_event_count === 0, String(input.aggregate.lineage.missing_source_event_count)),
      checkBoolean('no_lookahead_source_events', input.aggregate.lineage.lookahead_source_event_count === 0, String(input.aggregate.lineage.lookahead_source_event_count)),
      checkBoolean('no_recompute_mismatches', input.aggregate.lineage.recompute_mismatch_count === 0, String(input.aggregate.lineage.recompute_mismatch_count)),
      checkBoolean('no_source_hash_mismatches', input.aggregate.lineage.source_hash_mismatch_count === 0, String(input.aggregate.lineage.source_hash_mismatch_count)),
    ]),
    group('telemetry_health_checks', [
      checkBoolean('source_mbo_events_present', input.aggregate.source_mbo_event_count > 0, String(input.aggregate.source_mbo_event_count)),
      checkBoolean('action_counts_present', Object.keys(input.aggregate.action_counts).length > 0, Object.keys(input.aggregate.action_counts).join(',') || 'none'),
      checkBoolean('side_counts_present', Object.keys(input.aggregate.side_counts).length > 0, Object.keys(input.aggregate.side_counts).join(',') || 'none'),
      checkBoolean('order_id_coverage_nonzero', (input.aggregate.order_id_coverage ?? 0) > 0, String(input.aggregate.order_id_coverage ?? 'missing')),
      checkBoolean('sequence_observed_all_sessions', input.aggregate.sequence_observed_sessions === input.sessions.length, `${input.aggregate.sequence_observed_sessions}/${input.sessions.length}`),
      checkBoolean('sequence_monotonic_all_sessions', input.aggregate.sequence_monotonic_sessions === input.sessions.length, `${input.aggregate.sequence_monotonic_sessions}/${input.sessions.length}`),
      checkBoolean('taxonomy_status_unresolved', input.aggregate.taxonomy_statuses.length === 1 && input.aggregate.taxonomy_statuses[0] === 'action_taxonomy_unresolved', input.aggregate.taxonomy_statuses.join(',') || 'missing'),
    ]),
    group('promotion_guardrail_checks', [
      checkBoolean('mbo_decision_use_remains_blocked', POLICY_POSTURE.mbo_decision_use_allowed === false, String(POLICY_POSTURE.mbo_decision_use_allowed)),
      checkBoolean('mbo_advisory_use_not_yet_approved', POLICY_POSTURE.mbo_advisory_use_allowed === false, String(POLICY_POSTURE.mbo_advisory_use_allowed)),
      checkBoolean('queue_position_remains_blocked', POLICY_POSTURE.queue_position_status === 'blocked', POLICY_POSTURE.queue_position_status),
      checkBoolean('next_stage_is_taxonomy_adr', POLICY_POSTURE.next_policy_ticket === 'DATA-MBO-ADR-01', POLICY_POSTURE.next_policy_ticket),
    ]),
  ];
}

function emptySourceScan(): SourceScan {
  return {
    parse_errors: 0,
    source_mbo_event_count: 0,
    action_counts: {},
    side_counts: {},
    order_id_present_count: 0,
    sequence_observed_count: 0,
    sequence_monotonic: null,
    sequence_gap_count: null,
  };
}

function readJsonObject(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as JsonValue;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeReport(options: ResolvedOptions, report: MboShadowEvidence02Report): void {
  writeFile(resolve(options.cwd, options.out_json), `${stableJsonStringify(report as unknown as JsonValue)}\n`);
  if (options.out_md !== null) {
    writeFile(resolve(options.cwd, options.out_md), renderMarkdown(report));
  }
}

function renderMarkdown(report: MboShadowEvidence02Report): string {
  const lines: string[] = [
    '# MBO Shadow Evidence 02',
    '',
    `Status: ${report.status}`,
    '',
    'This report proves repeatability of diagnostic-only MBO shadow telemetry. It does not promote MBO to advisory or decision-use.',
    '',
    '## Policy',
    '',
    `- Minimum sessions: ${report.evidence_policy.minimum_sessions_required}`,
    `- Ideal sessions: ${report.evidence_policy.ideal_sessions}`,
    `- MBO decision-use allowed: ${report.policy_posture.mbo_decision_use_allowed}`,
    `- MBO advisory-use allowed: ${report.policy_posture.mbo_advisory_use_allowed}`,
    `- Next policy ticket: ${report.policy_posture.next_policy_ticket}`,
    '',
    '## Aggregate',
    '',
    `- Sessions: ${report.aggregate.session_count}`,
    `- Source MBO events: ${report.aggregate.source_mbo_event_count}`,
    `- Shadow events: ${report.aggregate.shadow_events}`,
    `- Shadow field occurrences: ${report.aggregate.shadow_field_occurrences}`,
    `- Order ID coverage: ${report.aggregate.order_id_coverage ?? '--'}`,
    `- Sequence monotonic sessions: ${report.aggregate.sequence_monotonic_sessions}/${report.aggregate.session_count}`,
    `- REL-00 / REL-01D / REL-01E pass: ${report.aggregate.rel00_pass_sessions}/${report.aggregate.rel01d_pass_sessions}/${report.aggregate.rel01e_pass_sessions}`,
    '',
    '## Checks',
    '',
  ];
  for (const checkGroup of report.check_groups) {
    lines.push(`### ${checkGroup.name}: ${checkGroup.status}`, '');
    for (const checkItem of checkGroup.checks) {
      lines.push(`- ${checkItem.name}: ${checkItem.status} (${checkItem.detail})`);
    }
    lines.push('');
  }
  lines.push('## Sessions', '');
  for (const session of report.sessions) {
    lines.push(`- ${session.session_id}: source_events=${session.telemetry_health.source_mbo_event_count}, shadow_events=${session.shadow_events}, order_id_coverage=${session.telemetry_health.order_id_coverage ?? '--'}, sequence_monotonic=${session.telemetry_health.sequence_monotonic ?? '--'}`);
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

function collectReasons(
  sessions: readonly SessionSummary[],
  checkGroups: readonly CheckGroup[],
): readonly string[] {
  const reasons: string[] = [];
  for (const session of sessions) {
    for (const reason of session.reasons) {
      reasons.push(`${session.session_id}:${reason}`);
    }
  }
  for (const checkGroup of checkGroups) {
    for (const checkItem of checkGroup.checks) {
      if (checkItem.status === 'fail') {
        reasons.push(`${checkGroup.name}:${checkItem.name}:${checkItem.detail}`);
      }
    }
  }
  return reasons.sort();
}

function checkBoolean(name: string, condition: boolean, detail: string): Check {
  return {
    name,
    status: condition ? 'pass' : 'fail',
    detail,
  };
}

function group(name: string, checks: readonly Check[]): CheckGroup {
  return {
    name,
    status: checks.every((checkItem) => checkItem.status === 'pass') ? 'pass' : 'fail',
    checks,
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

function bigintFromPayload(payload: JsonObject, key: string): bigint | null {
  const value = stringFromPayload(payload, key);
  if (value === null || !/^\d+$/u.test(value)) {
    return null;
  }
  return BigInt(value);
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

function mergeCountRecords(...records: readonly Record<string, number>[]): Record<string, number> {
  const merged = new Map<string, number>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      incrementCount(merged, key, record[key] ?? 0);
    }
  }
  return mapToSortedRecord(merged);
}

function numberAt(value: JsonObject | null, path: readonly string[]): number {
  const found = unknownAt(value, path);
  return typeof found === 'number' && Number.isFinite(found) ? found : 0;
}

function stringAt(value: JsonObject | null, path: readonly string[]): string | null {
  const found = unknownAt(value, path);
  return typeof found === 'string' ? found : null;
}

function arrayAt<T>(value: JsonObject | null, path: readonly string[]): readonly T[] {
  const found = unknownAt(value, path);
  return Array.isArray(found) ? (found as T[]) : [];
}

function unknownAt(value: JsonObject | null, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function roundMetric(value: number): number {
  return Number(value.toFixed(12));
}

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
  return value;
}

function writeFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function toPortablePath(cwd: string, filePath: string): string {
  const relativePath = relative(cwd, filePath).replace(/\\/gu, '/');
  return relativePath === '' || relativePath.startsWith('..') ? filePath.replace(/\\/gu, '/') : relativePath;
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
      case 'evidence01-report':
        parsed.evidence01_report = value;
        break;
      case 'out-json':
        parsed.out_json = value;
        break;
      case 'out-md':
        parsed.out_md = value;
        break;
      case 'min-sessions':
        parsed.min_sessions = Number(value);
        break;
      case 'ideal-sessions':
        parsed.ideal_sessions = Number(value);
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

function main(): void {
  const args = parseArgs(processArgv.slice(2));
  const report = runMboShadowEvidence02({
    evidence01_report: requireString(args.evidence01_report, 'evidence01-report'),
    out_json: args.out_json ?? DEFAULT_OUT_JSON,
    out_md: args.out_md ?? DEFAULT_OUT_MD,
    min_sessions: args.min_sessions ?? DEFAULT_MIN_SESSIONS,
    ideal_sessions: args.ideal_sessions ?? DEFAULT_IDEAL_SESSIONS,
  });
  processStdout.write(`MBO shadow evidence 02: ${report.status}\n`);
  processStdout.write(`sessions=${report.aggregate.session_count}\n`);
  processStdout.write(`min_sessions=${report.evidence_policy.minimum_sessions_required}\n`);
  processStdout.write(`next_blocker=${report.next_blocker}\n`);
  processExit(report.status === 'pass' ? 0 : 2);
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(2);
  }
}
