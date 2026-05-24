import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACT_SPECS } from '../../apps/strategy_runtime/src/risk/contracts.js';
import {
  FixedSeedRandomSource,
  sampleMarketableAdverseSlippage,
} from '../../apps/strategy_runtime/src/execution/slippage-model.js';

const require = createRequire(import.meta.url);
const parquet = require('parquetjs-lite') as {
  ParquetSchema: new (definition: Record<string, unknown>) => unknown;
  ParquetReader: {
    openFile(path: string): Promise<{
      getCursor(columnList?: unknown): { next(): Promise<Record<string, unknown> | null> };
      close(): Promise<void>;
    }>;
  };
  ParquetWriter: {
    openFile(
      schema: unknown,
      path: string,
      options?: Record<string, unknown>,
    ): Promise<{
      appendRow(row: Record<string, unknown>): Promise<void>;
      close(): Promise<void>;
      setMetadata(key: string, value: string): void;
      setRowGroupSize(size: number): void;
    }>;
  };
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..', '..');
const MOC_ROOT = join(REPO_ROOT, 'scratch', 'moc-research');
const MANIFEST_PATH = join(MOC_ROOT, 'event-day-manifest.json');
const EVENT_STREAM_PATH = join(MOC_ROOT, 'event-stream.parquet');
const EVENT_STREAM_ATTESTATION_PATH = join(MOC_ROOT, 'event-stream.sha256.txt');
const OUTPUT_DIR = process.env.MOC_R3_OUTPUT_DIR ?? MOC_ROOT;
const TRIGGERED_EVENTS_PATH = join(OUTPUT_DIR, 'triggered-events.parquet');

const NS_PER_SECOND = 1_000_000_000n;
const GRID_ARM_TIME_S = [5, 10, 15] as const;
const GRID_TRIGGER_OFFSET_PTS = [0.5, 1.0, 1.5, 2.0, 3.0] as const;
const GRID_REFERENCE = ['bid_ask', 'microprice', 'mid'] as const;
const GRID_STOP_LIMIT_PROTECTION_PTS = [null, 0.5, 1.0, 1.5] as const;
const GRID_LATENCY_BUCKET_MS = [0, 100, 500, 1000] as const;
const EXPECTED_SESSION_COUNT = 30;
const EXPECTED_ROWS_PER_SESSION = 720;
const CANCEL_AFTER_OFFSET_NS = 300n * NS_PER_SECOND;

type ReferenceKind = typeof GRID_REFERENCE[number];
type Outcome = 'neither' | 'buy_only' | 'sell_only' | 'both_sides';
type TriggerSide = 'buy' | 'sell';

interface ManifestSession {
  readonly session_date: string;
  readonly data_present: boolean;
  readonly is_rth: boolean;
  readonly imbalance_anchor_ts_ns_i0: number;
}

interface Manifest {
  readonly sessions: readonly ManifestSession[];
}

interface QuoteEvent {
  readonly sessionDate: string;
  readonly ts: bigint;
  readonly sourceSeq: number;
  readonly bidPxPts: number;
  readonly askPxPts: number;
  readonly bidSz: number;
  readonly askSz: number;
}

interface TradeEvent {
  readonly sessionDate: string;
  readonly ts: bigint;
  readonly sourceSeq: number;
  readonly tradePricePts: number;
  readonly tradeSize: number;
  readonly aggressorSide: string;
}

interface SessionEvents {
  readonly quotes: readonly QuoteEvent[];
  readonly trades: readonly TradeEvent[];
}

interface DetectionResult {
  readonly buyTrigger: QuoteEvent | null;
  readonly buyTriggerIndex: number | null;
  readonly sellTrigger: QuoteEvent | null;
  readonly sellTriggerIndex: number | null;
}

interface FillResult {
  readonly filled: boolean;
  readonly fillPricePts: number | null;
  readonly missReason: 'no_print_within_limit' | null;
}

interface ExcursionResult {
  readonly mfePts: number;
  readonly maePts: number;
}

function utf8(optional = false): Record<string, unknown> {
  return optional ? { type: 'UTF8', optional: true } : { type: 'UTF8' };
}

function int32(optional = false): Record<string, unknown> {
  return optional ? { type: 'INT32', optional: true } : { type: 'INT32' };
}

function int64(optional = false): Record<string, unknown> {
  return optional ? { type: 'INT64', optional: true } : { type: 'INT64' };
}

function double(optional = false): Record<string, unknown> {
  return optional ? { type: 'DOUBLE', optional: true } : { type: 'DOUBLE' };
}

function bool(optional = false): Record<string, unknown> {
  return optional ? { type: 'BOOLEAN', optional: true } : { type: 'BOOLEAN' };
}

const TRIGGERED_EVENTS_SCHEMA = new parquet.ParquetSchema({
  session_date: utf8(),
  arm_time_s: int32(),
  trigger_offset_pts: double(),
  reference: utf8(),
  stop_limit_protection_pts: double(true),
  latency_bucket_ms: int32(),
  armed_buy_stop_px_pts: double(),
  armed_sell_stop_px_pts: double(),
  armed_ref_px_pts: double(),
  armed_ts_offset_ns: int64(),
  buy_triggered_ts_offset_ns: int64(true),
  sell_triggered_ts_offset_ns: int64(true),
  outcome: utf8(),
  modeled_trigger_slippage_pts: double(true),
  stop_limit_filled: bool(true),
  stop_limit_fill_price_pts: double(true),
  stop_limit_miss_reason: utf8(true),
  post_trigger_mfe_pts: double(true),
  post_trigger_mae_pts: double(true),
  time_to_trigger_ns: int64(true),
});

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  verifyEventStreamAttestation();
  const manifest = readManifest();
  const sessions = manifest.sessions.filter((session) => session.data_present === true && session.is_rth === true);
  if (sessions.length !== EXPECTED_SESSION_COUNT) {
    throw new Error(`expected ${EXPECTED_SESSION_COUNT} data-present RTH sessions, got ${sessions.length}`);
  }
  if (sessions.some((session) => session.session_date === '2026-04-03')) {
    throw new Error('Good Friday leaked into MOC-R3 filtered session set');
  }
  const sessionByDate = new Map(sessions.map((session) => [session.session_date, session]));
  const writer = await openWriter(TRIGGERED_EVENTS_SCHEMA, TRIGGERED_EVENTS_PATH);
  let totalRows = 0;
  try {
    for await (const entry of readEventStreamBySession(EVENT_STREAM_PATH)) {
      const manifestSession = sessionByDate.get(entry.sessionDate);
      if (manifestSession === undefined) {
        continue;
      }
      const rows = simulateSession(manifestSession, entry.events);
      for (const row of rows) {
        await writer.appendRow(row);
      }
      totalRows += rows.length;
      console.log(`MOC-R3 simulated ${entry.sessionDate}: rows=${rows.length}`);
    }
  } finally {
    await writer.close();
  }
  const expectedRows = EXPECTED_SESSION_COUNT * EXPECTED_ROWS_PER_SESSION;
  if (totalRows !== expectedRows) {
    throw new Error(`expected ${expectedRows} triggered rows, got ${totalRows}`);
  }
  writeMethodology();
  console.log(`MOC-R3 wrote ${totalRows} rows to ${TRIGGERED_EVENTS_PATH}`);
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
}

