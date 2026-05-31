import type {
  ReplaySignalCandidateSeed,
  ReplaySignalRow,
  ReplayTradeTick,
} from '../replay-dataset-input/index.js';
import {
  addNs,
  cmpNs,
  nsToDecimalString,
  secondsToNs,
  toReplaySignalCandidateSeed,
  replaySignalRowToJson,
} from '../replay-dataset-input/index.js';
import {
  FORWARD_RETURN_HORIZONS_SECONDS,
  type ForwardReturnHorizonLabel,
  type ForwardReturnLabelOptions,
  type LabeledReplaySignalRow,
} from './types.js';

const DEFAULT_TICK_SIZE = 0.25;

export function labelReplaySignalRow(
  row: ReplaySignalRow,
  trades: readonly ReplayTradeTick[],
  options: ForwardReturnLabelOptions = {},
): LabeledReplaySignalRow {
  const seed = toReplaySignalCandidateSeed(row);
  return Object.freeze({
    label_schema_version: 1,
    signal: replaySignalRowToJson(row),
    candidate_seed: serializeSeed(seed),
    forward_returns: labelForwardReturnsForSeed(seed, trades, {
      horizonsSeconds: options.horizonsSeconds ?? FORWARD_RETURN_HORIZONS_SECONDS,
      tickSize: options.tickSize ?? DEFAULT_TICK_SIZE,
    }),
  });
}

export function labelForwardReturnsForSeed(
  seed: ReplaySignalCandidateSeed,
  trades: readonly ReplayTradeTick[],
  options: Required<ForwardReturnLabelOptions>,
): readonly ForwardReturnHorizonLabel[] {
  const horizons = validateHorizons(options.horizonsSeconds);
  const tickSize = validateTickSize(options.tickSize);

  if (seed.signal_price === null || seed.signal_price <= 0) {
    return Object.freeze(horizons.map((horizon) =>
      emptyLabel(horizon, 'invalid_signal', seed.normalized_direction),
    ));
  }
  const direction = seed.normalized_direction;
  if (direction === 'neutral' || direction === 'unknown') {
    return Object.freeze(horizons.map((horizon) =>
      emptyLabel(horizon, 'neutral_direction', direction),
    ));
  }

  const entryIndex = firstTradeIndexAtOrAfter(trades, seed.ts_ns);
  if (entryIndex === -1) {
    return Object.freeze(horizons.map((horizon) =>
      emptyLabel(horizon, 'no_post_signal_trade', direction),
    ));
  }

  const entry = trades[entryIndex]!;
  const lastTradeTs = trades.at(-1)?.ts_ns ?? entry.ts_ns;
  return Object.freeze(horizons.map((horizonSeconds) => {
    const horizonEnd = addNs(entry.ts_ns, secondsToNs(horizonSeconds));
    const windowEndIndex = lastTradeIndexAtOrBefore(trades, horizonEnd, entryIndex);
    const horizonTrades = trades.slice(entryIndex, windowEndIndex + 1);
    if (lastTradeTs < horizonEnd) {
      return labelFromWindow({
        direction,
        entry,
        horizonSeconds,
        status: 'tape_eof_before_horizon',
        tickSize,
        trades: horizonTrades,
      });
    }
    if (horizonTrades.length <= 1) {
      return labelFromWindow({
        direction,
        entry,
        horizonSeconds,
        status: 'no_trades_in_horizon',
        tickSize,
        trades: horizonTrades,
      });
    }
    return labelFromWindow({
      direction,
      entry,
      horizonSeconds,
      status: 'ok',
      tickSize,
      trades: horizonTrades,
    });
  }));
}

