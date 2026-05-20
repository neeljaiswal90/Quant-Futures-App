import { stdout as processStdout } from 'node:process';
import type { AnyJournalEventEnvelope, RuntimeEventType } from '../../contracts/index.js';
import type { RuntimeEventBus } from '../../orchestration/index.js';
import { render as renderHeaderPanel } from './panels/header-panel.js';
import { render as renderSloPanel } from './panels/slo-panel.js';
import { render as renderQuarantinePanel } from './panels/quarantine-panel.js';
import { render as renderHaltPanel } from './panels/halt-panel.js';
import { render as renderValidatorsPanel } from './panels/validators-panel.js';
import { render as renderLatencyPanel } from './panels/latency-panel.js';
import { render as renderMaskPanel } from './panels/mask-panel.js';
import {
  OPERATOR_CONSOLE_CURRENT_EVENT_TYPES,
  OPERATOR_CONSOLE_FUTURE_PANEL_SLOTS,
  OperatorConsoleStateStore,
  type CurrentOperatorConsoleEventType,
  type OperatorConsoleState,
} from './console-state.js';
import { bold } from './ansi-renderer.js';

export const DEFAULT_OPERATOR_CONSOLE_REFRESH_INTERVAL_MS = 1_000;
export const QFA_CONSOLE_REFRESH_INTERVAL_MS_ENV = 'QFA_CONSOLE_REFRESH_INTERVAL_MS' as const;

export const OPERATOR_CONSOLE_EVENT_TYPES: readonly CurrentOperatorConsoleEventType[] =
  OPERATOR_CONSOLE_CURRENT_EVENT_TYPES;

export const OPERATOR_CONSOLE_FUTURE_EVENT_TYPES = OPERATOR_CONSOLE_FUTURE_PANEL_SLOTS.flatMap(
  (slot) => slot.event_types,
);

export interface OperatorConsoleSubscription {
  readonly unsubscribe: () => void;
}

export interface OperatorConsoleEventSourceSubscribeOptions {
  readonly event_types: readonly CurrentOperatorConsoleEventType[];
}

export interface OperatorConsoleEventSource {
  subscribe(
    options: OperatorConsoleEventSourceSubscribeOptions,
    handler: (event: AnyJournalEventEnvelope) => void | Promise<void>,
  ): OperatorConsoleSubscription;
}

export interface OperatorConsoleWriter {
  write(chunk: string): unknown;
}

export interface OperatorConsolePanelDefinition {
  readonly id: 'header' | 'slo' | 'quarantine' | 'halt' | 'validators' | 'latency' | 'mask';
  readonly title: string;
  readonly render: (state: OperatorConsoleState) => string;
}

export const OPERATOR_CONSOLE_PANEL_DEFINITIONS: readonly OperatorConsolePanelDefinition[] = [
  {
    id: 'header',
    title: 'Header',
    render: (state) => renderHeaderPanel(state.header),
  },
  {
    id: 'slo',
    title: 'SLO',
    render: (state) => renderSloPanel(state.slo),
  },
  {
    id: 'quarantine',
    title: 'Quarantine',
    render: (state) => renderQuarantinePanel(state.quarantine),
  },
  {
    id: 'halt',
    title: 'Halt',
    render: (state) => renderHaltPanel(state.halt),
  },
  {
    id: 'validators',
    title: 'Validators',
    render: (state) => renderValidatorsPanel(state.validators),
  },
  {
    id: 'latency',
    title: 'Latency',
    render: (state) => renderLatencyPanel(state.latency),
  },
  {
    id: 'mask',
    title: 'Mask',
    render: (state) => renderMaskPanel(state.mask),
  },
];

export interface OperatorConsoleOptions {
  readonly event_source?: OperatorConsoleEventSource;
  readonly state_store?: OperatorConsoleStateStore;
  readonly writer?: OperatorConsoleWriter;
  readonly refresh_interval_ms?: number;
  readonly clear_screen?: boolean;
}

export class OperatorConsole {
  private readonly eventSource?: OperatorConsoleEventSource;
  private readonly stateStore: OperatorConsoleStateStore;
  private readonly writer: OperatorConsoleWriter;
  private readonly refreshIntervalMs: number;
  private readonly clearScreen: boolean;
  private eventSubscription: OperatorConsoleSubscription | undefined;
  private sloUnsubscribe: (() => void) | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: OperatorConsoleOptions = {}) {
    this.eventSource = options.event_source;
    this.stateStore = options.state_store ?? new OperatorConsoleStateStore();
    this.writer = options.writer ?? processStdout;
    this.refreshIntervalMs = options.refresh_interval_ms ?? refreshIntervalMsFromEnv();
    this.clearScreen = options.clear_screen ?? true;
    assertRefreshInterval(this.refreshIntervalMs);
  }

  start(): void {
    if (this.refreshTimer !== undefined) {
      return;
    }
    this.eventSubscription = this.eventSource?.subscribe(
      { event_types: OPERATOR_CONSOLE_EVENT_TYPES },
      (event) => {
        this.stateStore.observeEvent(event);
      },
    );
    this.sloUnsubscribe = this.stateStore.subscribeToBurnRateEvaluator();
    this.refresh();
    this.refreshTimer = setInterval(() => {
      this.refresh();
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.eventSubscription?.unsubscribe();
    this.eventSubscription = undefined;
    this.sloUnsubscribe?.();
    this.sloUnsubscribe = undefined;
  }

  observeEvent(event: AnyJournalEventEnvelope): void {
    this.stateStore.observeEvent(event);
  }

  renderOnce(): string {
    this.stateStore.captureSnapshots();
    return renderOperatorConsoleDashboard(this.stateStore.getState());
  }

  refresh(): string {
    const output = this.renderOnce();
    this.writer.write(`${this.clearScreen ? '\u001bc' : ''}${output}`);
    return output;
  }
}

export function renderOperatorConsoleDashboard(state: OperatorConsoleState): string {
  const lines: string[] = [];
  lines.push(bold('Quant Futures Operator Console'));
  lines.push(
    [
      'mode=read_only',
      'source=journal_events+observability_snapshots',
      `panels=${OPERATOR_CONSOLE_PANEL_DEFINITIONS.length}`,
      `future_slots=${state.future_panel_slots.map((slot) => slot.id).join(',')}`,
    ].join(' '),
  );
  lines.push('controls=disabled inputs=disabled ansi_renderer=true');
  lines.push('');
  for (const panel of OPERATOR_CONSOLE_PANEL_DEFINITIONS) {
    lines.push(panel.render(state));
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function refreshIntervalMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[QFA_CONSOLE_REFRESH_INTERVAL_MS_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_OPERATOR_CONSOLE_REFRESH_INTERVAL_MS;
  }
  const parsed = Number(raw);
  assertRefreshInterval(parsed);
  return parsed;
}

export function operatorConsoleEventSourceFromRuntimeEventBus(
  bus: Pick<RuntimeEventBus, 'subscribe'>,
): OperatorConsoleEventSource {
  return {
    subscribe: (options, handler) => {
      const subscription = bus.subscribe(
        { event_types: [...options.event_types] as RuntimeEventType[] },
        async (delivery) => {
          await handler(delivery.event as AnyJournalEventEnvelope);
        },
      );
      return {
        unsubscribe: subscription.unsubscribe,
      };
    },
  };
}

function assertRefreshInterval(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${QFA_CONSOLE_REFRESH_INTERVAL_MS_ENV} must be a positive integer`);
  }
}