import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { makeRunId, makeSessionId, ns, type UnixNs } from '../../apps/strategy_runtime/src/contracts/index.js';
import { PaperTradingSession, resolvePaperTradingSessionConfig } from '../../apps/strategy_runtime/src/paper-trading/index.js';
import { getMnqSessionPhase, loadMnqSessionCalendarConfig } from '../../apps/strategy_runtime/src/session/mnq-session-calendar.js';

const TICKET = 'QFA-612-PAPER-TRADING-START-RTH-2026-06-15-IMPL-01';
const CONFIG_PATH = 'config/paper/qfa-612-rth-2026-06-15-paper-trading.yaml';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion' as const;
const LIVE_CAPTURE_ROOT = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures';
const LIVE_CAPTURE_OBS_FILE = 'MNQ_globex.obs01.jsonl';
const MAX_LIVE_CAPTURE_TAIL_STALENESS_MS = 120_000;
const REPO_ROOT = process.cwd();
const PRIMARY_ENV_PATH = 'D:/Quant-futures-app/.env';
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'broker', 'qfa-612-paper-trading-start-rth-2026-06-15-impl-01');
const BOUNDED_JSONL = path.join(ARTIFACT_DIR, 'bounded-paper-trading-start-rth-2026-06-15.jsonl');
const REPORT_JSON = path.join(ARTIFACT_DIR, 'paper-trading-start-rth-2026-06-15-report.json');
const REPORT_MD = path.join(ARTIFACT_DIR, 'paper-trading-start-rth-2026-06-15-report.md');
const MEMO_PATH = path.join(REPO_ROOT, 'docs', 'research', 'qfa-612-paper-trading-start-rth-2026-06-15-impl-01.md');
const BACKLOG_PATH = path.join(REPO_ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const RUN_ID = makeRunId('run-qfa-612-paper-trading-start-rth-2026-06-15');
const SESSION_ID = makeSessionId('session-qfa-612-paper-trading-start-rth-2026-06-15');
const SUBSTRATE = 'origin/main@9f365050c59e58d8778ad782a52c7f9c25e05abb';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface CliOptions {
  readonly start: boolean;
  readonly preflight_only: boolean;
  readonly allow_preopen: boolean;
  readonly duration_ms?: number;
}

interface GateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: Json;
}

function parseCli(argv: readonly string[]): CliOptions {
  let start = false;
  let preflightOnly = false;
  let allowPreopen = false;
  let durationMs: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--start') start = true;
    else if (arg === '--preflight-only') preflightOnly = true;
    else if (arg === '--allow-preopen') allowPreopen = true;
    else if (arg === '--duration-ms') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--duration-ms requires a value');
      durationMs = Number(value);
      index += 1;
    } else if (arg === '--help') {
      process.stdout.write(helpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (start && preflightOnly) throw new Error('--start and --preflight-only are mutually exclusive');
  if (!start && !preflightOnly) preflightOnly = true;
  if (durationMs !== undefined && (!Number.isInteger(durationMs) || durationMs <= 0)) {
    throw new Error('--duration-ms must be a positive integer');
  }
  return { start, preflight_only: preflightOnly, allow_preopen: allowPreopen, duration_ms: durationMs };
}

function helpText(): string {
  return `Usage: npx tsx scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts [--preflight-only|--start] [--duration-ms MS] [--allow-preopen]\n\n` +
    `Default mode is --preflight-only. --start requires RTH unless --allow-preopen is explicitly used, plus QFA_PAPER_OPERATOR_CONFIRMS_FLAT=true, QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED=true, RITHMIC_TEST_* order-placement env, exactly one live-account allowlist, and a readable live_local_capture_tail OBS source.\n`;
}

function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

function mergedEnv(): NodeJS.ProcessEnv {
  const dotenv = loadEnvFile(PRIMARY_ENV_PATH);
  const env: NodeJS.ProcessEnv = { ...dotenv, ...process.env };
  env.QFA_PAPER_SESSION_CONFIG = CONFIG_PATH;
  env.QFA_BROKER_ADAPTER_KIND = 'rithmic';
  env.QFA_PAPER_MARKET_DATA_SOURCE = 'live_local_capture_tail';
  env.QFA_PAPER_LOCAL_OBS_PATH = env.QFA_PAPER_LOCAL_OBS_PATH ?? currentTradingDateLiveCaptureObsPath();
  env.QFA_PAPER_LOCAL_OBS_PACE_MODE = 'tail_from_end';
  env.RITHMIC_TEST_USERNAME = env.RITHMIC_TEST_USERNAME ?? env.RITHMIC_TEST_USER;
  env.RITHMIC_TEST_GATEWAY_URL = env.RITHMIC_TEST_GATEWAY_URL ?? env.RITHMIC_TEST_WS_URL;
  env.RITHMIC_TEST_SYSTEM_NAME = normalizeSystemName(env.RITHMIC_TEST_SYSTEM_NAME ?? env.RITHMIC_TEST_SYSTEM ?? '');
  return env;
}

function currentTradingDateLiveCaptureObsPath(): string {
  const phase = getMnqSessionPhase(loadMnqSessionCalendarConfig(), nowNs());
  return `${LIVE_CAPTURE_ROOT}/${phase.trading_date}/${LIVE_CAPTURE_OBS_FILE}`;
}

function normalizeSystemName(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, '').trim();
  return trimmed.toLowerCase() === 'tradeify' ? 'Tradeify' : trimmed;
}

