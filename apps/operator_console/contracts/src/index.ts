export { CONSOLE_SNAPSHOT_SCHEMA_VERSION } from './snapshot.js';
export { nextSequence, assertDecimalSequence } from './delta.js';

export type {
  Availability,
  AvailableValue,
  UnixNsString,
  DecimalString,
  FeatureAvailabilityTier,
  MaybeAvailable,
  FeatureAvailabilityMask,
  AlertState,
  ConsoleSnapshot,
  DataPipelineState,
  TradeBlotterState,
  TradeBlotterRow,
  StrategyGateState,
  PositionState,
  PnlState,
  RiskState,
  LatencyState,
  SystemHealthState,
  FeatureSurfaceState,
  MboShadowState,
} from './snapshot.js';

export { isFeatureAvailabilityMask } from './snapshot.js';

export type {
  ConsoleDelta,
  ConsoleStreamFrame,
} from './delta.js';

export type {
  OperatorConsoleAlertInput,
  OperatorConsoleAlertKind,
  OperatorConsoleAlertSeverity,
} from './alerts.js';
