import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ACTIVE_STRATEGY_IDS } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { HeldOutValidationRealArchiveOptions } from '../../../src/held-out-validation/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

interface Qfa410bExecuteModule {
  readonly parseArgs: (argv: readonly string[]) => {
    readonly researchFixedContracts?: number;
  };
  readonly runQfa410bExecute: (
    args: ReturnType<Qfa410bExecuteModule['parseArgs']>,
    dependencies: {
      readonly archiveSessions?: readonly HeldOutValidationRealArchiveOptions['archive_sessions'][number][];
      readonly execute?: (options: HeldOutValidationRealArchiveOptions) => Promise<unknown>;
    },
  ) => Promise<unknown>;
}

describe('qfa-410b-execute CLI', () => {
  it('accepts research-fixed-contracts as a positive integer replay override', () => {
    const args = qfa410bExecute().parseArgs([
      '--run-id',
      'qfa-410b-fixed-contracts-test',
      '--research-fixed-contracts',
      '2',
    ]);

    expect(args.researchFixedContracts).toBe(2);
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'rejects invalid research-fixed-contracts value %s',
    (value) => {
      expect(() => qfa410bExecute().parseArgs([
        '--run-id',
        'qfa-410b-fixed-contracts-test',
        '--research-fixed-contracts',
        value,
      ])).toThrow('--research-fixed-contracts must be a positive integer');
    },
  );

  it('rejects research-fixed-contracts when the value is missing', () => {
    expect(() => qfa410bExecute().parseArgs([
      '--run-id',
      'qfa-410b-fixed-contracts-test',
      '--research-fixed-contracts',
    ])).toThrow('--research-fixed-contracts requires a positive integer value');
  });

  it('leaves replay fill policy unchanged when research-fixed-contracts is omitted', async () => {
    const { capturedOptions, outputDir } = await runWithCapturedExecute([]);

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.fill_policy).toBeUndefined();
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it('passes research-fixed-contracts into the real-archive replay fill policy', async () => {
    const { capturedOptions, outputDir } = await runWithCapturedExecute([
      '--research-fixed-contracts',
      '2',
    ]);

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.fill_policy).toEqual({ order_quantity: 2 });
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it('emits one artifact per active strategy and preserves partial-evidence discipline', () => {
    const root = mkdtempSync(join(tmpdir(), 'qfa-410b-cli-'));
    const outputDir = join(root, 'held-out');
    mkdirSync(outputDir, { recursive: true });
    const stdout = execFileSync(npxBin(), [
      'tsx',
      'scripts/qfa-410b-execute.mts',
      '--run-id',
      'qfa611-cycle1-test',
      '--manifests',
      fixtureManifest(root, 'feb', true),
      fixtureManifest(root, 'mar', false),
      fixtureManifest(root, 'apr', false),
      '--regime-labels',
      fixtureRegimeLabels(root),
      '--output-dir',
      outputDir,
      '--metadata-by-strategy',
      fixtureMetadata(root),
      '--walk-forward-policy',
      fixtureWalkForwardPolicy(root),
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    const summary = JSON.parse(stdout);

    expect(summary.strategy_ids).toEqual(ACTIVE_STRATEGY_IDS);
    expect(summary.artifact_paths).toHaveLength(ACTIVE_STRATEGY_IDS.length);
    for (const [index, strategyId] of ACTIVE_STRATEGY_IDS.entries()) {
      const artifact = JSON.parse(
        readFileSync(join(outputDir, `${strategyId}-feb-mar-apr-2026.json`), 'utf8'),
      );
      expect(artifact.strategy_id).toBe(strategyId);
      expect(artifact.parameter_lock_hash).toBe(`${index + 1}`.padStart(64, '0'));
      expect(artifact.gating_pnl_basis).toBe('net');
      expect(artifact.evidence_package_status).toBe('incomplete');
      expect(artifact.capability_status).toBe('blocked');
      expect(artifact.failure_reason).toContain('replay-ready capability status');
    }
  });
});

async function runWithCapturedExecute(extraArgs: readonly string[]): Promise<{
  readonly capturedOptions: readonly HeldOutValidationRealArchiveOptions[];
  readonly outputDir: string;
}> {
  const root = mkdtempSync(join(tmpdir(), 'qfa-410b-fixed-contracts-'));
  const outputDir = join(root, 'held-out');
  const capturedOptions: HeldOutValidationRealArchiveOptions[] = [];
  const qfa410b = qfa410bExecute();

  await qfa410b.runQfa410bExecute(qfa410b.parseArgs([
    '--run-id',
    'qfa-410b-fixed-contracts-test',
    '--strategy-ids',
    ACTIVE_STRATEGY_IDS[0]!,
    '--manifests',
    fixtureManifest(root, 'feb', false),
    fixtureManifest(root, 'mar', false),
    fixtureManifest(root, 'apr', false),
    '--regime-labels',
    fixtureRegimeLabels(root),
    '--output-dir',
    outputDir,
    '--metadata-by-strategy',
    fixtureMetadata(root),
    '--walk-forward-policy',
    fixtureWalkForwardPolicy(root),
    ...extraArgs,
  ]), {
    archiveSessions: [
      { session_id: '2026-02-02-rth', trading_date: '2026-02-02', raw_symbol: 'MNQH6' },
      { session_id: '2026-02-03-rth', trading_date: '2026-02-03', raw_symbol: 'MNQH6' },
      { session_id: '2026-02-04-rth', trading_date: '2026-02-04', raw_symbol: 'MNQH6' },
    ],
    execute: async (options) => {
      capturedOptions.push(options);
      return {
        artifact_paths: [],
        per_strategy_real_records: [{
          strategy_id: options.strategy_order[0]!,
          total_trades: 0,
          windows: [],
        }],
      } as never;
    },
  });

  return { capturedOptions, outputDir };
}

let cachedQfa410bExecute: Qfa410bExecuteModule | null = null;

beforeAll(async () => {
  cachedQfa410bExecute = await import(
    pathToFileURL(join(REPO_ROOT, 'scripts/qfa-410b-execute.mts')).href
  ) as Qfa410bExecuteModule;
});

function qfa410bExecute(): Qfa410bExecuteModule {
  if (cachedQfa410bExecute === null) {
    throw new Error('qfa-410b-execute module was not loaded');
  }
  return cachedQfa410bExecute;
}

function fixtureManifest(root: string, name: string, includeSessions: boolean): string {
  const path = join(root, `${name}.json`);
  writeFixtureJson(path, {
    sessions: includeSessions
      ? ['2026-02-02-rth', '2026-02-03-rth', '2026-02-04-rth'].map(manifestSession)
      : [],
  });
  return path;
}

function fixtureRegimeLabels(root: string): string {
  const path = join(root, 'regime-labels.json');
  writeFixtureJson(path, {
    sessions: [
      { session_id: '2026-02-02-rth', confirmed_label: 'high' },
      { session_id: '2026-02-03-rth', confirmed_label: 'mid' },
      { session_id: '2026-02-04-rth', confirmed_label: 'low' },
    ],
  });
  return path;
}

function fixtureMetadata(root: string): string {
  const path = join(root, 'metadata.json');
  writeFixtureJson(path, Object.fromEntries(ACTIVE_STRATEGY_IDS.map((strategyId, index) => [
    strategyId,
    {
      strategy_family: 'continuation',
      parameter_lock_source: 'test-fixture',
      parameter_lock_hash: `${index + 1}`.padStart(64, '0'),
      input_substrate_hash: 'b'.repeat(64),
      input_manifest_hashes: { feb: 'c'.repeat(64), mar: 'd'.repeat(64), apr: 'e'.repeat(64) },
    },
  ])));
  return path;
}

function fixtureWalkForwardPolicy(root: string): string {
  const path = join(root, 'walk-forward-policy.json');
  writeFixtureJson(path, {
    policy_version: 1,
    train_sessions: 1,
    validation_sessions: 0,
    test_sessions: 1,
    step_sessions: 1,
    min_required_sessions: 2,
  });
  return path;
}

function manifestSession(sessionId: string) {
  return {
    session_id: sessionId,
    status: 'complete',
    symbol: 'MNQH6',
    schemas: {
      trades: { status: 'available', path: `D:/archive/${sessionId}/trades.dbn.zst` },
      'mbp-1': { status: 'available', path: `D:/archive/${sessionId}/mbp-1.dbn.zst` },
    },
  };
}

function writeFixtureJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

function npxBin(): string {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}
