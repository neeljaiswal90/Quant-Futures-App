import type { EntryStateVector } from '../contracts/candidate.js';
import type {
  EntryStateLobState,
  EntryStateOfiReliability,
  LobSnapshot,
  MarketSnapshot,
} from '../contracts/market.js';

export const ORDERFLOW_SHORT_WINDOW_MS = 10_000;
export const ORDERFLOW_LONG_WINDOW_MS = 30_000;
export const ORDERFLOW_Z_WARMUP_SAMPLES = 30;
export const ORDERFLOW_MIN_TOTAL_DEPTH_10LVL = 20;
export const ORDERFLOW_MIN_SIDE_DEPTH_10LVL = 5;

export interface OrderflowFeatures {
  ofi_10s: number | null;
  ofi_30s: number | null;
  z_ofi_10s: number | null;
  z_ofi_30s: number | null;
  z_ofi_blend: number | null;
  queue_imbalance_5: number | null;
  microprice_offset_pts: number | null;
  lob_state: EntryStateLobState;
  ofi_reliability: EntryStateOfiReliability;
}

interface OrderflowSample {
  timestamp_ms: number;
  value: number;
}

interface BestBidOfferState {
  timestamp_ms: number;
  bid: number;
  ask: number;
  bid_size: number;
  ask_size: number;
}

export interface OrderflowRollingBuffer {
  last_bbo: BestBidOfferState | null;
  contributions: OrderflowSample[];
  ofi_10s_history: number[];
  ofi_30s_history: number[];
  orderflow_buffer_ready: boolean;
}

export function makeOrderflowBuffer(): OrderflowRollingBuffer {
  return {
    last_bbo: null,
    contributions: [],
    ofi_10s_history: [],
    ofi_30s_history: [],
    orderflow_buffer_ready: false,
  };
}

