import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  makeEventId,
  makeConfigHash,
  makeFeatureSnapshotId,
  makeSessionId,
  ns,
  type Bar,
  type InstrumentIdentity,
} from '../contracts/index.js';
import type {
  StrategyFeatureSnapshot,
  StrategyFeatureSnapshotRegime,
} from '../strategies/index.js';

const ONE_SECOND_NS = 1_000_000_000n;
const ONE_MINUTE_NS = 60n * ONE_SECOND_NS;
const RTH_OPEN_HOUR_UTC = 13;
const RTH_OPEN_MINUTE_UTC = 30;
const RTH_CLOSE_HOUR_UTC = 20;
const RTH_CLOSE_MINUTE_UTC = 0;
const WARMUP_BARS_REQUIRED = 14;
const TICK_SIZE = 0.25;
const POINT_VALUE = 2;
const PRICE_DECIMALS = 2;
const DEFAULT_SYMBOL = 'MNQU6';
const DEFAULT_CONTRACT_MONTH = '2026-09';
const PROCESSING_LAG_NS = 2n * ONE_SECOND_NS;
const POLL_INTERVAL_MS = 1_000;
export const LIVE_CAPTURE_FEATURE_BRIDGE_MAX_TRADE_SEED_BYTES = 128 * 1024 * 1024;
export const LIVE_CAPTURE_FEATURE_BRIDGE_MAX_QUOTE_SEED_BYTES = 64 * 1024 * 1024;
export const LIVE_CAPTURE_MINUTE_BAR_SEED_SCHEMA_VERSION = 1;
const LIVE_CAPTURE_FEATURE_BRIDGE_CONFIG_HASH = makeConfigHash(
  createHash('sha256').update('qfa612-live-local-capture-feature-bridge-v1', 'utf8').digest('hex'),
);
const BIGINT_QUOTED_FIELD_REGEX_CACHE = new Map<string, RegExp>();
const BIGINT_NUMERIC_FIELD_REGEX_CACHE = new Map<string, RegExp>();
const NUMBER_FIELD_REGEX_CACHE = new Map<string, RegExp>();

interface QuoteRow {
  readonly ts_ns: bigint;
  readonly bid_px: number;
  readonly ask_px: number;
  readonly mid_px: number;
}

interface MutableBar {
  start_ts_ns: bigint;
  end_ts_ns: bigint;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
}

interface MinuteBarSeedBar {
  readonly slot: number;
  readonly start_ts_ns: string;
  readonly end_ts_ns: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trade_count: number;
}

interface MinuteBarSeedFile {
  readonly schema_version: number;
  readonly record_type: string;
  readonly source_obs01_path: string;
  readonly source_obs01_size_bytes: number;
  readonly trading_date: string;
  readonly bars: readonly MinuteBarSeedBar[];
}

interface AppendState {
  offset: number;
  remainder: string;
}

export interface LiveLocalCaptureFeatureBridgeOptions {
  readonly obs01_path: string;
  readonly minute_bar_seed_path?: string;
  readonly regime_label: StrategyFeatureSnapshotRegime;
  readonly process_snapshot: (snapshot: StrategyFeatureSnapshot) => Promise<unknown>;
  readonly symbol?: string;
  readonly contract_month?: string;
}

export class LiveLocalCaptureFeatureBridge {
  private readonly obs01Path: string;
  private readonly mbp1Path: string;
  private readonly minuteBarSeedPath: string | undefined;
  private readonly regimeLabel: StrategyFeatureSnapshotRegime;
  private readonly processSnapshot: (snapshot: StrategyFeatureSnapshot) => Promise<unknown>;
  private readonly instrument: InstrumentIdentity;
  private readonly tradingDate: string;
  private readonly rthOpenNs: bigint;
  private readonly rthCloseNs: bigint;
  private readonly barsBySlot = new Map<number, MutableBar>();
  private readonly processedBars: Bar[] = [];
  private readonly quotes: QuoteRow[] = [];
  private tradeAppend: AppendState = { offset: 0, remainder: '' };
  private quoteAppend: AppendState = { offset: 0, remainder: '' };
  private quoteCursor = 0;
  private nextSlotToProcess = 0;
  private maxObservedNs: bigint | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private stopped = false;

