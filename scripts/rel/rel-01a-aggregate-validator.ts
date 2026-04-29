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
  parseJournalQueryArgs,
  runJournalQuery,
} from '../journal/journal-query.js';
import {
  forEachJsonlLine,
  sha256File,
} from '../sim/streaming-jsonl.js';
import {
  runRel00ControlledLiveSimReadiness,
  type Rel00Report,
} from './rel-00-controlled-live-sim-readiness.js';

export const REL_01A_REPORT_SCHEMA_VERSION = 1 as const;
export const REL_01A_MANIFEST_SCHEMA_VERSION = 1 as const;
export const REL_01A_TICKET_ID = 'REL-01A' as const;

const DEFAULT_OUT_JSON = 'reports/rel/rel01_aggregate_report.json';
const DEFAULT_OUT_MD = 'reports/rel/rel01_aggregate_report.md';
const DEFAULT_WORK_DIR = 'reports/rel/rel01a_validation';
const DEFAULT_REQUIRED_SESSIONS = 10;
const DEFAULT_MIN_SOURCE_EVENTS_PER_SESSION = 10_000;
const DEFAULT_PROVENANCE_SPOT_CHECKS = 5;
const NO_RAW_DATA_STATEMENT =
  'REL-01A indexes session paths, SHA-256 hashes, counts, statuses, and event identifiers only. It does not embed raw market-data rows, feature payload values, order payload values, DBN files, or runtime journal payloads.';

type Rel01aCompletionStatus = 'incomplete' | 'pass' | 'fail';
type Rel01aCheckStatus = 'pass' | 'fail';
type Rel01aExitCode = 0 | 2 | 3;

export interface Rel01aOptions {
  readonly cwd?: string;
  readonly manifest: string;
  readonly out_json?: string;
  readonly out_md?: string;
  readonly work_dir?: string;
  readonly required_sessions?: number;
  readonly min_source_events?: number;
  readonly strict?: boolean;
  readonly provenance_spot_checks?: number;
}

type MutableRel01aOptions = {
  -readonly [K in keyof Rel01aOptions]?: Rel01aOptions[K];
};

export interface Rel01aManifest {
  readonly schema_version: typeof REL_01A_MANIFEST_SCHEMA_VERSION;
  readonly rel01_run_id: string;
  readonly runtime_commit: string;
  readonly config_hash: string;
  readonly strategy_config_hash: string;
  readonly risk_config_hash: string;
  readonly management_config_hash: string;
  readonly sim03_report: string;
  readonly sim03_gate: string;
  readonly rel00b_report?: string;
  readonly sessions: readonly Rel01aSessionInput[];
}

export interface Rel01aSessionInput {
  readonly session_id: string;
  readonly run_id: string;
  readonly journal: string;
  readonly rel00_report: string;
  readonly rel00c_report?: string;
}

export interface Rel01aReport {
  readonly schema_version: typeof REL_01A_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof REL_01A_TICKET_ID;
  readonly status: Rel01aCompletionStatus;
  readonly run_id: string | null;
  readonly manifest: {
    readonly path: string;
    readonly sha256: string | null;
    readonly session_count: number;
    readonly required_sessions: number;
    readonly strict: boolean;
    readonly runtime_commit: string | null;
    readonly config_hash: string | null;
    readonly strategy_config_hash: string | null;
    readonly risk_config_hash: string | null;
    readonly management_config_hash: string | null;
  };
  readonly sim03_report: OptionalEvidenceSummary;
  readonly sim03_readiness: Sim03ReadinessSummary;
  readonly rel00b_evidence_index: OptionalEvidenceSummary;
  readonly sessions: readonly Rel01aSessionSummary[];
  readonly aggregate_counts: Rel01aAggregateCounts;
  readonly provenance_spot_checks: ProvenanceSpotCheckSummary;
  readonly check_groups: {
    readonly packet_checks: Rel01aCheckGroup;
    readonly sim03_checks: Rel01aCheckGroup;
    readonly rel00_prior_checks: Rel01aCheckGroup;
    readonly rel00c_generation_checks: Rel01aCheckGroup;
    readonly rel00_rerun_checks: Rel01aCheckGroup;
    readonly feature_surface_checks: Rel01aCheckGroup;
    readonly execution_safety_checks: Rel01aCheckGroup;
    readonly obs_evt_checks: Rel01aCheckGroup;
    readonly provenance_checks: Rel01aCheckGroup;
  };
  readonly reasons: readonly string[];
  readonly next_blocker: string;
  readonly no_raw_data_statement: typeof NO_RAW_DATA_STATEMENT;
}

interface Rel01aSessionSummary {
  readonly session_id: string;
  readonly run_id: string;
  readonly journal_path: string;
  readonly journal_sha256: string | null;
  readonly prior_rel00_report_path: string;
  readonly prior_rel00_status: string | null;
  readonly prior_rel00_journal_hash_matches: boolean;
  readonly rel00_rerun_status: string | null;
  readonly rel00c_report_path: string | null;
  readonly rel00c_status: string | null;
  readonly rel00c_journal_hash_matches: boolean | null;
  readonly rth_session: boolean;
  readonly file_existence: {
    readonly journal: boolean;
    readonly rel00_report: boolean;
    readonly rel00c_report: boolean | null;
  };
  readonly journal_config_hashes: readonly string[];
  readonly journal_run_ids: readonly string[];
  readonly source_events: number;
  readonly total_events: number;
  readonly feature_snapshots: number;
  readonly candidates: number;
  readonly order_intents: number;
  readonly sim_fills: number;
  readonly exec_rejects: number;
  readonly positions_opened: number;
  readonly positions_closed: number;
  readonly real_order_event_types: number;
  readonly blocked_feature_fields: readonly string[];
  readonly restricted_feature_fields: readonly string[];
  readonly quarantine_count: number;
  readonly parse_error_count: number;
  readonly traceability_status: string | null;
  readonly reasons: readonly string[];
}

