export const RUNTIME_EVENT_TYPES = [
  'CONN',
  'FEED',
  'GAP',
  'BOOK_REBUILD',
  'SESSION_PHASE',
  'ROLL_ADVISORY',
  'HALT',
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
  'ORDER_INTENT',
  'SIM_FILL',
  'EXEC_REJECT',
  'POSITION',
  'MGMT_TICK',
  'MGMT_ACTION',
  'CONFIG',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export type JournalEventTimestampCategory = 'source_market_data' | 'derived' | 'system_control';

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
  'CONFIG',
] as const satisfies readonly RuntimeEventType[];

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

export function categorizeRuntimeEventType(type: RuntimeEventType): JournalEventTimestampCategory {
  if (SOURCE_MARKET_DATA_EVENT_TYPE_SET.has(type)) {
    return 'source_market_data';
  }
  if (SYSTEM_CONTROL_EVENT_TYPE_SET.has(type)) {
    return 'system_control';
  }
  if (DERIVED_EVENT_TYPE_SET.has(type)) {
    return 'derived';
  }
  throw new Error(`runtime event type has no timestamp category: ${type}`);
}