  constructor(options: LiveLocalCaptureFeatureBridgeOptions) {
    this.obs01Path = options.obs01_path;
    this.mbp1Path = deriveMbp1Path(options.obs01_path);
    this.minuteBarSeedPath = options.minute_bar_seed_path;
    this.regimeLabel = options.regime_label;
    this.processSnapshot = options.process_snapshot;
    const symbol = options.symbol ?? DEFAULT_SYMBOL;
    this.instrument = {
      root: 'MNQ',
      symbol,
      exchange: 'CME',
      currency: 'USD',
      contract_month: options.contract_month ?? DEFAULT_CONTRACT_MONTH,
      tick_size: TICK_SIZE,
      point_value: POINT_VALUE,
      price_decimals: PRICE_DECIMALS,
    };
    this.tradingDate = parseTradingDateFromCapturePath(options.obs01_path);
    this.rthOpenNs = utcNs(this.tradingDate, RTH_OPEN_HOUR_UTC, RTH_OPEN_MINUTE_UTC);
    this.rthCloseNs = utcNs(this.tradingDate, RTH_CLOSE_HOUR_UTC, RTH_CLOSE_MINUTE_UTC);
  }

  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    if (!existsSync(this.obs01Path)) {
      throw new Error(`QFA live capture feature bridge requires OBS01 path to exist: ${this.obs01Path}`);
    }
    if (!existsSync(this.mbp1Path)) {
      throw new Error(`QFA live capture feature bridge requires sibling MBP1 path to exist: ${this.mbp1Path}`);
    }
    void this.bootstrap().catch((error: unknown) => {
      console.error('[qfa-live-capture-feature-bridge] bootstrap failed', error);
    });
    this.timer = setInterval(() => {
      void this.poll().catch((error: unknown) => {
        console.error('[qfa-live-capture-feature-bridge] poll failed', error);
      });
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async bootstrap(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      await this.seedQuotes();
      if (this.stopped) return;
      await this.seedTrades();
      if (this.stopped) return;
      this.primeHistoricalState();
    } finally {
      this.polling = false;
    }
  }

  private async seedQuotes(): Promise<void> {
    this.quoteAppend = readSeedLines(this.mbp1Path, LIVE_CAPTURE_FEATURE_BRIDGE_MAX_QUOTE_SEED_BYTES, (line) => {
      this.ingestQuoteLine(line);
    });
  }

  private async seedTrades(): Promise<void> {
    if (this.seedTradesFromMinuteBarSeed()) {
      return;
    }
    this.tradeAppend = readSeedLines(this.obs01Path, LIVE_CAPTURE_FEATURE_BRIDGE_MAX_TRADE_SEED_BYTES, (line) => {
      this.ingestTradeLine(line);
    });
  }

  private seedTradesFromMinuteBarSeed(): boolean {
    if (this.minuteBarSeedPath === undefined || this.minuteBarSeedPath.trim() === '') {
      return false;
    }
    if (!existsSync(this.minuteBarSeedPath)) {
      throw new Error(`QFA live capture feature bridge minute-bar seed is missing: ${this.minuteBarSeedPath}`);
    }
    const seed = JSON.parse(readFileSync(this.minuteBarSeedPath, 'utf8')) as MinuteBarSeedFile;
    if (seed.schema_version !== LIVE_CAPTURE_MINUTE_BAR_SEED_SCHEMA_VERSION || seed.record_type !== 'LIVE_CAPTURE_MINUTE_BAR_SEED') {
      throw new Error('QFA live capture feature bridge minute-bar seed schema is incompatible');
    }
    if (seed.trading_date !== this.tradingDate) {
      throw new Error(`QFA live capture feature bridge minute-bar seed trading date mismatch: ${seed.trading_date} !== ${this.tradingDate}`);
    }
    if (normalizePath(seed.source_obs01_path) !== normalizePath(this.obs01Path)) {
      throw new Error('QFA live capture feature bridge minute-bar seed source path does not match OBS01 path');
    }
    const currentSize = statSync(this.obs01Path).size;
    if (!Number.isSafeInteger(seed.source_obs01_size_bytes) || seed.source_obs01_size_bytes < 0 || seed.source_obs01_size_bytes > currentSize) {
      throw new Error('QFA live capture feature bridge minute-bar seed source offset is invalid for current OBS01 file');
    }
    for (const seedBar of seed.bars) {
      if (!Number.isInteger(seedBar.slot) || seedBar.slot < 0 || seedBar.slot >= 390) {
        continue;
      }
      const start = BigInt(seedBar.start_ts_ns);
      const end = BigInt(seedBar.end_ts_ns);
      this.barsBySlot.set(seedBar.slot, {
        start_ts_ns: start,
        end_ts_ns: end,
        open: seedBar.open,
        high: seedBar.high,
        low: seedBar.low,
        close: seedBar.close,
        volume: seedBar.volume,
        trade_count: seedBar.trade_count,
      });
      this.observeTs(end);
    }
    this.tradeAppend = { offset: seed.source_obs01_size_bytes, remainder: '' };
    return true;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const line of readAppendedLines(this.mbp1Path, this.quoteAppend)) {
        this.ingestQuoteLine(line);
      }
      for (const line of readAppendedLines(this.obs01Path, this.tradeAppend)) {
        this.ingestTradeLine(line);
      }
      await this.processCompletedSlots();
    } finally {
      this.polling = false;
    }
  }

  private primeHistoricalState(): void {
    if (this.maxObservedNs === null) return;
    const safeNs = this.maxObservedNs - PROCESSING_LAG_NS;
    while (this.nextSlotToProcess < 390) {
      const slotEndNs = this.rthOpenNs + BigInt(this.nextSlotToProcess + 1) * ONE_MINUTE_NS;
      if (slotEndNs > safeNs) break;
      const mutable = this.barsBySlot.get(this.nextSlotToProcess);
      this.nextSlotToProcess += 1;
      if (mutable !== undefined) {
        this.processedBars.push(toBar(this.instrument, mutable));
      }
    }
  }

  private ingestQuoteLine(line: string): void {
    if (line.trim() === '') return;
    const tsNs = extractBigintField(line, 'ts_event_ns') ?? extractBigintField(line, 'ts_recv_ns');
    const bidPx = extractNumberField(line, 'bid_px_00');
    const askPx = extractNumberField(line, 'ask_px_00');
    if (tsNs === null || bidPx === null || askPx === null) return;
    if (tsNs < this.rthOpenNs || tsNs > this.rthCloseNs + ONE_MINUTE_NS) return;
    this.quotes.push({ ts_ns: tsNs, bid_px: bidPx, ask_px: askPx, mid_px: round4((bidPx + askPx) / 2) });
    this.observeTs(tsNs);
  }

  private ingestTradeLine(line: string): void {
    if (line.trim() === '') return;
    const tsNs =
      extractBigintField(line, 'exchange_event_ts_ns') ??
      extractBigintField(line, 'sidecar_recv_ts_ns');
    const price = extractNumberField(line, 'price');
    const quantity = extractNumberField(line, 'quantity') ?? 1;
    if (tsNs === null || price === null) return;
    const slot = this.slotIndexForTs(tsNs);
    if (slot === null) return;
    const existing = this.barsBySlot.get(slot);
    if (existing === undefined) {
      const start = this.rthOpenNs + BigInt(slot) * ONE_MINUTE_NS;
      this.barsBySlot.set(slot, {
        start_ts_ns: start,
        end_ts_ns: start + ONE_MINUTE_NS,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: quantity,
        trade_count: 1,
      });
    } else {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += quantity;
      existing.trade_count += 1;
    }
    this.observeTs(tsNs);
  }

  private async processCompletedSlots(): Promise<void> {
    if (this.maxObservedNs === null) return;
    const safeNs = this.maxObservedNs - PROCESSING_LAG_NS;
    while (this.nextSlotToProcess < 390) {
      const slotEndNs = this.rthOpenNs + BigInt(this.nextSlotToProcess + 1) * ONE_MINUTE_NS;
      if (slotEndNs > safeNs) break;
      const mutable = this.barsBySlot.get(this.nextSlotToProcess);
      this.nextSlotToProcess += 1;
      if (mutable === undefined) continue;
      const bar = toBar(this.instrument, mutable);
      this.processedBars.push(bar);
      if (this.processedBars.length < WARMUP_BARS_REQUIRED) continue;
      const quote = this.quoteAtOrBefore(slotEndNs);
      const barIndex = this.processedBars.length - 1;
      const sessionVwap = computeSessionVwap(this.processedBars, barIndex);
      const atr14Pts = computeAtr14(this.processedBars, barIndex);
      const sigmaPts = computeSigmaPts(this.processedBars, barIndex);
      if (quote === null || sessionVwap === null || atr14Pts === null || atr14Pts <= 0) continue;
      const signedShockVwap = round4((quote.mid_px - sessionVwap) / atr14Pts);
      await this.processSnapshot(this.buildSnapshot({ bar, quote, sessionVwap, atr14Pts, sigmaPts, signedShockVwap }));
    }
  }

  private quoteAtOrBefore(tsNs: bigint): QuoteRow | null {
    while (this.quoteCursor < this.quotes.length && this.quotes[this.quoteCursor].ts_ns <= tsNs) {
      this.quoteCursor += 1;
    }
    return this.quoteCursor === 0 ? null : this.quotes[this.quoteCursor - 1];
  }

  private buildSnapshot(input: {
    readonly bar: Bar;
    readonly quote: QuoteRow;
    readonly sessionVwap: number;
    readonly atr14Pts: number;
    readonly sigmaPts: number;
    readonly signedShockVwap: number;
  }): StrategyFeatureSnapshot {
    const timestamp = input.bar.end_ts_ns;
    const featureSnapshotId = makeFeatureSnapshotId(`feature-qfa612-live-capture-${compactDate(this.tradingDate)}-${timestamp.toString()}`);
    return {
      feature_snapshot_id: featureSnapshotId,
      source_event_id: makeEventId(`source-live-capture-${featureSnapshotId}`),
      created_ts_ns: timestamp,
      instrument: this.instrument,
      session: {
        session_id: makeSessionId(`${this.tradingDate}-rth`),
        trading_date: this.tradingDate,
        phase: 'rth',
        is_rth: true,
        is_halt: false,
        is_roll_block: false,
        opened_ts_ns: ns(this.rthOpenNs),
        closes_ts_ns: ns(this.rthCloseNs),
      },
      quote: { bid_px: input.quote.bid_px, ask_px: input.quote.ask_px, mid_px: input.quote.mid_px },
      last_trade_price: input.bar.close,
      bars: this.processedBars,
      indicators: {
        atr_14_pts: input.atr14Pts,
        session_vwap: input.sessionVwap,
        sigma_pts: input.sigmaPts,
        signed_shock_vwap: input.signedShockVwap,
      },
      structure: { trend: 'unknown', values: {} },
      microstructure: { l3_authority: 'unavailable', values: {} },
      context: {
        prior_day_close: null,
        prior_day_high: null,
        prior_day_low: null,
        today_open: null,
        vix_value: null,
        vix_fresh: false,
        vix_prior_close_percentile: null,
        regime_label: this.regimeLabel,
        opening_range_high: null,
        opening_range_low: null,
        opening_range_minutes_elapsed: Math.max(0, Math.floor(Number(BigInt(input.bar.end_ts_ns) - this.rthOpenNs) / Number(ONE_MINUTE_NS))),
        session_vwap: input.sessionVwap,
        session_vwap_band_sigma_pts: input.sigmaPts,
        overnight_return_bps: null,
        signed_shock_vwap: {
          value: input.signedShockVwap,
          anchor_type: 'vwap',
          anchor_value: input.sessionVwap,
          sigma_basis: 'atr_14',
          sigma_basis_value: input.atr14Pts,
        },
        signed_shock_vwap_recent_values: null,
        signed_shock_prior_close: {
          value: null,
          anchor_type: 'prior_close',
          anchor_value: null,
          sigma_basis: 'atr_14',
          sigma_basis_value: null,
        },
      },
      config: {
        config_hash: LIVE_CAPTURE_FEATURE_BRIDGE_CONFIG_HASH,
        config_version: 1,
      },
    };
  }

  private slotIndexForTs(tsNs: bigint): number | null {
    if (tsNs < this.rthOpenNs || tsNs >= this.rthCloseNs) return null;
    return Number((tsNs - this.rthOpenNs) / ONE_MINUTE_NS);
  }

  private observeTs(tsNs: bigint): void {
    if (this.maxObservedNs === null || tsNs > this.maxObservedNs) {
      this.maxObservedNs = tsNs;
    }
  }
}

