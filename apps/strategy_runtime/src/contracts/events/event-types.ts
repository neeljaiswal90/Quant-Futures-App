export const RUNTIME_EVENT_TYPES = [
  'CONN',
  'FEED',
  'GAP',
  'BOOK_REBUILD',
  'SESSION_PHASE',
  'ROLL_ADVISORY',
  'HALT',
  'WOULD_HALT',
  'ORDER_QUARANTINE_ENTERED',
  'ORDER_QUARANTINE_CLEARED',
  'VALIDATOR_ISSUE',
  'QUOTE',
  'TRADE',
  'BAR_CLOSE',
  'FEATURES',
  'STRUCTURE',
  'MICROSTRUCTURE',
  'STRAT_EVAL',
  'CANDIDATE',
  'ML_UPLIFT',
  'RANK',
  'RISK_GATE',
  'SIZING',
  'ORDER_ACK_CANCEL',
  'ORDER_ACK_FILL',
  'ORDER_ACK_SUBMISSION',
  'ORDER_BROKER_REJECT',
  'ORDER_INTENT',
  'SIM_FILL',
  'EXEC_REJECT',
  'POSITION',
  'MGMT_TICK',
  'MGMT_ACTION',
  'CONFIG',
  'BACKTEST_RUN_META',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export type JournalEventTimestampCategory =
  | 'source_market_data'
  | 'broker_originated'
  | 'derived'
  | 'system_control';

export const SOURCE_MARKET_DATA_EVENT_TYPES = [
  'QUOTE',
  'TRADE',
  'BAR_CLOSE',
  'MICROSTRUCTURE',
  'BOOK_REBUILD',
] as const satisfies readonly RuntimeEventType[];

export const SYSTEM_CONTROL_EVENT_TYPES = [
  'CONN',
  'FEED',
  'GAP',
  'SESSION_PHASE',
  'ROLL_ADVISORY',
  'HALT',
  'WOULD_HALT',
  'ORDER_QUARANTINE_ENTERED',
  'ORDER_QUARANTINE_CLEARED',
  'VALIDATOR_ISSUE',
  'CONFIG',
  'BACKTEST_RUN_META',
] as const satisfies readonly RuntimeEventType[];

export const BROKER_ORIGINATED_EVENT_TYPES = [
  'ORDER_ACK_SUBMISSION',
  'ORDER_ACK_FILL',
  'ORDER_ACK_CANCEL',
  'ORDER_BROKER_REJECT',
] as const satisfies readonly RuntimeEventType[];

export type BrokerOriginatedEventType = (typeof BROKER_ORIGINATED_EVENT_TYPES)[number];

export const DERIVED_EVENT_TYPES = [
  'FEATURES',
  'STRUCTURE',
  'STRAT_EVAL',
  'CANDIDATE',
  'ML_UPLIFT',
  'RANK',
  'RISK_GATE',
  'SIZING',
  'ORDER_INTENT',
  'SIM_FILL',
  'EXEC_REJECT',
  'POSITION',
  'MGMT_TICK',
  'MGMT_ACTION',
] as const satisfies readonly RuntimeEventType[];

const RUNTIME_EVENT_TYPE_SET = new Set<string>(RUNTIME_EVENT_TYPES);
const SOURCE_MARKET_DATA_EVENT_TYPE_SET = new Set<RuntimeEventType>(SOURCE_MARKET_DATA_EVENT_TYPES);
const SYSTEM_CONTROL_EVENT_TYPE_SET = new Set<RuntimeEventType>(SYSTEM_CONTROL_EVENT_TYPES);
const BROKER_ORIGINATED_EVENT_TYPE_SET = new Set<RuntimeEventType>(BROKER_ORIGINATED_EVENT_TYPES);
const DERIVED_EVENT_TYPE_SET = new Set<RuntimeEventType>(DERIVED_EVENT_TYPES);

export function isRuntimeEventType(value: string): value is RuntimeEventType {
  return RUNTIME_EVENT_TYPE_SET.has(value);
}

export function parseRuntimeEventType(value: string): RuntimeEventType {
  if (!isRuntimeEventType(value)) {
    throw new Error(`Unknown runtime event type: ${value}`);
  }
  return value;
}

export function isBrokerOriginatedEventType(value: RuntimeEventType): value is BrokerOriginatedEventType {
  return BROKER_ORIGINATED_EVENT_TYPE_SET.has(value);
}

export function categorizeRuntimeEventType(type: RuntimeEventType): JournalEventTimestampCategory {
  if (SOURCE_MARKET_DATA_EVENT_TYPE_SET.has(type)) {
    return 'source_market_data';
  }
  if (BROKER_ORIGINATED_EVENT_TYPE_SET.has(type)) {
    return 'broker_originated';
  }
  if (SYSTEM_CONTROL_EVENT_TYPE_SET.has(type)) {
    return 'system_control';
  }
  if (DERIVED_EVENT_TYPE_SET.has(type)) {
    return 'derived';
  }
  throw new Error(`runtime event type has no timestamp category: ${type}`);
}
