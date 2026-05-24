import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDbnFile } from '../../apps/strategy_runtime/src/data/dbn-loader.js';
import type {
  DbnMbp1Record,
  DbnTradesRecord,
} from '../../apps/strategy_runtime/src/data/dbn-types.js';

const require = createRequire(import.meta.url);
const parquet = require('parquetjs-lite') as {
  ParquetSchema: new (definition: Record<string, unknown>) => unknown;
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
const MANIFEST_PATH = join(REPO_ROOT, 'scratch', 'moc-research', 'event-day-manifest.json');
const CORPUS_ROOT = join(REPO_ROOT, 'data', 'databento', 'sim03_corpus');
const OUTPUT_DIR = process.env.MOC_R2_OUTPUT_DIR ?? join(REPO_ROOT, 'scratch', 'moc-research');
const DECOMPRESS_CACHE_DIR = join(REPO_ROOT, 'scratch', 'moc-research', '.tmp', 'dbn-decompress-cache');

const NS_PER_SECOND = 1_000_000_000n;
const PRICE_SCALE = 1_000_000_000;
const TICK_SIZE_POINTS = 0.25;
const HORIZONS = [1, 5, 10, 30, 60, 120, 300] as const;
const WINDOW_START_OFFSET_S = -30;
const WINDOW_END_OFFSET_S = 300;
const SAME_DOW_ZSCORE_WINDOW = 20;

type RecordKind = 'mbp1_quote' | 'tbbo_trade';

interface ManifestSession {
  readonly session_date: string;
  readonly session_date_et: string;
  readonly day_of_week: string;
  readonly data_present: boolean;
  readonly is_rth: boolean;
  readonly imbalance_anchor_ts_ns_i0: number;
}

interface Manifest {
  readonly sessions: readonly ManifestSession[];
}

interface QuoteState {
  readonly ts: bigint;
  readonly bidPxPts: number;
  readonly askPxPts: number;
  readonly bidSz: number;
  readonly askSz: number;
  readonly sourceOrdinal: number;
}

interface TradeState {
  readonly ts: bigint;
  readonly tradePricePts: number;
  readonly tradeSize: number;
  readonly aggressorSide: 'B' | 'A' | 'N';
  readonly sourceOrdinal: number;
}

type StreamEvent =
  | ({ readonly recordKind: 'mbp1_quote' } & QuoteState)
  | ({ readonly recordKind: 'tbbo_trade' } & TradeState);

interface PathRow {
  readonly session_date: string;
  readonly ts_offset_s: number;
  readonly bid_px_pts: number;
  readonly ask_px_pts: number;
  readonly bid_sz: number;
  readonly ask_sz: number;
  readonly mid_pts: number;
  readonly microprice_pts: number;
  readonly spread_ticks: number;
  readonly trade_count: number;
  readonly volume_contracts: number;
  readonly buy_aggressor_volume: number;
  readonly sell_aggressor_volume: number;
  readonly trade_aggressor_imbalance: number;
  readonly queue_imbalance_top: number;
  readonly mbp10_bid_depth_5_levels: null;
  readonly mbp10_ask_depth_5_levels: null;
}

interface SessionExtraction {
  readonly streamRows: readonly Record<string, unknown>[];
  readonly pathRows: readonly PathRow[];
  readonly aggregateBase: Record<string, unknown>;
  readonly preEventVolume: number;
  readonly dayOfWeek: string;
}

function utf8(optional = false): Record<string, unknown> {
  return optional ? { type: 'UTF8', optional: true } : { type: 'UTF8' };
}

function int32(optional = false): Record<string, unknown> {
  return optional ? { type: 'INT32', optional: true } : { type: 'INT32' };
}

function int64(): Record<string, unknown> {
  return { type: 'INT64' };
}

function double(optional = false): Record<string, unknown> {
  return optional ? { type: 'DOUBLE', optional: true } : { type: 'DOUBLE' };
}

const EVENT_STREAM_SCHEMA = new parquet.ParquetSchema({
  session_date: utf8(),
  ts_event_ns: int64(),
  source_seq: int32(),
  record_kind: utf8(),
  bid_px_pts: double(true),
  ask_px_pts: double(true),
  bid_sz: int32(true),
  ask_sz: int32(true),
  trade_price_pts: double(true),
  trade_size: int32(true),
  aggressor_side: utf8(true),
});

const EVENT_PATHS_SCHEMA = new parquet.ParquetSchema({
  session_date: utf8(),
  ts_offset_s: int32(),
  bid_px_pts: double(),
  ask_px_pts: double(),
  bid_sz: int32(),
  ask_sz: int32(),
  mid_pts: double(),
  microprice_pts: double(),
  spread_ticks: int32(),
  trade_count: int32(),
  volume_contracts: int32(),
  buy_aggressor_volume: int32(),
  sell_aggressor_volume: int32(),
  trade_aggressor_imbalance: double(),
  queue_imbalance_top: double(),
  mbp10_bid_depth_5_levels: int32(true),
  mbp10_ask_depth_5_levels: int32(true),
});

const aggregateSchemaDefinition: Record<string, unknown> = {
  session_date: utf8(),
  time_to_up_mfe_at_300s_seconds: int32(),
  time_to_down_mfe_at_300s_seconds: int32(),
  first_5s_range_pts: double(),
  first_30s_range_pts: double(),
  first_60s_range_pts: double(),
  pre_event_spread_ticks_t_minus_30s: int32(),
  pre_event_spread_ticks_t_minus_10s: int32(),
  pre_event_spread_ticks_t_zero: int32(),
  pre_event_imbalance_t_minus_30s: double(),
  pre_event_imbalance_t_minus_10s: double(),
  pre_event_volume_z_score: double(true),
};
for (const horizon of HORIZONS) {
  aggregateSchemaDefinition[`mfe_signed_pts_at_${horizon}s`] = double();
  aggregateSchemaDefinition[`mfe_abs_pts_at_${horizon}s`] = double();
  aggregateSchemaDefinition[`mae_signed_pts_at_${horizon}s`] = double();
  aggregateSchemaDefinition[`mae_abs_pts_at_${horizon}s`] = double();
}
for (const horizon of HORIZONS) {
  aggregateSchemaDefinition[`close_signed_pts_at_${horizon}s`] = double();
}
const EVENT_AGGREGATES_SCHEMA = new parquet.ParquetSchema(aggregateSchemaDefinition);

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const manifest = readManifest();
  const sessions = manifest.sessions.filter((row) => row.data_present === true && row.is_rth === true);
  if (manifest.sessions.length !== 31 || sessions.length !== 30) {
    throw new Error(`unexpected R1 filter shape: manifest=${manifest.sessions.length} filtered=${sessions.length}`);
  }
  if (sessions.some((row) => row.session_date === '2026-04-03')) {
    throw new Error('Good Friday leaked into the data-present RTH session set');
  }

  const streamWriter = await openWriter(EVENT_STREAM_SCHEMA, join(OUTPUT_DIR, 'event-stream.parquet'));
  const pathWriter = await openWriter(EVENT_PATHS_SCHEMA, join(OUTPUT_DIR, 'event-paths.parquet'));
  const aggregateBases: SessionExtraction[] = [];

  try {
    for (const session of sessions) {
      const extracted = await extractSession(session);
      aggregateBases.push(extracted);
      for (const row of extracted.streamRows) {
        await streamWriter.appendRow(row);
      }
      for (const row of extracted.pathRows) {
        await pathWriter.appendRow(row as unknown as Record<string, unknown>);
      }
      console.log(
        `MOC-R2 extracted ${session.session_date}: stream=${extracted.streamRows.length} path=${extracted.pathRows.length}`,
      );
    }
  } finally {
    await streamWriter.close();
    await pathWriter.close();
  }

  const aggregateRows = finalizeAggregateRows(aggregateBases);
  const aggregateWriter = await openWriter(EVENT_AGGREGATES_SCHEMA, join(OUTPUT_DIR, 'event-aggregates.parquet'));
  try {
    for (const row of aggregateRows) {
      await aggregateWriter.appendRow(row);
    }
  } finally {
    await aggregateWriter.close();
  }

  writeMethodology();
  console.log(`MOC-R2 wrote outputs under ${OUTPUT_DIR}`);
}

