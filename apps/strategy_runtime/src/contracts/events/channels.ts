import { RUNTIME_EVENT_TYPES, type RuntimeEventType } from './event-types.js';

export const EVENT_CHANNELS = [
  'CONNECTION',
  'SESSION',
  'MARKET',
  'QUOTE_RAW',
  'INDICATORS',
  'STRUCTURE',
  'MICROSTRUCTURE',
  'STRATEGY_GATES',
  'CANDIDATES',
  'ORDERS',
  'POSITION',
  'CONFIG',
] as const;

export const OPERATOR_SURFACE_SUBSCRIBERS = [
  'TUI',
  'FORMATTER',
  'JOURNAL_QUERY',
  'ALERTS',
  'REPLAY',
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];
export type OperatorSurfaceSubscriber = (typeof OPERATOR_SURFACE_SUBSCRIBERS)[number];
export type EmissionCadence =
  | 'event_driven'
  | '1hz_heartbeat'
  | '2hz_throttled'
  | '5hz_throttled'
  | 'per_bar_close'
  | 'per_evaluation_cycle'
  | 'per_bar_tick'
  | 'raw_event_stream';

export type ThrottlePolicy =
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'fixed_rate';
      readonly max_hz: 1 | 2 | 5;
      readonly window_ms: 1_000 | 500 | 200;
      readonly source_clock: 'event_ts_ns';
      readonly selection: 'latest_event_per_window';
    }
  | {
      readonly kind: 'explicit_opt_in_raw';
      readonly default_enabled: false;
      readonly source_clock: 'event_ts_ns';
      readonly warning: 'not_for_tui_default';
    };

export interface EventChannelContract {
  readonly channel: EventChannel;
  readonly event_types: readonly RuntimeEventType[];
  readonly emission_cadence: EmissionCadence;
  readonly throttle: ThrottlePolicy;
  readonly default_subscribers: readonly OperatorSurfaceSubscriber[];
  readonly tui_default: boolean;
  readonly facts_are_authoritative: true;
  readonly recomputation_allowed: false;
  readonly description: string;
}

export interface OperatorSurfaceSubscriptionContract {
  readonly subscriber: OperatorSurfaceSubscriber;
  readonly channels: readonly EventChannel[];
  readonly raw_channels_allowed: readonly EventChannel[];
  readonly description: string;
}

export interface EventChannelContractIssue {
  readonly path: string;
  readonly message: string;
}

const TUI_DEFAULT_SUBSCRIBERS = ['TUI', 'FORMATTER', 'JOURNAL_QUERY', 'REPLAY'] as const;
const EVENT_DRIVEN_SUBSCRIBERS = [
  'TUI',
  'FORMATTER',
  'JOURNAL_QUERY',
  'ALERTS',
  'REPLAY',
] as const;