function nowNs(): UnixNs {
  return ns(BigInt(Date.now()) * 1_000_000n);
}

function boolEnv(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function allowlistCount(env: NodeJS.ProcessEnv): number | undefined {
  const allowlistPath = env.QFA_PAPER_LIVE_ACCOUNT_ALLOWLIST_PATH;
  if (allowlistPath === undefined || allowlistPath.trim() === '') return undefined;
  if (!existsSync(allowlistPath)) return undefined;
  const parsed = JSON.parse(readFileSync(allowlistPath, 'utf8')) as unknown;
  return Array.isArray(parsed) ? parsed.length : undefined;
}

function preflight(env: NodeJS.ProcessEnv, options: CliOptions): { readonly gates: readonly GateResult[]; readonly session_phase: Record<string, Json> } {
  const phase = getMnqSessionPhase(loadMnqSessionCalendarConfig(), nowNs());
  const liveAllowlistCount = allowlistCount(env);
  const liveCapturePath = env.QFA_PAPER_LOCAL_OBS_PATH ?? '';
  const liveCaptureExists = liveCapturePath !== '' && existsSync(liveCapturePath);
  const liveCaptureStat = liveCaptureExists ? statSync(liveCapturePath) : undefined;
  const liveCaptureSize = liveCaptureStat?.size ?? 0;
  const liveCaptureAgeMs = liveCaptureStat === undefined ? undefined : Math.max(0, Date.now() - liveCaptureStat.mtimeMs);
  const gates: GateResult[] = [
    { name: 'RITHMIC_TEST_USERNAME_present', passed: present(env.RITHMIC_TEST_USERNAME), detail: present(env.RITHMIC_TEST_USERNAME) },
    { name: 'RITHMIC_TEST_PASSWORD_present', passed: present(env.RITHMIC_TEST_PASSWORD), detail: present(env.RITHMIC_TEST_PASSWORD) },
    { name: 'RITHMIC_TEST_GATEWAY_URL_present', passed: present(env.RITHMIC_TEST_GATEWAY_URL), detail: present(env.RITHMIC_TEST_GATEWAY_URL) },
    { name: 'RITHMIC_TEST_SYSTEM_NAME_is_Tradeify', passed: env.RITHMIC_TEST_SYSTEM_NAME === 'Tradeify', detail: env.RITHMIC_TEST_SYSTEM_NAME === undefined || env.RITHMIC_TEST_SYSTEM_NAME === '' ? 'missing' : env.RITHMIC_TEST_SYSTEM_NAME },
    { name: 'capture_credentials_not_broker_fallback', passed: env.RITHMIC_TEST_GATEWAY_URL !== undefined, detail: 'requires explicit RITHMIC_TEST_GATEWAY_URL/RITHMIC_TEST_WS_URL' },
    { name: 'market_data_source_is_live_local_capture_tail', passed: env.QFA_PAPER_MARKET_DATA_SOURCE === 'live_local_capture_tail', detail: env.QFA_PAPER_MARKET_DATA_SOURCE ?? 'missing' },
    { name: 'live_capture_tail_path_present', passed: present(liveCapturePath), detail: present(liveCapturePath) },
    { name: 'live_capture_tail_path_exists', passed: liveCaptureExists, detail: liveCapturePath },
    { name: 'live_capture_tail_path_nonempty', passed: liveCaptureSize > 0, detail: liveCaptureSize },
    {
      name: 'live_capture_tail_recent',
      passed: liveCaptureAgeMs !== undefined && liveCaptureAgeMs <= MAX_LIVE_CAPTURE_TAIL_STALENESS_MS,
      detail: liveCaptureAgeMs ?? 'unavailable',
    },
    { name: 'QFA_PAPER_OPERATOR_CONFIRMS_FLAT_true', passed: boolEnv(env.QFA_PAPER_OPERATOR_CONFIRMS_FLAT), detail: boolEnv(env.QFA_PAPER_OPERATOR_CONFIRMS_FLAT) },
    { name: 'QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED_true', passed: boolEnv(env.QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED), detail: boolEnv(env.QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED) },
    { name: 'allowlist_path_present', passed: present(env.QFA_PAPER_LIVE_ACCOUNT_ALLOWLIST_PATH), detail: present(env.QFA_PAPER_LIVE_ACCOUNT_ALLOWLIST_PATH) },
    { name: 'allowlist_count_exactly_one', passed: liveAllowlistCount === 1, detail: liveAllowlistCount ?? 'unavailable' },
    { name: 'rth_gate', passed: phase.is_rth || options.allow_preopen, detail: { is_rth: phase.is_rth, phase: phase.phase, trading_date: phase.trading_date, allow_preopen: options.allow_preopen } },
    { name: 'start_duration_required', passed: !options.start || options.duration_ms !== undefined, detail: options.start ? options.duration_ms ?? 'missing' : 'not_starting' },
  ];
  return {
    gates,
    session_phase: {
      phase: phase.phase,
      journal_phase: phase.journal_phase,
      trading_date: phase.trading_date,
      session_id: phase.session_id,
      is_rth: phase.is_rth,
      timestamp_ns: String(phase.timestamp_ns),
    },
  };
}

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

async function main(): Promise<void> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(path.dirname(MEMO_PATH), { recursive: true });
  const options = parseCli(process.argv.slice(2));
  const env = mergedEnv();
  const readiness = preflight(env, options);
  const preflightPassed = readiness.gates.every((gate) => gate.passed);
  let started = false;
  let stopped = false;
  let diagnostics: unknown = null;
  let startError: string | null = null;

  if (options.start && preflightPassed) {
    try {
      const config = resolvePaperTradingSessionConfig({
        env,
        overrides: {
          paper_session_config_path: CONFIG_PATH,
          strategy_id: STRATEGY_ID,
          explicit_strategy_ids: [STRATEGY_ID],
          run_id: RUN_ID,
          session_id: SESSION_ID,
          duration_ms: options.duration_ms,
        },
      });
      const session = new PaperTradingSession({ env, config });
      await session.start();
      started = true;
      await new Promise((resolve) => setTimeout(resolve, options.duration_ms));
      await session.stop();
      stopped = true;
      diagnostics = session.getDiagnostics();
    } catch (error: unknown) {
      startError = error instanceof Error ? error.message : String(error);
    }
  }

  const determination = options.start
    ? started && stopped && startError === null
      ? 'PAPER_TRADING_START_RTH_2026_06_15_STARTED_AND_STOPPED_BOUNDED'
      : 'PAPER_TRADING_START_RTH_2026_06_15_BLOCKED_OR_FAILED_CLOSED'
    : preflightPassed
      ? 'PAPER_TRADING_START_RTH_2026_06_15_PREFLIGHT_READY'
      : 'PAPER_TRADING_START_RTH_2026_06_15_PREFLIGHT_BLOCKED_MISSING_LAUNCH_GATES';

  const boundedRecords = [
    { record_type: 'RUN_MANIFEST', ticket: TICKET, determination, substrate: SUBSTRATE, mode: options.start ? 'start' : 'preflight_only' },
    { record_type: 'PREFLIGHT', gates: readiness.gates, session_phase: readiness.session_phase, preflight_passed: preflightPassed },
    { record_type: 'START_RESULT', start_requested: options.start, duration_ms: options.duration_ms ?? null, started, stopped, start_error: startError, diagnostics: diagnostics as Json },
    {
      record_type: 'AUTHORITY_LOCKS',
      production_account_used: false,
      live_trading_authority_created: false,
      phase_6_authority_created: false,
      roster_mutated: false,
      capture_credentials_mutated: false,
      automatic_shutdown_flattening: false,
    },
  ];
  const boundedJsonl = boundedRecords.map((record) => stableJson(record)).join('\n') + '\n';
  writeFileSync(BOUNDED_JSONL, boundedJsonl, 'utf8');

  const report = {
    ticket: TICKET,
    determination,
    worktree: REPO_ROOT,
    substrate: SUBSTRATE,
    config_path: CONFIG_PATH,
    command: options.start
      ? `npx tsx scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts --start --duration-ms ${String(options.duration_ms)}`
      : 'npx tsx scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts --preflight-only --allow-preopen',
    gates: readiness.gates,
    session_phase: readiness.session_phase,
    start_result: boundedRecords[2],
    authority_locks: boundedRecords[3],
    output_hashes: { bounded_jsonl_lf_sha256: sha256Lf(boundedJsonl) },
  };
  const reportJson = stableJson(report) + '\n';
  writeFileSync(REPORT_JSON, reportJson, 'utf8');
  const reportMd = markdownReport(report, boundedJsonl, reportJson);
  writeFileSync(REPORT_MD, reportMd, 'utf8');
  const memoText = memo(report, boundedJsonl, reportJson, reportMd);
  writeFileSync(MEMO_PATH, memoText, 'utf8');
  updateBacklog();

  console.log(JSON.stringify({
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    determination,
    preflight_passed: preflightPassed,
    blocked_gates: readiness.gates.filter((gate) => !gate.passed).map((gate) => gate.name),
    bounded_jsonl_lf_sha256: sha256Lf(boundedJsonl),
    report_json_lf_sha256: sha256Lf(reportJson),
    report_md_lf_sha256: sha256Lf(reportMd),
    memo_lf_sha256: sha256Lf(memoText),
  }, null, 2));

  if (options.start && (!started || startError !== null)) process.exitCode = 1;
}