function readManifest(): Manifest {
  const payload = JSON.parse(require('node:fs').readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  return payload;
}

async function openWriter(schema: unknown, path: string) {
  const writer = await parquet.ParquetWriter.openFile(schema, path, { useDataPageV2: false });
  writer.setMetadata('moc_ticket', 'MOC-R2');
  writer.setMetadata('generated_at_note', 'Deterministic MOC-R2 parquet; no wall-clock timestamp emitted.');
  writer.setRowGroupSize(4096);
  return writer;
}

async function extractSession(session: ManifestSession): Promise<SessionExtraction> {
  const i0 = BigInt(session.imbalance_anchor_ts_ns_i0);
  const windowStart = i0 + BigInt(WINDOW_START_OFFSET_S) * NS_PER_SECOND;
  const windowEnd = i0 + BigInt(WINDOW_END_OFFSET_S) * NS_PER_SECOND;
  const sessionDir = join(CORPUS_ROOT, `${session.session_date}-rth`);
  const mbp1Path = join(sessionDir, 'mbp-1.dbn.zst');
  const tradesPath = join(sessionDir, 'trades.dbn.zst');

  const quotes = await loadQuoteWindow(mbp1Path, windowStart, windowEnd);
  const trades = await loadTradeWindow(tradesPath, windowStart, windowEnd);
  if (quotes.seed === null) {
    throw new Error(`no pre-window MBP-1 quote seed for ${session.session_date}`);
  }

  const streamEvents: StreamEvent[] = [
    ...quotes.window.map((quote) => ({ ...quote, recordKind: 'mbp1_quote' as const })),
    ...trades.window.map((trade) => ({ ...trade, recordKind: 'tbbo_trade' as const })),
  ].sort(compareStreamEvents);

  const streamRows = streamEvents.map((event, index) => streamEventToRow(session.session_date, event, index));
  const pathRows = buildPathRows(session, i0, quotes.seed, quotes.window, trades.window);
  const aggregateBase = buildAggregateBase(session.session_date, pathRows);
  const preEventVolume = pathRows
    .filter((row) => row.ts_offset_s <= 0)
    .reduce((total, row) => total + row.volume_contracts, 0);

  return {
    streamRows,
    pathRows,
    aggregateBase,
    preEventVolume,
    dayOfWeek: session.day_of_week,
  };
}

async function loadQuoteWindow(path: string, start: bigint, end: bigint): Promise<{
  readonly seed: QuoteState | null;
  readonly window: readonly QuoteState[];
}> {
  try {
    return await loadQuoteWindowFromRecords(loadDbnFile(path, 'mbp-1'), start, end);
  } catch (error) {
    if (!isZstdFrameError(error)) {
      throw error;
    }
    const decompressedPath = await decompressZstdToCache(path);
    return await loadQuoteWindowFromRecords(loadDbnFile(decompressedPath, 'mbp-1'), start, end);
  }
}

async function loadQuoteWindowFromRecords(
  records: AsyncIterable<unknown>,
  start: bigint,
  end: bigint,
): Promise<{
  readonly seed: QuoteState | null;
  readonly window: readonly QuoteState[];
}> {
  const window: QuoteState[] = [];
  let seed: QuoteState | null = null;
  let ordinal = 0;
  for await (const record of records) {
    const mbp = record as DbnMbp1Record;
    const quote = quoteState(mbp, ordinal);
    ordinal += 1;
    if (mbp.ts_event < start) {
      seed = quote;
      continue;
    }
    if (mbp.ts_event > end) {
      break;
    }
    window.push(quote);
  }
  return { seed, window };
}

async function loadTradeWindow(path: string, start: bigint, end: bigint): Promise<{
  readonly window: readonly TradeState[];
}> {
  try {
    return await loadTradeWindowFromRecords(loadDbnFile(path, 'trades'), start, end);
  } catch (error) {
    if (!isZstdFrameError(error)) {
      throw error;
    }
    const decompressedPath = await decompressZstdToCache(path);
    return await loadTradeWindowFromRecords(loadDbnFile(decompressedPath, 'trades'), start, end);
  }
}

async function loadTradeWindowFromRecords(
  records: AsyncIterable<unknown>,
  start: bigint,
  end: bigint,
): Promise<{
  readonly window: readonly TradeState[];
}> {
  const window: TradeState[] = [];
  let ordinal = 0;
  for await (const record of records) {
    const trade = record as DbnTradesRecord;
    if (trade.ts_event < start) {
      ordinal += 1;
      continue;
    }
    if (trade.ts_event > end) {
      break;
    }
    window.push({
      ts: trade.ts_event,
      tradePricePts: toPoints(trade.price),
      tradeSize: trade.size,
      aggressorSide: trade.aggressor_side,
      sourceOrdinal: ordinal,
    });
    ordinal += 1;
  }
  return { window };
}

function isZstdFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Frame requires too much memory') || message.includes('Unsupported frame parameter');
}

