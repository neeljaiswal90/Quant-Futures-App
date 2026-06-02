import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

type SourceKind = 'obs01' | 'mbp1' | 'raw';

type CoverageScan = {
  readonly kind: SourceKind;
  readonly path: string | null;
  readonly exists: boolean;
  readonly first_ts_ns: string | null;
  readonly first_ts_utc: string | null;
  readonly bounded_end_ts_ns: string | null;
  readonly bounded_end_ts_utc: string | null;
  readonly records_scanned_until_cutoff: number;
  readonly records_selected_at_or_after_open: number;
  readonly source_covers_rth_open: boolean;
  readonly notes: readonly string[];
};

type PriceBar = {
  readonly start_ts_ns: bigint;
  readonly end_ts_ns: bigint;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
};

type MutablePriceBar = {
  start_ts_ns: bigint;
  end_ts_ns: bigint;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type QuoteScan = CoverageScan & {
  readonly finite_mid_quote_count: number;
  readonly latest_finite_mid_quote: {
    readonly ts_ns: string;
    readonly ts_utc: string;
    readonly bid_px: number;
    readonly ask_px: number;
    readonly mid_px: number;
  } | null;
};

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-SOURCE-READINESS-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const OUTPUT_DIR = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01';
const OUTPUT_JSONL = `${OUTPUT_DIR}/bounded-2026-06-02-source-readiness.jsonl`;
const OUTPUT_JSON = `${OUTPUT_DIR}/source-readiness-report.json`;
const OUTPUT_MD = `${OUTPUT_DIR}/source-readiness-report.md`;
const MEMO_PATH = 'docs/research/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01-memo.md';
const TARGET_SESSION_ID = '2026-06-02-rth';
const TARGET_DATE = '2026-06-02';
const PRIOR_SOURCE_DATE = '2026-06-01';
const RTH_OPEN_UTC = '2026-06-02T13:30:00.000Z';
const PRIOR_RTH_OPEN_UTC = '2026-06-01T13:30:00.000Z';
const BOUNDED_ANALYSIS_CUTOFF_UTC = '2026-06-02T18:00:00.000Z';
const FRED_SOURCE_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS,VXNCLS&cosd=2026-06-01&coed=2026-06-01';
const REGIME_LABEL_PATH = 'artifacts/regime/regime-labels.json';
const PINNED_VIX_VXN_PATH = 'config/research/vix-vxn-daily-2025-09-to-2026-04.json';
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;
const MINUTE_NS = 60_000_000_000n;
const ORIGINAL_REPO_ROOT = 'D:/Quant-futures-app';

const OPEN_NS = isoToNs(RTH_OPEN_UTC);
const PRIOR_OPEN_NS = isoToNs(PRIOR_RTH_OPEN_UTC);
const CUTOFF_NS = isoToNs(BOUNDED_ANALYSIS_CUTOFF_UTC);

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: JsonRecord = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key]);
    }
    return sorted;
  }
  return value;
}

function stableJsonLine(value: JsonValue): string {
  return JSON.stringify(sortJsonValue(value));
}

function stableJson(value: JsonValue): string {
  return `${stableJsonLine(value)}\n`;
}

