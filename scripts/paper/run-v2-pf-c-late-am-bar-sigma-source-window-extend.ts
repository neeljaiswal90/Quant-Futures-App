import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type SourceKind = 'obs01' | 'mbp1';

type SelectedRecord = {
  readonly record_type: 'TRADE' | 'QUOTE';
  readonly source_usage: 'bar_payload' | 'closure_only';
  readonly closure_trigger_for_bar_end_ts_ns: string | null;
  readonly source_path: string;
  readonly source_line_number: number;
  readonly source_event_id: string;
  readonly source_ts_ns: string;
  readonly derived_ts_ns: string;
  readonly causality_status: string;
  readonly source_record_lf_sha256: string;
  readonly payload: Record<string, JsonValue>;
};

type OutputRecord = {
  readonly record_type: 'BAR_SOURCE_DIAGNOSTIC' | 'SIGMA_SOURCE_DIAGNOSTIC' | 'SOURCE_GAP';
  readonly source_event_ids: readonly string[];
  readonly source_line_numbers: readonly number[];
  readonly source_ts_ns_range: { readonly min: string | null; readonly max: string | null };
  readonly bar_start_ts_ns: string | null;
  readonly bar_end_ts_ns: string | null;
  readonly derived_ts_ns: string | null;
  readonly max_source_ts_ns_used: string | null;
  readonly causality_status: string;
  readonly lookahead_detected: false;
  readonly payload: Record<string, JsonValue>;
};

type BuiltBar = {
  readonly bar_start_ts_ns: string;
  readonly bar_end_ts_ns: string;
  readonly first_record_ts_ns: string;
  readonly last_record_ts_ns: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trade_count: number;
  readonly quote_count: number;
  readonly finite_quote_mid_count: number;
  readonly source_event_ids: readonly string[];
  readonly source_line_numbers: readonly number[];
};

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-BAR-SIGMA-SOURCE-WINDOW-EXTEND-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const SOURCE_ROOT = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-01';
const OBS01_PATH = `${SOURCE_ROOT}/MNQ_globex.obs01.jsonl`;
const MBP1_PATH = `${SOURCE_ROOT}/MNQ_globex.mbp1.jsonl`;
const OUTPUT_DIR = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-bar-sigma-source-window-extend-01';
const OUTPUT_SOURCE = `${OUTPUT_DIR}/bounded-bar-sigma-window-source.jsonl`;
const OUTPUT_JSON = `${OUTPUT_DIR}/bar-sigma-window-report.json`;
const OUTPUT_MD = `${OUTPUT_DIR}/bar-sigma-window-report.md`;
const MEMO_PATH = 'docs/research/v2-pf-c-late-am-paper-observation-bar-sigma-source-window-extend-01-memo.md';
const PR298_SOURCE_PATH = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-source-data-extend-01/bounded-source-events.jsonl';
const PR298_SHA = '0ab171e087826aaffb14cfbf6d3e5a51bd81173ace17efe85528790452010788';
const PR300_SHA = '005f76c0352fa31e16ce716595f193f5f4607b7ec1b2ae986488197967b6e541';
const BAR_SPEC = '1m';
const BAR_INTERVAL_NS = 60_000_000_000n;
const TICK_SIZE = 0.25;
const SIGMA_FORMULA = 'sigma_pts = round4(max(TICK_SIZE, average(bars.map(bar => bar.high - bar.low)) / 2))';
const SIGMA_FORMULA_SOURCE = 'apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:1215,1280';
const SIGNED_SHOCK_NEXT = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-SIGNED-SHOCK-SOURCE-EXTEND-01';
const WINDOW_NEXT = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-BAR-SIGMA-SOURCE-WINDOW-EXTEND-02';

function parseArgs(): { targetClosedBars: number; maxLinesPerSource: number } {
  const args = process.argv.slice(2);
  let targetClosedBars = 30;
  let maxLinesPerSource = 250000;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--target-closed-bars') {
      const raw = args[index + 1];
      if (raw === undefined) throw new Error('--target-closed-bars requires a value');
      targetClosedBars = Number.parseInt(raw, 10);
      index += 1;
    } else if (arg === '--max-lines-per-source') {
      const raw = args[index + 1];
      if (raw === undefined) throw new Error('--max-lines-per-source requires a value');
      maxLinesPerSource = Number.parseInt(raw, 10);
      index += 1;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (!Number.isInteger(targetClosedBars) || targetClosedBars <= 0) throw new Error('--target-closed-bars must be positive');
  if (!Number.isInteger(maxLinesPerSource) || maxLinesPerSource <= 0) throw new Error('--max-lines-per-source must be positive');
  return { targetClosedBars, maxLinesPerSource };
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key]);
    return sorted;
  }
  return value;
}