export function deriveMbp1Path(obs01Path: string): string {
  if (obs01Path.endsWith('.obs01.jsonl')) {
    return obs01Path.slice(0, -'.obs01.jsonl'.length) + '.mbp1.jsonl';
  }
  return path.join(path.dirname(obs01Path), 'MNQ_globex.mbp1.jsonl');
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, '/').toLowerCase();
}

export function parseCaptureRegimeLabel(value: string | undefined): StrategyFeatureSnapshotRegime {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'high' ||
    normalized === 'mid' ||
    normalized === 'low' ||
    normalized === 'transition_pending' ||
    normalized === 'unknown'
  ) {
    return normalized;
  }
  return 'unknown';
}

function readAppendedLines(file: string, state: AppendState): string[] {
  const stat = statSync(file);
  if (stat.size <= state.offset) return [];
  const length = stat.size - state.offset;
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, state.offset);
    state.offset = stat.size;
    const text = state.remainder + buffer.toString('utf8');
    const parts = text.split(/\r?\n/u);
    state.remainder = parts.pop() ?? '';
    return parts.filter((line) => line.trim() !== '');
  } finally {
    closeSync(fd);
  }
}

function readSeedLines(
  file: string,
  maxBytes: number,
  onLine: (line: string) => void,
): AppendState {
  const stat = statSync(file);
  if (stat.size <= 0) return { offset: 0, remainder: '' };
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  let remainder = '';
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    const parts = text.split(/\r?\n/u);
    remainder = parts.pop() ?? '';
    if (start > 0) parts.shift();
    for (const line of parts) {
      if (line.trim() !== '') onLine(line);
    }
    return { offset: stat.size, remainder };
  } finally {
    closeSync(fd);
  }
}

