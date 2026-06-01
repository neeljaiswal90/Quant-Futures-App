import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  parseForwardReturnLabelCliArgs,
  runForwardReturnLabelCli,
} from '../../../src/forward-return-labels/cli.js';

describe('RA-093b forward-return label CLI', () => {
  it('maps the root runnable command surface onto the RA-091 writer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra093b-label-cli-'));
    try {
      const datasetPath = join(dir, 'signals.jsonl');
      const tradeTapePath = join(dir, 'obs01.jsonl');
      const labelsPath = join(dir, 'labels.jsonl');
      const manifestPath = join(dir, 'labels.manifest.json');
      writeFileSync(datasetPath, `${signalLine({ source_obs01: tradeTapePath })}\n`, 'utf8');
      writeFileSync(tradeTapePath, `${tradeLine({ ts_ns: '1770000000000000100', price: 30351 })}\n`, 'utf8');

      const exitCode = runForwardReturnLabelCli([
        '--dataset', datasetPath,
        '--trade-tape', tradeTapePath,
        '--out', labelsPath,
        '--manifest', manifestPath,
        '--horizons', '1,5',
      ]);

      expect(exitCode).toBe(0);
      expect(existsSync(labelsPath)).toBe(true);
      expect(existsSync(manifestPath)).toBe(true);
      expect(readFileSync(labelsPath, 'utf8')).toContain('"label_schema_version":1');
      expect(readFileSync(manifestPath, 'utf8')).toContain('"generated_by":"ra091_forward_return_labels_v1"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects incomplete command lines before touching files', () => {
    expect(() => parseForwardReturnLabelCliArgs(['--dataset', 'signals.jsonl'])).toThrow(
      'missing required --out <labels.jsonl>',
    );
    expect(() => parseForwardReturnLabelCliArgs(['--dataset'])).toThrow(
      'missing value for --dataset',
    );
  });
});

function signalLine(input: {
  readonly ts_ns?: string;
  readonly price?: number;
  readonly source_obs01: string;
}): string {
  return [
    '{',
    '"schema_version":1,',
    `"ts_ns":${input.ts_ns ?? '1770000000000000000'},`,
    '"family":"sweep",',
    '"event_type":"sweep_detected",',
    '"tier":"HIGH",',
    `"price":${input.price ?? 30350.25},`,
    '"level_id":"W+2",',
    '"side":"long",',
    '"direction":"bullish",',
    '"zone_context":null,',
    '"regime":null,',
    '"orderflow_snapshot":null,',
    '"depth_snapshot":null,',
    '"confluence_stack_size":2,',
    '"payload":{},',
    '"replay":{',
    '"capture_date":"2026-05-29",',
    '"session":"rth",',
    '"step_ns":1770000000000000000,',
    `"source_obs01":${JSON.stringify(input.source_obs01)},`,
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
    `"size":${input.size ?? 1},`,
    `"aggressor_side":${JSON.stringify(input.aggressor_side ?? 'buy')}`,
    '}',
  ].join('');
}