async function decompressZstdToCache(path: string): Promise<string> {
  mkdirSync(DECOMPRESS_CACHE_DIR, { recursive: true });
  const key = createHash('sha256').update(path).digest('hex').slice(0, 24);
  const outputPath = join(DECOMPRESS_CACHE_DIR, `${key}.dbn`);
  if (existsSync(outputPath)) {
    return outputPath;
  }
  const tmpPath = `${outputPath}.tmp`;
  const script = [
    'import pathlib, sys, zstandard as zstd',
    'src = pathlib.Path(sys.argv[1])',
    'dst = pathlib.Path(sys.argv[2])',
    'dctx = zstd.ZstdDecompressor()',
    'with src.open("rb") as fh, dctx.stream_reader(fh, read_across_frames=True) as reader, dst.open("wb") as out:',
    '    while True:',
    '        chunk = reader.read(8 * 1024 * 1024)',
    '        if not chunk:',
    '            break',
    '        out.write(chunk)',
  ].join('\n');
  await runPython(script, [path, tmpPath]);
  renameSync(tmpPath, outputPath);
  return outputPath;
}

async function runPython(script: string, args: readonly string[]): Promise<void> {
  const child = spawn('python', ['-c', script, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
  });
  if (exitCode !== 0) {
    throw new Error(`python zstandard decompression failed: ${stderr.trim()}`);
  }
}

