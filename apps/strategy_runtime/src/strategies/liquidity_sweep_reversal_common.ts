import type { LiquiditySweepReversalStrategyParameters } from '../config/index.js';
import type { PriceTarget } from '../contracts/index.js';
import type {
  StrategyFeatureSnapshot,
  StrategyFeatureSnapshotRegime,
  StrategyScalarMap,
} from './types.js';

export type SweepDirection = 'down' | 'up';

export interface SweepState {
  readonly sweep_direction: SweepDirection | null;
  readonly sweep_intensity_sigma: number;
  readonly post_sweep_depth_ratio: number | null;
  readonly bars_since_sweep: number;
}

export function validateLiquiditySweepParameters(
  parameters: LiquiditySweepReversalStrategyParameters,
): void {
  if (parameters.pre_committed_retirement !== true) {
    throw new Error('liquidity_sweep_reversal requires pre_committed_retirement=true');
  }
  if (parameters.use_regime_co_filter && parameters.allowed_regimes.length === 0) {
    throw new Error('liquidity_sweep_reversal regime co-filter requires allowed_regimes');
  }
}

export function detectSweep(
  snapshot: StrategyFeatureSnapshot,
  parameters: LiquiditySweepReversalStrategyParameters,
): SweepState | null {
  const sigmaPts = getOptionalNumber(snapshot.indicators, 'sigma_pts');
  if (!(sigmaPts !== undefined && sigmaPts > 0)) {
    return null;
  }

  const bars = snapshot.bars;
  const current = bars.at(-1);
  const previous = bars.at(-2);
  if (current === undefined || previous === undefined) {
    return null;
  }

  const priceMoveSigma = (current.close - previous.close) / sigmaPts;
  const flowSigma = getOptionalNumber(snapshot.indicators, 'z_ofi_blend')
    ?? getOptionalNumber(snapshot.microstructure.values, 'ofi_z')
    ?? priceMoveSigma;

  const downPressure =
    priceMoveSigma <= -parameters.sweep_overshoot_sigma
    || flowSigma <= -parameters.sweep_aggressor_threshold;
  const upPressure =
    priceMoveSigma >= parameters.sweep_overshoot_sigma
    || flowSigma >= parameters.sweep_aggressor_threshold;

  if (!downPressure && !upPressure) {
    return null;
  }

  const direction: SweepDirection =
    downPressure && upPressure
      ? Math.abs(Math.min(priceMoveSigma, flowSigma)) >= Math.abs(Math.max(priceMoveSigma, flowSigma))
        ? 'down'
        : 'up'
      : downPressure ? 'down' : 'up';
  const intensity = Math.max(Math.abs(priceMoveSigma), Math.abs(flowSigma));

  return {
    sweep_direction: direction,
    sweep_intensity_sigma: round4(intensity),
    post_sweep_depth_ratio: computePostSweepDepthRatio(snapshot, direction),
    bars_since_sweep: Math.max(0, Math.trunc(
      getOptionalNumber(snapshot.microstructure.values, 'bars_since_sweep') ?? 0,
    )),
  };
}

export function regimeAllowed(
  regime: StrategyFeatureSnapshotRegime,
  parameters: LiquiditySweepReversalStrategyParameters,
): boolean {
  return !parameters.use_regime_co_filter || parameters.allowed_regimes.includes(regime);
}

export function getRequiredSigmaPts(snapshot: StrategyFeatureSnapshot): number {
  const sigmaPts = getOptionalNumber(snapshot.indicators, 'sigma_pts');
  if (!(sigmaPts !== undefined && sigmaPts > 0)) {
    throw new Error('liquidity_sweep_reversal requires positive sigma_pts');
  }
  return sigmaPts;
}

export function buildReversalTargets(input: {
  readonly entryPrice: number;
  readonly riskPts: number;
  readonly direction: 'long' | 'short';
  readonly parameters: LiquiditySweepReversalStrategyParameters;
  readonly tickSize: number;
}): readonly PriceTarget[] {
  const sign = input.direction === 'long' ? 1 : -1;
  return [
    {
      label: 'pt1',
      price: roundToTick(
        input.entryPrice + sign * input.riskPts * input.parameters.target_1_rr,
        input.tickSize,
      ),
      quantity_fraction: 0.5,
    },
    {
      label: 'pt2',
      price: roundToTick(
        input.entryPrice + sign * input.riskPts * input.parameters.target_2_rr,
        input.tickSize,
      ),
      quantity_fraction: 0.5,
    },
  ];
}

export function rewardRisk(
  targetPrice: number,
  entryPrice: number,
  riskPts: number,
  direction: 'long' | 'short',
): number {
  if (!(riskPts > 0)) {
    return 0;
  }
  const reward = direction === 'long'
    ? targetPrice - entryPrice
    : entryPrice - targetPrice;
  return round4(reward / riskPts);
}

export function roundToTick(value: number, tickSize: number): number {
  return round4(Math.round(value / tickSize) * tickSize);
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function computePostSweepDepthRatio(
  snapshot: StrategyFeatureSnapshot,
  direction: SweepDirection,
): number | null {
  const depthImbalance = getOptionalNumber(snapshot.microstructure.values, 'depth_imbalance')
    ?? getOptionalNumber(snapshot.microstructure.values, 'queue_imbalance');
  if (depthImbalance !== undefined) {
    return round4(clamp(
      direction === 'down' ? 1 + depthImbalance : 1 - depthImbalance,
      0,
      1,
    ));
  }

  const spreadPts = getOptionalNumber(snapshot.microstructure.values, 'spread_pts');
  if (spreadPts !== undefined && spreadPts > 0) {
    return round4(clamp(snapshot.instrument.tick_size / spreadPts, 0.1, 1));
  }

  return null;
}

function getOptionalNumber(values: StrategyScalarMap, key: string): number | undefined {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
