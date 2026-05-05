import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  channelsForEventType,
  formatJournalEventSchemaValidationErrors,
  journalEventFromJsonLine,
  parseRuntimeEventType,
  stableJsonStringify,
  validateJournalEventEnvelope,
  type JournalEventEnvelope,
  type JsonValue,
  type RuntimeEventType,
  type UnixNs,
} from '../contracts/index.js';
import { ns } from '../contracts/time.js';

export interface FormatterOptions {
  readonly color: boolean;
  readonly only_types: readonly RuntimeEventType[];
  readonly grep?: string;
  readonly strategy_id?: string;
  readonly since_ts_ns?: UnixNs;
}

export interface FormatterDiagnostic {
  readonly line_number: number;
  readonly message: string;
}

export interface FormatJournalJsonlResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly events_seen: number;
  readonly events_rendered: number;
  readonly diagnostics: readonly FormatterDiagnostic[];
  readonly exit_code: 0 | 1;
}

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const CYAN = '\u001b[36m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';

export const DEFAULT_FORMATTER_OPTIONS: FormatterOptions = {
  color: false,
  only_types: [],
};

export function parseFormatterArgs(args: readonly string[]): FormatterOptions {
  const options: {
    color: boolean;
    only_types: RuntimeEventType[];
    grep?: string;
    strategy_id?: string;
    since_ts_ns?: UnixNs;
  } = {
    color: false,
    only_types: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const [flag, inlineValue] = splitArg(arg);

    switch (flag) {
      case '--color':
        options.color = true;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '--only':
        options.only_types.push(...parseOnlyTypes(requireValue(flag, inlineValue, args, () => {
          index += 1;
          return args[index];
        })));
        break;
      case '--grep':
        options.grep = requireValue(flag, inlineValue, args, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--strategy':
        options.strategy_id = requireValue(flag, inlineValue, args, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--since':
        options.since_ts_ns = ns(requireValue(flag, inlineValue, args, () => {
          index += 1;
          return args[index];
        }));
        break;
      case '--help':
      case '-h':
        throw new FormatterHelpRequested();
      default:
        throw new Error(`Unknown formatter argument: ${arg}`);
    }
  }

  return options;
}

export function formatJournalJsonl(
  input: string,
  options: FormatterOptions = DEFAULT_FORMATTER_OPTIONS,
): FormatJournalJsonlResult {
  const lines = input.split(/\n/);
  const outputLines: string[] = [];
  const diagnostics: FormatterDiagnostic[] = [];
  let eventsSeen = 0;

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

      eventsSeen += 1;
      if (eventMatchesFilters(event, options)) {
        outputLines.push(formatJournalEvent(event, options));
      }
    } catch (error) {
      diagnostics.push({
        line_number: lineNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const stderr = diagnostics
    .map((diagnostic) => `line ${diagnostic.line_number}: ${diagnostic.message}`)
    .join('\n');
  const stdout = outputLines.length === 0 ? '' : `${outputLines.join('\n')}\n`;

  return {
    stdout,
    stderr: stderr === '' ? '' : `${stderr}\n`,
    events_seen: eventsSeen,
    events_rendered: outputLines.length,
    diagnostics,
    exit_code: diagnostics.length === 0 ? 0 : 1,
  };
}

export function formatJournalEvent(
  event: JournalEventEnvelope,
  options: Pick<FormatterOptions, 'color'> = { color: false },
): string {
  const channels = channelsForEventType(event.type).join(',');
  const base = [
    colorize(nsToString(event.ts_ns), DIM, options.color),
    colorize(event.type, colorForEventType(event.type), options.color),
    colorize(`[${channels}]`, DIM, options.color),
    `run=${event.run_id}`,
    `session=${event.session_id}`,
    `event=${event.event_id}`,
  ];

  if (event.causation_id !== undefined) {
    base.push(`cause=${event.causation_id}`);
  }
  if (event.correlation_id !== undefined) {
    base.push(`corr=${event.correlation_id}`);
  }

  const detail = formatPayloadSummary(event);
  if (detail !== '') {
    base.push(detail);
  }

  return base.join(' ');
}

export function formatterUsage(): string {
  return [
    'Usage: format:journal [--only type=A,B] [--grep text] [--strategy strategy_id] [--since ts_ns] [--color]',
    '',
    'Reads OBS-01 JSONL events from stdin and writes deterministic human-readable lines to stdout.',
    '--since accepts a decimal nanosecond timestamp. Color is off by default.',
  ].join('\n');
}

function eventMatchesFilters(event: JournalEventEnvelope, options: FormatterOptions): boolean {
  if (options.only_types.length > 0 && !options.only_types.includes(event.type)) {
    return false;
  }

  if (options.since_ts_ns !== undefined && BigInt(event.ts_ns) < BigInt(options.since_ts_ns)) {
    return false;
  }

  if (options.strategy_id !== undefined && strategyIdForEvent(event) !== options.strategy_id) {
    return false;
  }

  if (options.grep !== undefined && !searchTextForEvent(event).includes(options.grep)) {
    return false;
  }

  return true;
}

function formatPayloadSummary(event: JournalEventEnvelope): string {
  const payload = asRecord(event.payload);
  if (payload === undefined) {
    return `payload=${stableJsonStringify(event.payload as JsonValue)}`;
  }

  switch (event.type) {
    case 'CONN':
      return compactParts([`state=${stringField(payload, 'state')}`, optionalField(payload, 'detail')]);
    case 'FEED':
      return compactParts([
        `state=${stringField(payload, 'state')}`,
        optionalField(payload, 'stream'),
        optionalField(payload, 'detail'),
      ]);
    case 'GAP':
      return compactParts([
        `gap=${stringField(payload, 'gap_id')}`,
        `stream=${stringField(payload, 'stream')}`,
        `start=${nsField(payload, 'start_ts_ns')}`,
        `end=${nsField(payload, 'end_ts_ns')}`,
      ]);
    case 'BOOK_REBUILD':
      return compactParts([
        `authority=${stringField(payload, 'authority')}`,
        `warmup=${payload.warmup_complete}`,
        `reason=${stringField(payload, 'reason')}`,
      ]);
    case 'SESSION_PHASE':
      return compactParts([
        `phase=${stringField(payload, 'phase')}`,
        `date=${stringField(payload, 'trading_date')}`,
      ]);
    case 'ROLL_ADVISORY':
      return compactParts([
        `advisory=${stringField(payload, 'advisory')}`,
        `active=${stringField(payload, 'active_symbol')}`,
        `next=${stringField(payload, 'next_symbol')}`,
      ]);
    case 'HALT':
      return compactParts([`state=${stringField(payload, 'state')}`, optionalField(payload, 'reason')]);
    case 'QUOTE':
      return compactParts([
        `bid=${numberField(payload, 'bid_px')}x${numberField(payload, 'bid_qty')}`,
        `ask=${numberField(payload, 'ask_px')}x${numberField(payload, 'ask_qty')}`,
        optionalField(payload, 'authority'),
      ]);
    case 'TRADE':
      return compactParts([
        `px=${numberField(payload, 'price')}`,
        `qty=${numberField(payload, 'quantity')}`,
        `side=${stringField(payload, 'aggressor_side')}`,
      ]);
    case 'BAR_CLOSE':
      return compactParts([
        `tf=${stringField(payload, 'timeframe')}`,
        `o=${numberField(payload, 'open')}`,
        `h=${numberField(payload, 'high')}`,
        `l=${numberField(payload, 'low')}`,
        `c=${numberField(payload, 'close')}`,
        `vol=${numberField(payload, 'volume')}`,
      ]);
    case 'FEATURES':
      return compactParts([
        `feature=${stringField(payload, 'feature_snapshot_id')}`,
        `keys=${scalarMapKeys(payload.values)}`,
      ]);
    case 'STRUCTURE':
      return compactParts([
        `feature=${stringField(payload, 'feature_snapshot_id')}`,
        `trend=${stringField(payload, 'trend')}`,
        `keys=${scalarMapKeys(payload.values)}`,
      ]);
    case 'MICROSTRUCTURE':
      return compactParts([
        `feature=${stringField(payload, 'feature_snapshot_id')}`,
        `l3=${stringField(payload, 'l3_authority')}`,
        `keys=${scalarMapKeys(payload.values)}`,
      ]);
    case 'STRAT_EVAL':
      return compactParts([
        `strategy=${stringField(payload, 'strategy_id')}`,
        `eval=${stringField(payload, 'strategy_evaluation_id')}`,
        `gate=${stringField(payload, 'gate_state')}`,
        payload.score === undefined ? undefined : `score=${numberField(payload, 'score')}`,
        `reasons=${stringArrayField(payload, 'reasons')}`,
      ]);
    case 'CANDIDATE':
      return compactParts([
        `candidate=${stringField(payload, 'candidate_id')}`,
        `strategy=${stringField(payload, 'strategy_id')}`,
        `dir=${stringField(payload, 'direction')}`,
        `status=${stringField(payload, 'status')}`,
        `entry=${numberField(payload, 'entry_price')}`,
        `stop=${numberField(payload, 'stop_price')}`,
        `conf=${numberField(payload, 'confidence')}`,
      ]);
    case 'ML_UPLIFT':
      return compactParts([
        `model=${stringField(payload, 'model_id')}`,
        `score=${numberField(payload, 'score')}`,
        `enabled=${payload.enabled}`,
      ]);
    case 'RANK':
      return compactParts([
        `method=${stringField(payload, 'method')}`,
        `count=${arrayLength(payload.ranked_candidate_ids)}`,
      ]);
    case 'RISK_GATE':
      return compactParts([
        `risk=${stringField(payload, 'risk_gate_decision_id')}`,
        `candidate=${stringField(payload, 'candidate_id')}`,
        `status=${stringField(payload, 'status')}`,
        `reasons=${stringArrayField(payload, 'reasons')}`,
      ]);
    case 'SIZING':
      return compactParts([
        `sizing=${stringField(payload, 'sizing_decision_id')}`,
        `candidate=${stringField(payload, 'candidate_id')}`,
        `qty=${numberField(payload, 'quantity')}`,
        `risk_usd=${numberField(payload, 'risk_usd')}`,
        `risk_pts=${numberField(payload, 'risk_points')}`,
      ]);
    case 'ORDER_INTENT':
      return compactParts([
        `order=${stringField(payload, 'order_intent_id')}`,
        `candidate=${stringField(payload, 'candidate_id')}`,
        `side=${stringField(payload, 'side')}`,
        `type=${stringField(payload, 'order_type')}`,
        `qty=${numberField(payload, 'quantity')}`,
      ]);
    case 'SIM_FILL':
      return compactParts([
        `fill=${stringField(payload, 'fill_id')}`,
        `order=${stringField(payload, 'order_intent_id')}`,
        `side=${stringField(payload, 'side')}`,
        `qty=${numberField(payload, 'quantity')}`,
        `px=${numberField(payload, 'price')}`,
        `liq=${stringField(payload, 'liquidity')}`,
      ]);
    case 'EXEC_REJECT':
      return compactParts([
        `reject=${stringField(payload, 'execution_reject_id')}`,
        `order=${stringField(payload, 'order_intent_id')}`,
        `status=${stringField(payload, 'status')}`,
        `reason=${stringField(payload, 'reason')}`,
      ]);
    case 'POSITION':
      return compactParts([
        `position=${stringField(payload, 'position_id')}`,
        `candidate=${stringField(payload, 'candidate_id')}`,
        `side=${stringField(payload, 'side')}`,
        `status=${stringField(payload, 'status')}`,
        `open_qty=${numberField(payload, 'quantity_open')}`,
        `avg=${numberField(payload, 'avg_entry_price')}`,
      ]);
    case 'MGMT_TICK':
      return compactParts([
        `position=${stringField(payload, 'position_id')}`,
        `mark=${numberField(payload, 'mark_price')}`,
        `upnl=${numberField(payload, 'unrealized_pnl_usd')}`,
      ]);
    case 'MGMT_ACTION':
      return compactParts([
        `action=${stringField(payload, 'management_action_id')}`,
        `position=${stringField(payload, 'position_id')}`,
        `type=${stringField(payload, 'action_type')}`,
        `reason=${stringField(payload, 'reason')}`,
      ]);
    case 'CONFIG':
      return compactParts([
        `config_hash=${stringField(payload, 'config_hash')}`,
        `config_version=${numberField(payload, 'config_version')}`,
      ]);
    case 'BACKTEST_RUN_META':
      // run_id lives on the envelope, not the payload (Q-1.10: payload extends
      // RunSpec without duplicating envelope fields). Access via event.run_id
      // here even though the rest of this case reads from payload.
      return compactParts([
        `run_id=${event.run_id}`,
        `run_spec_hash=${stringField(payload, 'run_spec_hash')}`,
        `run_spec_schema_version=${numberField(payload, 'run_spec_schema_version')}`,
      ]);
    default:
      return assertNeverRuntimeEventType(event.type);
  }
}

function assertNeverRuntimeEventType(type: never): never {
  throw new Error(`Unhandled runtime event type: ${String(type)}`);
}

function strategyIdForEvent(event: JournalEventEnvelope): string | undefined {
  const payload = asRecord(event.payload);
  if (payload === undefined) {
    return undefined;
  }
  return typeof payload.strategy_id === 'string' ? payload.strategy_id : undefined;
}

function searchTextForEvent(event: JournalEventEnvelope): string {
  return [
    event.type,
    event.event_id,
    event.run_id,
    event.session_id,
    event.causation_id ?? '',
    event.correlation_id ?? '',
    stableJsonStringify(event.payload as JsonValue),
  ].join(' ');
}

function parseOnlyTypes(value: string): readonly RuntimeEventType[] {
  const normalized = value.startsWith('type=') ? value.slice('type='.length) : value;
  return normalized
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => parseRuntimeEventType(item));
}

function requireValue(
  flag: string,
  inlineValue: string | undefined,
  args: readonly string[],
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

function splitArg(arg: string): readonly [string, string | undefined] {
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex < 0) {
    return [arg, undefined];
  }
  return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' ');
}

function optionalField(payload: Record<string, unknown>, field: string): string | undefined {
  if (payload[field] === undefined) {
    return undefined;
  }
  return `${field}=${String(payload[field])}`;
}

function stringField(payload: Record<string, unknown>, field: string): string {
  return typeof payload[field] === 'string' ? payload[field] : '--';
}

function numberField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '--';
}

function nsField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === 'bigint' ? nsToString(value) : '--';
}

