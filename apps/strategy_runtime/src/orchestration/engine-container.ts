import type { LoadedAppConfig } from '../config/types.js';
import type { JournalEventEnvelope } from '../contracts/index.js';
import {
  createJournalTransportConfigFromAppConfig,
  JsonlJournalTransportIngestor,
  type JournalTransportConfig,
  type JournalTransportSink,
} from '../transport/index.js';
import { RuntimeEventBus, type RuntimeEventBusOptions } from './event-bus.js';

export interface StrategyRuntimeEngineContainerOptions {
  readonly config: LoadedAppConfig;
  readonly event_bus?: RuntimeEventBus;
  readonly event_bus_options?: RuntimeEventBusOptions;
  readonly journal_transport_config?: JournalTransportConfig;
}

export interface StrategyRuntimeEngineContainer {
  readonly config: LoadedAppConfig;
  readonly eventBus: RuntimeEventBus;
  readonly journalTransportConfig: JournalTransportConfig;
  readonly createJournalIngestor: (
    sink?: Partial<JournalTransportSink>,
  ) => JsonlJournalTransportIngestor;
  readonly publish: (event: JournalEventEnvelope) => Promise<void>;
}

export function createStrategyRuntimeEngineContainer(
  options: StrategyRuntimeEngineContainerOptions,
): StrategyRuntimeEngineContainer {
  const eventBus =
    options.event_bus ?? new RuntimeEventBus(options.event_bus_options);
  const journalTransportConfig =
    options.journal_transport_config ??
    createJournalTransportConfigFromAppConfig(options.config.publicConfig);

  return {
    config: options.config,
    eventBus,
    journalTransportConfig,
    createJournalIngestor: (sink = {}) =>
      new JsonlJournalTransportIngestor(journalTransportConfig, {
        onEvent: async (ingestedEvent) => {
          await eventBus.publish(ingestedEvent.event);
          await sink.onEvent?.(ingestedEvent);
        },
        onMalformedLine: sink.onMalformedLine,
      }),
    publish: async (event) => {
      await eventBus.publish(event);
    },
  };
}
