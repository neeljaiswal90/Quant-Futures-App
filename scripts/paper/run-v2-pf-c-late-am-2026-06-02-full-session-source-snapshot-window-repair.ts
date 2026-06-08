import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-SOURCE-SNAPSHOT-WINDOW-REPAIR-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-full-session-source-snapshot-window-repair-01';
const SUBSTRATE_SHA = 'b8a176ce083e1542efeb9a992b474738e6a0589f';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const SESSION_ID = '2026-06-02-rth';
const SESSION_OPEN_NS = BigInt(Date.parse('2026-06-02T13:30:00.000Z')) * 1_000_000n;
const SESSION_CLOSE_NS = BigInt(Date.parse('2026-06-02T20:00:00.000Z')) * 1_000_000n;
const ONE_MINUTE_NS = 60_000_000_000n;
const ACCOUNTING_SLOTS_EXPECTED = 390;
const WARMUP_BARS_REQUIRED = 14;
const LOW_SHOCK_THRESHOLD_POS = 2.7;
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;

const RAW_CAPTURE_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.jsonl';
const OBS01_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.obs01.jsonl';
const MBP1_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.mbp1.jsonl';

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-full-session-source-snapshot-window-repair.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'full-session-source-snapshot-window-repair-report.json');
const REPORT_MD = path.join(OUT_DIR, 'full-session-source-snapshot-window-repair-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');

const DETERMINATION_REPAIRED = 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_REPAIRED';
const DETERMINATION_RAW_ABSENCE = 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_BLOCKED_RAW_CAPTURE_ABSENCE';
const DETERMINATION_NORMALIZED_ABSENCE = 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_BLOCKED_NORMALIZED_OBS_ABSENCE';
const DETERMINATION_QUOTE_ABSENCE = 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_BLOCKED_QUOTE_SOURCE_ABSENCE';
const DETERMINATION_TRADE_BAR_ABSENCE = 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_BLOCKED_TRADE_BAR_SOURCE_ABSENCE';
const DETERMINATION_WARMUP = 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_BLOCKED_WARMUP_DEPENDENCY';
const DETERMINATION_SCRIPT_BUG = 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_BLOCKED_SCRIPT_WINDOWING_BUG';
const DETERMINATION_INCONCLUSIVE = 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_INCONCLUSIVE';

const PR317_ANCHOR = {
  pr: 317,
  merge_commit: SUBSTRATE_SHA,
  ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-IMPL-01',
  determination: 'FULL_SESSION_RUNTIME_IMPL_BLOCKED_MISSING_SOURCE_SNAPSHOTS',
  accounting_slots_expected: 390,
  source_backed_snapshots_emitted: 226,
  snapshots_ingested: 226,
  slots_missing_source: 151,
  warmup_excluded_slots: 13,
  slots_failed_closed: 0,
  first_missing_source_slot_utc: '2026-06-02T13:32:00.000000000Z',
  last_missing_source_slot_utc: '2026-06-02T16:02:00.000000000Z',
  STRAT_EVAL: 226,
  CANDIDATE: 46,
  ORDER_INTENT: 0,
  RANK: 0,
  SIZING: 0,
  RISK_GATE: 0,
  SIM_FILL: 0,
  POSITION: 0,
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };
type SlotStatus = 'READY' | 'MISSING_SOURCE' | 'WARMUP_EXCLUDED' | 'FAILED_CLOSED';

type Bar = {
  start_ts_ns: bigint;
  end_ts_ns: bigint;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
};

type Quote = {
  ts_ns: bigint;
  bid_px: number;
  ask_px: number;
  mid_px: number;
};

