import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getMnqSessionPhase, loadMnqSessionCalendarConfig } from '../../apps/strategy_runtime/src/session/mnq-session-calendar.js';
import { ns, type UnixNs } from '../../apps/strategy_runtime/src/contracts/index.js';

const PROFILE_TICKET = 'QFA-612-SHADOW-MODE-LIVE-CAPTURE-PROFILE-01';
const REGIME_TICKET = 'QFA-612-SHADOW-MODE-REGIME-LABEL-SOURCE-01';
const ROLLUP_TICKET = 'QFA-612-SHADOW-MODE-PERFORMANCE-ROLLUP-01';
const START_HELPER = 'scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts';
const PROFILE_CONFIG_PATH = 'config/paper/qfa-612-shadow-mode-live-capture.yaml';
const SHADOW_STRATEGY_ID = 'opening_range_box_breakout_long' as const;
const REGIME_SOURCE_PATH = 'config/paper/qfa-612-shadow-regime-label-source.json';
const PRIMARY_ENV_PATH = 'D:/Quant-futures-app/.env';
const REPO_ROOT = process.cwd();
const JOURNAL_PATH = path.join(REPO_ROOT, 'journals', 'paper', 'qfa-612-rth-2026-06-15-paper-trading', 'session-qfa-612-paper-trading-start-rth-2026-06-15.jsonl');
const START_REPORT_PATH = path.join(REPO_ROOT, 'artifacts', 'broker', 'qfa-612-paper-trading-start-rth-2026-06-15-impl-01', 'paper-trading-start-rth-2026-06-15-report.json');
const PROFILE_ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'broker', 'qfa-612-shadow-mode-live-capture-profile-01');
const REGIME_ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'broker', 'qfa-612-shadow-mode-regime-label-source-01');
const ROLLUP_ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'broker', 'qfa-612-shadow-mode-performance-rollup-01');
const BACKLOG_PATH = path.join(REPO_ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Mode = 'preflight_only' | 'start' | 'rollup_only';

interface CliOptions {
  readonly mode: Mode;
  readonly duration_ms?: number;
  readonly until_rth_close: boolean;
  readonly allow_preopen: boolean;
}

interface RegimeSourceFile {
  readonly schema_version: number;
  readonly labels: readonly RegimeLabelRecord[];
}

interface RegimeLabelRecord {
  readonly session_id: string;
  readonly label: string;
  readonly target_prior_close_date: string;
  readonly source_name: string;
  readonly source_urls: readonly string[];
  readonly source_authority_type: string;
  readonly primary_percentile_diagnostic_only?: number;
  readonly VIXCLS?: number;
  readonly VXNCLS?: number;
  readonly global_regime_labels_mutated: boolean;
  readonly notes?: readonly string[];
}

interface EventRecord {
  readonly type?: string;
  readonly ts_ns?: string;
  readonly payload?: Record<string, unknown>;
}

function parseCli(argv: readonly string[]): CliOptions {
  let mode: Mode = 'preflight_only';
  let durationMs: number | undefined;
  let untilRthClose = false;
  let allowPreopen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--preflight-only') mode = 'preflight_only';
    else if (arg === '--start') mode = 'start';
    else if (arg === '--rollup-only') mode = 'rollup_only';
    else if (arg === '--duration-ms') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--duration-ms requires a value');
      durationMs = Number(value);
      index += 1;
    } else if (arg === '--until-rth-close') {
      untilRthClose = true;
    } else if (arg === '--allow-preopen') {
      allowPreopen = true;
    } else if (arg === '--help') {
      process.stdout.write(helpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (durationMs !== undefined && (!Number.isInteger(durationMs) || durationMs <= 0)) throw new Error('--duration-ms must be a positive integer');
  if (mode === 'start' && durationMs === undefined && !untilRthClose) throw new Error('--start requires --duration-ms or --until-rth-close');
  if (durationMs !== undefined && untilRthClose) throw new Error('--duration-ms and --until-rth-close are mutually exclusive');
  return { mode, duration_ms: durationMs, until_rth_close: untilRthClose, allow_preopen: allowPreopen };
}

function helpText(): string {
  return `Usage: npx tsx scripts/paper/run-qfa-612-shadow-mode-live-capture.ts [--preflight-only|--start|--rollup-only] [--duration-ms MS|--until-rth-close] [--allow-preopen]\n\n` +
    `Shadow mode composes the existing QFA-612 guarded paper-start helper with source-backed regime-label resolution and a rollup that requires ORDER_INTENT=0. It uses RITHMIC_TEST_* order-placement credentials and preserves paper_observation_stop_after_candidate=true.\n`;
}

function nowNs(): UnixNs {
  return ns(BigInt(Date.now()) * 1_000_000n);
}

function currentSession(): { readonly session_id: string; readonly trading_date: string; readonly phase: string; readonly is_rth: boolean; readonly rth_close_duration_ms: number } {
  const phase = getMnqSessionPhase(loadMnqSessionCalendarConfig(), nowNs());
  const closeMs = Date.parse(`${phase.trading_date}T20:00:00.000Z`);
  return {
    session_id: `${phase.trading_date}-rth`,
    trading_date: phase.trading_date,
    phase: phase.phase,
    is_rth: phase.is_rth,
    rth_close_duration_ms: Math.max(0, closeMs - Date.now()),
  };
}

function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function resolveRegimeLabel(sessionId: string): RegimeLabelRecord {
  const configuredPath = process.env.QFA_SHADOW_REGIME_LABEL_SOURCE_PATH ?? REGIME_SOURCE_PATH;
  if (existsSync(configuredPath)) {
    const parsed = JSON.parse(readFileSync(configuredPath, 'utf8')) as RegimeSourceFile;
    const match = parsed.labels.find((entry) => entry.session_id === sessionId);
    if (match !== undefined) {
      if (!['high', 'mid', 'low', 'transition_pending', 'unknown'].includes(match.label)) throw new Error(`invalid regime label in ${configuredPath}: ${match.label}`);
      return match;
    }
  }
  const override = process.env.QFA_PAPER_CAPTURE_REGIME_LABEL?.trim().toLowerCase();
  const allowOverride = process.env.QFA_SHADOW_ALLOW_OPERATOR_REGIME_OVERRIDE?.trim().toLowerCase() === 'true';
  if (override !== undefined && override !== '' && allowOverride) {
    return {
      session_id: sessionId,
      label: override,
      target_prior_close_date: 'operator_override',
      source_name: 'operator_runtime_override',
      source_urls: [],
      source_authority_type: 'operator_override_explicitly_allowed',
      global_regime_labels_mutated: false,
      notes: ['Override requires QFA_SHADOW_ALLOW_OPERATOR_REGIME_OVERRIDE=true and should not be used for source-faithful performance accounting.'],
    };
  }
  if ((process.env.QFA_PAPER_SHADOW_STRATEGY_ID ?? SHADOW_STRATEGY_ID) === SHADOW_STRATEGY_ID) {
    return {
      session_id: sessionId,
      label: 'unknown',
      target_prior_close_date: 'not_required_for_orb_shadow_profile',
      source_name: 'strategy_does_not_consume_regime_label',
      source_urls: [],
      source_authority_type: 'SHADOW_MODE_REGIME_LABEL_SOURCE_NOT_REQUIRED_FOR_ORB_PROFILE',
      global_regime_labels_mutated: false,
      notes: ['Opening-range breakout long prior-down shadow profile does not consume context.regime_label; label is carried as unknown without mutating global regime labels.'],
    };
  }
  throw new Error(`missing source-backed shadow regime label for ${sessionId}; add ${configuredPath} entry or explicitly allow operator override`);
}

function runStartHelper(options: CliOptions, regime: RegimeLabelRecord, session: ReturnType<typeof currentSession>): { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly duration_ms: number | null } {
  if (options.mode === 'rollup_only') return { status: 0, stdout: '', stderr: '', duration_ms: null };
  const durationMs = options.mode === 'start'
    ? options.until_rth_close ? session.rth_close_duration_ms : options.duration_ms ?? null
    : null;
  if (options.mode === 'start' && (durationMs === null || durationMs <= 0)) throw new Error('computed shadow start duration is not positive');
  const env = {
    ...loadEnvFile(PRIMARY_ENV_PATH),
    ...process.env,
    QFA_PAPER_SESSION_CONFIG: PROFILE_CONFIG_PATH,
    QFA_PAPER_SHADOW_STRATEGY_ID: SHADOW_STRATEGY_ID,
    QFA_PAPER_CAPTURE_REGIME_LABEL: regime.label,
    QFA_PAPER_OBSERVATION_STOP_AFTER_CANDIDATE: 'true',
    QFA_PAPER_LIVE_CAPTURE_FEATURE_BRIDGE_ENABLED: 'true',
  };
  const args = ['tsx', START_HELPER, options.mode === 'start' ? '--start' : '--preflight-only'];
  if (options.allow_preopen) args.push('--allow-preopen');
  if (durationMs !== null) args.push('--duration-ms', String(durationMs));
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', ['npx.cmd', ...args].map(quoteCmdArg).join(' ')]
    : args;
  const result = spawnSync(command, commandArgs, { cwd: REPO_ROOT, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
    duration_ms: durationMs,
  };
}

function readEvents(): readonly EventRecord[] {
  if (!existsSync(JOURNAL_PATH)) return [];
  return readFileSync(JOURNAL_PATH, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as EventRecord);
}

function eventCounts(events: readonly EventRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const type = event.type ?? 'UNKNOWN';
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function writeArtifacts(options: CliOptions, session: ReturnType<typeof currentSession>, regime: RegimeLabelRecord, helper: ReturnType<typeof runStartHelper>): void {
  mkdirSync(PROFILE_ARTIFACT_DIR, { recursive: true });
  mkdirSync(REGIME_ARTIFACT_DIR, { recursive: true });
  mkdirSync(ROLLUP_ARTIFACT_DIR, { recursive: true });
  mkdirSync(path.join(REPO_ROOT, 'docs', 'research'), { recursive: true });
  const events = readEvents();
  const counts = eventCounts(events);
  const orderIntentCount = counts.ORDER_INTENT ?? 0;
  const candidateEvents = events.filter((event) => event.type === 'CANDIDATE');
  const stratEvalEvents = events.filter((event) => event.type === 'STRAT_EVAL');
  const startReport = existsSync(START_REPORT_PATH) ? JSON.parse(readFileSync(START_REPORT_PATH, 'utf8')) as Json : null;
  const common = {
    generated_at_utc: new Date().toISOString(),
    session,
    regime_label_source: regime as unknown as Json,
    start_helper_status: helper.status,
    start_helper_duration_ms: helper.duration_ms,
    start_helper_stdout_sha256: sha256Lf(helper.stdout),
    start_helper_stderr_sha256: sha256Lf(helper.stderr),
    start_report: startReport,
    authority_locks: {
      paper_observation_stop_after_candidate: true,
      order_intent_required_to_remain_zero: true,
      ORDER_INTENT: orderIntentCount,
      order_translation_authority_created: false,
      production_account_used: false,
      live_broker_authority_created: false,
      phase_6_authority_created: false,
      roster_mutated: false,
    },
  };
  const profile = {
    ticket: PROFILE_TICKET,
    determination: 'SHADOW_MODE_LIVE_CAPTURE_PROFILE_READY',
    profile_config_path: PROFILE_CONFIG_PATH,
    market_data_source: 'live_local_capture_tail',
    feature_bridge: 'live_capture_feature_bridge_enabled',
    stop_mode: 'paper_observation_stop_after_candidate',
    ...common,
  };
  const regimeReport = {
    ticket: REGIME_TICKET,
    determination: 'SHADOW_MODE_REGIME_LABEL_SOURCE_READY',
    source_backed_label: regime.label,
    source_path: process.env.QFA_SHADOW_REGIME_LABEL_SOURCE_PATH ?? REGIME_SOURCE_PATH,
    global_regime_labels_mutated: false,
    ...common,
  };
  const rollup = {
    ticket: ROLLUP_TICKET,
    determination: orderIntentCount === 0 ? 'SHADOW_MODE_PERFORMANCE_ROLLUP_READY_ORDER_INTENT_ZERO' : 'SHADOW_MODE_PERFORMANCE_ROLLUP_FAILED_ORDER_INTENT_NONZERO',
    journal_path: JOURNAL_PATH,
    event_counts: counts,
    strat_eval_count: stratEvalEvents.length,
    candidate_count: candidateEvents.length,
    order_intent_count: orderIntentCount,
    candidates: candidateEvents.map((event) => event.payload ?? {}),
    strat_evals: stratEvalEvents.map((event) => event.payload ?? {}),
    ...common,
  };
  writeReport(PROFILE_ARTIFACT_DIR, 'shadow-mode-profile', profile);
  writeReport(REGIME_ARTIFACT_DIR, 'shadow-mode-regime-label-source', regimeReport);
  writeReport(ROLLUP_ARTIFACT_DIR, 'shadow-mode-performance-rollup', rollup);
  writeMemo(PROFILE_TICKET, profile);
  writeMemo(REGIME_TICKET, regimeReport);
  writeMemo(ROLLUP_TICKET, rollup);
  updateBacklog();
  if (orderIntentCount !== 0) process.exitCode = 1;
  console.log(JSON.stringify({
    state: 'PENDING_REVIEW',
    profile_ticket: PROFILE_TICKET,
    regime_ticket: REGIME_TICKET,
    rollup_ticket: ROLLUP_TICKET,
    helper_status: helper.status,
    event_counts: counts,
    order_intent_count: orderIntentCount,
    regime_label: regime.label,
    session_id: session.session_id,
    rollup_determination: rollup.determination,
  }, null, 2));
}

function writeReport(dir: string, slug: string, report: Record<string, unknown>): void {
  const json = stableJson(report) + '\n';
  const jsonl = stableJson({ record_type: 'REPORT', payload: report }) + '\n';
  const md = `# ${String(report.ticket)}\n\n## Determination\n\n\`\`\`text\n${String(report.determination)}\n\`\`\`\n\n## Key counts\n\n\`\`\`json\n${JSON.stringify((report.event_counts ?? {}) as Json, null, 2)}\n\`\`\`\n\n## Authority boundary\n\nORDER_INTENT must remain zero. No order translation, production account, live broker authority, Phase 6 authority, or roster mutation is authorized.\n\n## Output hashes\n\n\`\`\`text\nreport_json_lf_sha256 = ${sha256Lf(json)}\nbounded_jsonl_lf_sha256 = ${sha256Lf(jsonl)}\n\`\`\`\n`;
  writeFileSync(path.join(dir, `${slug}-report.json`), json, 'utf8');
  writeFileSync(path.join(dir, `bounded-${slug}.jsonl`), jsonl, 'utf8');
  writeFileSync(path.join(dir, `${slug}-report.md`), md, 'utf8');
}

function writeMemo(ticket: string, report: Record<string, unknown>): void {
  const file = path.join(REPO_ROOT, 'docs', 'research', `${ticket.toLowerCase()}.md`);
  const text = `# ${ticket}\n\nSTATE: PENDING-REVIEW\n\nDetermination:\n\n\`\`\`text\n${String(report.determination)}\n\`\`\`\n\nThis ticket is part of QFA-612 live-capture shadow mode. It preserves paper_observation_stop_after_candidate=true and requires ORDER_INTENT=0. No order translation, production account, live broker authority, Phase 6 authority, or roster mutation is authorized.\n`;
  writeFileSync(file, text, 'utf8');
}

function updateBacklog(): void {
  const rows = [
    'QFA-612-SHADOW-MODE-LIVE-CAPTURE-PROFILE-01,P1,0.5,QFA-612-PAPER-TRADING-START-RTH-2026-06-15-IMPL-01,Create guarded live_local_capture_tail shadow-mode profile using full-session minute-bar seed paper_observation_stop_after_candidate and ORDER_INTENT zero authority,broker_order_plant_lifecycle',
    'QFA-612-SHADOW-MODE-REGIME-LABEL-SOURCE-01,P1,0.5,QFA-612-SHADOW-MODE-LIVE-CAPTURE-PROFILE-01,Add source-backed session regime-label input for QFA-612 live-capture shadow mode while preserving global regime labels read-only and failing closed when missing,broker_order_plant_lifecycle',
    'QFA-612-SHADOW-MODE-PERFORMANCE-ROLLUP-01,P1,0.5,QFA-612-SHADOW-MODE-REGIME-LABEL-SOURCE-01,Produce shadow-mode performance rollup from live-capture paper journal with QUOTE FEATURES STRAT_EVAL CANDIDATE counts and ORDER_INTENT zero enforcement,broker_order_plant_lifecycle',
  ];
  const existing = existsSync(BACKLOG_PATH) ? readFileSync(BACKLOG_PATH, 'utf8') : '';
  const additions = rows.filter((row) => !existing.includes(row.split(',')[0]!));
  if (additions.length === 0) return;
  const prefix = existing.endsWith('\n') || existing.length === 0 ? existing : `${existing}\n`;
  writeFileSync(BACKLOG_PATH, `${prefix}${additions.join('\n')}\n`, 'utf8');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
}

function quoteCmdArg(arg: string): string {
  return /^[A-Za-z0-9_./:=\\-]+$/u.test(arg) ? arg : `"${arg.replace(/"/gu, '\\"')}"`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) out[key] = sortJson(entry);
    return out;
  }
  return value;
}

function sha256Lf(text: string | null | undefined): string {
  return createHash('sha256').update((text ?? '').replace(/\r\n/gu, '\n')).digest('hex');
}

const options = parseCli(process.argv.slice(2));
const session = currentSession();
const regime = resolveRegimeLabel(session.session_id);
const helper = runStartHelper(options, regime, session);
writeArtifacts(options, session, regime, helper);
if (helper.status !== 0) process.exitCode = helper.status ?? 1;