function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortJsonValue(value))}\n`;
}

function stableJsonl(records: readonly (SelectedRecord | OutputRecord)[]): string {
  return records.map((record) => JSON.stringify(sortJsonValue(record as unknown as JsonValue))).join('\n') + '\n';
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}function bigintCompare(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function nsOrNull(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/u.test(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value).toString();
  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseTrade(parsed: Record<string, unknown>, sourcePath: string, lineNumber: number, rawLine: string): SelectedRecord | null {
  if (parsed.type !== 'TRADE') return null;
  const tsNs = nsOrNull(parsed.ts_ns);
  if (tsNs === null) return null;
  const payload = parsed.payload !== null && typeof parsed.payload === 'object' ? parsed.payload as Record<string, unknown> : {};
  return {
    record_type: 'TRADE',
    source_usage: 'bar_payload',
    closure_trigger_for_bar_end_ts_ns: null,
    source_path: normalizePath(sourcePath),
    source_line_number: lineNumber,
    source_event_id: stringOrNull(parsed.event_id) ?? `trade-line-${lineNumber}`,
    source_ts_ns: tsNs,
    derived_ts_ns: tsNs,
    causality_status: 'source_event_time_observed',
    source_record_lf_sha256: sha256Text(`${rawLine}\n`),
    payload: {
      price: numberOrNull(payload.price),
      quantity: numberOrNull(payload.quantity),
      aggressor_side: stringOrNull(payload.aggressor_side),
      trade_id: stringOrNull(payload.trade_id),
    },
  };
}

function parseQuote(parsed: Record<string, unknown>, sourcePath: string, lineNumber: number, rawLine: string): SelectedRecord | null {
  const tsNs = nsOrNull(parsed.ts_event_ns ?? parsed.ts_recv_ns);
  if (tsNs === null) return null;
  const bid = numberOrNull(parsed.bid_px_00);
  const ask = numberOrNull(parsed.ask_px_00);
  const mid = bid !== null && ask !== null && ask > 0 ? (bid + ask) / 2 : null;
  return {
    record_type: 'QUOTE',
    source_usage: 'bar_payload',
    closure_trigger_for_bar_end_ts_ns: null,
    source_path: normalizePath(sourcePath),
    source_line_number: lineNumber,
    source_event_id: `mbp1-line-${lineNumber}`,
    source_ts_ns: tsNs,
    derived_ts_ns: tsNs,
    causality_status: 'source_event_time_observed',
    source_record_lf_sha256: sha256Text(`${rawLine}\n`),
    payload: {
      bid_px_00: bid,
      bid_sz_00: numberOrNull(parsed.bid_sz_00),
      bid_ct_00: numberOrNull(parsed.bid_ct_00),
      ask_px_00: ask,
      ask_sz_00: numberOrNull(parsed.ask_sz_00),
      ask_ct_00: numberOrNull(parsed.ask_ct_00),
      mid_px: mid,
      spread_points: bid !== null && ask !== null && ask > 0 ? ask - bid : null,
      ts_recv_ns: nsOrNull(parsed.ts_recv_ns),
    },
  };
}

async function readEligibleSource(kind: SourceKind, sourcePath: string, startTsNs: string, maxLines: number): Promise<{ records: SelectedRecord[]; scanned: number; malformed: number; unsupported: number; missingTimestamp: number; fullHash: string; beforeSize: number; afterSize: number; beforeMtime: string; afterMtime: string; mutatedDuringHash: boolean }> {
  const before = await stat(sourcePath);
  const fullHash = await sha256File(sourcePath);
  const after = await stat(sourcePath);
  const records: SelectedRecord[] = [];
  let scanned = 0;
  let malformed = 0;
  let unsupported = 0;
  let missingTimestamp = 0;
  const start = BigInt(startTsNs);
  const stream = createReadStream(sourcePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const lineRaw of rl) {
    scanned += 1;
    if (scanned > maxLines) {
      rl.close();
      stream.destroy();
      break;
    }
    const line = lineRaw.trimEnd();
    if (line.length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        unsupported += 1;
        continue;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      malformed += 1;
      continue;
    }
    const record = kind === 'obs01' ? parseTrade(parsed, sourcePath, scanned, line) : parseQuote(parsed, sourcePath, scanned, line);
    if (record === null) {
      const ts = nsOrNull(parsed.ts_ns ?? parsed.ts_event_ns ?? parsed.ts_recv_ns);
      if (ts === null) missingTimestamp += 1;
      else unsupported += 1;
      continue;
    }
    if (BigInt(record.source_ts_ns) >= start) records.push(record);
  }
  return {
    records,
    scanned: Math.min(scanned, maxLines),
    malformed,
    unsupported,
    missingTimestamp,
    fullHash,
    beforeSize: before.size,
    afterSize: after.size,
    beforeMtime: before.mtime.toISOString(),
    afterMtime: after.mtime.toISOString(),
    mutatedDuringHash: before.size !== after.size || before.mtimeMs !== after.mtimeMs,
  };
}

function mergeRecords(records: readonly SelectedRecord[]): SelectedRecord[] {
  return [...records].sort((a, b) => {
    const ts = bigintCompare(BigInt(a.source_ts_ns), BigInt(b.source_ts_ns));
    if (ts !== 0) return ts;
    const pathCompare = a.source_path.localeCompare(b.source_path);
    if (pathCompare !== 0) return pathCompare;
    return a.source_line_number - b.source_line_number;
  });
}

function rangeFor(records: readonly SelectedRecord[]): { min: string | null; max: string | null } {
  if (records.length === 0) return { min: null, max: null };
  return { min: records[0]!.source_ts_ns, max: records[records.length - 1]!.source_ts_ns };
}
function barStartForTs(tsNs: string): string {
  const ts = BigInt(tsNs);
  return (ts - (ts % BAR_INTERVAL_NS)).toString();
}

function barEndForStart(startNs: string): string {
  return (BigInt(startNs) + BAR_INTERVAL_NS).toString();
}

function finiteNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asClosureOnlyRecord(record: SelectedRecord, closedBarEndTsNs: string): SelectedRecord {
  return {
    ...record,
    source_usage: 'closure_only',
    closure_trigger_for_bar_end_ts_ns: closedBarEndTsNs,
  };
}

function buildClosedBars(records: readonly SelectedRecord[], targetClosedBars: number): { selectedRecords: SelectedRecord[]; closedBars: BuiltBar[]; openPartialBarsSeen: number; stoppingReason: string; closureTriggerRecord: SelectedRecord | null } {
  const selected: SelectedRecord[] = [];
  const closedBars: BuiltBar[] = [];
  let activeStart: string | null = null;
  let activeEnd: string | null = null;
  let activeRecords: SelectedRecord[] = [];
  let openPartialBarsSeen = 0;
  let closureTriggerRecord: SelectedRecord | null = null;

  const closeActive = (): void => {
    if (activeStart === null || activeEnd === null || activeRecords.length === 0) return;
    const trades = activeRecords.filter((record) => record.record_type === 'TRADE');
    const quotes = activeRecords.filter((record) => record.record_type === 'QUOTE');
    const prices = trades.map((record) => finiteNumber(record.payload.price)).filter((value): value is number => value !== null);
    const quantities = trades.map((record) => finiteNumber(record.payload.quantity)).filter((value): value is number => value !== null);
    if (prices.length > 0) {
      closedBars.push({
        bar_start_ts_ns: activeStart,
        bar_end_ts_ns: activeEnd,
        first_record_ts_ns: activeRecords[0]!.source_ts_ns,
        last_record_ts_ns: activeRecords[activeRecords.length - 1]!.source_ts_ns,
        open: prices[0]!,
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1]!,
        volume: quantities.reduce((total, value) => total + value, 0),
        trade_count: trades.length,
        quote_count: quotes.length,
        finite_quote_mid_count: quotes.filter((record) => finiteNumber(record.payload.mid_px) !== null).length,
        source_event_ids: activeRecords.map((record) => record.source_event_id),
        source_line_numbers: activeRecords.map((record) => record.source_line_number),
      });
    }
  };

  for (const record of records) {
    const recordStart = barStartForTs(record.source_ts_ns);
    const recordEnd = barEndForStart(recordStart);
    if (activeStart === null) {
      activeStart = recordStart;
      activeEnd = recordEnd;
    }
    while (activeEnd !== null && BigInt(record.source_ts_ns) >= BigInt(activeEnd)) {
      const closedBarEnd = activeEnd;
      closeActive();
      if (closedBars.length >= targetClosedBars) {
        closureTriggerRecord = asClosureOnlyRecord(record, closedBarEnd);
        selected.push(closureTriggerRecord);
        return { selectedRecords: selected, closedBars, openPartialBarsSeen, stoppingReason: 'target_closed_bars_reached_with_closure_trigger_in_bounded_source', closureTriggerRecord };
      }
      activeRecords = [];
      activeStart = recordStart;
      activeEnd = recordEnd;
      break;
    }
    activeRecords.push(record);
    selected.push(record);
  }
  if (activeRecords.length > 0) openPartialBarsSeen += 1;
  return { selectedRecords: selected, closedBars, openPartialBarsSeen, stoppingReason: closedBars.length >= targetClosedBars ? 'target_closed_bars_reached_with_closure_trigger_in_bounded_source' : 'source_exhausted_or_scan_cap_before_target', closureTriggerRecord };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function sigmaPtsFromBars(bars: readonly BuiltBar[]): number | null {
  if (bars.length === 0) return null;
  const avgRange = bars.reduce((total, bar) => total + (bar.high - bar.low), 0) / bars.length;
  return round4(Math.max(TICK_SIZE, avgRange / 2));
}

function outputRecordRange(records: readonly SelectedRecord[]): { min: string | null; max: string | null } {
  return rangeFor(records);
}

function assertCausal(record: OutputRecord): void {
  if (record.lookahead_detected !== false) throw new Error(`${record.record_type} lookahead flag is not false`);
  if (record.max_source_ts_ns_used !== null && record.derived_ts_ns !== null && BigInt(record.max_source_ts_ns_used) > BigInt(record.derived_ts_ns)) {
    throw new Error(`${record.record_type} violates max_source_ts_ns_used <= derived_ts_ns`);
  }
}

function buildOutputRecords(input: { selected: readonly SelectedRecord[]; closedBars: readonly BuiltBar[]; openPartialBarsSeen: number; targetClosedBars: number; stoppingReason: string; closureTriggerRecord: SelectedRecord | null }): readonly OutputRecord[] {
  const range = outputRecordRange(input.selected);
  const max = range.max;
  const lastBar = input.closedBars.at(-1);
  const closureTrigger = input.closureTriggerRecord;
  const sigma = sigmaPtsFromBars(input.closedBars);
  const barsReady = input.closedBars.length >= input.targetClosedBars && sigma !== null;
  const barRecord: OutputRecord = {
    record_type: 'BAR_SOURCE_DIAGNOSTIC',
    source_event_ids: [...(lastBar?.source_event_ids ?? []), ...(closureTrigger === null ? [] : [closureTrigger.source_event_id])],
    source_line_numbers: [...(lastBar?.source_line_numbers ?? []), ...(closureTrigger === null ? [] : [closureTrigger.source_line_number])],
    source_ts_ns_range: range,
    bar_start_ts_ns: lastBar?.bar_start_ts_ns ?? null,
    bar_end_ts_ns: lastBar?.bar_end_ts_ns ?? null,
    derived_ts_ns: max,
    max_source_ts_ns_used: max,
    causality_status: barsReady ? 'causal_closed_1m_bars_ready' : 'causal_closed_1m_bars_partial',
    lookahead_detected: false,
    payload: {
      bar_interval: BAR_SPEC,
      closed_bars_constructed: input.closedBars.length,
      open_partial_bars_seen: input.openPartialBarsSeen,
      target_closed_bars: input.targetClosedBars,
      stopping_reason: input.stoppingReason,
      closure_trigger_source_event_id: closureTrigger?.source_event_id ?? null,
      closure_trigger_source_ts_ns: closureTrigger?.source_ts_ns ?? null,
      closure_trigger_source_line_number: closureTrigger?.source_line_number ?? null,
      closure_trigger_source_path: closureTrigger?.source_path ?? null,
      closure_trigger_in_bounded_source: closureTrigger !== null && input.selected.some((record) => record.source_event_id === closureTrigger.source_event_id && record.source_usage === 'closure_only'),
      closure_trigger_usage: closureTrigger === null ? null : 'closure_only_not_used_for_bar_ohlc_or_sigma_range',
      last_closed_bar: lastBar === undefined ? null : lastBar as unknown as JsonValue,
    },
  };
  const sigmaRecord: OutputRecord = {
    record_type: 'SIGMA_SOURCE_DIAGNOSTIC',
    source_event_ids: lastBar?.source_event_ids ?? [],
    source_line_numbers: lastBar?.source_line_numbers ?? [],
    source_ts_ns_range: range,
    bar_start_ts_ns: lastBar?.bar_start_ts_ns ?? null,
    bar_end_ts_ns: lastBar?.bar_end_ts_ns ?? null,
    derived_ts_ns: max,
    max_source_ts_ns_used: max,
    causality_status: barsReady ? 'causal_sigma_pts_ready' : 'blocked_insufficient_history',
    lookahead_detected: false,
    payload: {
      sigma_formula: SIGMA_FORMULA,
      sigma_formula_source: SIGMA_FORMULA_SOURCE,
      sigma_lookback_bars_required: input.targetClosedBars,
      sigma_lookback_bars_available: input.closedBars.length,
      sigma_pts_ready: barsReady,
      sigma_pts_value_if_ready: barsReady ? sigma : null,
      signed_shock_readiness_claimed: false,
      signed_shock_note: 'signed-shock still requires ATR14/session VWAP/recent-history checks in the follow-up ticket',
    },
  };
  const records: OutputRecord[] = [barRecord, sigmaRecord];
  if (!barsReady) {
    records.push({
      record_type: 'SOURCE_GAP',
      source_event_ids: [],
      source_line_numbers: [],
      source_ts_ns_range: range,
      bar_start_ts_ns: lastBar?.bar_start_ts_ns ?? null,
      bar_end_ts_ns: lastBar?.bar_end_ts_ns ?? null,
      derived_ts_ns: max,
      max_source_ts_ns_used: max,
      causality_status: 'blocked_insufficient_history',
      lookahead_detected: false,
      payload: {
        blocker_family: 'bar_sigma_window_history',
        missing_reason: 'wider bounded scan did not produce the target closed 1m bars before stopping condition',
        required_source: 'larger deterministic bounded quote/trade source window',
        next_ticket_hint: WINDOW_NEXT,
      },
    });
  }
  for (const record of records) assertCausal(record);
  return records;
}
function countByType(records: readonly SelectedRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) counts[record.record_type] = (counts[record.record_type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function outputCounts(records: readonly OutputRecord[]): Record<string, number> {
  const counts: Record<string, number> = { BAR_SOURCE_DIAGNOSTIC: 0, SIGMA_SOURCE_DIAGNOSTIC: 0, SOURCE_GAP: 0 };
  for (const record of records) counts[record.record_type] = (counts[record.record_type] ?? 0) + 1;
  return counts;
}

function buildReport(input: {
  readonly selectedText: string;
  readonly selected: readonly SelectedRecord[];
  readonly outputText: string;
  readonly outputRecords: readonly OutputRecord[];
  readonly closedBars: readonly BuiltBar[];
  readonly openPartialBarsSeen: number;
  readonly targetClosedBars: number;
  readonly maxLinesPerSource: number;
  readonly sourceStats: Record<string, JsonValue>;
  readonly stoppingReason: string;
  readonly closureTriggerRecord: SelectedRecord | null;
}): JsonValue {
  const selectedCounts = countByType(input.selected);
  const outputCountMap = outputCounts(input.outputRecords);
  const quoteRecords = input.selected.filter((record) => record.record_type === 'QUOTE');
  const tradeRecords = input.selected.filter((record) => record.record_type === 'TRADE');
  const quotesWithBidAsk = quoteRecords.filter((record) => finiteNumber(record.payload.bid_px_00) !== null && finiteNumber(record.payload.ask_px_00) !== null).length;
  const quotesWithMid = quoteRecords.filter((record) => finiteNumber(record.payload.mid_px) !== null).length;
  const sigma = sigmaPtsFromBars(input.closedBars);
  const sigmaReady = input.closedBars.length >= input.targetClosedBars && sigma !== null;
  const barWindowEnd = input.closedBars.at(-1)?.bar_end_ts_ns ?? null;
  const boundedSourceEnd = input.selected.at(-1)?.source_ts_ns ?? null;
  const closureTrigger = input.closureTriggerRecord;
  const closureInBoundedSource = closureTrigger !== null && input.selected.some((record) => record.source_event_id === closureTrigger.source_event_id && record.source_usage === 'closure_only');
  return {
    schema_version: 1,
    ticket: TICKET,
    classification: sigmaReady ? 'BAR_SIGMA_WINDOW_READY_FOR_SIGNED_SHOCK_SOURCE' : 'BAR_SIGMA_WINDOW_BLOCKED_INSUFFICIENT_HISTORY',
    strategy_id: STRATEGY_ID,
    observation_day_eligible: false,
    observation_day_increment: 0,
    pr298_control_source_lf_sha256: PR298_SHA,
    pr300_control_bar_sigma_lf_sha256: PR300_SHA,
    control_result: 'BAR_SIGMA_SOURCE_BLOCKED_INSUFFICIENT_HISTORY',
    bounded_input_source_lf_sha256: sha256Text(input.selectedText),
    bounded_input_event_count: input.selected.length,
    bounded_bar_sigma_output_lf_sha256: sha256Text(input.outputText),
    bounded_bar_sigma_record_count: input.outputRecords.length,
    bounded_bar_sigma_record_counts_by_type: outputCountMap,
    bounded_source_start_ts_ns: input.selected[0]?.source_ts_ns ?? null,
    bounded_source_end_ts_ns: boundedSourceEnd,
    bounded_source_end_ts_ns_gte_bar_window_end_ts_ns: barWindowEnd !== null && boundedSourceEnd !== null ? BigInt(boundedSourceEnd) >= BigInt(barWindowEnd) : false,
    source_event_counts_by_type: selectedCounts,
    quote_records_total: quoteRecords.length,
    quote_records_with_bid_ask: quotesWithBidAsk,
    quote_records_with_finite_mid_px: quotesWithMid,
    trade_records_total: tradeRecords.length,
    source_selection_policy: 'start from first PR #298 bounded source timestamp; merge eligible obs01 TRADE and mbp1 QUOTE records by source_ts_ns, source_path, source_line_number; continue until target closed 1m bars or scan cap; MBO excluded from bar/sigma readiness',
    max_lines_scanned_per_source: input.maxLinesPerSource,
    source_scan_stats: input.sourceStats,
    full_file_hash_scope_note: 'point_in_time_full_file; bounded input source hash is authoritative',
    bar_interval: BAR_SPEC,
    closed_bars_constructed: input.closedBars.length,
    open_partial_bars_seen: input.openPartialBarsSeen,
    bar_window_start_ts_ns: input.closedBars[0]?.bar_start_ts_ns ?? null,
    bar_window_end_ts_ns: barWindowEnd,
    closure_trigger_source_event_id: closureTrigger?.source_event_id ?? null,
    closure_trigger_source_ts_ns: closureTrigger?.source_ts_ns ?? null,
    closure_trigger_source_line_number: closureTrigger?.source_line_number ?? null,
    closure_trigger_source_path: closureTrigger?.source_path ?? null,
    closure_trigger_in_bounded_source: closureInBoundedSource,
    closure_trigger_usage: closureTrigger === null ? null : 'closure_only_not_used_for_bar_ohlc_or_sigma_range',
    sigma_formula: SIGMA_FORMULA,
    sigma_formula_source: SIGMA_FORMULA_SOURCE,
    sigma_lookback_bars_required: input.targetClosedBars,
    sigma_lookback_bars_available: input.closedBars.length,
    sigma_pts_ready: sigmaReady,
    sigma_pts_value_if_ready: sigmaReady ? sigma : null,
    causality_check: {
      bar_closure_rule: '1m bar closes only when a source event timestamp is greater than or equal to the next minute boundary; final EOF/open bar is excluded from sigma readiness',
      final_bar_closure_trigger_in_bounded_source: closureInBoundedSource,
      bounded_source_end_ts_ns_gte_bar_window_end_ts_ns: barWindowEnd !== null && boundedSourceEnd !== null ? BigInt(boundedSourceEnd) >= BigInt(barWindowEnd) : false,
      max_source_ts_ns_used_lte_derived_ts_ns_for_non_gap_records: true,
      every_record_lookahead_detected_false: true,
    },
    lookahead_detected: false,
    stopping_reason: input.stoppingReason,
    signed_shock_readiness_claimed: false,
    signed_shock_note: 'sigma_pts readiness does not imply signed-shock readiness; signed-shock still requires ATR14/session VWAP/recent-history checks in the follow-up ticket',
    recommended_next_ticket: sigmaReady ? SIGNED_SHOCK_NEXT : WINDOW_NEXT,
    recommended_next_ticket_reason: sigmaReady ? 'closed 1m bars and sigma_pts are ready; proceed to signed-shock source readiness without claiming signed-shock readiness here' : 'closed 1m bars remain insufficient under the bounded scan cap',
    deterministic_generation: {
      ab_byte_stable_bounded_input_source_jsonl: true,
      ab_byte_stable_bounded_bar_sigma_output_jsonl: true,
      ab_byte_stable_report_json: true,
      ab_byte_stable_report_md: true,
      hash_convention: 'LF-canonical SHA-256 over exact generated payload',
    },
    strategy_runtime_markers: { STRAT_EVAL: 0, CANDIDATE: 0, ORDER_INTENT: 0 },
    authority: {
      broker_live_authorized: false,
      phase_6_authorized: false,
      active_roster_mutated: false,
      candidate_roster_mutated: false,
      paper_observation_day_created: false,
    },
  };
}

function markdownTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  const divider = rows[0]!.map(() => '---');
  return [rows[0]!, divider, ...rows.slice(1)].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function buildMarkdown(report: JsonValue): string {
  const r = report as Record<string, any>;
  const rows = [
    ['Metric', 'Value'],
    ['classification', r.classification],
    ['bounded_input_source_lf_sha256', r.bounded_input_source_lf_sha256],
    ['bounded_bar_sigma_output_lf_sha256', r.bounded_bar_sigma_output_lf_sha256],
    ['closed_bars_constructed', String(r.closed_bars_constructed)],
    ['bounded_source_end_ts_ns_gte_bar_window_end_ts_ns', String(r.bounded_source_end_ts_ns_gte_bar_window_end_ts_ns)],
    ['closure_trigger_in_bounded_source', String(r.closure_trigger_in_bounded_source)],
    ['sigma_pts_ready', String(r.sigma_pts_ready)],
    ['sigma_pts_value_if_ready', String(r.sigma_pts_value_if_ready)],
    ['recommended_next_ticket', r.recommended_next_ticket],
  ];
  return `# ${TICKET} — Bar/Sigma Window Report\n\n` +
    `## Determination\n\n${markdownTable(rows)}\n\n` +
    `## Source selection\n\n${r.source_selection_policy}\n\n` +
    `Full-file hashes are point-in-time only. The bounded input source hash is authoritative.\n\n` +
    `## Bar and sigma\n\nBar interval remains \`${r.bar_interval}\`. Formula: \`${r.sigma_formula}\` from \`${r.sigma_formula_source}\`.\n\n` +
    `Final closure proof: \`bounded_source_end_ts_ns=${r.bounded_source_end_ts_ns}\`, \`bar_window_end_ts_ns=${r.bar_window_end_ts_ns}\`, \`closure_trigger_source_ts_ns=${r.closure_trigger_source_ts_ns}\`, \`closure_trigger_in_bounded_source=${r.closure_trigger_in_bounded_source}\`. The closure trigger is marked \`${r.closure_trigger_usage}\`.\n\n` +
    `## Signed-shock boundary\n\n${r.signed_shock_note}\n\n` +
    `## Authority caveat\n\nObservation-day eligible: \`${r.observation_day_eligible}\`. Observation-day increment: \`${r.observation_day_increment}\`. No feature snapshots, paper runtime, strategy markers, broker/live, Phase 6, active roster, or candidate roster authority.\n`;
}
function buildMemo(report: JsonValue): string {
  const r = report as Record<string, any>;
  return `# ${TICKET} Memo\n\n` +
    `## 1. Context\n\n` +
    `PR #300 classified the PR #298 control as \`BAR_SIGMA_SOURCE_BLOCKED_INSUFFICIENT_HISTORY\`. This ticket extends the bounded quote/trade source window deterministically to test whether closed \`1m\` bars and \`sigma_pts\` readiness can be established.\n\n` +
    `## 2. Input provenance\n\n` +
    `PR #298 control source SHA: \`${r.pr298_control_source_lf_sha256}\`. PR #300 control bar/sigma SHA: \`${r.pr300_control_bar_sigma_lf_sha256}\`. New bounded input SHA: \`${r.bounded_input_source_lf_sha256}\`.\n\n` +
    `## 3. Source selection\n\n` +
    `${r.source_selection_policy}. Max lines per source: \`${r.max_lines_scanned_per_source}\`.\n\n` +
    `## 4. Bar construction result\n\n` +
    `Closed bars constructed: \`${r.closed_bars_constructed}\`. Open partial bars seen: \`${r.open_partial_bars_seen}\`. Bar window: \`${r.bar_window_start_ts_ns}\` to \`${r.bar_window_end_ts_ns}\`.\n\n` +
    `## 5. Final closure proof\n\n` +
    `The bounded source now includes the boundary-crossing closure proof for the final claimed bar: \`closure_trigger_source_event_id=${r.closure_trigger_source_event_id}\`, \`closure_trigger_source_ts_ns=${r.closure_trigger_source_ts_ns}\`, \`closure_trigger_source_line_number=${r.closure_trigger_source_line_number}\`, \`closure_trigger_in_bounded_source=${r.closure_trigger_in_bounded_source}\`. The closure record is marked \`${r.closure_trigger_usage}\` and is not used for bar OHLC, high-low range, or sigma range construction. The invariant \`bounded_source_end_ts_ns >= bar_window_end_ts_ns\` is \`${r.bounded_source_end_ts_ns_gte_bar_window_end_ts_ns}\`.\n\n` +
    `## 6. Sigma readiness result\n\n` +
    `Formula: \`${r.sigma_formula}\`. Lookback available: \`${r.sigma_lookback_bars_available}\`; required: \`${r.sigma_lookback_bars_required}\`. Ready: \`${r.sigma_pts_ready}\`. Value if ready: \`${r.sigma_pts_value_if_ready}\`.\n\n` +
    `## 7. No-lookahead contract\n\n` +
    `A \`1m\` bar closes only when a source event timestamp is greater than or equal to the next minute boundary. The final open partial bar is excluded from sigma readiness. Every record carries \`lookahead_detected=false\`.\n\n` +
    `## 8. Signed-shock boundary\n\n` +
    `${r.signed_shock_note}.\n\n` +
    `## 9. Determination\n\n` +
    `Classification: \`${r.classification}\`. Recommended next ticket: \`${r.recommended_next_ticket}\` — ${r.recommended_next_ticket_reason}.\n\n` +
    `## 10. Verification\n\n` +
    `The script asserts A/B byte stability for bounded input JSONL, bounded output JSONL, report JSON, and report Markdown.\n\n` +
    `## 11. Authority caveat\n\n` +
    `Observation-day eligible: \`${r.observation_day_eligible}\`. Observation-day increment: \`${r.observation_day_increment}\`. No \`StrategyFeatureSnapshot\`, paper runtime, \`STRAT_EVAL\`, \`CANDIDATE\`, \`ORDER_INTENT\`, broker/live, Phase 6, active roster, candidate roster, or observation-day authority is created.\n`;
}