function quoteState(record: DbnMbp1Record, sourceOrdinal: number): QuoteState {
  const top = record.levels[0];
  if (top === undefined) {
    throw new Error(`MBP-1 record missing top-of-book level at ${record.ts_event}`);
  }
  return {
    ts: record.ts_event,
    bidPxPts: toPoints(top.bid_px),
    askPxPts: toPoints(top.ask_px),
    bidSz: top.bid_sz,
    askSz: top.ask_sz,
    sourceOrdinal,
  };
}

function buildPathRows(
  session: ManifestSession,
  i0: bigint,
  seedQuote: QuoteState,
  quoteUpdates: readonly QuoteState[],
  trades: readonly TradeState[],
): readonly PathRow[] {
  const rows: PathRow[] = [];
  let quoteCursor = 0;
  let tradeCursor = 0;
  let currentQuote = seedQuote;
  let previousBinClose = i0 + BigInt(WINDOW_START_OFFSET_S - 1) * NS_PER_SECOND;

  for (let offset = WINDOW_START_OFFSET_S; offset <= WINDOW_END_OFFSET_S; offset += 1) {
    const binClose = i0 + BigInt(offset) * NS_PER_SECOND;
    while (quoteCursor < quoteUpdates.length && quoteUpdates[quoteCursor]!.ts <= binClose) {
      currentQuote = quoteUpdates[quoteCursor]!;
      quoteCursor += 1;
    }

    let tradeCount = 0;
    let volumeContracts = 0;
    let buyAggressorVolume = 0;
    let sellAggressorVolume = 0;
    while (tradeCursor < trades.length && trades[tradeCursor]!.ts <= binClose) {
      const trade = trades[tradeCursor]!;
      if (trade.ts > previousBinClose) {
        tradeCount += 1;
        volumeContracts += trade.tradeSize;
        if (trade.aggressorSide === 'B') buyAggressorVolume += trade.tradeSize;
        if (trade.aggressorSide === 'A') sellAggressorVolume += trade.tradeSize;
      }
      tradeCursor += 1;
    }

    const mid = (currentQuote.bidPxPts + currentQuote.askPxPts) / 2;
    const microDenominator = currentQuote.bidSz + currentQuote.askSz;
    const microprice =
      microDenominator === 0
        ? mid
        : (currentQuote.bidPxPts * currentQuote.askSz + currentQuote.askPxPts * currentQuote.bidSz)
          / microDenominator;
    const spreadTicks = Math.round((currentQuote.askPxPts - currentQuote.bidPxPts) / TICK_SIZE_POINTS);
    const tradeAggressorDenominator = buyAggressorVolume + sellAggressorVolume;
    const tradeAggressorImbalance =
      tradeAggressorDenominator === 0
        ? 0
        : (buyAggressorVolume - sellAggressorVolume) / tradeAggressorDenominator;
    const queueDenominator = currentQuote.bidSz + currentQuote.askSz;
    const queueImbalance =
      queueDenominator === 0 ? 0 : (currentQuote.bidSz - currentQuote.askSz) / queueDenominator;

    rows.push({
      session_date: session.session_date,
      ts_offset_s: offset,
      bid_px_pts: round10(currentQuote.bidPxPts),
      ask_px_pts: round10(currentQuote.askPxPts),
      bid_sz: currentQuote.bidSz,
      ask_sz: currentQuote.askSz,
      mid_pts: round10(mid),
      microprice_pts: round10(microprice),
      spread_ticks: spreadTicks,
      trade_count: tradeCount,
      volume_contracts: volumeContracts,
      buy_aggressor_volume: buyAggressorVolume,
      sell_aggressor_volume: sellAggressorVolume,
      trade_aggressor_imbalance: round10(tradeAggressorImbalance),
      queue_imbalance_top: round10(queueImbalance),
      mbp10_bid_depth_5_levels: null,
      mbp10_ask_depth_5_levels: null,
    });
    previousBinClose = binClose;
  }
  if (rows.length !== 331) {
    throw new Error(`expected 331 path rows for ${session.session_date}, got ${rows.length}`);
  }
  return rows;
}

