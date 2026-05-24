import {
  makeConfigHash,
  makeEventId,
  makeFeatureSnapshotId,
  makeSessionId,
  ns,
  type ConfigLineageRef,
  type Direction,
  type InstrumentIdentity,
  type StrategyId,
} from '../../../src/contracts/index.js';
import type {
  StrategyFeatureSnapshot,
  StrategyFixtureId,
  StrategyScalarMap,
} from '../../../src/strategies/index.js';
import { createNullSignedShockMeasurement } from '../../../src/strategies/index.js';

export const STRATEGY_SYNTHETIC_FIXTURE_VERSION = 1 as const;

const INSTRUMENT: InstrumentIdentity = {
  root: 'MNQ',
  symbol: 'MNQM6',
  exchange: 'CME',
  currency: 'USD',
  contract_month: '2026-06',
  tick_size: 0.25,
  point_value: 2,
  price_decimals: 2,
};

const CONFIG: ConfigLineageRef = {
  config_hash: makeConfigHash('c'.repeat(64)),
  config_version: 1,
};

const SESSION = {
  session_id: makeSessionId('2026-04-23-rth'),
  trading_date: '2026-04-23',
  phase: 'rth',
  is_rth: true,
  is_halt: false,
  is_roll_block: false,
} as const;

const BASE_TS_NS = 1_776_957_600_000_000_000n;

export interface SyntheticStrategyFixture {
  readonly fixture_id: StrategyFixtureId;
  readonly strategy_id: StrategyId;
  readonly description: string;
  readonly expected_direction: Direction;
  readonly expected_gate_state: 'armed';
  readonly expected_reason_fragments: readonly string[];
  readonly snapshot: StrategyFeatureSnapshot;
}

function timestamp(offsetNs: bigint) {
  return ns(BASE_TS_NS + offsetNs);
}

function makeBars(
  direction: Direction,
  startClose: number,
  count = 6,
) {
  return Array.from({ length: count }, (_, index) => {
    const drift = direction === 'long' ? index * 1.25 : -index * 1.25;
    const close = startClose + drift;
    return {
      instrument: INSTRUMENT,
      timeframe: '1m' as const,
      start_ts_ns: timestamp(BigInt(index) * 60_000_000_000n),
      end_ts_ns: timestamp(BigInt(index + 1) * 60_000_000_000n),
      open: close - (direction === 'long' ? 0.75 : -0.75),
      high: close + 2,
      low: close - 2,
      close,
      volume: 120 + index * 5,
      trade_count: 80 + index,
    };
  });
}

function makeSnapshot(input: {
  readonly fixtureId: StrategyFixtureId;
  readonly sourceEventId: string;
  readonly createdOffsetNs: bigint;
  readonly direction: Direction;
  readonly bidPx: number;
  readonly askPx: number;
  readonly lastTradePrice: number;
  readonly barsStartClose: number;
  readonly indicators: StrategyScalarMap;
  readonly trend: 'up' | 'down';
  readonly structure: StrategyScalarMap;
  readonly microstructure: StrategyScalarMap;
  readonly regimeLabel?: StrategyFeatureSnapshot['context']['regime_label'];
  readonly context?: Partial<StrategyFeatureSnapshot['context']>;
}): StrategyFeatureSnapshot {
  return {
    feature_snapshot_id: makeFeatureSnapshotId(input.fixtureId),
    source_event_id: makeEventId(input.sourceEventId),
    created_ts_ns: timestamp(input.createdOffsetNs),
    instrument: INSTRUMENT,
    session: SESSION,
    quote: {
      bid_px: input.bidPx,
      ask_px: input.askPx,
      mid_px: (input.bidPx + input.askPx) / 2,
    },
    last_trade_price: input.lastTradePrice,
    bars: makeBars(input.direction, input.barsStartClose),
    indicators: input.indicators,
    structure: {
      trend: input.trend,
      values: input.structure,
    },
    microstructure: {
      l3_authority: 'authoritative',
      values: input.microstructure,
    },
    context: {
      prior_day_close: null,
      prior_day_high: null,
      prior_day_low: null,
      today_open: input.barsStartClose,
      vix_value: null,
      vix_fresh: false,
      vix_prior_close_percentile: null,
      regime_label: input.regimeLabel ?? 'unknown',
      opening_range_high: null,
      opening_range_low: null,
      opening_range_minutes_elapsed: 0,
      session_vwap: null,
      session_vwap_band_sigma_pts: null,
      overnight_return_bps: null,
      signed_shock_vwap: createNullSignedShockMeasurement('vwap'),
      signed_shock_prior_close: createNullSignedShockMeasurement('prior_close'),
      ...input.context,
    },
    config: CONFIG,
  };
}

