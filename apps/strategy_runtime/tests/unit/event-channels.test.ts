import { describe, expect, it } from 'vitest';
import {
  EVENT_CHANNELS,
  RUNTIME_EVENT_TYPES,
  channelContractFor,
  channelsForEventType,
  channelsForSubscriber,
  defaultTuiChannels,
  eventTypesForChannel,
  validateEventChannelContracts,
  type EventChannel,
} from '../../src/contracts/index.js';

const REQUIRED_TUI_CHANNELS: readonly EventChannel[] = [
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
];

describe('TUI-01 operator event-bus contract', () => {
  it('defines the required operator channels plus explicit raw/config channels', () => {
    expect(EVENT_CHANNELS).toEqual([
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
    ]);

    for (const channel of REQUIRED_TUI_CHANNELS) {
      expect(EVENT_CHANNELS).toContain(channel);
    }
  });

  it('maps all runtime event types to at least one operator channel', () => {
    expect(validateEventChannelContracts()).toEqual([]);

    for (const eventType of RUNTIME_EVENT_TYPES) {
      expect(channelsForEventType(eventType, { include_raw: true })).not.toEqual([]);
    }
  });

  it('keeps raw quotes explicit and out of the default TUI subscription', () => {
    expect(channelsForEventType('QUOTE')).toEqual(['MARKET']);
    expect(channelsForEventType('QUOTE', { include_raw: true })).toEqual([
      'MARKET',
      'QUOTE_RAW',
    ]);
    expect(defaultTuiChannels()).toEqual(REQUIRED_TUI_CHANNELS);
    expect(defaultTuiChannels()).not.toContain('QUOTE_RAW');
  });

  it('defines throttling rates using event timestamps rather than wall clock', () => {
    expect(channelContractFor('MARKET').throttle).toEqual({
      kind: 'fixed_rate',
      max_hz: 5,
      window_ms: 200,
      source_clock: 'event_ts_ns',
      selection: 'latest_event_per_window',
    });
    expect(channelContractFor('MICROSTRUCTURE').throttle).toEqual({
      kind: 'fixed_rate',
      max_hz: 2,
      window_ms: 500,
      source_clock: 'event_ts_ns',
      selection: 'latest_event_per_window',
    });
    expect(channelContractFor('CONNECTION').throttle).toEqual({
      kind: 'fixed_rate',
      max_hz: 1,
      window_ms: 1_000,
      source_clock: 'event_ts_ns',
      selection: 'latest_event_per_window',
    });
  });

  it('groups strategy, candidate, order, and position facts without recomputation permission', () => {
    expect(eventTypesForChannel('CANDIDATES')).toEqual([
      'CANDIDATE',
      'ML_UPLIFT',
      'RANK',
      'RISK_GATE',
      'SIZING',
    ]);
    expect(eventTypesForChannel('ORDERS')).toEqual(['ORDER_INTENT', 'SIM_FILL']);
    expect(eventTypesForChannel('POSITION')).toEqual([
      'POSITION',
      'MGMT_TICK',
      'MGMT_ACTION',
    ]);

    for (const channel of EVENT_CHANNELS) {
      const contract = channelContractFor(channel);
      expect(contract.facts_are_authoritative).toBe(true);
      expect(contract.recomputation_allowed).toBe(false);
    }
  });

  it('defines subscriber channel sets for formatter, query, alerts, replay, and TUI', () => {
    expect(channelsForSubscriber('FORMATTER')).toContain('CONFIG');
    expect(channelsForSubscriber('FORMATTER')).not.toContain('QUOTE_RAW');
    expect(channelsForSubscriber('JOURNAL_QUERY')).toContain('QUOTE_RAW');
    expect(channelsForSubscriber('REPLAY')).toContain('QUOTE_RAW');
    expect(channelsForSubscriber('ALERTS')).toEqual([
      'CONNECTION',
      'SESSION',
      'CANDIDATES',
      'ORDERS',
      'POSITION',
    ]);
  });
});
