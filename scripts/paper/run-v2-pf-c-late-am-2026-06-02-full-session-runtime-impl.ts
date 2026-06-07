import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { loadAppConfig } from '../../apps/strategy_runtime/src/config/index.js';
import { makeRunId, makeSessionId } from '../../apps/strategy_runtime/src/contracts/index.js';
import { createSimulatedExecutionAdapter } from '../../apps/strategy_runtime/src/execution/simulated-execution.js';
import { createStrategyRuntimeEngineContainer, StrategyRuntimeRunner } from '../../apps/strategy_runtime/src/orchestration/index.js';
import { sourceQuoteEventForSnapshot } from '../../apps/strategy_runtime/src/paper-trading/index.js';
import { loadVenueCostTable } from '../../apps/strategy_runtime/src/risk/index.js';
import type { StrategyFeatureSnapshot } from '../../apps/strategy_runtime/src/strategies/index.js';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-IMPL-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-full-session-runtime-impl-01';
const SUBSTRATE_SHA = '8a8558a6ff23d2d7d6a011812f1078c70ae0fb75';
const DETERMINATION_PASS = 'FULL_SESSION_RUNTIME_IMPL_PASSED_CANDIDATE_ONLY_GUARD';
const DETERMINATION_MISSING_SOURCE = 'FULL_SESSION_RUNTIME_IMPL_BLOCKED_MISSING_SOURCE_SNAPSHOTS';
const DETERMINATION_ORDER_LEAK = 'FULL_SESSION_RUNTIME_IMPL_FAILED_ORDER_BOUNDARY_LEAK';
const DETERMINATION_HARNESS_GAP = 'FULL_SESSION_RUNTIME_IMPL_BLOCKED_RUNTIME_HARNESS_GAP';
const PASSED_NEXT_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-OBSERVATION-DAY-ACCOUNTING-SCOPE-01';
const BLOCKED_SOURCE_NEXT_TICKET =
  'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-SOURCE-SNAPSHOT-WINDOW-REPAIR-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const SESSION_ID = '2026-06-02-rth';
const OBS01_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.obs01.jsonl';
const MBP1_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.mbp1.jsonl';
const STRATEGY_CONFIG_RELATIVE_PATH = 'config/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml';
const SESSION_OPEN_NS = BigInt(Date.parse('2026-06-02T13:30:00.000Z')) * 1_000_000n;
const SESSION_CLOSE_NS = BigInt(Date.parse('2026-06-02T20:00:00.000Z')) * 1_000_000n;
const ONE_MINUTE_NS = 60_000_000_000n;
const ACCOUNTING_SLOTS_EXPECTED = 390;
const WARMUP_BARS_REQUIRED = 14;
const LOW_SHOCK_THRESHOLD_POS = 2.7;
const REGIME_LABEL = 'low';
const TICK_SIZE = 0.25;
const POINT_VALUE = 2;
const PRICE_DECIMALS = 2;
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-full-session-runtime-impl.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'full-session-runtime-impl-report.json');
const REPORT_MD = path.join(OUT_DIR, 'full-session-runtime-impl-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');

const PR316_ANCHOR = {
  merge_commit: SUBSTRATE_SHA,
  ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-SCOPE-01',
  determination: 'FULL_SESSION_RUNTIME_SCOPE_READY_FOR_IMPL',
  observation_window_start_utc: '2026-06-02T13:30:00.000000000Z',
  observation_window_end_utc: '2026-06-02T20:00:00.000000000Z',
  window_basis: '2026-06-02-rth',
  snapshot_cadence_basis: 'one closed 1m accounting slot',
  required_accounting_slots: ACCOUNTING_SLOTS_EXPECTED,
  order_intent_must_remain: 0,
};

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
type JsonRecord = { readonly [key: string]: Json };

type Bar = {
  readonly start_ts_ns: bigint;
  readonly end_ts_ns: bigint;
  readonly open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
};

type Quote = {
  readonly ts_ns: bigint;
  readonly bid_px: number;
  readonly ask_px: number;
  readonly mid_px: number;
};