function stringArrayField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value.join('|')
    : '--';
}

function scalarMapKeys(value: unknown): string {
  const record = asRecord(value);
  return record === undefined ? '--' : Object.keys(record).sort().join(',');
}

function arrayLength(value: unknown): string {
  return Array.isArray(value) ? String(value.length) : '--';
}

function nsToString(value: UnixNs | bigint): string {
  return BigInt(value).toString();
}

function colorize(value: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${value}${RESET}` : value;
}

function colorForEventType(type: RuntimeEventType): string {
  if (['GAP', 'HALT', 'EXEC_REJECT'].includes(type)) {
    return RED;
  }
  if (['RISK_GATE', 'MGMT_ACTION', 'ROLL_ADVISORY'].includes(type)) {
    return YELLOW;
  }
  if (['SIM_FILL', 'POSITION', 'CANDIDATE'].includes(type)) {
    return GREEN;
  }
  return CYAN;
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}

class FormatterHelpRequested extends Error {
  constructor() {
    super('formatter help requested');
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of processStdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  let options: FormatterOptions;
  try {
    options = parseFormatterArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof FormatterHelpRequested) {
      processStdout.write(`${formatterUsage()}\n`);
      return;
    }
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const input = await readStdin();
  const result = formatJournalJsonl(input, options);
  processStdout.write(result.stdout);
  processStderr.write(result.stderr);
  process.exitCode = result.exit_code;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath !== undefined && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  void main();
}
