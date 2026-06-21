import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { makeRunId, makeSessionId, ns, type UnixNs } from '../../apps/strategy_runtime/src/contracts/index.js';
import { parseStrategyId, type StrategyId } from '../../apps/strategy_runtime/src/contracts/strategy-ids.js';
import { PaperTradingSession, resolvePaperTradingSessionConfig } from '../../apps/strategy_runtime/src/paper-trading/index.js';
import {
  deriveMbp1Path,
  LIVE_CAPTURE_FEATURE_BRIDGE_MAX_QUOTE_SEED_BYTES,
  LIVE_CAPTURE_FEATURE_BRIDGE_MAX_TRADE_SEED_BYTES,
  LIVE_CAPTURE_MINUTE_BAR_SEED_SCHEMA_VERSION,
} from '../../apps/strategy_runtime/src/paper-trading/live-local-capture-feature-bridge.js';
import { getMnqSessionPhase, loadMnqSessionCalendarConfig } from '../../apps/strategy_runtime/src/session/mnq-session-calendar.js';

const TICKET = 'QFA-612-PAPER-TRADING-START-RTH-2026-06-15-IMPL-01';
const DEFAULT_CONFIG_PATH = 'config/paper/qfa-612-rth-2026-06-15-paper-trading.yaml';
const DEFAULT_STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion' as const;
const LIVE_CAPTURE_ROOT = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures';
const LIVE_CAPTURE_OBS_FILE = 'MNQ_globex.obs01.jsonl';
const DEFAULT_RITHMIC_RPROTOCOL_HOME = 'D:/Quant-futures-app/.local/rithmic';
const MAX_LIVE_CAPTURE_TAIL_STALENESS_MS = 120_000;
const REPO_ROOT = process.cwd();
const LIVE_CAPTURE_MINUTE_BAR_SEED_DIR = path.join(REPO_ROOT, '.tmp', 'qfa-612-live-capture-minute-bar-seed');
const LIVE_CAPTURE_PRIOR_SESSION_SUMMARY_DIR = path.join(REPO_ROOT, '.tmp', 'qfa-612-live-capture-prior-session-summary');
const PRIMARY_ENV_PATH = 'D:/Quant-futures-app/.env';
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'broker', 'qfa-612-paper-trading-start-rth-2026-06-15-impl-01');
const BOUNDED_JSONL = path.join(ARTIFACT_DIR, 'bounded-paper-trading-start-rth-2026-06-15.jsonl');
const REPORT_JSON = path.join(ARTIFACT_DIR, 'paper-trading-start-rth-2026-06-15-report.json');
const REPORT_MD = path.join(ARTIFACT_DIR, 'paper-trading-start-rth-2026-06-15-report.md');
const MEMO_PATH = path.join(REPO_ROOT, 'docs', 'research', 'qfa-612-paper-trading-start-rth-2026-06-15-impl-01.md');
const BACKLOG_PATH = path.join(REPO_ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const RUN_ID = makeRunId('run-qfa-612-paper-trading-start-rth-2026-06-15');
const SESSION_ID = makeSessionId('session-qfa-612-paper-trading-start-rth-2026-06-15');
const SUBSTRATE = 'origin/main@a88a8c388667021ca3c8c4b9a857b2f7fcb81353';

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

interface MutableMinuteBar {
  slot: number;
  start_ts_ns: string;
  end_ts_ns: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
}

interface MinuteBarSeedSummary {
  readonly path: string;
  readonly source_obs01_path: string;
  readonly source_obs01_size_bytes: number;
  readonly trading_date: string;
  readonly bars_count: number;
  readonly first_slot: number | null;
  readonly last_slot: number | null;
  readonly source_records_scanned: number;
  readonly generated_at_utc: string;
}

interface PriorSessionSummary {
  readonly path: string;
  readonly source_obs01_path: string;
  readonly source_obs01_size_bytes: number;
  readonly trading_date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly trend_state: 'prior_down_large' | 'prior_down' | 'prior_flat' | 'prior_up' | 'prior_up_large';
  readonly source_records_scanned: number;
  readonly generated_at_utc: string;
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

function configuredPaperSessionConfigPath(env: NodeJS.ProcessEnv): string {
  return env.QFA_PAPER_SESSION_CONFIG ?? DEFAULT_CONFIG_PATH;
}

function configuredStrategyId(env: NodeJS.ProcessEnv): StrategyId {
  return parseStrategyId(env.QFA_PAPER_SHADOW_STRATEGY_ID ?? env.QFA_PAPER_STRATEGY_ID ?? DEFAULT_STRATEGY_ID);
}
function mergedEnv(): NodeJS.ProcessEnv {
  const dotenv = loadEnvFile(PRIMARY_ENV_PATH);
  const env: NodeJS.ProcessEnv = { ...dotenv, ...process.env };
  env.QFA_PAPER_SESSION_CONFIG = configuredPaperSessionConfigPath(env);
  env.QFA_PAPER_SHADOW_STRATEGY_ID = env.QFA_PAPER_SHADOW_STRATEGY_ID ?? env.QFA_PAPER_STRATEGY_ID ?? DEFAULT_STRATEGY_ID;
  env.QFA_BROKER_ADAPTER_KIND = 'rithmic';
  env.QFA_PAPER_MARKET_DATA_SOURCE = 'live_local_capture_tail';
  env.QFA_PAPER_LOCAL_OBS_PATH = env.QFA_PAPER_LOCAL_OBS_PATH ?? currentTradingDateLiveCaptureObsPath();
  env.QFA_PAPER_LIVE_CAPTURE_MINUTE_BAR_SEED_PATH = env.QFA_PAPER_LIVE_CAPTURE_MINUTE_BAR_SEED_PATH ?? defaultMinuteBarSeedPath(env.QFA_PAPER_LOCAL_OBS_PATH);
  env.QFA_PAPER_CAPTURE_PRIOR_SESSION_SUMMARY_PATH = env.QFA_PAPER_CAPTURE_PRIOR_SESSION_SUMMARY_PATH ?? defaultPriorSessionSummaryPath(env.QFA_PAPER_LOCAL_OBS_PATH);
  env.QFA_PAPER_LOCAL_OBS_PACE_MODE = 'tail_from_end';
  env.QFA_PAPER_OBSERVATION_STOP_AFTER_CANDIDATE = 'true';
  env.QFA_PAPER_LIVE_CAPTURE_FEATURE_BRIDGE_ENABLED = 'true';
  env.RITHMIC_RPROTOCOL_HOME = env.RITHMIC_RPROTOCOL_HOME ?? DEFAULT_RITHMIC_RPROTOCOL_HOME;
  env.RITHMIC_TEST_USERNAME = env.RITHMIC_TEST_USERNAME ?? env.RITHMIC_TEST_USER;
  env.RITHMIC_TEST_GATEWAY_URL = env.RITHMIC_TEST_GATEWAY_URL ?? env.RITHMIC_TEST_WS_URL;
  env.RITHMIC_TEST_SYSTEM_NAME = normalizeSystemName(
    env.RITHMIC_TEST_SYSTEM_NAME ??
      env.RITHMIC_TEST_SYSTEM ??
      'Tradeify',
  );
  env.RITHMIC_TEST_SYSTEM = env.RITHMIC_TEST_SYSTEM_NAME;
  env.RITHMIC_SYSTEM_NAME = env.RITHMIC_TEST_SYSTEM_NAME;
  env.RITHMIC_SYSTEM = env.RITHMIC_TEST_SYSTEM_NAME;
  env.RITHMIC_LUCID_SYSTEM_NAME = env.RITHMIC_TEST_SYSTEM_NAME;
  return env;
}

function currentTradingDateLiveCaptureObsPath(): string {
  const phase = getMnqSessionPhase(loadMnqSessionCalendarConfig(), nowNs());
  return `${LIVE_CAPTURE_ROOT}/${phase.trading_date}/${LIVE_CAPTURE_OBS_FILE}`;
}

function defaultMinuteBarSeedPath(obs01Path: string): string {
  const tradingDate = parseTradingDateFromCapturePath(obs01Path) ?? 'unknown-date';
  return path.join(LIVE_CAPTURE_MINUTE_BAR_SEED_DIR, `${tradingDate}-MNQ_globex.minute-bars.seed.json`);
}

function defaultPriorSessionSummaryPath(obs01Path: string): string {
  const tradingDate = parseTradingDateFromCapturePath(obs01Path) ?? 'unknown-date';
  return path.join(LIVE_CAPTURE_PRIOR_SESSION_SUMMARY_DIR, `${tradingDate}-prior-session-summary.json`);
}
function normalizeSystemName(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, '').trim();
  const normalized = trimmed.toLowerCase();
  if (normalized === '' || normalized === 'tradeify' || normalized === 'rithmic paper trading') {
    return 'Tradeify';
  }
  return trimmed;
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

function preflight(
  env: NodeJS.ProcessEnv,
  options: CliOptions,
  minuteBarSeed: MinuteBarSeedSummary | null,
  priorSessionSummary: PriorSessionSummary | null,
): { readonly gates: readonly GateResult[]; readonly session_phase: Record<string, Json> } {
  const phase = getMnqSessionPhase(loadMnqSessionCalendarConfig(), nowNs());
  const liveAllowlistCount = allowlistCount(env);
  const liveCapturePath = env.QFA_PAPER_LOCAL_OBS_PATH ?? '';
  const liveCaptureExists = liveCapturePath !== '' && existsSync(liveCapturePath);
  const liveCaptureStat = liveCaptureExists ? statSync(liveCapturePath) : undefined;
  const liveCaptureSize = liveCaptureStat?.size ?? 0;
  const liveCaptureAgeMs = liveCaptureStat === undefined ? undefined : Math.max(0, Date.now() - liveCaptureStat.mtimeMs);
  const liveCaptureMbp1Path = liveCapturePath === '' ? '' : deriveMbp1Path(liveCapturePath);
  const liveCaptureMbp1Exists = liveCaptureMbp1Path !== '' && existsSync(liveCaptureMbp1Path);
  const liveCaptureMbp1Stat = liveCaptureMbp1Exists ? statSync(liveCaptureMbp1Path) : undefined;
  const liveCaptureMbp1AgeMs = liveCaptureMbp1Stat === undefined ? undefined : Math.max(0, Date.now() - liveCaptureMbp1Stat.mtimeMs);
  const minuteBarSeedPath = env.QFA_PAPER_LIVE_CAPTURE_MINUTE_BAR_SEED_PATH ?? '';
  const priorSummaryPath = env.QFA_PAPER_CAPTURE_PRIOR_SESSION_SUMMARY_PATH ?? '';
  const priorSummaryExists = priorSummaryPath !== '' && existsSync(priorSummaryPath);
  const strategyId = env.QFA_PAPER_SHADOW_STRATEGY_ID ?? DEFAULT_STRATEGY_ID;
  const priorTrendRequired = strategyId === 'opening_range_box_breakout_long';
  const minuteBarSeedExists = minuteBarSeedPath !== '' && existsSync(minuteBarSeedPath);
  const minuteBarSeedSourceMatches = minuteBarSeed?.source_obs01_path === liveCapturePath;
  const minuteBarSeedSourceSizeCovered =
    minuteBarSeed !== null &&
    liveCaptureStat !== undefined &&
    minuteBarSeed.source_obs01_size_bytes > 0 &&
    minuteBarSeed.source_obs01_size_bytes <= liveCaptureStat.size;
  const rprotocolHome = env.RITHMIC_RPROTOCOL_HOME ?? '';
  const gates: GateResult[] = [
    { name: 'RITHMIC_TEST_USERNAME_present', passed: present(env.RITHMIC_TEST_USERNAME), detail: present(env.RITHMIC_TEST_USERNAME) },
    { name: 'RITHMIC_TEST_PASSWORD_present', passed: present(env.RITHMIC_TEST_PASSWORD), detail: present(env.RITHMIC_TEST_PASSWORD) },
    { name: 'RITHMIC_TEST_GATEWAY_URL_present', passed: present(env.RITHMIC_TEST_GATEWAY_URL), detail: present(env.RITHMIC_TEST_GATEWAY_URL) },
    { name: 'RITHMIC_TEST_SYSTEM_NAME_is_Tradeify', passed: env.RITHMIC_TEST_SYSTEM_NAME === 'Tradeify', detail: env.RITHMIC_TEST_SYSTEM_NAME === undefined || env.RITHMIC_TEST_SYSTEM_NAME === '' ? 'missing' : env.RITHMIC_TEST_SYSTEM_NAME },
    { name: 'RITHMIC_RPROTOCOL_HOME_present', passed: present(rprotocolHome), detail: present(rprotocolHome) },
    { name: 'RITHMIC_RPROTOCOL_HOME_exists', passed: present(rprotocolHome) && existsSync(rprotocolHome), detail: rprotocolHome || 'missing' },
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
    { name: 'live_capture_mbp1_path_exists', passed: liveCaptureMbp1Exists, detail: liveCaptureMbp1Path },
    {
      name: 'live_capture_mbp1_recent',
      passed: liveCaptureMbp1AgeMs !== undefined && liveCaptureMbp1AgeMs <= MAX_LIVE_CAPTURE_TAIL_STALENESS_MS,
      detail: liveCaptureMbp1AgeMs ?? 'unavailable',
    },
    { name: 'live_capture_minute_bar_seed_path_present', passed: present(minuteBarSeedPath), detail: minuteBarSeedPath || 'missing' },
    { name: 'live_capture_minute_bar_seed_path_exists', passed: minuteBarSeedExists, detail: minuteBarSeedPath || 'missing' },
    { name: 'live_capture_minute_bar_seed_source_matches_obs01', passed: minuteBarSeedSourceMatches, detail: minuteBarSeed?.source_obs01_path ?? 'unavailable' },
    { name: 'live_capture_minute_bar_seed_source_size_covered', passed: minuteBarSeedSourceSizeCovered, detail: minuteBarSeed?.source_obs01_size_bytes ?? 'unavailable' },
    { name: 'live_capture_minute_bar_seed_has_warmup', passed: (minuteBarSeed?.bars_count ?? 0) >= 14, detail: minuteBarSeed?.bars_count ?? 0 },
    { name: 'live_capture_minute_bar_seed_starts_at_rth_open', passed: minuteBarSeed?.first_slot === 0, detail: minuteBarSeed?.first_slot ?? 'unavailable' },
    { name: 'prior_session_summary_path_present', passed: !priorTrendRequired || present(priorSummaryPath), detail: priorSummaryPath || 'missing' },
    { name: 'prior_session_summary_path_exists', passed: !priorTrendRequired || priorSummaryExists, detail: priorSummaryPath || 'missing' },
    { name: 'prior_session_summary_trend_state_ready', passed: !priorTrendRequired || priorSessionSummary !== null, detail: priorSessionSummary?.trend_state ?? 'unavailable' },
    { name: 'paper_observation_stop_after_candidate_enabled', passed: boolEnv(env.QFA_PAPER_OBSERVATION_STOP_AFTER_CANDIDATE), detail: boolEnv(env.QFA_PAPER_OBSERVATION_STOP_AFTER_CANDIDATE) },
    { name: 'live_capture_feature_bridge_enabled', passed: boolEnv(env.QFA_PAPER_LIVE_CAPTURE_FEATURE_BRIDGE_ENABLED), detail: boolEnv(env.QFA_PAPER_LIVE_CAPTURE_FEATURE_BRIDGE_ENABLED) },
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
  const minuteBarSeed = await ensureMinuteBarSeed(env);
  const priorSessionSummary = await ensurePriorSessionSummary(env);
  const readiness = preflight(env, options, minuteBarSeed, priorSessionSummary);
  const preflightPassed = readiness.gates.every((gate) => gate.passed);
  let started = false;
  let stopped = false;
  let diagnostics: unknown = null;
  let startError: string | null = null;
  const strategyId = configuredStrategyId(env);

  if (options.start && preflightPassed) {
    try {
      const config = resolvePaperTradingSessionConfig({
        env,
        overrides: {
          paper_session_config_path: configuredPaperSessionConfigPath(env),
          strategy_id: strategyId,
          explicit_strategy_ids: [strategyId],
          paper_observation_stop_after_candidate: true,
          live_capture_feature_bridge_enabled: true,
          live_capture_minute_bar_seed_path: env.QFA_PAPER_LIVE_CAPTURE_MINUTE_BAR_SEED_PATH,
          live_capture_prior_session_summary_path: env.QFA_PAPER_CAPTURE_PRIOR_SESSION_SUMMARY_PATH,
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

  const startRecord = { record_type: 'START_RESULT', start_requested: options.start, duration_ms: options.duration_ms ?? null, started, stopped, start_error: startError, diagnostics: diagnostics as Json };
  const authorityRecord = {
    record_type: 'AUTHORITY_LOCKS',
    production_account_used: false,
    live_trading_authority_created: false,
    phase_6_authority_created: false,
    roster_mutated: false,
    capture_credentials_mutated: false,
    automatic_shutdown_flattening: false,
  };
  const boundedRecords = [
    { record_type: 'RUN_MANIFEST', ticket: TICKET, determination, substrate: SUBSTRATE, mode: options.start ? 'start' : 'preflight_only' },
    { record_type: 'PREFLIGHT', gates: readiness.gates, session_phase: readiness.session_phase, preflight_passed: preflightPassed },
    { record_type: 'MINUTE_BAR_SEED', minute_bar_seed: minuteBarSeed as unknown as Json },
    startRecord,
    authorityRecord,
  ];
  const boundedJsonl = boundedRecords.map((record) => stableJson(record)).join('\n') + '\n';
  writeFileSync(BOUNDED_JSONL, boundedJsonl, 'utf8');

  const report = {
    ticket: TICKET,
    determination,
    worktree: REPO_ROOT,
    substrate: SUBSTRATE,
    config_path: configuredPaperSessionConfigPath(env),
    minute_bar_seed: minuteBarSeed as unknown as Json,
    prior_session_summary: priorSessionSummary as unknown as Json,
    live_capture_feature_bridge_contract: {
      source: 'live_local_capture_tail',
      obs01_seed_scope: 'full_session_minute_bar_seed',
      mbp1_seed_scope: 'bounded_recent_tail',
      max_trade_seed_bytes: LIVE_CAPTURE_FEATURE_BRIDGE_MAX_TRADE_SEED_BYTES,
      max_quote_seed_bytes: LIVE_CAPTURE_FEATURE_BRIDGE_MAX_QUOTE_SEED_BYTES,
      historical_replay_policy: 'full_session_minute_bar_state_without_historical_strategy_runtime_replay',
      fresh_runtime_cycle_expected: true,
      full_session_vwap_authority: true,
      full_session_vwap_authority_scope: 'through_minute_bar_seed_source_offset_plus_live_tail',
      observation_day_authority: false,
      order_translation_authority: false,
    },
    command: options.start
      ? `npx tsx scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts --start --duration-ms ${String(options.duration_ms)}`
      : 'npx tsx scripts/paper/run-qfa-612-rth-2026-06-15-paper-trading.ts --preflight-only --allow-preopen',
    gates: readiness.gates,
    session_phase: readiness.session_phase,
    start_result: startRecord,
    authority_locks: authorityRecord,
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

async function ensurePriorSessionSummary(env: NodeJS.ProcessEnv): Promise<PriorSessionSummary | null> {
  const currentObs01Path = env.QFA_PAPER_LOCAL_OBS_PATH;
  const summaryPath = env.QFA_PAPER_CAPTURE_PRIOR_SESSION_SUMMARY_PATH;
  if (currentObs01Path === undefined || currentObs01Path.trim() === '' || summaryPath === undefined || summaryPath.trim() === '') {
    return null;
  }
  const currentTradingDate = parseTradingDateFromCapturePath(currentObs01Path);
  if (currentTradingDate === null) {
    return null;
  }
  mkdirSync(path.dirname(summaryPath), { recursive: true });
  const priorObs01Path = findPriorCaptureObsPath(currentTradingDate);
  if (priorObs01Path === null) {
    return null;
  }
  const sourceSizeBytes = statSync(priorObs01Path).size;
  if (existsSync(summaryPath)) {
    try {
      const existing = JSON.parse(readFileSync(summaryPath, 'utf8')) as PriorSessionSummary;
      if (existing.source_obs01_path === priorObs01Path && existing.source_obs01_size_bytes === sourceSizeBytes) {
        return existing;
      }
    } catch {
      // Fall through and rebuild.
    }
  }
  return await buildPriorSessionSummary(priorObs01Path, summaryPath, sourceSizeBytes);
}

function findPriorCaptureObsPath(currentTradingDate: string): string | null {
  if (!existsSync(LIVE_CAPTURE_ROOT)) {
    return null;
  }
  const candidates = readdirSync(LIVE_CAPTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(entry.name) && entry.name < currentTradingDate)
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const date of candidates) {
    const candidate = path.join(LIVE_CAPTURE_ROOT, date, LIVE_CAPTURE_OBS_FILE);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function buildPriorSessionSummary(
  priorObs01Path: string,
  summaryPath: string,
  sourceSizeBytes: number,
): Promise<PriorSessionSummary> {
  const tradingDate = parseTradingDateFromCapturePath(priorObs01Path);
  if (tradingDate === null) {
    throw new Error(`could not parse prior trading date from capture path: ${priorObs01Path}`);
  }
  const rthOpenNs = BigInt(Date.parse(`${tradingDate}T13:30:00.000Z`)) * 1_000_000n;
  const rthCloseNs = BigInt(Date.parse(`${tradingDate}T20:00:00.000Z`)) * 1_000_000n;
  let open: number | null = null;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let close: number | null = null;
  let sourceRecordsScanned = 0;
  let remainder = '';
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(priorObs01Path, {
      encoding: 'utf8',
      highWaterMark: 4 * 1024 * 1024,
      start: 0,
      end: Math.max(0, sourceSizeBytes - 1),
    });
    stream.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const parts = (remainder + text).split(/\r?\n/u);
      remainder = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim() === '') continue;
        sourceRecordsScanned += 1;
        const tsNs = extractBigintFieldFast(line, 'exchange_event_ts_ns') ?? extractBigintFieldFast(line, 'sidecar_recv_ts_ns');
        const price = extractNumberFieldFast(line, 'price');
        if (tsNs === null || price === null || tsNs < rthOpenNs || tsNs >= rthCloseNs) continue;
        if (open === null) open = price;
        high = Math.max(high, price);
        low = Math.min(low, price);
        close = price;
      }
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  if (open === null || close === null || !Number.isFinite(high) || !Number.isFinite(low) || !(high >= low)) {
    throw new Error(`prior-session capture has no usable RTH trades: ${priorObs01Path}`);
  }
  const summary: PriorSessionSummary = {
    path: summaryPath,
    source_obs01_path: priorObs01Path,
    source_obs01_size_bytes: sourceSizeBytes,
    trading_date: tradingDate,
    open: round4(open),
    high: round4(high),
    low: round4(low),
    close: round4(close),
    trend_state: priorSessionTrendState(open, high, low, close),
    source_records_scanned: sourceRecordsScanned,
    generated_at_utc: new Date().toISOString(),
  };
  writeFileSync(summaryPath, stableJson(summary) + '\n', 'utf8');
  return summary;
}

function priorSessionTrendState(
  open: number,
  high: number,
  low: number,
  close: number,
): PriorSessionSummary['trend_state'] {
  const range = high - low;
  if (!(range > 0)) return 'prior_flat';
  const closeLocationFromOpen = (close - open) / range;
  if (closeLocationFromOpen <= -0.25) return 'prior_down_large';
  if (closeLocationFromOpen < 0) return 'prior_down';
  if (closeLocationFromOpen >= 0.25) return 'prior_up_large';
  if (closeLocationFromOpen > 0) return 'prior_up';
  return 'prior_flat';
}
async function ensureMinuteBarSeed(env: NodeJS.ProcessEnv): Promise<MinuteBarSeedSummary | null> {
  const obs01Path = env.QFA_PAPER_LOCAL_OBS_PATH;
  const seedPath = env.QFA_PAPER_LIVE_CAPTURE_MINUTE_BAR_SEED_PATH;
  if (obs01Path === undefined || obs01Path.trim() === '' || seedPath === undefined || seedPath.trim() === '' || !existsSync(obs01Path)) {
    return null;
  }
  const resolvedObs01Path = obs01Path;
  const resolvedSeedPath = seedPath;
  mkdirSync(path.dirname(resolvedSeedPath), { recursive: true });
  const sourceStat = statSync(resolvedObs01Path);
  if (existsSync(resolvedSeedPath)) {
    try {
      const existing = JSON.parse(readFileSync(resolvedSeedPath, 'utf8')) as {
        readonly schema_version?: number;
        readonly source_obs01_path?: string;
        readonly source_obs01_size_bytes?: number;
        readonly trading_date?: string;
        readonly generated_at_utc?: string;
        readonly bars?: readonly unknown[];
        readonly source_records_scanned?: number;
      };
      if (
        existing.schema_version === LIVE_CAPTURE_MINUTE_BAR_SEED_SCHEMA_VERSION &&
        existing.source_obs01_path === resolvedObs01Path &&
        existing.source_obs01_size_bytes === sourceStat.size &&
        Array.isArray(existing.bars)
      ) {
        const slots = existing.bars
          .map((bar) => typeof bar === 'object' && bar !== null && 'slot' in bar ? Number((bar as { readonly slot: unknown }).slot) : Number.NaN)
          .filter((slot) => Number.isInteger(slot))
          .sort((a, b) => a - b);
        return {
          path: resolvedSeedPath,
          source_obs01_path: resolvedObs01Path,
          source_obs01_size_bytes: sourceStat.size,
          trading_date: String(existing.trading_date ?? parseTradingDateFromCapturePath(resolvedObs01Path) ?? 'unknown'),
          bars_count: existing.bars.length,
          first_slot: slots[0] ?? null,
          last_slot: slots.at(-1) ?? null,
          source_records_scanned: Number(existing.source_records_scanned ?? 0),
          generated_at_utc: String(existing.generated_at_utc ?? 'unknown'),
        };
      }
    } catch {
      // Fall through and rebuild.
    }
  }
  return await buildMinuteBarSeed(resolvedObs01Path, resolvedSeedPath, sourceStat.size);
}

async function buildMinuteBarSeed(
  obs01Path: string,
  seedPath: string,
  sourceSizeBytes: number,
): Promise<MinuteBarSeedSummary> {
  const tradingDate = parseTradingDateFromCapturePath(obs01Path);
  if (tradingDate === null) {
    throw new Error(`could not parse trading date from live capture path: ${obs01Path}`);
  }
  const rthOpenNs = BigInt(Date.parse(`${tradingDate}T13:30:00.000Z`)) * 1_000_000n;
  const oneMinuteNs = 60n * 1_000_000_000n;
  const bars = new Map<number, MutableMinuteBar>();
  let sourceRecordsScanned = 0;
  let remainder = '';
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(obs01Path, {
      encoding: 'utf8',
      highWaterMark: 4 * 1024 * 1024,
      start: 0,
      end: Math.max(0, sourceSizeBytes - 1),
    });
    stream.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const parts = (remainder + text).split(/\r?\n/u);
      remainder = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim() === '') continue;
        sourceRecordsScanned += 1;
        ingestSeedTradeLine(line, rthOpenNs, oneMinuteNs, bars);
      }
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const generatedAt = new Date().toISOString();
  const sortedBars = [...bars.values()].sort((a, b) => a.slot - b.slot);
  const slots = sortedBars.map((bar) => bar.slot);
  const seed = {
    schema_version: LIVE_CAPTURE_MINUTE_BAR_SEED_SCHEMA_VERSION,
    record_type: 'LIVE_CAPTURE_MINUTE_BAR_SEED',
    generated_at_utc: generatedAt,
    source_obs01_path: obs01Path,
    source_obs01_size_bytes: sourceSizeBytes,
    source_records_scanned: sourceRecordsScanned,
    trading_date: tradingDate,
    rth_open_ts_ns: String(rthOpenNs),
    rth_close_ts_ns: String(rthOpenNs + 390n * oneMinuteNs),
    bars: sortedBars,
  };
  writeFileSync(seedPath, stableJson(seed) + '\n', 'utf8');
  return {
    path: seedPath,
    source_obs01_path: obs01Path,
    source_obs01_size_bytes: sourceSizeBytes,
    trading_date: tradingDate,
    bars_count: sortedBars.length,
    first_slot: slots[0] ?? null,
    last_slot: slots.at(-1) ?? null,
    source_records_scanned: sourceRecordsScanned,
    generated_at_utc: generatedAt,
  };
}

function ingestSeedTradeLine(
  line: string,
  rthOpenNs: bigint,
  oneMinuteNs: bigint,
  bars: Map<number, MutableMinuteBar>,
): void {
  const tsNs =
    extractBigintFieldFast(line, 'exchange_event_ts_ns') ??
    extractBigintFieldFast(line, 'sidecar_recv_ts_ns');
  const price = extractNumberFieldFast(line, 'price');
  const quantity = extractNumberFieldFast(line, 'quantity') ?? 1;
  if (tsNs === null || price === null) return;
  const slot = Number((tsNs - rthOpenNs) / oneMinuteNs);
  if (slot < 0 || slot >= 390) return;
  const existing = bars.get(slot);
  if (existing === undefined) {
    const start = rthOpenNs + BigInt(slot) * oneMinuteNs;
    bars.set(slot, {
      slot,
      start_ts_ns: String(start),
      end_ts_ns: String(start + oneMinuteNs),
      open: round4(price),
      high: round4(price),
      low: round4(price),
      close: round4(price),
      volume: round4(quantity),
      trade_count: 1,
    });
  } else {
    existing.high = round4(Math.max(existing.high, price));
    existing.low = round4(Math.min(existing.low, price));
    existing.close = round4(price);
    existing.volume = round4(existing.volume + quantity);
    existing.trade_count += 1;
  }
}

function parseTradingDateFromCapturePath(obs01Path: string): string | null {
  const normalized = obs01Path.replace(/\\/g, '/');
  const match = /\/captures\/(\d{4}-\d{2}-\d{2})\//u.exec(normalized);
  return match?.[1] ?? null;
}

function extractNumberFieldFast(line: string, key: string): number | null {
  const raw = extractRawNumericField(line, key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function extractBigintFieldFast(line: string, key: string): bigint | null {
  const raw = extractRawNumericField(line, key);
  if (raw === null) return null;
  const decimal = raw.indexOf('.');
  return BigInt(decimal === -1 ? raw : raw.slice(0, decimal));
}

function extractRawNumericField(line: string, key: string): string | null {
  const pattern = `"${key}":`;
  const index = line.indexOf(pattern);
  if (index < 0) return null;
  let start = index + pattern.length;
  while (line.charCodeAt(start) === 32) start += 1;
  if (line.charCodeAt(start) === 34) start += 1;
  let end = start;
  while (end < line.length) {
    const code = line.charCodeAt(end);
    if ((code >= 48 && code <= 57) || code === 45 || code === 46) {
      end += 1;
    } else {
      break;
    }
  }
  return end === start ? null : line.slice(start, end);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function markdownReport(report: Record<string, unknown>, boundedJsonl: string, reportJson: string): string {
  const gates = report.gates as readonly GateResult[];
  const rows = gates.map((gate) => `| ${gate.name} | ${gate.passed ? 'PASS' : 'BLOCKED'} | ${stableJson(gate.detail)} |`).join('\n');
  return `# ${TICKET}\n\n` +
    `## Determination\n\n\`\`\`text\n${String(report.determination)}\n\`\`\`\n\n` +
    `## Gates\n\n| Gate | Status | Detail |\n|---|---|---|\n${rows}\n\n` +
    `## Launch command\n\n\`\`\`powershell\n${String(report.command)}\n\`\`\`\n\n` +
    `## Boundary\n\nThis wrapper is paper-mode Rithmic Test only. Capture credentials are not broker fallback. No production account, live trading authority, Phase 6 authority, roster mutation, automatic shutdown flattening, or capture credential mutation is authorized.\n\n` +
    `## Live capture feature bridge contract\n\nThe bridge uses a compact full-session minute-bar seed built from OBS01 before start, uses bounded recent-tail MBP1 quote seeding for operator start speed, and does not replay historical records through strategy runtime. This grants full-session VWAP authority through the seed source offset plus live tail, but does not grant observation-day or order-translation authority.\n\n` +
    `## Output hashes\n\n\`\`\`text\nbounded_jsonl_lf_sha256 = ${sha256Lf(boundedJsonl)}\nreport_json_lf_sha256 = ${sha256Lf(reportJson)}\n\`\`\`\n`;
}

function memo(report: Record<string, unknown>, boundedJsonl: string, reportJson: string, reportMd: string): string {
  return `# ${TICKET}\n\nSTATE: PENDING-REVIEW\n\nDetermination:\n\n\`\`\`text\n${String(report.determination)}\n\`\`\`\n\n` +
    `This implementation adds a dedicated 2026-06-15 RTH paper-trading config and a fail-closed launch wrapper. Default mode is preflight-only; actual paper start requires --start, --duration-ms, RTH unless explicitly allowed, RITHMIC_TEST_* order-placement env, explicit gateway, exactly one allowlisted account, flat-at-start confirmation, account-active confirmation, and a readable live_local_capture_tail OBS source.\n\n` +
    `The live capture feature bridge uses a compact full-session minute-bar seed built from OBS01 before start, uses bounded recent-tail MBP1 quote seeding for operator start speed, and does not replay historical records through strategy runtime. This grants full-session VWAP authority through the seed source offset plus live tail, but does not grant observation-day or order-translation authority.\n\n` +
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