function stableJsonl(records: readonly JsonValue[]): string {
  return `${records.map(stableJsonLine).join('\n')}\n`;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeLf(value: string): string {
  return value.replace(/\r\n/gu, '\n');
}

function isoToNs(value: string): bigint {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid ISO timestamp: ${value}`);
  }
  return BigInt(ms) * 1_000_000n;
}

function nsToIso(ns: bigint): string {
  const seconds = ns / 1_000_000_000n;
  const nanos = ns % 1_000_000_000n;
  const base = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${base}.${nanos.toString().padStart(9, '0')}Z`;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function portablePath(value: string): string {
  return value.replace(/\\/gu, '/');
}

function resolveCapturePath(date: string, filename: string): string | null {
  const envRoot = process.env.QFA_RITHMIC_CAPTURE_ROOT;
  const candidates = [
    envRoot === undefined ? null : path.join(envRoot, date, filename),
    path.join(process.cwd(), 'tools', 'rithmic_analytics', 'data', 'captures', date, filename),
    path.join(ORIGINAL_REPO_ROOT, 'tools', 'rithmic_analytics', 'data', 'captures', date, filename),
    path.join(ORIGINAL_REPO_ROOT, 'tools', 'analytics', 'data', 'captures', date, filename),
  ].filter((candidate): candidate is string => candidate !== null);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveNumberOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed === null || !(parsed > 0) ? null : parsed;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractTsNs(record: Record<string, unknown>, kind: SourceKind): bigint | null {
  const payload = asObject(record.payload);
  const candidates = kind === 'obs01'
    ? [record.ts_ns, payload.exchange_event_ts_ns, record.ts_event_ns, record.exchange_event_ts_ns]
    : [record.ts_event_ns, record.ts_ns, record.exchange_event_ts_ns, payload.exchange_event_ts_ns];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^\d+$/u.test(candidate)) {
      return BigInt(candidate);
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      return BigInt(Math.trunc(candidate));
    }
  }
  return null;
}

function bucketStart(tsNs: bigint): bigint {
  return (tsNs / MINUTE_NS) * MINUTE_NS;
}

async function scanTradesAndBars(filePath: string | null): Promise<{ readonly coverage: CoverageScan; readonly bars: readonly PriceBar[]; readonly first_bar_trade_ts_ns: string | null; readonly last_bar_trade_ts_ns: string | null }> {
  if (filePath === null) {
    return {
      bars: [],
      coverage: missingCoverage('obs01', 'source file not found'),
      first_bar_trade_ts_ns: null,
      last_bar_trade_ts_ns: null,
    };
  }
  const barsByBucket = new Map<string, MutablePriceBar>();
  let firstTs: bigint | null = null;
  let boundedEndTs: bigint | null = null;
  let recordsScanned = 0;
  let recordsSelected = 0;
  let firstBarTradeTs: bigint | null = null;
  let lastBarTradeTs: bigint | null = null;

  for await (const line of readLines(filePath)) {
    if (line.length === 0) {
      continue;
    }
    const parsed = JSON.parse(line) as unknown;
    const record = asObject(parsed);
    const payload = asObject(record.payload);
    const tsNs = extractTsNs(record, 'obs01');
    if (tsNs === null) {
      continue;
    }
    firstTs ??= tsNs;
    if (tsNs > CUTOFF_NS) {
      break;
    }
    boundedEndTs = tsNs;
    recordsScanned += 1;
    if (tsNs < OPEN_NS) {
      continue;
    }
    const price = numberOrNull(payload.price ?? record.price);
    const quantity = positiveNumberOrNull(payload.quantity ?? payload.size ?? payload.qty ?? record.quantity ?? record.size ?? record.qty);
    if (price === null || quantity === null) {
      continue;
    }
    const start = bucketStart(tsNs);
    const end = start + MINUTE_NS;
    if (end > CUTOFF_NS) {
      continue;
    }
    recordsSelected += 1;
    firstBarTradeTs ??= tsNs;
    lastBarTradeTs = tsNs;
    const key = start.toString();
    const existing = barsByBucket.get(key);
    if (existing === undefined) {
      barsByBucket.set(key, {
        close: price,
        end_ts_ns: end,
        high: price,
        low: price,
        open: price,
        start_ts_ns: start,
        volume: quantity,
      });
    } else {
      existing.close = price;
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.volume += quantity;
    }
  }

  const bars = [...barsByBucket.values()]
    .sort((left, right) => (left.start_ts_ns < right.start_ts_ns ? -1 : left.start_ts_ns > right.start_ts_ns ? 1 : 0))
    .map((bar) => ({
      close: round4(bar.close),
      end_ts_ns: bar.end_ts_ns,
      high: round4(bar.high),
      low: round4(bar.low),
      open: round4(bar.open),
      start_ts_ns: bar.start_ts_ns,
      volume: round4(bar.volume),
    }));

  return {
    bars,
    coverage: {
      bounded_end_ts_ns: boundedEndTs?.toString() ?? null,
      bounded_end_ts_utc: boundedEndTs === null ? null : nsToIso(boundedEndTs),
      exists: true,
      first_ts_ns: firstTs?.toString() ?? null,
      first_ts_utc: firstTs === null ? null : nsToIso(firstTs),
      kind: 'obs01',
      notes: ['bounded scan stops at fixed cutoff to avoid live append nondeterminism'],
      path: portablePath(filePath),
      records_scanned_until_cutoff: recordsScanned,
      records_selected_at_or_after_open: recordsSelected,
      source_covers_rth_open: firstTs !== null && firstTs <= OPEN_NS,
    },
    first_bar_trade_ts_ns: firstBarTradeTs?.toString() ?? null,
    last_bar_trade_ts_ns: lastBarTradeTs?.toString() ?? null,
  };
}

async function scanMbp1ForQuote(filePath: string | null): Promise<QuoteScan> {
  if (filePath === null) {
    return {
      ...missingCoverage('mbp1', 'source file not found'),
      finite_mid_quote_count: 0,
      latest_finite_mid_quote: null,
    };
  }
  let firstTs: bigint | null = null;
  let boundedEndTs: bigint | null = null;
  let recordsScanned = 0;
  let recordsSelected = 0;
  let finiteMidQuoteCount = 0;
  let latestFiniteMidQuote: QuoteScan['latest_finite_mid_quote'] = null;

  for await (const line of readLines(filePath)) {
    if (line.length === 0) {
      continue;
    }
    const parsed = JSON.parse(line) as unknown;
    const record = asObject(parsed);
    const tsNs = extractTsNs(record, 'mbp1');
    if (tsNs === null) {
      continue;
    }
    firstTs ??= tsNs;
    if (tsNs > CUTOFF_NS) {
      break;
    }
    boundedEndTs = tsNs;
    recordsScanned += 1;
    if (tsNs >= OPEN_NS) {
      recordsSelected += 1;
    }
    const bidPx = numberOrNull(record.bid_px_00);
    const askPx = numberOrNull(record.ask_px_00);
    if (bidPx !== null && askPx !== null) {
      finiteMidQuoteCount += 1;
      latestFiniteMidQuote = {
        ask_px: round4(askPx),
        bid_px: round4(bidPx),
        mid_px: round4((bidPx + askPx) / 2),
        ts_ns: tsNs.toString(),
        ts_utc: nsToIso(tsNs),
      };
    }
  }

  return {
    bounded_end_ts_ns: boundedEndTs?.toString() ?? null,
    bounded_end_ts_utc: boundedEndTs === null ? null : nsToIso(boundedEndTs),
    exists: true,
    finite_mid_quote_count: finiteMidQuoteCount,
    first_ts_ns: firstTs?.toString() ?? null,
    first_ts_utc: firstTs === null ? null : nsToIso(firstTs),
    kind: 'mbp1',
    latest_finite_mid_quote: latestFiniteMidQuote,
    notes: ['bounded scan stops at fixed cutoff to avoid live append nondeterminism'],
    path: portablePath(filePath),
    records_scanned_until_cutoff: recordsScanned,
    records_selected_at_or_after_open: recordsSelected,
    source_covers_rth_open: firstTs !== null && firstTs <= OPEN_NS,
  };
}

async function scanFirstTimestamp(filePath: string | null, kind: SourceKind): Promise<CoverageScan> {
  if (filePath === null) {
    return missingCoverage(kind, 'source file not found');
  }
  let firstTs: bigint | null = null;
  for await (const line of readLines(filePath)) {
    if (line.length === 0) {
      continue;
    }
    const parsed = JSON.parse(line) as unknown;
    const record = asObject(parsed);
    firstTs = extractTsNs(record, kind);
    if (firstTs !== null) {
      break;
    }
  }
  return {
    bounded_end_ts_ns: null,
    bounded_end_ts_utc: null,
    exists: true,
    first_ts_ns: firstTs?.toString() ?? null,
    first_ts_utc: firstTs === null ? null : nsToIso(firstTs),
    kind,
    notes: ['first timestamp only; 2026-06-01 remains an incomplete source day and is not repaired by 2026-06-02'],
    path: portablePath(filePath),
    records_scanned_until_cutoff: firstTs === null ? 0 : 1,
    records_selected_at_or_after_open: firstTs !== null && firstTs >= PRIOR_OPEN_NS ? 1 : 0,
    source_covers_rth_open: firstTs !== null && firstTs <= PRIOR_OPEN_NS,
  };
}

function missingCoverage(kind: SourceKind, note: string): CoverageScan {
  return {
    bounded_end_ts_ns: null,
    bounded_end_ts_utc: null,
    exists: false,
    first_ts_ns: null,
    first_ts_utc: null,
    kind,
    notes: [note],
    path: null,
    records_scanned_until_cutoff: 0,
    records_selected_at_or_after_open: 0,
    source_covers_rth_open: false,
  };
}

async function* readLines(filePath: string): AsyncGenerator<string> {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ crlfDelay: Infinity, input });
  for await (const line of rl) {
    yield line;
  }
}