interface Rel01aAggregateCounts {
  readonly session_count: number;
  readonly passing_prior_rel00_sessions: number;
  readonly passing_rel00_rerun_sessions: number;
  readonly total_events: number;
  readonly total_source_events: number;
  readonly feature_snapshots: number;
  readonly candidates: number;
  readonly order_intents: number;
  readonly sim_fills: number;
  readonly exec_rejects: number;
  readonly positions_opened: number;
  readonly positions_closed: number;
  readonly real_order_event_types: number;
  readonly blocked_feature_fields: readonly string[];
  readonly restricted_feature_fields: readonly string[];
  readonly strategy_activity_by_session: readonly StrategyActivityBySession[];
}

interface StrategyActivityBySession {
  readonly session_id: string;
  readonly source_events: number;
  readonly feature_snapshots: number;
  readonly candidates: number;
  readonly order_intents: number;
  readonly sim_fills: number;
  readonly exec_rejects: number;
}

interface Rel01aCheck {
  readonly name: string;
  readonly status: Rel01aCheckStatus;
  readonly detail?: string;
}

interface Rel01aCheckGroup {
  readonly status: Rel01aCheckStatus;
  readonly checks: readonly Rel01aCheck[];
}

interface Sim03ReadinessSummary {
  readonly path: string | null;
  readonly sha256: string | null;
  readonly ticket_id: string | null;
  readonly status: string | null;
  readonly ready_for_rel01_execution_simulation: boolean | null;
  readonly failure_reasons_count: number | null;
}

interface OptionalEvidenceSummary {
  readonly path: string | null;
  readonly sha256: string | null;
  readonly status: string | null;
  readonly present: boolean;
}

interface ProvenanceSpotCheckSummary {
  readonly requested: number;
  readonly attempted: number;
  readonly passed: number;
  readonly failed: number;
  readonly checks: readonly ProvenanceSpotCheck[];
}

interface ProvenanceSpotCheck {
  readonly session_id: string;
  readonly journal_path: string;
  readonly selector: 'terminal_event' | 'order_intent' | 'source_event';
  readonly event_id: string;
  readonly event_type: string;
  readonly status: Rel01aCheckStatus;
  readonly returned_event_count: number;
  readonly diagnostics_count: number;
  readonly missing_count: number;
}

interface SessionRuntimeCandidate {
  readonly session_id: string;
  readonly journal_path: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly selector: 'terminal_event' | 'order_intent' | 'source_event';
}

interface JournalLocalSummary {
  readonly config_hashes: readonly string[];
  readonly run_ids: readonly string[];
  readonly candidates: number;
  readonly feature_snapshots: number;
  readonly positions_opened: number;
  readonly positions_closed: number;
}

