import { describe, expect, it } from 'vitest';
import { atr, computeIndicators, ema, rsi, vwap } from '../../src/features/indicators.js';
import { buildEntryStateVector } from '../../src/features/entry-state.js';
import {
  computeMicroprice,
  computeOfiContribution,
  computeOrderflowFeatures,
  makeOrderflowBuffer,
} from '../../src/features/orderflow-state.js';
import { computeSessionLevels } from '../../src/features/session-levels.js';
import { detectStructure, detectSwings } from '../../src/features/structure.js';
import { makeBars, makeSnapshot } from './helpers.js';

describe('Local indicator and feature primitives', () => {
  it('computes EMA, RSI, ATR, and VWAP from local bars', () => {
    const bars = makeBars(Array.from({ length: 40 }, (_, index) => 100 + index));
    expect(ema(bars.map((bar) => bar.close), 9)).not.toBeNull();
    expect(rsi(bars.map((bar) => bar.close), 14)).not.toBeNull();
    expect(atr(bars, 14)).toBeGreaterThan(0);
    expect(vwap(bars)).toBeGreaterThan(0);
    expect(computeIndicators(bars).ema_50).toBeNull();
  });

  it('detects structure swings and session levels locally', () => {
    const closes = [100, 102, 105, 103, 99, 96, 94, 97, 100, 104, 108, 110, 106, 103];
    const bars = makeBars(closes);
    expect(detectSwings(bars, 2).length).toBeGreaterThan(0);
    expect(detectStructure(bars, 2).recent_swing_highs.length).toBeGreaterThan(0);
    expect(computeSessionLevels(bars, 9, 5).opening_range_high).not.toBeNull();
  });

  it('builds entry-state vectors with explicit lob input', () => {
    const snap = makeSnapshot();
    const buffer = makeOrderflowBuffer();
    const first = computeOrderflowFeatures(buffer, {
      timestamp_ms: 1,
      bbo_age_ms: 0,
      data_quality: 'full_depth',
      bid: 20_015,
      ask: 20_015.25,
      bid_size: 12,
      ask_size: 8,
      total_bid_depth_10lvl: 55,
      total_ask_depth_10lvl: 42,
      depth_imbalance_5: 0.2,
    }, 'long');
    expect(first.lob_state).toBe('fresh');

    const vector = buildEntryStateVector(
      snap,
      {
        timestamp_ms: 2,
        bbo_age_ms: 0,
        data_quality: 'full_depth',
        bid: 20_015,
        ask: 20_015.25,
        bid_size: 14,
        ask_size: 6,
        total_bid_depth_10lvl: 60,
        total_ask_depth_10lvl: 38,
        depth_imbalance_5: 0.3,
      },
      'long',
      'trend_pullback_long',
      { orderflowBuffer: buffer, regime: 'trending_up' },
    );

    expect(vector).not.toBeNull();
    expect(vector?.sigma_pts).toBeGreaterThan(0);
    expect(vector?.lob_state).toBe('fresh');
    expect(vector?.queue_imbalance_5).toBeGreaterThan(0);
  });

  it('computes OFI contributions and microprice deterministically', () => {
    expect(computeOfiContribution(
      { bid: 100, ask: 100.25, bid_size: 10, ask_size: 10 },
      { bid: 100, ask: 100.25, bid_size: 15, ask_size: 6 },
    )).toBe(9);
    expect(computeMicroprice(100, 100.25, 12, 8)).toBeGreaterThan(100);
  });
});