function verifyEventStreamAttestation(): void {
  const expected = readFileSync(EVENT_STREAM_ATTESTATION_PATH, 'utf8').trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(EVENT_STREAM_PATH)).digest('hex');
  if (actual !== expected) {
    throw new Error(`event-stream SHA mismatch: ${actual} != ${expected}`);
  }
}

async function openWriter(schema: unknown, path: string) {
  const writer = await parquet.ParquetWriter.openFile(schema, path, { useDataPageV2: false });
  writer.setMetadata('moc_ticket', 'MOC-R3');
  writer.setMetadata('generated_at_note', 'Deterministic MOC-R3 parquet; no wall-clock timestamp emitted.');
  writer.setMetadata('event_stream_sha256', readFileSync(EVENT_STREAM_ATTESTATION_PATH, 'utf8').trim().split(/\s+/)[0] ?? '');
  writer.setRowGroupSize(4096);
  return writer;
}

async function* readEventStreamBySession(path: string): AsyncIterableIterator<{
  readonly sessionDate: string;
  readonly events: SessionEvents;
}> {
  const reader = await parquet.ParquetReader.openFile(path);
  try {
    const cursor = reader.getCursor();
    let currentSession: string | null = null;
    let quotes: QuoteEvent[] = [];
    let trades: TradeEvent[] = [];
    while (true) {
      const row = await cursor.next();
      if (row === null) {
        break;
      }
      const sessionDate = expectString(row.session_date, 'session_date');
      if (currentSession !== null && sessionDate !== currentSession) {
        yield { sessionDate: currentSession, events: { quotes, trades } };
        quotes = [];
        trades = [];
      }
      currentSession = sessionDate;
      const recordKind = expectString(row.record_kind, 'record_kind');
      if (recordKind === 'mbp1_quote') {
        quotes.push({
          sessionDate,
          ts: expectBigInt(row.ts_event_ns, 'ts_event_ns'),
          sourceSeq: expectInteger(row.source_seq, 'source_seq'),
          bidPxPts: expectNumber(row.bid_px_pts, 'bid_px_pts'),
          askPxPts: expectNumber(row.ask_px_pts, 'ask_px_pts'),
          bidSz: expectInteger(row.bid_sz, 'bid_sz'),
          askSz: expectInteger(row.ask_sz, 'ask_sz'),
        });
      } else if (recordKind === 'tbbo_trade') {
        trades.push({
          sessionDate,
          ts: expectBigInt(row.ts_event_ns, 'ts_event_ns'),
          sourceSeq: expectInteger(row.source_seq, 'source_seq'),
          tradePricePts: expectNumber(row.trade_price_pts, 'trade_price_pts'),
          tradeSize: expectInteger(row.trade_size, 'trade_size'),
          aggressorSide: row.aggressor_side === null || row.aggressor_side === undefined
            ? 'N'
            : expectString(row.aggressor_side, 'aggressor_side'),
        });
      } else {
        throw new Error(`unsupported record_kind: ${recordKind}`);
      }
    }
    if (currentSession !== null) {
      yield { sessionDate: currentSession, events: { quotes, trades } };
    }
  } finally {
    await reader.close();
  }
}

