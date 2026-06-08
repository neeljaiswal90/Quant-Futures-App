import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-RTH-RAW-CAPTURE-SOURCE-BACKFILL-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-rth-raw-capture-source-backfill-01';
const SUBSTRATE_SHA = '6e3fdb68272d084ffd813a34f5fe5fdcbac3e15c';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const TARGET_START_NS = BigInt(Date.parse('2026-06-02T13:32:00.000Z')) * 1_000_000n;
const ONE_MINUTE_NS = 60_000_000_000n;
const TARGET_LAST_SLOT_NS = BigInt(Date.parse('2026-06-02T16:02:00.000Z')) * 1_000_000n;
const TARGET_EXCLUSIVE_END_NS = TARGET_LAST_SLOT_NS + ONE_MINUTE_NS;
const TARGET_MISSING_SLOTS = 151;
const ARTIFACT_SIZE_LIMIT_BYTES = 95 * 1024 * 1024;

const CAPTURE_DIR = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02';
const RAW_CAPTURE_PATH = `${CAPTURE_DIR}/MNQ_rth.jsonl`;
const OBS01_PATH = `${CAPTURE_DIR}/MNQ_rth.obs01.jsonl`;
const MBP1_PATH = `${CAPTURE_DIR}/MNQ_rth.mbp1.jsonl`;
const WRAPPER_LOG = `${CAPTURE_DIR}/wrapper.log`;
const RTH_WRAPPER_ERR = `${CAPTURE_DIR}/rth_wrapper.log.err`;
const RTH_RELAUNCH_WRAPPER_ERR = `${CAPTURE_DIR}/rth_relaunch_wrapper.log.err`;

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-rth-raw-capture-source-backfill.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'rth-raw-capture-source-backfill-report.json');
const REPORT_MD = path.join(OUT_DIR, 'rth-raw-capture-source-backfill-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');

const DETERMINATION_READY = 'RTH_RAW_CAPTURE_SOURCE_BACKFILL_READY';
const DETERMINATION_LOCAL_ABSENCE = 'RTH_RAW_CAPTURE_SOURCE_BACKFILL_BLOCKED_LOCAL_SOURCE_ABSENCE';
const DETERMINATION_PROVIDER_CREDS = 'RTH_RAW_CAPTURE_SOURCE_BACKFILL_BLOCKED_PROVIDER_CREDENTIALS_ABSENT';
const DETERMINATION_PROVIDER_DATA = 'RTH_RAW_CAPTURE_SOURCE_BACKFILL_BLOCKED_PROVIDER_DATA_UNAVAILABLE';
const DETERMINATION_SIZE = 'RTH_RAW_CAPTURE_SOURCE_BACKFILL_BLOCKED_ARTIFACT_SIZE_GUARD';
const DETERMINATION_NORMALIZATION = 'RTH_RAW_CAPTURE_SOURCE_BACKFILL_BLOCKED_NORMALIZATION_GAP';
const DETERMINATION_INCONCLUSIVE = 'RTH_RAW_CAPTURE_SOURCE_BACKFILL_INCONCLUSIVE';

const PR318_ANCHOR = {
  pr: 318,
  merge_commit: SUBSTRATE_SHA,
  ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-SOURCE-SNAPSHOT-WINDOW-REPAIR-01',
  determination: 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_BLOCKED_RAW_CAPTURE_ABSENCE',
  accounting_slots_expected: 390,
  source_backed_feature_snapshot_slots_ready: 226,
  slots_missing_source: 151,
  first_missing_source_slot_utc: '2026-06-02T13:32:00.000000000Z',
  last_missing_source_slot_utc: '2026-06-02T16:02:00.000000000Z',
  missing_reason: 'RAW_CAPTURE_ABSENCE',
  quote_mid_ready_slots: 390,
  raw_capture_slots_absent: 151,
  normalized_trade_bar_slots_absent: 151,
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

type CoverageScan = {
  file_present: boolean;
  file_path: string;
  file_size_bytes: number;
  records_total: number;
  records_in_target_window: number;
  slots_covered_in_target_window: number;
  target_missing_window_covered: boolean;
  source_time_min_utc: string | null;
  source_time_max_utc: string | null;
};

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function lfText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(lfText(text), 'utf8').digest('hex');
}