export async function runRel01aAggregateValidator(
  options: Rel01aOptions,
): Promise<{ readonly report: Rel01aReport; readonly exit_code: Rel01aExitCode }> {
  const cwd = resolve(options.cwd ?? processCwd());
  const manifestPath = resolve(cwd, options.manifest);
  const outJson = resolve(cwd, options.out_json ?? DEFAULT_OUT_JSON);
  const outMd = resolve(cwd, options.out_md ?? DEFAULT_OUT_MD);
  const workDir = resolve(cwd, options.work_dir ?? DEFAULT_WORK_DIR);
  const requiredSessions = options.required_sessions ?? DEFAULT_REQUIRED_SESSIONS;
  const minSourceEvents = options.min_source_events ?? DEFAULT_MIN_SOURCE_EVENTS_PER_SESSION;
  const strict = options.strict ?? true;
  const provenanceSpotChecks = options.provenance_spot_checks ?? DEFAULT_PROVENANCE_SPOT_CHECKS;

  mkdirSync(dirname(outJson), { recursive: true });
  mkdirSync(dirname(outMd), { recursive: true });
  mkdirSync(workDir, { recursive: true });

  try {
    const manifest = readManifest(manifestPath);
    const manifestHash = sha256File(manifestPath);
    const sim03Report = readOptionalEvidence(cwd, manifest.sim03_report);
    const sim03 = readSim03Readiness(cwd, manifest.sim03_gate);
    const rel00b = readOptionalEvidence(cwd, manifest.rel00b_report);
    const sessionSummaries: Rel01aSessionSummary[] = [];
    const spotCandidates: SessionRuntimeCandidate[] = [];

    for (let index = 0; index < manifest.sessions.length; index += 1) {
      const session = manifest.sessions[index]!;
      const summary = await validateSession({
        cwd,
        workDir,
        session,
        index,
        minSourceEvents,
        expectedConfigHash: manifest.config_hash,
        spotCandidates,
      });
      sessionSummaries.push(summary);
    }

    const provenance = runProvenanceSpotChecks(spotCandidates, provenanceSpotChecks);
    const aggregate = aggregateCounts(sessionSummaries);
    const checkGroups = buildCheckGroups({
      manifest,
      requiredSessions,
      sim03Report,
      sim03,
      sessions: sessionSummaries,
      aggregate,
      provenance,
      minSourceEvents,
    });
    const failureReasons = Object.entries(checkGroups).flatMap(([groupName, group]) =>
      group.checks
        .filter((check) => check.status === 'fail')
        .map((check) => `${groupName}:${check.name}: ${check.detail ?? 'failed'}`),
    );
    const completionStatus = classifyCompletion({
      failureReasons,
      sessionCount: manifest.sessions.length,
      requiredSessions,
    });

    const report: Rel01aReport = {
      schema_version: REL_01A_REPORT_SCHEMA_VERSION,
      ticket_id: REL_01A_TICKET_ID,
      status: completionStatus,
      run_id: manifest.rel01_run_id,
      manifest: {
        path: toReportPath(cwd, manifestPath),
        sha256: manifestHash,
        session_count: manifest.sessions.length,
        required_sessions: requiredSessions,
        strict,
        runtime_commit: manifest.runtime_commit,
        config_hash: manifest.config_hash,
        strategy_config_hash: manifest.strategy_config_hash,
        risk_config_hash: manifest.risk_config_hash,
        management_config_hash: manifest.management_config_hash,
      },
      sim03_report: sim03Report,
      sim03_readiness: sim03,
      rel00b_evidence_index: rel00b,
      sessions: sessionSummaries,
      aggregate_counts: aggregate,
      provenance_spot_checks: provenance,
      check_groups: checkGroups,
      reasons: failureReasons,
      next_blocker: completionStatus === 'pass'
        ? 'REL-01 candidate evidence packet passed; proceed to final release traceability review.'
        : completionStatus === 'incomplete'
          ? `Collect ${requiredSessions - manifest.sessions.length} more distinct passing RTH session(s), append them to the REL-01 manifest, then rerun REL-01A.`
          : 'Resolve failed REL-01A checks, regenerate affected REL-00 evidence, then rerun REL-01A.',
      no_raw_data_statement: NO_RAW_DATA_STATEMENT,
    };
    writeOutputs(outJson, outMd, report);
    return { report, exit_code: report.status === 'pass' ? 0 : 2 };
  } catch (error) {
    const report = invalidReport(cwd, manifestPath, errorMessage(error), requiredSessions, options.strict ?? true);
    writeOutputs(outJson, outMd, report);
    return { report, exit_code: 3 };
  }
}

