import type {
  AlertState,
  ConsoleSnapshot,
  DataPipelineState,
  FeatureSurfaceState,
  LatencyState,
  MboShadowState,
  PnlState,
  PositionState,
  RiskState,
  StrategyGateState,
  SystemHealthState,
  TradeBlotterRow,
} from './snapshot.js';

export type ConsoleDelta =
  | { readonly kind: 'data_pipeline'; readonly patch: Partial<DataPipelineState> }
  | { readonly kind: 'strategy'; readonly id: string; readonly patch: Partial<StrategyGateState> }
  | { readonly kind: 'trade'; readonly row: TradeBlotterRow }
  | { readonly kind: 'position'; readonly id: string; readonly patch: Partial<PositionState> }
  | { readonly kind: 'pnl'; readonly patch: Partial<PnlState> }
  | { readonly kind: 'risk'; readonly patch: Partial<RiskState> }
  | { readonly kind: 'latency'; readonly patch: Partial<LatencyState> }
  | { readonly kind: 'alert'; readonly alert: AlertState }
  | { readonly kind: 'system_health'; readonly patch: Partial<SystemHealthState> }
  | { readonly kind: 'feature_surface'; readonly patch: Partial<FeatureSurfaceState> }
  | { readonly kind: 'mbo_shadow'; readonly patch: Partial<MboShadowState> };

export type ConsoleStreamFrame =
  | { readonly kind: 'snapshot'; readonly seq: string; readonly snapshot: ConsoleSnapshot }
  | {
      readonly kind: 'delta';
      readonly seq: string;
      readonly base_seq: string;
      readonly last_event_id: string | null;
      readonly delta: ConsoleDelta;
    }
  | {
      readonly kind: 'resync_required';
      readonly seq: string;
      readonly reason: 'gap' | 'backpressure' | 'schema_mismatch';
    };

export function nextSequence(current: string): string {
  assertDecimalSequence(current);
  return (BigInt(current) + 1n).toString(10);
}

export function assertDecimalSequence(value: string): void {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`sequence must be a non-negative decimal integer string: ${value}`);
  }
}