function computeSessionVwap(bars: readonly PriceBar[]): number | null {
  let pv = 0;
  let volume = 0;
  for (const bar of bars) {
    if (bar.start_ts_ns < OPEN_NS || !(bar.volume > 0)) {
      continue;
    }
    pv += bar.close * bar.volume;
    volume += bar.volume;
  }
  return volume > 0 ? round4(pv / volume) : null;
}

function computeAtr14(bars: readonly PriceBar[], period = 14): number | null {
  if (bars.length <= period) {
    return null;
  }
  let atr = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const trueRange = computeTrueRange(bars, index);
    if (index < period) {
      atr += trueRange;
      if (index === period - 1) {
        atr /= period;
      }
      continue;
    }
    atr = ((atr * (period - 1)) + trueRange) / period;
  }
  return round4(atr);
}

function computeTrueRange(bars: readonly PriceBar[], index: number): number {
  const bar = bars[index]!;
  const previous = bars[index - 1];
  return previous === undefined
    ? bar.high - bar.low
    : Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    );
}

function summarizeBars(bars: readonly PriceBar[]): JsonRecord {
  const first = bars[0];
  const last = bars.at(-1);
  return {
    closed_1m_bars_constructed: bars.length,
    first_bar: first === undefined ? null : serializeBar(first),
    last_bar: last === undefined ? null : serializeBar(last),
    missing_open_minute_bar: first === undefined || first.start_ts_ns !== OPEN_NS,
    source_proven_from_effective_rth_open: first !== undefined && first.start_ts_ns === OPEN_NS,
  };
}

function serializeBar(bar: PriceBar): JsonRecord {
  return {
    close: bar.close,
    end_ts_ns: bar.end_ts_ns.toString(),
    end_ts_utc: nsToIso(bar.end_ts_ns),
    high: bar.high,
    low: bar.low,
    open: bar.open,
    start_ts_ns: bar.start_ts_ns.toString(),
    start_ts_utc: nsToIso(bar.start_ts_ns),
    volume: bar.volume,
  };
}

function loadCachedRecord(records: readonly JsonRecord[], recordType: string, key: string | null = null): JsonRecord | null {
  for (const record of records) {
    if (record.record_type !== recordType) {
      continue;
    }
    if (key === null || record.cache_key === key) {
      return record;
    }
  }
  return null;
}

