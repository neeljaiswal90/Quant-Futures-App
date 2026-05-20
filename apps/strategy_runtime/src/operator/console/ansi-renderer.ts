import type { ValidatorIssueSeverity } from '../../contracts/events/payloads.js';
import type { SloWindowState } from '../../observability/burn-rate-evaluator.js';

export const ANSI_RESET = '\u001b[0m';
export const ANSI_BOLD = '\u001b[1m';
export const ANSI_DIM = '\u001b[2m';
export const ANSI_GREEN = '\u001b[32m';
export const ANSI_YELLOW = '\u001b[33m';
export const ANSI_RED = '\u001b[31m';
export const ANSI_MAGENTA = '\u001b[35m';
export const ANSI_CYAN = '\u001b[36m';

export type OperatorPanelTone = 'neutral' | 'pass' | 'warn' | 'breach' | 'fatal' | 'dim';

export function ansiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NO_COLOR === undefined && env.FORCE_COLOR !== '0';
}

export function colorize(value: string, code: string): string {
  if (!ansiEnabled()) {
    return value;
  }
  return `${code}${value}${ANSI_RESET}`;
}

export function bold(value: string): string {
  return colorize(value, ANSI_BOLD);
}

export function dim(value: string): string {
  return colorize(value, ANSI_DIM);
}

export function tone(value: string, panelTone: OperatorPanelTone): string {
  switch (panelTone) {
    case 'pass':
      return colorize(value, ANSI_GREEN);
    case 'warn':
      return colorize(value, ANSI_YELLOW);
    case 'breach':
      return colorize(value, ANSI_RED);
    case 'fatal':
      return colorize(value, ANSI_MAGENTA);
    case 'dim':
      return dim(value);
    case 'neutral':
      return value;
    default:
      return value;
  }
}

export function toneForSloState(state: SloWindowState | 'unknown'): OperatorPanelTone {
  switch (state) {
    case 'pass':
      return 'pass';
    case 'breach':
      return 'breach';
    case 'insufficient_data':
      return 'warn';
    case 'unknown':
      return 'dim';
    default:
      return 'neutral';
  }
}

export function toneForSeverity(severity: ValidatorIssueSeverity): OperatorPanelTone {
  switch (severity) {
    case 'info':
      return 'dim';
    case 'warning':
      return 'warn';
    case 'error':
      return 'breach';
    case 'fatal':
      return 'fatal';
    default:
      return 'neutral';
  }
}

export function renderPanel(title: string, lines: readonly string[]): string {
  return [bold(`[${title}]`), ...lines.map((line) => `  ${line}`)].join('\n');
}

export function formatBoolean(value: boolean | undefined): string {
  if (value === undefined) {
    return '--';
  }
  return value ? 'true' : 'false';
}

export function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

export function formatMsUpperBound(value: number | undefined): string {
  if (value === undefined) {
    return '--';
  }
  return `<=${formatNumber(value)}`;
}

export function formatNs(value: bigint | string | number | undefined): string {
  if (value === undefined) {
    return '--';
  }
  return String(value);
}

export function formatDurationMs(ms: number): string {
  const safeMs = Math.max(0, Math.trunc(ms));
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function shortHash(maskHash: string | undefined): string {
  if (maskHash === undefined || maskHash.trim() === '') {
    return '--';
  }
  const digest = maskHash.includes(':') ? maskHash.split(':').at(-1)! : maskHash;
  return digest.slice(0, 8);
}

export function noneIfEmpty(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(',');
}