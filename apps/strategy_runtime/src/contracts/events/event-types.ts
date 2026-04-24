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
  'RISK_GATE',
  'SIZING',
  'ORDER_INTENT',
  'SIM_FILL',
  'POSITION',
  'MGMT_TICK',
  'MGMT_ACTION',
  'CONFIG',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

const RUNTIME_EVENT_TYPE_SET = new Set<string>(RUNTIME_EVENT_TYPES);

export function isRuntimeEventType(value: string): value is RuntimeEventType {
  return RUNTIME_EVENT_TYPE_SET.has(value);
}

export function parseRuntimeEventType(value: string): RuntimeEventType {
  if (!isRuntimeEventType(value)) {
    throw new Error(`Unknown runtime event type: ${value}`);
  }
  return value;
}