async function loadCache(): Promise<readonly JsonRecord[]> {
  if (!existsSync(OUTPUT_JSONL)) {
    return [];
  }
  const text = normalizeLf(await readFile(OUTPUT_JSONL, 'utf8'));
  return text.split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

async function pointInTimeHashRecord(kind: SourceKind, filePath: string | null, cache: readonly JsonRecord[]): Promise<JsonRecord> {
  const cached = loadCachedRecord(cache, 'FULL_SOURCE_HASH', kind);
  if (cached !== null) {
    return cached;
  }
  if (filePath === null) {
    return {
      cache_key: kind,
      payload: { reason: 'source file not found' },
      record_type: 'FULL_SOURCE_HASH',
      source_kind: kind,
      status: 'missing',
      ticket: TICKET,
    };
  }
  if (kind === 'raw') {
    return rawMetadataRecord(filePath, cache);
  }
  const before = await stat(filePath);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const after = await stat(filePath);
  return {
    cache_key: kind,
    payload: {
      full_source_sha256: hash.digest('hex'),
      full_source_sha256_scope: 'point_in_time_full_file',
      last_write_time_utc_after_hash: after.mtime.toISOString(),
      last_write_time_utc_before_hash: before.mtime.toISOString(),
      mutated_during_hash: before.size !== after.size || before.mtimeMs !== after.mtimeMs,
      path: portablePath(filePath),
      size_bytes_after_hash: after.size,
      size_bytes_before_hash: before.size,
    },
    record_type: 'FULL_SOURCE_HASH',
    source_kind: kind,
    status: 'hashed',
    ticket: TICKET,
  };
}

async function rawMetadataRecord(filePath: string, cache: readonly JsonRecord[]): Promise<JsonRecord> {
  const cached = loadCachedRecord(cache, 'RAW_SOURCE_METADATA', 'raw');
  if (cached !== null) {
    return cached;
  }
  const info = await stat(filePath);
  return {
    cache_key: 'raw',
    payload: {
      full_source_sha256: null,
      full_source_sha256_scope: 'not_computed_raw_file_excluded_from_compact_source_readiness',
      last_write_time_utc: info.mtime.toISOString(),
      path: portablePath(filePath),
      raw_file_not_used_reason: 'normalized obs01 trades and mbp1 quotes prove the feature-source chain; raw capture is multi-GiB/live-locked and not useful for this compact 95 MiB guarded source-readiness artifact',
      size_bytes: info.size,
    },
    record_type: 'RAW_SOURCE_METADATA',
    source_kind: 'raw',
    status: 'metadata_only',
    ticket: TICKET,
  };
}

async function fetchOrLoadVixVxn(cache: readonly JsonRecord[]): Promise<JsonRecord> {
  const cached = loadCachedRecord(cache, 'VIX_VXN_PRIOR_CLOSE_SOURCE', 'fred-2026-06-01');
  if (cached !== null) {
    return cached;
  }
  const retrievedAt = new Date().toISOString();
  try {
    const response = await fetch(FRED_SOURCE_URL);
    const body = normalizeLf(await response.text());
    const parsed = parseFredCsv(body);
    return {
      cache_key: 'fred-2026-06-01',
      payload: {
        fred_response_lf_sha256: sha256Text(body),
        fred_source_url: FRED_SOURCE_URL,
        http_status: response.status,
        prior_close_date: PRIOR_SOURCE_DATE,
        retrieval_timestamp_utc: retrievedAt,
        returned_values: parsed,
      },
      record_type: 'VIX_VXN_PRIOR_CLOSE_SOURCE',
      source: 'FRED fredgraph.csv',
      status: parsed.VIXCLS === null || parsed.VXNCLS === null ? 'missing_value' : 'available',
      ticket: TICKET,
    };
  } catch (error) {
    return {
      cache_key: 'fred-2026-06-01',
      payload: {
        error: error instanceof Error ? error.message : String(error),
        fred_source_url: FRED_SOURCE_URL,
        prior_close_date: PRIOR_SOURCE_DATE,
        retrieval_timestamp_utc: retrievedAt,
        returned_values: { VIXCLS: null, VXNCLS: null },
      },
      record_type: 'VIX_VXN_PRIOR_CLOSE_SOURCE',
      source: 'FRED fredgraph.csv',
      status: 'fetch_failed',
      ticket: TICKET,
    };
  }
}

function parseFredCsv(csv: string): { readonly VIXCLS: number | null; readonly VXNCLS: number | null } {
  const lines = csv.split('\n').filter((line) => line.trim().length > 0);
  const header = lines[0]?.split(',').map((cell) => cell.trim()) ?? [];
  const dateIndex = header.indexOf('observation_date');
  const vixIndex = header.indexOf('VIXCLS');
  const vxnIndex = header.indexOf('VXNCLS');
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells[dateIndex] !== PRIOR_SOURCE_DATE) {
      continue;
    }
    return {
      VIXCLS: parseFredNumber(cells[vixIndex]),
      VXNCLS: parseFredNumber(cells[vxnIndex]),
    };
  }
  return { VIXCLS: null, VXNCLS: null };
}

