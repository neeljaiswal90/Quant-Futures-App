import type { CandidateSetup } from './candidate.js';

export type RuntimeExecutionMode = 'paper' | 'signal_only' | 'live';

export interface EntryOrderIntent {
  candidate: CandidateSetup;
  quantity: number;
  reference_price: number;
}

export interface ExitOrderIntent {
  side: 'long' | 'short';
  quantity: number;
  reference_price: number;
  reason: string;
}

export interface OrderResult {
  order_id: string;
  fill_price: number;
  fill_time_iso: string;
  quantity: number;
  side: 'long' | 'short';
  slippage_pts: number;
  fee_usd: number;
  status: 'simulated' | 'rejected';
}

export interface ExecutionAdapter {
  mode: RuntimeExecutionMode;
  isAvailable(): boolean;
  placeEntry(intent: EntryOrderIntent): Promise<OrderResult>;
  placeExit(intent: ExitOrderIntent): Promise<OrderResult>;
}