async function validateSession(input: {
  readonly cwd: string;
  readonly workDir: string;
  readonly session: Rel01aSessionInput;
  readonly index: number;
  readonly minSourceEvents: number;
  readonly expectedConfigHash: string;
  readonly spotCandidates: SessionRuntimeCandidate[];
}): Promise<Rel01aSessionSummary> {
  const journalPath = resolve(input.cwd, input.session.journal);
  const rel00ReportPath = resolve(input.cwd, input.session.rel00_report);
  const rel00cReportPath = input.session.rel00c_report === undefined
    ? undefined
    : resolve(input.cwd, input.session.rel00c_report);
  const reasons: string[] = [];
  const journalSha256 = existsSync(journalPath) ? sha256File(journalPath) : null;
  if (journalSha256 === null) {
    reasons.push('journal_missing');
  }
  const rthSession = input.session.session_id.endsWith('-rth');
  if (!rthSession) {
    reasons.push('session_not_rth');
  }

  const priorRel00 = existsSync(rel00ReportPath)
    ? readJson(rel00ReportPath) as Partial<Rel00Report>
    : null;
  if (priorRel00 === null) {
    reasons.push('prior_rel00_report_missing');
  }
  const priorRel00Status = stringOrNull(priorRel00?.status);
  const priorRel00JournalHash = stringOrNull(priorRel00?.input?.journal_sha256);
  const priorRel00HashMatches =
    journalSha256 !== null && priorRel00JournalHash !== null && priorRel00JournalHash === journalSha256;
  if (priorRel00Status !== 'pass') {
    reasons.push(`prior_rel00_status_${priorRel00Status ?? 'missing'}`);
  }
  if (!priorRel00HashMatches) {
    reasons.push('prior_rel00_journal_hash_mismatch');
  }

  const rel00c = rel00cReportPath !== undefined && existsSync(rel00cReportPath)
    ? readJson(rel00cReportPath) as {
        readonly status?: unknown;
        readonly output?: { readonly out_journal_hash?: unknown };
      }
    : null;
  const rel00cStatus = stringOrNull(rel00c?.status);
  const rel00cJournalHash = stringOrNull(rel00c?.output?.out_journal_hash);
  const rel00cHashMatches = rel00cReportPath === undefined
    ? null
    : journalSha256 !== null && rel00cJournalHash !== null && rel00cJournalHash === journalSha256;
  if (rel00cReportPath !== undefined && rel00c === null) {
    reasons.push('rel00c_report_missing');
  }
  if (rel00cReportPath !== undefined && rel00cStatus !== 'generated' && rel00cStatus !== 'pass') {
    reasons.push(`rel00c_status_${rel00cStatus ?? 'missing'}`);
  }
  if (rel00cReportPath !== undefined && rel00cHashMatches !== true) {
    reasons.push('rel00c_journal_hash_mismatch');
  }

  const rel00Rerun = existsSync(journalPath)
    ? await runRel00ControlledLiveSimReadiness({
        cwd: input.cwd,
        journal: journalPath,
        out_json: resolve(input.workDir, `session_${String(input.index + 1).padStart(2, '0')}_rel00.json`),
        out_md: resolve(input.workDir, `session_${String(input.index + 1).padStart(2, '0')}_rel00.md`),
        validation_dir: resolve(input.workDir, `session_${String(input.index + 1).padStart(2, '0')}_rel00_transport`),
        min_source_events: input.minSourceEvents,
      })
    : null;
  if (rel00Rerun?.report.status !== 'pass') {
    reasons.push(`rel00_rerun_status_${rel00Rerun?.report.status ?? 'missing'}`);
  }

  const report = rel00Rerun?.report;
  const localJournal = existsSync(journalPath)
    ? scanJournalLocalSummary(journalPath)
    : emptyJournalLocalSummary();
  if (!localJournal.config_hashes.includes(input.expectedConfigHash)) {
    reasons.push('journal_config_hash_missing_or_unstable');
  }
  if (localJournal.run_ids.length !== 1 || localJournal.run_ids[0] !== input.session.run_id) {
    reasons.push('journal_run_id_mismatch');
  }
  if (report !== undefined) {
    input.spotCandidates.push(...collectSpotCandidates(input.session.session_id, journalPath));
  }

  return {
    session_id: input.session.session_id,
    run_id: input.session.run_id,
    journal_path: toReportPath(input.cwd, journalPath),
    journal_sha256: journalSha256,
    prior_rel00_report_path: toReportPath(input.cwd, rel00ReportPath),
    prior_rel00_status: priorRel00Status,
    prior_rel00_journal_hash_matches: priorRel00HashMatches,
    rel00_rerun_status: stringOrNull(report?.status),
    rel00c_report_path: rel00cReportPath === undefined ? null : toReportPath(input.cwd, rel00cReportPath),
    rel00c_status: rel00cStatus,
    rel00c_journal_hash_matches: rel00cHashMatches,
    rth_session: rthSession,
    file_existence: {
      journal: existsSync(journalPath),
      rel00_report: existsSync(rel00ReportPath),
      rel00c_report: rel00cReportPath === undefined ? null : existsSync(rel00cReportPath),
    },
    journal_config_hashes: localJournal.config_hashes,
    journal_run_ids: localJournal.run_ids,
    source_events: sumRecordValues(report?.source_event_counts),
    total_events: sumRecordValues(report?.event_counts),
    feature_snapshots: localJournal.feature_snapshots,
    candidates: localJournal.candidates,
    order_intents: numberRecordValue(report?.event_counts, 'ORDER_INTENT'),
    sim_fills: numberRecordValue(report?.event_counts, 'SIM_FILL'),
    exec_rejects: numberRecordValue(report?.event_counts, 'EXEC_REJECT'),
    positions_opened: localJournal.positions_opened,
    positions_closed: localJournal.positions_closed,
    real_order_event_types: sumRecordValues(report?.raw_scan_summary.real_order_event_type_counts),
    blocked_feature_fields: uniqueSorted(report?.feature_surface_summary.blocked_fields.map((field) => field.canonical_field) ?? []),
    restricted_feature_fields: uniqueSorted(report?.feature_surface_summary.restricted_fields.map((field) => field.canonical_field) ?? []),
    quarantine_count: report?.transport_checks.checks.find((check) => check.name === 'journal_transport_no_quarantine')?.detail === undefined
      ? 0
      : Number(report.transport_checks.checks.find((check) => check.name === 'journal_transport_no_quarantine')?.detail ?? 0),
    parse_error_count: report?.raw_scan_summary.parse_error_count ?? 0,
    traceability_status: stringOrNull(report?.traceability_checks.status),
    reasons: uniqueSorted(reasons),
  };
}

function collectSpotCandidates(sessionId: string, journalPath: string): readonly SessionRuntimeCandidate[] {
  const terminals: SessionRuntimeCandidate[] = [];
  const intents: SessionRuntimeCandidate[] = [];
  const sources: SessionRuntimeCandidate[] = [];
  forEachJsonlLine(journalPath, (line) => {
    if (line.trim() === '') {
      return;
    }
    let event: JournalEventEnvelope;
    try {
      event = journalEventFromJsonLine(line);
    } catch {
      return;
    }
    const candidate: SessionRuntimeCandidate = {
      session_id: sessionId,
      journal_path: journalPath,
      event_id: String(event.event_id),
      event_type: event.type,
      selector: event.type === 'SIM_FILL' || event.type === 'EXEC_REJECT'
        ? 'terminal_event'
        : event.type === 'ORDER_INTENT'
          ? 'order_intent'
          : 'source_event',
    };
    if (candidate.selector === 'terminal_event') {
      terminals.push(candidate);
    } else if (candidate.selector === 'order_intent') {
      intents.push(candidate);
    } else if (event.type === 'QUOTE' || event.type === 'TRADE') {
      sources.push(candidate);
    }
  });
  return [...terminals, ...intents, ...sources];
}

