import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  stderr as processStderr,
  stdin as processStdin,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  channelsForEventType,
  channelsForSubscriber,
  eventTypesForChannel,
  formatJournalEventSchemaValidationErrors,
  journalEventFromJsonLine,
  validateJournalEventEnvelope,
  type EventChannel,
  type JournalEventEnvelope,
  type RuntimeEventType,
  type UnixNs,
} from '../contracts/index.js';
import { ns } from '../contracts/time.js';

export const TUI_PANEL_IDS = [
  'CONNECTION',
  'SESSION',
  'MARKET',
  'INDICATORS',
  'STRUCTURE',
  'MICROSTRUCTURE',
  'STRATEGY_GATES',
  'POSITION',
] as const;

export type TuiPanelId = (typeof TUI_PANEL_IDS)[number];
export type TuiPanelStatus = 'missing' | 'warmup' | 'active' | 'stale' | 'alert';

export interface TuiPanelDefinition {
  readonly id: TuiPanelId;
  readonly title: string;
  readonly channels: readonly EventChannel[];
  readonly stale_after_ms: number;
}

export interface TuiPanelSnapshot {
  readonly id: TuiPanelId;
  readonly title: string;
  readonly channels: readonly EventChannel[];
  readonly status: TuiPanelStatus;
  readonly latest_ts_ns?: UnixNs;
  readonly age_ms?: number;
  readonly lines: readonly string[];
}

export interface TuiDashboardSnapshot {
  readonly render_at_ts_ns?: UnixNs;
  readonly run_id?: string;
  readonly session_id?: string;
  readonly tui_events_seen: number;
  readonly panels: readonly TuiPanelSnapshot[];
}

export interface TuiRenderOptions {
  readonly color: boolean;
  readonly render_at_ts_ns?: UnixNs;
}

export interface TuiDiagnostic {
  readonly line_number: number;
  readonly message: string;
}

export interface RenderTuiJsonlResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly events_seen: number;
  readonly diagnostics: readonly TuiDiagnostic[];
  readonly snapshot: TuiDashboardSnapshot;
  readonly exit_code: 0 | 1;
}

interface TuiCliOptions extends TuiRenderOptions {
  readonly journal_path?: string;
  readonly fixture?: 'obs00';
}

type EventMap = Partial<Record<RuntimeEventType, JournalEventEnvelope[]>>;

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const CYAN = '\u001b[36m';
const BOLD = '\u001b[1m';

const TUI_DEFAULT_CHANNELS = channelsForSubscriber('TUI');

export const TUI_PANEL_DEFINITIONS: readonly TuiPanelDefinition[] = [
  {
    id: 'CONNECTION',
    title: 'Connection',
    channels: ['CONNECTION'],
    stale_after_ms: 5_000,
  },
  {
    id: 'SESSION',
    title: 'Session',
    channels: ['SESSION'],
    stale_after_ms: 86_400_000,
  },
  {
    id: 'MARKET',
    title: 'Market',
    channels: ['MARKET'],
    stale_after_ms: 2_000,
  },
  {
    id: 'INDICATORS',
    title: 'Indicators',
    channels: ['INDICATORS'],
    stale_after_ms: 120_000,
  },
  {
    id: 'STRUCTURE',
    title: 'Structure',
    channels: ['STRUCTURE'],
    stale_after_ms: 120_000,
  },
  {
    id: 'MICROSTRUCTURE',
    title: 'Microstructure',
    channels: ['MICROSTRUCTURE'],
    stale_after_ms: 5_000,
  },
  {
    id: 'STRATEGY_GATES',
    title: 'Strategy Gates',
    // Strategy gates need candidate/risk/sizing facts to show the first failing decision chain.
    channels: ['STRATEGY_GATES', 'CANDIDATES'],
    stale_after_ms: 120_000,
  },
  {
    id: 'POSITION',
    title: 'Position',
    // Position state is easier to audit beside the simulated order/fill facts that caused it.
    channels: ['ORDERS', 'POSITION'],
    stale_after_ms: 120_000,
  },
] as const;