function extractBigintField(line: string, key: string): bigint | null {
  const quoted = cachedRegex(BIGINT_QUOTED_FIELD_REGEX_CACHE, key, `"${escapeRegExp(key)}"\\s*:\\s*"(\\d+)"`).exec(line);
  if (quoted !== null) return BigInt(quoted[1]);
  const numeric = cachedRegex(BIGINT_NUMERIC_FIELD_REGEX_CACHE, key, `"${escapeRegExp(key)}"\\s*:\\s*(\\d+)`).exec(line);
  return numeric === null ? null : BigInt(numeric[1]);
}

function extractNumberField(line: string, key: string): number | null {
  const match = cachedRegex(NUMBER_FIELD_REGEX_CACHE, key, `"${escapeRegExp(key)}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(line);
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function cachedRegex(cache: Map<string, RegExp>, key: string, source: string): RegExp {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const created = new RegExp(source, 'u');
  cache.set(key, created);
  return created;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function parseTradingDateFromCapturePath(obs01Path: string): string {
  const normalized = obs01Path.replace(/\\/gu, '/');
  const match = /\/captures\/(\d{4}-\d{2}-\d{2})\//u.exec(normalized);
  if (match === null) {
    throw new Error(`QFA live capture feature bridge could not parse trading date from OBS01 path: ${obs01Path}`);
  }
  return match[1];
}

function utcNs(date: string, hour: number, minute: number): bigint {
  return BigInt(Date.parse(`${date}T${pad2(hour)}:${pad2(minute)}:00.000Z`)) * 1_000_000n;
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function compactDate(date: string): string {
  return date.replace(/-/gu, '');
}

function toBar(instrument: InstrumentIdentity, bar: MutableBar): Bar {
  return {
    instrument,
    timeframe: '1m',
    start_ts_ns: ns(bar.start_ts_ns),
    end_ts_ns: ns(bar.end_ts_ns),
    open: round4(bar.open),
    high: round4(bar.high),
    low: round4(bar.low),
    close: round4(bar.close),
    volume: round4(bar.volume),
    trade_count: bar.trade_count,
  };
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

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
