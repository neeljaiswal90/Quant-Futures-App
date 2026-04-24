import type {
  EntryStateVector,
  MarketRegime,
  SetupType,
} from '../contracts/candidate.js';
import { ENTRY_STATE_VECTOR_SCHEMA_VERSION } from '../contracts/candidate.js';
import type { LobSnapshot, MarketSnapshot, OhlcvBar } from '../contracts/market.js';
import { tryGetContractSpec } from '../risk/contracts.js';
import {
  computeNormalizers,
  computeSigmaPts,
  zScorePts,
  DEFAULT_NORMALIZATION_CONFIG,
  type NormalizationConfig,
} from './normalization.js';
import { detectSwings, type Bar as StructureBar } from './structure.js';
import {
  hydrateEntryStateVectorOrderflow,
  makeOrderflowBuffer,
  type OrderflowRollingBuffer,
} from './orderflow-state.js';

export interface PullbackGeometry {
  pullback_ratio: number | null;
  impulse_maturity_bars: number | null;
}

export function computePullbackGeometry(
  bars1m: OhlcvBar[],
  currentPrice: number,
  direction: 'long' | 'short',
  lookback: number = 3,
): PullbackGeometry {
  if (!bars1m || bars1m.length < lookback * 2 + 2) {
    return { pullback_ratio: null, impulse_maturity_bars: null };
  }

  const swings = detectSwings(bars1m as StructureBar[], lookback);
  if (swings.length < 2) {
    return { pullback_ratio: null, impulse_maturity_bars: null };
  }

  const highs = swings.filter((s) => s.type === 'high');
  const lows = swings.filter((s) => s.type === 'low');

  if (direction === 'long') {
    const impulse = highs[highs.length - 1];
    if (!impulse) return { pullback_ratio: null, impulse_maturity_bars: null };
    const base = [...lows].reverse().find((s) => s.barIndex < impulse.barIndex);
    if (!base) return { pullback_ratio: null, impulse_maturity_bars: null };
    const impulseSize = impulse.price - base.price;
    if (!(impulseSize > 0)) return { pullback_ratio: null, impulse_maturity_bars: null };
    return {
      pullback_ratio: round4((impulse.price - currentPrice) / impulseSize),
      impulse_maturity_bars: bars1m.length - 1 - impulse.barIndex,
    };
  }

  const impulse = lows[lows.length - 1];
  if (!impulse) return { pullback_ratio: null, impulse_maturity_bars: null };
  const base = [...highs].reverse().find((s) => s.barIndex < impulse.barIndex);
  if (!base) return { pullback_ratio: null, impulse_maturity_bars: null };
  const impulseSize = base.price - impulse.price;
  if (!(impulseSize > 0)) return { pullback_ratio: null, impulse_maturity_bars: null };
  return {
    pullback_ratio: round4((currentPrice - impulse.price) / impulseSize),
    impulse_maturity_bars: bars1m.length - 1 - impulse.barIndex,
  };
}

export interface BuildEntryStateVectorOptions {
  tickSize?: number;
  normalizationConfig?: NormalizationConfig;
  regime?: MarketRegime | null;
  orderflowBuffer?: OrderflowRollingBuffer;
}

export function buildEntryStateVector(
  snap: MarketSnapshot,
  lob: LobSnapshot | null,
  direction: 'long' | 'short',
  setupType: SetupType,
  options: BuildEntryStateVectorOptions = {},
): EntryStateVector | null {
  let tickSize = options.tickSize;
  if (tickSize === undefined) {
    tickSize = tryGetContractSpec(snap.symbol)?.tick_size;
  }
  if (!(tickSize && tickSize > 0)) return null;

  const sigmaPts = computeSigmaPts(snap, tickSize);
  if (!(sigmaPts && sigmaPts > 0)) return null;

  const norms = computeNormalizers(
    snap,
    options.normalizationConfig ?? DEFAULT_NORMALIZATION_CONFIG,
  );

  const dirSign = direction === 'long' ? 1 : -1;
  const ind = snap.indicators_1m;

  const baseVector: EntryStateVector = {
    schema_version: ENTRY_STATE_VECTOR_SCHEMA_VERSION,
    timestamp_unix: snap.timestamp_unix,
    direction,
    setup_type: setupType,
    sigma_pts: sigmaPts,
    micro_atr: norms?.micro_atr ?? null,
    room_atr: norms?.room_atr ?? null,
    session_atr: norms?.session_atr ?? null,
    z_ema9: ind.ema_9 != null ? zScorePts((snap.price - ind.ema_9) * dirSign, sigmaPts) : null,
    z_ema21: ind.ema_21 != null ? zScorePts((snap.price - ind.ema_21) * dirSign, sigmaPts) : null,
    z_vwap: ind.vwap != null ? zScorePts((snap.price - ind.vwap) * dirSign, sigmaPts) : null,
    ...computePullbackGeometry(snap.bars_1m ?? [], snap.price, direction),
    regime: options.regime ?? null,
    ofi_10s: null,
    ofi_30s: null,
    z_ofi_10s: null,
    z_ofi_30s: null,
    z_ofi_blend: null,
    queue_imbalance_5: null,
    microprice_offset_pts: null,
    lob_state: 'missing',
    ofi_reliability: 'unknown',
  };

  const orderflowBuffer = options.orderflowBuffer ?? makeOrderflowBuffer();
  return hydrateEntryStateVectorOrderflow(baseVector, lob, direction, orderflowBuffer);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