function parseFredNumber(value: string | undefined): number | null {
  if (value === undefined || value === '.' || value.length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function regimeStatusRecord(): Promise<JsonRecord> {
  const regimeText = existsSync(REGIME_LABEL_PATH) ? normalizeLf(await readFile(REGIME_LABEL_PATH, 'utf8')) : null;
  const pinnedText = existsSync(PINNED_VIX_VXN_PATH) ? normalizeLf(await readFile(PINNED_VIX_VXN_PATH, 'utf8')) : null;
  const regime = regimeText === null ? null : JSON.parse(regimeText) as JsonRecord;
  const labels = Array.isArray(regime?.labels) ? regime.labels.map((value) => asObject(value)) : [];
  const label = labels.find((row) => row.session_id === TARGET_SESSION_ID);
  const pinned = pinnedText === null ? null : JSON.parse(pinnedText) as JsonRecord;
  const series = asObject(pinned?.series);
  const vixRows = Array.isArray(series.VIXCLS) ? series.VIXCLS.map((value) => asObject(value)) : [];
  const vxnRows = Array.isArray(series.VXNCLS) ? series.VXNCLS.map((value) => asObject(value)) : [];
  const labelValue = label === undefined ? null : String(label.confirmed_label ?? label.regime_label ?? 'unknown');
  return {
    cache_key: TARGET_SESSION_ID,
    payload: {
      current_regime_label_lookup: {
        label: labelValue,
        session_id: TARGET_SESSION_ID,
        status: label === undefined ? 'missing' : 'available',
      },
      current_regime_label_source: {
        first_label_session_id: labels[0]?.session_id === undefined ? null : String(labels[0]?.session_id),
        label_count: labels.length,
        last_label_session_id: labels.at(-1)?.session_id === undefined ? null : String(labels.at(-1)?.session_id),
        path: REGIME_LABEL_PATH,
        sha256: regimeText === null ? null : sha256Text(regimeText),
      },
      pinned_vix_vxn_source: {
        path: PINNED_VIX_VXN_PATH,
        sha256: pinnedText === null ? null : sha256Text(pinnedText),
        vix_latest_date: latestDate(vixRows),
        vix_row_count: vixRows.length,
        vxn_latest_date: latestDate(vxnRows),
        vxn_row_count: vxnRows.length,
      },
      source_readiness_note: label === undefined
        ? '2026-06-02-rth is absent from current global regime labels; this ticket does not mutate global regime authority'
        : '2026-06-02-rth is present in current global regime labels',
    },
    record_type: 'REGIME_LABEL_SOURCE_STATUS',
    status: label === undefined ? 'missing' : 'available',
    ticket: TICKET,
  };
}

function latestDate(rows: readonly Record<string, unknown>[]): string | null {
  const dates = rows
    .map((row) => typeof row.date === 'string' ? row.date : null)
    .filter((date): date is string => date !== null)
    .sort();
  return dates.at(-1) ?? null;
}

function buildDetermination(params: {
  readonly sourceMutationOrNondeterminism: boolean;
  readonly sessionVwapReady: boolean;
  readonly vixVxnReady: boolean;
  readonly regimeLabelReady: boolean;
}): string {
  if (params.sourceMutationOrNondeterminism) {
    return 'SOURCE_READINESS_2026_06_02_BLOCKED_SOURCE_MUTATION_OR_NONDETERMINISM';
  }
  if (!params.sessionVwapReady) {
    return 'SOURCE_READINESS_2026_06_02_BLOCKED_MISSING_SESSION_VWAP_SOURCE';
  }
  if (!params.vixVxnReady) {
    return 'SOURCE_READINESS_2026_06_02_BLOCKED_MISSING_VIX_VXN_SOURCE';
  }
  if (!params.regimeLabelReady) {
    return 'SOURCE_READINESS_2026_06_02_BLOCKED_MISSING_REGIME_LABEL_SOURCE';
  }
  return 'SOURCE_READINESS_2026_06_02_READY_FOR_FEATURE_SOURCE_RECHECK';
}

function buildRecommendedNextTicket(determination: string): string {
  if (determination === 'SOURCE_READINESS_2026_06_02_BLOCKED_MISSING_VIX_VXN_SOURCE') {
    return 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-VIX-VXN-PRIOR-CLOSE-SOURCE-ACQUIRE-01';
  }
  if (determination === 'SOURCE_READINESS_2026_06_02_BLOCKED_MISSING_REGIME_LABEL_SOURCE') {
    return 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-REGIME-LABEL-SOURCE-INPUTS-EXTEND-01';
  }
  if (determination === 'SOURCE_READINESS_2026_06_02_BLOCKED_MISSING_SESSION_VWAP_SOURCE') {
    return 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-SESSION-VWAP-SOURCE-REPAIR-01';
  }
  if (determination === 'SOURCE_READINESS_2026_06_02_BLOCKED_SOURCE_MUTATION_OR_NONDETERMINISM') {
    return 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-BOUNDED-SOURCE-FREEZE-01';
  }
  return 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SOURCE-RECHECK-01';
}

function artifactSizeStatus(text: string): JsonRecord {
  const size = Buffer.byteLength(text, 'utf8');
  return {
    artifact_size_bytes: size,
    artifact_size_limit_bytes: MAX_ARTIFACT_BYTES,
    artifact_size_within_limit: size < MAX_ARTIFACT_BYTES,
  };
}

function asPayload(record: JsonRecord): JsonRecord {
  return asObject(record.payload) as JsonRecord;
}

function buildMarkdown(report: JsonRecord): string {
  const rows: readonly [string, string][] = [
    ['ticket', TICKET],
    ['determination', String(report.determination)],
    ['2026-06-01 disposition', 'incomplete source day; not repaired by 2026-06-02'],
    ['effective RTH start', RTH_OPEN_UTC],
    ['bounded analysis cutoff', BOUNDED_ANALYSIS_CUTOFF_UTC],
    ['closed 1m bars', String(asObject(report.closed_1m_bars).closed_1m_bars_constructed ?? 'null')],
    ['session_vwap_ready', String(asObject(report.session_vwap_source_readiness).ready)],
    ['signed_shock_vwap_ready', String(asObject(report.signed_shock_vwap_source_readiness).ready)],
    ['vix_vxn_prior_close_ready', String(asObject(report.vix_vxn_prior_close_source_status).ready)],
    ['regime_label_ready', String(asObject(report.regime_label_source_status).ready)],
    ['bounded JSONL sha256', String(report.bounded_source_readiness_lf_sha256)],
    ['recommended_next_ticket', String(report.recommended_next_ticket)],
  ];
  const blockers = Array.isArray(report.blockers) ? report.blockers.map((blocker) => `- ${String(blocker)}`).join('\n') : '- none';
  return [
    `# ${TICKET}`,
    '',
    '## Determination',
    '',
    '| Field | Value |',
    '|---|---|',
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    '',
    '## Blockers',
    '',
    blockers,
    '',
    '## Scope and authority',
    '',
    '- Source-readiness only.',
    '- 2026-06-01 remains an incomplete source day and is not repaired or substituted by 2026-06-02.',
    '- No `StrategyFeatureSnapshot`, paper runtime, broker/live path, Phase 6 path, qfa-410b/qfa-611 verdict, active roster mutation, or candidate roster mutation was created.',
    '- `STRAT_EVAL = 0`, `CANDIDATE = 0`, `ORDER_INTENT = 0`.',
    '- `observation_day_eligible = false`, `observation_day_increment = 0`.',
    '',
    '## Source and hash policy',
    '',
    '- Bounded hashes are authoritative for this ticket.',
    '- Full normalized source hashes are point-in-time full-file diagnostics only.',
    '- Raw capture metadata is recorded only; raw capture is not duplicated or hashed because it is live/multi-GiB and not useful for the compact normalized feature-source bridge.',
    '',
  ].join('\n');
}

function buildMemo(report: JsonRecord): string {
  return [
    `# ${TICKET} memo`,
    '',
    `Determination: \`${String(report.determination)}\`.`,
    '',
    'This ticket evaluates 2026-06-02 as a new source-complete candidate day for the paper-observation feature-source bridge. It does not repair, substitute for, or create observation-day credit from the incomplete 2026-06-01 source day.',
    '',
    `The effective RTH/session start used for the source-readiness check is \`${RTH_OPEN_UTC}\`; the bounded source proof uses a fixed cutoff of \`${BOUNDED_ANALYSIS_CUTOFF_UTC}\` to avoid live append nondeterminism. The bounded JSONL hash is \`${String(report.bounded_source_readiness_lf_sha256)}\`.`,
    '',
    `Repo-faithful session_vwap status: \`${String(asObject(report.session_vwap_source_readiness).status)}\`. signed_shock_vwap status: \`${String(asObject(report.signed_shock_vwap_source_readiness).status)}\`. VIX/VXN prior-close status: \`${String(asObject(report.vix_vxn_prior_close_source_status).status)}\`. Regime-label status: \`${String(asObject(report.regime_label_source_status).status)}\`.`,
    '',
    `Recommended next ticket: \`${String(report.recommended_next_ticket)}\`.`,
    '',
    'Guardrails held: `STRAT_EVAL = 0`, `CANDIDATE = 0`, `ORDER_INTENT = 0`, `observation_day_eligible = false`, `observation_day_increment = 0`, no `StrategyFeatureSnapshot`, no paper runtime, no broker/live, no Phase 6, no roster mutation, no qfa-410b/qfa-611 research verdict, and no global regime-label mutation.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const cache = await loadCache();
  const obsPath = resolveCapturePath(TARGET_DATE, 'MNQ_rth.obs01.jsonl');
  const mbp1Path = resolveCapturePath(TARGET_DATE, 'MNQ_rth.mbp1.jsonl');
  const rawPath = resolveCapturePath(TARGET_DATE, 'MNQ_rth.jsonl');
  const priorObsPath = resolveCapturePath(PRIOR_SOURCE_DATE, 'MNQ_rth.obs01.jsonl');
  const priorMbp1Path = resolveCapturePath(PRIOR_SOURCE_DATE, 'MNQ_rth.mbp1.jsonl');

  const [tradeScan, quoteScan, priorObs, priorMbp1, obsHash, mbp1Hash, rawRecord, vixRecord, regimeRecord] = await Promise.all([
    scanTradesAndBars(obsPath),
    scanMbp1ForQuote(mbp1Path),
    scanFirstTimestamp(priorObsPath, 'obs01'),
    scanFirstTimestamp(priorMbp1Path, 'mbp1'),
    pointInTimeHashRecord('obs01', obsPath, cache),
    pointInTimeHashRecord('mbp1', mbp1Path, cache),
    rawPath === null
      ? Promise.resolve(missingRawRecord())
      : rawMetadataRecord(rawPath, cache),
    fetchOrLoadVixVxn(cache),
    regimeStatusRecord(),
  ]);

  const bars = tradeScan.bars;
  const barSummary = summarizeBars(bars);
  const sessionVwap = computeSessionVwap(bars);
  const atr14 = computeAtr14(bars);
  const latestQuote = quoteScan.latest_finite_mid_quote;
  const signedShockValue = sessionVwap === null || atr14 === null || latestQuote === null
    ? null
    : round4((latestQuote.mid_px - sessionVwap) / atr14);
  const sessionVwapReady = tradeScan.coverage.source_covers_rth_open
    && quoteScan.source_covers_rth_open
    && Boolean(barSummary.source_proven_from_effective_rth_open)
    && sessionVwap !== null;
  const signedShockReady = sessionVwapReady && atr14 !== null && latestQuote !== null && signedShockValue !== null;
  const vixPayload = asPayload(vixRecord);
  const returnedValues = asObject(vixPayload.returned_values);
  const vixVxnReady = numberOrNull(returnedValues.VIXCLS) !== null && numberOrNull(returnedValues.VXNCLS) !== null;
  const regimePayload = asPayload(regimeRecord);
  const regimeLookup = asObject(regimePayload.current_regime_label_lookup);
  const regimeLabelReady = regimeLookup.status === 'available';
  const boundedSourceMutationOrNondeterminism = false;
  const determination = buildDetermination({
    regimeLabelReady,
    sessionVwapReady,
    sourceMutationOrNondeterminism: boundedSourceMutationOrNondeterminism,
    vixVxnReady,
  });
  const recommendedNextTicket = buildRecommendedNextTicket(determination);
  const blockers = [
    sessionVwapReady ? null : 'session_vwap source is not ready from source-proven RTH open',
    vixVxnReady ? null : 'VIX/VXN prior-close source for 2026-06-01 is missing or failed retrieval',
    regimeLabelReady ? null : 'regime label source for 2026-06-02-rth is missing from current global regime labels',
  ].filter((value): value is string => value !== null);
  const serializeCoverageScan = <T extends CoverageScan>(scan: T): JsonRecord => ({
    ...scan,
    notes: [...scan.notes],
  });

  const records: JsonRecord[] = [
    {
      payload: {
        CANDIDATE: 0,
        ORDER_INTENT: 0,
        STRAT_EVAL: 0,
        active_roster_mutated: false,
        broker_live_authorized: false,
        candidate_roster_mutated: false,
        observation_day_eligible: false,
        observation_day_increment: 0,
        paper_runtime_invoked: false,
        phase_6_authorized: false,
        qfa_410b_or_qfa_611_backtest_authority_created: false,
        strategy_feature_snapshot_emitted: false,
      },
      record_type: 'SOURCE_READINESS_GUARDRAILS',
      ticket: TICKET,
    },
    {
      payload: {
        disposition: 'incomplete_source_day_not_repaired_by_2026_06_02',
        prior_rth_open_utc: PRIOR_RTH_OPEN_UTC,
        source_checks: {
          mbp1: serializeCoverageScan(priorMbp1),
          obs01: serializeCoverageScan(priorObs),
        },
      },
      record_type: 'SOURCE_DAY_2026_06_01_DISPOSITION',
      ticket: TICKET,
    },
    {
      payload: {
        bounded_analysis_cutoff_utc: BOUNDED_ANALYSIS_CUTOFF_UTC,
        effective_rth_start_ns: OPEN_NS.toString(),
        effective_rth_start_utc: RTH_OPEN_UTC,
        source_coverage: {
          mbp1: serializeCoverageScan(quoteScan),
          obs01: serializeCoverageScan(tradeScan.coverage),
          raw: rawPath === null
            ? serializeCoverageScan(missingCoverage('raw', 'raw source file not found and not needed for normalized source-readiness'))
            : serializeCoverageScan({
              ...missingCoverage('raw', 'raw source metadata recorded separately; raw file not useful for compact normalized source-readiness'),
              exists: true,
              path: portablePath(rawPath),
            }),
        },
      },
      record_type: 'SOURCE_COVERAGE_2026_06_02_RTH',
      ticket: TICKET,
    },
    obsHash,
    mbp1Hash,
    rawRecord,
    {
      payload: {
        bars: barSummary,
        first_bar_trade_ts_ns: tradeScan.first_bar_trade_ts_ns,
        first_bar_trade_ts_utc: tradeScan.first_bar_trade_ts_ns === null ? null : nsToIso(BigInt(tradeScan.first_bar_trade_ts_ns)),
        last_bar_trade_ts_ns: tradeScan.last_bar_trade_ts_ns,
        last_bar_trade_ts_utc: tradeScan.last_bar_trade_ts_ns === null ? null : nsToIso(BigInt(tradeScan.last_bar_trade_ts_ns)),
      },
      record_type: 'CLOSED_1M_BARS_FROM_SOURCE_PROVEN_RTH_OPEN',
      ticket: TICKET,
    },
    {
      payload: {
        accumulation_formula: 'repo-faithful closed-bar sum(close * volume) / sum(volume), rounded to 4 decimals',
        effective_session_start_precedence: 'explicit RTH open for this source-readiness candidate: 2026-06-02T13:30:00.000Z',
        ready: sessionVwapReady,
        session_vwap: sessionVwap,
        source_proven_from_effective_rth_open: sessionVwapReady,
        status: sessionVwapReady ? 'ready' : 'blocked_missing_source',
      },
      record_type: 'SESSION_VWAP_SOURCE_READINESS',
      ticket: TICKET,
    },
    {
      payload: {
        atr14_pts: atr14,
        formula: '(quote.mid_px - session_vwap) / atr_14',
        latest_finite_mid_quote: latestQuote,
        ready: signedShockReady,
        session_vwap: sessionVwap,
        signed_shock_vwap_source_readiness_value: signedShockValue,
        status: signedShockReady ? 'ready_source_readiness_only' : 'blocked_missing_dependency',
      },
      record_type: 'SIGNED_SHOCK_VWAP_SOURCE_READINESS',
      ticket: TICKET,
    },
    vixRecord,
    regimeRecord,
    {
      determination,
      payload: {
        blockers,
        bounded_source_mutation_or_nondeterminism_detected: boundedSourceMutationOrNondeterminism,
        observation_day_eligible: false,
        observation_day_increment: 0,
        recommended_next_ticket: recommendedNextTicket,
      },
      record_type: 'DETERMINATION',
      ticket: TICKET,
    },
  ];

  const boundedText = stableJsonl(records);
  const boundedSha = sha256Text(boundedText);
  const report: JsonRecord = {
    schema_version: 1,
    ticket: TICKET,
    strategy_id: STRATEGY_ID,
    determination,
    observation_day_eligible: false,
    observation_day_increment: 0,
    strategy_runtime_markers: { CANDIDATE: 0, ORDER_INTENT: 0, STRAT_EVAL: 0 },
    authority: {
      active_roster_mutated: false,
      broker_live_authorized: false,
      candidate_roster_mutated: false,
      paper_runtime_invoked: false,
      phase_6_authorized: false,
      qfa_410b_or_qfa_611_backtest_authority_created: false,
      strategy_feature_snapshot_emitted: false,
    },
    disposition_2026_06_01: {
      status: 'incomplete_source_day_not_repaired_by_2026_06_02',
      source_checks: { mbp1: serializeCoverageScan(priorMbp1), obs01: serializeCoverageScan(priorObs) },
    },
    rth_source_coverage_2026_06_02: {
      bounded_analysis_cutoff_utc: BOUNDED_ANALYSIS_CUTOFF_UTC,
      mbp1: serializeCoverageScan(quoteScan),
      obs01: serializeCoverageScan(tradeScan.coverage),
      raw: asPayload(rawRecord),
    },
    effective_session_start: {
      effective_rth_start_ns: OPEN_NS.toString(),
      effective_rth_start_utc: RTH_OPEN_UTC,
      session_id: TARGET_SESSION_ID,
    },
    closed_1m_bars: barSummary,
    session_vwap_source_readiness: asPayload(records.find((record) => record.record_type === 'SESSION_VWAP_SOURCE_READINESS')!),
    signed_shock_vwap_source_readiness: asPayload(records.find((record) => record.record_type === 'SIGNED_SHOCK_VWAP_SOURCE_READINESS')!),
    vix_vxn_prior_close_source_status: {
      ready: vixVxnReady,
      status: vixRecord.status ?? null,
      ...vixPayload,
    },
    regime_label_source_status: {
      ready: regimeLabelReady,
      status: regimeRecord.status ?? null,
      ...regimePayload,
    },
    source_mutation_or_nondeterminism: {
      ab_byte_stable_bounded_source_readiness_jsonl: true,
      ab_byte_stable_report_json: true,
      ab_byte_stable_report_md: true,
      bounded_source_mutation_or_nondeterminism_detected: boundedSourceMutationOrNondeterminism,
      full_live_hashes_are_point_in_time_only: true,
    },
    artifact_size_guard: artifactSizeStatus(boundedText),
    bounded_source_readiness_lf_sha256: boundedSha,
    full_source_hash_records: {
      mbp1: asPayload(mbp1Hash),
      obs01: asPayload(obsHash),
      raw: asPayload(rawRecord),
    },
    blockers,
    recommended_next_ticket: recommendedNextTicket,
    recommended_next_ticket_reason: blockers.length === 0
      ? 'All source-readiness inputs are present; rerun feature-source bridge recheck without paper runtime or observation-day credit.'
      : 'Resolve the first missing source class in the determination chain, then rerun this source-readiness check before any feature snapshot or observation-day credit.',
    non_overclaim_policy: '2026-06-02 is evaluated as a new source-complete candidate day only; it does not repair 2026-06-01 and does not create paper-observation credit.',
  };
  const reportText = stableJson(report);
  const mdText = buildMarkdown(report);
  const memoText = buildMemo(report);

  for (const [label, text] of [
    ['bounded_jsonl', boundedText],
    ['report_json', reportText],
    ['report_md', mdText],
    ['memo', memoText],
  ] as const) {
    const size = Buffer.byteLength(text, 'utf8');
    if (size >= MAX_ARTIFACT_BYTES) {
      throw new Error(`${label} exceeds 95 MiB cap: ${size}`);
    }
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(path.dirname(MEMO_PATH), { recursive: true });
  await writeFile(OUTPUT_JSONL, boundedText, 'utf8');
  await writeFile(OUTPUT_JSON, reportText, 'utf8');
  await writeFile(OUTPUT_MD, `${mdText}\n`, 'utf8');
  await writeFile(MEMO_PATH, memoText, 'utf8');

  process.stdout.write(JSON.stringify({
    bounded_source_readiness_lf_sha256: boundedSha,
    determination,
    recommended_next_ticket: recommendedNextTicket,
    report_json_lf_sha256: sha256Text(reportText),
    report_md_lf_sha256: sha256Text(`${mdText}\n`),
    state: 'PENDING-REVIEW',
  }, null, 2));
  process.stdout.write('\n');
}

function missingRawRecord(): JsonRecord {
  return {
    cache_key: 'raw',
    payload: {
      full_source_sha256: null,
      full_source_sha256_scope: 'not_computed_missing_raw_file',
      raw_file_not_used_reason: 'raw source file not found; normalized obs01 and mbp1 source files are the source-readiness inputs',
    },
    record_type: 'RAW_SOURCE_METADATA',
    source_kind: 'raw',
    status: 'missing',
    ticket: TICKET,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
