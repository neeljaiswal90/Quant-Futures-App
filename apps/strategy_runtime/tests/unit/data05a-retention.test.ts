import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-data05a-'));
  tempDirectories.push(directory);
  return directory;
}

function writeL1TradeJournal(directory: string, sessionId: string, eventType: 'QUOTE' | 'TRADE' = 'QUOTE'): string {
  const path = join(directory, `${sessionId}.jsonl`);
  const row = {
    schema_version: 1,
    event_id: `${eventType.toLowerCase()}-${sessionId}-000000000001`,
    type: eventType,
    ts_ns: '1776952861000000000',
    run_id: 'run-data05a-test',
    session_id: sessionId,
    payload: {
      exchange_event_ts_ns: '1776952861000000000',
      sidecar_recv_ts_ns: '1776952861001000000',
    },
  };
  writeFileSync(path, `${JSON.stringify(row)}\n`, 'utf8');
  return path;
}

function writeNonL1Journal(directory: string, sessionId: string): string {
  const path = join(directory, `${sessionId}-candidate.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      schema_version: 1,
      event_id: `candidate-${sessionId}`,
      type: 'CANDIDATE',
      session_id: sessionId,
      payload: {},
    })}\n`,
    'utf8',
  );
  return path;
}

function runRetention(options: {
  readonly journalDir: string;
  readonly archiveDir: string;
  readonly referenceSessionId?: string;
  readonly apply?: boolean;
  readonly diskTotalBytes?: number;
  readonly diskFreeBytes?: number;
}): {
  readonly reportText: string;
  readonly report: Record<string, unknown>;
} {
  const reportPath = join(options.journalDir, 'retention-report.json');
  const args = [
    '-m',
    'services.market_data_sidecar.retention_app',
    '--journal-dir',
    options.journalDir,
    '--archive-dir',
    options.archiveDir,
    '--reference-session-id',
    options.referenceSessionId ?? '2026-04-24-rth',
    '--report',
    reportPath,
  ];
  if (options.apply === true) {
    args.push('--apply');
  }
  if (options.diskTotalBytes !== undefined) {
    args.push('--disk-total-bytes', String(options.diskTotalBytes));
  }
  if (options.diskFreeBytes !== undefined) {
    args.push('--disk-free-bytes', String(options.diskFreeBytes));
  }
  const result = spawnSync(PYTHON, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`DATA-05A retention failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  const reportText = readFileSync(reportPath, 'utf8');
  return {
    reportText,
    report: JSON.parse(reportText) as Record<string, unknown>,
  };
}

describe('DATA-05A L1/trade journal retention', () => {
  it('plans to keep current and prior RTH raw journals while compressing older raw journals', () => {
    const root = makeTempDir();
    const archiveDir = join(root, 'archive');
    writeL1TradeJournal(root, '2026-04-22-rth');
    writeL1TradeJournal(root, '2026-04-23-rth');
    writeL1TradeJournal(root, '2026-04-24-rth');

    const { report } = runRetention({ journalDir: root, archiveDir });

    expect(report).toMatchObject({
      status: 'pass',
      mode: 'plan',
      reference_session_id: '2026-04-24-rth',
      retained_raw_sessions: ['2026-04-23-rth', '2026-04-24-rth'],
      raw_journal_count: 3,
      keep_raw_count: 2,
      compress_raw_count: 1,
      delete_compressed_count: 0,
      partial_parity_status: 'L1_TRADE_ONLY_PASS',
      data01_full_gate_status: 'blocked',
      data01b_status: 'blocked_l2_l3_parity',
    });
    expect(report.actions).toEqual([
      {
        action: 'compress_raw',
        path: `${root.replaceAll('\\', '/')}/2026-04-22-rth.jsonl`,
        reason: 'raw_retention_exceeded',
        session_id: '2026-04-22-rth',
        target_path: `${archiveDir.replaceAll('\\', '/')}/2026-04-22-rth.l1-trade.jsonl.gz`,
      },
      {
        action: 'keep_raw',
        path: `${root.replaceAll('\\', '/')}/2026-04-23-rth.jsonl`,
        reason: 'current_or_prior_rth_session',
        session_id: '2026-04-23-rth',
        target_path: null,
      },
      {
        action: 'keep_raw',
        path: `${root.replaceAll('\\', '/')}/2026-04-24-rth.jsonl`,
        reason: 'current_or_prior_rth_session',
        session_id: '2026-04-24-rth',
        target_path: null,
      },
    ]);
    expect(existsSync(join(root, '2026-04-22-rth.jsonl'))).toBe(true);
  });

  it('applies deterministic compression and raw deletion only when requested', () => {
    const root = makeTempDir();
    const archiveDir = join(root, 'archive');
    const oldRawPath = writeL1TradeJournal(root, '2026-04-22-rth', 'TRADE');
    writeL1TradeJournal(root, '2026-04-23-rth');
    writeL1TradeJournal(root, '2026-04-24-rth');
    const rawContents = readFileSync(oldRawPath, 'utf8');

    const { report } = runRetention({ journalDir: root, archiveDir, apply: true });
    const archivePath = join(archiveDir, '2026-04-22-rth.l1-trade.jsonl.gz');

    expect(report).toMatchObject({
      mode: 'apply',
      compress_raw_count: 1,
      keep_raw_count: 2,
    });
    expect(existsSync(oldRawPath)).toBe(false);
    expect(gunzipSync(readFileSync(archivePath)).toString('utf8')).toBe(rawContents);
  });

  it('plans and applies compressed archive expiry using the caller reference session', () => {
    const root = makeTempDir();
    const archiveDir = join(root, 'archive');
    writeL1TradeJournal(root, '2026-04-24-rth');
    writeL1TradeJournal(root, '2026-04-23-rth');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, '2026-04-01-rth.l1-trade.jsonl.gz'), 'expired', { encoding: 'utf8', flag: 'w' });

    const { report } = runRetention({ journalDir: root, archiveDir, apply: true });

    expect(report).toMatchObject({
      delete_compressed_count: 1,
      compressed_journal_count: 1,
    });
    expect(existsSync(join(archiveDir, '2026-04-01-rth.l1-trade.jsonl.gz'))).toBe(false);
  });

  it('warns at 70 percent disk use without fail-closing writes', () => {
    const root = makeTempDir();
    const archiveDir = join(root, 'archive');
    writeL1TradeJournal(root, '2026-04-24-rth');

    const { report } = runRetention({
      journalDir: root,
      archiveDir,
      diskTotalBytes: 1000,
      diskFreeBytes: 250,
    });

    expect(report).toMatchObject({
      status: 'warning',
      disk_pressure: {
        checked: true,
        total_bytes: 1000,
        free_bytes: 250,
        used_pct: 75,
        severity: 'warning',
        reason: 'disk_used_pct_at_or_above_warning_threshold',
        data_writes_allowed: true,
      },
    });
  });

  it('fails closed at 85 percent disk use', () => {
    const root = makeTempDir();
    const archiveDir = join(root, 'archive');
    writeL1TradeJournal(root, '2026-04-24-rth');

    const { report } = runRetention({
      journalDir: root,
      archiveDir,
      diskTotalBytes: 1000,
      diskFreeBytes: 100,
    });

    expect(report).toMatchObject({
      status: 'fail',
      disk_pressure: {
        checked: true,
        used_pct: 90,
        severity: 'fail',
        reason: 'disk_used_pct_at_or_above_fail_threshold',
        data_writes_allowed: false,
      },
      data01_full_gate_status: 'blocked',
      data01b_status: 'blocked_l2_l3_parity',
    });
  });

  it('skips mixed or non-L1 journals with diagnostics instead of rotating them', () => {
    const root = makeTempDir();
    const archiveDir = join(root, 'archive');
    writeNonL1Journal(root, '2026-04-22-rth');
    writeL1TradeJournal(root, '2026-04-24-rth');

    const { report } = runRetention({ journalDir: root, archiveDir });

    expect(report).toMatchObject({
      status: 'warning',
      raw_journal_count: 1,
      compress_raw_count: 0,
      keep_raw_count: 1,
      diagnostics: [
        {
          path: `${root.replaceAll('\\', '/')}/2026-04-22-rth-candidate.jsonl`,
          reason: 'non_l1_trade_event_type:CANDIDATE',
        },
      ],
    });
  });

  it('has a stable report shape and byte-stable plan output across repeated runs', () => {
    const firstRoot = makeTempDir();
    const secondRoot = makeTempDir();
    for (const root of [firstRoot, secondRoot]) {
      writeL1TradeJournal(root, '2026-04-22-rth');
      writeL1TradeJournal(root, '2026-04-23-rth');
      writeL1TradeJournal(root, '2026-04-24-rth');
    }

    const first = runRetention({ journalDir: firstRoot, archiveDir: join(firstRoot, 'archive') });
    const second = runRetention({ journalDir: secondRoot, archiveDir: join(secondRoot, 'archive') });

    const normalizePaths = (text: string, root: string) => text.replaceAll(root.replaceAll('\\', '/'), '<root>');
    expect(normalizePaths(first.reportText, firstRoot)).toBe(normalizePaths(second.reportText, secondRoot));
    expect(Object.keys(first.report)).toEqual([
      'actions',
      'compress_raw_count',
      'compressed_journal_count',
      'data01_full_gate_status',
      'data01b_status',
      'delete_compressed_count',
      'diagnostics',
      'disk_pressure',
      'keep_raw_count',
      'mode',
      'partial_parity_status',
      'policy',
      'raw_journal_count',
      'reference_session_id',
      'retained_raw_sessions',
      'skip_count',
      'status',
    ]);
  });

  it('does not introduce wall-clock, random, or L2/L3 feature paths', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../services/market_data_sidecar');
    const source = ['retention.py', 'retention_app.py']
      .map((file) => readFileSync(join(root, file), 'utf8'))
      .join('\n');

    expect(source).not.toContain('datetime.now');
    expect(source).not.toContain('datetime.utcnow');
    expect(source).not.toContain('time.time');
    expect(source).not.toContain('random');
    expect(source).not.toContain('mbp10_book_state');
    expect(source).not.toContain('advanced_mbo');
  });
});
