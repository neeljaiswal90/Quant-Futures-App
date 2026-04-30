import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
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
  stableJsonStringify,
  type JsonValue,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import {
  forEachJsonlLine,
  sha256File,
} from '../sim/streaming-jsonl.js';

export const REL_01B_REPORT_SCHEMA_VERSION = 1 as const;
export const REL_01B_MANIFEST_SCHEMA_VERSION = 1 as const;
export const REL_01B_TICKET_ID = 'REL-01B' as const;

const DEFAULT_REPORTS_ROOT = 'reports/rel';
const DEFAULT_MANIFEST = 'reports/rel/rel01_manifest.json';
const DEFAULT_SYMBOL = 'MNQM6';
const DEFAULT_EXCHANGE = 'CME';
const DEFAULT_DURATION_SEC = 2_100;
const DEFAULT_STREAMS = 'LAST_TRADE,L1_QUOTE,MBP10';
const DEFAULT_MIN_SOURCE_EVENTS = 10_000;
const DEFAULT_SIM03_REPORT = 'reports/sim/fill_slippage_calibration_robust_limit_queue_front.json';
const DEFAULT_SIM03_GATE = 'reports/sim/fill_slippage_calibration_robust_limit_queue_front_gate.json';
const DEFAULT_REL00B_REPORT = 'reports/rel/rel00b_evidence_index.json';
const CME_EQUITY_RTH_OPEN_UTC_MINUTE = 13 * 60 + 30;
const CME_EQUITY_RTH_CLOSE_UTC_MINUTE = 20 * 60;
const NO_RAW_DATA_STATEMENT =
  'REL-01B reports command names, paths, SHA-256 hashes, counts, statuses, and safety posture only. It does not embed raw Rithmic probe rows, normalized journal rows, runtime journal payloads, DBN files, credentials, stdout, or stderr.';

type Rel01bStatus =
  | 'session_appended'
  | 'failed'
  | 'duplicate_session'
  | 'requires_manifest_seed';
type Rel01bExitCode = 0 | 2 | 3;
type CommandStatus = 'pass' | 'fail' | 'skipped';

export interface Rel01bManifest {
  readonly schema_version: typeof REL_01B_MANIFEST_SCHEMA_VERSION;
  readonly rel01_run_id: string;
  readonly runtime_commit: string;
  readonly config_hash: string;
  readonly strategy_config_hash: string;
  readonly risk_config_hash: string;
  readonly management_config_hash: string;
  readonly sim03_report: string;
  readonly sim03_gate: string;
  readonly rel00b_report?: string;
  readonly sessions: readonly Rel01bManifestSession[];
}

export interface Rel01bManifestSession {
  readonly session_id: string;
  readonly run_id: string;
  readonly journal: string;
  readonly rel00_report: string;
  readonly rel00c_report: string;
}

export interface Rel01bManifestSeed {
  readonly rel01_run_id: string;
  readonly runtime_commit: string;
  readonly config_hash: string;
  readonly strategy_config_hash: string;
  readonly risk_config_hash: string;
  readonly management_config_hash: string;
  readonly sim03_report?: string;
  readonly sim03_gate?: string;
  readonly rel00b_report?: string;
}

export interface Rel01bOptions {
  readonly cwd?: string;
  readonly trade_date: string;
  readonly manifest?: string;
  readonly reports_root?: string;
  readonly report?: string;
  readonly run_id?: string;
  readonly session_id?: string;
  readonly symbol?: string;
  readonly exchange?: string;
  readonly duration_sec?: number;
  readonly streams?: string;
  readonly raw_probe?: string;
  readonly skip_capture?: boolean;
  readonly min_source_events?: number;
  readonly max_feature_snapshots?: number;
  readonly manifest_seed?: Rel01bManifestSeed;
}

type MutableRel01bOptions = {
  -readonly [K in keyof Rel01bOptions]?: Rel01bOptions[K];
};

type MutableRel01bManifestSeed = {
  -readonly [K in keyof Rel01bManifestSeed]?: Rel01bManifestSeed[K];
};