export const EVENT_CHANNEL_CONTRACTS: readonly EventChannelContract[] = [
  {
    channel: 'CONNECTION',
    event_types: ['CONN', 'FEED', 'GAP', 'BOOK_REBUILD'],
    emission_cadence: '1hz_heartbeat',
    throttle: {
      kind: 'fixed_rate',
      max_hz: 1,
      window_ms: 1_000,
      source_clock: 'event_ts_ns',
      selection: 'latest_event_per_window',
    },
    default_subscribers: EVENT_DRIVEN_SUBSCRIBERS,
    tui_default: true,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Connection health, feed authority, gap, and book-rebuild facts.',
  },
  {
    channel: 'SESSION',
    event_types: ['SESSION_PHASE', 'ROLL_ADVISORY', 'HALT'],
    emission_cadence: 'event_driven',
    throttle: { kind: 'none' },
    default_subscribers: EVENT_DRIVEN_SUBSCRIBERS,
    tui_default: true,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Session, halt, maintenance, and roll state changes.',
  },
  {
    channel: 'MARKET',
    event_types: ['QUOTE', 'TRADE', 'BAR_CLOSE'],
    emission_cadence: '5hz_throttled',
    throttle: {
      kind: 'fixed_rate',
      max_hz: 5,
      window_ms: 200,
      source_clock: 'event_ts_ns',
      selection: 'latest_event_per_window',
    },
    default_subscribers: TUI_DEFAULT_SUBSCRIBERS,
    tui_default: true,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Throttled L1 quotes, prints, and bar-close facts for operator surfaces.',
  },
  {
    channel: 'QUOTE_RAW',
    event_types: ['QUOTE'],
    emission_cadence: 'raw_event_stream',
    throttle: {
      kind: 'explicit_opt_in_raw',
      default_enabled: false,
      source_clock: 'event_ts_ns',
      warning: 'not_for_tui_default',
    },
    default_subscribers: ['JOURNAL_QUERY', 'REPLAY'],
    tui_default: false,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Explicit raw quote stream for diagnostics and replay; not a default TUI input.',
  },
  {
    channel: 'INDICATORS',
    event_types: ['FEATURES'],
    emission_cadence: 'per_bar_close',
    throttle: { kind: 'none' },
    default_subscribers: TUI_DEFAULT_SUBSCRIBERS,
    tui_default: true,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Runtime-computed feature snapshots; consumers must not recompute indicators.',
  },
  {
    channel: 'STRUCTURE',
    event_types: ['STRUCTURE'],
    emission_cadence: 'per_bar_close',
    throttle: { kind: 'none' },
    default_subscribers: TUI_DEFAULT_SUBSCRIBERS,
    tui_default: true,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Runtime-computed market-structure facts such as swings and breaks.',
  },
  {
    channel: 'MICROSTRUCTURE',
    event_types: ['MICROSTRUCTURE'],
    emission_cadence: '2hz_throttled',
    throttle: {
      kind: 'fixed_rate',
      max_hz: 2,
      window_ms: 500,
      source_clock: 'event_ts_ns',
      selection: 'latest_event_per_window',
    },
    default_subscribers: TUI_DEFAULT_SUBSCRIBERS,
    tui_default: true,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Sidecar-derived microstructure snapshots, throttled for operator display.',
  },
  {
    channel: 'STRATEGY_GATES',
    event_types: ['STRAT_EVAL'],
    emission_cadence: 'per_evaluation_cycle',
    throttle: { kind: 'none' },
    default_subscribers: EVENT_DRIVEN_SUBSCRIBERS,
    tui_default: true,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Strategy gate state and reasons from runtime strategy evaluation.',
  },
  {
    channel: 'CANDIDATES',
    event_types: ['CANDIDATE', 'ML_UPLIFT', 'RANK', 'RISK_GATE', 'SIZING'],
    emission_cadence: 'event_driven',
    throttle: { kind: 'none' },
    default_subscribers: EVENT_DRIVEN_SUBSCRIBERS,
    tui_default: true,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Candidate, ranking, ML uplift, risk gate, and sizing facts.',
  },
  {
    channel: 'ORDERS',
    event_types: ['ORDER_INTENT', 'SIM_FILL', 'EXEC_REJECT'],
    emission_cadence: 'event_driven',
    throttle: { kind: 'none' },
    default_subscribers: EVENT_DRIVEN_SUBSCRIBERS,
    tui_default: true,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Simulation-only order intents, fills, and execution rejections.',
  },
  {
    channel: 'POSITION',
    event_types: ['POSITION', 'MGMT_TICK', 'MGMT_ACTION'],
    emission_cadence: 'per_bar_tick',
    throttle: { kind: 'none' },
    default_subscribers: EVENT_DRIVEN_SUBSCRIBERS,
    tui_default: true,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Position state and deterministic management action facts.',
  },
  {
    channel: 'CONFIG',
    event_types: ['CONFIG', 'BACKTEST_RUN_META'],
    emission_cadence: 'event_driven',
    throttle: { kind: 'none' },
    default_subscribers: ['FORMATTER', 'JOURNAL_QUERY', 'REPLAY'],
    tui_default: false,
    facts_are_authoritative: true,
    recomputation_allowed: false,
    description: 'Runtime config lineage facts and backtest run-identity meta events for replay and provenance.',
  },
] as const;

export const OPERATOR_SURFACE_SUBSCRIPTION_CONTRACTS: readonly OperatorSurfaceSubscriptionContract[] = [
  {
    subscriber: 'TUI',
    channels: [
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
    ],
    raw_channels_allowed: [],
    description: 'Read-only TUI default subscription; excludes raw quote firehose.',
  },
  {
    subscriber: 'FORMATTER',
    channels: [
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
    ],
    raw_channels_allowed: ['QUOTE_RAW'],
    description: 'Deterministic log formatter subscription over validated event facts.',
  },
  {
    subscriber: 'JOURNAL_QUERY',
    channels: [
      'CONNECTION',
      'SESSION',
      'MARKET',
      'QUOTE_RAW',
      'INDICATORS',
      'STRUCTURE',
      'MICROSTRUCTURE',
      'STRATEGY_GATES',
      'CANDIDATES',
      'ORDERS',
      'POSITION',
      'CONFIG',
    ],
    raw_channels_allowed: ['QUOTE_RAW'],
    description: 'Provenance and diagnostic query subscription, including explicit raw quotes.',
  },
  {
    subscriber: 'ALERTS',
    channels: ['CONNECTION', 'SESSION', 'CANDIDATES', 'ORDERS', 'POSITION'],
    raw_channels_allowed: [],
    description: 'Future alerting subscription; receives only journaled decisions and state facts.',
  },
  {
    subscriber: 'REPLAY',
    channels: [
      'CONNECTION',
      'SESSION',
      'MARKET',
      'QUOTE_RAW',
      'INDICATORS',
      'STRUCTURE',
      'MICROSTRUCTURE',
      'STRATEGY_GATES',
      'CANDIDATES',
      'ORDERS',
      'POSITION',
      'CONFIG',
    ],
    raw_channels_allowed: ['QUOTE_RAW'],
    description: 'Replay substrate subscription over all authoritative event facts.',
  },
] as const;

