import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  stderr as processStderr,
  stdin as processStdin,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  formatJournalEventSchemaValidationErrors,
  journalEventFromJsonLine,
  stableJsonStringify,
  validateJournalEventEnvelope,
  type JournalEventEnvelope,
  type JsonValue,
  type RuntimeEventType,
} from '../contracts/index.js';

export const L1_TRADE_LATENCY_DASHBOARD_SCHEMA_VERSION = 1;
export const L1_TRADE_LATENCY_PARTIAL_PARITY_STATUS = 'L1_TRADE_ONLY_PASS';
export const L1_TRADE_LATENCY_DATA01_FULL_GATE_STATUS = 'BLOCKED';
export const L1_TRADE_LATENCY_DATA01B_STATUS = 'BLOCKED_L2_L3_PARITY';

export type L1TradeLatencyDashboardFormat = 'text' | 'json';
export type L1TradeLatencyDashboardStatus = 'pass' | 'warning' | 'fail';
export type L1TradeLatencyStream = 'QUOTE' | 'TRADE' | 'COMBINED';

export interface L1TradeLatencyDashboardOptions {
  readonly format: L1TradeLatencyDashboardFormat;
}

export interface L1TradeLatencyCliOptions extends L1TradeLatencyDashboardOptions {
  readonly journal_path?: string;
}

export interface L1TradeLatencyDiagnostic {
  readonly line_number: number;
  readonly message: string;
}

export interface L1TradeLatencyStats {
  readonly stream: L1TradeLatencyStream;
  readonly event_count: number;
  readonly latency_sample_count: number;
  readonly negative_latency_count: number;
  readonly min_latency_ms: number | null;
  readonly p50_latency_ms: number | null;
  readonly p95_latency_ms: number | null;
  readonly p99_latency_ms: number | null;
  readonly max_latency_ms: number | null;
}

export interface L1TradeLatencyDashboardReport {
  readonly schema_version: 1;
  readonly status: L1TradeLatencyDashboardStatus;
  readonly partial_parity_status: typeof L1_TRADE_LATENCY_PARTIAL_PARITY_STATUS;
  readonly data01_full_gate_status: typeof L1_TRADE_LATENCY_DATA01_FULL_GATE_STATUS;
  readonly data01b_status: typeof L1_TRADE_LATENCY_DATA01B_STATUS;
  readonly events_seen: number;
  readonly l1_trade_events_seen: number;
  readonly quote_events_seen: number;
  readonly trade_events_seen: number;
  readonly ignored_event_count: number;
  readonly invalid_event_count: number;
  readonly negative_latency_count: number;
  readonly streams_checked: readonly ['QUOTE', 'TRADE'];
  readonly latency: {
    readonly combined: L1TradeLatencyStats;
    readonly quote: L1TradeLatencyStats;
    readonly trade: L1TradeLatencyStats;
  };
  readonly diagnostics: readonly L1TradeLatencyDiagnostic[];
  readonly notes: readonly string[];
}

export interface RenderL1TradeLatencyDashboardResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly report: L1TradeLatencyDashboardReport;
  readonly diagnostics: readonly L1TradeLatencyDiagnostic[];
  readonly exit_code: 0 | 1;
}

interface LatencyAccumulator {
  readonly stream: L1TradeLatencyStream;
  readonly samples_ms: number[];
  event_count: number;
}

export const DEFAULT_L1_TRADE_LATENCY_DASHBOARD_OPTIONS: L1TradeLatencyDashboardOptions = {
  format: 'text',
};

export function parseL1TradeLatencyDashboardArgs(
  args: readonly string[],
): L1TradeLatencyCliOptions {
  const options: {
    format: L1TradeLatencyDashboardFormat;
    journal_path?: string;
  } = {
    format: 'text',
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
      case '--format': {
        const format = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        if (format !== 'text' && format !== 'json') {
          throw new Error(`Unsupported L1/trade latency dashboard format: ${format}`);
        }
        options.format = format;
        break;
      }
      case '--help':
      case '-h':
        throw new L1TradeLatencyDashboardHelpRequested();
      default:
        throw new Error(`Unknown L1/trade latency dashboard argument: ${arg}`);
    }
  }

  return options;
}

