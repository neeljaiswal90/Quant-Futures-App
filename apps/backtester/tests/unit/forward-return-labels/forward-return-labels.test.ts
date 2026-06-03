import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  FORWARD_RETURN_STATUSES,
  buildForwardReturnLabelJsonl,
  labelReplaySignalRow,
  readReplayDatasetJsonl,
  readReplayTradeTapeJsonl,
  writeForwardReturnLabels,
  type ForwardReturnStatus,
} from '../../../src/index.js';

describe('RA-091 forward-return labels', () => {
  it('uses the first trade at-or-after signal time as entry and retains signal_price separately', () => {
    const row = readSingleSignal(signalLine({
      ts_ns: '1770000000000000100',
      price: 30350.25,
      direction: 'bullish',
    }));
    const trades = readTrades([
      tradeLine({ ts_ns: '1770000000000000000', price: 30349.75 }),
      tradeLine({ ts_ns: '1770000000000000200', price: 30350.5 }),
      tradeLine({ ts_ns: '1770000000500000000', price: 30352 }),
      tradeLine({ ts_ns: '1770000000900000000', price: 30349.5 }),
      tradeLine({ ts_ns: '1770000000990000000', price: 30351 }),
      tradeLine({ ts_ns: '1770000006100000000', price: 30351.25 }),
    ]);

    const labeled = labelReplaySignalRow(row, trades, { horizonsSeconds: [1], tickSize: 0.25 });
    const horizon = labeled.forward_returns[0]!;

    expect(labeled.candidate_seed.signal_price).toBe(30350.25);
    expect(horizon.status).toBe('ok');
    expect(horizon.entry_ts_ns).toBe('1770000000000000200');
    expect(horizon.entry_price).toBe(30350.5);
    expect(horizon.exit_price).toBe(30351);
    expect(horizon.realized_pts).toBe(0.5);
    expect(horizon.realized_ticks).toBe(2);
    expect(horizon.mfe_pts).toBe(1.5);
    expect(horizon.mfe_ticks).toBe(6);
    expect(horizon.mae_pts).toBe(-1);
    expect(horizon.mae_ticks).toBe(-4);
  });

  it('computes short-side realized, MFE, and MAE in both points and ticks', () => {
    const row = readSingleSignal(signalLine({
      ts_ns: '1770000010000000000',
      direction: 'bearish',
      side: 'ask-side',
    }));
    const trades = readTrades([
      tradeLine({ ts_ns: '1770000010000000000', price: 30360 }),
      tradeLine({ ts_ns: '1770000010200000000', price: 30357.5 }),
      tradeLine({ ts_ns: '1770000010900000000', price: 30361 }),
    ]);

    const horizon = labelReplaySignalRow(row, trades, { horizonsSeconds: [1], tickSize: 0.25 })
      .forward_returns[0]!;

    expect(horizon.status).toBe('tape_eof_before_horizon');
    expect(horizon.realized_pts).toBe(-1);
    expect(horizon.realized_ticks).toBe(-4);
    expect(horizon.mfe_pts).toBe(2.5);
    expect(horizon.mfe_ticks).toBe(10);
    expect(horizon.mae_pts).toBe(-1);
    expect(horizon.mae_ticks).toBe(-4);
  });

  it('emits exhaustive skip statuses for neutral direction, missing future trades, and empty horizons', () => {
    expect(FORWARD_RETURN_STATUSES).toEqual([
      'ok',
      'no_trades_in_horizon',
      'no_post_signal_trade',
      'neutral_direction',
      'tape_eof_before_horizon',
      'invalid_signal',
    ] satisfies readonly ForwardReturnStatus[]);

    const neutral = readSingleSignal(signalLine({ direction: 'mixed' }));
    const neutralLabel = labelReplaySignalRow(neutral, [
      { ts_ns: 1770000000000000000n, price: 30350, size: 1, aggressor_side: 'unknown' },
    ], { horizonsSeconds: [1], tickSize: 0.25 }).forward_returns[0]!;
    expect(neutralLabel.status).toBe('neutral_direction');

    const afterTape = readSingleSignal(signalLine({ ts_ns: '1770000009000000000' }));
    const noFutureLabel = labelReplaySignalRow(afterTape, [
      { ts_ns: 1770000000000000000n, price: 30350, size: 1, aggressor_side: 'unknown' },
    ], { horizonsSeconds: [1], tickSize: 0.25 }).forward_returns[0]!;
    expect(noFutureLabel.status).toBe('no_post_signal_trade');

    const flatTape = readSingleSignal(signalLine({ ts_ns: '1770000000000000000' }));
    const noHorizonTrades = labelReplaySignalRow(flatTape, [
      { ts_ns: 1770000000000000000n, price: 30350, size: 1, aggressor_side: 'unknown' },
      { ts_ns: 1770000002000000000n, price: 30350, size: 1, aggressor_side: 'unknown' },
    ], { horizonsSeconds: [1], tickSize: 0.25 }).forward_returns[0]!;
    expect(noHorizonTrades.status).toBe('no_trades_in_horizon');
  });

  it('writes byte-identical canonical JSONL for the same dataset and trade tape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra091-'));
    try {
      const datasetPath = join(dir, 'signals.jsonl');
      const tradeTapePath = join(dir, 'tape.jsonl');
      const firstOutput = join(dir, 'first.jsonl');
      const secondOutput = join(dir, 'second.jsonl');
      writeFileSync(datasetPath, [
        signalLine({ ts_ns: '1770000000000000000', direction: 'bullish', source_obs01: tradeTapePath }),
        signalLine({ ts_ns: '1770000000500000000', direction: 'bearish', side: 'ask-side', source_obs01: tradeTapePath }),
      ].join('\n') + '\n', 'utf8');
      writeFileSync(tradeTapePath, [
        tradeLine({ ts_ns: '1770000000000000100', price: 30350 }),
        tradeLine({ ts_ns: '1770000000500000100', price: 30351 }),
        tradeLine({ ts_ns: '1770000001500000000', price: 30352 }),
        tradeLine({ ts_ns: '1770000006500000000', price: 30349 }),
      ].join('\n') + '\n', 'utf8');

      const first = writeForwardReturnLabels({ datasetPath, outputJsonlPath: firstOutput });
      const second = writeForwardReturnLabels({ datasetPath, outputJsonlPath: secondOutput });

      // The writer used to expose result.jsonl with the full output. That field
      // was removed when the writer was switched to streaming to avoid the V8
      // >512MB string cap; the equivalent determinism assertion is now done
      // by comparing the on-disk files plus the manifest sha256.
      expect(readFileSync(firstOutput, 'utf8')).toBe(readFileSync(secondOutput, 'utf8'));
      expect(first.manifest.label_jsonl_sha256).toBe(second.manifest.label_jsonl_sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can build deterministic JSONL in memory for already-loaded inputs', () => {
    const rows = readRows([signalLine({ source_obs01: 'memory-tape' })]);
    const trades = readTrades([
      tradeLine({ ts_ns: '1770000000000000000', price: 30350 }),
      tradeLine({ ts_ns: '1770000005000000000', price: 30351 }),
    ]);

    expect(buildForwardReturnLabelJsonl(rows, trades, { horizonsSeconds: [1] })).toBe(
      buildForwardReturnLabelJsonl(rows, trades, { horizonsSeconds: [1] }),
    );
  });
});