function simulateSession(session: ManifestSession, events: SessionEvents): readonly Record<string, unknown>[] {
  if (events.quotes.length === 0) {
    throw new Error(`no quotes for ${session.session_date}`);
  }
  const i0 = BigInt(session.imbalance_anchor_ts_ns_i0);
  const cancelAfterTs = i0 + CANCEL_AFTER_OFFSET_NS;
  const suffix = buildMidSuffix(events.quotes);
  const rows: Record<string, unknown>[] = [];
  for (const armTimeS of GRID_ARM_TIME_S) {
    const armedTs = i0 - BigInt(armTimeS) * NS_PER_SECOND;
    const armedQuoteIndex = latestQuoteIndexAtOrBefore(events.quotes, armedTs);
    if (armedQuoteIndex === null) {
      throw new Error(`missing armed quote for ${session.session_date} arm_time_s=${armTimeS}`);
    }
    const armedQuote = events.quotes[armedQuoteIndex];
    for (const triggerOffsetPts of GRID_TRIGGER_OFFSET_PTS) {
      for (const reference of GRID_REFERENCE) {
        const armedRefPxPts = referencePrice(armedQuote, reference);
        const armedBuyStopPxPts = round10(armedRefPxPts + triggerOffsetPts);
        const armedSellStopPxPts = round10(armedRefPxPts - triggerOffsetPts);
        const detection = detectTriggers(events.quotes, armedTs, armedBuyStopPxPts, armedSellStopPxPts);
        const outcome = classifyOutcome(detection);
        const earliest = earliestTrigger(detection);
        for (const stopLimitProtectionPts of GRID_STOP_LIMIT_PROTECTION_PTS) {
          const fill = earliest === null
            ? null
            : simulateFill(events.trades, earliest.side, earliest.event.ts, cancelAfterTs, earliest.stopPricePts, stopLimitProtectionPts);
          const excursion = earliest === null || earliest.quoteIndex === null
            ? null
            : computeExcursion(earliest.side, earliest.stopPricePts, suffix, earliest.quoteIndex);
          for (const latencyBucketMs of GRID_LATENCY_BUCKET_MS) {
            const slippage = earliest === null
              ? null
              : deterministicSlippagePts({
                sessionDate: session.session_date,
                armTimeS,
                triggerOffsetPts,
                reference,
                stopLimitProtectionPts,
                latencyBucketMs,
              });
            rows.push({
              session_date: session.session_date,
              arm_time_s: armTimeS,
              trigger_offset_pts: triggerOffsetPts,
              reference,
              stop_limit_protection_pts: stopLimitProtectionPts,
              latency_bucket_ms: latencyBucketMs,
              armed_buy_stop_px_pts: armedBuyStopPxPts,
              armed_sell_stop_px_pts: armedSellStopPxPts,
              armed_ref_px_pts: round10(armedRefPxPts),
              armed_ts_offset_ns: -BigInt(armTimeS) * NS_PER_SECOND,
              buy_triggered_ts_offset_ns: detection.buyTrigger === null ? null : detection.buyTrigger.ts - i0,
              sell_triggered_ts_offset_ns: detection.sellTrigger === null ? null : detection.sellTrigger.ts - i0,
              outcome,
              modeled_trigger_slippage_pts: slippage,
              stop_limit_filled: fill === null ? null : fill.filled,
              stop_limit_fill_price_pts: fill === null ? null : fill.fillPricePts,
              stop_limit_miss_reason: fill === null ? null : fill.missReason,
              post_trigger_mfe_pts: excursion === null ? null : excursion.mfePts,
              post_trigger_mae_pts: excursion === null ? null : excursion.maePts,
              time_to_trigger_ns: earliest === null ? null : earliest.event.ts - armedTs,
            });
          }
        }
      }
    }
  }
  if (rows.length !== EXPECTED_ROWS_PER_SESSION) {
    throw new Error(`expected ${EXPECTED_ROWS_PER_SESSION} rows for ${session.session_date}, got ${rows.length}`);
  }
  return rows;
}

