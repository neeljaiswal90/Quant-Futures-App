import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const START_TS_NS = 1_777_300_000_000_000_000n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-mbp10-l1-checkpoint-'));
  tempDirectories.push(directory);
  return directory;
}

describe('DATA-PARITY-04E disk-backed MBP10/L1 checkpoint audit', () => {
  it('passes when MBP10 top of book matches reconstructed side-specific L1 checkpoints', () => {
    const report = runAudit([
      l1Quote(0n, { bid_px: 100, bid_sz: 3 }),
      l1Quote(1_000_000n, { ask_px: 101, ask_sz: 4 }),
      mbp10Row(1_000_000n, {
        bids: [{ px: 100, sz: 3 }],
        asks: [{ px: 101, sz: 4 }],
      }),
      l1Quote(2_000_000n, { bid_px: 100.25, bid_sz: 5 }),
      mbp10Row(2_000_000n, {
        bids: [{ px: 100.25, sz: 5 }],
      }),
    ]);

    expect(report).toMatchObject({
      schema_version: 1,
      ticket_id: 'DATA-PARITY-04E',
      status: 'analysis_only',
      data01_status: 'blocked',
      data01b_eligible: false,
      mbp10_extraction_trusted: true,
      classification: 'state_stream_incremental_valid',
      l1_checkpoint_count: 2,
      probe_parsing: {
        l1_quote_rows: 3,
        l1_quote_reconstructed_checkpoint_count: 2,
        l1_quote_warming_rows: 1,
      },
      parity: {
        compared_checkpoint_count: 2,
        within_1_tick_pct: 100,
      },
    });
  });

  it('fails when reconstructed MBP10 disagrees with reconstructed L1 checkpoints', () => {
    const report = runAudit([
      l1Quote(0n, { bid_px: 100, ask_px: 101, bid_sz: 3, ask_sz: 4 }),
      mbp10Row(0n, {
        bids: [{ px: 90, sz: 3 }],
        asks: [{ px: 110, sz: 4 }],
      }),
    ]);

    expect(report).toMatchObject({
      status: 'fail',
      mbp10_extraction_trusted: false,
      classification: 'extraction_bug_suspected',
      parity: {
        compared_checkpoint_count: 1,
        within_1_tick_pct: 0,
        mismatch_count: 2,
      },
    });
  });

  it('keeps the implementation free of deterministic runtime hazards', () => {
    const source = readFileSync('scripts/infra/audit_mbp10_l1_checkpoints.py', 'utf8');

    expect(source).not.toContain('datetime.now');
    expect(source).not.toContain('datetime.utcnow');
    expect(source).not.toContain('time.time');
    expect(source).not.toContain('random');
  });
});

function runAudit(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  const directory = makeTempDir();
  const probePath = join(directory, 'probe.jsonl');
  const reportPath = join(directory, 'report.json');
  writeFileSync(probePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const result = spawnSync(
    PYTHON,
    [
      'scripts/infra/audit_mbp10_l1_checkpoints.py',
      '--probe',
      probePath,
      '--out',
      reportPath,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`checkpoint audit failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  return JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
}

function l1Quote(offsetNs: bigint, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'L1_QUOTE',
    exchange_event_ts_ns: (START_TS_NS + offsetNs).toString(),
    sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
    ...overrides,
  };
}

function mbp10Row(offsetNs: bigint, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'MBP10',
    exchange_event_ts_ns: (START_TS_NS + offsetNs).toString(),
    sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
    ...overrides,
  };
}