export const DEFAULT_TUI_RENDER_OPTIONS: TuiRenderOptions = {
  color: true,
};

export function parseTuiArgs(args: readonly string[]): TuiCliOptions {
  const options: {
    color: boolean;
    journal_path?: string;
    fixture?: 'obs00';
    render_at_ts_ns?: UnixNs;
  } = {
    color: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const [flag, inlineValue] = splitArg(arg);
    switch (flag) {
      case '--journal':
        options.journal_path = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--fixture': {
        const fixture = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        if (fixture !== 'obs00') {
          throw new Error(`Unsupported TUI fixture: ${fixture}`);
        }
        options.fixture = fixture;
        break;
      }
      case '--at':
      case '--render-at':
        options.render_at_ts_ns = ns(requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        }));
        break;
      case '--color':
        options.color = true;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '--help':
      case '-h':
        throw new TuiHelpRequested();
      default:
        throw new Error(`Unknown TUI argument: ${arg}`);
    }
  }

  if (options.journal_path !== undefined && options.fixture !== undefined) {
    throw new Error('Use either --journal or --fixture, not both');
  }

  return options;
}

export function renderTuiJsonl(
  input: string,
  options: TuiRenderOptions = DEFAULT_TUI_RENDER_OPTIONS,
): RenderTuiJsonlResult {
  const parsed = parseValidJournalEvents(input);
  const snapshot = buildTuiDashboardSnapshot(parsed.events, options);
  const stdout = renderTuiDashboard(snapshot, options);
  const stderr = parsed.diagnostics
    .map((diagnostic) => `line ${diagnostic.line_number}: ${diagnostic.message}`)
    .join('\n');

  return {
    stdout,
    stderr: stderr === '' ? '' : `${stderr}\n`,
    events_seen: parsed.events.length,
    diagnostics: parsed.diagnostics,
    snapshot,
    exit_code: parsed.diagnostics.length === 0 ? 0 : 1,
  };
}

export function buildTuiDashboardSnapshot(
  events: readonly JournalEventEnvelope[],
  options: Pick<TuiRenderOptions, 'render_at_ts_ns'> = {},
): TuiDashboardSnapshot {
  const tuiEvents = events.filter(isDefaultTuiEvent);
  const eventMap = groupByType(tuiEvents);
  const renderAt = options.render_at_ts_ns ?? maxEventTimestamp(tuiEvents);
  const latestEvent = tuiEvents.at(-1);

  return {
    render_at_ts_ns: renderAt,
    run_id: latestEvent?.run_id,
    session_id: latestEvent?.session_id,
    tui_events_seen: tuiEvents.length,
    panels: TUI_PANEL_DEFINITIONS.map((definition) =>
      buildPanelSnapshot(definition, eventMap, renderAt),
    ),
  };
}