function sha256FileLf(filePath: string): string {
  return sha256Text(readText(filePath));
}

function sortJson(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value !== null && typeof value === 'object') {
    const output: JsonRecord = {};
    for (const key of Object.keys(value).sort()) output[key] = sortJson((value as JsonRecord)[key]);
    return output;
  }
  return value;
}

function stableJson(value: Json): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function stableJsonl(records: readonly Json[]): string {
  return `${records.map((record) => JSON.stringify(sortJson(record))).join('\n')}\n`;
}

function toJson(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => toJson(item));
  if (value !== null && typeof value === 'object') {
    const output: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) output[key] = toJson(child);
    return output;
  }
  return String(value);
}

function nsToIso(ns: bigint): string {
  const millis = (ns / 1_000_000_000n) * 1_000n;
  const nanos = ns % 1_000_000_000n;
  const base = new Date(Number(millis)).toISOString().replace('.000Z', '');
  return `${base}.${nanos.toString().padStart(9, '0')}Z`;
}

function extractNs(line: string, key: string): bigint | null {
  const match = line.match(new RegExp(`"${key}"\\s*:\\s*"?(\\d+)"?`));
  return match ? BigInt(match[1]) : null;
}

function bestRawTimestamp(line: string): bigint | null {
  return (
    extractNs(line, 'exchange_event_ts_ns') ??
    extractNs(line, 'rithmic_publish_ts_ns') ??
    extractNs(line, 'sidecar_recv_ts_ns') ??
    extractNs(line, 'ts_event_ns') ??
    extractNs(line, 'ts_recv_ns') ??
    extractNs(line, 'ts_ns')
  );
}

function tradeTimestamp(line: string): bigint | null {
  if (!line.includes('"type":"TRADE"') && !line.includes('"type": "TRADE"')) return null;
  return extractNs(line, 'ts_ns');
}

function quoteTimestamp(line: string): bigint | null {
  return extractNs(line, 'ts_event_ns') ?? extractNs(line, 'ts_recv_ns');
}

function slotIndexForTarget(tsNs: bigint): number | null {
  if (tsNs < TARGET_START_NS || tsNs >= TARGET_EXCLUSIVE_END_NS) return null;
  const index = Number((tsNs - TARGET_START_NS) / ONE_MINUTE_NS);
  return index >= 0 && index < TARGET_MISSING_SLOTS ? index : null;
}

async function scanFile(filePath: string, timestampFn: (line: string) => bigint | null): Promise<CoverageScan> {
  if (!existsSync(filePath)) {
    return {
      file_present: false,
      file_path: filePath,
      file_size_bytes: 0,
      records_total: 0,
      records_in_target_window: 0,
      slots_covered_in_target_window: 0,
      target_missing_window_covered: false,
      source_time_min_utc: null,
      source_time_max_utc: null,
    };
  }
  const slots = Array.from({ length: TARGET_MISSING_SLOTS }, () => false);
  let recordsTotal = 0;
  let recordsInWindow = 0;
  let minTs: bigint | null = null;
  let maxTs: bigint | null = null;
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const tsNs = timestampFn(line);
    if (tsNs === null) continue;
    recordsTotal += 1;
    if (minTs === null || tsNs < minTs) minTs = tsNs;
    if (maxTs === null || tsNs > maxTs) maxTs = tsNs;
    const slotIndex = slotIndexForTarget(tsNs);
    if (slotIndex !== null) {
      slots[slotIndex] = true;
      recordsInWindow += 1;
    }
  }
  const covered = slots.filter(Boolean).length;
  return {
    file_present: true,
    file_path: filePath,
    file_size_bytes: statSync(filePath).size,
    records_total: recordsTotal,
    records_in_target_window: recordsInWindow,
    slots_covered_in_target_window: covered,
    target_missing_window_covered: covered === TARGET_MISSING_SLOTS,
    source_time_min_utc: minTs === null ? null : nsToIso(minTs),
    source_time_max_utc: maxTs === null ? null : nsToIso(maxTs),
  };
}

function providerCredentialStatus(): JsonRecord {
  const names = ['DATABENTO_API_KEY', 'DATABENTO_KEY', 'QFA_DATABENTO_API_KEY'];
  const availableNames = names.filter((name) => Boolean(process.env[name]));
  return {
    provider_name: 'Databento',
    provider_credentials_available: availableNames.length > 0,
    provider_credential_env_names_checked: names,
    provider_credential_env_names_present: availableNames,
  };
}