function scanJournalLocalSummary(journalPath: string): JournalLocalSummary {
  const configHashes = new Set<string>();
  const runIds = new Set<string>();
  let candidates = 0;
  let featureSnapshots = 0;
  let positionsOpened = 0;
  let positionsClosed = 0;
  forEachJsonlLine(journalPath, (line) => {
    if (line.trim() === '') {
      return;
    }
    let event: JournalEventEnvelope;
    try {
      event = journalEventFromJsonLine(line);
    } catch {
      return;
    }
    runIds.add(String(event.run_id));
    const envelopeConfigHash = jsonObject(event.config)?.config_hash;
    if (typeof envelopeConfigHash === 'string') {
      configHashes.add(envelopeConfigHash);
    }
    const payload = jsonObject(event.payload);
    if (event.type === 'CONFIG' && typeof payload.config_hash === 'string') {
      configHashes.add(payload.config_hash);
    }
    if (event.type === 'FEATURES') {
      featureSnapshots += 1;
    }
    if (event.type === 'CANDIDATE') {
      candidates += 1;
    }
    if (event.type === 'POSITION') {
      const status = typeof payload.status === 'string' ? payload.status : '';
      if (status === 'closed' || status === 'flat') {
        positionsClosed += 1;
      } else {
        positionsOpened += 1;
      }
    }
  });
  return {
    config_hashes: [...configHashes].sort(),
    run_ids: [...runIds].sort(),
    candidates,
    feature_snapshots: featureSnapshots,
    positions_opened: positionsOpened,
    positions_closed: positionsClosed,
  };
}

function emptyJournalLocalSummary(): JournalLocalSummary {
  return {
    config_hashes: [],
    run_ids: [],
    candidates: 0,
    feature_snapshots: 0,
    positions_opened: 0,
    positions_closed: 0,
  };
}

function runProvenanceSpotChecks(
  candidates: readonly SessionRuntimeCandidate[],
  requested: number,
): ProvenanceSpotCheckSummary {
  const selected = candidates.slice(0, Math.max(0, requested));
  const checks = selected.map((candidate) => {
    const result = runJournalQuery(parseJournalQueryArgs([
      '--journal',
      candidate.journal_path,
      '--event',
      candidate.event_id,
      '--format',
      'json',
      '--strict',
    ]));
    const status: Rel01aCheckStatus =
      result.exit_code === 0 &&
      result.diagnostics.length === 0 &&
      result.missing.length === 0 &&
      result.events.some((event) => String(event.event_id) === candidate.event_id)
        ? 'pass'
        : 'fail';
    return {
      session_id: candidate.session_id,
      journal_path: candidate.journal_path,
      selector: candidate.selector,
      event_id: candidate.event_id,
      event_type: candidate.event_type,
      status,
      returned_event_count: result.events.length,
      diagnostics_count: result.diagnostics.length,
      missing_count: result.missing.length,
    };
  });
  return {
    requested,
    attempted: checks.length,
    passed: checks.filter((check) => check.status === 'pass').length,
    failed: checks.filter((check) => check.status === 'fail').length,
    checks,
  };
}

