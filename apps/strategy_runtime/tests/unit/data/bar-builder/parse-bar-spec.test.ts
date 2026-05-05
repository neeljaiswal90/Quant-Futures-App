import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import { parseBarSpec, timeBarSpecDurationNs } from '../../../../src/data/bar-builder/bar-spec.js';

/**
 * Module under test: src/data/bar-builder/bar-spec.ts
 * Ticket: QFA-104 Session 2a
 */

describe('QFA-104 parseBarSpec', () => {
  it('parses time bars using the existing run-spec grammar', () => {
    expect(parseBarSpec('1m')).toEqual({
      kind: 'time',
      count: 1,
      unit: 'm',
      raw: '1m',
      token: '1m',
    });
    expect(parseBarSpec('30s')).toEqual({
      kind: 'time',
      count: 30,
      unit: 's',
      raw: '30s',
      token: '30s',
    });
  });

  it('parses tick-derived bars using the existing run-spec grammar', () => {
    expect(parseBarSpec('tick:ticks:100')).toEqual({
      kind: 'tick',
      subkind: 'ticks',
      count: 100,
      raw: 'tick:ticks:100',
      token: 'tick100',
    });
  });

  it('derives time-bar durations as branded nanoseconds', () => {
    const parsed = parseBarSpec('5m');
    if (parsed.kind !== 'time') {
      throw new Error('expected time bar');
    }
    expect(timeBarSpecDurationNs(parsed)).toEqual(ns('300000000000'));
  });
});