export function channelsForEventType(
  type: RuntimeEventType,
  options: { readonly include_raw?: boolean } = {},
): readonly EventChannel[] {
  return EVENT_CHANNEL_CONTRACTS.filter((contract) => {
    if (!contract.event_types.includes(type)) {
      return false;
    }
    if (!options.include_raw && contract.throttle.kind === 'explicit_opt_in_raw') {
      return false;
    }
    return true;
  }).map((contract) => contract.channel);
}

export function eventTypesForChannel(channel: EventChannel): readonly RuntimeEventType[] {
  return EVENT_CHANNEL_CONTRACTS.find((contract) => contract.channel === channel)?.event_types ?? [];
}

export function channelContractFor(
  channel: EventChannel,
): EventChannelContract {
  const contract = EVENT_CHANNEL_CONTRACTS.find((candidate) => candidate.channel === channel);
  if (contract === undefined) {
    throw new Error(`Unknown event channel: ${channel}`);
  }
  return contract;
}

export function channelsForSubscriber(
  subscriber: OperatorSurfaceSubscriber,
): readonly EventChannel[] {
  const contract = OPERATOR_SURFACE_SUBSCRIPTION_CONTRACTS.find(
    (candidate) => candidate.subscriber === subscriber,
  );
  if (contract === undefined) {
    throw new Error(`Unknown operator surface subscriber: ${subscriber}`);
  }
  return contract.channels;
}

export function defaultTuiChannels(): readonly EventChannel[] {
  return channelsForSubscriber('TUI');
}

export function validateEventChannelContracts(): readonly EventChannelContractIssue[] {
  const issues: EventChannelContractIssue[] = [];
  const seenChannels = new Set<EventChannel>();

  for (const channel of EVENT_CHANNELS) {
    const contracts = EVENT_CHANNEL_CONTRACTS.filter((contract) => contract.channel === channel);
    if (contracts.length !== 1) {
      issues.push({
        path: `EVENT_CHANNEL_CONTRACTS.${channel}`,
        message: `expected exactly one contract, found ${contracts.length}`,
      });
    }
  }

  for (const contract of EVENT_CHANNEL_CONTRACTS) {
    if (seenChannels.has(contract.channel)) {
      issues.push({
        path: `EVENT_CHANNEL_CONTRACTS.${contract.channel}`,
        message: 'duplicate channel contract',
      });
    }
    seenChannels.add(contract.channel);

    if (contract.recomputation_allowed !== false || contract.facts_are_authoritative !== true) {
      issues.push({
        path: `EVENT_CHANNEL_CONTRACTS.${contract.channel}`,
        message: 'operator channel must render authoritative facts without recomputation',
      });
    }

    if (contract.throttle.kind === 'fixed_rate' && contract.throttle.source_clock !== 'event_ts_ns') {
      issues.push({
        path: `EVENT_CHANNEL_CONTRACTS.${contract.channel}.throttle`,
        message: 'throttling must use event_ts_ns, not wall clock',
      });
    }

    if (contract.throttle.kind === 'explicit_opt_in_raw' && contract.tui_default) {
      issues.push({
        path: `EVENT_CHANNEL_CONTRACTS.${contract.channel}.tui_default`,
        message: 'raw opt-in channels must not be enabled for TUI by default',
      });
    }
  }

  for (const type of RUNTIME_EVENT_TYPES) {
    const channels = channelsForEventType(type, { include_raw: true });
    if (channels.length === 0) {
      issues.push({
        path: `RuntimeEventType.${type}`,
        message: 'event type has no operator channel',
      });
    }
  }

  const tuiChannels = channelsForSubscriber('TUI');
  for (const channel of tuiChannels) {
    const contract = channelContractFor(channel);
    if (!contract.tui_default) {
      issues.push({
        path: `OPERATOR_SURFACE_SUBSCRIPTION_CONTRACTS.TUI.${channel}`,
        message: 'TUI default subscription includes a non-default channel',
      });
    }
    if (contract.throttle.kind === 'explicit_opt_in_raw') {
      issues.push({
        path: `OPERATOR_SURFACE_SUBSCRIPTION_CONTRACTS.TUI.${channel}`,
        message: 'TUI default subscription must not include raw opt-in channels',
      });
    }
  }

  return issues.sort(compareIssues);
}

function compareIssues(
  left: EventChannelContractIssue,
  right: EventChannelContractIssue,
): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.message < right.message) return -1;
  if (left.message > right.message) return 1;
  return 0;
}