function buildAggregateBase(sessionDate: string, pathRows: readonly PathRow[]): Record<string, unknown> {
  const byOffset = new Map(pathRows.map((row) => [row.ts_offset_s, row]));
  const reference = byOffset.get(0);
  if (reference === undefined) {
    throw new Error(`missing I0 path row for ${sessionDate}`);
  }
  const referenceMid = reference.mid_pts;
  const rowsFromI0 = pathRows.filter((row) => row.ts_offset_s >= 0);
  const moves = new Map(rowsFromI0.map((row) => [row.ts_offset_s, round10(row.mid_pts - referenceMid)]));
  const output: Record<string, unknown> = { session_date: sessionDate };

  for (const horizon of HORIZONS) {
    const horizonMoves = [...moves]
      .filter(([offset]) => offset <= horizon)
      .sort(([a], [b]) => a - b);
    const values = horizonMoves.map(([, value]) => value);
    const up = Math.max(...values);
    const down = Math.min(...values);
    output[`mfe_signed_pts_at_${horizon}s`] = round10(up);
    output[`mfe_abs_pts_at_${horizon}s`] = round10(Math.abs(up));
    output[`mae_signed_pts_at_${horizon}s`] = round10(down);
    output[`mae_abs_pts_at_${horizon}s`] = round10(Math.abs(down));
    output[`close_signed_pts_at_${horizon}s`] = moves.get(horizon) ?? null;
  }

  const moves300 = [...moves].filter(([offset]) => offset <= 300).sort(([a], [b]) => a - b);
  const up300 = Math.max(...moves300.map(([, value]) => value));
  const down300 = Math.min(...moves300.map(([, value]) => value));
  output.time_to_up_mfe_at_300s_seconds = moves300.find(([, value]) => value === up300)?.[0] ?? 0;
  output.time_to_down_mfe_at_300s_seconds = moves300.find(([, value]) => value === down300)?.[0] ?? 0;
  output.first_5s_range_pts = rangePts(rowsFromI0, 5);
  output.first_30s_range_pts = rangePts(rowsFromI0, 30);
  output.first_60s_range_pts = rangePts(rowsFromI0, 60);
  output.pre_event_spread_ticks_t_minus_30s = requireOffset(byOffset, -30).spread_ticks;
  output.pre_event_spread_ticks_t_minus_10s = requireOffset(byOffset, -10).spread_ticks;
  output.pre_event_spread_ticks_t_zero = requireOffset(byOffset, 0).spread_ticks;
  output.pre_event_imbalance_t_minus_30s = requireOffset(byOffset, -30).queue_imbalance_top;
  output.pre_event_imbalance_t_minus_10s = requireOffset(byOffset, -10).queue_imbalance_top;
  return output;
}