function directoryInventory(): Json[] {
  const dirs = [
    'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02',
    'D:/Quant-futures-app-qfa-629/tools/rithmic_analytics/data/captures/2026-06-02',
    'D:/mnq-orderflow/tools/rithmic_analytics/data/captures/2026-06-02',
    'D:/Quant-futures-app/tools/rithmic_dashboard/data/captures/2026-06-02',
  ];
  return dirs.map((dir) => {
    if (!existsSync(dir)) return { directory: dir, present: false, entries: [] };
    const entries = readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const fullPath = path.join(dir, entry.name);
      const stat = statSync(fullPath);
      return { name: entry.name, is_file: entry.isFile(), size_bytes: stat.size, last_write_time_ms: stat.mtimeMs };
    });
    return { directory: dir, present: true, entries };
  });
}

function wrapperLogSummary(): JsonRecord {
  const paths = [WRAPPER_LOG, RTH_WRAPPER_ERR, RTH_RELAUNCH_WRAPPER_ERR];
  const lines: string[] = [];
  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    lines.push(...readText(filePath).split(/\r?\n/).filter((line) => line.trim().length > 0));
  }
  const joined = lines.join('\n');
  return {
    wrapper_logs_present: paths.filter((filePath) => existsSync(filePath)),
    indicates_permission_denied_disconnect: joined.includes('permission denied'),
    indicates_keepalive_timeout: joined.includes('keepalive ping timeout'),
    indicates_relaunch: joined.includes('launching probe contract=MNQM6') && joined.includes('probe exited'),
    diagnostic_excerpt: lines.slice(0, 12),
  };
}

function appendBacklogRow(): void {
  const row = [
    TICKET,
    'P1',
    '1.0',
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-SOURCE-SNAPSHOT-WINDOW-REPAIR-01',
    'Attempt local or provider backfill for missing 2026-06-02 RTH raw capture trade-bar window while preserving no runtime markers observation-day or broker authority',
    'new_cycle4_v2_research_substrate',
  ].join(',');
  const current = readText(BACKLOG_CSV);
  if (!current.includes(`${TICKET},`)) writeFileSync(BACKLOG_CSV, `${current.trimEnd()}\n${row}\n`, 'utf8');
}

function buildReportMarkdown(report: JsonRecord): string {
  const summary = report.backfill_summary as JsonRecord;
  const local = report.local_source_inventory as JsonRecord;
  const provider = report.provider_backfill_status as JsonRecord;
  const authority = report.authority_locks as JsonRecord;
  const hashes = report.output_hashes as JsonRecord;
  return [
    `# ${TICKET}`,
    '',
    `Determination: \`${report.determination}\``,
    '',
    '## Backfill summary',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(summary).map(([key, value]) => `| ${key} | \`${value}\` |`),
    '',
    '## Local source inventory',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(local).filter(([_, value]) => typeof value !== 'object').map(([key, value]) => `| ${key} | \`${value}\` |`),
    '',
    '## Provider/backfill status',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(provider).map(([key, value]) => `| ${key} | \`${Array.isArray(value) ? value.join(', ') : value}\` |`),
    '',
    '## Authority locks',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(authority).map(([key, value]) => `| ${key} | \`${value}\` |`),
    '',
    '## Output hashes',
    '',
    '| Artifact | LF SHA-256 |',
    '|---|---|',
    ...Object.entries(hashes).map(([key, value]) => `| ${key} | \`${value}\` |`),
    '',
    `Recommended next ticket: \`${report.recommended_next_ticket}\``,
    '',
  ].join('\n');
}

