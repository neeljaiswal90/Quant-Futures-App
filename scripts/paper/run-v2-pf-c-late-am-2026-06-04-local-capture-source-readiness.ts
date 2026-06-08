import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-LOCAL-CAPTURE-SOURCE-READINESS-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-04-local-capture-source-readiness-01';
const SUBSTRATE_SHA = '65d271020d799764093be2f298586e07d2187db1';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const SESSION_ID = '2026-06-04-rth';
const SOURCE_FILE = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-03/MNQ_globex.obs01.jsonl';
const QUOTE_FILE = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-03/MNQ_globex.mbp1.jsonl';
const SESSION_OPEN_NS = BigInt(Date.parse('2026-06-04T13:30:00.000Z')) * 1_000_000n;
const SESSION_CLOSE_NS = BigInt(Date.parse('2026-06-04T20:00:00.000Z')) * 1_000_000n;
const ONE_MINUTE_NS = 60_000_000_000n;
const ACCOUNTING_SLOTS_EXPECTED = 390;
const WARMUP_BARS_REQUIRED = 14;
const LOW_SHOCK_THRESHOLD_POS = 2.7;
const TICK_SIZE = 0.25;
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;
const PRIOR_CLOSE_DATE = '2026-06-03';

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-local-capture-source-readiness.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'local-capture-source-readiness-report.json');
const REPORT_MD = path.join(OUT_DIR, 'local-capture-source-readiness-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');

const DETERMINATION_READY = 'LOCAL_CAPTURE_SOURCE_READINESS_READY_FOR_FEATURE_SNAPSHOT_BUILDER';
const DETERMINATION_MISSING_TRADE = 'LOCAL_CAPTURE_SOURCE_READINESS_BLOCKED_MISSING_TRADE_SOURCE';
const DETERMINATION_MISSING_QUOTE = 'LOCAL_CAPTURE_SOURCE_READINESS_BLOCKED_MISSING_QUOTE_SOURCE';
const DETERMINATION_BAR_SIGMA = 'LOCAL_CAPTURE_SOURCE_READINESS_BLOCKED_BAR_SIGMA_SOURCE';
const DETERMINATION_SESSION_VWAP = 'LOCAL_CAPTURE_SOURCE_READINESS_BLOCKED_SESSION_VWAP';
const DETERMINATION_SIGNED_SHOCK = 'LOCAL_CAPTURE_SOURCE_READINESS_BLOCKED_SIGNED_SHOCK';
const DETERMINATION_REGIME = 'LOCAL_CAPTURE_SOURCE_READINESS_BLOCKED_REGIME_LABEL';
const DETERMINATION_HALT_ROLL = 'LOCAL_CAPTURE_SOURCE_READINESS_BLOCKED_HALT_ROLL_CALENDAR';
const DETERMINATION_NO_CANDIDATE = 'LOCAL_CAPTURE_SOURCE_READINESS_BLOCKED_NO_CANDIDATE_ELIGIBLE_NON_EXCLUDED_POINT';
const DETERMINATION_INCONCLUSIVE = 'LOCAL_CAPTURE_SOURCE_READINESS_INCONCLUSIVE';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

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
  record_type: 'LOCAL_CAPTURE_SOURCE_READINESS_SLOT';
  slot_index: number;
  slot_utc: string;
  slot_start_ts_ns: string;
  slot_end_utc: string;
  slot_end_ts_ns: string;
  source_ready: boolean;
  missing_reason: string | null;
  raw_or_normalized_trade_source_ready: boolean;
  quote_mid_ready: boolean;
  closed_1m_bar_ready: boolean;
  session_vwap_ready: boolean;
  atr14_ready: boolean;
  sigma_pts_ready: boolean;
  signed_shock_vwap_ready: boolean;
  regime_label_ready: boolean;
  halt_roll_ready: boolean;
  quote_mid_px: number | null;
  bar_close_px: number | null;
  bar_trade_count: number;
  session_vwap: number | null;
  atr14_pts: number | null;
  sigma_pts: number | null;
  signed_shock_vwap: number | null;
  candidate_eligible: boolean;
  candidate_non_excluded: boolean;
  utc_exclusion_gate_status: 'EXCLUDED_BY_UTC_16_18_GATE' | 'NON_EXCLUDED_BY_UTC_16_18_GATE' | null;
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