export function renderTuiDashboard(
  snapshot: TuiDashboardSnapshot,
  options: Pick<TuiRenderOptions, 'color'> = DEFAULT_TUI_RENDER_OPTIONS,
): string {
  const lines: string[] = [];
  lines.push(colorize('Quant Futures Operator TUI', BOLD, options.color));
  lines.push(
    [
      'mode=read_only',
      'source=OBS-01_journal',
      `run=${snapshot.run_id ?? '--'}`,
      `session=${snapshot.session_id ?? '--'}`,
      `render_at=${snapshot.render_at_ts_ns === undefined ? '--' : nsToString(snapshot.render_at_ts_ns)}`,
      `tui_events=${snapshot.tui_events_seen}`,
    ].join(' '),
  );
  lines.push('mutation_controls=disabled facts=authoritative recomputation=false');
  lines.push('');

  for (const panel of snapshot.panels) {
    lines.push(renderPanel(panel, options.color));
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function tuiUsage(): string {
  return [
    'Usage: tui [--fixture obs00 | --journal path] [--at ts_ns|--render-at ts_ns] [--color|--no-color]',
    '',
    'Renders a read-only single-screen operator dashboard from OBS-01 JSONL.',
    'If neither --fixture nor --journal is provided, JSONL is read from stdin.',
    'Color is enabled by default; use --no-color for byte-stable fixture smoke tests.',
  ].join('\n');
}

function parseValidJournalEvents(input: string): {
  readonly events: readonly JournalEventEnvelope[];
  readonly diagnostics: readonly TuiDiagnostic[];
} {
  const events: JournalEventEnvelope[] = [];
  const diagnostics: TuiDiagnostic[] = [];
  const lines = input.split(/\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = stripTrailingCarriageReturn(lines[index]!);
    if (rawLine.trim() === '') {
      continue;
    }

    const lineNumber = index + 1;
    try {
      const event = journalEventFromJsonLine(rawLine);
      const validation = validateJournalEventEnvelope(event);
      if (!validation.ok) {
        diagnostics.push({
          line_number: lineNumber,
          message: formatJournalEventSchemaValidationErrors(validation.issues),
        });
        continue;
      }
      events.push(event);
    } catch (error) {
      diagnostics.push({
        line_number: lineNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { events, diagnostics };
}

function buildPanelSnapshot(
  definition: TuiPanelDefinition,
  eventMap: EventMap,
  renderAt: UnixNs | undefined,
): TuiPanelSnapshot {
  const relevantEvents = eventsForPanel(definition, eventMap);
  const latest = relevantEvents.at(-1);
  const ageMs = latest === undefined || renderAt === undefined
    ? undefined
    : diffMs(latest.ts_ns, renderAt);
  const status = panelStatus(definition.id, eventMap, latest, ageMs, definition.stale_after_ms);

  return {
    id: definition.id,
    title: definition.title,
    channels: definition.channels,
    status,
    latest_ts_ns: latest?.ts_ns,
    age_ms: ageMs,
    lines: linesForPanel(definition.id, eventMap),
  };
}

function panelStatus(
  panel: TuiPanelId,
  eventMap: EventMap,
  latest: JournalEventEnvelope | undefined,
  ageMs: number | undefined,
  staleAfterMs: number,
): TuiPanelStatus {
  if (latest === undefined) {
    return 'missing';
  }
  if (ageMs !== undefined && ageMs > staleAfterMs) {
    return 'stale';
  }

  if (panel === 'CONNECTION') {
    const feedState = stringPayloadField(latestOf(eventMap, 'FEED'), 'state');
    const bookWarmupComplete = booleanPayloadField(latestOf(eventMap, 'BOOK_REBUILD'), 'warmup_complete');
    if (feedState === 'warming' || bookWarmupComplete === false) {
      return 'warmup';
    }
    if (feedState === 'gap' || feedState === 'stale' || feedState === 'closed') {
      return 'alert';
    }
  }

  if (panel === 'SESSION') {
    if (stringPayloadField(latestOf(eventMap, 'HALT'), 'state') === 'halted') {
      return 'alert';
    }
    if (stringPayloadField(latestOf(eventMap, 'ROLL_ADVISORY'), 'advisory') === 'block_new_entries') {
      return 'warmup';
    }
  }

  if (panel === 'STRATEGY_GATES') {
    const gate = stringPayloadField(latestOf(eventMap, 'STRAT_EVAL'), 'gate_state');
    const risk = stringPayloadField(latestOf(eventMap, 'RISK_GATE'), 'status');
    if (gate === 'blocked' || risk === 'reject') {
      return 'alert';
    }
    if (gate === 'waiting') {
      return 'warmup';
    }
  }

  if (panel === 'POSITION') {
    if (latestOf(eventMap, 'EXEC_REJECT') !== undefined) {
      return 'alert';
    }
    const upnl = numberPayloadField(latestOf(eventMap, 'MGMT_TICK'), 'unrealized_pnl_usd');
    if (upnl !== undefined && upnl < 0) {
      return 'alert';
    }
  }

  return 'active';
}

function linesForPanel(panel: TuiPanelId, eventMap: EventMap): readonly string[] {
  switch (panel) {
    case 'CONNECTION':
      return connectionLines(eventMap);
    case 'SESSION':
      return sessionLines(eventMap);
    case 'MARKET':
      return marketLines(eventMap);
    case 'INDICATORS':
      return indicatorLines(eventMap);
    case 'STRUCTURE':
      return structureLines(eventMap);
    case 'MICROSTRUCTURE':
      return microstructureLines(eventMap);
    case 'STRATEGY_GATES':
      return strategyGateLines(eventMap);
    case 'POSITION':
      return positionLines(eventMap);
    default:
      return assertNeverPanel(panel);
  }
}

function connectionLines(eventMap: EventMap): readonly string[] {
  const conn = latestOf(eventMap, 'CONN');
  const feed = latestOf(eventMap, 'FEED');
  const rebuild = latestOf(eventMap, 'BOOK_REBUILD');
  const gaps = eventMap.GAP ?? [];

  return [
    `gateway=${stringPayloadField(conn, 'state') ?? '--'} detail=${stringPayloadField(conn, 'detail') ?? '--'}`,
    `feed=${stringPayloadField(feed, 'state') ?? '--'} stream=${stringPayloadField(feed, 'stream') ?? '--'}`,
    `feed_latency_ms p50=-- p99=--`,
    `gaps_this_session=${gaps.length}`,
    `book_rebuild=${stringPayloadField(rebuild, 'authority') ?? '--'} warmup=${boolString(booleanPayloadField(rebuild, 'warmup_complete'))} reason=${stringPayloadField(rebuild, 'reason') ?? '--'}`,
  ];
}

function sessionLines(eventMap: EventMap): readonly string[] {
  const session = latestOf(eventMap, 'SESSION_PHASE');
  const roll = latestOf(eventMap, 'ROLL_ADVISORY');
  const halt = latestOf(eventMap, 'HALT');

  return [
    `phase=${stringPayloadField(session, 'phase') ?? '--'} trading_date=${stringPayloadField(session, 'trading_date') ?? '--'}`,
    `time_to_close=-- maintenance=--`,
    `roll=${stringPayloadField(roll, 'advisory') ?? '--'} active=${stringPayloadField(roll, 'active_symbol') ?? '--'} next=${stringPayloadField(roll, 'next_symbol') ?? '--'}`,
    `halt=${stringPayloadField(halt, 'state') ?? '--'} reason=${stringPayloadField(halt, 'reason') ?? '--'}`,
  ];
}

function marketLines(eventMap: EventMap): readonly string[] {
  const quote = latestOf(eventMap, 'QUOTE');
  const trade = latestOf(eventMap, 'TRADE');
  const bar = latestOf(eventMap, 'BAR_CLOSE');

  return [
    `l1 bid=${numberString(numberPayloadField(quote, 'bid_px'))}x${numberString(numberPayloadField(quote, 'bid_qty'))} ask=${numberString(numberPayloadField(quote, 'ask_px'))}x${numberString(numberPayloadField(quote, 'ask_qty'))}`,
    `trade px=${numberString(numberPayloadField(trade, 'price'))} qty=${numberString(numberPayloadField(trade, 'quantity'))} side=${stringPayloadField(trade, 'aggressor_side') ?? '--'}`,
    `bar_1m o=${numberString(numberPayloadField(bar, 'open'))} h=${numberString(numberPayloadField(bar, 'high'))} l=${numberString(numberPayloadField(bar, 'low'))} c=${numberString(numberPayloadField(bar, 'close'))} vol=${numberString(numberPayloadField(bar, 'volume'))}`,
    `bar_5m o=-- h=-- l=-- c=-- vol=--`,
  ];
}

function indicatorLines(eventMap: EventMap): readonly string[] {
  const features = latestOf(eventMap, 'FEATURES');
  const values = valuesRecord(features);
  return [
    `snapshot=${stringPayloadField(features, 'feature_snapshot_id') ?? '--'}`,
    `ema9=${scalarString(values, 'ema9')} atr_pts=${scalarString(values, 'atr_pts')} sigma_pts=${scalarString(values, 'sigma_pts')}`,
    `vwap_z=${scalarString(values, 'vwap_z')} supertrend=-- adx=-- di=--`,
  ];
}

function structureLines(eventMap: EventMap): readonly string[] {
  const structure = latestOf(eventMap, 'STRUCTURE');
  const values = valuesRecord(structure);
  return [
    `trend=${stringPayloadField(structure, 'trend') ?? '--'} snapshot=${stringPayloadField(structure, 'feature_snapshot_id') ?? '--'}`,
    `bos_recent=${scalarString(values, 'bos_recent')} choch=-- pullback_ratio=${scalarString(values, 'pullback_ratio')}`,
    `swing_low=${scalarString(values, 'swing_low')} open_range=-- overnight=-- daily_open=--`,
  ];
}

function microstructureLines(eventMap: EventMap): readonly string[] {
  const micro = latestOf(eventMap, 'MICROSTRUCTURE');
  const values = valuesRecord(micro);
  return [
    `l3_authority=${stringPayloadField(micro, 'l3_authority') ?? '--'} snapshot=${stringPayloadField(micro, 'feature_snapshot_id') ?? '--'}`,
    `spread_ticks=${scalarString(values, 'spread_ticks')} microprice_offset_ticks=${scalarString(values, 'microprice_offset_ticks')}`,
    `ofi_short=${scalarString(values, 'ofi_short')} queue_imbalance=${scalarString(values, 'queue_imbalance')} depth_imbalance=-- flags=--`,
  ];
}

function strategyGateLines(eventMap: EventMap): readonly string[] {
  const evalEvent = latestOf(eventMap, 'STRAT_EVAL');
  const candidate = latestOf(eventMap, 'CANDIDATE');
  const risk = latestOf(eventMap, 'RISK_GATE');
  const sizing = latestOf(eventMap, 'SIZING');

  return [
    `strategy=${stringPayloadField(evalEvent, 'strategy_id') ?? '--'} gate=${stringPayloadField(evalEvent, 'gate_state') ?? '--'} score=${numberString(numberPayloadField(evalEvent, 'score'))}`,
    `reasons=${stringArrayPayloadField(evalEvent, 'reasons')}`,
    `candidate=${stringPayloadField(candidate, 'candidate_id') ?? '--'} status=${stringPayloadField(candidate, 'status') ?? '--'} dir=${stringPayloadField(candidate, 'direction') ?? '--'} entry=${numberString(numberPayloadField(candidate, 'entry_price'))} stop=${numberString(numberPayloadField(candidate, 'stop_price'))}`,
    `risk=${stringPayloadField(risk, 'status') ?? '--'} sizing_qty=${numberString(numberPayloadField(sizing, 'quantity'))} risk_usd=${numberString(numberPayloadField(sizing, 'risk_usd'))}`,
  ];
}

function positionLines(eventMap: EventMap): readonly string[] {
  const order = latestOf(eventMap, 'ORDER_INTENT');
  const fill = latestOf(eventMap, 'SIM_FILL');
  const reject = latestOf(eventMap, 'EXEC_REJECT');
  const position = latestOf(eventMap, 'POSITION');
  const tick = latestOf(eventMap, 'MGMT_TICK');
  const action = latestOf(eventMap, 'MGMT_ACTION');

  return [
    `position=${stringPayloadField(position, 'position_id') ?? '--'} status=${stringPayloadField(position, 'status') ?? '--'} side=${stringPayloadField(position, 'side') ?? '--'} qty_open=${numberString(numberPayloadField(position, 'quantity_open'))}`,
    `avg_entry=${numberString(numberPayloadField(position, 'avg_entry_price'))} mark=${numberString(numberPayloadField(tick, 'mark_price'))} upnl_usd=${numberString(numberPayloadField(tick, 'unrealized_pnl_usd'))} today_r=--`,
    `order=${stringPayloadField(order, 'order_intent_id') ?? '--'} type=${stringPayloadField(order, 'order_type') ?? '--'} side=${stringPayloadField(order, 'side') ?? '--'} qty=${numberString(numberPayloadField(order, 'quantity'))}`,
    `fill=${stringPayloadField(fill, 'fill_id') ?? '--'} px=${numberString(numberPayloadField(fill, 'price'))} liq=${stringPayloadField(fill, 'liquidity') ?? '--'} fills_today=${eventCount(eventMap, 'SIM_FILL')}`,
    `reject=${stringPayloadField(reject, 'execution_reject_id') ?? '--'} status=${stringPayloadField(reject, 'status') ?? '--'} reason=${stringPayloadField(reject, 'reason') ?? '--'}`,
    `management=${stringPayloadField(action, 'action_type') ?? '--'} reason=${stringPayloadField(action, 'reason') ?? '--'}`,
  ];
}

function renderPanel(panel: TuiPanelSnapshot, color: boolean): string {
  const statusLabel = panel.status.toUpperCase();
  const age = panel.age_ms === undefined ? '--' : `${panel.age_ms}ms`;
  const header = [
    `[${panel.id}]`,
    panel.title,
    `status=${statusLabel}`,
    `age=${age}`,
    `channels=${panel.channels.join(',')}`,
  ].join(' ');
  const renderedHeader = colorize(header, colorForPanelStatus(panel.status), color);
  const renderedLines = panel.lines.map((line) => {
    const rendered = `  ${line}`;
    return panel.status === 'stale' ? colorize(rendered, DIM, color) : colorizeStatusWords(rendered, color);
  });
  return [renderedHeader, ...renderedLines].join('\n');
}

function colorizeStatusWords(value: string, color: boolean): string {
  if (!color) {
    return value;
  }
  return value
    .replace(/(gate=armed|risk=pass|status=open|feed=live|halt=resumed)/g, `${GREEN}$1${RESET}`)
    .replace(/(feed=warming|status=proposed|roll=block_new_entries|warmup=false)/g, `${YELLOW}$1${RESET}`)
    .replace(/(gate=blocked|risk=reject|halt=halted|feed=gap|feed=stale|upnl_usd=-[0-9.]+)/g, `${RED}$1${RESET}`);
}

function colorForPanelStatus(status: TuiPanelStatus): string {
  switch (status) {
    case 'active':
      return GREEN;
    case 'warmup':
      return YELLOW;
    case 'alert':
      return RED;
    case 'stale':
    case 'missing':
      return DIM;
    default:
      return assertNeverStatus(status);
  }
}

function eventsForPanel(definition: TuiPanelDefinition, eventMap: EventMap): readonly JournalEventEnvelope[] {
  const channelTypes = new Set<RuntimeEventType>();
  for (const channel of definition.channels) {
    for (const type of eventTypesForChannel(channel)) {
      channelTypes.add(type);
    }
  }
  const events: JournalEventEnvelope[] = [];
  for (const type of channelTypes) {
    events.push(...(eventMap[type] ?? []));
  }
  return events.sort(compareEventsByTimestampThenInputOrder);
}

function groupByType(events: readonly JournalEventEnvelope[]): EventMap {
  const eventMap: EventMap = {};
  for (const event of events) {
    const existing = eventMap[event.type] ?? [];
    eventMap[event.type] = [...existing, event];
  }
  return eventMap;
}

function latestOf<TType extends RuntimeEventType>(
  eventMap: EventMap,
  type: TType,
): JournalEventEnvelope<TType> | undefined {
  const events = eventMap[type];
  return events?.at(-1) as JournalEventEnvelope<TType> | undefined;
}

function eventCount(eventMap: EventMap, type: RuntimeEventType): number {
  return eventMap[type]?.length ?? 0;
}

function maxEventTimestamp(events: readonly JournalEventEnvelope[]): UnixNs | undefined {
  let latest: UnixNs | undefined;
  for (const event of events) {
    if (latest === undefined || BigInt(event.ts_ns) > BigInt(latest)) {
      latest = event.ts_ns;
    }
  }
  return latest;
}

function isDefaultTuiEvent(event: JournalEventEnvelope): boolean {
  const eventChannels = channelsForEventType(event.type);
  return eventChannels.some((channel) => TUI_DEFAULT_CHANNELS.includes(channel));
}

function compareEventsByTimestampThenInputOrder(
  left: JournalEventEnvelope,
  right: JournalEventEnvelope,
): number {
  if (BigInt(left.ts_ns) < BigInt(right.ts_ns)) return -1;
  if (BigInt(left.ts_ns) > BigInt(right.ts_ns)) return 1;
  return 0;
}

function diffMs(from: UnixNs, to: UnixNs): number {
  const delta = BigInt(to) - BigInt(from);
  if (delta <= 0n) {
    return 0;
  }
  return Number(delta / 1_000_000n);
}

function payloadRecord(event: JournalEventEnvelope | undefined): Record<string, unknown> | undefined {
  if (event === undefined || event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return undefined;
  }
  return event.payload as Record<string, unknown>;
}

function stringPayloadField(event: JournalEventEnvelope | undefined, field: string): string | undefined {
  const value = payloadRecord(event)?.[field];
  return typeof value === 'string' ? value : undefined;
}

function numberPayloadField(event: JournalEventEnvelope | undefined, field: string): number | undefined {
  const value = payloadRecord(event)?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanPayloadField(event: JournalEventEnvelope | undefined, field: string): boolean | undefined {
  const value = payloadRecord(event)?.[field];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayPayloadField(event: JournalEventEnvelope | undefined, field: string): string {
  const value = payloadRecord(event)?.[field];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value.join('|')
    : '--';
}

function valuesRecord(event: JournalEventEnvelope | undefined): Record<string, unknown> | undefined {
  const values = payloadRecord(event)?.values;
  return values !== null && typeof values === 'object' && !Array.isArray(values)
    ? (values as Record<string, unknown>)
    : undefined;
}

function scalarString(record: Record<string, unknown> | undefined, field: string): string {
  if (record === undefined || record[field] === undefined || record[field] === null) {
    return '--';
  }
  const value = record[field];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return '--';
}

function numberString(value: number | undefined): string {
  return value === undefined ? '--' : String(value);
}

function boolString(value: boolean | undefined): string {
  return value === undefined ? '--' : String(value);
}

function nsToString(value: UnixNs | bigint): string {
  return BigInt(value).toString();
}

function colorize(value: string, colorCode: string, enabled: boolean): string {
  return enabled ? `${colorCode}${value}${RESET}` : value;
}

function splitArg(arg: string): readonly [string, string | undefined] {
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex < 0) {
    return [arg, undefined];
  }
  return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
}

function requireValue(
  flag: string,
  inlineValue: string | undefined,
  nextValue: () => string | undefined,
): string {
  if (inlineValue !== undefined) {
    if (inlineValue === '') {
      throw new Error(`${flag} requires a non-empty value`);
    }
    return inlineValue;
  }
  const value = nextValue();
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}

function fixturePath(fixture: 'obs00'): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  switch (fixture) {
    case 'obs00':
      return join(moduleDir, '..', '..', 'tests', 'fixtures', 'obs00', 'mini-journal.jsonl');
    default:
      return assertNeverFixture(fixture);
  }
}

function assertNeverPanel(panel: never): never {
  throw new Error(`Unhandled TUI panel: ${String(panel)}`);
}

function assertNeverStatus(status: never): never {
  throw new Error(`Unhandled TUI panel status: ${String(status)}`);
}

function assertNeverFixture(fixture: never): never {
  throw new Error(`Unhandled TUI fixture: ${String(fixture)}`);
}

class TuiHelpRequested extends Error {
  constructor() {
    super('TUI help requested');
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of processStdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function inputForCli(options: TuiCliOptions): Promise<string> {
  if (options.fixture !== undefined) {
    return readFileSync(fixturePath(options.fixture), 'utf8');
  }
  if (options.journal_path !== undefined) {
    return readFileSync(resolve(options.journal_path), 'utf8');
  }
  return readStdin();
}

async function main(): Promise<void> {
  let options: TuiCliOptions;
  try {
    options = parseTuiArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof TuiHelpRequested) {
      processStdout.write(`${tuiUsage()}\n`);
      return;
    }
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const input = await inputForCli(options);
    const result = renderTuiJsonl(input, options);
    processStdout.write(result.stdout);
    processStderr.write(result.stderr);
    process.exitCode = result.exit_code;
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath !== undefined && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  void main();
}