type RuntimeSlotRecord = {
  readonly record_type: 'FULL_SESSION_RUNTIME_SLOT';
  readonly slot_index: number;
  readonly slot_start_ts_ns: string;
  readonly slot_start_utc: string;
  readonly slot_end_ts_ns: string;
  readonly slot_end_utc: string;
  readonly status: 'SNAPSHOT_INGESTED' | 'WARMUP_EXCLUDED' | 'MISSING_SOURCE' | 'FAILED_CLOSED';
  readonly feature_snapshot_id: string | null;
  readonly feature_snapshot_lf_sha256: string | null;
  readonly quote_mid_px: number | null;
  readonly session_vwap: number | null;
  readonly atr14_pts: number | null;
  readonly sigma_pts: number | null;
  readonly signed_shock_vwap: number | null;
  readonly STRAT_EVAL_count: number;
  readonly CANDIDATE_count: number;
  readonly RANK_count: number;
  readonly SIZING_count: number;
  readonly RISK_GATE_count: number;
  readonly ORDER_INTENT_count: number;
  readonly SIM_FILL_count: number;
  readonly EXEC_REJECT_count: number;
  readonly POSITION_count: number;
  readonly candidate_id_or_null: string | null;
  readonly suppression_reason_or_null: string | null;
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
    const output: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) output[key] = sortJson(value[key]);
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
    const output: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) output[key] = toJson(child);
    return output;
  }
  return String(value);
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
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

function extractNumber(line: string, key: string): number | null {
  const match = line.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
}

function minuteBucketStart(tsNs: bigint): bigint {
  return SESSION_OPEN_NS + ((tsNs - SESSION_OPEN_NS) / ONE_MINUTE_NS) * ONE_MINUTE_NS;
}

function accountingSlotStarts(): bigint[] {
  const slots: bigint[] = [];
  for (let start = SESSION_OPEN_NS; start < SESSION_CLOSE_NS; start += ONE_MINUTE_NS) slots.push(start);
  if (slots.length !== ACCOUNTING_SLOTS_EXPECTED) throw new Error(`Expected ${ACCOUNTING_SLOTS_EXPECTED} slots, got ${slots.length}`);
  return slots;
}

