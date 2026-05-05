import type { UnixNs } from '../../contracts/time.js';
import { ns } from '../../contracts/time.js';
import { deriveBarToken } from '../../contracts/run-id.js';

const TIME_BAR_RE = /^([1-9][0-9]*)(s|m|h|d)$/u;
const TICK_BAR_RE = /^tick:(ticks|volume|dollar):([1-9][0-9]*)$/u;

export interface TimeBarSpec {
  readonly kind: 'time';
  readonly count: number;
  readonly unit: 's' | 'm' | 'h' | 'd';
  readonly raw: string;
  readonly token: string;
}

export interface TickBarSpec {
  readonly kind: 'tick';
  readonly subkind: 'ticks' | 'volume' | 'dollar';
  readonly count: number;
  readonly raw: string;
  readonly token: string;
}

export type ParsedBarSpec = TimeBarSpec | TickBarSpec;

export function parseBarSpec(barSpec: string): ParsedBarSpec {
  const timeMatch = TIME_BAR_RE.exec(barSpec);
  if (timeMatch !== null) {
    return {
      kind: 'time',
      count: Number(timeMatch[1]),
      unit: timeMatch[2] as TimeBarSpec['unit'],
      raw: barSpec,
      token: deriveBarToken(barSpec),
    };
  }

  const tickMatch = TICK_BAR_RE.exec(barSpec);
  if (tickMatch !== null) {
    return {
      kind: 'tick',
      subkind: tickMatch[1] as TickBarSpec['subkind'],
      count: Number(tickMatch[2]),
      raw: barSpec,
      token: deriveBarToken(barSpec),
    };
  }

  throw new Error(
    `Invalid bar_spec: ${barSpec}; expected time-bar (e.g., 1m, 5m, 1h) or tick-bar (tick:ticks:N, tick:volume:N, tick:dollar:N)`,
  );
}

export function isTimeBarSpec(barSpec: ParsedBarSpec): barSpec is TimeBarSpec {
  return barSpec.kind === 'time';
}

export function timeBarSpecDurationNs(barSpec: TimeBarSpec): UnixNs {
  const unitNs =
    barSpec.unit === 's'
      ? 1_000_000_000n
      : barSpec.unit === 'm'
        ? 60_000_000_000n
        : barSpec.unit === 'h'
          ? 3_600_000_000_000n
          : 86_400_000_000_000n;
  return ns(BigInt(barSpec.count) * unitNs);
}