function referencePrice(quote: QuoteEvent, reference: ReferenceKind): number {
  const mid = (quote.bidPxPts + quote.askPxPts) / 2;
  if (reference === 'bid_ask' || reference === 'mid') {
    return mid;
  }
  const denominator = quote.bidSz + quote.askSz;
  return denominator === 0 ? mid : (quote.bidPxPts * quote.askSz + quote.askPxPts * quote.bidSz) / denominator;
}

function detectTriggers(
  quotes: readonly QuoteEvent[],
  armedTs: bigint,
  buyStopPxPts: number,
  sellStopPxPts: number,
): DetectionResult {
  const startIndex = lowerBoundQuoteTs(quotes, armedTs);
  let buyTrigger: QuoteEvent | null = null;
  let buyTriggerIndex: number | null = null;
  let sellTrigger: QuoteEvent | null = null;
  let sellTriggerIndex: number | null = null;
  for (let index = startIndex; index < quotes.length; index += 1) {
    const quote = quotes[index]!;
    if (buyTrigger === null && quote.askPxPts >= buyStopPxPts) {
      buyTrigger = quote;
      buyTriggerIndex = index;
    }
    if (sellTrigger === null && quote.bidPxPts <= sellStopPxPts) {
      sellTrigger = quote;
      sellTriggerIndex = index;
    }
    if (buyTrigger !== null && sellTrigger !== null) {
      break;
    }
  }
  return { buyTrigger, buyTriggerIndex, sellTrigger, sellTriggerIndex };
}

function classifyOutcome(detection: DetectionResult): Outcome {
  if (detection.buyTrigger !== null && detection.sellTrigger !== null) return 'both_sides';
  if (detection.buyTrigger !== null) return 'buy_only';
  if (detection.sellTrigger !== null) return 'sell_only';
  return 'neither';
}

