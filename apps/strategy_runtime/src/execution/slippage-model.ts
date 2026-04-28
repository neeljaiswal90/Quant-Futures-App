import type { ContractSpec } from '../risk/contracts.js';

export interface DeterministicRandomSource {
  next(): number;
}

export class FixedSeedRandomSource implements DeterministicRandomSource {
  private state: number;

  constructor(seed = 0x5eed_2026) {
    this.state = seed >>> 0;
    if (this.state === 0) {
      this.state = 0x5eed_2026;
    }
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

export interface MarketableSlippageSampleInput {
  readonly base_slippage_points: number;
  readonly extra_tick_probability: number;
  readonly contract: ContractSpec;
  readonly rng: DeterministicRandomSource;
}

export interface MarketableSlippageSample {
  readonly slippage_points: number;
  readonly adverse_tick_draw: number;
  readonly adverse_ticks: number;
  readonly calibration_status: 'placeholder_pending_sim03';
}

export function sampleMarketableAdverseSlippage(
  input: MarketableSlippageSampleInput,
): MarketableSlippageSample {
  const extraTickProbability = clamp(input.extra_tick_probability, 0, 1);
  const draw = extraTickProbability > 0 ? input.rng.next() : 0;
  const extraTicks = draw < extraTickProbability ? 1 : 0;
  const baseTicks = Math.max(0, Math.round(input.base_slippage_points / input.contract.tick_size));
  const adverseTicks = baseTicks + extraTicks;
  return {
    slippage_points: adverseTicks * input.contract.tick_size,
    adverse_tick_draw: round6(draw),
    adverse_ticks: adverseTicks,
    calibration_status: 'placeholder_pending_sim03',
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