function buildCheckGroups(input: {
  readonly manifest: Rel01aManifest;
  readonly requiredSessions: number;
  readonly sim03Report: OptionalEvidenceSummary;
  readonly sim03: Sim03ReadinessSummary;
  readonly sessions: readonly Rel01aSessionSummary[];
  readonly aggregate: Rel01aAggregateCounts;
  readonly provenance: ProvenanceSpotCheckSummary;
  readonly minSourceEvents: number;
}): Rel01aReport['check_groups'] {
  const duplicateSessions = duplicateValues(input.manifest.sessions.map((session) => session.session_id));
  const duplicateRunIds = duplicateValues(input.manifest.sessions.map((session) => session.run_id));
  return {
    packet_checks: group([
      checkBoolean('manifest_schema_version_supported', input.manifest.schema_version === REL_01A_MANIFEST_SCHEMA_VERSION, `${input.manifest.schema_version}`),
      checkBoolean('manifest_required_hashes_present', [
        input.manifest.runtime_commit,
        input.manifest.config_hash,
        input.manifest.strategy_config_hash,
        input.manifest.risk_config_hash,
        input.manifest.management_config_hash,
      ].every((value) => value.trim() !== ''), 'runtime/config hashes are required'),
      checkBoolean('session_count_progress_recorded', input.manifest.sessions.length > 0, `${input.manifest.sessions.length}/${input.requiredSessions}`),
      checkBoolean('session_ids_unique', duplicateSessions.length === 0, duplicateSessions.join(',')),
      checkBoolean('run_ids_unique', duplicateRunIds.length === 0, duplicateRunIds.join(',')),
      checkBoolean('all_sessions_are_rth', input.sessions.every((session) => session.rth_session), mismatchSessionDetail(input.sessions, (session) => !session.rth_session)),
      checkBoolean('all_referenced_files_exist', input.sessions.every((session) =>
        session.file_existence.journal &&
        session.file_existence.rel00_report &&
        session.file_existence.rel00c_report !== false,
      ), mismatchSessionDetail(input.sessions, (session) =>
        !session.file_existence.journal ||
        !session.file_existence.rel00_report ||
        session.file_existence.rel00c_report === false,
      )),
      checkBoolean('journal_config_hashes_match_manifest', input.sessions.every((session) =>
        session.journal_config_hashes.includes(input.manifest.config_hash),
      ), mismatchSessionDetail(input.sessions, (session) => !session.journal_config_hashes.includes(input.manifest.config_hash))),
    ]),
    sim03_checks: group([
      checkBoolean('sim03_report_present', input.sim03Report.present, input.sim03Report.path ?? 'missing'),
      checkBoolean('sim03d_report_present', input.sim03.path !== null, input.sim03.path ?? 'missing'),
      checkBoolean('sim03d_status_pass', input.sim03.status === 'pass', input.sim03.status ?? 'missing'),
      checkBoolean('sim03d_ready_for_rel01_execution_simulation', input.sim03.ready_for_rel01_execution_simulation === true, `${input.sim03.ready_for_rel01_execution_simulation}`),
      checkBoolean('sim03d_failure_reasons_empty', input.sim03.failure_reasons_count === 0, `${input.sim03.failure_reasons_count}`),
    ]),
    rel00_prior_checks: group([
      checkBoolean('all_sessions_have_prior_rel00_pass', input.sessions.every((session) => session.prior_rel00_status === 'pass'), `${input.aggregate.passing_prior_rel00_sessions}/${input.sessions.length}`),
      checkBoolean('all_prior_rel00_reports_match_journal_hash', input.sessions.every((session) => session.prior_rel00_journal_hash_matches), mismatchSessionDetail(input.sessions, (session) => !session.prior_rel00_journal_hash_matches)),
    ]),
    rel00c_generation_checks: group([
      checkBoolean('all_sessions_have_rel00c_generated_report', input.sessions.every((session) => session.rel00c_status === 'generated' || session.rel00c_status === 'pass'), mismatchSessionDetail(input.sessions, (session) => session.rel00c_status !== 'generated' && session.rel00c_status !== 'pass')),
      checkBoolean('all_rel00c_reports_match_journal_hash', input.sessions.every((session) => session.rel00c_journal_hash_matches !== false), mismatchSessionDetail(input.sessions, (session) => session.rel00c_journal_hash_matches === false)),
    ]),
    rel00_rerun_checks: group([
      checkBoolean('all_sessions_pass_current_rel00_validator', input.sessions.every((session) => session.rel00_rerun_status === 'pass'), `${input.aggregate.passing_rel00_rerun_sessions}/${input.sessions.length}`),
      checkBoolean('all_sessions_meet_min_source_events', input.sessions.every((session) => session.source_events >= input.minSourceEvents), mismatchSessionDetail(input.sessions, (session) => session.source_events < input.minSourceEvents)),
    ]),
    feature_surface_checks: group([
      checkBoolean('no_blocked_feature_fields_used', input.aggregate.blocked_feature_fields.length === 0, input.aggregate.blocked_feature_fields.join(',')),
      checkBoolean('no_restricted_or_mbo_subscope_fields_used', input.aggregate.restricted_feature_fields.length === 0, input.aggregate.restricted_feature_fields.join(',')),
    ]),
    execution_safety_checks: group([
      checkBoolean('real_order_event_types_absent', input.aggregate.real_order_event_types === 0, `${input.aggregate.real_order_event_types}`),
      checkBoolean('simulated_terminal_events_present_or_no_order_intents', input.aggregate.order_intents === 0 || input.aggregate.sim_fills + input.aggregate.exec_rejects > 0, `intents=${input.aggregate.order_intents}, terminals=${input.aggregate.sim_fills + input.aggregate.exec_rejects}`),
    ]),
    obs_evt_checks: group([
      checkBoolean('all_journals_parse_without_quarantine', input.sessions.every((session) => session.quarantine_count === 0 && session.parse_error_count === 0), mismatchSessionDetail(input.sessions, (session) => session.quarantine_count > 0 || session.parse_error_count > 0)),
      checkBoolean('all_order_intents_have_traceable_terminals', input.sessions.every((session) => session.traceability_status === 'pass'), mismatchSessionDetail(input.sessions, (session) => session.traceability_status !== 'pass')),
    ]),
    provenance_checks: group([
      checkBoolean('tui04_provenance_spot_checks_attempted', input.provenance.attempted === input.provenance.requested, `${input.provenance.attempted}/${input.provenance.requested}`),
      checkBoolean('tui04_provenance_spot_checks_pass', input.provenance.failed === 0 && input.provenance.passed === input.provenance.requested, `passed=${input.provenance.passed}, failed=${input.provenance.failed}`),
    ]),
  };
}

function aggregateCounts(sessions: readonly Rel01aSessionSummary[]): Rel01aAggregateCounts {
  return {
    session_count: sessions.length,
    passing_prior_rel00_sessions: sessions.filter((session) => session.prior_rel00_status === 'pass').length,
    passing_rel00_rerun_sessions: sessions.filter((session) => session.rel00_rerun_status === 'pass').length,
    total_events: sum(sessions.map((session) => session.total_events)),
    total_source_events: sum(sessions.map((session) => session.source_events)),
    feature_snapshots: sum(sessions.map((session) => session.feature_snapshots)),
    candidates: sum(sessions.map((session) => session.candidates)),
    order_intents: sum(sessions.map((session) => session.order_intents)),
    sim_fills: sum(sessions.map((session) => session.sim_fills)),
    exec_rejects: sum(sessions.map((session) => session.exec_rejects)),
    positions_opened: sum(sessions.map((session) => session.positions_opened)),
    positions_closed: sum(sessions.map((session) => session.positions_closed)),
    real_order_event_types: sum(sessions.map((session) => session.real_order_event_types)),
    blocked_feature_fields: uniqueSorted(sessions.flatMap((session) => session.blocked_feature_fields)),
    restricted_feature_fields: uniqueSorted(sessions.flatMap((session) => session.restricted_feature_fields)),
    strategy_activity_by_session: sessions.map((session) => ({
      session_id: session.session_id,
      source_events: session.source_events,
      feature_snapshots: session.feature_snapshots,
      candidates: session.candidates,
      order_intents: session.order_intents,
      sim_fills: session.sim_fills,
      exec_rejects: session.exec_rejects,
    })),
  };
}