function finalizeAggregateRows(sessions: readonly SessionExtraction[]): readonly Record<string, unknown>[] {
  const historyByDow = new Map<string, number[]>();
  return sessions.map((session) => {
    const history = historyByDow.get(session.dayOfWeek) ?? [];
    const zScore =
      history.length >= SAME_DOW_ZSCORE_WINDOW
        ? round10((session.preEventVolume - mean(history.slice(-SAME_DOW_ZSCORE_WINDOW))) / stddev(history.slice(-SAME_DOW_ZSCORE_WINDOW)))
        : null;
    historyByDow.set(session.dayOfWeek, [...history, session.preEventVolume]);
    return { ...session.aggregateBase, pre_event_volume_z_score: zScore };
  });
}

function rangePts(rows: readonly PathRow[], horizon: number): number {
  const values = rows.filter((row) => row.ts_offset_s <= horizon).map((row) => row.mid_pts);
  return round10(Math.max(...values) - Math.min(...values));
}

function requireOffset(rows: ReadonlyMap<number, PathRow>, offset: number): PathRow {
  const row = rows.get(offset);
  if (row === undefined) {
    throw new Error(`missing path row at offset ${offset}`);
  }
  return row;
}

function streamEventToRow(sessionDate: string, event: StreamEvent, sourceSeq: number): Record<string, unknown> {
  if (event.recordKind === 'mbp1_quote') {
    return {
      session_date: sessionDate,
      ts_event_ns: event.ts,
      source_seq: sourceSeq,
      record_kind: event.recordKind,
      bid_px_pts: round10(event.bidPxPts),
      ask_px_pts: round10(event.askPxPts),
      bid_sz: event.bidSz,
      ask_sz: event.askSz,
      trade_price_pts: null,
      trade_size: null,
      aggressor_side: null,
    };
  }
  return {
    session_date: sessionDate,
    ts_event_ns: event.ts,
    source_seq: sourceSeq,
    record_kind: event.recordKind,
    bid_px_pts: null,
    ask_px_pts: null,
    bid_sz: null,
    ask_sz: null,
    trade_price_pts: round10(event.tradePricePts),
    trade_size: event.tradeSize,
    aggressor_side: event.aggressorSide,
  };
}

function compareStreamEvents(left: StreamEvent, right: StreamEvent): number {
  if (left.ts < right.ts) return -1;
  if (left.ts > right.ts) return 1;
  const kind = kindOrder(left.recordKind) - kindOrder(right.recordKind);
  if (kind !== 0) return kind;
  return left.sourceOrdinal - right.sourceOrdinal;
}

function kindOrder(kind: RecordKind): number {
  return kind === 'mbp1_quote' ? 0 : 1;
}

function toPoints(value: bigint): number {
  return Number(value) / PRICE_SCALE;
}

