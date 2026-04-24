import type { RuntimeEventType } from './event-types.js';

export const EVENT_CHANNELS = [
  'CONNECTION',
  'SESSION',
  'MARKET',
  'INDICATORS',
  'STRUCTURE',
  'MICROSTRUCTURE',
  'STRATEGY_GATES',
  'CANDIDATES',
  'ORDERS',
  'POSITION',
  'CONFIG',
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];
export type EmissionCadence = 'event_driven' | '1hz_heartbeat' | '2hz_throttled' | '5hz_throttled';

export interface EventChannelContract {
  readonly channel: EventChannel;
  readonly event_types: readonly RuntimeEventType[];
  readonly emission_cadence: EmissionCadence;
  readonly description: string;
}

export const EVENT_CHANNEL_CONTRACTS: readonly EventChannelContract[] = [
  {
    channel: 'CONNECTION',
    event_types: ['CONN', 'FEED', 'GAP', 'BOOK_REBUILD'],
    emission_cadence: '1hz_heartbeat',
    description: 'Connection health and feed authority events.',
  },
  {
    channel: 'SESSION',
    event_types: ['SESSION_PHASE', 'ROLL_ADVISORY', 'HALT'],
    emission_cadence: 'event_driven',
    description: 'Session, halt, and roll state changes.',
  },
  {
    channel: 'MARKET',
    event_types: ['QUOTE', 'TRADE', 'BAR_CLOSE'],
    emission_cadence: '5hz_throttled',
    description: 'L1 quotes, prints, and bar-close facts.',
  },
  {
    channel: 'INDICATORS',
    event_types: ['FEATURES'],
    emission_cadence: 'event_driven',
    description: 'Feature snapshots emitted by the runtime feature layer.',
  },
  {
    channel: 'STRUCTURE',
    event_types: ['STRUCTURE'],
    emission_cadence: 'event_driven',
    description: 'Market-structure facts such as swings and breaks.',
  },
  {
    channel: 'MICROSTRUCTURE',
    event_types: ['MICROSTRUCTURE'],
    emission_cadence: '2hz_throttled',
    description: 'Sidecar-derived microstructure features.',
  },
  {
    channel: 'STRATEGY_GATES',
    event_types: ['STRAT_EVAL'],
    emission_cadence: 'event_driven',
    description: 'Strategy gate state and first-failing-gate reasons.',
  },
  {
    channel: 'CANDIDATES',
    event_types: ['CANDIDATE', 'RISK_GATE', 'SIZING'],
    emission_cadence: 'event_driven',
    description: 'Candidate provenance, risk decisions, and sizing.',
  },
  {
    channel: 'ORDERS',
    event_types: ['ORDER_INTENT', 'SIM_FILL'],
    emission_cadence: 'event_driven',
    description: 'Simulation-only order intents and fills.',
  },
  {
    channel: 'POSITION',
    event_types: ['POSITION', 'MGMT_TICK', 'MGMT_ACTION'],
    emission_cadence: 'event_driven',
    description: 'Position state and management actions.',
  },
  {
    channel: 'CONFIG',
    event_types: ['CONFIG'],
    emission_cadence: 'event_driven',
    description: 'Runtime config lineage facts.',
  },
] as const;

export function channelsForEventType(type: RuntimeEventType): readonly EventChannel[] {
  return EVENT_CHANNEL_CONTRACTS.filter((contract) => contract.event_types.includes(type)).map(
    (contract) => contract.channel,
  );
}