export const STRATEGY_SYNTHETIC_FIXTURES = {
  trend_pullback_long: {
    fixture_id: 'fixture_trend_pullback_long',
    strategy_id: 'trend_pullback_long',
    description: 'Fresh bullish trend pullback into the EMA9/EMA21 cluster with positive flow.',
    expected_direction: 'long',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['ema_stack_bullish', 'pullback', 'flow_positive'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_trend_pullback_long',
      sourceEventId: 'source-bar-trend-pullback-long',
      createdOffsetNs: 6n * 60_000_000_000n,
      direction: 'long',
      bidPx: 18598.75,
      askPx: 18599,
      lastTradePrice: 18599,
      barsStartClose: 18585,
      trend: 'up',
      indicators: {
        supertrend_direction: 'up',
        ema_9: 18597.25,
        ema_21: 18591.5,
        ema_50: 18576.75,
        vwap: 18583,
        atr_14: 7.5,
        sigma_pts: 6.75,
        z_ema9: 0.38,
        pullback_ratio: 0.44,
        z_ofi_blend: 0.72,
      },
      structure: {
        bos_direction: 'up',
        choch_sell: 18613.5,
        nearest_resistance: 18618,
        pullback_depth_pts: 7.25,
      },
      microstructure: {
        spread_pts: 0.25,
        ofi_z: 0.81,
        depth_imbalance: 0.34,
        queue_imbalance: 0.27,
      },
    }),
  },
  trend_pullback_short: {
    fixture_id: 'fixture_trend_pullback_short',
    strategy_id: 'trend_pullback_short',
    description: 'Fresh bearish trend pullback into the EMA cluster with sell-side flow intact.',
    expected_direction: 'short',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['ema_stack_bearish', 'pullback', 'flow_negative'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_trend_pullback_short',
      sourceEventId: 'source-bar-trend-pullback-short',
      createdOffsetNs: 7n * 60_000_000_000n,
      direction: 'short',
      bidPx: 18542.5,
      askPx: 18542.75,
      lastTradePrice: 18542.5,
      barsStartClose: 18558,
      trend: 'down',
      indicators: {
        supertrend_direction: 'down',
        ema_9: 18544.25,
        ema_21: 18550.5,
        ema_50: 18565,
        vwap: 18561.75,
        atr_14: 7.75,
        sigma_pts: 6.95,
        z_ema9: 0.41,
        pullback_ratio: 0.46,
        z_ofi_blend: 0.68,
      },
      structure: {
        bos_direction: 'down',
        choch_buy: 18526.25,
        nearest_support: 18521.5,
        pullback_depth_pts: 7.75,
      },
      microstructure: {
        spread_pts: 0.25,
        ofi_z: -0.74,
        depth_imbalance: -0.31,
        queue_imbalance: -0.22,
      },
    }),
  },
  breakout_retest_long: {
    fixture_id: 'fixture_breakout_retest_long',
    strategy_id: 'breakout_retest_long',
    description: 'Bullish breakout holds above the EMA stack and retests prior resistance as support.',
    expected_direction: 'long',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['breakout_retest', 'ema_stack_bullish', 'retest_hold'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_breakout_retest_long',
      sourceEventId: 'source-bar-breakout-retest-long',
      createdOffsetNs: 8n * 60_000_000_000n,
      direction: 'long',
      bidPx: 18622,
      askPx: 18622.25,
      lastTradePrice: 18622.25,
      barsStartClose: 18605,
      trend: 'up',
      indicators: {
        supertrend_direction: 'up',
        ema_9: 18618,
        ema_21: 18608.5,
        ema_50: 18591.25,
        vwap: 18597,
        atr_14: 8.25,
        sigma_pts: 7.2,
        z_ema9: 0.55,
      },
      structure: {
        breakout_level: 18617.5,
        retest_hold: true,
        nearest_resistance: 18642,
        pivot_resistance_1: 18648,
      },
      microstructure: {
        spread_pts: 0.25,
        ofi_z: 0.58,
        depth_imbalance: 0.29,
        queue_imbalance: 0.18,
      },
    }),
  },
  breakdown_retest_short: {
    fixture_id: 'fixture_breakdown_retest_short',
    strategy_id: 'breakdown_retest_short',
    description: 'Bearish breakdown retests broken support as resistance with downside room.',
    expected_direction: 'short',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['breakdown_retest', 'broken_support', 'downside_room'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_breakdown_retest_short',
      sourceEventId: 'source-bar-breakdown-retest-short',
      createdOffsetNs: 9n * 60_000_000_000n,
      direction: 'short',
      bidPx: 18488.25,
      askPx: 18488.5,
      lastTradePrice: 18488.25,
      barsStartClose: 18505,
      trend: 'down',
      indicators: {
        supertrend_direction: 'down',
        ema_9: 18494.5,
        ema_21: 18504,
        ema_50: 18522.25,
        vwap: 18518,
        atr_14: 8.5,
        sigma_pts: 7.45,
        z_ema9: 0.62,
      },
      structure: {
        broken_support: 18496,
        retest_reject: true,
        choch_buy: 18463.5,
        pivot_support_1: 18458,
      },
      microstructure: {
        spread_pts: 0.25,
        ofi_z: -0.62,
        depth_imbalance: -0.36,
        queue_imbalance: -0.21,
      },
    }),
  },
  regime_mean_reversion_long: {
    fixture_id: 'fixture_regime_mean_reversion_long',
    strategy_id: 'regime_mean_reversion_long',
    description: 'High-regime downside overshoot below session VWAP eligible for long mean reversion.',
    expected_direction: 'long',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['regime_high', 'signed_shock', 'armed'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_regime_mean_reversion_long',
      sourceEventId: 'source-bar-regime-mean-reversion-long',
      createdOffsetNs: 10n * 60_000_000_000n,
      direction: 'long',
      bidPx: 18591,
      askPx: 18591.25,
      lastTradePrice: 18591.25,
      barsStartClose: 18600,
      trend: 'up',
      indicators: {
        supertrend_direction: 'up',
        ema_9: 18596,
        ema_21: 18599,
        ema_50: 18602,
        vwap: 18603,
        atr_14: 8,
        sigma_pts: 6,
        z_ema9: -0.82,
        z_ofi_blend: -0.31,
      },
      structure: {
        bos_direction: 'range',
      },
      microstructure: {
        spread_pts: 0.25,
        ofi_z: -0.34,
        depth_imbalance: -0.18,
        queue_imbalance: -0.16,
      },
      regimeLabel: 'high',
    }),
  },
  regime_mean_reversion_short: {
    fixture_id: 'fixture_regime_mean_reversion_short',
    strategy_id: 'regime_mean_reversion_short',
    description: 'High-regime upside overshoot above session VWAP eligible for short mean reversion.',
    expected_direction: 'short',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['regime_high', 'signed_shock', 'armed'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_regime_mean_reversion_short',
      sourceEventId: 'source-bar-regime-mean-reversion-short',
      createdOffsetNs: 11n * 60_000_000_000n,
      direction: 'short',
      bidPx: 18610.75,
      askPx: 18611,
      lastTradePrice: 18610.75,
      barsStartClose: 18600,
      trend: 'down',
      indicators: {
        supertrend_direction: 'down',
        ema_9: 18606,
        ema_21: 18603,
        ema_50: 18600,
        vwap: 18596,
        atr_14: 8,
        sigma_pts: 6,
        z_ema9: 0.82,
        z_ofi_blend: 0.31,
      },
      structure: {
        bos_direction: 'range',
      },
      microstructure: {
        spread_pts: 0.25,
        ofi_z: 0.34,
        depth_imbalance: 0.18,
        queue_imbalance: 0.16,
      },
      regimeLabel: 'high',
    }),
  },
  liquidity_sweep_reversal_long: {
    fixture_id: 'fixture_liquidity_sweep_reversal_long',
    strategy_id: 'liquidity_sweep_reversal_long',
    description: 'Bearish sweep exhausts bid-side depth and sets up a long snapback fade.',
    expected_direction: 'long',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['sweep_direction_down', 'post_sweep_depth_ratio'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_liquidity_sweep_reversal_long',
      sourceEventId: 'source-bar-liquidity-sweep-reversal-long',
      createdOffsetNs: 12n * 60_000_000_000n,
      direction: 'short',
      bidPx: 18591.5,
      askPx: 18591.75,
      lastTradePrice: 18591.5,
      barsStartClose: 18598,
      trend: 'down',
      indicators: {
        supertrend_direction: 'down',
        ema_9: 18594,
        ema_21: 18596,
        ema_50: 18600,
        vwap: 18599,
        atr_14: 6.5,
        sigma_pts: 2,
        z_ema9: -1.2,
        z_ofi_blend: -1.15,
      },
      structure: {
        nearest_support: 18584,
        nearest_resistance: 18602,
      },
      microstructure: {
        spread_pts: 0.75,
        ofi_z: -1.2,
        depth_imbalance: -0.75,
        queue_imbalance: -0.6,
        bars_since_sweep: 0,
      },
    }),
  },
  liquidity_sweep_reversal_short: {
    fixture_id: 'fixture_liquidity_sweep_reversal_short',
    strategy_id: 'liquidity_sweep_reversal_short',
    description: 'Bullish sweep exhausts ask-side depth and sets up a short snapback fade.',
    expected_direction: 'short',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['sweep_direction_up', 'post_sweep_depth_ratio'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_liquidity_sweep_reversal_short',
      sourceEventId: 'source-bar-liquidity-sweep-reversal-short',
      createdOffsetNs: 13n * 60_000_000_000n,
      direction: 'long',
      bidPx: 18610,
      askPx: 18610.25,
      lastTradePrice: 18610.25,
      barsStartClose: 18603,
      trend: 'up',
      indicators: {
        supertrend_direction: 'up',
        ema_9: 18607,
        ema_21: 18604,
        ema_50: 18598,
        vwap: 18602,
        atr_14: 6.25,
        sigma_pts: 2,
        z_ema9: 1.35,
        z_ofi_blend: 1.18,
      },
      structure: {
        nearest_support: 18598,
        nearest_resistance: 18618,
      },
      microstructure: {
        spread_pts: 0.75,
        ofi_z: 1.25,
        depth_imbalance: 0.74,
        queue_imbalance: 0.58,
        bars_since_sweep: 0,
      },
    }),
  },
  vwap_overnight_reversal_long: {
    fixture_id: 'fixture_vwap_overnight_reversal_long',
    strategy_id: 'vwap_overnight_reversal_long',
    description: 'Negative overnight gap remains below VWAP after warmup in a non-trending high-regime fade.',
    expected_direction: 'long',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['target_1_vwap_touch', 'signed_shock_vwap', 'armed'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_vwap_overnight_reversal_long',
      sourceEventId: 'source-bar-vwap-overnight-reversal-long',
      createdOffsetNs: 14n * 60_000_000_000n,
      direction: 'long',
      bidPx: 18590,
      askPx: 18590.25,
      lastTradePrice: 18590.25,
      barsStartClose: 18590,
      trend: 'up',
      indicators: {
        supertrend_direction: 'up',
        ema_9: 18593,
        ema_21: 18596,
        ema_50: 18600,
        vwap: 18600,
        atr_14: 5,
        atr_14_pts: 5,
        adx_14: 16,
        sigma_pts: 5,
        z_ema9: -0.6,
        z_ofi_blend: -0.2,
      },
      structure: {
        bos_direction: 'range',
      },
      microstructure: {
        spread_pts: 0.25,
        ofi_z: -0.24,
        depth_imbalance: -0.1,
        queue_imbalance: -0.08,
      },
      regimeLabel: 'high',
      context: {
        prior_day_close: 18600,
        today_open: 18560,
        opening_range_minutes_elapsed: 15,
        session_vwap: 18600,
        overnight_return_bps: -21.5054,
        signed_shock_vwap: {
          value: -2,
          anchor_type: 'vwap',
          anchor_value: 18600,
          sigma_basis: 'atr_14',
          sigma_basis_value: 5,
        },
      },
    }),
  },
  vwap_overnight_reversal_short: {
    fixture_id: 'fixture_vwap_overnight_reversal_short',
    strategy_id: 'vwap_overnight_reversal_short',
    description: 'Positive overnight gap remains above VWAP after warmup in a non-trending high-regime fade.',
    expected_direction: 'short',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['target_1_vwap_touch', 'signed_shock_vwap', 'armed'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_vwap_overnight_reversal_short',
      sourceEventId: 'source-bar-vwap-overnight-reversal-short',
      createdOffsetNs: 15n * 60_000_000_000n,
      direction: 'short',
      bidPx: 18609.75,
      askPx: 18610,
      lastTradePrice: 18609.75,
      barsStartClose: 18610,
      trend: 'down',
      indicators: {
        supertrend_direction: 'down',
        ema_9: 18607,
        ema_21: 18604,
        ema_50: 18600,
        vwap: 18600,
        atr_14: 5,
        atr_14_pts: 5,
        adx_14: 16,
        sigma_pts: 5,
        z_ema9: 0.6,
        z_ofi_blend: 0.2,
      },
      structure: {
        bos_direction: 'range',
      },
      microstructure: {
        spread_pts: 0.25,
        ofi_z: 0.24,
        depth_imbalance: 0.1,
        queue_imbalance: 0.08,
      },
      regimeLabel: 'high',
      context: {
        prior_day_close: 18600,
        today_open: 18640,
        opening_range_minutes_elapsed: 15,
        session_vwap: 18600,
        overnight_return_bps: 21.5054,
        signed_shock_vwap: {
          value: 2,
          anchor_type: 'vwap',
          anchor_value: 18600,
          sigma_basis: 'atr_14',
          sigma_basis_value: 5,
        },
      },
    }),
  },
  regime_shock_reversion_short_v2: {
    fixture_id: 'fixture_regime_shock_reversion_short_v2',
    strategy_id: 'regime_shock_reversion_short_v2',
    description: 'High-regime upside shock above VWAP eligible for the short-only v2 reversion successor.',
    expected_direction: 'short',
    expected_gate_state: 'armed',
    expected_reason_fragments: ['regime_high', 'signed_shock_vwap', 'armed'],
    snapshot: makeSnapshot({
      fixtureId: 'fixture_regime_shock_reversion_short_v2',
      sourceEventId: 'source-bar-regime-shock-reversion-short-v2',
      createdOffsetNs: 16n * 60_000_000_000n,
      direction: 'short',
      bidPx: 18614.875,
      askPx: 18615.125,
      lastTradePrice: 18615,
      barsStartClose: 18600,
      trend: 'down',
      indicators: {
        supertrend_direction: 'down',
        ema_9: 18608,
        ema_21: 18604,
        ema_50: 18600,
        vwap: 18600,
        atr_14: 6,
        atr_14_pts: 6,
        adx_14: 18,
        sigma_pts: 6,
        z_ema9: 1.15,
        z_ofi_blend: 0.42,
      },
      structure: {
        bos_direction: 'range',
      },
      microstructure: {
        spread_pts: 0.25,
        ofi_z: 0.44,
        depth_imbalance: 0.2,
        queue_imbalance: 0.18,
      },
      regimeLabel: 'high',
      context: {
        session_vwap: 18600,
        signed_shock_vwap: {
          value: 2.5,
          anchor_type: 'vwap',
          anchor_value: 18600,
          sigma_basis: 'atr_14',
          sigma_basis_value: 6,
        },
      },
    }),
  },
} as const satisfies Record<StrategyId, SyntheticStrategyFixture>;

export function listSyntheticStrategyFixtures(): readonly SyntheticStrategyFixture[] {
  return [
    STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long,
    STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_short,
    STRATEGY_SYNTHETIC_FIXTURES.regime_shock_reversion_short_v2,
  ];
}