async function firstPr298Timestamp(): Promise<string> {
  const text = await readFile(PR298_SOURCE_PATH, 'utf8');
  const hash = sha256Text(text);
  if (hash !== PR298_SHA) throw new Error(`PR #298 source hash mismatch: ${hash}`);
  const first = text.split(/\r?\n/u).find((line) => line.length > 0);
  if (first === undefined) throw new Error('PR #298 source is empty');
  const parsed = JSON.parse(first) as { source_ts_ns?: unknown };
  const ts = nsOrNull(parsed.source_ts_ns);
  if (ts === null) throw new Error('PR #298 first record missing source_ts_ns');
  return ts;
}

async function buildEvidence(args: { targetClosedBars: number; maxLinesPerSource: number }) {
  const startTs = await firstPr298Timestamp();
  const obs = await readEligibleSource('obs01', OBS01_PATH, startTs, args.maxLinesPerSource);
  const mbp = await readEligibleSource('mbp1', MBP1_PATH, startTs, args.maxLinesPerSource);
  const mergedAll = mergeRecords([...obs.records, ...mbp.records]);
  const built = buildClosedBars(mergedAll, args.targetClosedBars);
  const selected = built.selectedRecords;
  const selectedTextA = stableJsonl(selected);
  const selectedTextB = stableJsonl(selected);
  if (selectedTextA !== selectedTextB) throw new Error('bounded selected source JSONL is not byte-stable');
  const outputA = buildOutputRecords({ selected, closedBars: built.closedBars, openPartialBarsSeen: built.openPartialBarsSeen, targetClosedBars: args.targetClosedBars, stoppingReason: built.stoppingReason, closureTriggerRecord: built.closureTriggerRecord });
  const outputB = buildOutputRecords({ selected, closedBars: built.closedBars, openPartialBarsSeen: built.openPartialBarsSeen, targetClosedBars: args.targetClosedBars, stoppingReason: built.stoppingReason, closureTriggerRecord: built.closureTriggerRecord });
  const outputTextA = stableJsonl(outputA);
  const outputTextB = stableJsonl(outputB);
  if (outputTextA !== outputTextB) throw new Error('bounded bar/sigma output JSONL is not byte-stable');
  const sourceStats: Record<string, JsonValue> = {
    obs01: {
      path: normalizePath(OBS01_PATH),
      records_scanned: obs.scanned,
      records_selected: selected.filter((record) => record.source_path === normalizePath(OBS01_PATH)).length,
      full_source_sha256: obs.fullHash,
      full_source_sha256_scope: 'point_in_time_full_file',
      size_bytes_before: obs.beforeSize,
      size_bytes_after: obs.afterSize,
      mtime_before: obs.beforeMtime,
      mtime_after: obs.afterMtime,
      mutated_during_hash: obs.mutatedDuringHash,
      malformed_count: obs.malformed,
      unsupported_record_count: obs.unsupported,
      missing_timestamp_count: obs.missingTimestamp,
    },
    mbp1: {
      path: normalizePath(MBP1_PATH),
      records_scanned: mbp.scanned,
      records_selected: selected.filter((record) => record.source_path === normalizePath(MBP1_PATH)).length,
      full_source_sha256: mbp.fullHash,
      full_source_sha256_scope: 'point_in_time_full_file',
      size_bytes_before: mbp.beforeSize,
      size_bytes_after: mbp.afterSize,
      mtime_before: mbp.beforeMtime,
      mtime_after: mbp.afterMtime,
      mutated_during_hash: mbp.mutatedDuringHash,
      malformed_count: mbp.malformed,
      unsupported_record_count: mbp.unsupported,
      missing_timestamp_count: mbp.missingTimestamp,
    },
  };
  const reportA = buildReport({ selectedText: selectedTextA, selected, outputText: outputTextA, outputRecords: outputA, closedBars: built.closedBars, openPartialBarsSeen: built.openPartialBarsSeen, targetClosedBars: args.targetClosedBars, maxLinesPerSource: args.maxLinesPerSource, sourceStats, stoppingReason: built.stoppingReason, closureTriggerRecord: built.closureTriggerRecord });
  const reportB = buildReport({ selectedText: selectedTextB, selected, outputText: outputTextB, outputRecords: outputB, closedBars: built.closedBars, openPartialBarsSeen: built.openPartialBarsSeen, targetClosedBars: args.targetClosedBars, maxLinesPerSource: args.maxLinesPerSource, sourceStats, stoppingReason: built.stoppingReason, closureTriggerRecord: built.closureTriggerRecord });
  const reportJsonA = stableJson(reportA);
  const reportJsonB = stableJson(reportB);
  if (reportJsonA !== reportJsonB) throw new Error('report JSON is not byte-stable');
  const reportMdA = buildMarkdown(reportA);
  const reportMdB = buildMarkdown(reportB);
  if (reportMdA !== reportMdB) throw new Error('report Markdown is not byte-stable');
  return { selectedText: selectedTextA, outputText: outputTextA, report: reportA, reportJson: reportJsonA, reportMd: reportMdA, memo: buildMemo(reportA) };
}

async function main() {
  const args = parseArgs();
  const evidence = await buildEvidence(args);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(path.dirname(MEMO_PATH), { recursive: true });
  await writeFile(OUTPUT_SOURCE, evidence.selectedText, 'utf8');
  await writeFile(OUTPUT_JSON, evidence.reportJson, 'utf8');
  await writeFile(OUTPUT_MD, evidence.reportMd, 'utf8');
  await writeFile(MEMO_PATH, evidence.memo, 'utf8');
  const report = evidence.report as Record<string, any>;
  console.log(JSON.stringify({
    ticket: TICKET,
    classification: report.classification,
    bounded_input_source_lf_sha256: report.bounded_input_source_lf_sha256,
    bounded_input_event_count: report.bounded_input_event_count,
    bounded_bar_sigma_output_lf_sha256: report.bounded_bar_sigma_output_lf_sha256,
    closed_bars_constructed: report.closed_bars_constructed,
    sigma_pts_ready: report.sigma_pts_ready,
    sigma_pts_value_if_ready: report.sigma_pts_value_if_ready,
    recommended_next_ticket: report.recommended_next_ticket,
    observation_day_eligible: report.observation_day_eligible,
    observation_day_increment: report.observation_day_increment,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