function classifyCompletion(input: {
  readonly failureReasons: readonly string[];
  readonly sessionCount: number;
  readonly requiredSessions: number;
}): Rel01aCompletionStatus {
  if (input.failureReasons.length > 0) {
    return 'fail';
  }
  return input.sessionCount >= input.requiredSessions ? 'pass' : 'incomplete';
}

function readManifest(path: string): Rel01aManifest {
  const parsed = readJson(path) as Partial<Rel01aManifest>;
  if (parsed.schema_version !== REL_01A_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`REL-01A manifest schema_version must be ${REL_01A_MANIFEST_SCHEMA_VERSION}`);
  }
  for (const field of [
    'rel01_run_id',
    'runtime_commit',
    'config_hash',
    'strategy_config_hash',
    'risk_config_hash',
    'management_config_hash',
    'sim03_report',
    'sim03_gate',
  ] as const) {
    if (!isString(parsed[field]) || parsed[field].trim() === '') {
      throw new Error(`REL-01A manifest ${field} is required`);
    }
  }
  if (!Array.isArray(parsed.sessions)) {
    throw new Error('REL-01A manifest sessions must be an array');
  }
  for (const [index, session] of parsed.sessions.entries()) {
    if (!isString(session.session_id) || !isString(session.run_id) || !isString(session.journal) || !isString(session.rel00_report) || !isString(session.rel00c_report)) {
      throw new Error(`REL-01A manifest session ${index + 1} must include session_id, run_id, journal, rel00_report, and rel00c_report`);
    }
  }
  return parsed as Rel01aManifest;
}

function readSim03Readiness(cwd: string, path: string): Sim03ReadinessSummary {
  const resolved = resolve(cwd, path);
  if (!existsSync(resolved)) {
    return {
      path: toReportPath(cwd, resolved),
      sha256: null,
      ticket_id: null,
      status: null,
      ready_for_rel01_execution_simulation: null,
      failure_reasons_count: null,
    };
  }
  const report = readJson(resolved) as {
    readonly ticket_id?: unknown;
    readonly status?: unknown;
    readonly ready_for_rel01_execution_simulation?: unknown;
    readonly failure_reasons?: unknown;
  };
  return {
    path: toReportPath(cwd, resolved),
    sha256: sha256File(resolved),
    ticket_id: stringOrNull(report.ticket_id),
    status: stringOrNull(report.status),
    ready_for_rel01_execution_simulation: typeof report.ready_for_rel01_execution_simulation === 'boolean'
      ? report.ready_for_rel01_execution_simulation
      : null,
    failure_reasons_count: Array.isArray(report.failure_reasons) ? report.failure_reasons.length : null,
  };
}

function readOptionalEvidence(cwd: string, path: string | undefined): OptionalEvidenceSummary {
  if (path === undefined) {
    return { path: null, sha256: null, status: null, present: false };
  }
  const resolved = resolve(cwd, path);
  if (!existsSync(resolved)) {
    return { path: toReportPath(cwd, resolved), sha256: null, status: null, present: false };
  }
  const report = readJson(resolved) as { readonly status?: unknown };
  return {
    path: toReportPath(cwd, resolved),
    sha256: sha256File(resolved),
    status: stringOrNull(report.status),
    present: true,
  };
}

function invalidReport(cwd: string, manifestPath: string, reason: string, requiredSessions: number, strict: boolean): Rel01aReport {
  const packet = group([
    checkBoolean('manifest_parseable', false, reason),
  ]);
  return {
    schema_version: REL_01A_REPORT_SCHEMA_VERSION,
    ticket_id: REL_01A_TICKET_ID,
    status: 'fail',
    run_id: null,
    manifest: {
      path: toReportPath(cwd, manifestPath),
      sha256: existsSync(manifestPath) ? sha256File(manifestPath) : null,
      session_count: 0,
      required_sessions: requiredSessions,
      strict,
      runtime_commit: null,
      config_hash: null,
      strategy_config_hash: null,
      risk_config_hash: null,
      management_config_hash: null,
    },
    sim03_report: { path: null, sha256: null, status: null, present: false },
    sim03_readiness: {
      path: null,
      sha256: null,
      ticket_id: null,
      status: null,
      ready_for_rel01_execution_simulation: null,
      failure_reasons_count: null,
    },
    rel00b_evidence_index: { path: null, sha256: null, status: null, present: false },
    sessions: [],
    aggregate_counts: {
      session_count: 0,
      passing_prior_rel00_sessions: 0,
      passing_rel00_rerun_sessions: 0,
      total_events: 0,
      total_source_events: 0,
      feature_snapshots: 0,
      candidates: 0,
      order_intents: 0,
      sim_fills: 0,
      exec_rejects: 0,
      positions_opened: 0,
      positions_closed: 0,
      real_order_event_types: 0,
      blocked_feature_fields: [],
      restricted_feature_fields: [],
      strategy_activity_by_session: [],
    },
    provenance_spot_checks: {
      requested: 0,
      attempted: 0,
      passed: 0,
      failed: 0,
      checks: [],
    },
    check_groups: {
      packet_checks: packet,
      sim03_checks: group([]),
      rel00_prior_checks: group([]),
      rel00c_generation_checks: group([]),
      rel00_rerun_checks: group([]),
      feature_surface_checks: group([]),
      execution_safety_checks: group([]),
      obs_evt_checks: group([]),
      provenance_checks: group([]),
    },
    reasons: [`packet_checks:manifest_parseable: ${reason}`],
    next_blocker: 'Fix REL-01A run packet input and rerun REL-01A.',
    no_raw_data_statement: NO_RAW_DATA_STATEMENT,
  };
}