export function renderL1TradeLatencyDashboardJsonl(
  input: string,
  options: L1TradeLatencyDashboardOptions = DEFAULT_L1_TRADE_LATENCY_DASHBOARD_OPTIONS,
): RenderL1TradeLatencyDashboardResult {
  const report = buildL1TradeLatencyDashboardReport(input);
  const stdout =
    options.format === 'json'
      ? `${stableJsonStringify(report as unknown as JsonValue)}\n`
      : renderL1TradeLatencyDashboard(report);
  const stderr = report.diagnostics
    .map((diagnostic) => `line ${diagnostic.line_number}: ${diagnostic.message}`)
    .join('\n');

  return {
    stdout,
    stderr: stderr === '' ? '' : `${stderr}\n`,
    report,
    diagnostics: report.diagnostics,
    exit_code: report.diagnostics.length === 0 ? 0 : 1,
  };
}

export function buildL1TradeLatencyDashboardReport(
  input: string,
): L1TradeLatencyDashboardReport {
  const quote: LatencyAccumulator = { stream: 'QUOTE', event_count: 0, samples_ms: [] };
  const trade: LatencyAccumulator = { stream: 'TRADE', event_count: 0, samples_ms: [] };
  const combined: LatencyAccumulator = { stream: 'COMBINED', event_count: 0, samples_ms: [] };
  const diagnostics: L1TradeLatencyDiagnostic[] = [];
  let eventsSeen = 0;
  let ignoredEventCount = 0;

  const lines = input.split(/\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = stripTrailingCarriageReturn(lines[index]!);
    if (rawLine.trim() === '') {
      continue;
    }

    const lineNumber = index + 1;
    let event: JournalEventEnvelope;
    try {
      event = journalEventFromJsonLine(rawLine);
    } catch (error) {
      diagnostics.push({
        line_number: lineNumber,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const validation = validateJournalEventEnvelope(event);
    if (!validation.ok) {
      diagnostics.push({
        line_number: lineNumber,
        message: formatJournalEventSchemaValidationErrors(validation.issues),
      });
      continue;
    }

    eventsSeen += 1;
    if (event.type !== 'QUOTE' && event.type !== 'TRADE') {
      ignoredEventCount += 1;
      continue;
    }

    const stream = event.type === 'QUOTE' ? quote : trade;
    addLatencySample(stream, event);
    addLatencySample(combined, event);
  }

  const quoteStats = summarizeAccumulator(quote);
  const tradeStats = summarizeAccumulator(trade);
  const combinedStats = summarizeAccumulator(combined);
  const negativeLatencyCount =
    quoteStats.negative_latency_count + tradeStats.negative_latency_count;
  const status = dashboardStatus(diagnostics.length, negativeLatencyCount);

  return {
    schema_version: L1_TRADE_LATENCY_DASHBOARD_SCHEMA_VERSION,
    status,
    partial_parity_status: L1_TRADE_LATENCY_PARTIAL_PARITY_STATUS,
    data01_full_gate_status: L1_TRADE_LATENCY_DATA01_FULL_GATE_STATUS,
    data01b_status: L1_TRADE_LATENCY_DATA01B_STATUS,
    events_seen: eventsSeen,
    l1_trade_events_seen: quote.event_count + trade.event_count,
    quote_events_seen: quote.event_count,
    trade_events_seen: trade.event_count,
    ignored_event_count: ignoredEventCount,
    invalid_event_count: diagnostics.length,
    negative_latency_count: negativeLatencyCount,
    streams_checked: ['QUOTE', 'TRADE'],
    latency: {
      combined: combinedStats,
      quote: quoteStats,
      trade: tradeStats,
    },
    diagnostics,
    notes: [
      'sidecar_recv_ts_ns is telemetry only; exchange_event_ts_ns remains canonical event time.',
      'This L1/trade dashboard does not verify MBP10/MBO and does not unblock full DATA-01.',
    ],
  };
}

export function renderL1TradeLatencyDashboard(report: L1TradeLatencyDashboardReport): string {
  const lines: string[] = [];
  lines.push('Quant Futures L1/Trade Latency Dashboard');
  lines.push(
    [
      'mode=read_only',
      'source=OBS-01_journal',
      `status=${report.status}`,
      `partial=${report.partial_parity_status}`,
      `data01=${report.data01_full_gate_status}`,
      `data01b=${report.data01b_status}`,
    ].join(' '),
  );
  lines.push('canonical_time=exchange_event_ts_ns telemetry_time=sidecar_recv_ts_ns');
  lines.push(
    [
      `events_seen=${report.events_seen}`,
      `l1_trade_events=${report.l1_trade_events_seen}`,
      `quotes=${report.quote_events_seen}`,
      `trades=${report.trade_events_seen}`,
      `ignored_non_l1=${report.ignored_event_count}`,
      `invalid=${report.invalid_event_count}`,
    ].join(' '),
  );
  lines.push('');
  lines.push(renderStats(report.latency.combined));
  lines.push(renderStats(report.latency.quote));
  lines.push(renderStats(report.latency.trade));
  lines.push('');
  lines.push('guardrail=DATA-01B remains blocked pending MBP10/MBO parity');

  if (report.diagnostics.length > 0) {
    lines.push('');
    lines.push('Diagnostics');
    for (const diagnostic of report.diagnostics) {
      lines.push(`line ${diagnostic.line_number}: ${diagnostic.message}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function l1TradeLatencyDashboardUsage(): string {
  return [
    'Usage: obs:04:l1-latency [--journal path] [--format text|json]',
    '',
    'Renders deterministic L1/trade receive-latency telemetry from OBS-01 JSONL.',
    'If --journal is omitted, JSONL is read from stdin.',
    'This is an offline L1/trade-only dashboard and does not unblock full DATA-01.',
  ].join('\n');
}

function addLatencySample(accumulator: LatencyAccumulator, event: JournalEventEnvelope): void {
  accumulator.event_count += 1;
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return;
  }
  const record = payload as Record<string, unknown>;
  const exchangeTs = record.exchange_event_ts_ns;
  const recvTs = record.sidecar_recv_ts_ns;
  if (typeof exchangeTs !== 'bigint' || typeof recvTs !== 'bigint') {
    return;
  }

  const deltaNs = recvTs - exchangeTs;
  accumulator.samples_ms.push(Number(deltaNs) / 1_000_000);
}

function summarizeAccumulator(accumulator: LatencyAccumulator): L1TradeLatencyStats {
  const sorted = [...accumulator.samples_ms].sort((left, right) => left - right);
  return {
    stream: accumulator.stream,
    event_count: accumulator.event_count,
    latency_sample_count: sorted.length,
    negative_latency_count: sorted.filter((value) => value < 0).length,
    min_latency_ms: sorted.length === 0 ? null : roundMs(sorted[0]!),
    p50_latency_ms: percentile(sorted, 50),
    p95_latency_ms: percentile(sorted, 95),
    p99_latency_ms: percentile(sorted, 99),
    max_latency_ms: sorted.length === 0 ? null : roundMs(sorted[sorted.length - 1]!),
  };
}

function percentile(sortedAscending: readonly number[], percentileValue: number): number | null {
  if (sortedAscending.length === 0) {
    return null;
  }
  const index = Math.max(
    0,
    Math.min(sortedAscending.length - 1, Math.ceil((percentileValue / 100) * sortedAscending.length) - 1),
  );
  return roundMs(sortedAscending[index]!);
}

function roundMs(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function dashboardStatus(
  invalidEventCount: number,
  negativeLatencyCount: number,
): L1TradeLatencyDashboardStatus {
  if (invalidEventCount > 0) {
    return 'fail';
  }
  if (negativeLatencyCount > 0) {
    return 'warning';
  }
  return 'pass';
}

function renderStats(stats: L1TradeLatencyStats): string {
  return [
    `[${stats.stream}]`,
    `events=${stats.event_count}`,
    `samples=${stats.latency_sample_count}`,
    `min_ms=${formatNullableNumber(stats.min_latency_ms)}`,
    `p50_ms=${formatNullableNumber(stats.p50_latency_ms)}`,
    `p95_ms=${formatNullableNumber(stats.p95_latency_ms)}`,
    `p99_ms=${formatNullableNumber(stats.p99_latency_ms)}`,
    `max_ms=${formatNullableNumber(stats.max_latency_ms)}`,
    `negative=${stats.negative_latency_count}`,
  ].join(' ');
}

function formatNullableNumber(value: number | null): string {
  return value === null ? '--' : String(value);
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of processStdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function inputForCli(options: L1TradeLatencyCliOptions): Promise<string> {
  if (options.journal_path !== undefined) {
    return readFileSync(resolve(options.journal_path), 'utf8');
  }
  return readStdin();
}

class L1TradeLatencyDashboardHelpRequested extends Error {
  constructor() {
    super('L1/trade latency dashboard help requested');
  }
}

async function main(): Promise<void> {
  let options: L1TradeLatencyCliOptions;
  try {
    options = parseL1TradeLatencyDashboardArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof L1TradeLatencyDashboardHelpRequested) {
      processStdout.write(`${l1TradeLatencyDashboardUsage()}\n`);
      return;
    }
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const input = await inputForCli(options);
    const result = renderL1TradeLatencyDashboardJsonl(input, options);
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