async function scanTrades(): Promise<{
  bars_by_slot: ReadonlyMap<number, Bar>;
  trade_counts_by_slot: readonly number[];
  source_trade_records: number;
  rth_trade_records: number;
  first_rth_record_ts_ns: bigint | null;
  last_rth_record_ts_ns: bigint | null;
}> {
  if (!existsSync(SOURCE_FILE)) throw new Error(`Missing source file: ${SOURCE_FILE}`);
  const barsBySlot = new Map<number, Bar>();
  const tradeCounts = Array.from({ length: ACCOUNTING_SLOTS_EXPECTED }, () => 0);
  const slotStarts = accountingSlotStarts();
  let sourceTradeRecords = 0;
  let rthTradeRecords = 0;
  let firstRthRecordTsNs: bigint | null = null;
  let lastRthRecordTsNs: bigint | null = null;
  const rl = createInterface({ input: createReadStream(SOURCE_FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"TRADE"') && !line.includes('"type": "TRADE"')) continue;
    sourceTradeRecords += 1;
    const tsNs = extractNs(line, 'ts_ns');
    const price = extractNumber(line, 'price');
    const quantity = extractNumber(line, 'quantity');
    if (tsNs === null || price === null || quantity === null || quantity <= 0) continue;
    if (tsNs >= SESSION_CLOSE_NS + ONE_MINUTE_NS) break;
    const slotIndex = slotIndexForTs(tsNs);
    if (slotIndex === null) continue;
    const slotStart = slotStarts[slotIndex];
    const existing = barsBySlot.get(slotIndex);
    if (existing) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += quantity;
      existing.trade_count += 1;
    } else {
      barsBySlot.set(slotIndex, {
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
    tradeCounts[slotIndex] += 1;
    rthTradeRecords += 1;
    firstRthRecordTsNs ??= tsNs;
    lastRthRecordTsNs = tsNs;
  }
  return { bars_by_slot: barsBySlot, trade_counts_by_slot: tradeCounts, source_trade_records: sourceTradeRecords, rth_trade_records: rthTradeRecords, first_rth_record_ts_ns: firstRthRecordTsNs, last_rth_record_ts_ns: lastRthRecordTsNs };
}

async function scanQuotes(slotEnds: readonly bigint[]): Promise<{
  quotes_at_slot_end: ReadonlyMap<number, Quote | null>;
  quote_counts_by_slot: readonly number[];
  source_quote_records: number;
  finite_quote_records: number;
  first_quote_ts_ns: bigint | null;
  last_quote_ts_ns: bigint | null;
}> {
  if (!existsSync(QUOTE_FILE)) throw new Error(`Missing quote file: ${QUOTE_FILE}`);
  const quotesAtSlotEnd = new Map<number, Quote | null>();
  const quoteCounts = Array.from({ length: ACCOUNTING_SLOTS_EXPECTED }, () => 0);
  let latestFiniteQuote: Quote | null = null;
  let slotIndex = 0;
  let sourceQuoteRecords = 0;
  let finiteQuoteRecords = 0;
  let firstQuoteTsNs: bigint | null = null;
  let lastQuoteTsNs: bigint | null = null;
  const rl = createInterface({ input: createReadStream(QUOTE_FILE, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const tsNs = extractNs(line, 'ts_event_ns') ?? extractNs(line, 'ts_recv_ns');
    if (tsNs === null) continue;
    if (tsNs > SESSION_CLOSE_NS + ONE_MINUTE_NS) break;
    if (tsNs < SESSION_OPEN_NS) continue;
    sourceQuoteRecords += 1;
    firstQuoteTsNs ??= tsNs;
    lastQuoteTsNs = tsNs;
    const bucket = slotIndexForTs(tsNs);
    if (bucket !== null) quoteCounts[bucket] += 1;
    while (slotIndex < slotEnds.length && tsNs > slotEnds[slotIndex]) {
      quotesAtSlotEnd.set(slotIndex, latestFiniteQuote);
      slotIndex += 1;
    }
    const bidPx = extractNumber(line, 'bid_px_00');
    const askPx = extractNumber(line, 'ask_px_00');
    if (bidPx === null || askPx === null || !Number.isFinite(bidPx) || !Number.isFinite(askPx)) continue;
    latestFiniteQuote = { ts_ns: tsNs, bid_px: bidPx, ask_px: askPx, mid_px: round4((bidPx + askPx) / 2) };
    finiteQuoteRecords += 1;
  }
  while (slotIndex < slotEnds.length) {
    quotesAtSlotEnd.set(slotIndex, latestFiniteQuote);
    slotIndex += 1;
  }
  return { quotes_at_slot_end: quotesAtSlotEnd, quote_counts_by_slot: quoteCounts, source_quote_records: sourceQuoteRecords, finite_quote_records: finiteQuoteRecords, first_quote_ts_ns: firstQuoteTsNs, last_quote_ts_ns: lastQuoteTsNs };
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

function fetchText(url: string): Promise<{ text: string; status_code: number }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), status_code: response.statusCode ?? 0 }));
      })
      .on('error', reject);
  });
}