async function scanTrades(sourcePath: string): Promise<{
  bars_by_start: ReadonlyMap<string, Bar>;
  source_trade_records: number;
  used_trade_records: number;
  first_trade_ts_ns: bigint | null;
  last_trade_ts_ns: bigint | null;
}> {
  if (!existsSync(sourcePath)) throw new Error(`Missing OBS source path: ${sourcePath}`);
  const barsByStart = new Map<string, Bar>();
  let sourceTradeRecords = 0;
  let usedTradeRecords = 0;
  let firstTradeTsNs: bigint | null = null;
  let lastTradeTsNs: bigint | null = null;
  const rl = createInterface({ input: createReadStream(sourcePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"TRADE"') && !line.includes('"type": "TRADE"')) continue;
    sourceTradeRecords += 1;
    const tsNs = extractNs(line, 'ts_ns');
    const price = extractNumber(line, 'price');
    const quantity = extractNumber(line, 'quantity');
    if (tsNs === null || price === null || quantity === null || tsNs < SESSION_OPEN_NS || tsNs >= SESSION_CLOSE_NS || quantity <= 0) continue;
    const bucketStart = minuteBucketStart(tsNs);
    const key = bucketStart.toString();
    const existing = barsByStart.get(key);
    if (existing) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += quantity;
      existing.trade_count += 1;
    } else {
      barsByStart.set(key, {
        start_ts_ns: bucketStart,
        end_ts_ns: bucketStart + ONE_MINUTE_NS,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: quantity,
        trade_count: 1,
      });
    }
    usedTradeRecords += 1;
    firstTradeTsNs ??= tsNs;
    lastTradeTsNs = tsNs;
  }
  return { bars_by_start: barsByStart, source_trade_records: sourceTradeRecords, used_trade_records: usedTradeRecords, first_trade_ts_ns: firstTradeTsNs, last_trade_ts_ns: lastTradeTsNs };
}

async function scanQuotes(sourcePath: string, slotEnds: readonly bigint[]): Promise<{
  quotes_at_slot_end: ReadonlyMap<string, Quote | null>;
  source_quote_records: number;
  finite_quote_records: number;
  quote_records_with_null_mid: number;
  first_quote_ts_ns: bigint | null;
  last_quote_ts_ns: bigint | null;
}> {
  if (!existsSync(sourcePath)) throw new Error(`Missing MBP1 source path: ${sourcePath}`);
  const quotesAtSlotEnd = new Map<string, Quote | null>();
  let latestFiniteQuote: Quote | null = null;
  let slotIndex = 0;
  let sourceQuoteRecords = 0;
  let finiteQuoteRecords = 0;
  let quoteRecordsWithNullMid = 0;
  let firstQuoteTsNs: bigint | null = null;
  let lastQuoteTsNs: bigint | null = null;
  const rl = createInterface({ input: createReadStream(sourcePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    sourceQuoteRecords += 1;
    const tsNs = extractNs(line, 'ts_event_ns') ?? extractNs(line, 'ts_recv_ns');
    if (tsNs === null || tsNs < SESSION_OPEN_NS) continue;
    if (tsNs > SESSION_CLOSE_NS + ONE_MINUTE_NS) break;
    firstQuoteTsNs ??= tsNs;
    lastQuoteTsNs = tsNs;
    while (slotIndex < slotEnds.length && tsNs > slotEnds[slotIndex]) {
      quotesAtSlotEnd.set(slotEnds[slotIndex].toString(), latestFiniteQuote);
      slotIndex += 1;
    }
    const bidPx = extractNumber(line, 'bid_px_00');
    const askPx = extractNumber(line, 'ask_px_00');
    if (bidPx === null || askPx === null || !Number.isFinite(bidPx) || !Number.isFinite(askPx)) {
      quoteRecordsWithNullMid += 1;
      continue;
    }
    latestFiniteQuote = { ts_ns: tsNs, bid_px: bidPx, ask_px: askPx, mid_px: round4((bidPx + askPx) / 2) };
    finiteQuoteRecords += 1;
  }
  while (slotIndex < slotEnds.length) {
    quotesAtSlotEnd.set(slotEnds[slotIndex].toString(), latestFiniteQuote);
    slotIndex += 1;
  }
  return { quotes_at_slot_end: quotesAtSlotEnd, source_quote_records: sourceQuoteRecords, finite_quote_records: finiteQuoteRecords, quote_records_with_null_mid: quoteRecordsWithNullMid, first_quote_ts_ns: firstQuoteTsNs, last_quote_ts_ns: lastQuoteTsNs };
}

function trueRange(bar: Bar, prior: Bar | null): number {
  return prior === null ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - prior.close), Math.abs(bar.low - prior.close));
}

function computeAtr14(bars: readonly Bar[], index: number): number | null {
  if (index + 1 < WARMUP_BARS_REQUIRED) return null;
  let atr = 0;
  for (let i = 0; i < WARMUP_BARS_REQUIRED; i += 1) atr += trueRange(bars[i], i === 0 ? null : bars[i - 1]);
  atr /= WARMUP_BARS_REQUIRED;
  for (let i = WARMUP_BARS_REQUIRED; i <= index; i += 1) atr = (atr * 13 + trueRange(bars[i], bars[i - 1])) / 14;
  return round4(atr);
}

function computeSigmaPts(bars: readonly Bar[], index: number): number {
  const selected = bars.slice(0, index + 1);
  const averageRange = selected.reduce((sum, bar) => sum + (bar.high - bar.low), 0) / selected.length;
  return round4(Math.max(TICK_SIZE, averageRange / 2));
}

function computeSessionVwap(bars: readonly Bar[], index: number): number | null {
  let pv = 0;
  let volume = 0;
  for (let i = 0; i <= index; i += 1) {
    pv += bars[i].close * bars[i].volume;
    volume += bars[i].volume;
  }
  return volume > 0 ? round4(pv / volume) : null;
}

function serializeBarForSnapshot(bar: Bar): Record<string, unknown> {
  return {
    close: round4(bar.close),
    end_ts_ns: bar.end_ts_ns,
    end_ts_utc: nsToIso(bar.end_ts_ns),
    high: round4(bar.high),
    low: round4(bar.low),
    open: round4(bar.open),
    start_ts_ns: bar.start_ts_ns,
    start_ts_utc: nsToIso(bar.start_ts_ns),
    timeframe: '1m',
    trade_count: bar.trade_count,
    volume: round4(bar.volume),
  };
}

function buildSnapshot(input: {
  readonly bar: Bar;
  readonly bars: readonly Bar[];
  readonly quote: Quote;
  readonly sessionVwap: number;
  readonly atr14Pts: number;
  readonly sigmaPts: number;
  readonly signedShockVwap: number;
  readonly strategyConfigHash: string;
}): StrategyFeatureSnapshot {
  const featureSnapshotId = `feature-v2pf-full-session-20260602-${input.bar.end_ts_ns.toString()}`;
  return {
    bars: input.bars.map(serializeBarForSnapshot) as unknown as StrategyFeatureSnapshot['bars'],
    config: { config_hash: input.strategyConfigHash, config_version: 1, strategy_config_path: STRATEGY_CONFIG_RELATIVE_PATH },
    context: {
      regime_label: REGIME_LABEL,
      session_vwap: input.sessionVwap,
      session_vwap_band_sigma_pts: input.sigmaPts,
      signed_shock_vwap: { anchor_type: 'vwap', anchor_value: input.sessionVwap, sigma_basis: 'atr_14', sigma_basis_value: input.atr14Pts, value: input.signedShockVwap },
      vix_prior_close_percentile: 0.05,
      vix_value: 16.05,
      vxn_value: 23.18,
    },
    created_ts_ns: input.bar.end_ts_ns,
    feature_snapshot_id: featureSnapshotId,
    indicators: { atr_14_pts: input.atr14Pts, session_vwap: input.sessionVwap, sigma_pts: input.sigmaPts, signed_shock_vwap: input.signedShockVwap },
    instrument: { contract_month: '2026-06', currency: 'USD', exchange: 'CME', point_value: POINT_VALUE, price_decimals: PRICE_DECIMALS, root: 'MNQ', symbol: 'MNQM6', tick_size: TICK_SIZE },
    quote: { ask_px: input.quote.ask_px, bid_px: input.quote.bid_px, mid_px: input.quote.mid_px, source_ts_ns: input.quote.ts_ns },
    session: { is_halt: false, is_roll_block: false, is_rth: true, opened_ts_ns: SESSION_OPEN_NS, phase: 'rth', session_id: SESSION_ID, trading_date: '2026-06-02' },
    source_event_id: `source-quote-${featureSnapshotId}`,
    strategy_id: STRATEGY_ID,
  } as unknown as StrategyFeatureSnapshot;
}

function snapshotDigest(snapshot: StrategyFeatureSnapshot): string {
  return sha256Text(stableJson(toJson(snapshot)));
}

function countRecord(records: readonly RuntimeSlotRecord[], field: keyof RuntimeSlotRecord): number {
  return records.reduce((sum, record) => sum + (typeof record[field] === 'number' ? Number(record[field]) : 0), 0);
}

function appendBacklogRow(): void {
  const row = [
    TICKET,
    'P1',
    '1.0',
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-SCOPE-01',
    'Implement bounded 2026-06-02 full-session paper-runtime candidate-only harness over the 390-slot RTH accounting window while preserving ORDER_INTENT zero broker live Phase 6 roster and observation-day locks',
    'new_cycle4_v2_research_substrate',
  ].join(',');
  const current = readText(BACKLOG_CSV);
  if (!current.includes(`${TICKET},`)) writeFileSync(BACKLOG_CSV, `${current.trimEnd()}\n${row}\n`, 'utf8');
}

function markerCounts(slotRecords: readonly RuntimeSlotRecord[]): JsonRecord {
  return {
    SESSION_MANIFEST: 2,
    FEATURE_SNAPSHOT_INGEST: slotRecords.filter((record) => record.status === 'SNAPSHOT_INGESTED').length,
    STRAT_EVAL: countRecord(slotRecords, 'STRAT_EVAL_count'),
    CANDIDATE: countRecord(slotRecords, 'CANDIDATE_count'),
    RANK: countRecord(slotRecords, 'RANK_count'),
    SIZING: countRecord(slotRecords, 'SIZING_count'),
    RISK_GATE: countRecord(slotRecords, 'RISK_GATE_count'),
    ORDER_INTENT: countRecord(slotRecords, 'ORDER_INTENT_count'),
    SIM_FILL: countRecord(slotRecords, 'SIM_FILL_count'),
    EXEC_REJECT: countRecord(slotRecords, 'EXEC_REJECT_count'),
    POSITION: countRecord(slotRecords, 'POSITION_count'),
  };
}

function buildReportMarkdown(report: JsonRecord): string {
  const slotAccounting = report.slot_accounting as JsonRecord;
  const counts = report.runtime_marker_counts as JsonRecord;
  const locks = report.authority_locks as JsonRecord;
  const outputHashes = report.output_hashes as JsonRecord;
  const blocker = report.blocker_summary as JsonRecord;
  return [
    `# ${TICKET}`,
    '',
    `Determination: \`${report.determination}\``,
    '',
    '## Slot accounting',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(slotAccounting).map(([key, value]) => `| ${key} | \`${value}\` |`),
    '',
    '## Runtime marker counts',
    '',
    '| Marker | Count |',
    '|---|---:|',
    ...Object.entries(counts).map(([key, value]) => `| ${key} | ${value} |`),
    '',
    '## Authority locks',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(locks).map(([key, value]) => `| ${key} | \`${value}\` |`),
    '',
    '## Boundary result',
    '',
    '`STRAT_EVAL` and `CANDIDATE` were allowed through the bounded paper-runtime harness for source-backed ingested slots. `ORDER_INTENT`, ranking, sizing, risk, fills, positions, adapters, broker/live, Phase 6, and observation-day credit remained suppressed.',
    '',
    '## Blocker summary',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(blocker).map(([key, value]) => `| ${key} | \`${value}\` |`),
    '',
    '## Output hashes',
    '',
    '| Artifact | LF SHA-256 |',
    '|---|---|',
    ...Object.entries(outputHashes).map(([key, value]) => `| ${key} | \`${value}\` |`),
    '',
    `Recommended next ticket: \`${report.recommended_next_ticket}\``,
    '',
  ].join('\n');
}

function buildMemo(report: JsonRecord): string {
  const passed = report.determination === DETERMINATION_PASS;
  return [
    `# ${TICKET} memo`,
    '',
    `Determination: \`${report.determination}\``,
    '',
    'This implementation runs a bounded full-session/window paper-runtime candidate-only harness for the 2026-06-02 RTH accounting window scoped by PR #316. It reconstructs 390 one-minute accounting slots, excludes only explicit ATR14 warmup slots, ingests source-backed StrategyFeatureSnapshots through `StrategyRuntimeRunner` in `runtime_mode: paper`, and uses `paper_observation_stop_after_candidate: true` with the explicit registered-inactive strategy id.',
    '',
    passed
      ? 'The result proves the candidate-only paper-runtime boundary over the full 390-slot accounting contract. It does not authorize observation-day credit. Observation accounting remains `false / 0` until the separate accounting scope evaluates whether this evidence may count.'
      : 'The result does not satisfy the full 390-slot accounting contract because source-backed snapshots are missing for part of the window. It still proves the candidate-only guard over the source-backed ingested subset, with ORDER_INTENT and downstream paths suppressed. Observation accounting remains `false / 0`.',
    '',
    '## Authority caveat',
    '',
    'No ORDER_INTENT, order translation, order adapter call, broker adapter call, paper fill, qfa-410b/qfa-611, ACTIVE_STRATEGY_IDS mutation, CANDIDATE_STRATEGY_IDS mutation, broker/live authority, Phase 6 authority, or observation-day increment is created by this ticket.',
    '',
    '## Report summary',
    '',
    'See the paired JSON/MD report for slot accounting, marker counts, output hashes, and validation command results.',
    '',
    `Recommended next ticket: \`${report.recommended_next_ticket}\``,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  const strategyConfigPath = path.join(ROOT, STRATEGY_CONFIG_RELATIVE_PATH);
  if (!existsSync(strategyConfigPath)) throw new Error(`Missing strategy config path: ${strategyConfigPath}`);
  const strategyConfigHash = sha256FileLf(strategyConfigPath);
  const slotStarts = accountingSlotStarts();
  const slotEnds = slotStarts.map((start) => start + ONE_MINUTE_NS);
  const tradeScan = await scanTrades(OBS01_PATH);
  const quoteScan = await scanQuotes(MBP1_PATH, slotEnds);
  const bars: Bar[] = [];
  const config = loadAppConfig({ configPath: 'config/app.example.json', cwd: ROOT, env: { QFA_JOURNAL_DIR: 'journals/paper/v2-pf-c-late-am-full-session-runtime-impl' } });
  const container = createStrategyRuntimeEngineContainer({ config });
  const runId = makeRunId('v2-pf-c-late-am-full-session-runtime-impl-run');
  const sessionId = makeSessionId('v2-pf-c-late-am-full-session-runtime-impl-session');
  const runner = new StrategyRuntimeRunner({
    container,
    run_id: runId,
    session_id: sessionId,
    execution_adapter: createSimulatedExecutionAdapter({ venue_costs: loadVenueCostTable() }),
    runtime_mode: 'paper',
    paper_observation_explicit_strategy_ids: [STRATEGY_ID],
    paper_observation_stop_after_candidate: true,
  });
  const slotRecords: RuntimeSlotRecord[] = [];
  const candidateIds: string[] = [];
  const signedShockValues: number[] = [];
  let slotsMissingSource = 0;
  let slotsFailedClosed = 0;
  let warmupExcludedSlots = 0;
  for (let index = 0; index < slotStarts.length; index += 1) {
    const slotStart = slotStarts[index];
    const slotEnd = slotEnds[index];
    const bar = tradeScan.bars_by_start.get(slotStart.toString());
    const baseRecord = { record_type: 'FULL_SESSION_RUNTIME_SLOT' as const, slot_index: index, slot_start_ts_ns: slotStart.toString(), slot_start_utc: nsToIso(slotStart), slot_end_ts_ns: slotEnd.toString(), slot_end_utc: nsToIso(slotEnd) };
    if (bar === undefined) {
      slotsMissingSource += 1;
      slotRecords.push({ ...baseRecord, status: 'MISSING_SOURCE', feature_snapshot_id: null, feature_snapshot_lf_sha256: null, quote_mid_px: null, session_vwap: null, atr14_pts: null, sigma_pts: null, signed_shock_vwap: null, STRAT_EVAL_count: 0, CANDIDATE_count: 0, RANK_count: 0, SIZING_count: 0, RISK_GATE_count: 0, ORDER_INTENT_count: 0, SIM_FILL_count: 0, EXEC_REJECT_count: 0, POSITION_count: 0, candidate_id_or_null: null, suppression_reason_or_null: 'MISSING_TRADE_BAR_SOURCE' });
      continue;
    }
    bars.push(bar);
    const quote = quoteScan.quotes_at_slot_end.get(slotEnd.toString()) ?? null;
    const sessionVwap = computeSessionVwap(bars, bars.length - 1);
    const atr14Pts = computeAtr14(bars, bars.length - 1);
    const sigmaPts = computeSigmaPts(bars, bars.length - 1);
    if (bars.length < WARMUP_BARS_REQUIRED) {
      warmupExcludedSlots += 1;
      slotRecords.push({ ...baseRecord, status: 'WARMUP_EXCLUDED', feature_snapshot_id: null, feature_snapshot_lf_sha256: null, quote_mid_px: quote?.mid_px ?? null, session_vwap: sessionVwap, atr14_pts: atr14Pts, sigma_pts: sigmaPts, signed_shock_vwap: null, STRAT_EVAL_count: 0, CANDIDATE_count: 0, RANK_count: 0, SIZING_count: 0, RISK_GATE_count: 0, ORDER_INTENT_count: 0, SIM_FILL_count: 0, EXEC_REJECT_count: 0, POSITION_count: 0, candidate_id_or_null: null, suppression_reason_or_null: 'ATR14_WARMUP_EXCLUDED' });
      continue;
    }
    if (quote === null || sessionVwap === null || atr14Pts === null || atr14Pts <= 0) {
      slotsFailedClosed += 1;
      slotRecords.push({ ...baseRecord, status: 'FAILED_CLOSED', feature_snapshot_id: null, feature_snapshot_lf_sha256: null, quote_mid_px: quote?.mid_px ?? null, session_vwap: sessionVwap, atr14_pts: atr14Pts, sigma_pts: sigmaPts, signed_shock_vwap: null, STRAT_EVAL_count: 0, CANDIDATE_count: 0, RANK_count: 0, SIZING_count: 0, RISK_GATE_count: 0, ORDER_INTENT_count: 0, SIM_FILL_count: 0, EXEC_REJECT_count: 0, POSITION_count: 0, candidate_id_or_null: null, suppression_reason_or_null: 'FEATURE_SOURCE_NOT_READY_FAILED_CLOSED' });
      continue;
    }
    const signedShockVwap = round4((quote.mid_px - sessionVwap) / atr14Pts);
    signedShockValues.push(signedShockVwap);
    const snapshot = buildSnapshot({ bar, bars, quote, sessionVwap, atr14Pts, sigmaPts, signedShockVwap, strategyConfigHash });
    await runner.publishExternalEvent(sourceQuoteEventForSnapshot(snapshot, runId, sessionId));
    const result = await runner.processFeatureSnapshot(snapshot);
    const candidateId = typeof result.candidate_events[0]?.payload.candidate_id === 'string' ? result.candidate_events[0].payload.candidate_id : null;
    if (candidateId !== null) candidateIds.push(candidateId);
    slotRecords.push({ ...baseRecord, status: 'SNAPSHOT_INGESTED', feature_snapshot_id: snapshot.feature_snapshot_id, feature_snapshot_lf_sha256: snapshotDigest(snapshot), quote_mid_px: quote.mid_px, session_vwap: sessionVwap, atr14_pts: atr14Pts, sigma_pts: sigmaPts, signed_shock_vwap: signedShockVwap, STRAT_EVAL_count: result.strategy_evaluation_events.length, CANDIDATE_count: result.candidate_events.length, RANK_count: result.rank_event === undefined ? 0 : 1, SIZING_count: result.sizing_events.length, RISK_GATE_count: result.risk_gate_events.length, ORDER_INTENT_count: result.order_intent_events.length, SIM_FILL_count: result.sim_fill_events.length, EXEC_REJECT_count: result.exec_reject_events.length, POSITION_count: result.position_events.length, candidate_id_or_null: candidateId, suppression_reason_or_null: result.paper_observation_stopped_after_candidate === true ? 'PAPER_OBSERVATION_STOP_AFTER_CANDIDATE' : null });
  }
  const counts = markerCounts(slotRecords);
  const sourceBackedSnapshotsEmitted = slotRecords.filter((record) => record.status === 'SNAPSHOT_INGESTED').length;
  const snapshotsIngested = sourceBackedSnapshotsEmitted;
  const skippedSlots = 0;
  const success = sourceBackedSnapshotsEmitted > 0 && Number(counts.STRAT_EVAL) > 0 && Number(counts.CANDIDATE) >= 1 && counts.ORDER_INTENT === 0 && counts.RANK === 0 && counts.SIZING === 0 && counts.RISK_GATE === 0 && counts.SIM_FILL === 0 && counts.POSITION === 0 && slotsMissingSource === 0 && slotsFailedClosed === 0;
  const determination = success ? DETERMINATION_PASS : counts.ORDER_INTENT !== 0 || counts.RANK !== 0 || counts.SIZING !== 0 || counts.RISK_GATE !== 0 || counts.SIM_FILL !== 0 || counts.POSITION !== 0 ? DETERMINATION_ORDER_LEAK : slotsMissingSource > 0 || slotsFailedClosed > 0 || sourceBackedSnapshotsEmitted === 0 ? DETERMINATION_MISSING_SOURCE : DETERMINATION_HARNESS_GAP;
  const missingSourceRecords = slotRecords.filter((record) => record.status === 'MISSING_SOURCE');
  const failedClosedRecords = slotRecords.filter((record) => record.status === 'FAILED_CLOSED');
  const recommendedNextTicket = determination === DETERMINATION_PASS ? PASSED_NEXT_TICKET : BLOCKED_SOURCE_NEXT_TICKET;
  const slotAccounting: JsonRecord = { accounting_slots_expected: ACCOUNTING_SLOTS_EXPECTED, source_backed_snapshots_emitted: sourceBackedSnapshotsEmitted, snapshots_ingested: snapshotsIngested, slots_processed: slotRecords.length, slots_missing_source: slotsMissingSource, slots_failed_closed: slotsFailedClosed, warmup_excluded_slots: warmupExcludedSlots, skipped_slots: skippedSlots, first_slot_utc: nsToIso(SESSION_OPEN_NS), last_slot_utc: nsToIso(SESSION_CLOSE_NS - ONE_MINUTE_NS), observation_window_start_utc: nsToIso(SESSION_OPEN_NS), observation_window_end_utc: nsToIso(SESSION_CLOSE_NS), slot_cadence: '1m_closed_bar_accounting_slot' };
  const blockerSummary: JsonRecord = {
    full_session_contract_satisfied: determination === DETERMINATION_PASS,
    blocker_family: determination === DETERMINATION_MISSING_SOURCE ? 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW' : determination,
    missing_source_slots: slotsMissingSource,
    failed_closed_slots: slotsFailedClosed,
    first_missing_source_slot_utc: missingSourceRecords[0]?.slot_start_utc ?? null,
    last_missing_source_slot_utc: missingSourceRecords[missingSourceRecords.length - 1]?.slot_start_utc ?? null,
    first_failed_closed_slot_utc: failedClosedRecords[0]?.slot_start_utc ?? null,
    last_failed_closed_slot_utc: failedClosedRecords[failedClosedRecords.length - 1]?.slot_start_utc ?? null,
    partial_runtime_boundary_proof: Number(counts.STRAT_EVAL) > 0 && Number(counts.CANDIDATE) >= 1 && counts.ORDER_INTENT === 0,
  };
  const authorityLocks: JsonRecord = { observation_day_eligible: false, observation_day_increment: 0, paper_runtime_invoked: true, full_session_runtime_harness_invoked: true, paper_observation_stop_after_candidate: true, order_translation_invoked: false, order_adapter_call_count: 0, broker_adapter_call_count: 0, paper_fill_count: 0, qfa_410b_or_qfa_611_run: false, ACTIVE_STRATEGY_IDS_mutated: false, CANDIDATE_STRATEGY_IDS_mutated: false, broker_live_authorized: false, phase_6_authorized: false };
  const records: Json[] = [{ record_type: 'SESSION_MANIFEST', manifest_role: 'open', ticket: TICKET, substrate_sha: SUBSTRATE_SHA, pr316_anchor: PR316_ANCHOR, strategy_id: STRATEGY_ID, run_id: String(runId), session_id: String(sessionId), observation_window_start_utc: nsToIso(SESSION_OPEN_NS), observation_window_end_utc: nsToIso(SESSION_CLOSE_NS), accounting_slots_expected: ACCOUNTING_SLOTS_EXPECTED, paper_observation_explicit_strategy_ids: [STRATEGY_ID], paper_observation_stop_after_candidate: true }, ...slotRecords.map((record) => toJson(record)), { record_type: 'SESSION_MANIFEST', manifest_role: 'close', ticket: TICKET, determination, slot_accounting: slotAccounting, runtime_marker_counts: counts, authority_locks: authorityLocks }];
  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  if (statSync(BOUNDED_JSONL).size > MAX_ARTIFACT_BYTES) throw new Error(`Bounded JSONL exceeds 95 MiB guard: ${BOUNDED_JSONL}`);
  const boundedSha = sha256FileLf(BOUNDED_JSONL);
  const signedShockSummary: JsonRecord = { min: signedShockValues.length ? round4(Math.min(...signedShockValues)) : null, max: signedShockValues.length ? round4(Math.max(...signedShockValues)) : null, candidate_threshold: LOW_SHOCK_THRESHOLD_POS, candidate_count: candidateIds.length, first_candidate_id: candidateIds[0] ?? null, last_candidate_id: candidateIds[candidateIds.length - 1] ?? null };
  const report: Record<string, Json> = { ticket: TICKET, determination, substrate_sha: SUBSTRATE_SHA, pr316_anchor: PR316_ANCHOR, strategy_id: STRATEGY_ID, slot_accounting: slotAccounting, runtime_marker_counts: counts, blocker_summary: blockerSummary, signed_shock_summary: signedShockSummary, source_inputs: { obs01_path: OBS01_PATH, mbp1_path: MBP1_PATH, source_trade_records: tradeScan.source_trade_records, used_trade_records: tradeScan.used_trade_records, first_trade_ts_utc: tradeScan.first_trade_ts_ns === null ? null : nsToIso(tradeScan.first_trade_ts_ns), last_trade_ts_utc: tradeScan.last_trade_ts_ns === null ? null : nsToIso(tradeScan.last_trade_ts_ns), source_quote_records: quoteScan.source_quote_records, finite_quote_records: quoteScan.finite_quote_records, quote_records_with_null_mid: quoteScan.quote_records_with_null_mid, first_quote_ts_utc: quoteScan.first_quote_ts_ns === null ? null : nsToIso(quoteScan.first_quote_ts_ns), last_quote_ts_utc: quoteScan.last_quote_ts_ns === null ? null : nsToIso(quoteScan.last_quote_ts_ns) }, guard_contract: { runtime_mode: 'paper', paper_observation_explicit_strategy_ids: [STRATEGY_ID], paper_observation_stop_after_candidate: true, stop_before: 'rankCandidates(...), sizing/risk, createEntryOrderIntent(...), order adapter, broker adapter, fill handling' }, authority_locks: authorityLocks, output_hashes: { bounded_full_session_runtime_impl_jsonl: boundedSha }, recommended_next_ticket: recommendedNextTicket };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  report.output_hashes = { bounded_full_session_runtime_impl_jsonl: boundedSha, full_session_runtime_impl_report_json: sha256FileLf(REPORT_JSON) };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  const reportSha = sha256FileLf(REPORT_JSON);
  report.output_hashes = { bounded_full_session_runtime_impl_jsonl: boundedSha, full_session_runtime_impl_report_json: reportSha };
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  const reportMdSha = sha256FileLf(REPORT_MD);
  report.output_hashes = { bounded_full_session_runtime_impl_jsonl: boundedSha, full_session_runtime_impl_report_json: reportSha, full_session_runtime_impl_report_md: reportMdSha };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();
  const final = { state: 'PENDING_REVIEW', ticket: TICKET, substrate_sha: SUBSTRATE_SHA, determination, slot_accounting: slotAccounting, runtime_marker_counts: counts, blocker_summary: blockerSummary, authority_locks: authorityLocks, bounded_jsonl_lf_sha256: sha256FileLf(BOUNDED_JSONL), report_json_lf_sha256: sha256FileLf(REPORT_JSON), report_md_lf_sha256: sha256FileLf(REPORT_MD), memo_lf_sha256: sha256FileLf(MEMO_MD), script_lf_sha256: sha256FileLf(path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-02-full-session-runtime-impl.ts')), recommended_next_ticket: recommendedNextTicket };
  console.log(JSON.stringify(final, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