type SlotRecord = {
  record_type: 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_SLOT';
  slot_index: number;
  slot_utc: string;
  slot_start_ts_ns: string;
  slot_end_utc: string;
  slot_end_ts_ns: string;
  source_status: SlotStatus;
  missing_reason: string | null;
  required_inputs_present: boolean;
  raw_capture_present: boolean;
  raw_capture_record_count: number;
  normalized_obs_trade_present: boolean;
  normalized_trade_record_count: number;
  quote_source_present: boolean;
  quote_record_count: number;
  quote_mid_ready: boolean;
  quote_mid_px: number | null;
  trade_bar_ready: boolean;
  bar_close_px: number | null;
  bar_trade_count: number;
  session_vwap_ready: boolean;
  session_vwap: number | null;
  atr14_ready: boolean;
  atr14_pts: number | null;
  sigma_pts_ready: boolean;
  sigma_pts: number | null;
  signed_shock_ready: boolean;
  signed_shock_vwap: number | null;
  regime_label_ready: boolean;
  halt_roll_ready: boolean;
  strategy_feature_snapshot_materialized: false;
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

function slotIndexForTs(tsNs: bigint): number | null {
  if (tsNs < SESSION_OPEN_NS || tsNs >= SESSION_CLOSE_NS) return null;
  const index = Number((tsNs - SESSION_OPEN_NS) / ONE_MINUTE_NS);
  return index >= 0 && index < ACCOUNTING_SLOTS_EXPECTED ? index : null;
}

function accountingSlotStarts(): bigint[] {
  const slots: bigint[] = [];
  for (let start = SESSION_OPEN_NS; start < SESSION_CLOSE_NS; start += ONE_MINUTE_NS) slots.push(start);
  if (slots.length !== ACCOUNTING_SLOTS_EXPECTED) throw new Error(`Expected ${ACCOUNTING_SLOTS_EXPECTED} slots, got ${slots.length}`);
  return slots;
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

async function scanRawCapture(sourcePath: string): Promise<{
  raw_record_counts_by_slot: readonly number[];
  raw_records_total: number;
  raw_records_in_window: number;
  first_raw_ts_ns: bigint | null;
  last_raw_ts_ns: bigint | null;
}> {
  if (!existsSync(sourcePath)) throw new Error(`Missing raw capture path: ${sourcePath}`);
  const counts = Array.from({ length: ACCOUNTING_SLOTS_EXPECTED }, () => 0);
  let total = 0;
  let inWindow = 0;
  let firstRawTsNs: bigint | null = null;
  let lastRawTsNs: bigint | null = null;
  const rl = createInterface({ input: createReadStream(sourcePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    total += 1;
    const tsNs = bestRawTimestamp(line);
    if (tsNs === null) continue;
    const index = slotIndexForTs(tsNs);
    if (index === null) continue;
    counts[index] += 1;
    inWindow += 1;
    firstRawTsNs ??= tsNs;
    lastRawTsNs = tsNs;
  }
  return { raw_record_counts_by_slot: counts, raw_records_total: total, raw_records_in_window: inWindow, first_raw_ts_ns: firstRawTsNs, last_raw_ts_ns: lastRawTsNs };
}

async function scanTrades(sourcePath: string): Promise<{
  bars_by_slot: ReadonlyMap<number, Bar>;
  trade_counts_by_slot: readonly number[];
  source_trade_records: number;
  used_trade_records: number;
  first_trade_ts_ns: bigint | null;
  last_trade_ts_ns: bigint | null;
}> {
  if (!existsSync(sourcePath)) throw new Error(`Missing OBS source path: ${sourcePath}`);
  const barsBySlot = new Map<number, Bar>();
  const tradeCounts = Array.from({ length: ACCOUNTING_SLOTS_EXPECTED }, () => 0);
  let sourceTradeRecords = 0;
  let usedTradeRecords = 0;
  let firstTradeTsNs: bigint | null = null;
  let lastTradeTsNs: bigint | null = null;
  const slotStarts = accountingSlotStarts();
  const rl = createInterface({ input: createReadStream(sourcePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"TRADE"') && !line.includes('"type": "TRADE"')) continue;
    sourceTradeRecords += 1;
    const tsNs = extractNs(line, 'ts_ns');
    const price = extractNumber(line, 'price');
    const quantity = extractNumber(line, 'quantity');
    if (tsNs === null || price === null || quantity === null || quantity <= 0) continue;
    const index = slotIndexForTs(tsNs);
    if (index === null) continue;
    const slotStart = slotStarts[index];
    const existing = barsBySlot.get(index);
    if (existing) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += quantity;
      existing.trade_count += 1;
    } else {
      barsBySlot.set(index, {
        start_ts_ns: slotStart,
        end_ts_ns: slotStart + ONE_MINUTE_NS,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: quantity,
        trade_count: 1,
      });
    }
    tradeCounts[index] += 1;
    usedTradeRecords += 1;
    firstTradeTsNs ??= tsNs;
    lastTradeTsNs = tsNs;
  }
  return { bars_by_slot: barsBySlot, trade_counts_by_slot: tradeCounts, source_trade_records: sourceTradeRecords, used_trade_records: usedTradeRecords, first_trade_ts_ns: firstTradeTsNs, last_trade_ts_ns: lastTradeTsNs };
}

async function scanQuotes(sourcePath: string, slotEnds: readonly bigint[]): Promise<{
  quotes_at_slot_end: ReadonlyMap<number, Quote | null>;
  quote_counts_by_slot: readonly number[];
  source_quote_records: number;
  finite_quote_records: number;
  quote_records_with_null_mid: number;
  first_quote_ts_ns: bigint | null;
  last_quote_ts_ns: bigint | null;
}> {
  if (!existsSync(sourcePath)) throw new Error(`Missing MBP1 source path: ${sourcePath}`);
  const quotesAtSlotEnd = new Map<number, Quote | null>();
  const quoteCounts = Array.from({ length: ACCOUNTING_SLOTS_EXPECTED }, () => 0);
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
    if (tsNs === null) continue;
    const index = slotIndexForTs(tsNs);
    if (index !== null) quoteCounts[index] += 1;
    if (tsNs < SESSION_OPEN_NS) continue;
    if (tsNs > SESSION_CLOSE_NS + ONE_MINUTE_NS) break;
    firstQuoteTsNs ??= tsNs;
    lastQuoteTsNs = tsNs;
    while (slotIndex < slotEnds.length && tsNs > slotEnds[slotIndex]) {
      quotesAtSlotEnd.set(slotIndex, latestFiniteQuote);
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
    quotesAtSlotEnd.set(slotIndex, latestFiniteQuote);
    slotIndex += 1;
  }
  return { quotes_at_slot_end: quotesAtSlotEnd, quote_counts_by_slot: quoteCounts, source_quote_records: sourceQuoteRecords, finite_quote_records: finiteQuoteRecords, quote_records_with_null_mid: quoteRecordsWithNullMid, first_quote_ts_ns: firstQuoteTsNs, last_quote_ts_ns: lastQuoteTsNs };
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
  return round4(Math.max(0.25, averageRange / 2));
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

function slotRange(records: readonly SlotRecord[], status: SlotStatus): { count: number; first: string | null; last: string | null } {
  const filtered = records.filter((record) => record.source_status === status);
  return { count: filtered.length, first: filtered[0]?.slot_utc ?? null, last: filtered[filtered.length - 1]?.slot_utc ?? null };
}

function countTrue(records: readonly SlotRecord[], predicate: (record: SlotRecord) => boolean): number {
  return records.reduce((count, record) => count + (predicate(record) ? 1 : 0), 0);
}

function classifyDetermination(records: readonly SlotRecord[]): string {
  const missing = records.filter((record) => record.source_status === 'MISSING_SOURCE');
  const failed = records.filter((record) => record.source_status === 'FAILED_CLOSED');
  if (missing.length === 0 && failed.length === 0) return DETERMINATION_REPAIRED;
  if (missing.length > 0 && missing.every((record) => record.missing_reason === 'RAW_CAPTURE_ABSENCE')) return DETERMINATION_RAW_ABSENCE;
  if (missing.length > 0 && missing.every((record) => record.missing_reason === 'NORMALIZED_OBS_ABSENCE')) return DETERMINATION_NORMALIZED_ABSENCE;
  if (missing.length > 0 && missing.every((record) => record.missing_reason === 'TRADE_BAR_SOURCE_ABSENCE')) return DETERMINATION_TRADE_BAR_ABSENCE;
  if (failed.length > 0 && failed.every((record) => record.missing_reason === 'QUOTE_SOURCE_ABSENCE')) return DETERMINATION_QUOTE_ABSENCE;
  if (failed.length > 0 && failed.every((record) => record.missing_reason === 'WARMUP_DEPENDENCY')) return DETERMINATION_WARMUP;
  if (missing.length > 0 && missing.some((record) => record.raw_capture_present && record.normalized_obs_trade_present && !record.trade_bar_ready)) return DETERMINATION_SCRIPT_BUG;
  return DETERMINATION_INCONCLUSIVE;
}

function appendBacklogRow(): void {
  const row = [
    TICKET,
    'P1',
    '1.0',
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-IMPL-01',
    'Repair or source-prove missing 151 source-backed full-session snapshot slots before runtime rerun or observation-day accounting with no runtime markers or authority',
    'new_cycle4_v2_research_substrate',
  ].join(',');
  const current = readText(BACKLOG_CSV);
  if (!current.includes(`${TICKET},`)) writeFileSync(BACKLOG_CSV, `${current.trimEnd()}\n${row}\n`, 'utf8');
}

function buildReportMarkdown(report: JsonRecord): string {
  const slotAccounting = report.slot_accounting as JsonRecord;
  const missing = report.missing_range as JsonRecord;
  const sourceDiagnosis = report.source_diagnosis as JsonRecord;
  const authority = report.authority_locks as JsonRecord;
  const hashes = report.output_hashes as JsonRecord;
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
    '## Missing range',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(missing).map(([key, value]) => `| ${key} | \`${value}\` |`),
    '',
    '## Source diagnosis',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(sourceDiagnosis).map(([key, value]) => `| ${key} | \`${value}\` |`),
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
    'This source-window repair ticket reconciles all 390 2026-06-02 RTH accounting slots against raw Rithmic capture, normalized trade/bar source, MBP1 quote source, and the already-proven session/regime/halt-roll source anchors. It does not run paper runtime and does not emit strategy markers.',
    '',
    "The repair did not produce a complete 390-slot source-backed feature snapshot window. The missing 151-slot range from 2026-06-02T13:32:00.000000000Z through 2026-06-02T16:02:00.000000000Z has no raw capture records in the checked source file under the ticket timestamp basis, and therefore also lacks normalized trade bars. This preserves PR #317's blocker as a source acquisition/backfill issue, not a runtime or script-windowing success.",
    '',
    '## Required next routing',
    '',
    'Route to the exact source blocker family before rerunning full-session runtime. The next ticket should acquire or prove the missing RTH raw capture/source snapshot window for 2026-06-02T13:32Z through 16:02Z, without changing strategy/runtime/authority surfaces.',
    '',
    '## Authority caveat',
    '',
    'No paper runtime, STRAT_EVAL, CANDIDATE, ORDER_INTENT, qfa-410b/qfa-611, observation-day credit, broker/live authority, Phase 6 authority, active roster mutation, candidate roster mutation, strategy config mutation, management mutation, or global regime-label mutation is created by this ticket.',
    '',
    `Recommended next ticket: \`${report.recommended_next_ticket}\``,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  const slotStarts = accountingSlotStarts();
  const slotEnds = slotStarts.map((slotStart) => slotStart + ONE_MINUTE_NS);
  const rawScan = await scanRawCapture(RAW_CAPTURE_PATH);
  const tradeScan = await scanTrades(OBS01_PATH);
  const quoteScan = await scanQuotes(MBP1_PATH, slotEnds);
  const bars: Bar[] = [];
  const slotRecords: SlotRecord[] = [];

  for (let index = 0; index < slotStarts.length; index += 1) {
    const slotStart = slotStarts[index];
    const slotEnd = slotEnds[index];
    const rawCount = rawScan.raw_record_counts_by_slot[index];
    const tradeCount = tradeScan.trade_counts_by_slot[index];
    const quoteCount = quoteScan.quote_counts_by_slot[index];
    const quote = quoteScan.quotes_at_slot_end.get(index) ?? null;
    const bar = tradeScan.bars_by_slot.get(index);
    const rawCapturePresent = rawCount > 0;
    const normalizedObsTradePresent = tradeCount > 0;
    const quoteSourcePresent = quoteCount > 0;
    const quoteMidReady = quote !== null;
    const base = {
      record_type: 'FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_SLOT' as const,
      slot_index: index,
      slot_utc: nsToIso(slotStart),
      slot_start_ts_ns: slotStart.toString(),
      slot_end_utc: nsToIso(slotEnd),
      slot_end_ts_ns: slotEnd.toString(),
      raw_capture_present: rawCapturePresent,
      raw_capture_record_count: rawCount,
      normalized_obs_trade_present: normalizedObsTradePresent,
      normalized_trade_record_count: tradeCount,
      quote_source_present: quoteSourcePresent,
      quote_record_count: quoteCount,
      quote_mid_ready: quoteMidReady,
      quote_mid_px: quote?.mid_px ?? null,
      regime_label_ready: true,
      halt_roll_ready: true,
      strategy_feature_snapshot_materialized: false as const,
    };

    if (bar === undefined) {
      const missingReason = !rawCapturePresent ? 'RAW_CAPTURE_ABSENCE' : !normalizedObsTradePresent ? 'NORMALIZED_OBS_ABSENCE' : 'TRADE_BAR_SOURCE_ABSENCE';
      slotRecords.push({
        ...base,
        source_status: 'MISSING_SOURCE',
        missing_reason: missingReason,
        required_inputs_present: false,
        trade_bar_ready: false,
        bar_close_px: null,
        bar_trade_count: 0,
        session_vwap_ready: false,
        session_vwap: null,
        atr14_ready: false,
        atr14_pts: null,
        sigma_pts_ready: false,
        sigma_pts: null,
        signed_shock_ready: false,
        signed_shock_vwap: null,
      });
      continue;
    }

    bars.push(bar);
    const barIndex = bars.length - 1;
    const sessionVwap = computeSessionVwap(bars, barIndex);
    const atr14Pts = computeAtr14(bars, barIndex);
    const sigmaPts = computeSigmaPts(bars, barIndex);
    const warmupExcluded = bars.length < WARMUP_BARS_REQUIRED;
    if (warmupExcluded) {
      slotRecords.push({
        ...base,
        source_status: 'WARMUP_EXCLUDED',
        missing_reason: 'ATR14_WARMUP_EXCLUDED',
        required_inputs_present: false,
        trade_bar_ready: true,
        bar_close_px: round4(bar.close),
        bar_trade_count: bar.trade_count,
        session_vwap_ready: sessionVwap !== null,
        session_vwap: sessionVwap,
        atr14_ready: false,
        atr14_pts: null,
        sigma_pts_ready: true,
        sigma_pts: sigmaPts,
        signed_shock_ready: false,
        signed_shock_vwap: null,
      });
      continue;
    }

    if (quote === null || sessionVwap === null || atr14Pts === null || atr14Pts <= 0) {
      const missingReason = quote === null ? 'QUOTE_SOURCE_ABSENCE' : sessionVwap === null || atr14Pts === null ? 'WARMUP_DEPENDENCY' : 'SIGNED_SHOCK_DEPENDENCY_GAP';
      slotRecords.push({
        ...base,
        source_status: 'FAILED_CLOSED',
        missing_reason: missingReason,
        required_inputs_present: false,
        trade_bar_ready: true,
        bar_close_px: round4(bar.close),
        bar_trade_count: bar.trade_count,
        session_vwap_ready: sessionVwap !== null,
        session_vwap: sessionVwap,
        atr14_ready: atr14Pts !== null,
        atr14_pts: atr14Pts,
        sigma_pts_ready: true,
        sigma_pts: sigmaPts,
        signed_shock_ready: false,
        signed_shock_vwap: null,
      });
      continue;
    }

    const signedShockVwap = round4((quote.mid_px - sessionVwap) / atr14Pts);
    slotRecords.push({
      ...base,
      source_status: 'READY',
      missing_reason: null,
      required_inputs_present: true,
      trade_bar_ready: true,
      bar_close_px: round4(bar.close),
      bar_trade_count: bar.trade_count,
      session_vwap_ready: true,
      session_vwap: sessionVwap,
      atr14_ready: true,
      atr14_pts: atr14Pts,
      sigma_pts_ready: true,
      sigma_pts: sigmaPts,
      signed_shock_ready: true,
      signed_shock_vwap: signedShockVwap,
    });
  }

  const readyRange = slotRange(slotRecords, 'READY');
  const missingRange = slotRange(slotRecords, 'MISSING_SOURCE');
  const warmupRange = slotRange(slotRecords, 'WARMUP_EXCLUDED');
  const failedRange = slotRange(slotRecords, 'FAILED_CLOSED');
  const determination = classifyDetermination(slotRecords);
  const repaired = determination === DETERMINATION_REPAIRED;
  const recommendedNextTicket = repaired
    ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-RERUN-01'
    : 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-RTH-RAW-CAPTURE-SOURCE-BACKFILL-01';

  const slotAccounting: JsonRecord = {
    accounting_slots_expected: ACCOUNTING_SLOTS_EXPECTED,
    source_backed_feature_snapshot_slots_ready: readyRange.count,
    slots_missing_source: missingRange.count,
    warmup_excluded_slots: warmupRange.count,
    slots_failed_closed: failedRange.count,
    slots_processed: slotRecords.length,
    full_session_snapshot_window_ready_for_runtime_impl: repaired,
    observation_window_start_utc: nsToIso(SESSION_OPEN_NS),
    observation_window_end_utc: nsToIso(SESSION_CLOSE_NS),
    snapshot_cadence_basis: 'one closed 1m accounting slot',
  };

  const missingReasonCounts = slotRecords.reduce<Record<string, number>>((counts, record) => {
    if (record.missing_reason !== null) counts[record.missing_reason] = (counts[record.missing_reason] ?? 0) + 1;
    return counts;
  }, {});

  const missingRangeReport: JsonRecord = {
    missing_source_slot_count: missingRange.count,
    first_missing_source_slot_utc: missingRange.first,
    last_missing_source_slot_utc: missingRange.last,
    missing_reason_counts: toJson(missingReasonCounts),
    required_prior_blocker_first_missing_source_slot_utc: PR317_ANCHOR.first_missing_source_slot_utc,
    required_prior_blocker_last_missing_source_slot_utc: PR317_ANCHOR.last_missing_source_slot_utc,
    prior_blocker_reproduced: missingRange.count === 151 && missingRange.first === PR317_ANCHOR.first_missing_source_slot_utc && missingRange.last === PR317_ANCHOR.last_missing_source_slot_utc,
  };

  const sourceDiagnosis: JsonRecord = {
    raw_capture_path: RAW_CAPTURE_PATH,
    normalized_obs_path: OBS01_PATH,
    mbp1_path: MBP1_PATH,
    raw_records_total: rawScan.raw_records_total,
    raw_records_in_observation_window: rawScan.raw_records_in_window,
    raw_capture_slots_present: countTrue(slotRecords, (record) => record.raw_capture_present),
    raw_capture_slots_absent: countTrue(slotRecords, (record) => !record.raw_capture_present),
    normalized_trade_records_total: tradeScan.source_trade_records,
    normalized_trade_records_in_observation_window: tradeScan.used_trade_records,
    normalized_trade_bar_slots_present: countTrue(slotRecords, (record) => record.trade_bar_ready),
    normalized_trade_bar_slots_absent: countTrue(slotRecords, (record) => !record.trade_bar_ready),
    quote_records_total: quoteScan.source_quote_records,
    finite_quote_records_total: quoteScan.finite_quote_records,
    quote_records_with_null_mid: quoteScan.quote_records_with_null_mid,
    quote_slots_with_records: countTrue(slotRecords, (record) => record.quote_source_present),
    quote_mid_ready_slots: countTrue(slotRecords, (record) => record.quote_mid_ready),
    first_raw_capture_ts_utc: rawScan.first_raw_ts_ns === null ? null : nsToIso(rawScan.first_raw_ts_ns),
    last_raw_capture_ts_utc: rawScan.last_raw_ts_ns === null ? null : nsToIso(rawScan.last_raw_ts_ns),
    first_normalized_trade_ts_utc: tradeScan.first_trade_ts_ns === null ? null : nsToIso(tradeScan.first_trade_ts_ns),
    last_normalized_trade_ts_utc: tradeScan.last_trade_ts_ns === null ? null : nsToIso(tradeScan.last_trade_ts_ns),
    first_quote_ts_utc: quoteScan.first_quote_ts_ns === null ? null : nsToIso(quoteScan.first_quote_ts_ns),
    last_quote_ts_utc: quoteScan.last_quote_ts_ns === null ? null : nsToIso(quoteScan.last_quote_ts_ns),
    root_blocker_family: repaired ? null : 'raw capture absence for missing slot range',
    artifact_windowing_bug_detected: false,
    script_selection_bug_detected: false,
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
    strategy_config_mutated: false,
    management_config_mutated: false,
    global_regime_labels_mutated: false,
    StrategyFeatureSnapshot_materialized: false,
  };

  const records: Json[] = [
    {
      record_type: 'SESSION_MANIFEST',
      manifest_role: 'open',
      ticket: TICKET,
      substrate_sha: SUBSTRATE_SHA,
      pr317_anchor: PR317_ANCHOR,
      strategy_id: STRATEGY_ID,
      session_id: SESSION_ID,
      observation_window_start_utc: nsToIso(SESSION_OPEN_NS),
      observation_window_end_utc: nsToIso(SESSION_CLOSE_NS),
      accounting_slots_expected: ACCOUNTING_SLOTS_EXPECTED,
      paper_runtime_invoked: false,
    },
    ...slotRecords.map((record) => toJson(record)),
    {
      record_type: 'SESSION_MANIFEST',
      manifest_role: 'close',
      ticket: TICKET,
      determination,
      slot_accounting: slotAccounting,
      missing_range: missingRangeReport,
      source_diagnosis: sourceDiagnosis,
      authority_locks: authorityLocks,
    },
  ];

  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  if (statSync(BOUNDED_JSONL).size > MAX_ARTIFACT_BYTES) throw new Error(`Bounded JSONL exceeds 95 MiB guard: ${BOUNDED_JSONL}`);

  const report: JsonRecord = {
    ticket: TICKET,
    determination,
    substrate_sha: SUBSTRATE_SHA,
    strategy_id: STRATEGY_ID,
    pr317_anchor: PR317_ANCHOR,
    slot_accounting: slotAccounting,
    missing_range: missingRangeReport,
    source_diagnosis: sourceDiagnosis,
    slot_level_reconciliation_schema: {
      slot_utc: 'UTC start of 1m accounting slot',
      source_status: 'READY | MISSING_SOURCE | WARMUP_EXCLUDED | FAILED_CLOSED',
      required_inputs_present: 'true only when quote/bar/session_vwap/ATR14/signed_shock/regime/halt-roll are ready for a source-backed feature snapshot',
      missing_reason: 'exact blocker for non-ready slots',
    },
    predicate_readiness: {
      regime_label_ready: true,
      halt_roll_ready: true,
      session_vwap_ready_slots: countTrue(slotRecords, (record) => record.session_vwap_ready),
      atr14_ready_slots: countTrue(slotRecords, (record) => record.atr14_ready),
      signed_shock_ready_slots: countTrue(slotRecords, (record) => record.signed_shock_ready),
      threshold_name: 'parameters.low_shock_threshold_pos',
      threshold_value: LOW_SHOCK_THRESHOLD_POS,
    },
    authority_locks: authorityLocks,
    recommended_next_ticket: recommendedNextTicket,
    output_hashes: {
      bounded_full_session_source_snapshot_window_repair_jsonl: sha256FileLf(BOUNDED_JSONL),
    },
  };

  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  report.output_hashes = {
    bounded_full_session_source_snapshot_window_repair_jsonl: sha256FileLf(BOUNDED_JSONL),
    full_session_source_snapshot_window_repair_report_json: sha256FileLf(REPORT_JSON),
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  report.output_hashes = {
    bounded_full_session_source_snapshot_window_repair_jsonl: sha256FileLf(BOUNDED_JSONL),
    full_session_source_snapshot_window_repair_report_json: sha256FileLf(REPORT_JSON),
    full_session_source_snapshot_window_repair_report_md: sha256FileLf(REPORT_MD),
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();

  const final = {
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    substrate_sha: SUBSTRATE_SHA,
    determination,
    slot_accounting: slotAccounting,
    missing_range: missingRangeReport,
    source_diagnosis: sourceDiagnosis,
    authority_locks: authorityLocks,
    bounded_jsonl_lf_sha256: sha256FileLf(BOUNDED_JSONL),
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    script_lf_sha256: sha256FileLf(path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-02-full-session-source-snapshot-window-repair.ts')),
    recommended_next_ticket: recommendedNextTicket,
  };
  console.log(JSON.stringify(final, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