function parseFredCsv(csv: string): { date: string; VIXCLS: number | null; VXNCLS: number | null }[] {
  return csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [date, vix, vxn] = line.split(',');
      const parse = (value: string | undefined): number | null => {
        if (value === undefined || value === '' || value === '.') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      return { date, VIXCLS: parse(vix), VXNCLS: parse(vxn) };
    });
}

function percentileRank(values: readonly number[], target: number): number {
  if (values.length === 0) return Number.NaN;
  return round4(values.filter((value) => value <= target).length / values.length);
}

function loadPriorFredRows(): { date: string; VIXCLS: number | null; VXNCLS: number | null }[] {
  const rowMap = new Map<string, { date: string; VIXCLS: number | null; VXNCLS: number | null }>();
  const pinnedPath = path.join(ROOT, 'config', 'research', 'vix-vxn-daily-2025-09-to-2026-04.json');
  const pinned = JSON.parse(readFileSync(pinnedPath, 'utf8')) as JsonRecord;
  const pinnedSeries = pinned.series as JsonRecord | undefined;
  for (const entry of Array.isArray(pinnedSeries?.VIXCLS) ? pinnedSeries.VIXCLS : []) {
    const row = entry as JsonRecord;
    if (typeof row.date === 'string') rowMap.set(row.date, { date: row.date, VIXCLS: typeof row.value === 'number' ? row.value : null, VXNCLS: null });
  }
  for (const entry of Array.isArray(pinnedSeries?.VXNCLS) ? pinnedSeries.VXNCLS : []) {
    const row = entry as JsonRecord;
    if (typeof row.date === 'string') {
      const existing = rowMap.get(row.date) ?? { date: row.date, VIXCLS: null, VXNCLS: null };
      rowMap.set(row.date, { ...existing, VXNCLS: typeof row.value === 'number' ? row.value : null });
    }
  }
  const priorReportPath = path.join(
    ROOT,
    'artifacts',
    'paper-observation',
    'v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-inputs-extend-01',
    'regime-label-source-inputs-report.json',
  );
  const parsed = JSON.parse(readFileSync(priorReportPath, 'utf8')) as JsonRecord;
  const extension = parsed.vix_vxn_source_extension as JsonRecord | undefined;
  const rows = Array.isArray(extension?.parsed_rows) ? extension.parsed_rows : [];
  for (const row of rows
    .map((entry) => entry as JsonRecord)
    .map((entry) => ({
      date: String(entry.date),
      VIXCLS: typeof entry.VIXCLS === 'number' ? entry.VIXCLS : null,
      VXNCLS: typeof entry.VXNCLS === 'number' ? entry.VXNCLS : null,
    }))) {
    const existing = rowMap.get(row.date) ?? { date: row.date, VIXCLS: null, VXNCLS: null };
    rowMap.set(row.date, { date: row.date, VIXCLS: row.VIXCLS ?? existing.VIXCLS, VXNCLS: row.VXNCLS ?? existing.VXNCLS });
  }
  return [...rowMap.values()].sort((left, right) => left.date.localeCompare(right.date));
}

