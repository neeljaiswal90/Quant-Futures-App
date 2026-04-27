import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const RTH_OPEN_TS_NS = 1_776_951_000_000_000_000n;
const ETH_TS_NS = 1_776_983_400_000_000_000n;
const MAINTENANCE_TS_NS = 1_776_979_800_000_000_000n;
const CLOSED_TS_NS = 1_777_132_800_000_000_000n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-data06a-'));
  tempDirectories.push(directory);
  return directory;
}

function tsNs(base: bigint, offsetSeconds = 0): string {
  return (base + BigInt(offsetSeconds) * 1_000_000_000n).toString();
}

function quoteRow(exchangeTsNs: string, recvTsNs?: string): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'L1_QUOTE',
    exchange_event_ts_ns: exchangeTsNs,
    sidecar_recv_ts_ns: recvTsNs ?? (BigInt(exchangeTsNs) + 1_000_000n).toString(),
    bid_px: 27526.25,
    ask_px: 27526.5,
    bid_sz: 4,
    ask_sz: 5,
  };
}

function tradeRow(exchangeTsNs: string): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'LAST_TRADE',
    exchange_event_ts_ns: exchangeTsNs,
    sidecar_recv_ts_ns: (BigInt(exchangeTsNs) + 2_000_000n).toString(),
    price: 27526.5,
    size: 1,
    aggressor: 'buy',
  };
}