function readSingleSignal(line: string) {
  return readRows([line])[0]!;
}

function readRows(lines: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ra091-rows-'));
  try {
    const path = join(dir, 'signals.jsonl');
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
    return readReplayDatasetJsonl(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readTrades(lines: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ra091-trades-'));
  try {
    const path = join(dir, 'trades.jsonl');
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
    return readReplayTradeTapeJsonl(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function signalLine(input: {
  readonly ts_ns?: string;
  readonly step_ns?: string;
  readonly price?: number | null;
  readonly source_obs01?: string;
  readonly direction?: string | null;
  readonly side?: string | null;
} = {}): string {
  return [
    '{',
    '"schema_version":1,',
    `"ts_ns":${input.ts_ns ?? '1770000000000000000'},`,
    '"family":"sweep",',
    '"event_type":"sweep_detected",',
    '"tier":"HIGH",',
    `"price":${input.price === undefined ? 30350.25 : input.price === null ? 'null' : input.price},`,
    '"level_id":"W+2",',
    `"side":${json(input.side ?? 'long')},`,
    `"direction":${json(input.direction ?? 'bullish')},`,
    '"zone_context":null,',
    '"regime":null,',
    '"orderflow_snapshot":null,',
    '"depth_snapshot":null,',
    '"confluence_stack_size":2,',
    '"payload":{},',
    '"replay":{',
    '"capture_date":"2026-05-29",',
    '"session":"rth",',
    `"step_ns":${input.step_ns ?? '1770000000000000000'},`,
    `"source_obs01":${json(input.source_obs01 ?? 'D:/captures/MNQ_rth.obs01.jsonl')},`,
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
    `"aggressor_side":${json(input.aggressor_side ?? 'buy')}`,
    '}',
  ].join('');
}

function json(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}