function writeOutputs(outJson: string, outMd: string, report: Rel01aReport): void {
  writeFileSync(outJson, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
  writeFileSync(outMd, markdownReport(report), 'utf8');
}

function markdownReport(report: Rel01aReport): string {
  return [
    '# REL-01A 10-Session Controlled Live-Sim Validation',
    '',
    `Status: ${report.status}`,
    `Run ID: ${report.run_id ?? 'unavailable'}`,
    `Sessions: ${report.manifest.session_count}/${report.manifest.required_sessions}`,
    `SIM-03D ready: ${report.sim03_readiness.ready_for_rel01_execution_simulation}`,
    `Prior REL-00 passes: ${report.aggregate_counts.passing_prior_rel00_sessions}/${report.aggregate_counts.session_count}`,
    `REL-00 rerun passes: ${report.aggregate_counts.passing_rel00_rerun_sessions}/${report.aggregate_counts.session_count}`,
    `Source events: ${report.aggregate_counts.total_source_events}`,
    `Feature snapshots: ${report.aggregate_counts.feature_snapshots}`,
    `Candidates: ${report.aggregate_counts.candidates}`,
    `Order intents: ${report.aggregate_counts.order_intents}`,
    `Sim fills: ${report.aggregate_counts.sim_fills}`,
    `Exec rejects: ${report.aggregate_counts.exec_rejects}`,
    `Positions opened: ${report.aggregate_counts.positions_opened}`,
    `Positions closed: ${report.aggregate_counts.positions_closed}`,
    `Real-order event types: ${report.aggregate_counts.real_order_event_types}`,
    `Blocked fields: ${report.aggregate_counts.blocked_feature_fields.join(',') || 'none'}`,
    `Restricted fields: ${report.aggregate_counts.restricted_feature_fields.join(',') || 'none'}`,
    `TUI-04 spot checks: ${report.provenance_spot_checks.passed}/${report.provenance_spot_checks.requested}`,
    '',
    '## Reasons',
    ...(report.reasons.length === 0 ? ['none'] : report.reasons.map((reason) => `- ${reason}`)),
    '',
    `Next blocker: ${report.next_blocker}`,
    '',
    report.no_raw_data_statement,
    '',
  ].join('\n');
}

function group(checks: readonly Rel01aCheck[]): Rel01aCheckGroup {
  return {
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    checks,
  };
}

function checkBoolean(name: string, passed: boolean, detail?: string): Rel01aCheck {
  return {
    name,
    status: passed ? 'pass' : 'fail',
    ...(detail === undefined ? {} : { detail }),
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function toReportPath(cwd: string, path: string): string {
  const rel = relative(cwd, path).replace(/\\/gu, '/');
  return rel.startsWith('..') ? path.replace(/\\/gu, '/') : rel;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumRecordValues(record: Record<string, number> | null | undefined): number {
  return record == null ? 0 : sum(Object.values(record));
}

function numberRecordValue(record: Record<string, number> | null | undefined, key: string): number {
  return record?.[key] ?? 0;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
}

function mismatchSessionDetail(
  sessions: readonly Rel01aSessionSummary[],
  predicate: (session: Rel01aSessionSummary) => boolean,
): string {
  return sessions.filter(predicate).map((session) => session.session_id).join(',');
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRel01aArgs(args: readonly string[]): Rel01aOptions {
  const options: MutableRel01aOptions = {};
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
      case '--work-dir':
        index += 1;
        options.work_dir = requireArgValue(arg, args[index]);
        break;
      case '--required-sessions':
        index += 1;
        options.required_sessions = parsePositiveInteger(arg, requireArgValue(arg, args[index]));
        break;
      case '--min-source-events':
        index += 1;
        options.min_source_events = parsePositiveInteger(arg, requireArgValue(arg, args[index]));
        break;
      case '--strict':
        if (args[index + 1] !== undefined && !args[index + 1]!.startsWith('--')) {
          index += 1;
          options.strict = parseBoolean(arg, args[index]!);
        } else {
          options.strict = true;
        }
        break;
      case '--no-strict':
        options.strict = false;
        break;
      case '--provenance-spot-checks':
        index += 1;
        options.provenance_spot_checks = parseNonNegativeInteger(arg, requireArgValue(arg, args[index]));
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
  return options as Rel01aOptions;
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function parseBoolean(flag: string, value: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${flag} must be true or false`);
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage(): string {
  return [
    'Usage: npm run rel:01a:aggregate -- --manifest path [--out-json path] [--out-md path] [--work-dir path] [--required-sessions n] [--min-source-events n] [--strict true|false]',
    '',
  ].join('\n');
}

export function formatRel01aSummary(report: Rel01aReport): string {
  return [
    `REL-01A aggregate controlled live-sim validation: ${report.status}`,
    `manifest=${report.manifest.path}`,
    `sessions=${report.aggregate_counts.passing_rel00_rerun_sessions}/${report.manifest.session_count}`,
    `source_events=${report.aggregate_counts.total_source_events}`,
    `provenance_spot_checks=${report.provenance_spot_checks.passed}/${report.provenance_spot_checks.requested}`,
    `next_blocker=${report.next_blocker}`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const result = await runRel01aAggregateValidator(parseRel01aArgs(processArgv.slice(2)));
    processStdout.write(formatRel01aSummary(result.report));
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`${errorMessage(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(processArgv[1])) {
  void main();
}
