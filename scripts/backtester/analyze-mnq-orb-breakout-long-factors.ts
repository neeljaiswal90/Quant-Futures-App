// @ts-nocheck
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadDbnFile } from '../../apps/strategy_runtime/src/data/dbn-loader.js';
import { loadMnqSessionCalendarConfig, getMnqSessionPhase } from '../../apps/strategy_runtime/src/session/mnq-session-calendar.js';

const CACHE_OHLCV_1M_ROOT = 'D:/QFA-cache/databento/mnq-continuous-included-2019-05-06_2026-06-20/ohlcv-1m';
const TRADE_LEDGER = 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-regime-nofade-riskgt30-daystop300/mnq-12mo-trades.csv';
const OUT_ROOT = 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-factor-audit-01';
const STRATEGY_ID = 'opening_range_box_breakout_long';
const PRICE_SCALE = 1_000_000_000;
const ATR_PERIOD = 14;
const FIRST_RTH_MINUTE = 9 * 60 + 30;
const TEN_AM_MINUTE = 10 * 60;
const ELEVEN_AM_MINUTE = 11 * 60;
const ONE_PM_MINUTE = 13 * 60;

type RthBar = {
  tsNs: bigint;
  tsIso: string;
  tradingDate: string;
  minuteOfDay: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Session = {
  tradingDate: string;
  bars: RthBar[];
  open: number;
  close: number;
  high: number;
  low: number;
  dailyRange: number;
  dailyReturn: number;
  first30Volume: number;
  first30Range: number;
  atr14: Array<number | null>;
  sessionVwap: Array<number | null>;
  priorRange: number | null;
  priorClose: number | null;
  priorTrendState: string;
  first30VolumeTrailingMedian: number | null;
};

type Trade = {
  strategy_id: string;
  candidate_id: string;
  trading_date: string;
  signal_ts_ns: string;
  signal_ts_utc: string;
  direction: string;
  regime_label: string;
  entry_price: number;
  stop_price: number;
  exit_ts_utc: string;
  exit_reason: string;
  gross_usd: number;
  net_usd: number;
  mfe_points: number;
  mae_points: number;
};

type Enriched = Trade & {
  outcome: 'win' | 'loss' | 'flat';
  signal_local_minute: number | null;
  breakout_time_bucket: string;
  early_continuation_vs_late_chase: string;
  opening_range_size: number | null;
  opening_range_size_to_prior_range: number | null;
  opening_range_size_bucket: string;
  first30_volume_ratio: number | null;
  first30_volume_bucket: string;
  prior_day_trend_state: string;
  prior_day_return_points: number | null;
  prior_day_range_points: number | null;
  gap_points: number | null;
  gap_direction: string;
  gap_to_prior_range: number | null;
  gap_bucket: string;
  atr14_at_signal: number | null;
  session_vwap_at_signal: number | null;
  vwap_distance_points: number | null;
  vwap_distance_atr: number | null;
  vwap_distance_bucket: string;
  mfe_30m: number | null;
  mae_30m: number | null;
  mfe_60m: number | null;
  mae_60m: number | null;
  mfe_120m: number | null;
  mae_120m: number | null;
  mfe_60m_to_risk: number | null;
  mae_60m_to_risk: number | null;
  risk_points: number;
};

function round(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function priceFromFixed(value: unknown): number {
  if (typeof value === 'bigint') return Number(value) / PRICE_SCALE;
  if (typeof value === 'number') return value / PRICE_SCALE;
  return Number(value) / PRICE_SCALE;
}

function isoFromNs(tsNs: bigint): string {
  return new Date(Number(tsNs / 1_000_000n)).toISOString().replace('.000Z', '.000000000Z');
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((entry) => path.join(dir, entry))
    .flatMap((entry) => (statSync(entry).isDirectory() ? listFiles(entry) : [entry]))
    .filter((file) => file.endsWith('.dbn.zst'))
    .sort();
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function readTrades(filePath: string): Trade[] {
  const text = readFileSync(filePath, 'utf8').trim();
  const [headerLine, ...lines] = text.split(/\r?\n/);
  const headers = parseCsvLine(headerLine);
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const values = parseCsvLine(line);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
      return {
        strategy_id: row.strategy_id,
        candidate_id: row.candidate_id,
        trading_date: row.trading_date,
        signal_ts_ns: row.signal_ts_ns,
        signal_ts_utc: row.signal_ts_utc,
        direction: row.direction,
        regime_label: row.regime_label,
        entry_price: Number(row.entry_price),
        stop_price: Number(row.stop_price),
        exit_ts_utc: row.exit_ts_utc,
        exit_reason: row.exit_reason,
        gross_usd: Number(row.gross_usd),
        net_usd: Number(row.net_usd),
        mfe_points: Number(row.mfe_points),
        mae_points: Number(row.mae_points),
      };
    })
    .filter((trade) => trade.strategy_id === STRATEGY_ID);
}

async function loadRthBars(): Promise<RthBar[]> {
  const calendar = loadMnqSessionCalendarConfig();
  const bars: RthBar[] = [];
  for (const file of listFiles(CACHE_OHLCV_1M_ROOT)) {
    for await (const record of loadDbnFile(file, 'ohlcv-1m')) {
      const tsNs = BigInt(record.ts_event);
      const phase = getMnqSessionPhase(calendar, tsNs);
      if (!phase.is_rth || phase.journal_phase !== 'rth') continue;
      bars.push({
        tsNs,
        tsIso: isoFromNs(tsNs),
        tradingDate: phase.trading_date,
        minuteOfDay: phase.local.minute_of_day,
        open: priceFromFixed(record.open),
        high: priceFromFixed(record.high),
        low: priceFromFixed(record.low),
        close: priceFromFixed(record.close),
        volume: Number(record.volume ?? 0),
      });
    }
  }
  bars.sort((left, right) => (left.tsNs < right.tsNs ? -1 : left.tsNs > right.tsNs ? 1 : 0));
  return bars;
}

function median(values: number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const midpoint = Math.floor(finite.length / 2);
  if (finite.length % 2 === 1) return finite[midpoint];
  return (finite[midpoint - 1] + finite[midpoint]) / 2;
}

function computeAtr14(bars: RthBar[]): Array<number | null> {
  const trueRanges = bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const priorClose = bars[index - 1].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - priorClose), Math.abs(bar.low - priorClose));
  });
  return trueRanges.map((_, index) => {
    if (index < ATR_PERIOD - 1) return null;
    const window = trueRanges.slice(index - ATR_PERIOD + 1, index + 1);
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
}

function computeSessionVwap(bars: RthBar[]): Array<number | null> {
  let volume = 0;
  let priceVolume = 0;
  return bars.map((bar) => {
    const typical = (bar.high + bar.low + bar.close) / 3;
    volume += bar.volume;
    priceVolume += typical * bar.volume;
    return volume > 0 ? priceVolume / volume : null;
  });
}

function buildSessions(bars: RthBar[]): Session[] {
  const grouped = new Map<string, RthBar[]>();
  for (const bar of bars) {
    const existing = grouped.get(bar.tradingDate) ?? [];
    existing.push(bar);
    grouped.set(bar.tradingDate, existing);
  }
  const sessions: Session[] = [];
  for (const [tradingDate, sessionBars] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    sessionBars.sort((left, right) => (left.tsNs < right.tsNs ? -1 : left.tsNs > right.tsNs ? 1 : 0));
    const first30Bars = sessionBars.filter((bar) => bar.minuteOfDay >= FIRST_RTH_MINUTE && bar.minuteOfDay < TEN_AM_MINUTE);
    const high = Math.max(...sessionBars.map((bar) => bar.high));
    const low = Math.min(...sessionBars.map((bar) => bar.low));
    const open = sessionBars[0].open;
    const close = sessionBars[sessionBars.length - 1].close;
    const previous = sessions.at(-1) ?? null;
    const previousReturn = previous?.dailyReturn ?? null;
    const previousRange = previous?.dailyRange ?? null;
    const previousTrend =
      previousReturn === null || previousRange === null || previousRange <= 0
        ? 'missing'
        : previousReturn / previousRange >= 0.25
          ? 'prior_up_large'
          : previousReturn / previousRange > 0
            ? 'prior_up'
            : previousReturn / previousRange <= -0.25
              ? 'prior_down_large'
              : previousReturn / previousRange < 0
                ? 'prior_down'
                : 'prior_flat';
    sessions.push({
      tradingDate,
      bars: sessionBars,
      open,
      close,
      high,
      low,
      dailyRange: high - low,
      dailyReturn: close - open,
      first30Volume: first30Bars.reduce((sum, bar) => sum + bar.volume, 0),
      first30Range: first30Bars.length > 0 ? Math.max(...first30Bars.map((bar) => bar.high)) - Math.min(...first30Bars.map((bar) => bar.low)) : 0,
      atr14: computeAtr14(sessionBars),
      sessionVwap: computeSessionVwap(sessionBars),
      priorRange: previous?.dailyRange ?? null,
      priorClose: previous?.close ?? null,
      priorTrendState: previousTrend,
      first30VolumeTrailingMedian: median(sessions.slice(-20).map((session) => session.first30Volume)),
    });
  }
  return sessions;
}

function openingRangeSize(session: Session): number | null {
  const bars = session.bars.filter((bar) => bar.minuteOfDay >= FIRST_RTH_MINUTE && bar.minuteOfDay < TEN_AM_MINUTE);
  if (bars.length === 0) return null;
  return Math.max(...bars.map((bar) => bar.high)) - Math.min(...bars.map((bar) => bar.low));
}

function horizonMfeMae(session: Session, startIndex: number, entry: number, minutes: number): { mfe: number | null; mae: number | null } {
  if (startIndex < 0) return { mfe: null, mae: null };
  const bars = session.bars.slice(startIndex, Math.min(session.bars.length, startIndex + minutes + 1));
  if (bars.length === 0) return { mfe: null, mae: null };
  return {
    mfe: Math.max(...bars.map((bar) => bar.high - entry)),
    mae: Math.max(...bars.map((bar) => entry - bar.low)),
  };
}

function bucket(value: number | null, bands: Array<[number, string]>, fallback: string): string {
  if (value === null || !Number.isFinite(value)) return 'missing';
  for (const [max, label] of bands) {
    if (value <= max) return label;
  }
  return fallback;
}

function timeBucket(minute: number | null): string {
  if (minute === null) return 'missing';
  if (minute < TEN_AM_MINUTE) return 'before_or_opening_range';
  if (minute < 10 * 60 + 30) return '10:00-10:30';
  if (minute < ELEVEN_AM_MINUTE) return '10:30-11:00';
  if (minute < 12 * 60) return '11:00-12:00';
  if (minute < ONE_PM_MINUTE) return '12:00-13:00';
  if (minute < 14 * 60) return '13:00-14:00';
  return '14:00+';
}

function continuationBucket(minute: number | null): string {
  if (minute === null) return 'missing';
  if (minute < ELEVEN_AM_MINUTE) return 'early_continuation';
  if (minute < ONE_PM_MINUTE) return 'midday_breakout';
  return 'late_chase';
}

function gapDirection(gap: number | null): string {
  if (gap === null) return 'missing';
  if (gap > 0) return 'gap_up';
  if (gap < 0) return 'gap_down';
  return 'flat';
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath: string, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    writeFileSync(filePath, '');
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function summaryStats(rows: Enriched[]): Record<string, unknown> {
  const values = rows.map((row) => row.net_usd);
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const net = values.reduce((sum, value) => sum + value, 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const average = <K extends keyof Enriched>(key: K): number | null => {
    const selected = rows.map((row) => Number(row[key])).filter(Number.isFinite);
    if (selected.length === 0) return null;
    return selected.reduce((sum, value) => sum + value, 0) / selected.length;
  };
  return {
    trades: rows.length,
    net_usd: round(net, 2),
    profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    win_rate: rows.length > 0 ? round(wins.length / rows.length, 4) : null,
    avg_net_usd: rows.length > 0 ? round(net / rows.length, 4) : null,
    avg_or_size_to_prior_range: round(average('opening_range_size_to_prior_range'), 6),
    avg_first30_volume_ratio: round(average('first30_volume_ratio'), 6),
    avg_gap_to_prior_range: round(average('gap_to_prior_range'), 6),
    avg_vwap_distance_atr: round(average('vwap_distance_atr'), 6),
    avg_mfe_30m: round(average('mfe_30m'), 4),
    avg_mae_30m: round(average('mae_30m'), 4),
    avg_mfe_60m: round(average('mfe_60m'), 4),
    avg_mae_60m: round(average('mae_60m'), 4),
    avg_mfe_120m: round(average('mfe_120m'), 4),
    avg_mae_120m: round(average('mae_120m'), 4),
    avg_mfe_60m_to_risk: round(average('mfe_60m_to_risk'), 6),
    avg_mae_60m_to_risk: round(average('mae_60m_to_risk'), 6),
  };
}

function groupSummary(rows: Enriched[], factor: string, selector: (row: Enriched) => string): Record<string, unknown>[] {
  const groups = new Map<string, Enriched[]>();
  for (const row of rows) {
    const key = selector(row);
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, bucketRows]) => ({
      factor,
      bucket: key,
      ...summaryStats(bucketRows),
    }));
}

function sha256Lf(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

async function main(): Promise<void> {
  mkdirSync(OUT_ROOT, { recursive: true });
  const trades = readTrades(TRADE_LEDGER);
  const sessions = buildSessions(await loadRthBars());
  const sessionByDate = new Map(sessions.map((session) => [session.tradingDate, session]));
  const enriched: Enriched[] = trades.map((trade) => {
    const session = sessionByDate.get(trade.trading_date);
    const signalIndex = session?.bars.findIndex((bar) => bar.tsNs.toString() === trade.signal_ts_ns) ?? -1;
    const signalMinute = session && signalIndex >= 0 ? session.bars[signalIndex].minuteOfDay : null;
    const risk = Math.abs(trade.entry_price - trade.stop_price);
    const orSize = session ? openingRangeSize(session) : null;
    const orSizeToPrior = orSize !== null && session?.priorRange && session.priorRange > 0 ? orSize / session.priorRange : null;
    const first30VolumeRatio =
      session?.first30VolumeTrailingMedian && session.first30VolumeTrailingMedian > 0
        ? session.first30Volume / session.first30VolumeTrailingMedian
        : null;
    const gap = session?.priorClose !== null && session?.priorClose !== undefined ? session.open - session.priorClose : null;
    const gapToPrior = gap !== null && session?.priorRange && session.priorRange > 0 ? gap / session.priorRange : null;
    const atr14 = session && signalIndex >= 0 ? session.atr14[signalIndex] : null;
    const vwap = session && signalIndex >= 0 ? session.sessionVwap[signalIndex] : null;
    const vwapDistance = vwap !== null ? trade.entry_price - vwap : null;
    const vwapDistanceAtr = vwapDistance !== null && atr14 !== null && atr14 > 0 ? vwapDistance / atr14 : null;
    const h30 = session ? horizonMfeMae(session, signalIndex, trade.entry_price, 30) : { mfe: null, mae: null };
    const h60 = session ? horizonMfeMae(session, signalIndex, trade.entry_price, 60) : { mfe: null, mae: null };
    const h120 = session ? horizonMfeMae(session, signalIndex, trade.entry_price, 120) : { mfe: null, mae: null };
    const outcome = trade.net_usd > 0 ? 'win' : trade.net_usd < 0 ? 'loss' : 'flat';
    return {
      ...trade,
      outcome,
      signal_local_minute: signalMinute,
      breakout_time_bucket: timeBucket(signalMinute),
      early_continuation_vs_late_chase: continuationBucket(signalMinute),
      opening_range_size: orSize,
      opening_range_size_to_prior_range: orSizeToPrior,
      opening_range_size_bucket: bucket(orSizeToPrior, [[0.2, '<=0.20'], [0.35, '0.20-0.35'], [0.5, '0.35-0.50'], [0.75, '0.50-0.75']], '>0.75'),
      first30_volume_ratio: first30VolumeRatio,
      first30_volume_bucket: bucket(first30VolumeRatio, [[0.75, '<=0.75'], [1.0, '0.75-1.00'], [1.25, '1.00-1.25'], [1.5, '1.25-1.50']], '>1.50'),
      prior_day_trend_state: session?.priorTrendState ?? 'missing',
      prior_day_return_points: session?.priorClose !== null && session?.priorClose !== undefined ? session.priorClose - (sessions[sessions.findIndex((candidate) => candidate.tradingDate === trade.trading_date) - 1]?.open ?? session.priorClose) : null,
      prior_day_range_points: session?.priorRange ?? null,
      gap_points: gap,
      gap_direction: gapDirection(gap),
      gap_to_prior_range: gapToPrior,
      gap_bucket: bucket(gapToPrior === null ? null : Math.abs(gapToPrior), [[0.05, '<=0.05'], [0.1, '0.05-0.10'], [0.2, '0.10-0.20'], [0.35, '0.20-0.35']], '>0.35'),
      atr14_at_signal: atr14,
      session_vwap_at_signal: vwap,
      vwap_distance_points: vwapDistance,
      vwap_distance_atr: vwapDistanceAtr,
      vwap_distance_bucket: bucket(vwapDistanceAtr, [[0, '<=0'], [1, '0-1'], [2, '1-2'], [3, '2-3'], [4, '3-4']], '>4'),
      mfe_30m: h30.mfe,
      mae_30m: h30.mae,
      mfe_60m: h60.mfe,
      mae_60m: h60.mae,
      mfe_120m: h120.mfe,
      mae_120m: h120.mae,
      mfe_60m_to_risk: h60.mfe !== null && risk > 0 ? h60.mfe / risk : null,
      mae_60m_to_risk: h60.mae !== null && risk > 0 ? h60.mae / risk : null,
      risk_points: risk,
    };
  });

  const tradeRows = enriched.map((row) => ({
    ...row,
    opening_range_size: round(row.opening_range_size, 4),
    opening_range_size_to_prior_range: round(row.opening_range_size_to_prior_range, 6),
    first30_volume_ratio: round(row.first30_volume_ratio, 6),
    prior_day_return_points: round(row.prior_day_return_points, 4),
    prior_day_range_points: round(row.prior_day_range_points, 4),
    gap_points: round(row.gap_points, 4),
    gap_to_prior_range: round(row.gap_to_prior_range, 6),
    atr14_at_signal: round(row.atr14_at_signal, 4),
    session_vwap_at_signal: round(row.session_vwap_at_signal, 4),
    vwap_distance_points: round(row.vwap_distance_points, 4),
    vwap_distance_atr: round(row.vwap_distance_atr, 6),
    mfe_30m: round(row.mfe_30m, 4),
    mae_30m: round(row.mae_30m, 4),
    mfe_60m: round(row.mfe_60m, 4),
    mae_60m: round(row.mae_60m, 4),
    mfe_120m: round(row.mfe_120m, 4),
    mae_120m: round(row.mae_120m, 4),
    mfe_60m_to_risk: round(row.mfe_60m_to_risk, 6),
    mae_60m_to_risk: round(row.mae_60m_to_risk, 6),
    risk_points: round(row.risk_points, 4),
  }));
  const winLoss = [
    { outcome: 'win', ...summaryStats(enriched.filter((row) => row.outcome === 'win')) },
    { outcome: 'loss', ...summaryStats(enriched.filter((row) => row.outcome === 'loss')) },
    { outcome: 'flat', ...summaryStats(enriched.filter((row) => row.outcome === 'flat')) },
    { outcome: 'all', ...summaryStats(enriched) },
  ];
  const bucketRows = [
    ...groupSummary(enriched, 'opening_range_size_to_prior_range', (row) => row.opening_range_size_bucket),
    ...groupSummary(enriched, 'first30_volume_ratio', (row) => row.first30_volume_bucket),
    ...groupSummary(enriched, 'breakout_time_bucket', (row) => row.breakout_time_bucket),
    ...groupSummary(enriched, 'prior_day_trend_state', (row) => row.prior_day_trend_state),
    ...groupSummary(enriched, 'gap_direction', (row) => row.gap_direction),
    ...groupSummary(enriched, 'gap_abs_to_prior_range', (row) => row.gap_bucket),
    ...groupSummary(enriched, 'vwap_distance_atr', (row) => row.vwap_distance_bucket),
    ...groupSummary(enriched, 'early_continuation_vs_late_chase', (row) => row.early_continuation_vs_late_chase),
  ];
  const tradeCsv = path.join(OUT_ROOT, 'orb-breakout-long-factor-trades.csv');
  const winLossCsv = path.join(OUT_ROOT, 'orb-breakout-long-win-loss-factor-comparison.csv');
  const bucketCsv = path.join(OUT_ROOT, 'orb-breakout-long-factor-bucket-summary.csv');
  const reportJson = path.join(OUT_ROOT, 'orb-breakout-long-factor-audit-report.json');
  const reportMd = path.join(OUT_ROOT, 'orb-breakout-long-factor-audit-report.md');
  const manifestPath = path.join(OUT_ROOT, 'manifest.json');
  writeCsv(tradeCsv, tradeRows);
  writeCsv(winLossCsv, winLoss);
  writeCsv(bucketCsv, bucketRows);
  const report = {
    generated_at_utc: new Date().toISOString(),
    determination: 'ORB_BREAKOUT_LONG_FACTOR_AUDIT_COMPLETE_NO_PROMOTION_AUTHORITY',
    strategy_id: STRATEGY_ID,
    source_trade_ledger: TRADE_LEDGER,
    cache_ohlcv_1m_root: CACHE_OHLCV_1M_ROOT,
    counts: {
      sessions: sessions.length,
      trades: enriched.length,
      wins: enriched.filter((row) => row.outcome === 'win').length,
      losses: enriched.filter((row) => row.outcome === 'loss').length,
    },
    win_loss_comparison: winLoss,
    artifact_paths: { tradeCsv, winLossCsv, bucketCsv, reportJson, reportMd, manifestPath },
  };
  writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    '# ORB breakout long factor audit',
    '',
    `Determination: \`${report.determination}\``,
    '',
    '## Scope',
    '',
    `Strategy: \`${STRATEGY_ID}\``,
    '',
    'Factors audited: opening range size/prior range, first30 volume ratio, breakout time bucket, prior-day trend state, gap size/direction, VWAP distance at signal, 30/60/120m MFE/MAE, and early continuation vs late chase.',
    '',
    'No strategy promotion, broker authority, ORDER_INTENT, or roster mutation is authorized by this artifact.',
    '',
    '## Win/loss factor comparison',
    '',
    '| Outcome | Trades | Net USD | PF | Avg OR/prior | Avg first30 vol ratio | Avg gap/prior | Avg VWAP dist ATR | Avg MFE 60m | Avg MAE 60m | Avg MFE60/risk | Avg MAE60/risk |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...winLoss.map((row) => `| ${row.outcome} | ${row.trades} | ${row.net_usd} | ${row.profit_factor ?? ''} | ${row.avg_or_size_to_prior_range ?? ''} | ${row.avg_first30_volume_ratio ?? ''} | ${row.avg_gap_to_prior_range ?? ''} | ${row.avg_vwap_distance_atr ?? ''} | ${row.avg_mfe_60m ?? ''} | ${row.avg_mae_60m ?? ''} | ${row.avg_mfe_60m_to_risk ?? ''} | ${row.avg_mae_60m_to_risk ?? ''} |`),
    '',
    '## Artifacts',
    '',
    `- \`${tradeCsv}\``,
    `- \`${winLossCsv}\``,
    `- \`${bucketCsv}\``,
    `- \`${reportJson}\``,
  ].join('\n');
  writeFileSync(reportMd, `${md}\n`);
  const manifest = {
    generated_at_utc: new Date().toISOString(),
    files: [tradeCsv, winLossCsv, bucketCsv, reportJson, reportMd].map((file) => ({ path: file, lf_sha256: sha256Lf(file) })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'ok', output_root: OUT_ROOT, trades: enriched.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