function markdownReport(report: Record<string, unknown>, boundedJsonl: string, reportJson: string): string {
  const gates = report.gates as readonly GateResult[];
  const rows = gates.map((gate) => `| ${gate.name} | ${gate.passed ? 'PASS' : 'BLOCKED'} | ${stableJson(gate.detail)} |`).join('\n');
  return `# ${TICKET}\n\n` +
    `## Determination\n\n\`\`\`text\n${String(report.determination)}\n\`\`\`\n\n` +
    `## Gates\n\n| Gate | Status | Detail |\n|---|---|---|\n${rows}\n\n` +
    `## Launch command\n\n\`\`\`powershell\n${String(report.command)}\n\`\`\`\n\n` +
    `## Boundary\n\nThis wrapper is paper-mode Rithmic Test only. Capture credentials are not broker fallback. No production account, live trading authority, Phase 6 authority, roster mutation, automatic shutdown flattening, or capture credential mutation is authorized.\n\n` +
    `## Output hashes\n\n\`\`\`text\nbounded_jsonl_lf_sha256 = ${sha256Lf(boundedJsonl)}\nreport_json_lf_sha256 = ${sha256Lf(reportJson)}\n\`\`\`\n`;
}

function memo(report: Record<string, unknown>, boundedJsonl: string, reportJson: string, reportMd: string): string {
  return `# ${TICKET}\n\nSTATE: PENDING-REVIEW\n\nDetermination:\n\n\`\`\`text\n${String(report.determination)}\n\`\`\`\n\n` +
    `This implementation adds a dedicated 2026-06-15 RTH paper-trading config and a fail-closed launch wrapper. Default mode is preflight-only; actual paper start requires --start, --duration-ms, RTH unless explicitly allowed, RITHMIC_TEST_* order-placement env, explicit gateway, exactly one allowlisted account, flat-at-start confirmation, account-active confirmation, and a readable live_local_capture_tail OBS source.\n\n` +
    `Authority boundary remains: no production account, no live broker authority, no Phase 6 authority, no roster mutation, no capture credential mutation, and no automatic shutdown flattening.\n\n` +
    `Output hashes:\n\n\`\`\`text\nbounded_jsonl_lf_sha256 = ${sha256Lf(boundedJsonl)}\nreport_json_lf_sha256 = ${sha256Lf(reportJson)}\nreport_md_lf_sha256 = ${sha256Lf(reportMd)}\n\`\`\`\n`;
}

function updateBacklog(): void {
  const row = 'QFA-612-PAPER-TRADING-START-RTH-2026-06-15-IMPL-01,P1,1.0,QFA-612-PAPER-TRADING-START-RTH-2026-06-15-SCOPE-01,Implement dedicated fail-closed 2026-06-15 RTH paper-trading launch config wrapper and readiness artifacts for Rithmic Test ORDER_PLANT paper mode while preserving capture credential isolation no production live Phase 6 roster or unbounded position authority,broker_order_plant_lifecycle';
  const existing = existsSync(BACKLOG_PATH) ? readFileSync(BACKLOG_PATH, 'utf8') : '';
  if (existing.includes('QFA-612-PAPER-TRADING-START-RTH-2026-06-15-IMPL-01')) return;
  const next = existing.endsWith('\n') || existing.length === 0 ? existing + row + '\n' : existing + '\n' + row + '\n';
  writeFileSync(BACKLOG_PATH, next, 'utf8');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) result[key] = sortJson(entry);
    return result;
  }
  return value;
}

function sha256Lf(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