function round10(value: number): number {
  return Number(value.toFixed(10));
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function stddev(values: readonly number[]): number {
  const avg = mean(values);
  const variance = values.reduce((total, value) => total + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance) || Number.POSITIVE_INFINITY;
}

function writeMethodology(): void {
  const content = `# MOC-R2 event-path methodology

MOC-R2 reads the MOC-R1 manifest and processes only rows where
\`data_present=true\` and \`is_rth=true\`. The R1 synthesized Good Friday row
for \`2026-04-03\` is excluded from all three parquet outputs by construction.

The extractor streams \`mbp-1.dbn.zst\` and \`trades.dbn.zst\` from
\`data/databento/sim03_corpus/\`. This corpus does not ship a separate
\`tbbo.dbn.zst\`; trade rows therefore populate the \`tbbo_trade\` record kind
with trade fields and null quote fields, while bid/ask, mid, and microprice
come from MBP-1.

## Large stream artifact attestation

\`event-stream.parquet\` is generated by:

\`\`\`powershell
npx tsx scratch/moc-research/extract-event-paths.mts
\`\`\`

The observed full-corpus run time is approximately 9-10 minutes on the
operator worktree. The file is intentionally gitignored because it is
434,731,353 bytes and exceeds GitHub's 100 MB single-file hard limit. Its
committed attestation is \`scratch/moc-research/event-stream.sha256.txt\`:

\`\`\`text
f9effd810b609c03394e96c69e473e9d388eec82accdcbf8975494a307c330cb  event-stream.parquet
\`\`\`

\`check-event-paths.py\` warns if the local stream parquet is absent and fails
if it is present with a mismatched SHA. The smaller
\`event-paths.parquet\` and \`event-aggregates.parquet\` artifacts remain
committed normally.

## MBP-1 ZSTD fallback

The Node DBN loader hit \`ZSTD_error_frameParameter_windowTooLarge\` on
\`data/databento/sim03_corpus/2026-04-22-rth/mbp-1.dbn.zst\`. The extractor
uses a scratch-only fallback for ZSTD frame errors: it invokes
\`python -c "import zstandard ..."\` to decompress the affected file into
\`scratch/moc-research/.tmp/dbn-decompress-cache/\`, then parses the
uncompressed DBN through the existing production loader. The fallback does
not modify production code, writes only ignored scratch temp files, and is
deterministic across re-runs. Re-running the extractor requires Python's
\`zstandard\` package in addition to the normal Node dependencies.

\`DATA-LOADER-FIX-01\` therefore covers both observed Node loader gaps:
\`ZSTD_error_frameParameter_unsupported\` on MBP-10 files and
\`ZSTD_error_frameParameter_windowTooLarge\` on at least the
\`2026-04-22\` MBP-1 file.

## Known limitations

MBP-10 is classified as Tier A required per
\`apps/strategy_runtime/src/contracts/tier-policy.ts\`. The current Node DBN
loader cannot decompress the ZSTD-framed MBP-10 files in the corpus
(\`ZSTD_error_frameParameter_unsupported\`). This gap is captured in
\`DATA-LOADER-FIX-01\` and tracked independently. For MOC-R2 scope, the two
\`mbp10_bid_depth_5_levels\` and \`mbp10_ask_depth_5_levels\` columns are
deterministic null; downstream consumers can branch on \`is_null\` until the
loader gap closes.

\`MOC-R2B\` is reserved for re-extracting MBP-10 depth fields only if
\`DATA-LOADER-FIX-01\` lands and MOC-R5 conditioning analysis identifies
depth-5 as an informative stratification dimension beyond top-of-book
imbalance. If MOC-R5 does not find that need, the null MBP-10 fields are the
accepted permanent state for this corpus.

All outputs are deterministic parquet files written with \`parquetjs-lite\`.
Rows are sorted by \`session_date\`, timestamp, and \`source_seq\`; metadata is
static and contains no wall-clock timestamp.

No-lookahead discipline: each 1s bin is computed only from records with
\`ts_event_ns <= bin_close_ts\`. The checker recomputes MBP-1/trade-derived
fields from \`event-stream.parquet\` to verify that invariant.
`;
  writeFileSync(join(OUTPUT_DIR, 'event-paths-methodology.md'), content, 'utf8');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
