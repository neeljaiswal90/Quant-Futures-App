import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  loadReplayDatasetInput,
  normalizeSignalDirection,
  readReplayDatasetJsonl,
  resolveTradeTapePath,
  toReplaySignalCandidateSeed,
} from '../../../src/replay-dataset-input/index.js';

describe('RA-090b replay dataset input', () => {
  it('preserves nanosecond precision as bigint at the JSONL boundary', () => {
    const dir = makeTempDir();
    try {
      const datasetPath = join(dir, 'signals.jsonl');
      writeFileSync(datasetPath, `${signalLine({
        ts_ns: '1770000000000000123',
        step_ns: '1770000000000000456',
        source_obs01: 'D:/captures/MNQ_rth.obs01.jsonl',
      })}\n`, 'utf8');

      const rows = readReplayDatasetJsonl(datasetPath);

      expect(rows[0]!.ts_ns).toBe(1770000000000000123n);
      expect(rows[0]!.replay.step_ns).toBe(1770000000000000456n);
      expect(toReplaySignalCandidateSeed(rows[0]!).ts_ns).toBe(1770000000000000123n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loud when source_obs01 paths disagree and no override is provided', () => {
    const rows = readRows([
      signalLine({ source_obs01: 'D:/captures/a.obs01.jsonl' }),
      signalLine({ source_obs01: 'D:/captures/b.obs01.jsonl', ts_ns: '1770000000000000500' }),
    ]);

    expect(() => resolveTradeTapePath(rows)).toThrow(
      'conflicting source_obs01 paths: D:/captures/a.obs01.jsonl, D:/captures/b.obs01.jsonl',
    );
    expect(resolveTradeTapePath(rows, 'D:/override.obs01.jsonl')).toBe('D:/override.obs01.jsonl');
  });

  it('loads rows with an explicit trade tape and normalizes signal direction without fake setup families', () => {
    const dir = makeTempDir();
    try {
      const datasetPath = join(dir, 'signals.jsonl');
      const tradeTapePath = join(dir, 'tape.jsonl');
      writeFileSync(datasetPath, `${signalLine({ direction: 'bearish', side: 'ask-side' })}\n`, 'utf8');
      writeFileSync(tradeTapePath, `${tradeLine({ ts_ns: '1770000000000000999', price: 30350.25 })}\n`, 'utf8');

      const input = loadReplayDatasetInput({ datasetPath, tradeTapePath });
      const seed = toReplaySignalCandidateSeed(input.rows[0]!);

      expect(input.trade_tape_path).toBe(tradeTapePath);
      expect(seed.normalized_direction).toBe('short');
      expect(seed.family).toBe('sweep');
      expect(normalizeSignalDirection('mixed')).toBe('neutral');
      expect(normalizeSignalDirection(null, null)).toBe('unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function readRows(lines: readonly string[]) {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'signals.jsonl');
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
    return readReplayDatasetJsonl(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ra090b-'));
}

function signalLine(overrides: {
  readonly ts_ns?: string;
  readonly step_ns?: string;
  readonly source_obs01?: string;
  readonly direction?: string | null;
  readonly side?: string | null;
} = {}): string {
  return [
    '{',
    '"schema_version":1,',
    `"ts_ns":${overrides.ts_ns ?? '1770000000000000001'},`,
    '"family":"sweep",',
    '"event_type":"sweep_detected",',
    '"tier":"HIGH",',
    '"price":30350.25,',
    '"level_id":"W+2",',
    `"side":${json(overrides.side ?? 'long')},`,
    `"direction":${json(overrides.direction ?? 'bullish')},`,
    '"zone_context":null,',
    '"regime":null,',
    '"orderflow_snapshot":null,',
    '"depth_snapshot":null,',
    '"confluence_stack_size":2,',
    '"payload":{},',
    '"replay":{',
    '"capture_date":"2026-05-29",',
    '"session":"rth",',
    `"step_ns":${overrides.step_ns ?? '1770000000000000100'},`,
    `"source_obs01":${json(overrides.source_obs01 ?? 'D:/captures/MNQ_rth.obs01.jsonl')},`,
    '"source_mbo":null,',
    '"schema_version":1',
    '}',
    '}',
  ].join('');
}

function tradeLine(input: {
  readonly ts_ns: string;
  readonly price: number;
  readonly size?: number;
  readonly aggressor_side?: string;
}): string {
  return [
    '{',
    `"ts_ns":${input.ts_ns},`,
    '"type":"LAST_TRADE",',
    `"price":${input.price},`,
    `"size":${input.size ?? 3},`,
    `"aggressor_side":${json(input.aggressor_side ?? 'buy')}`,
    '}',
  ].join('');
}

function json(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}