function earliestTrigger(detection: DetectionResult): {
  readonly side: TriggerSide;
  readonly event: QuoteEvent;
  readonly quoteIndex: number;
  readonly stopPricePts: number;
} | null {
  if (detection.buyTrigger === null && detection.sellTrigger === null) {
    return null;
  }
  if (detection.sellTrigger === null || (
    detection.buyTrigger !== null && detection.buyTrigger.ts <= detection.sellTrigger.ts
  )) {
    return {
      side: 'buy',
      event: detection.buyTrigger!,
      quoteIndex: detection.buyTriggerIndex!,
      stopPricePts: detection.buyTrigger!.askPxPts,
    };
  }
  return {
    side: 'sell',
    event: detection.sellTrigger,
    quoteIndex: detection.sellTriggerIndex!,
    stopPricePts: detection.sellTrigger.bidPxPts,
  };
}

function simulateFill(
  trades: readonly TradeEvent[],
  side: TriggerSide,
  triggerTs: bigint,
  cancelAfterTs: bigint,
  stopPricePts: number,
  protectionPts: number | null,
): FillResult {
  const startIndex = lowerBoundTradeTs(trades, triggerTs);
  const limitPrice = protectionPts === null
    ? null
    : side === 'buy'
      ? stopPricePts + protectionPts
      : stopPricePts - protectionPts;
  for (let index = startIndex; index < trades.length; index += 1) {
    const trade = trades[index]!;
    if (trade.ts > cancelAfterTs) {
      break;
    }
    const qualifies = limitPrice === null
      || (side === 'buy' ? trade.tradePricePts <= limitPrice : trade.tradePricePts >= limitPrice);
    if (qualifies) {
      return { filled: true, fillPricePts: round10(trade.tradePricePts), missReason: null };
    }
  }
  return { filled: false, fillPricePts: null, missReason: 'no_print_within_limit' };
}

function buildMidSuffix(quotes: readonly QuoteEvent[]): {
  readonly minMidFromIndex: readonly number[];
  readonly maxMidFromIndex: readonly number[];
} {
  const minMidFromIndex = new Array<number>(quotes.length);
  const maxMidFromIndex = new Array<number>(quotes.length);
  for (let index = quotes.length - 1; index >= 0; index -= 1) {
    const mid = midPrice(quotes[index]!);
    minMidFromIndex[index] = index === quotes.length - 1 ? mid : Math.min(mid, minMidFromIndex[index + 1]!);
    maxMidFromIndex[index] = index === quotes.length - 1 ? mid : Math.max(mid, maxMidFromIndex[index + 1]!);
  }
  return { minMidFromIndex, maxMidFromIndex };
}

function computeExcursion(
  side: TriggerSide,
  stopPricePts: number,
  suffix: { readonly minMidFromIndex: readonly number[]; readonly maxMidFromIndex: readonly number[] },
  quoteIndex: number,
): ExcursionResult {
  if (side === 'buy') {
    return {
      mfePts: round10(suffix.maxMidFromIndex[quoteIndex]! - stopPricePts),
      maePts: round10(suffix.minMidFromIndex[quoteIndex]! - stopPricePts),
    };
  }
  return {
    mfePts: round10(stopPricePts - suffix.minMidFromIndex[quoteIndex]!),
    maePts: round10(stopPricePts - suffix.maxMidFromIndex[quoteIndex]!),
  };
}

function deterministicSlippagePts(input: {
  readonly sessionDate: string;
  readonly armTimeS: number;
  readonly triggerOffsetPts: number;
  readonly reference: ReferenceKind;
  readonly stopLimitProtectionPts: number | null;
  readonly latencyBucketMs: number;
}): number {
  const seed = seedForCell(input);
  const sample = sampleMarketableAdverseSlippage({
    base_slippage_points: input.latencyBucketMs / 1000,
    extra_tick_probability: input.latencyBucketMs === 0 ? 0 : 0.1,
    contract: CONTRACT_SPECS.MNQ,
    rng: new FixedSeedRandomSource(seed),
  });
  return round10(sample.slippage_points);
}