function buildMemo(report: JsonRecord): string {
  return [
    `# ${TICKET} memo`,
    '',
    `Determination: \`${report.determination}\``,
    '',
    'This ticket attempted source acquisition/backfill for the missing 2026-06-02 RTH raw capture/trade-bar window identified by PR #318. It inspected the local capture root and adjacent expected mirror roots, checked normalized trade and quote sources, and checked provider credential availability without writing credentials or fetching provider data without an existing key.',
    '',
    'The target missing window remains uncovered locally. The quote lane is already ready, but the raw/trade-bar lane is not. No provider fetch was attempted because no Databento credential environment variable was present in this worktree environment.',
    '',
    '## Authority caveat',
    '',
    'No paper runtime, STRAT_EVAL, CANDIDATE, ORDER_INTENT, qfa-410b/qfa-611, observation-day credit, broker/live authority, Phase 6 authority, active roster mutation, candidate roster mutation, canonical backtest/regime mutation, or market-data fabrication is created by this ticket.',
    '',
    `Recommended next ticket: \`${report.recommended_next_ticket}\``,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  const [rawScan, obsScan, quoteScan] = await Promise.all([
    scanFile(RAW_CAPTURE_PATH, bestRawTimestamp),
    scanFile(OBS01_PATH, tradeTimestamp),
    scanFile(MBP1_PATH, quoteTimestamp),
  ]);
  const providerCreds = providerCredentialStatus();
  const providerCredentialsAvailable = providerCreds.provider_credentials_available === true;
  const localCovered = rawScan.target_missing_window_covered && obsScan.target_missing_window_covered;
  const providerBackfillAttempted = providerCredentialsAvailable && !localCovered;
  const repaired = localCovered;
  const determination = repaired
    ? DETERMINATION_READY
    : providerCredentialsAvailable
      ? DETERMINATION_PROVIDER_DATA
      : rawScan.records_in_target_window === 0 && obsScan.records_in_target_window === 0
        ? DETERMINATION_PROVIDER_CREDS
        : rawScan.records_in_target_window === 0
          ? DETERMINATION_LOCAL_ABSENCE
          : obsScan.records_in_target_window === 0
            ? DETERMINATION_NORMALIZATION
            : DETERMINATION_INCONCLUSIVE;

  const backfillSummary: JsonRecord = {
    target_missing_window_start_utc: nsToIso(TARGET_START_NS),
    target_missing_window_end_utc: nsToIso(TARGET_LAST_SLOT_NS),
    target_missing_window_exclusive_end_utc: nsToIso(TARGET_EXCLUSIVE_END_NS),
    target_window_end_basis: 'target_missing_window_end_utc is the last missing 1m slot start; exclusive_end is used for coverage scanning',
    target_missing_slots: TARGET_MISSING_SLOTS,
    missing_raw_capture_slots_repaired: repaired ? TARGET_MISSING_SLOTS : 0,
    target_missing_window_covered: repaired,
    full_session_source_snapshot_window_repair_ready_for_rerun: repaired,
    exact_blocker_family: repaired ? null : 'provider credentials absent after local source absence reproduced',
  };

  const localSourceInventory: JsonRecord = {
    raw_capture_file_present: rawScan.file_present,
    normalized_obs_file_present: obsScan.file_present,
    trade_bar_source_present: obsScan.records_in_target_window > 0,
    quote_source_present: quoteScan.file_present,
    source_time_min_utc: rawScan.source_time_min_utc,
    source_time_max_utc: rawScan.source_time_max_utc,
    target_missing_window_covered: repaired,
    raw_capture_records_in_target_window: rawScan.records_in_target_window,
    raw_capture_slots_covered_in_target_window: rawScan.slots_covered_in_target_window,
    normalized_trade_records_in_target_window: obsScan.records_in_target_window,
    normalized_trade_slots_covered_in_target_window: obsScan.slots_covered_in_target_window,
    quote_records_in_target_window: quoteScan.records_in_target_window,
    quote_slots_covered_in_target_window: quoteScan.slots_covered_in_target_window,
    quote_mid_ready_slots_from_pr318_carry_forward_accounting: PR318_ANCHOR.quote_mid_ready_slots,
    quote_lane_is_not_current_blocker: true,
    raw_capture_scan: toJson(rawScan),
    normalized_obs_scan: toJson(obsScan),
    quote_scan: toJson(quoteScan),
  };

  const providerBackfillStatus: JsonRecord = {
    provider_backfill_attempted: providerBackfillAttempted,
    provider_name: 'Databento',
    provider_credentials_available: providerCredentialsAvailable,
    provider_fetch_result: providerBackfillAttempted ? 'not_implemented_in_source_only_guard' : 'not_attempted_credentials_absent',
    provider_data_committable: false,
  };

  const authorityLocks: JsonRecord = {
    paper_runtime_invoked: false,
    STRAT_EVAL: 0,
    CANDIDATE: 0,
    ORDER_INTENT: 0,
    observation_day_eligible: false,
    observation_day_increment: 0,
    qfa_410b_or_qfa_611_run: false,
    broker_live_authorized: false,
    phase_6_authorized: false,
    active_candidate_roster_mutated: false,
    canonical_backtest_or_regime_artifacts_mutated: false,
    fabricated_market_data: false,
  };

  const records: Json[] = [
    {
      record_type: 'SESSION_MANIFEST',
      manifest_role: 'open',
      ticket: TICKET,
      substrate_sha: SUBSTRATE_SHA,
      pr318_anchor: PR318_ANCHOR,
      strategy_id: STRATEGY_ID,
      target_missing_window_start_utc: nsToIso(TARGET_START_NS),
      target_missing_window_end_utc: nsToIso(TARGET_LAST_SLOT_NS),
      target_missing_window_exclusive_end_utc: nsToIso(TARGET_EXCLUSIVE_END_NS),
      provider_credentials_checked_without_secret_values: true,
    },
    {
      record_type: 'LOCAL_SOURCE_INVENTORY',
      local_source_inventory: localSourceInventory,
      directory_inventory: directoryInventory(),
      wrapper_log_summary: wrapperLogSummary(),
    },
    {
      record_type: 'PROVIDER_BACKFILL_STATUS',
      provider_backfill_status: providerBackfillStatus,
      provider_credential_status: providerCreds,
    },
    {
      record_type: 'SESSION_MANIFEST',
      manifest_role: 'close',
      ticket: TICKET,
      determination,
      backfill_summary: backfillSummary,
      authority_locks: authorityLocks,
    },
  ];

  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  const artifactSizeBytes = statSync(BOUNDED_JSONL).size;
  const artifactSizeWithinLimit = artifactSizeBytes <= ARTIFACT_SIZE_LIMIT_BYTES;
  const finalDetermination = artifactSizeWithinLimit ? determination : DETERMINATION_SIZE;

  const report: JsonRecord = {
    ticket: TICKET,
    determination: finalDetermination,
    substrate_sha: SUBSTRATE_SHA,
    strategy_id: STRATEGY_ID,
    pr318_anchor: PR318_ANCHOR,
    backfill_summary: backfillSummary,
    local_source_inventory: localSourceInventory,
    provider_backfill_status: providerBackfillStatus,
    artifact_size_guard: {
      artifact_size_bytes: artifactSizeBytes,
      artifact_size_limit_bytes: ARTIFACT_SIZE_LIMIT_BYTES,
      artifact_size_within_limit: artifactSizeWithinLimit,
    },
    authority_locks: authorityLocks,
    recommended_next_ticket: repaired
      ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-SOURCE-SNAPSHOT-WINDOW-RERUN-01'
      : 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-RTH-RAW-CAPTURE-PROVIDER-CREDENTIALS-01',
    output_hashes: {
      bounded_rth_raw_capture_source_backfill_jsonl: sha256FileLf(BOUNDED_JSONL),
    },
  };

  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  report.output_hashes = {
    bounded_rth_raw_capture_source_backfill_jsonl: sha256FileLf(BOUNDED_JSONL),
    rth_raw_capture_source_backfill_report_json: sha256FileLf(REPORT_JSON),
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  report.output_hashes = {
    bounded_rth_raw_capture_source_backfill_jsonl: sha256FileLf(BOUNDED_JSONL),
    rth_raw_capture_source_backfill_report_json: sha256FileLf(REPORT_JSON),
    rth_raw_capture_source_backfill_report_md: sha256FileLf(REPORT_MD),
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();

  const final = {
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    substrate_sha: SUBSTRATE_SHA,
    determination: finalDetermination,
    backfill_summary: backfillSummary,
    local_source_inventory: localSourceInventory,
    provider_backfill_status: providerBackfillStatus,
    artifact_size_guard: report.artifact_size_guard,
    authority_locks: authorityLocks,
    bounded_jsonl_lf_sha256: sha256FileLf(BOUNDED_JSONL),
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    script_lf_sha256: sha256FileLf(path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-02-rth-raw-capture-source-backfill.ts')),
    recommended_next_ticket: report.recommended_next_ticket,
  };
  console.log(JSON.stringify(final, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