export interface Rel01bCommand {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface Rel01bCommandResult {
  readonly exit_code: number;
}

export interface Rel01bCommandRunner {
  (command: Rel01bCommand): Promise<Rel01bCommandResult>;
}

export interface Rel01bReport {
  readonly schema_version: typeof REL_01B_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof REL_01B_TICKET_ID;
  readonly status: Rel01bStatus;
  readonly trade_date: string;
  readonly session_id: string;
  readonly run_id: string;
  readonly symbol: string;
  readonly exchange: string;
  readonly run_dir: string;
  readonly manifest: {
    readonly path: string;
    readonly existed_before: boolean;
    readonly sha256_before: string | null;
    readonly sha256_after: string | null;
    readonly session_count_before: number;
    readonly session_count_after: number;
    readonly appended: boolean;
  };
  readonly paths: {
    readonly raw_probe: string;
    readonly data01a_journal: string;
    readonly data01a_report: string;
    readonly data01b_price_state_journal: string;
    readonly data01b_price_state_report: string;
    readonly rel00c_journal: string;
    readonly rel00c_report: string;
    readonly rel00_report: string;
    readonly rel00_report_md: string;
    readonly rel01b_report: string;
  };
  readonly hashes: {
    readonly raw_probe: string | null;
    readonly data01a_journal: string | null;
    readonly data01b_price_state_journal: string | null;
    readonly rel00c_journal: string | null;
  };
  readonly raw_probe_audit: Rel01bRawProbeAudit;
  readonly command_log: readonly Rel01bCommandLog[];
  readonly checks: {
    readonly manifest_seed_available: boolean;
    readonly duplicate_session_absent: boolean;
    readonly capture_output_available: boolean;
    readonly raw_probe_trade_date_matches: boolean;
    readonly data01a_l1_trade_ready: boolean;
    readonly data01b_price_state_ready: boolean;
    readonly rel00c_generated: boolean;
    readonly rel00_passed: boolean;
    readonly manifest_appended: boolean;
  };
  readonly counts: {
    readonly data01a_emitted_events: number | null;
    readonly data01a_emitted_quote_events: number | null;
    readonly data01a_emitted_trade_events: number | null;
    readonly data01b_price_state_emitted_events: number | null;
    readonly rel00c_source_events_consumed: number | null;
    readonly rel00c_feature_snapshots_generated: number | null;
    readonly rel00c_order_intents_emitted: number | null;
    readonly rel00c_sim_fills_emitted: number | null;
    readonly rel00c_exec_rejects_emitted: number | null;
  };
  readonly safety_posture: {
    readonly live_data_source: 'rithmic';
    readonly execution_mode: 'simulated_only';
    readonly real_orders_allowed: false;
    readonly accepted_feature_surface_only: true;
    readonly mbo_derived_features_allowed: false;
    readonly rel01_status: 'collecting';
  };
  readonly manifest_entry: Rel01bManifestSession | null;
  readonly reasons: readonly string[];
  readonly next_action: string;
  readonly no_raw_data_statement: typeof NO_RAW_DATA_STATEMENT;
}

interface Rel01bCommandLog {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly exit_code: number | null;
  readonly status: CommandStatus;
}

export interface Rel01bRawProbeAudit {
  readonly status: 'not_checked' | 'pass' | 'fail';
  readonly expected_trade_date: string;
  readonly expected_session: 'cme_equity_index_rth';
  readonly timestamped_rows_checked: number;
  readonly matching_trade_date_rows: number;
  readonly rth_rows: number;
  readonly trade_date_mismatch_rows: number;
  readonly out_of_rth_rows: number;
  readonly parse_error_count: number;
  readonly failure_reason: string | null;
}

interface Rel01bPaths {
  readonly cwd: string;
  readonly reportsRoot: string;
  readonly runDir: string;
  readonly manifestPath: string;
  readonly reportPath: string;
  readonly rawProbe: string;
  readonly data01aJournal: string;
  readonly data01aReport: string;
  readonly data01bJournal: string;
  readonly data01bReport: string;
  readonly rel00cJournal: string;
  readonly rel00cReport: string;
  readonly rel00Report: string;
  readonly rel00ReportMd: string;
}

interface Rel01bMutableState {
  commandLog: Rel01bCommandLog[];
  checks: {
    manifest_seed_available: boolean;
    duplicate_session_absent: boolean;
    capture_output_available: boolean;
    raw_probe_trade_date_matches: boolean;
    data01a_l1_trade_ready: boolean;
    data01b_price_state_ready: boolean;
    rel00c_generated: boolean;
    rel00_passed: boolean;
    manifest_appended: boolean;
  };
  rawProbeAudit: Rel01bRawProbeAudit;
  reasons: string[];
}

export async function runRel01bDailySessionWrapper(
  options: Rel01bOptions,
  commandRunner: Rel01bCommandRunner = defaultCommandRunner,
): Promise<{ readonly report: Rel01bReport; readonly exit_code: Rel01bExitCode }> {
  const cwd = resolve(options.cwd ?? processCwd());
  const tradeDate = normalizeTradeDate(options.trade_date);
  const runStamp = tradeDate.replace(/-/gu, '');
  const sessionId = options.session_id ?? `${tradeDate}-rth`;
  const runId = options.run_id ?? `rel01-live-sim-${runStamp}`;
  const symbol = options.symbol ?? DEFAULT_SYMBOL;
  const exchange = options.exchange ?? DEFAULT_EXCHANGE;
  const durationSec = options.duration_sec ?? DEFAULT_DURATION_SEC;
  const streams = options.streams ?? DEFAULT_STREAMS;
  const minSourceEvents = options.min_source_events ?? DEFAULT_MIN_SOURCE_EVENTS;
  const paths = buildPaths(cwd, tradeDate, runStamp, options);
  mkdirSync(paths.runDir, { recursive: true });

  const state: Rel01bMutableState = {
    commandLog: [],
    checks: {
      manifest_seed_available: false,
      duplicate_session_absent: false,
      capture_output_available: false,
      raw_probe_trade_date_matches: false,
      data01a_l1_trade_ready: false,
      data01b_price_state_ready: false,
      rel00c_generated: false,
      rel00_passed: false,
      manifest_appended: false,
    },
    rawProbeAudit: emptyRawProbeAudit(tradeDate),
    reasons: [],
  };

  const manifestBefore = loadOrCreateManifest(paths, options.manifest_seed);
  if (manifestBefore.status === 'requires_seed') {
    state.reasons.push('manifest_missing_requires_seed');
    const report = buildReport({
      cwd,
      status: 'requires_manifest_seed',
      tradeDate,
      sessionId,
      runId,
      symbol,
      exchange,
      paths,
      manifestBefore: manifestBefore.manifest,
      manifestAfter: manifestBefore.manifest,
      manifestExistedBefore: false,
      manifestShaBefore: null,
      manifestShaAfter: null,
      state,
      data01a: null,
      data01b: null,
      rel00c: null,
      rel00: null,
      manifestEntry: null,
    });
    writeReport(paths.reportPath, report);
    return { report, exit_code: 2 };
  }

  state.checks.manifest_seed_available = true;
  const duplicate = duplicateManifestReason(manifestBefore.manifest, sessionId, runId);
  if (duplicate !== null) {
    state.reasons.push(duplicate);
    const report = buildReport({
      cwd,
      status: 'duplicate_session',
      tradeDate,
      sessionId,
      runId,
      symbol,
      exchange,
      paths,
      manifestBefore: manifestBefore.manifest,
      manifestAfter: manifestBefore.manifest,
      manifestExistedBefore: manifestBefore.existed,
      manifestShaBefore: manifestBefore.sha256,
      manifestShaAfter: manifestBefore.sha256,
      state,
      data01a: null,
      data01b: null,
      rel00c: null,
      rel00: null,
      manifestEntry: null,
    });
    writeReport(paths.reportPath, report);
    return { report, exit_code: 2 };
  }
  state.checks.duplicate_session_absent = true;

  const commandFailure = await runPipeline({
    cwd,
    paths,
    tradeDate,
    sessionId,
    runId,
    symbol,
    exchange,
    durationSec,
    streams,
    minSourceEvents,
    maxFeatureSnapshots: options.max_feature_snapshots,
    skipCapture: options.skip_capture ?? false,
    state,
    commandRunner,
  });

  const data01a = tryReadJsonObject(paths.data01aReport);
  const data01b = tryReadJsonObject(paths.data01bReport);
  const rel00c = tryReadJsonObject(paths.rel00cReport);
  const rel00 = tryReadJsonObject(paths.rel00Report);

  if (commandFailure !== null) {
    state.reasons.push(commandFailure);
  } else {
    validateOutputs(paths, state, data01a, data01b, rel00c, rel00);
  }

  const manifestEntry = state.reasons.length === 0
    ? {
        session_id: sessionId,
        run_id: runId,
        journal: toReportPath(cwd, paths.rel00cJournal),
        rel00_report: toReportPath(cwd, paths.rel00Report),
        rel00c_report: toReportPath(cwd, paths.rel00cReport),
      }
    : null;
  const manifestAfter = manifestEntry === null
    ? manifestBefore.manifest
    : appendManifestSession(manifestBefore.manifest, manifestEntry);
  let manifestShaAfter = manifestBefore.sha256;
  if (manifestEntry !== null) {
    writeManifest(paths.manifestPath, manifestAfter);
    manifestShaAfter = sha256File(paths.manifestPath);
    state.checks.manifest_appended = true;
  }

  const status: Rel01bStatus = state.reasons.length === 0 ? 'session_appended' : 'failed';
  const report = buildReport({
    cwd,
    status,
    tradeDate,
    sessionId,
    runId,
    symbol,
    exchange,
    paths,
    manifestBefore: manifestBefore.manifest,
    manifestAfter,
    manifestExistedBefore: manifestBefore.existed,
    manifestShaBefore: manifestBefore.sha256,
    manifestShaAfter,
    state,
    data01a,
    data01b,
    rel00c,
    rel00,
    manifestEntry,
  });
  writeReport(paths.reportPath, report);
  return { report, exit_code: status === 'session_appended' ? 0 : 2 };
}

async function runPipeline(input: {
  readonly cwd: string;
  readonly paths: Rel01bPaths;
  readonly tradeDate: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly symbol: string;
  readonly exchange: string;
  readonly durationSec: number;
  readonly streams: string;
  readonly minSourceEvents: number;
  readonly maxFeatureSnapshots: number | undefined;
  readonly skipCapture: boolean;
  readonly state: Rel01bMutableState;
  readonly commandRunner: Rel01bCommandRunner;
}): Promise<string | null> {
  if (input.skipCapture) {
    input.state.commandLog.push({
      name: 'capture_rithmic_probe',
      command: 'python',
      args: ['scripts/infra/capture-rithmic-probe.py', '--out', toReportPath(input.cwd, input.paths.rawProbe)],
      exit_code: null,
      status: 'skipped',
    });
  } else {
    const captureExit = await runCommand(input, {
      name: 'capture_rithmic_probe',
      command: pythonCommand(),
      args: [
        'scripts/infra/capture-rithmic-probe.py',
        '--symbol',
        input.symbol,
        '--exchange',
        input.exchange,
        '--duration-sec',
        String(input.durationSec),
        '--streams',
        input.streams,
        '--parity-payload',
        '--out',
        input.paths.rawProbe,
      ],
    });
    if (captureExit !== 0) return 'capture_rithmic_probe_failed';
  }

  input.state.checks.capture_output_available = fileExistsNonEmpty(input.paths.rawProbe);
  if (!input.state.checks.capture_output_available) return 'capture_output_missing_or_empty';

  input.state.rawProbeAudit = auditRawProbeTradeDate(input.paths.rawProbe, input.tradeDate);
  input.state.checks.raw_probe_trade_date_matches = input.state.rawProbeAudit.status === 'pass';
  if (!input.state.checks.raw_probe_trade_date_matches) {
    return `raw_probe_trade_date_mismatch:${input.state.rawProbeAudit.failure_reason ?? 'unknown'}`;
  }

  const data01aExit = await runCommand(input, {
    name: 'normalize_data01a_l1_trade',
    command: npmCommand(),
    args: [
      'run',
      'data:01a:l1-trade',
      '--',
      '--input',
      input.paths.rawProbe,
      '--out',
      input.paths.data01aJournal,
      '--report',
      input.paths.data01aReport,
      '--run-id',
      input.runId,
      '--session-id',
      input.sessionId,
    ],
  });
  if (data01aExit !== 0) return 'normalize_data01a_l1_trade_failed';

  const data01bExit = await runCommand(input, {
    name: 'normalize_data01b_ps_price_state',
    command: npmCommand(),
    args: [
      'run',
      'data:01b:price-state',
      '--',
      '--input',
      input.paths.rawProbe,
      '--out',
      input.paths.data01bJournal,
      '--report',
      input.paths.data01bReport,
      '--run-id',
      input.runId,
      '--session-id',
      input.sessionId,
    ],
  });
  if (data01bExit !== 0) return 'normalize_data01b_ps_price_state_failed';

  const rel00cArgs = [
    'run',
    'rel:00c:run-controlled-live-sim',
    '--',
    '--l1-trade-journal',
    input.paths.data01aJournal,
    '--mbp10-price-state-journal',
    input.paths.data01bJournal,
    '--out-journal',
    input.paths.rel00cJournal,
    '--report',
    input.paths.rel00cReport,
    '--run-id',
    input.runId,
    '--session-id',
    input.sessionId,
  ];
  if (input.maxFeatureSnapshots !== undefined) {
    rel00cArgs.push('--max-feature-snapshots', String(input.maxFeatureSnapshots));
  }
  const rel00cExit = await runCommand(input, {
    name: 'generate_rel00c_runtime_journal',
    command: npmCommand(),
    args: rel00cArgs,
  });
  if (rel00cExit !== 0) return 'generate_rel00c_runtime_journal_failed';

  const rel00Exit = await runCommand(input, {
    name: 'validate_rel00_controlled_live_sim',
    command: npmCommand(),
    args: [
      'run',
      'rel:00:controlled-live-sim',
      '--',
      '--journal',
      input.paths.rel00cJournal,
      '--out',
      input.paths.rel00Report,
      '--out-md',
      input.paths.rel00ReportMd,
      '--min-source-events',
      String(input.minSourceEvents),
    ],
  });
  if (rel00Exit !== 0) return 'validate_rel00_controlled_live_sim_failed';

  return null;
}

async function runCommand(
  input: {
    readonly cwd: string;
    readonly state: Rel01bMutableState;
    readonly commandRunner: Rel01bCommandRunner;
  },
  command: Omit<Rel01bCommand, 'cwd'>,
): Promise<number> {
  const fullCommand: Rel01bCommand = { ...command, cwd: input.cwd };
  const result = await input.commandRunner(fullCommand);
  input.state.commandLog.push({
    name: command.name,
    command: displayCommand(command.command),
    args: redactArgs(command.args, input.cwd),
    exit_code: result.exit_code,
    status: result.exit_code === 0 ? 'pass' : 'fail',
  });
  return result.exit_code;
}

function validateOutputs(
  paths: Rel01bPaths,
  state: Rel01bMutableState,
  data01a: Record<string, unknown> | null,
  data01b: Record<string, unknown> | null,
  rel00c: Record<string, unknown> | null,
  rel00: Record<string, unknown> | null,
): void {
  state.checks.data01a_l1_trade_ready = data01a !== null
    && positiveNumber(data01a.emitted_events)
    && positiveNumber(data01a.emitted_quote_events)
    && positiveNumber(data01a.emitted_trade_events)
    && fileExistsNonEmpty(paths.data01aJournal);
  if (!state.checks.data01a_l1_trade_ready) {
    state.reasons.push('data01a_l1_trade_not_ready');
  }

  state.checks.data01b_price_state_ready = data01b !== null
    && positiveNumber(data01b.emitted_events)
    && stringField(data01b.mbp10_price_state_status) === 'accepted_subscope'
    && fileExistsNonEmpty(paths.data01bJournal);
  if (!state.checks.data01b_price_state_ready) {
    state.reasons.push('data01b_price_state_not_ready');
  }

  state.checks.rel00c_generated = rel00c !== null
    && stringField(rel00c.status) === 'generated'
    && numberField(rel00c.real_order_event_types_emitted) === 0
    && emptyArray(rel00c.blocked_feature_fields_used)
    && emptyArray(rel00c.restricted_feature_fields_used)
    && fileExistsNonEmpty(paths.rel00cJournal);
  if (!state.checks.rel00c_generated) {
    state.reasons.push('rel00c_not_generated_safely');
  }

  state.checks.rel00_passed = rel00 !== null && stringField(rel00.status) === 'pass';
  if (!state.checks.rel00_passed) {
    state.reasons.push('rel00_controlled_live_sim_not_passed');
  }
}

function buildReport(input: {
  readonly cwd: string;
  readonly status: Rel01bStatus;
  readonly tradeDate: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly symbol: string;
  readonly exchange: string;
  readonly paths: Rel01bPaths;
  readonly manifestBefore: Rel01bManifest;
  readonly manifestAfter: Rel01bManifest;
  readonly manifestExistedBefore: boolean;
  readonly manifestShaBefore: string | null;
  readonly manifestShaAfter: string | null;
  readonly state: Rel01bMutableState;
  readonly data01a: Record<string, unknown> | null;
  readonly data01b: Record<string, unknown> | null;
  readonly rel00c: Record<string, unknown> | null;
  readonly rel00: Record<string, unknown> | null;
  readonly manifestEntry: Rel01bManifestSession | null;
}): Rel01bReport {
  return {
    schema_version: REL_01B_REPORT_SCHEMA_VERSION,
    ticket_id: REL_01B_TICKET_ID,
    status: input.status,
    trade_date: input.tradeDate,
    session_id: input.sessionId,
    run_id: input.runId,
    symbol: input.symbol,
    exchange: input.exchange,
    run_dir: toReportPath(input.cwd, input.paths.runDir),
    manifest: {
      path: toReportPath(input.cwd, input.paths.manifestPath),
      existed_before: input.manifestExistedBefore,
      sha256_before: input.manifestShaBefore,
      sha256_after: input.manifestShaAfter,
      session_count_before: input.manifestBefore.sessions.length,
      session_count_after: input.manifestAfter.sessions.length,
      appended: input.state.checks.manifest_appended,
    },
    paths: {
      raw_probe: toReportPath(input.cwd, input.paths.rawProbe),
      data01a_journal: toReportPath(input.cwd, input.paths.data01aJournal),
      data01a_report: toReportPath(input.cwd, input.paths.data01aReport),
      data01b_price_state_journal: toReportPath(input.cwd, input.paths.data01bJournal),
      data01b_price_state_report: toReportPath(input.cwd, input.paths.data01bReport),
      rel00c_journal: toReportPath(input.cwd, input.paths.rel00cJournal),
      rel00c_report: toReportPath(input.cwd, input.paths.rel00cReport),
      rel00_report: toReportPath(input.cwd, input.paths.rel00Report),
      rel00_report_md: toReportPath(input.cwd, input.paths.rel00ReportMd),
      rel01b_report: toReportPath(input.cwd, input.paths.reportPath),
    },
    hashes: {
      raw_probe: hashIfExists(input.paths.rawProbe),
      data01a_journal: hashIfExists(input.paths.data01aJournal),
      data01b_price_state_journal: hashIfExists(input.paths.data01bJournal),
      rel00c_journal: hashIfExists(input.paths.rel00cJournal),
    },
    raw_probe_audit: input.state.rawProbeAudit,
    command_log: input.state.commandLog,
    checks: input.state.checks,
    counts: {
      data01a_emitted_events: numberField(input.data01a?.emitted_events),
      data01a_emitted_quote_events: numberField(input.data01a?.emitted_quote_events),
      data01a_emitted_trade_events: numberField(input.data01a?.emitted_trade_events),
      data01b_price_state_emitted_events: numberField(input.data01b?.emitted_events),
      rel00c_source_events_consumed: numberField(input.rel00c?.source_events_consumed),
      rel00c_feature_snapshots_generated: numberField(input.rel00c?.feature_snapshots_generated),
      rel00c_order_intents_emitted: numberField(input.rel00c?.order_intents_emitted),
      rel00c_sim_fills_emitted: numberField(input.rel00c?.sim_fills_emitted),
      rel00c_exec_rejects_emitted: numberField(input.rel00c?.exec_rejects_emitted),
    },
    safety_posture: {
      live_data_source: 'rithmic',
      execution_mode: 'simulated_only',
      real_orders_allowed: false,
      accepted_feature_surface_only: true,
      mbo_derived_features_allowed: false,
      rel01_status: 'collecting',
    },
    manifest_entry: input.manifestEntry,
    reasons: input.state.reasons,
    next_action: nextAction(input.status),
    no_raw_data_statement: NO_RAW_DATA_STATEMENT,
  };
}

function nextAction(status: Rel01bStatus): string {
  switch (status) {
    case 'session_appended':
      return 'Run REL-01A aggregate validation, then continue with the next distinct RTH session until 10 sessions pass.';
    case 'duplicate_session':
      return 'Use a new distinct RTH trading date or intentionally edit the manifest outside REL-01B after operator review.';
    case 'requires_manifest_seed':
      return 'Create reports/rel/rel01_manifest.json or rerun REL-01B with manifest seed hashes.';
    case 'failed':
      return 'Do not append this session. Resolve the failed command/check, then rerun on the same evidence or discard the session.';
    default:
      return assertNeverStatus(status);
  }
}

function loadOrCreateManifest(
  paths: Rel01bPaths,
  seed: Rel01bManifestSeed | undefined,
): {
  readonly status: 'loaded' | 'created' | 'requires_seed';
  readonly existed: boolean;
  readonly sha256: string | null;
  readonly manifest: Rel01bManifest;
} {
  if (existsSync(paths.manifestPath)) {
    return {
      status: 'loaded',
      existed: true,
      sha256: sha256File(paths.manifestPath),
      manifest: readManifest(paths.manifestPath),
    };
  }
  if (seed === undefined) {
    return {
      status: 'requires_seed',
      existed: false,
      sha256: null,
      manifest: emptyManifest(),
    };
  }
  return {
    status: 'created',
    existed: false,
    sha256: null,
    manifest: {
      schema_version: REL_01B_MANIFEST_SCHEMA_VERSION,
      rel01_run_id: seed.rel01_run_id,
      runtime_commit: seed.runtime_commit,
      config_hash: seed.config_hash,
      strategy_config_hash: seed.strategy_config_hash,
      risk_config_hash: seed.risk_config_hash,
      management_config_hash: seed.management_config_hash,
      sim03_report: seed.sim03_report ?? DEFAULT_SIM03_REPORT,
      sim03_gate: seed.sim03_gate ?? DEFAULT_SIM03_GATE,
      rel00b_report: seed.rel00b_report ?? DEFAULT_REL00B_REPORT,
      sessions: [],
    },
  };
}

function readManifest(path: string): Rel01bManifest {
  const parsed = readJson(path) as Partial<Rel01bManifest>;
  if (parsed.schema_version !== REL_01B_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`REL-01 manifest schema_version must be ${REL_01B_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(parsed.sessions)) {
    throw new Error('REL-01 manifest sessions must be an array');
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
    if (typeof parsed[field] !== 'string' || parsed[field] === '') {
      throw new Error(`REL-01 manifest missing string field ${field}`);
    }
  }
  return parsed as Rel01bManifest;
}

function emptyManifest(): Rel01bManifest {
  return {
    schema_version: REL_01B_MANIFEST_SCHEMA_VERSION,
    rel01_run_id: '',
    runtime_commit: '',
    config_hash: '',
    strategy_config_hash: '',
    risk_config_hash: '',
    management_config_hash: '',
    sim03_report: DEFAULT_SIM03_REPORT,
    sim03_gate: DEFAULT_SIM03_GATE,
    rel00b_report: DEFAULT_REL00B_REPORT,
    sessions: [],
  };
}

function duplicateManifestReason(manifest: Rel01bManifest, sessionId: string, runId: string): string | null {
  if (manifest.sessions.some((session) => session.session_id === sessionId)) {
    return `duplicate_session_id:${sessionId}`;
  }
  if (manifest.sessions.some((session) => session.run_id === runId)) {
    return `duplicate_run_id:${runId}`;
  }
  return null;
}

function appendManifestSession(manifest: Rel01bManifest, session: Rel01bManifestSession): Rel01bManifest {
  return {
    ...manifest,
    sessions: [...manifest.sessions, session],
  };
}

function writeManifest(path: string, manifest: Rel01bManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  try {
    writeFileSync(tmpPath, `${stableJsonStringify(manifest as unknown as JsonValue)}\n`, 'utf8');
    renameSync(tmpPath, path);
  } catch (error) {
    cleanupTmpFile(tmpPath);
    throw error;
  }
}

function writeReport(path: string, report: Rel01bReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
}

function buildPaths(cwd: string, tradeDate: string, runStamp: string, options: Rel01bOptions): Rel01bPaths {
  const reportsRoot = resolve(cwd, options.reports_root ?? DEFAULT_REPORTS_ROOT);
  const runDir = resolve(reportsRoot, `rel01_${runStamp}`);
  return {
    cwd,
    reportsRoot,
    runDir,
    manifestPath: resolve(cwd, options.manifest ?? DEFAULT_MANIFEST),
    reportPath: resolve(cwd, options.report ?? `${toSystemPath(runDir)}/rel01b_daily_session_report.json`),
    rawProbe: resolve(cwd, options.raw_probe ?? `${toSystemPath(runDir)}/rithmic_probe.jsonl`),
    data01aJournal: resolve(runDir, 'data01a_l1_trade.obs01.jsonl'),
    data01aReport: resolve(runDir, 'data01a_l1_trade_report.json'),
    data01bJournal: resolve(runDir, 'data01b_ps_mbp10_price_state.obs01.jsonl'),
    data01bReport: resolve(runDir, 'data01b_ps_mbp10_price_state_report.json'),
    rel00cJournal: resolve(runDir, 'rel00_controlled_live_sim_journal.jsonl'),
    rel00cReport: resolve(runDir, 'rel00c_controlled_live_sim_generation_report.json'),
    rel00Report: resolve(runDir, 'rel00_controlled_live_sim_report.json'),
    rel00ReportMd: resolve(runDir, 'rel00_controlled_live_sim_report.md'),
  };
}

function toSystemPath(path: string): string {
  return path;
}

export function defaultCommandRunner(command: Rel01bCommand): Promise<Rel01bCommandResult> {
  const result = isWindowsCmd(command.command)
    ? spawnSync(windowsShellCommandLine(command.command, command.args), {
        cwd: command.cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        shell: true,
      })
    : spawnSync(command.command, [...command.args], {
        cwd: command.cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
  if (result.error !== undefined) {
    return Promise.resolve({ exit_code: 1 });
  }
  return Promise.resolve({ exit_code: result.status ?? 1 });
}

function pythonCommand(): string {
  return 'python';
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function isWindowsCmd(command: string): boolean {
  return process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
}

function windowsShellCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(windowsShellQuote).join(' ');
}

function windowsShellQuote(value: string): string {
  if (value !== '' && !/[\s"&|<>^]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/(["&|<>^])/gu, '^$1')}"`;
}

function displayCommand(command: string): string {
  return command.endsWith('.cmd') ? command.slice(0, -4) : command;
}

export function redactArgs(args: readonly string[], cwd: string): readonly string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      redacted.push('<redacted>');
      redactNext = false;
      continue;
    }
    if (arg === '--password' || arg === '--token' || arg === '--api-key') {
      redacted.push(arg);
      redactNext = true;
      continue;
    }
    if (/^(--password|--token|--api-key)=/u.test(arg)) {
      redacted.push(arg.replace(/=.*/u, '=<redacted>'));
      continue;
    }
    redacted.push(toPortableArg(arg, cwd));
  }
  return redacted;
}

function cleanupTmpFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Preserve the original manifest-write failure; stale tmp cleanup is best-effort.
  }
}

function toPortableArg(arg: string, cwd: string): string {
  const normalized = arg.replace(/\\/gu, '/');
  const maybePath = resolve(cwd, arg);
  if (existsSync(maybePath)) {
    return toReportPath(cwd, maybePath);
  }
  const cwdPrefix = cwd.replace(/\\/gu, '/');
  return normalized.startsWith(cwdPrefix) ? normalized.slice(cwdPrefix.length + 1) : normalized;
}

function fileExistsNonEmpty(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

function hashIfExists(path: string): string | null {
  return existsSync(path) ? sha256File(path) : null;
}

function emptyRawProbeAudit(tradeDate: string): Rel01bRawProbeAudit {
  return {
    status: 'not_checked',
    expected_trade_date: tradeDate,
    expected_session: 'cme_equity_index_rth',
    timestamped_rows_checked: 0,
    matching_trade_date_rows: 0,
    rth_rows: 0,
    trade_date_mismatch_rows: 0,
    out_of_rth_rows: 0,
    parse_error_count: 0,
    failure_reason: null,
  };
}

function auditRawProbeTradeDate(path: string, tradeDate: string): Rel01bRawProbeAudit {
  const counts = {
    timestampedRowsChecked: 0,
    matchingTradeDateRows: 0,
    rthRows: 0,
    tradeDateMismatchRows: 0,
    outOfRthRows: 0,
    parseErrorCount: 0,
  };

  forEachJsonlLine(path, (line) => {
    if (line.trim() === '') return;
    const parsed = parseJsonRecord(line);
    if (parsed === null) {
      counts.parseErrorCount += 1;
      return;
    }
    const eventTsNs = parseIntegerNs(parsed.exchange_event_ts_ns ?? parsed.ts_event_ns ?? parsed.ts_event);
    if (eventTsNs === null) return;
    counts.timestampedRowsChecked += 1;
    const parts = utcDatePartsFromUnixNs(eventTsNs);
    const rowTradeDate = formatUtcDate(parts.year, parts.month, parts.day);
    if (rowTradeDate === tradeDate) {
      counts.matchingTradeDateRows += 1;
    } else {
      counts.tradeDateMismatchRows += 1;
    }
    if (
      parts.minuteOfDay >= CME_EQUITY_RTH_OPEN_UTC_MINUTE
      && parts.minuteOfDay < CME_EQUITY_RTH_CLOSE_UTC_MINUTE
    ) {
      counts.rthRows += 1;
    } else {
      counts.outOfRthRows += 1;
    }
  });

  const failureReason =
    counts.parseErrorCount > 0
      ? 'raw_probe_malformed_jsonl'
      : counts.timestampedRowsChecked === 0
        ? 'raw_probe_missing_exchange_timestamps'
        : counts.tradeDateMismatchRows > 0
          ? 'raw_probe_trade_date_mismatch'
          : counts.outOfRthRows > 0
            ? 'raw_probe_contains_non_rth_timestamps'
            : null;

  return {
    status: failureReason === null ? 'pass' : 'fail',
    expected_trade_date: tradeDate,
    expected_session: 'cme_equity_index_rth',
    timestamped_rows_checked: counts.timestampedRowsChecked,
    matching_trade_date_rows: counts.matchingTradeDateRows,
    rth_rows: counts.rthRows,
    trade_date_mismatch_rows: counts.tradeDateMismatchRows,
    out_of_rth_rows: counts.outOfRthRows,
    parse_error_count: counts.parseErrorCount,
    failure_reason: failureReason,
  };
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseIntegerNs(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    return BigInt(value);
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

function utcDatePartsFromUnixNs(value: bigint): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly minuteOfDay: number;
} {
  const seconds = Number(value / 1_000_000_000n);
  const days = Math.floor(seconds / 86_400);
  const secondOfDay = seconds - (days * 86_400);
  const date = civilFromDays(days);
  return {
    ...date,
    minuteOfDay: Math.floor(secondOfDay / 60),
  };
}

function civilFromDays(daysSinceEpoch: number): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const z = daysSinceEpoch + 719_468;
  const era = Math.floor((z >= 0 ? z : z - 146_096) / 146_097);
  const dayOfEra = z - (era * 146_097);
  const yearOfEra = Math.floor(
    (
      dayOfEra
      - Math.floor(dayOfEra / 1_460)
      + Math.floor(dayOfEra / 36_524)
      - Math.floor(dayOfEra / 146_096)
    ) / 365,
  );
  let year = yearOfEra + (era * 400);
  const dayOfYear = dayOfEra - ((365 * yearOfEra) + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor(((5 * dayOfYear) + 2) / 153);
  const day = dayOfYear - Math.floor(((153 * monthPrime) + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

function formatUtcDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

function tryReadJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const value = readJson(path);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function positiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function normalizeTradeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error('--trade-date must use YYYY-MM-DD');
  }
  return value;
}

function toReportPath(cwd: string, path: string): string {
  const rel = relative(cwd, path).replace(/\\/gu, '/');
  return rel.startsWith('..') ? path.replace(/\\/gu, '/') : rel;
}

function parseRel01bArgs(args: readonly string[]): Rel01bOptions {
  const options: MutableRel01bOptions = {};
  const seed: MutableRel01bManifestSeed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    switch (arg) {
      case '--trade-date':
        index += 1;
        options.trade_date = requireArgValue(arg, args[index]);
        break;
      case '--manifest':
        index += 1;
        options.manifest = requireArgValue(arg, args[index]);
        break;
      case '--reports-root':
        index += 1;
        options.reports_root = requireArgValue(arg, args[index]);
        break;
      case '--report':
        index += 1;
        options.report = requireArgValue(arg, args[index]);
        break;
      case '--run-id':
        index += 1;
        options.run_id = requireArgValue(arg, args[index]);
        break;
      case '--session-id':
        index += 1;
        options.session_id = requireArgValue(arg, args[index]);
        break;
      case '--symbol':
        index += 1;
        options.symbol = requireArgValue(arg, args[index]);
        break;
      case '--exchange':
        index += 1;
        options.exchange = requireArgValue(arg, args[index]);
        break;
      case '--duration-sec':
        index += 1;
        options.duration_sec = parsePositiveInteger(arg, requireArgValue(arg, args[index]));
        break;
      case '--streams':
        index += 1;
        options.streams = requireArgValue(arg, args[index]);
        break;
      case '--raw-probe':
        index += 1;
        options.raw_probe = requireArgValue(arg, args[index]);
        break;
      case '--skip-capture':
        options.skip_capture = true;
        break;
      case '--min-source-events':
        index += 1;
        options.min_source_events = parsePositiveInteger(arg, requireArgValue(arg, args[index]));
        break;
      case '--max-feature-snapshots':
        index += 1;
        options.max_feature_snapshots = parsePositiveInteger(arg, requireArgValue(arg, args[index]));
        break;
      case '--rel01-run-id':
        index += 1;
        seed.rel01_run_id = requireArgValue(arg, args[index]);
        break;
      case '--runtime-commit':
        index += 1;
        seed.runtime_commit = requireArgValue(arg, args[index]);
        break;
      case '--config-hash':
        index += 1;
        seed.config_hash = requireArgValue(arg, args[index]);
        break;
      case '--strategy-config-hash':
        index += 1;
        seed.strategy_config_hash = requireArgValue(arg, args[index]);
        break;
      case '--risk-config-hash':
        index += 1;
        seed.risk_config_hash = requireArgValue(arg, args[index]);
        break;
      case '--management-config-hash':
        index += 1;
        seed.management_config_hash = requireArgValue(arg, args[index]);
        break;
      case '--sim03-report':
        index += 1;
        seed.sim03_report = requireArgValue(arg, args[index]);
        break;
      case '--sim03-gate':
        index += 1;
        seed.sim03_gate = requireArgValue(arg, args[index]);
        break;
      case '--rel00b-report':
        index += 1;
        seed.rel00b_report = requireArgValue(arg, args[index]);
        break;
      case '--help':
        processStdout.write(usage());
        processExit(0);
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  if (options.trade_date === undefined) {
    throw new Error('missing required --trade-date');
  }
  if (hasAnySeedField(seed)) {
    for (const field of [
      'rel01_run_id',
      'runtime_commit',
      'config_hash',
      'strategy_config_hash',
      'risk_config_hash',
      'management_config_hash',
    ] as const) {
      if (typeof seed[field] !== 'string' || seed[field] === '') {
        throw new Error(`manifest seed missing --${field.replace(/_/gu, '-')}`);
      }
    }
    options.manifest_seed = seed as Rel01bManifestSeed;
  }
  return options as Rel01bOptions;
}

function hasAnySeedField(seed: MutableRel01bManifestSeed): boolean {
  return Object.values(seed).some((value) => value !== undefined);
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function usage(): string {
  return [
    'Usage: npm run rel:01b:daily-session -- --trade-date YYYY-MM-DD [options]',
    '',
    'Runs the daily REL-01 controlled live-sim session chain: capture, DATA-01A, DATA-01B-PS, REL-00C, REL-00, manifest append.',
    'The manifest must already exist, or provide the manifest seed fields: --rel01-run-id, --runtime-commit, --config-hash, --strategy-config-hash, --risk-config-hash, --management-config-hash.',
    '',
  ].join('\n');
}

export function formatRel01bSummary(report: Rel01bReport): string {
  return [
    `REL-01B daily controlled live-sim session: ${report.status}`,
    `session=${report.session_id}`,
    `run=${report.run_id}`,
    `run_dir=${report.run_dir}`,
    `report=${report.paths.rel01b_report}`,
    `manifest_appended=${report.manifest.appended}`,
    `next_action=${report.next_action}`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const result = await runRel01bDailySessionWrapper(parseRel01bArgs(processArgv.slice(2)));
    processStdout.write(formatRel01bSummary(result.report));
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`${errorMessage(error)}\n`);
    processExit(3);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNeverStatus(status: never): never {
  throw new Error(`Unhandled REL-01B status: ${String(status)}`);
}

const isDirectCli = processArgv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(processArgv[1]);
if (isDirectCli) {
  void main();
}