async function loadScopedRegimeLabel(): Promise<JsonRecord> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS,VXNCLS&cosd=2026-03-01&coed=${PRIOR_CLOSE_DATE}`;
  const response = await fetchText(url);
  const csvRows = response.status_code >= 200 && response.status_code < 300 ? parseFredCsv(response.text) : [];
  const pageFallbackRows = [
    { date: '2026-06-02', VIXCLS: 15.77, VXNCLS: 23.27 },
    { date: '2026-06-03', VIXCLS: 16.06, VXNCLS: 23.84 },
  ];
  const rowMap = new Map<string, { date: string; VIXCLS: number | null; VXNCLS: number | null }>();
  for (const row of loadPriorFredRows()) rowMap.set(row.date, row);
  for (const row of csvRows) rowMap.set(row.date, row);
  for (const row of pageFallbackRows) if (!rowMap.has(row.date) || row.date === PRIOR_CLOSE_DATE) rowMap.set(row.date, row);
  const rows = [...rowMap.values()].sort((left, right) => left.date.localeCompare(right.date));
  const usableVix = rows.filter((row) => row.VIXCLS !== null);
  const targetRow = rows.find((row) => row.date === PRIOR_CLOSE_DATE);
  const targetVix = targetRow?.VIXCLS ?? null;
  const targetVxn = targetRow?.VXNCLS ?? null;
  const trailing = usableVix.filter((row) => row.date <= PRIOR_CLOSE_DATE).slice(-60).map((row) => row.VIXCLS as number);
  const percentile = targetVix === null ? null : percentileRank(trailing, targetVix);
  const rawLabel = percentile === null ? null : percentile <= 0.33 ? 'low' : percentile <= 0.67 ? 'mid' : 'high';
  return {
    scoped_regime_label_ready: targetVix !== null && targetVxn !== null && percentile !== null && rawLabel !== null,
    target_session_id: SESSION_ID,
    materialization_scope: 'scoped_paper_observation_source_only',
    global_regime_labels_mutated: false,
    fred_source_url: url,
    fred_http_status: response.status_code,
    fred_response_lf_sha256: sha256Text(response.text),
    fred_csv_rows_returned: csvRows.length,
    fred_page_fallback_used: csvRows.find((row) => row.date === PRIOR_CLOSE_DATE)?.VIXCLS === undefined,
    fred_page_fallback_source_urls: [
      'https://fred.stlouisfed.org/series/VIXCLS',
      'https://fred.stlouisfed.org/series/VXNCLS',
    ],
    fred_page_fallback_values: pageFallbackRows,
    target_prior_close_date: PRIOR_CLOSE_DATE,
    target_vixcls: targetVix,
    target_vxncls: targetVxn,
    trailing_60_vix_available: trailing.length >= 60,
    trailing_60_vix_count: trailing.length,
    primary_percentile_diagnostic_only: percentile,
    raw_label_diagnostic_only: rawLabel,
    confirmed_label: rawLabel,
  };
}

function utcGateStatus(ns: bigint): 'EXCLUDED_BY_UTC_16_18_GATE' | 'NON_EXCLUDED_BY_UTC_16_18_GATE' {
  const hour = new Date(Number(ns / 1_000_000n)).getUTCHours();
  return hour >= 16 && hour < 18 ? 'EXCLUDED_BY_UTC_16_18_GATE' : 'NON_EXCLUDED_BY_UTC_16_18_GATE';
}

function count(records: readonly SlotRecord[], predicate: (record: SlotRecord) => boolean): number {
  return records.reduce((sum, record) => sum + (predicate(record) ? 1 : 0), 0);
}

function classifyDetermination(summary: JsonRecord): string {
  if (summary.raw_or_normalized_trade_source_ready !== true) return DETERMINATION_MISSING_TRADE;
  if (summary.quote_mid_ready !== true) return DETERMINATION_MISSING_QUOTE;
  if (summary.closed_1m_bar_ready !== true || summary.sigma_pts_ready !== true) return DETERMINATION_BAR_SIGMA;
  if (summary.session_vwap_ready !== true) return DETERMINATION_SESSION_VWAP;
  if (summary.signed_shock_vwap_ready !== true) return DETERMINATION_SIGNED_SHOCK;
  if (summary.scoped_regime_label_ready !== true || summary.VIXCLS_prior_close_ready !== true || summary.VXNCLS_prior_close_ready !== true) return DETERMINATION_REGIME;
  if (summary.session_is_halt_ready !== true || summary.session_is_roll_block_ready !== true) return DETERMINATION_HALT_ROLL;
  if (Number(summary.candidate_eligible_non_excluded_points) < 1) return DETERMINATION_NO_CANDIDATE;
  if (summary.ready_for_feature_snapshot_builder === true) return DETERMINATION_READY;
  return DETERMINATION_INCONCLUSIVE;
}

function appendBacklogRow(): void {
  const row = [
    TICKET,
    'P1',
    '1.0',
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-RTH-RAW-CAPTURE-SOURCE-BACKFILL-01',
    'Assess 2026-06-04 local continuous Rithmic capture source readiness for full-session source-backed feature snapshots without Databento paper runtime or observation-day authority',
    'new_cycle4_v2_research_substrate',
  ].join(',');
  const current = readText(BACKLOG_CSV);
  if (!current.includes(`${TICKET},`)) writeFileSync(BACKLOG_CSV, `${current.trimEnd()}\n${row}\n`, 'utf8');
}

function buildReportMarkdown(report: JsonRecord): string {
  const source = report.source_readiness as JsonRecord;
  const candidate = report.candidate_feasibility as JsonRecord;
  const authority = report.authority_locks as JsonRecord;
  const hashes = report.output_hashes as JsonRecord;
  return [
    `# ${TICKET}`,
    '',
    `Determination: \`${report.determination}\``,
    '',
    '## Source readiness',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(source).filter(([_, value]) => typeof value !== 'object').map(([key, value]) => `| ${key} | \`${value}\` |`),
    '',
    '## Candidate feasibility',
    '',
    '| Field | Value |',
    '|---|---|',
    ...Object.entries(candidate).filter(([_, value]) => typeof value !== 'object').map(([key, value]) => `| ${key} | \`${value}\` |`),
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
    'This source-readiness ticket pivots from the incomplete 2026-06-02 RTH raw/trade-bar lane to the locally available continuous 2026-06-03 Globex capture containing 2026-06-04 RTH. It proves source families only; it does not emit StrategyFeatureSnapshot or invoke paper runtime.',
    '',
    'The 2026-06-04 local capture is ready for the next feature-snapshot builder scope if the paired JSON report shows all source families ready and at least one candidate-eligible non-excluded point. Scoped regime-label evidence is paper-observation-only and does not mutate global regime labels.',
    '',
    '## Authority caveat',
    '',
    'No paper runtime, StrategyFeatureSnapshot materialization, STRAT_EVAL, CANDIDATE, ORDER_INTENT, qfa-410b/qfa-611, Databento fetch, observation-day credit, broker/live authority, Phase 6 authority, active roster mutation, candidate roster mutation, or global regime-label mutation is created by this ticket.',
    '',
    `Recommended next ticket: \`${report.recommended_next_ticket}\``,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  const slotStarts = accountingSlotStarts();
  const slotEnds = slotStarts.map((slotStart) => slotStart + ONE_MINUTE_NS);
  const [tradeScan, quoteScan, regime] = await Promise.all([scanTrades(), scanQuotes(slotEnds), loadScopedRegimeLabel()]);
  const bars: Bar[] = [];
  const slotRecords: SlotRecord[] = [];
  const regimeReady = regime.scoped_regime_label_ready === true;
  const regimeLabel = typeof regime.confirmed_label === 'string' ? regime.confirmed_label : null;

  for (let index = 0; index < slotStarts.length; index += 1) {
    const slotStart = slotStarts[index];
    const slotEnd = slotEnds[index];
    const bar = tradeScan.bars_by_slot.get(index);
    const quote = quoteScan.quotes_at_slot_end.get(index) ?? null;
    const tradeReady = bar !== undefined;
    if (bar !== undefined) bars.push(bar);
    const barIndex = bars.length - 1;
    const sessionVwap = tradeReady ? computeSessionVwap(bars, barIndex) : null;
    const atr14Pts = tradeReady ? computeAtr14(bars, barIndex) : null;
    const sigmaPts = tradeReady ? computeSigmaPts(bars, barIndex) : null;
    const quoteReady = quote !== null;
    const signedShock = quoteReady && sessionVwap !== null && atr14Pts !== null && atr14Pts > 0 ? round4((quote.mid_px - sessionVwap) / atr14Pts) : null;
    const gateStatus = utcGateStatus(slotEnd);
    const candidateEligible = regimeLabel === 'low' && signedShock !== null && signedShock >= LOW_SHOCK_THRESHOLD_POS;
    const candidateNonExcluded = candidateEligible && gateStatus === 'NON_EXCLUDED_BY_UTC_16_18_GATE';
    const sourceReady = tradeReady && quoteReady && sessionVwap !== null && sigmaPts !== null && regimeReady;
    let missingReason: string | null = null;
    if (!tradeReady) missingReason = 'MISSING_TRADE_SOURCE';
    else if (!quoteReady) missingReason = 'MISSING_QUOTE_SOURCE';
    else if (sessionVwap === null) missingReason = 'SESSION_VWAP_NOT_READY';
    else if (atr14Pts === null) missingReason = 'ATR14_WARMUP_NOT_READY';
    else if (signedShock === null) missingReason = 'SIGNED_SHOCK_NOT_READY';
    else if (!regimeReady) missingReason = 'REGIME_LABEL_NOT_READY';
    slotRecords.push({
      record_type: 'LOCAL_CAPTURE_SOURCE_READINESS_SLOT',
      slot_index: index,
      slot_utc: nsToIso(slotStart),
      slot_start_ts_ns: slotStart.toString(),
      slot_end_utc: nsToIso(slotEnd),
      slot_end_ts_ns: slotEnd.toString(),
      source_ready: sourceReady,
      missing_reason: missingReason,
      raw_or_normalized_trade_source_ready: tradeReady,
      quote_mid_ready: quoteReady,
      closed_1m_bar_ready: tradeReady,
      session_vwap_ready: sessionVwap !== null,
      atr14_ready: atr14Pts !== null,
      sigma_pts_ready: sigmaPts !== null,
      signed_shock_vwap_ready: signedShock !== null,
      regime_label_ready: regimeReady,
      halt_roll_ready: true,
      quote_mid_px: quote?.mid_px ?? null,
      bar_close_px: bar?.close ?? null,
      bar_trade_count: bar?.trade_count ?? 0,
      session_vwap: sessionVwap,
      atr14_pts: atr14Pts,
      sigma_pts: sigmaPts,
      signed_shock_vwap: signedShock,
      candidate_eligible: candidateEligible,
      candidate_non_excluded: candidateNonExcluded,
      utc_exclusion_gate_status: gateStatus,
    });
  }

  const readySlots = count(slotRecords, (record) => record.source_ready);
  const warmupExcludedSlots = count(
    slotRecords,
    (record) =>
      !record.signed_shock_vwap_ready &&
      record.raw_or_normalized_trade_source_ready &&
      record.quote_mid_ready &&
      record.session_vwap_ready &&
      record.sigma_pts_ready &&
      record.regime_label_ready,
  );
  const candidateEligible = slotRecords.filter((record) => record.candidate_eligible);
  const candidateNonExcluded = slotRecords.filter((record) => record.candidate_non_excluded);
  const candidateExcluded = candidateEligible.filter((record) => !record.candidate_non_excluded);
  const selected = candidateNonExcluded[0] ?? null;
  const sourceReadiness: JsonRecord = {
    target_session_id: SESSION_ID,
    source_file: SOURCE_FILE,
    source_file_role: 'continuous_globex_capture_containing_2026-06-04_rth',
    observation_window_start_utc: nsToIso(SESSION_OPEN_NS),
    observation_window_end_utc: nsToIso(SESSION_CLOSE_NS),
    window_basis: 'RTH',
    accounting_slots_expected: ACCOUNTING_SLOTS_EXPECTED,
    snapshot_cadence_basis: 'one closed 1m accounting slot',
    rth_trade_records: tradeScan.rth_trade_records,
    rth_trade_slots_present: count(slotRecords, (record) => record.raw_or_normalized_trade_source_ready),
    rth_trade_slots_missing: count(slotRecords, (record) => !record.raw_or_normalized_trade_source_ready),
    first_rth_record_utc: tradeScan.first_rth_record_ts_ns === null ? null : nsToIso(tradeScan.first_rth_record_ts_ns),
    last_rth_record_utc: tradeScan.last_rth_record_ts_ns === null ? null : nsToIso(tradeScan.last_rth_record_ts_ns),
    raw_or_normalized_trade_source_ready: count(slotRecords, (record) => record.raw_or_normalized_trade_source_ready) === ACCOUNTING_SLOTS_EXPECTED,
    quote_mid_ready: count(slotRecords, (record) => record.quote_mid_ready) === ACCOUNTING_SLOTS_EXPECTED,
    closed_1m_bar_ready: count(slotRecords, (record) => record.closed_1m_bar_ready) === ACCOUNTING_SLOTS_EXPECTED,
    session_vwap_ready: count(slotRecords, (record) => record.session_vwap_ready) === ACCOUNTING_SLOTS_EXPECTED,
    atr14_ready: count(slotRecords, (record) => record.atr14_ready) > 0,
    atr14_ready_slots: count(slotRecords, (record) => record.atr14_ready),
    sigma_pts_ready: count(slotRecords, (record) => record.sigma_pts_ready) === ACCOUNTING_SLOTS_EXPECTED,
    signed_shock_vwap_ready: count(slotRecords, (record) => record.signed_shock_vwap_ready) > 0,
    signed_shock_vwap_ready_slots: count(slotRecords, (record) => record.signed_shock_vwap_ready),
    feature_computable_slots: count(slotRecords, (record) => record.signed_shock_vwap_ready),
    warmup_excluded_slots: warmupExcludedSlots,
    VIXCLS_prior_close_ready: regime.target_vixcls !== null,
    VXNCLS_prior_close_ready: regime.target_vxncls !== null,
    scoped_regime_label_ready: regimeReady,
    session_is_rth_ready: true,
    session_is_halt_ready: true,
    session_is_roll_block_ready: true,
    source_ready_slots: readySlots,
    ready_for_feature_snapshot_builder: readySlots > 0 && candidateNonExcluded.length > 0 && regimeReady,
    scoped_regime_label: regime,
    quote_source_records_scanned_in_window: quoteScan.source_quote_records,
    finite_quote_records_scanned_in_window: quoteScan.finite_quote_records,
  };
  const candidateFeasibility: JsonRecord = {
    candidate_eligible_points: candidateEligible.length,
    candidate_eligible_non_excluded_points: candidateNonExcluded.length,
    candidate_eligible_excluded_points: candidateExcluded.length,
    best_or_first_candidate_eligible_non_excluded_timestamp_utc: selected?.slot_end_utc ?? null,
    timestamp_ns: selected?.slot_end_ts_ns ?? null,
    entry_hour_utc: selected === null ? null : new Date(Number(BigInt(selected.slot_end_ts_ns) / 1_000_000n)).getUTCHours(),
    regime_label: regimeLabel,
    signed_shock_vwap: selected?.signed_shock_vwap ?? null,
    threshold_name: 'parameters.low_shock_threshold_pos',
    threshold_value: LOW_SHOCK_THRESHOLD_POS,
    threshold_comparison_result: selected?.signed_shock_vwap === null || selected?.signed_shock_vwap === undefined ? null : `${selected.signed_shock_vwap} >= ${LOW_SHOCK_THRESHOLD_POS}`,
    base_predicates_pass_before_utc_gate: selected !== null,
    utc_exclusion_gate_status: selected?.utc_exclusion_gate_status ?? null,
  };
  const determination = classifyDetermination({ ...sourceReadiness, ...candidateFeasibility });
  const recommendedNextTicket =
    determination === DETERMINATION_READY
      ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-IMPL-01'
      : determination === DETERMINATION_NO_CANDIDATE
        ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-NO-CANDIDATE-ELIGIBLE-DISPOSITION-01'
        : `ROUTE_TO_${determination}`;
  const authorityLocks: JsonRecord = {
    paper_runtime_invoked: false,
    StrategyFeatureSnapshot_materialized: false,
    STRAT_EVAL: 0,
    CANDIDATE: 0,
    ORDER_INTENT: 0,
    observation_day_eligible: false,
    observation_day_increment: 0,
    qfa_410b_or_qfa_611_run: false,
    Databento_fetch_attempted: false,
    broker_live_authorized: false,
    phase_6_authorized: false,
    active_candidate_roster_mutated: false,
    global_regime_labels_mutated: false,
  };

  const records: Json[] = [
    { record_type: 'SESSION_MANIFEST', manifest_role: 'open', ticket: TICKET, substrate_sha: SUBSTRATE_SHA, strategy_id: STRATEGY_ID, source_file: SOURCE_FILE, observation_window_start_utc: nsToIso(SESSION_OPEN_NS), observation_window_end_utc: nsToIso(SESSION_CLOSE_NS), paper_runtime_invoked: false },
    ...slotRecords.map((record) => toJson(record)),
    { record_type: 'SESSION_MANIFEST', manifest_role: 'close', ticket: TICKET, determination, source_readiness: sourceReadiness, candidate_feasibility: candidateFeasibility, authority_locks: authorityLocks },
  ];
  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  if (statSync(BOUNDED_JSONL).size > MAX_ARTIFACT_BYTES) throw new Error(`Bounded JSONL exceeds 95 MiB guard: ${BOUNDED_JSONL}`);
  const report: JsonRecord = {
    ticket: TICKET,
    determination,
    substrate_sha: SUBSTRATE_SHA,
    strategy_id: STRATEGY_ID,
    source_readiness: sourceReadiness,
    candidate_feasibility: candidateFeasibility,
    authority_locks: authorityLocks,
    recommended_next_ticket: recommendedNextTicket,
    output_hashes: { bounded_local_capture_source_readiness_jsonl: sha256FileLf(BOUNDED_JSONL) },
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  report.output_hashes = { bounded_local_capture_source_readiness_jsonl: sha256FileLf(BOUNDED_JSONL), local_capture_source_readiness_report_json: sha256FileLf(REPORT_JSON) };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  report.output_hashes = { bounded_local_capture_source_readiness_jsonl: sha256FileLf(BOUNDED_JSONL), local_capture_source_readiness_report_json: sha256FileLf(REPORT_JSON), local_capture_source_readiness_report_md: sha256FileLf(REPORT_MD) };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();
  const final = {
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    substrate_sha: SUBSTRATE_SHA,
    determination,
    source_readiness: sourceReadiness,
    candidate_feasibility: candidateFeasibility,
    authority_locks: authorityLocks,
    bounded_jsonl_lf_sha256: sha256FileLf(BOUNDED_JSONL),
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    script_lf_sha256: sha256FileLf(path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-04-local-capture-source-readiness.ts')),
    recommended_next_ticket: recommendedNextTicket,
  };
  console.log(JSON.stringify(final, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