function seedForCell(input: {
  readonly sessionDate: string;
  readonly armTimeS: number;
  readonly triggerOffsetPts: number;
  readonly reference: ReferenceKind;
  readonly stopLimitProtectionPts: number | null;
  readonly latencyBucketMs: number;
}): number {
  const payload = [
    input.sessionDate,
    String(input.armTimeS),
    input.triggerOffsetPts.toFixed(1),
    input.reference,
    input.stopLimitProtectionPts === null ? 'null' : input.stopLimitProtectionPts.toFixed(1),
    String(input.latencyBucketMs),
  ].join('|');
  const digest = createHash('sha256').update(payload).digest();
  const seed = digest.readUInt32BE(0);
  return seed === 0 ? 0x5eed_2026 : seed;
}

function latestQuoteIndexAtOrBefore(quotes: readonly QuoteEvent[], ts: bigint): number | null {
  const index = upperBoundQuoteTs(quotes, ts) - 1;
  return index < 0 ? null : index;
}

function lowerBoundQuoteTs(quotes: readonly QuoteEvent[], ts: bigint): number {
  let low = 0;
  let high = quotes.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (quotes[mid]!.ts < ts) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBoundQuoteTs(quotes: readonly QuoteEvent[], ts: bigint): number {
  let low = 0;
  let high = quotes.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (quotes[mid]!.ts <= ts) low = mid + 1;
    else high = mid;
  }
  return low;
}

function lowerBoundTradeTs(trades: readonly TradeEvent[], ts: bigint): number {
  let low = 0;
  let high = trades.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (trades[mid]!.ts < ts) low = mid + 1;
    else high = mid;
  }
  return low;
}

function midPrice(quote: QuoteEvent): number {
  return (quote.bidPxPts + quote.askPxPts) / 2;
}

function round10(value: number): number {
  return Number(value.toFixed(10));
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite number`);
  return value;
}

function expectInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} must be integer`);
  return value;
}

function expectBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new Error(`${label} must be bigint`);
  return value;
}

function writeMethodology(): void {
  const content = `# MOC-R3 trigger-conditional simulator methodology

MOC-R3 reads R2's \`event-stream.parquet\`, verified against
\`scratch/moc-research/event-stream.sha256.txt\` before simulation. The
input stream is regenerated locally because it is intentionally gitignored.
The expected R2 stream SHA is
\`f9effd810b609c03394e96c69e473e9d388eec82accdcbf8975494a307c330cb\`.

The simulator processes the 30 R1 manifest rows where \`data_present=true\`
and \`is_rth=true\`; the synthesized Good Friday row is excluded. For each
session it emits the full 720-cell grid: 3 arm times, 5 trigger offsets, 3
reference choices, 4 stop-limit protections, and 4 latency buckets.

Trigger detection uses event-level MBP-1 quotes only. Buy stops trigger on
the first quote with ask >= stop price; sell stops trigger on the first quote
with bid <= stop price. Stop-limit fills use event-level trade prints from
the trigger timestamp through I0+300s.

Slippage is deterministic. The seed is sha256(session_date|arm_time_s|
trigger_offset_pts|reference|stop_limit_protection_pts|latency_bucket_ms),
truncated to a uint32 and passed to FixedSeedRandomSource before calling
sampleMarketableAdverseSlippage. Byte-equal parquet output across two runs is
the load-bearing determinism gate.

For outcome=both_sides, both trigger timestamp fields are populated. The Plan
A R3 schema has singular fill and excursion fields, so those fields summarize
the earliest trigger side deterministically; production atomic OCO cancellation
is out of scope for this research-tier simulator.

Rows are sorted by session_date, arm_time_s, trigger_offset_pts, reference,
stop_limit_protection_pts, and latency_bucket_ms. Parquet metadata is static
and contains no wall-clock timestamp.
`;
  writeFileSync(join(OUTPUT_DIR, 'triggered-events-methodology.md'), content, 'utf8');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