function runSessionWarmup(rows: readonly Record<string, unknown>[]): {
  readonly reportText: string;
  readonly report: Record<string, unknown>;
} {
  const directory = makeTempDir();
  const inputPath = join(directory, 'probe.jsonl');
  const reportPath = join(directory, 'session-warmup.json');
  writeFileSync(inputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const result = spawnSync(
    PYTHON,
    [
      '-m',
      'services.market_data_sidecar.session_warmup_app',
      '--input',
      inputPath,
      '--report',
      reportPath,
      '--warmup-sec',
      '60',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(`DATA-06A session warmup failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  const reportText = readFileSync(reportPath, 'utf8');
  return {
    reportText,
    report: JSON.parse(reportText) as Record<string, unknown>,
  };
}

describe('DATA-06A L1/trade session clock and warmup suppression', () => {
  it('classifies RTH warmup and post-warmup eligibility deterministically', () => {
    const { report } = runSessionWarmup([
      quoteRow(tsNs(RTH_OPEN_TS_NS, 30)),
      tradeRow(tsNs(RTH_OPEN_TS_NS, 61)),
    ]);

    expect(report).toMatchObject({
      status: 'pass',
      verified_l1_trade_rows: 2,
      quote_rows: 1,
      trade_rows: 1,
      candidate_eligible_count: 1,
      warmup_suppressed_count: 1,
      blocked_count: 1,
      phase_counts: { rth: 2 },
      block_reason_counts: { warmup_suppression: 1 },
      partial_parity_status: 'L1_TRADE_ONLY_PASS',
      data01_full_gate_status: 'blocked',
      data01b_status: 'blocked_l2_l3_parity',
    });
  });

  it('classifies ETH, maintenance, and closed phases with stable block reasons', () => {
    const { report } = runSessionWarmup([
      quoteRow(tsNs(ETH_TS_NS)),
      quoteRow(tsNs(MAINTENANCE_TS_NS)),
      quoteRow(tsNs(CLOSED_TS_NS)),
    ]);

    expect(report).toMatchObject({
      candidate_eligible_count: 0,
      blocked_count: 3,
      phase_counts: {
        closed: 1,
        eth: 1,
        maintenance: 1,
      },
      block_reason_counts: {
        maintenance_halt: 1,
        outside_rth: 1,
        session_closed: 1,
      },
    });
  });

  it('reports session phase transitions only when the phase changes', () => {
    const { report } = runSessionWarmup([
      quoteRow(tsNs(RTH_OPEN_TS_NS, 61)),
      tradeRow(tsNs(RTH_OPEN_TS_NS, 62)),
      quoteRow(tsNs(ETH_TS_NS)),
      quoteRow(tsNs(ETH_TS_NS, 1)),
      quoteRow(tsNs(MAINTENANCE_TS_NS)),
    ]);
    const transitions = report.transitions as readonly Record<string, unknown>[];

    expect(report).toMatchObject({
      transition_count: 3,
      transitions_truncated: false,
    });
    expect(transitions.map((transition) => transition.phase)).toEqual(['rth', 'eth', 'maintenance']);
    expect(transitions.map((transition) => transition.previous_phase)).toEqual([null, 'rth', 'eth']);
  });

  it('does not use sidecar receive time as canonical session time', () => {
    const { report } = runSessionWarmup([
      quoteRow(tsNs(RTH_OPEN_TS_NS, 61), tsNs(ETH_TS_NS)),
    ]);

    expect(report).toMatchObject({
      candidate_eligible_count: 1,
      phase_counts: { rth: 1 },
      block_reason_counts: {},
    });
  });

  it('keeps missing timestamps and MBP10/MBO rows out of verified session classification', () => {
    const { report } = runSessionWarmup([
      {
        ...quoteRow(tsNs(RTH_OPEN_TS_NS, 61)),
        exchange_event_ts_ns: null,
      },
      {
        schema_version: 1,
        stream: 'MBP10',
        exchange_event_ts_ns: tsNs(RTH_OPEN_TS_NS, 62),
        sidecar_recv_ts_ns: tsNs(RTH_OPEN_TS_NS, 63),
        bids: [{ level: 0, px: 27526.25, sz: 10 }],
      },
      {
        schema_version: 1,
        stream: 'MBO',
        exchange_event_ts_ns: tsNs(RTH_OPEN_TS_NS, 64),
        sidecar_recv_ts_ns: tsNs(RTH_OPEN_TS_NS, 65),
        action: 'new',
      },
    ]);

    expect(report).toMatchObject({
      verified_l1_trade_rows: 0,
      skipped_mbp10_rows: 1,
      skipped_mbo_rows: 1,
      skipped_null_exchange_ts_rows: 1,
      diagnostic_count: 3,
      diagnostic_counts: {
        'L1_QUOTE:missing_exchange_event_ts_ns': 1,
        'MBP10:blocked_l2_l3_stream': 1,
        'MBO:blocked_l2_l3_stream': 1,
      },
    });
  });

  it('has a stable report shape and byte-stable output across repeated runs', () => {
    const rows = [
      quoteRow(tsNs(RTH_OPEN_TS_NS, 30)),
      tradeRow(tsNs(RTH_OPEN_TS_NS, 61)),
      quoteRow(tsNs(ETH_TS_NS)),
    ];
    const first = runSessionWarmup(rows);
    const second = runSessionWarmup(rows);

    expect(first.reportText).toBe(second.reportText);
    expect(Object.keys(first.report)).toEqual([
      'block_reason_counts',
      'blocked_count',
      'candidate_eligible_count',
      'data01_full_gate_status',
      'data01b_status',
      'diagnostic_count',
      'diagnostic_counts',
      'diagnostics',
      'diagnostics_truncated',
      'first_exchange_event_ts_ns',
      'input_rows',
      'last_exchange_event_ts_ns',
      'partial_parity_status',
      'phase_counts',
      'quote_rows',
      'skipped_mbo_rows',
      'skipped_mbp10_rows',
      'skipped_null_exchange_ts_rows',
      'status',
      'trade_rows',
      'transition_count',
      'transitions',
      'transitions_truncated',
      'verified_l1_trade_rows',
      'warmup_seconds',
      'warmup_suppressed_count',
    ]);
  });

  it('does not introduce wall-clock, random, or L2/L3 feature paths', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../services/market_data_sidecar');
    const files = [
      'session/session_clock.py',
      'session_warmup.py',
      'session_warmup_app.py',
    ];
    const source = files.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

    expect(source).not.toContain('datetime.now');
    expect(source).not.toContain('datetime.utcnow');
    expect(source).not.toContain('time.time');
    expect(source).not.toContain('random');
    expect(source).not.toContain('mbp10_book_state');
    expect(source).not.toContain('advanced_mbo');
  });
});