function labelFromWindow(input: {
  readonly direction: 'long' | 'short';
  readonly entry: ReplayTradeTick;
  readonly horizonSeconds: number;
  readonly status: ForwardReturnHorizonLabel['status'];
  readonly tickSize: number;
  readonly trades: readonly ReplayTradeTick[];
}): ForwardReturnHorizonLabel {
  const trades = input.trades.length === 0 ? [input.entry] : input.trades;
  const exit = trades.at(-1)!;
  let maxMove = Number.NEGATIVE_INFINITY;
  let minMove = Number.POSITIVE_INFINITY;
  let maxFavorablePrice = input.entry.price;
  let maxAdversePrice = input.entry.price;

  for (const trade of trades) {
    const move = directionalMove(input.direction, input.entry.price, trade.price);
    if (move > maxMove) {
      maxMove = move;
      maxFavorablePrice = trade.price;
    }
    if (move < minMove) {
      minMove = move;
      maxAdversePrice = trade.price;
    }
  }

  const realizedPts = directionalMove(input.direction, input.entry.price, exit.price);
  return Object.freeze({
    horizon_seconds: input.horizonSeconds,
    status: input.status,
    direction: input.direction,
    entry_ts_ns: nsToDecimalString(input.entry.ts_ns),
    entry_price: input.entry.price,
    exit_ts_ns: nsToDecimalString(exit.ts_ns),
    exit_price: exit.price,
    realized_pts: roundPriceDelta(realizedPts),
    realized_ticks: roundTicks(realizedPts, input.tickSize),
    mfe_pts: roundPriceDelta(Math.max(maxMove, 0)),
    mfe_ticks: roundTicks(Math.max(maxMove, 0), input.tickSize),
    mae_pts: roundPriceDelta(Math.min(minMove, 0)),
    mae_ticks: roundTicks(Math.min(minMove, 0), input.tickSize),
    max_favorable_price: maxFavorablePrice,
    max_adverse_price: maxAdversePrice,
    trade_count: trades.length,
  });
}

function firstTradeIndexAtOrAfter(
  trades: readonly ReplayTradeTick[],
  tsNs: bigint,
): number {
  let low = 0;
  let high = trades.length - 1;
  let answer = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (cmpNs(trades[mid]!.ts_ns, tsNs) >= 0) {
      answer = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return answer;
}

function lastTradeIndexAtOrBefore(
  trades: readonly ReplayTradeTick[],
  tsNs: bigint,
  floorIndex: number,
): number {
  let low = floorIndex;
  let high = trades.length - 1;
  let answer = floorIndex;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (cmpNs(trades[mid]!.ts_ns, tsNs) <= 0) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

function emptyLabel(
  horizonSeconds: number,
  status: ForwardReturnHorizonLabel['status'],
  direction: ForwardReturnHorizonLabel['direction'],
): ForwardReturnHorizonLabel {
  return Object.freeze({
    horizon_seconds: horizonSeconds,
    status,
    direction,
    entry_ts_ns: null,
    entry_price: null,
    exit_ts_ns: null,
    exit_price: null,
    realized_pts: null,
    realized_ticks: null,
    mfe_pts: null,
    mfe_ticks: null,
    mae_pts: null,
    mae_ticks: null,
    max_favorable_price: null,
    max_adverse_price: null,
    trade_count: 0,
  });
}

function serializeSeed(seed: ReplaySignalCandidateSeed): LabeledReplaySignalRow['candidate_seed'] {
  return Object.freeze({
    seed_schema_version: seed.seed_schema_version,
    seed_id: seed.seed_id,
    ts_ns: nsToDecimalString(seed.ts_ns),
    family: seed.family,
    event_type: seed.event_type,
    signal_price: seed.signal_price,
    level_id: seed.level_id,
    side: seed.side,
    normalized_direction: seed.normalized_direction,
    capture_date: seed.capture_date,
    session: seed.session,
    source_obs01: seed.source_obs01,
  });
}

function validateHorizons(horizons: readonly number[]): readonly number[] {
  if (horizons.length === 0) {
    throw new Error('at least one forward-return horizon is required');
  }
  return Object.freeze([...horizons].map((horizon) => {
    if (!Number.isInteger(horizon) || horizon <= 0) {
      throw new Error(`invalid forward-return horizon: ${horizon}`);
    }
    return horizon;
  }));
}

function validateTickSize(tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error(`tickSize must be positive, got ${tickSize}`);
  }
  return tickSize;
}

function directionalMove(direction: 'long' | 'short', entryPrice: number, price: number): number {
  return direction === 'long' ? price - entryPrice : entryPrice - price;
}

function roundPriceDelta(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

function roundTicks(value: number, tickSize: number): number {
  return Math.round((value / tickSize) * 100_000) / 100_000;
}
