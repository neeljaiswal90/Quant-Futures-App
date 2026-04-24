import type {
  EntryOrderIntent,
  ExecutionAdapter,
  ExitOrderIntent,
  OrderResult,
  RuntimeExecutionMode,
} from '../contracts/execution.js';
import type { ContractSpec } from '../risk/contracts.js';
import { roundToTick } from '../risk/contracts.js';

export class SimulatedExecutionAdapter implements ExecutionAdapter {
  readonly mode: RuntimeExecutionMode = 'paper';
  private orderSeq = 0;

  constructor(
    private readonly contract: ContractSpec,
    private readonly opts: { slippage_ticks?: number; commission_per_contract?: number } = {},
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async placeEntry(intent: EntryOrderIntent): Promise<OrderResult> {
    const slippagePts = (this.opts.slippage_ticks ?? 1) * this.contract.tick_size;
    const rawFill = intent.candidate.direction === 'long'
      ? intent.reference_price + slippagePts
      : intent.reference_price - slippagePts;
    return {
      order_id: `SIM-ENTRY-${Date.now()}-${++this.orderSeq}`,
      fill_price: roundToTick(rawFill, this.contract),
      fill_time_iso: new Date().toISOString(),
      quantity: intent.quantity,
      side: intent.candidate.direction,
      slippage_pts: slippagePts,
      fee_usd: round2((this.opts.commission_per_contract ?? defaultCommission(this.contract)) * Math.abs(intent.quantity)),
      status: 'simulated',
    };
  }

  async placeExit(intent: ExitOrderIntent): Promise<OrderResult> {
    const slippagePts = (this.opts.slippage_ticks ?? 1) * this.contract.tick_size;
    const rawFill = intent.side === 'long'
      ? intent.reference_price - slippagePts
      : intent.reference_price + slippagePts;
    return {
      order_id: `SIM-EXIT-${Date.now()}-${++this.orderSeq}`,
      fill_price: roundToTick(rawFill, this.contract),
      fill_time_iso: new Date().toISOString(),
      quantity: intent.quantity,
      side: intent.side,
      slippage_pts: slippagePts,
      fee_usd: round2((this.opts.commission_per_contract ?? defaultCommission(this.contract)) * Math.abs(intent.quantity)),
      status: 'simulated',
    };
  }
}

export class SignalOnlyExecutionAdapter implements ExecutionAdapter {
  readonly mode: RuntimeExecutionMode = 'signal_only';

  constructor(private readonly contract: ContractSpec) {}

  isAvailable(): boolean {
    return true;
  }

  async placeEntry(intent: EntryOrderIntent): Promise<OrderResult> {
    return {
      order_id: `SIGNAL-ENTRY-${Date.now()}`,
      fill_price: roundToTick(intent.reference_price, this.contract),
      fill_time_iso: new Date().toISOString(),
      quantity: intent.quantity,
      side: intent.candidate.direction,
      slippage_pts: 0,
      fee_usd: 0,
      status: 'simulated',
    };
  }

  async placeExit(intent: ExitOrderIntent): Promise<OrderResult> {
    return {
      order_id: `SIGNAL-EXIT-${Date.now()}`,
      fill_price: roundToTick(intent.reference_price, this.contract),
      fill_time_iso: new Date().toISOString(),
      quantity: intent.quantity,
      side: intent.side,
      slippage_pts: 0,
      fee_usd: 0,
      status: 'simulated',
    };
  }
}

export function createExecutionAdapter(
  mode: RuntimeExecutionMode,
  contract: ContractSpec,
): ExecutionAdapter {
  if (mode === 'live') {
    throw new Error('Live execution is intentionally disabled in the V1 runtime.');
  }
  if (mode === 'signal_only') {
    return new SignalOnlyExecutionAdapter(contract);
  }
  return new SimulatedExecutionAdapter(contract);
}

function defaultCommission(contract: ContractSpec): number {
  return contract.is_micro ? 0.5 : 2.25;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
