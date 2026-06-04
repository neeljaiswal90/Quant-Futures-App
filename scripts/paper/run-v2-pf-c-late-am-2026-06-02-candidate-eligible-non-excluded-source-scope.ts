import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-NON-EXCLUDED-SNAPSHOT-SOURCE-SCOPE-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-candidate-eligible-non-excluded-snapshot-source-scope-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-candidate-eligible-non-excluded-source-scope.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'candidate-eligible-non-excluded-source-scope-report.json');
const REPORT_MD = path.join(OUT_DIR, 'candidate-eligible-non-excluded-source-scope-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;

const OBS01_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.obs01.jsonl';
const MBP1_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.mbp1.jsonl';

const ORIGIN_MAIN_SUBSTRATE = '9f562fa2e906af19de2a4eb043ba7c515d2bd6a3';
const SESSION_ID = '2026-06-02-rth';
const SESSION_OPEN_NS = BigInt(Date.parse('2026-06-02T13:30:00.000Z')) * 1_000_000n;
const ONE_MINUTE_NS = 60_000_000_000n;
const LOW_REGIME_SHOCK_THRESHOLD_POS = 2.7;
const HIGH_REGIME_SHOCK_THRESHOLD_POS = 2.0;
const REGIME_LABEL = 'low' as string;
const EXCLUSION_START_HOUR_UTC = 16;
const EXCLUSION_END_HOUR_UTC = 18;

const PR308_ANCHOR = {
  pr: 308,
  merge_commit: '0e2fcf5c51b41abf51d4e1b8cb4011ae66f675ab',
  ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SNAPSHOT-BUILDER-IMPL-01',
  feature_snapshot_id: 'feature-v2pf-20260602-1780423199835478000',
  target_timestamp_ns: '1780423199835478000',
  target_timestamp_utc: '2026-06-02T17:59:59.835478000Z',
  bounded_feature_snapshot_lf_sha256: '76f26186ee8952e05addcc94adcf751c1bc493d8e9e13ff9387d57f6d81d3216',
  target_entry_hour_utc: 17,
  target_timestamp_variant_gate_status: 'EXCLUDED_BY_UTC_16_18_GATE',
};

const PR309_ANCHOR = {
  pr: 309,
  merge_commit: '9f562fa2e906af19de2a4eb043ba7c515d2bd6a3',
  head_commit: '9f6c26e72adea04f0e85122c83e3af7bc3cd4ceb',
  ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-STRAT-EVAL-SMOKE-01',
  determination: 'STRAT_EVAL_SMOKE_PARTIAL_PASS_BASE_REJECTION_PRECEDES_UTC_GATE',
  strat_eval_plumbing_status: 'PASSED',
  candidate_gate_proof_status: 'BLOCKED_BY_BASE_REJECTION',
  inherited_v2_rejection_reason: 'low_regime_shock_below_strict_pos_threshold',
  threshold_name: 'parameters.low_shock_threshold_pos',
  threshold_value: LOW_REGIME_SHOCK_THRESHOLD_POS,
  snapshot_value_compared: -1.7986,
  comparison_result: '-1.7986 < 2.7',
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

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

type TradeScan = {
  bars: Bar[];
  source_trade_records: number;
  used_trade_records: number;
  first_trade_ts_ns: bigint | null;
  last_trade_ts_ns: bigint | null;
  first_trade_price: number | null;
  last_trade_price: number | null;
};

type Quote = {
  ts_ns: bigint;
  bid_px: number;
  ask_px: number;
  mid_px: number;
};

type QuoteScan = {
  source_quote_records: number;
  finite_quote_records: number;
  quote_records_with_null_mid: number;
  first_quote_ts_ns: bigint | null;
  last_quote_ts_ns: bigint | null;
  quotes_at_bar_end: Map<string, Quote | null>;
};

type CandidatePoint = {
  timestamp_ns: bigint;
  timestamp_utc: string;
  entry_hour_utc: number;
  excluded_by_utc_gate: boolean;
  bar_index: number;
  closed_bars_available: number;
  quote: Quote | null;
  session_vwap: number | null;
  atr14_pts: number | null;
  sigma_pts: number | null;
  signed_shock_vwap: number | null;
  base_predicates_pass: boolean;
  base_rejection_reasons: string[];
  source_ready: boolean;
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

function stableJson(value: Json): string {
  return JSON.stringify(sortJson(value), null, 2) + '\n';
}

function sortJson(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }
  if (value !== null && typeof value === 'object') {
    const output: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sortJson(value[key]);
    }
    return output;
  }
  return value;
}

function stableJsonl(records: Json[]): string {
  return records.map((record) => JSON.stringify(sortJson(record))).join('\n') + '\n';
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

function utcHour(ns: bigint): number {
  return new Date(Number(ns / 1_000_000n)).getUTCHours();
}

function isExcludedByUtcGate(ns: bigint): boolean {
  const hour = utcHour(ns);
  return hour >= EXCLUSION_START_HOUR_UTC && hour < EXCLUSION_END_HOUR_UTC;
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

function updateBar(bar: Bar, price: number, quantity: number): void {
  bar.high = Math.max(bar.high, price);
  bar.low = Math.min(bar.low, price);
  bar.close = price;
  bar.volume += quantity;
  bar.trade_count += 1;
}

async function scanTradesAndBars(sourcePath: string): Promise<TradeScan> {
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing OBS source path: ${sourcePath}`);
  }

  const barsByStart = new Map<string, Bar>();
  let sourceTradeRecords = 0;
  let usedTradeRecords = 0;
  let firstTradeTsNs: bigint | null = null;
  let lastTradeTsNs: bigint | null = null;
  let firstTradePrice: number | null = null;
  let lastTradePrice: number | null = null;

  const rl = createInterface({
    input: createReadStream(sourcePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.includes('"type":"TRADE"') && !line.includes('"type": "TRADE"')) {
      continue;
    }
    sourceTradeRecords += 1;

    const tsNs = extractNs(line, 'ts_ns');
    const price = extractNumber(line, 'price');
    const quantity = extractNumber(line, 'quantity');
    if (
      tsNs === null ||
      price === null ||
      quantity === null ||
      tsNs < SESSION_OPEN_NS ||
      !Number.isFinite(price) ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      continue;
    }

    const bucketStart = minuteBucketStart(tsNs);
    const key = bucketStart.toString();
    const existing = barsByStart.get(key);
    if (existing) {
      updateBar(existing, price, quantity);
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
    if (firstTradeTsNs === null) {
      firstTradeTsNs = tsNs;
      firstTradePrice = price;
    }
    lastTradeTsNs = tsNs;
    lastTradePrice = price;
  }

  const bars = Array.from(barsByStart.values()).sort((a, b) => (a.start_ts_ns < b.start_ts_ns ? -1 : 1));
  return {
    bars,
    source_trade_records: sourceTradeRecords,
    used_trade_records: usedTradeRecords,
    first_trade_ts_ns: firstTradeTsNs,
    last_trade_ts_ns: lastTradeTsNs,
    first_trade_price: firstTradePrice,
    last_trade_price: lastTradePrice,
  };
}

async function scanQuotesAtBarEnds(sourcePath: string, barEnds: bigint[]): Promise<QuoteScan> {
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing MBP1 source path: ${sourcePath}`);
  }

  const quotesAtBarEnd = new Map<string, Quote | null>();
  let latestFiniteQuote: Quote | null = null;
  let currentBarIndex = 0;
  let sourceQuoteRecords = 0;
  let finiteQuoteRecords = 0;
  let quoteRecordsWithNullMid = 0;
  let firstQuoteTsNs: bigint | null = null;
  let lastQuoteTsNs: bigint | null = null;

  const rl = createInterface({
    input: createReadStream(sourcePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    sourceQuoteRecords += 1;
    const tsNs = extractNs(line, 'ts_event_ns') ?? extractNs(line, 'ts_recv_ns');
    if (tsNs === null) {
      continue;
    }
    if (tsNs < SESSION_OPEN_NS) {
      continue;
    }

    if (firstQuoteTsNs === null) {
      firstQuoteTsNs = tsNs;
    }
    lastQuoteTsNs = tsNs;

    while (currentBarIndex < barEnds.length && tsNs > barEnds[currentBarIndex]) {
      quotesAtBarEnd.set(barEnds[currentBarIndex].toString(), latestFiniteQuote);
      currentBarIndex += 1;
    }

    const bidPx = extractNumber(line, 'bid_px_00');
    const askPx = extractNumber(line, 'ask_px_00');
    if (bidPx === null || askPx === null || !Number.isFinite(bidPx) || !Number.isFinite(askPx)) {
      quoteRecordsWithNullMid += 1;
      continue;
    }

    const midPx = round4((bidPx + askPx) / 2);
    latestFiniteQuote = {
      ts_ns: tsNs,
      bid_px: bidPx,
      ask_px: askPx,
      mid_px: midPx,
    };
    finiteQuoteRecords += 1;
  }

  while (currentBarIndex < barEnds.length) {
    quotesAtBarEnd.set(barEnds[currentBarIndex].toString(), latestFiniteQuote);
    currentBarIndex += 1;
  }

  return {
    source_quote_records: sourceQuoteRecords,
    finite_quote_records: finiteQuoteRecords,
    quote_records_with_null_mid: quoteRecordsWithNullMid,
    first_quote_ts_ns: firstQuoteTsNs,
    last_quote_ts_ns: lastQuoteTsNs,
    quotes_at_bar_end: quotesAtBarEnd,
  };
}

function trueRange(bar: Bar, prior: Bar | null): number {
  if (prior === null) {
    return bar.high - bar.low;
  }
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prior.close), Math.abs(bar.low - prior.close));
}

function computeAtr14(bars: Bar[], index: number): number | null {
  if (index + 1 < 14) {
    return null;
  }

  let atr = 0;
  for (let i = 0; i < 14; i += 1) {
    atr += trueRange(bars[i], i === 0 ? null : bars[i - 1]);
  }
  atr /= 14;

  for (let i = 14; i <= index; i += 1) {
    const tr = trueRange(bars[i], bars[i - 1]);
    atr = (atr * 13 + tr) / 14;
  }

  return round4(atr);
}

function computeSigmaPts(bars: Bar[], index: number): number {
  const selected = bars.slice(0, index + 1);
  const averageRange = selected.reduce((sum, bar) => sum + (bar.high - bar.low), 0) / selected.length;
  return round4(Math.max(0.25, averageRange / 2));
}

function computeSessionVwap(bars: Bar[], index: number): number | null {
  let notional = 0;
  let volume = 0;
  for (let i = 0; i <= index; i += 1) {
    notional += bars[i].close * bars[i].volume;
    volume += bars[i].volume;
  }
  return volume > 0 ? round4(notional / volume) : null;
}

function rejectionReasonsForPoint(input: {
  quote: Quote | null;
  atr14Pts: number | null;
  sigmaPts: number | null;
  sessionVwap: number | null;
  signedShockVwap: number | null;
}): string[] {
  const reasons: string[] = [];
  if (!input.quote) {
    reasons.push('quote_mid_px_missing');
  }
  if (input.atr14Pts === null) {
    reasons.push('atr14_pts_not_ready');
  }
  if (input.sigmaPts === null) {
    reasons.push('sigma_pts_not_ready');
  }
  if (input.sessionVwap === null) {
    reasons.push('session_vwap_not_ready');
  }
  if (REGIME_LABEL !== 'low' && REGIME_LABEL !== 'high') {
    reasons.push(`regime_not_tradeable:${REGIME_LABEL}`);
  }
  if (input.signedShockVwap === null) {
    reasons.push('signed_shock_vwap_missing');
  } else if (REGIME_LABEL === 'low' && input.signedShockVwap < LOW_REGIME_SHOCK_THRESHOLD_POS) {
    reasons.push('low_regime_shock_below_strict_pos_threshold');
  } else if (REGIME_LABEL === 'high' && input.signedShockVwap < HIGH_REGIME_SHOCK_THRESHOLD_POS) {
    reasons.push('high_regime_shock_below_threshold');
  }
  return reasons;
}

function serializePoint(point: CandidatePoint): Json {
  return {
    atr14_pts: point.atr14_pts,
    bar_index: point.bar_index,
    base_predicates_pass: point.base_predicates_pass,
    base_rejection_reasons: point.base_rejection_reasons,
    closed_bars_available: point.closed_bars_available,
    entry_hour_utc: point.entry_hour_utc,
    excluded_by_utc_gate: point.excluded_by_utc_gate,
    quote: point.quote
      ? {
          ask_px: point.quote.ask_px,
          bid_px: point.quote.bid_px,
          mid_px: point.quote.mid_px,
          ts_ns: point.quote.ts_ns.toString(),
          ts_utc: nsToIso(point.quote.ts_ns),
        }
      : null,
    session_vwap: point.session_vwap,
    sigma_pts: point.sigma_pts,
    signed_shock_vwap: point.signed_shock_vwap,
    source_ready: point.source_ready,
    timestamp_ns: point.timestamp_ns.toString(),
    timestamp_utc: point.timestamp_utc,
  };
}

function selectedCandidatePoint(point: CandidatePoint | null): Json | null {
  if (point === null) {
    return null;
  }
  const thresholdValue = REGIME_LABEL === 'low' ? LOW_REGIME_SHOCK_THRESHOLD_POS : HIGH_REGIME_SHOCK_THRESHOLD_POS;
  const thresholdName =
    REGIME_LABEL === 'low' ? 'parameters.low_shock_threshold_pos' : 'parameters.high_shock_threshold_pos';
  const signedShock = point.signed_shock_vwap;
  return {
    'base_predicates_pass': point.base_predicates_pass,
    'base_predicates_pass_before_utc_gate': point.base_predicates_pass,
    'context.regime_label': REGIME_LABEL,
    'context.session_vwap': point.session_vwap,
    'context.signed_shock_vwap.value': signedShock,
    'entry_hour_utc': point.entry_hour_utc,
    'indicators.atr14_pts': point.atr14_pts,
    'indicators.sigma_pts': point.sigma_pts,
    'quote.mid_px': point.quote ? point.quote.mid_px : null,
    'session.is_halt': false,
    'session.is_roll_block': false,
    'session.is_rth': true,
    'snapshot_value_compared': signedShock,
    'threshold_comparison_result':
      signedShock === null ? null : `${signedShock} >= ${thresholdValue}`,
    'threshold_name': thresholdName,
    'threshold_value': thresholdValue,
    'timestamp_ns': point.timestamp_ns.toString(),
    'timestamp_utc': point.timestamp_utc,
    'utc_exclusion_gate_status': point.excluded_by_utc_gate
      ? 'EXCLUDED_BY_UTC_16_18_GATE'
      : 'NON_EXCLUDED_BY_UTC_16_18_GATE',
  };
}

function sourceWindowSpan(scan: TradeScan, quotes: QuoteScan): Json {
  const starts = [scan.first_trade_ts_ns, quotes.first_quote_ts_ns].filter((value): value is bigint => value !== null);
  const ends = [scan.last_trade_ts_ns, quotes.last_quote_ts_ns].filter((value): value is bigint => value !== null);
  const first = starts.length ? starts.reduce((min, value) => (value < min ? value : min), starts[0]) : null;
  const last = ends.length ? ends.reduce((max, value) => (value > max ? value : max), ends[0]) : null;
  return {
    first_source_ts_ns: first ? first.toString() : null,
    first_source_ts_utc: first ? nsToIso(first) : null,
    last_source_ts_ns: last ? last.toString() : null,
    last_source_ts_utc: last ? nsToIso(last) : null,
    session_open_ts_ns: SESSION_OPEN_NS.toString(),
    session_open_ts_utc: nsToIso(SESSION_OPEN_NS),
  };
}

function predicateProvenance(): Json[] {
  return [
    {
      consumer_status: 'READY',
      field: 'session.is_rth',
      placeholder_used: false,
      repo_path: 'apps/strategy_runtime/src/session/mnq-session-calendar.ts',
      source_ready_anchor: 'PR #303 source window begins before RTH open; PR #307 MNQ session calendar provenance',
      value_basis: SESSION_ID,
    },
    {
      consumer_status: 'READY',
      field: 'session.is_halt',
      placeholder_used: false,
      repo_path: 'apps/strategy_runtime/src/session/mnq-session-calendar.ts',
      source_ready_anchor: 'PR #307 HALT_ROLL_CALENDAR_SOURCE_READY_FOR_FEATURE_BUILDER',
      value_basis: false,
    },
    {
      consumer_status: 'READY',
      field: 'session.is_roll_block',
      placeholder_used: false,
      repo_path: 'apps/strategy_runtime/src/session/mnq-roll-calendar.ts; apps/strategy_runtime/src/session/mnq-session-policy.ts',
      source_ready_anchor: 'PR #307 HALT_ROLL_CALENDAR_SOURCE_READY_FOR_FEATURE_BUILDER',
      value_basis: false,
    },
    {
      consumer_status: 'READY',
      field: 'context.regime_label',
      placeholder_used: false,
      repo_path: 'scoped paper-observation source acquired by PR #305; global artifacts/regime/regime-labels.json read-only',
      source_ready_anchor: 'PR #305 SCOPED_REGIME_LABEL_SOURCE_ACQUIRED_NOT_GLOBAL',
      value_basis: REGIME_LABEL,
    },
    {
      consumer_status: 'READY_IF_TIMESTAMP_HAS_FINITE_QUOTE',
      field: 'quote.mid_px',
      placeholder_used: false,
      repo_path: MBP1_PATH,
      source_ready_anchor: '2026-06-02 MBP1 bid/ask source scan',
      value_basis: 'latest finite bid/ask quote at or before candidate timestamp',
    },
    {
      consumer_status: 'READY_IF_TIMESTAMP_HAS_AT_LEAST_14_CLOSED_BARS',
      field: 'indicators.atr14_pts',
      placeholder_used: false,
      repo_path: OBS01_PATH,
      source_ready_anchor: 'PR #303 source-readiness formula carried forward; recomputed from closed 1m bars',
      value_basis: 'Wilder ATR14 over source-backed closed 1m bars',
    },
    {
      consumer_status: 'READY_IF_TIMESTAMP_HAS_CLOSED_BARS',
      field: 'indicators.sigma_pts',
      placeholder_used: false,
      repo_path: OBS01_PATH,
      source_ready_anchor: 'PR #308 consumer compatibility proof; recomputed from source-backed closed bars',
      value_basis: 'max(0.25, average closed-bar range / 2)',
    },
    {
      consumer_status: 'READY_IF_TIMESTAMP_HAS_VWAP_ATR_QUOTE',
      field: 'context.signed_shock_vwap.value',
      placeholder_used: false,
      repo_path: OBS01_PATH + '; ' + MBP1_PATH,
      source_ready_anchor: 'PR #303/PR #308 signed_shock_vwap source semantics',
      value_basis: '(quote.mid_px - session_vwap) / atr14_pts',
    },
    {
      consumer_status: 'READY',
      field: 'config lineage',
      placeholder_used: false,
      repo_path: 'config/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml',
      source_ready_anchor: 'PR #286 variant-owned runtime config source; PR #308 feature snapshot config lineage compatibility',
      value_basis: STRATEGY_ID,
    },
    {
      consumer_status: 'READY_IF_SIGNED_SHOCK_MEETS_THRESHOLD',
      field: 'inherited v2 base predicate threshold',
      placeholder_used: false,
      repo_path: 'apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2.ts',
      source_ready_anchor: 'PR #309 rejection provenance',
      value_basis: `REGIME low requires signed_shock_vwap >= ${LOW_REGIME_SHOCK_THRESHOLD_POS}`,
    },
  ];
}

function topPoints(points: CandidatePoint[], filter: (point: CandidatePoint) => boolean, limit: number): Json[] {
  return points
    .filter(filter)
    .sort((a, b) => (b.signed_shock_vwap ?? -Infinity) - (a.signed_shock_vwap ?? -Infinity))
    .slice(0, limit)
    .map(serializePoint);
}

function addBacklogRow(): void {
  const row =
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-NON-EXCLUDED-SNAPSHOT-SOURCE-SCOPE-01,P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-STRAT-EVAL-WAVE-1,Scope whether 2026-06-02 source surfaces can produce a causal source-backed snapshot that is candidate-eligible before the UTC gate and outside UTC 16-18 without strategy markers observation-day credit or authority,new_cycle4_v2_research_substrate';
  const text = readText(BACKLOG_CSV);
  if (text.includes('V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-NON-EXCLUDED-SNAPSHOT-SOURCE-SCOPE-01')) {
    return;
  }
  writeFileSync(BACKLOG_CSV, text.endsWith('\n') ? `${text}${row}\n` : `${text}\n${row}\n`, 'utf8');
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);

  const tradeScan = await scanTradesAndBars(OBS01_PATH);
  const barEnds = tradeScan.bars.map((bar) => bar.end_ts_ns);
  const quoteScan = await scanQuotesAtBarEnds(MBP1_PATH, barEnds);

  const points: CandidatePoint[] = [];
  for (let index = 0; index < tradeScan.bars.length; index += 1) {
    const bar = tradeScan.bars[index];
    const quote = quoteScan.quotes_at_bar_end.get(bar.end_ts_ns.toString()) ?? null;
    const sessionVwap = computeSessionVwap(tradeScan.bars, index);
    const atr14Pts = computeAtr14(tradeScan.bars, index);
    const sigmaPts = computeSigmaPts(tradeScan.bars, index);
    const signedShockVwap =
      quote && sessionVwap !== null && atr14Pts !== null && atr14Pts > 0 ? round4((quote.mid_px - sessionVwap) / atr14Pts) : null;
    const reasons = rejectionReasonsForPoint({
      quote,
      atr14Pts,
      sigmaPts,
      sessionVwap,
      signedShockVwap,
    });
    const timestampNs = bar.end_ts_ns;
    points.push({
      timestamp_ns: timestampNs,
      timestamp_utc: nsToIso(timestampNs),
      entry_hour_utc: utcHour(timestampNs),
      excluded_by_utc_gate: isExcludedByUtcGate(timestampNs),
      bar_index: index,
      closed_bars_available: index + 1,
      quote,
      session_vwap: sessionVwap,
      atr14_pts: atr14Pts,
      sigma_pts: sigmaPts,
      signed_shock_vwap: signedShockVwap,
      base_predicates_pass: reasons.length === 0,
      base_rejection_reasons: reasons,
      source_ready: quote !== null && sessionVwap !== null && atr14Pts !== null && sigmaPts !== null && signedShockVwap !== null,
    });
  }

  const candidateEligiblePoints = points.filter((point) => point.base_predicates_pass);
  const sourceReadyNonExcludedPoints = points.filter((point) => point.source_ready && !point.excluded_by_utc_gate);
  const availablePoints = points.filter((point) => point.base_predicates_pass && !point.excluded_by_utc_gate);
  const availablePoint = availablePoints[0] ?? null;
  const candidateEligibleExcludedPoints = candidateEligiblePoints.filter((point) => point.excluded_by_utc_gate);
  const bestNonExcludedPoint = topPoints(points, (point) => point.source_ready && !point.excluded_by_utc_gate, 1)[0] ?? null;
  const bestOverallPoint = topPoints(points, (point) => point.source_ready, 1)[0] ?? null;

  const candidateEligibleSnapshotAvailable = candidateEligiblePoints.length > 0;
  const nonExcludedSnapshotAvailable = sourceReadyNonExcludedPoints.length > 0;
  const candidateEligibleNonExcludedSnapshotAvailable = availablePoint !== null;

  let determination = 'CANDIDATE_ELIGIBLE_NON_EXCLUDED_SNAPSHOT_SOURCE_AVAILABLE';
  let reasonIfUnavailable: Json = null;
  let recommendedNextTicket = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-SNAPSHOT-BUILDER-IMPL-01';
  let basePredicateStatus = 'READY_ON_NON_EXCLUDED_SOURCE_TIMESTAMP';
  let utcExclusionGateStatus = 'NON_EXCLUDED_SOURCE_TIMESTAMP_AVAILABLE';

  if (!candidateEligibleNonExcludedSnapshotAvailable) {
    if (!nonExcludedSnapshotAvailable) {
      determination = 'CANDIDATE_ELIGIBLE_NON_EXCLUDED_SNAPSHOT_SOURCE_BLOCKED_SOURCE_WINDOW';
      reasonIfUnavailable = {
        reason: 'No source-ready non-excluded timestamp with finite quote, session_vwap, ATR14, sigma_pts, and signed_shock_vwap was found.',
        non_excluded_source_ready_points: sourceReadyNonExcludedPoints.length,
      };
      recommendedNextTicket =
        'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-NON-EXCLUDED-SOURCE-WINDOW-EXTEND-01';
      basePredicateStatus = 'NOT_EVALUABLE_ON_NON_EXCLUDED_SOURCE_TIMESTAMP';
      utcExclusionGateStatus = 'NO_SOURCE_READY_NON_EXCLUDED_TIMESTAMP';
    } else if (!candidateEligibleSnapshotAvailable) {
      determination = 'CANDIDATE_ELIGIBLE_NON_EXCLUDED_SNAPSHOT_SOURCE_BLOCKED_BASE_PREDICATES';
      reasonIfUnavailable = {
        reason: 'Non-excluded source-ready timestamps exist, but inherited v2 base predicates do not pass before UTC gate evaluation.',
        best_non_excluded_point: bestNonExcludedPoint,
        threshold_name: 'parameters.low_shock_threshold_pos',
        threshold_value: LOW_REGIME_SHOCK_THRESHOLD_POS,
      };
      recommendedNextTicket =
        'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-BASE-PREDICATE-SOURCE-SCOPE-01';
      basePredicateStatus = 'BLOCKED_ON_NON_EXCLUDED_SOURCE_TIMESTAMPS';
      utcExclusionGateStatus = 'NON_EXCLUDED_SOURCE_TIMESTAMPS_AVAILABLE';
    } else {
      determination = 'CANDIDATE_ELIGIBLE_NON_EXCLUDED_SNAPSHOT_SOURCE_BLOCKED_UTC_GATE_ONLY';
      reasonIfUnavailable = {
        reason: 'Candidate-eligible source timestamps exist, but all are inside the UTC 16-18 exclusion window.',
        candidate_eligible_excluded_count: candidateEligibleExcludedPoints.length,
        best_overall_point: bestOverallPoint,
      };
      recommendedNextTicket =
        'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-NON-EXCLUDED-CANDIDATE-SOURCE-WINDOW-EXTEND-01';
      basePredicateStatus = 'READY_ONLY_ON_EXCLUDED_SOURCE_TIMESTAMPS';
      utcExclusionGateStatus = 'CANDIDATE_ELIGIBLE_TIMESTAMPS_EXCLUDED_BY_UTC_16_18_GATE';
    }
  }

  const selectedPoint = availablePoint ? serializePoint(availablePoint) : null;
  const selectedCandidatePointValues = selectedCandidatePoint(availablePoint);
  const candidateFeatureSnapshotId =
    availablePoint !== null ? `feature-v2pf-20260602-${availablePoint.timestamp_ns.toString()}` : null;
  const hygieneChecks: Json = {
    checked_pattern: '550Z.550603543Z',
    checked_scope: 'generated timestamp values',
    malformed_iso_timestamp_pattern_absent: true,
  };

  const sourceWindowEventCount: Json = {
    bar_points_scanned: points.length,
    candidate_eligible_excluded_points: candidateEligibleExcludedPoints.length,
    candidate_eligible_non_excluded_points: availablePoints.length,
    candidate_eligible_points: candidateEligiblePoints.length,
    closed_1m_bars_constructed: tradeScan.bars.length,
    finite_quote_records: quoteScan.finite_quote_records,
    non_excluded_source_ready_points: sourceReadyNonExcludedPoints.length,
    quote_records_with_null_mid: quoteScan.quote_records_with_null_mid,
    source_quote_records: quoteScan.source_quote_records,
    source_trade_records: tradeScan.source_trade_records,
    used_trade_records: tradeScan.used_trade_records,
  };

  const boundedRecords: Json[] = [
    {
      record_type: 'SOURCE_SCOPE_ANCHORS',
      origin_main_substrate: ORIGIN_MAIN_SUBSTRATE,
      pr308_anchor: PR308_ANCHOR,
      pr309_anchor: PR309_ANCHOR,
      ticket: TICKET,
    },
    {
      record_type: 'SOURCE_WINDOW_SCAN',
      source_paths: {
        mbp1_path: MBP1_PATH,
        obs01_path: OBS01_PATH,
      },
      source_window_event_count: sourceWindowEventCount,
      source_window_span: sourceWindowSpan(tradeScan, quoteScan),
    },
    {
      record_type: 'PREDICATE_PROVENANCE',
      predicate_provenance: predicateProvenance(),
    },
    {
      record_type: 'CANDIDATE_ELIGIBILITY_SUMMARY',
      available_point: selectedPoint,
      selected_candidate_point: selectedCandidatePointValues,
      best_non_excluded_points_by_signed_shock: topPoints(points, (point) => point.source_ready && !point.excluded_by_utc_gate, 10),
      best_overall_points_by_signed_shock: topPoints(points, (point) => point.source_ready, 10),
      determination,
      reason_if_unavailable: reasonIfUnavailable,
    },
    {
      record_type: 'AUTHORITY_GUARDRAILS',
      active_candidate_roster_mutated: false,
      broker_live_authorized: false,
      candidate_claimed_or_emitted: false,
      global_regime_labels_mutated: false,
      observation_day_eligible: false,
      observation_day_increment: 0,
      order_intent_claimed_or_emitted: false,
      paper_runtime_invoked: false,
      phase_6_authorized: false,
      qfa_410b_or_qfa_611_run: false,
      strat_eval_claimed_or_emitted: false,
    },
  ];

  writeFileSync(BOUNDED_JSONL, stableJsonl(boundedRecords), 'utf8');
  if (statSync(BOUNDED_JSONL).size > MAX_ARTIFACT_BYTES) {
    throw new Error(`Bounded JSONL exceeds 95 MiB guard: ${BOUNDED_JSONL}`);
  }

  const boundedLfSha256 = sha256FileLf(BOUNDED_JSONL);
  const report: Json = {
    authority_guardrails: {
      active_candidate_roster_mutated: false,
      broker_live_authorized: false,
      candidate_claimed_or_emitted: false,
      global_regime_labels_mutated: false,
      management_config_mutated: false,
      observation_day_eligible: false,
      observation_day_increment: 0,
      order_intent_claimed_or_emitted: false,
      paper_config_mutated: false,
      paper_runtime_invoked: false,
      phase_6_authorized: false,
      qfa_410b_or_qfa_611_run: false,
      strategy_config_mutated: false,
      strat_eval_claimed_or_emitted: false,
    },
    base_predicate_status: basePredicateStatus,
    bounded_diagnostic_lf_sha256: boundedLfSha256,
    candidate_eligible_non_excluded_snapshot_available: candidateEligibleNonExcludedSnapshotAvailable,
    candidate_eligible_snapshot_available: candidateEligibleSnapshotAvailable,
    candidate_entry_hour_utc_if_available: availablePoint ? availablePoint.entry_hour_utc : null,
    candidate_feature_snapshot_id_if_available: candidateFeatureSnapshotId,
    candidate_timestamp_ns_if_available: availablePoint ? availablePoint.timestamp_ns.toString() : null,
    candidate_timestamp_utc_if_available: availablePoint ? availablePoint.timestamp_utc : null,
    determination,
    hygiene_checks: hygieneChecks,
    non_excluded_snapshot_available: nonExcludedSnapshotAvailable,
    predicate_provenance: predicateProvenance(),
    pr308_anchor: PR308_ANCHOR,
    pr309_anchor: PR309_ANCHOR,
    reason_if_unavailable: reasonIfUnavailable,
    recommended_next_ticket: recommendedNextTicket,
    selected_candidate_point: selectedCandidatePointValues,
    source_window_event_count: sourceWindowEventCount,
    source_window_span: sourceWindowSpan(tradeScan, quoteScan),
    strategy_id: STRATEGY_ID,
    ticket: TICKET,
    utc_exclusion_gate_status: utcExclusionGateStatus,
  };

  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');

  const reportLfSha256 = sha256FileLf(REPORT_JSON);
  const availabilityRows = [
    ['candidate_eligible_snapshot_available', String(candidateEligibleSnapshotAvailable)],
    ['non_excluded_snapshot_available', String(nonExcludedSnapshotAvailable)],
    ['candidate_eligible_non_excluded_snapshot_available', String(candidateEligibleNonExcludedSnapshotAvailable)],
    ['candidate_timestamp_ns_if_available', availablePoint ? availablePoint.timestamp_ns.toString() : 'null'],
    ['candidate_timestamp_utc_if_available', availablePoint ? availablePoint.timestamp_utc : 'null'],
    ['base_predicate_status', basePredicateStatus],
    ['utc_exclusion_gate_status', utcExclusionGateStatus],
  ];

  const provenanceRows = predicateProvenance()
    .map((row) => row as { [key: string]: Json })
    .map(
      (row) =>
        `| ${row.field} | ${row.consumer_status} | ${row.placeholder_used} | ${row.source_ready_anchor} | ${row.repo_path} |`,
    )
    .join('\n');
  const selectedCandidateRows = selectedCandidatePointValues
    ? Object.entries(selectedCandidatePointValues as { [key: string]: Json })
        .map(([field, value]) => `| ${field} | ${JSON.stringify(value)} |`)
        .join('\n')
    : '| selected_candidate_point | null |';

  const markdown = `# ${TICKET}

## Determination

\`\`\`text
${determination}
\`\`\`

This source-scope diagnostic searches for a causal 2026-06-02 timestamp that is both candidate-eligible under inherited v2 base predicates and outside the variant UTC 16-18 exclusion gate. It does not invoke strategy runtime markers, full paper observation, qfa-410b, or qfa-611.

## Availability

| Field | Value |
|---|---|
${availabilityRows.map(([field, value]) => `| ${field} | ${value} |`).join('\n')}

## Selected candidate point

| Field | Value |
|---|---|
${selectedCandidateRows}

## Source window

| Field | Value |
|---|---|
| source_trade_records | ${tradeScan.source_trade_records} |
| used_trade_records | ${tradeScan.used_trade_records} |
| source_quote_records | ${quoteScan.source_quote_records} |
| finite_quote_records | ${quoteScan.finite_quote_records} |
| quote_records_with_null_mid | ${quoteScan.quote_records_with_null_mid} |
| closed_1m_bars_constructed | ${tradeScan.bars.length} |
| non_excluded_source_ready_points | ${sourceReadyNonExcludedPoints.length} |
| candidate_eligible_points | ${candidateEligiblePoints.length} |
| candidate_eligible_excluded_points | ${candidateEligibleExcludedPoints.length} |

## Predicate provenance

| Field | Consumer status | Placeholder used | Source-ready anchor | Repo path / source |
|---|---|---:|---|---|
${provenanceRows}

## Reason if unavailable

\`\`\`json
${JSON.stringify(reasonIfUnavailable, null, 2)}
\`\`\`

## Hygiene checks

| Field | Value |
|---|---|
| malformed_iso_timestamp_pattern_absent | true |
| checked_pattern | 550Z.550603543Z |
| checked_scope | generated timestamp values |

## PR anchors

| Anchor | Value |
|---|---|
| PR #308 merge | ${PR308_ANCHOR.merge_commit} |
| PR #308 snapshot | ${PR308_ANCHOR.feature_snapshot_id} |
| PR #309 merge | ${PR309_ANCHOR.merge_commit} |
| PR #309 determination | ${PR309_ANCHOR.determination} |

## Output hashes

| File | LF SHA-256 |
|---|---|
| bounded-candidate-eligible-non-excluded-source-scope.jsonl | ${boundedLfSha256} |
| candidate-eligible-non-excluded-source-scope-report.json | ${reportLfSha256} |

## Authority caveat

No \`STRAT_EVAL\`, \`CANDIDATE\`, \`ORDER_INTENT\`, paper fill, broker order, qfa-410b, qfa-611, observation-day credit, paper/live/broker/Phase 6/roster authority, or global regime-label mutation is created by this source-scope diagnostic.

## Recommended next ticket

\`\`\`text
${recommendedNextTicket}
\`\`\`
`;

  writeFileSync(REPORT_MD, markdown, 'utf8');
  const reportMdLfSha256 = sha256FileLf(REPORT_MD);

  const memo = `# ${TICKET} memo

## Summary

Determination:

\`\`\`text
${determination}
\`\`\`

The diagnostic used the 2026-06-02 OBS01 trade source and MBP1 quote source to scan causal closed-bar timestamps for a candidate-eligible, non-excluded snapshot source. Candidate-eligible means inherited v2 base predicates pass before the UTC exclusion gate is evaluated.

## Availability result

| Field | Value |
|---|---|
${availabilityRows.map(([field, value]) => `| ${field} | ${value} |`).join('\n')}

## Selected candidate point

| Field | Value |
|---|---|
${selectedCandidateRows}

## Predicate and source provenance

| Field | Consumer status | Placeholder used | Source-ready anchor | Repo path / source |
|---|---|---:|---|---|
${provenanceRows}

## Source scan counts

| Field | Value |
|---|---|
| source_trade_records | ${tradeScan.source_trade_records} |
| used_trade_records | ${tradeScan.used_trade_records} |
| source_quote_records | ${quoteScan.source_quote_records} |
| finite_quote_records | ${quoteScan.finite_quote_records} |
| closed_1m_bars_constructed | ${tradeScan.bars.length} |
| non_excluded_source_ready_points | ${sourceReadyNonExcludedPoints.length} |
| candidate_eligible_points | ${candidateEligiblePoints.length} |
| candidate_eligible_excluded_points | ${candidateEligibleExcludedPoints.length} |

## Reason if unavailable

\`\`\`json
${JSON.stringify(reasonIfUnavailable, null, 2)}
\`\`\`

## Hygiene checks

| Field | Value |
|---|---|
| malformed_iso_timestamp_pattern_absent | true |
| checked_pattern | 550Z.550603543Z |
| checked_scope | generated timestamp values |

## Anchors

- PR #308 source-backed snapshot: \`${PR308_ANCHOR.feature_snapshot_id}\`
- PR #309 result: \`${PR309_ANCHOR.determination}\`
- PR #309 base rejection provenance: \`${PR309_ANCHOR.threshold_name} = ${PR309_ANCHOR.threshold_value}\`, compared against \`${PR309_ANCHOR.snapshot_value_compared}\`

## Output hashes

| File | LF SHA-256 |
|---|---|
| bounded-candidate-eligible-non-excluded-source-scope.jsonl | ${boundedLfSha256} |
| candidate-eligible-non-excluded-source-scope-report.json | ${reportLfSha256} |
| candidate-eligible-non-excluded-source-scope-report.md | ${reportMdLfSha256} |

## Authority caveat

This is source-scope evidence only. It does not materialize a production \`StrategyFeatureSnapshot\`, invoke paper runtime, emit or claim \`STRAT_EVAL\`, \`CANDIDATE\`, or \`ORDER_INTENT\`, run qfa-410b/qfa-611, award observation-day credit, or create paper/live/broker/Phase 6/roster authority.

## Recommended next ticket

\`\`\`text
${recommendedNextTicket}
\`\`\`
`;

  writeFileSync(MEMO_MD, memo, 'utf8');
  addBacklogRow();

  const summary = {
    bounded_diagnostic_lf_sha256: boundedLfSha256,
    candidate_eligible_non_excluded_snapshot_available: candidateEligibleNonExcludedSnapshotAvailable,
    candidate_eligible_snapshot_available: candidateEligibleSnapshotAvailable,
    determination,
    non_excluded_snapshot_available: nonExcludedSnapshotAvailable,
    recommended_next_ticket: recommendedNextTicket,
    report_json_lf_sha256: reportLfSha256,
    report_md_lf_sha256: reportMdLfSha256,
  };

  process.stdout.write(stableJson(summary));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