export function deriveOrderflowSessionId(snap: MarketSnapshot): string {
  const timestamp = new Date(snap.timestamp_unix * 1000);
  const year = timestamp.getUTCFullYear();
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const day = String(timestamp.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function computeOfiContribution(
  prev: { bid: number; ask: number; bid_size: number; ask_size: number },
  curr: { bid: number; ask: number; bid_size: number; ask_size: number },
): number {
  let iBid: number;
  if (curr.bid > prev.bid) iBid = curr.bid_size;
  else if (curr.bid === prev.bid) iBid = curr.bid_size - prev.bid_size;
  else iBid = -prev.bid_size;

  let iAsk: number;
  if (curr.ask < prev.ask) iAsk = curr.ask_size;
  else if (curr.ask === prev.ask) iAsk = curr.ask_size - prev.ask_size;
  else iAsk = -prev.ask_size;

  return iBid - iAsk;
}

export function computeMicroprice(
  bid: number,
  ask: number,
  bidSize: number,
  askSize: number,
): number | null {
  if (!(bid > 0) || !(ask > 0) || !(bidSize > 0) || !(askSize > 0)) return null;
  return (ask * bidSize + bid * askSize) / (bidSize + askSize);
}

export function computeOrderflowFeatures(
  buffer: OrderflowRollingBuffer,
  lob: LobSnapshot | null,
  direction: 'long' | 'short',
): OrderflowFeatures {
  const dirSign = direction === 'long' ? 1 : -1;
  if (!lob || lob.data_quality === 'unavailable') {
    return nullOrderflow('missing', 'unknown');
  }
  if (lob.data_quality === 'stale') {
    return nullOrderflow('stale', 'unknown');
  }
  if (!(isFinitePositive(lob.bid) && isFinitePositive(lob.ask) && isFinitePositive(lob.bid_size) && isFinitePositive(lob.ask_size))) {
    return nullOrderflow('invalid', 'unknown');
  }
  if (lob.ask <= lob.bid) {
    return nullOrderflow('invalid', 'unknown');
  }

  const totalBidDepth = lob.total_bid_depth_10lvl ?? lob.bid_size;
  const totalAskDepth = lob.total_ask_depth_10lvl ?? lob.ask_size;
  const isSparse = totalBidDepth + totalAskDepth < ORDERFLOW_MIN_TOTAL_DEPTH_10LVL
    || totalBidDepth < ORDERFLOW_MIN_SIDE_DEPTH_10LVL
    || totalAskDepth < ORDERFLOW_MIN_SIDE_DEPTH_10LVL;

  if (buffer.last_bbo && lob.timestamp_ms <= buffer.last_bbo.timestamp_ms) {
    return nullOrderflow('invalid', 'unknown');
  }

  if (buffer.last_bbo) {
    buffer.contributions.push({
      timestamp_ms: lob.timestamp_ms,
      value: computeOfiContribution(buffer.last_bbo, {
        bid: lob.bid,
        ask: lob.ask,
        bid_size: lob.bid_size,
        ask_size: lob.ask_size,
      }),
    });
  }

  buffer.last_bbo = {
    timestamp_ms: lob.timestamp_ms,
    bid: lob.bid,
    ask: lob.ask,
    bid_size: lob.bid_size,
    ask_size: lob.ask_size,
  };

  trimSamples(buffer.contributions, lob.timestamp_ms - ORDERFLOW_LONG_WINDOW_MS);

  const ofi10 = sumWithin(buffer.contributions, lob.timestamp_ms - ORDERFLOW_SHORT_WINDOW_MS);
  const ofi30 = sumWithin(buffer.contributions, lob.timestamp_ms - ORDERFLOW_LONG_WINDOW_MS);

  buffer.ofi_10s_history.push(ofi10);
  buffer.ofi_30s_history.push(ofi30);
  if (buffer.ofi_10s_history.length > ORDERFLOW_Z_WARMUP_SAMPLES * 4) {
    buffer.ofi_10s_history.shift();
  }
  if (buffer.ofi_30s_history.length > ORDERFLOW_Z_WARMUP_SAMPLES * 4) {
    buffer.ofi_30s_history.shift();
  }
  buffer.orderflow_buffer_ready = buffer.ofi_10s_history.length >= ORDERFLOW_Z_WARMUP_SAMPLES;

  const z10 = zScoreLatest(buffer.ofi_10s_history);
  const z30 = zScoreLatest(buffer.ofi_30s_history);
  const zBlend = z10 != null && z30 != null
    ? round4(dirSign * ((z10 + z30) / 2))
    : z10 != null
      ? round4(dirSign * z10)
      : z30 != null
        ? round4(dirSign * z30)
        : null;

  const microprice = computeMicroprice(lob.bid, lob.ask, lob.bid_size, lob.ask_size);
  const mid = (lob.bid + lob.ask) / 2;
  const queueImbalance = lob.depth_imbalance_5 != null
    ? round4(dirSign * lob.depth_imbalance_5)
    : round4(dirSign * ((lob.bid_size - lob.ask_size) / (lob.bid_size + lob.ask_size)));

  return {
    ofi_10s: round4(dirSign * ofi10),
    ofi_30s: round4(dirSign * ofi30),
    z_ofi_10s: z10 != null ? round4(dirSign * z10) : null,
    z_ofi_30s: z30 != null ? round4(dirSign * z30) : null,
    z_ofi_blend: zBlend,
    queue_imbalance_5: queueImbalance,
    microprice_offset_pts: microprice != null ? round4(dirSign * (microprice - mid)) : null,
    lob_state: isSparse ? 'sparse' : 'fresh',
    ofi_reliability: isSparse ? 'sparse' : 'full',
  };
}

export function hydrateEntryStateVectorOrderflow(
  vector: EntryStateVector,
  lob: LobSnapshot | null,
  direction: 'long' | 'short',
  buffer: OrderflowRollingBuffer,
): EntryStateVector {
  const features = computeOrderflowFeatures(buffer, lob, direction);
  return {
    ...vector,
    ofi_10s: features.ofi_10s,
    ofi_30s: features.ofi_30s,
    z_ofi_10s: features.z_ofi_10s,
    z_ofi_30s: features.z_ofi_30s,
    z_ofi_blend: features.z_ofi_blend,
    queue_imbalance_5: features.queue_imbalance_5,
    microprice_offset_pts: features.microprice_offset_pts,
    lob_state: features.lob_state,
    ofi_reliability: features.ofi_reliability,
  };
}

function sumWithin(samples: OrderflowSample[], cutoffMs: number): number {
  let total = 0;
  for (const sample of samples) {
    if (sample.timestamp_ms >= cutoffMs) total += sample.value;
  }
  return total;
}

function trimSamples(samples: OrderflowSample[], cutoffMs: number): void {
  while (samples.length > 0 && samples[0]!.timestamp_ms < cutoffMs) {
    samples.shift();
  }
}

function zScoreLatest(values: number[]): number | null {
  if (values.length < ORDERFLOW_Z_WARMUP_SAMPLES) return null;
  const latest = values[values.length - 1]!;
  const history = values.slice(0, -1);
  const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
  const variance = history.reduce((sum, value) => sum + (value - mean) ** 2, 0) / history.length;
  const std = Math.sqrt(variance);
  if (!(std > 0)) return 0;
  return (latest - mean) / std;
}

function nullOrderflow(
  lobState: EntryStateLobState,
  reliability: EntryStateOfiReliability,
): OrderflowFeatures {
  return {
    ofi_10s: null,
    ofi_30s: null,
    z_ofi_10s: null,
    z_ofi_30s: null,
    z_ofi_blend: null,
    queue_imbalance_5: null,
    microprice_offset_pts: null,
    lob_state: lobState,
    ofi_reliability: reliability,
  };
}

function isFinitePositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
