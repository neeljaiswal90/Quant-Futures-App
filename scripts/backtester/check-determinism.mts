import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeTradeLedger,
  buildTradeLedger,
  computeReproducibilityManifest,
  runBacktest,
  writeReproducibilityManifest,
  REPRO_ARTIFACT_ORDER,
  type BacktestRunnerOptions,
  type EquityMetricsOptions,
  type ReproArtifactName,
  type ReproducibilityManifest,
  type TradeLedgerInstrumentContext,
} from '../../apps/backtester/src/index.js';
import {
  journalEventFromJsonLine,
  type AnyJournalEventEnvelope,
} from '../../apps/strategy_runtime/src/contracts/index.js';

const OUTPUT_ROOT = resolve('.tmp', 'qfa-determinism-fixture');
const MANIFEST_PATH = resolve(OUTPUT_ROOT, 'manifest.json');
const DBN_FIXTURE = resolve('apps/strategy_runtime/tests/fixtures/dbn/trades-minimal.dbn');
const RUN_STARTED_AT_NS = '1767365700000000000';
const RUNNER_SHA = 'd'.repeat(40);

const INSTRUMENT_CONTEXT: TradeLedgerInstrumentContext = {
  instrument_id: 1,
  raw_symbol: 'MNQH6',
};

const EQUITY_OPTIONS: EquityMetricsOptions = {
  initial_equity_cents: 100_000n,
  valuation: {
    instrument_root: 'MNQ',
    tick_size: '0.25',
    tick_value_usd_cents: 50n,
  },
};

export interface DeterminismRunSummary {
  readonly label: 'A' | 'B';
  readonly run_id: string;
  readonly run_spec_hash: string;
  readonly final_chain_hash: string;
  readonly event_count: number;
  readonly journal_path: string;
  readonly manifest_path: string;
  readonly manifest: ReproducibilityManifest;
}

export interface DeterminismComparison {
  readonly equal: boolean;
  readonly left_final_chain_hash: string;
  readonly right_final_chain_hash: string;
  readonly differing_artifacts: readonly ReproArtifactName[];
}

export interface DeterminismCheckResult {
  readonly run_a: DeterminismRunSummary;
  readonly run_b: DeterminismRunSummary;
  readonly comparison: DeterminismComparison;
}

export interface DeterminismCheckOptions {
  readonly force_mismatch_for_test?: boolean;
}

export async function runDeterminismCheck(
  options: DeterminismCheckOptions = {},
): Promise<DeterminismCheckResult> {
  await prepareOutputRoot();
  await writeFixtureManifest(MANIFEST_PATH);

  const runA = await runFixture('A');
  const rawRunB = await runFixture('B');
  const runB = options.force_mismatch_for_test
    ? forceMismatchForTest(rawRunB)
    : rawRunB;
  const comparison = compareDeterminismManifests(runA.manifest, runB.manifest);

  return {
    run_a: runA,
    run_b: runB,
    comparison,
  };
}

export function compareDeterminismManifests(
  left: ReproducibilityManifest,
  right: ReproducibilityManifest,
): DeterminismComparison {
  const rightArtifacts = new Map(right.artifacts.map((artifact) => [artifact.name, artifact]));
  const differingArtifacts = REPRO_ARTIFACT_ORDER.filter((artifactName) => {
    const leftArtifact = left.artifacts.find((artifact) => artifact.name === artifactName);
    const rightArtifact = rightArtifacts.get(artifactName);
    return leftArtifact?.sha256 !== rightArtifact?.sha256;
  });

  return {
    equal: left.final_chain_hash === right.final_chain_hash,
    left_final_chain_hash: left.final_chain_hash,
    right_final_chain_hash: right.final_chain_hash,
    differing_artifacts: differingArtifacts,
  };
}

export function formatDeterminismMismatch(comparison: DeterminismComparison): string {
  const differing = comparison.differing_artifacts.length === 0
    ? 'none'
    : comparison.differing_artifacts.join(', ');
  return [
    'QFA determinism check failed: reproducibility hashes differ',
    `run A final_chain_hash: ${comparison.left_final_chain_hash}`,
    `run B final_chain_hash: ${comparison.right_final_chain_hash}`,
    `differing artifacts: ${differing}`,
  ].join('\n');
}

async function runFixture(label: 'A' | 'B'): Promise<DeterminismRunSummary> {
  const outputDir = resolve(OUTPUT_ROOT, `run-${label}`, 'out');
  const cacheRoot = resolve(OUTPUT_ROOT, `run-${label}`, 'cache');
  const result = await runBacktest(backtestOptions(outputDir, cacheRoot));
  const journalJsonl = await readFile(result.journal_path, 'utf8');
  const events = parseJournalEvents(journalJsonl);
  const tradeLedger = buildTradeLedger(events, {
    run_id: result.run_id,
    instrument_context: INSTRUMENT_CONTEXT,
  });
  const analysis = analyzeTradeLedger(tradeLedger, EQUITY_OPTIONS);
  const manifest = computeReproducibilityManifest({
    run_id: result.run_id,
    run_spec_hash: result.run_spec_hash,
    journal_jsonl: journalJsonl,
    trade_ledger: tradeLedger,
    trade_pnl: analysis.trade_pnl,
    equity_curve: analysis.equity_curve,
    metrics_summary: analysis.summary,
  });
  const manifestPath = resolve(OUTPUT_ROOT, `run-${label}`, 'repro-manifest.json');
  await writeReproducibilityManifest(manifestPath, manifest);

  return {
    label,
    run_id: result.run_id,
    run_spec_hash: result.run_spec_hash,
    final_chain_hash: manifest.final_chain_hash,
    event_count: result.event_count,
    journal_path: result.journal_path,
    manifest_path: manifestPath,
    manifest,
  };
}

function backtestOptions(outputDir: string, cacheRoot: string): BacktestRunnerOptions {
  return {
    corpus_manifest_path: MANIFEST_PATH,
    strategy_id: 'trend_pullback_long',
    bar_spec: '1m',
    backtest_window: {
      start: '2026-02-02T14:30:00Z',
      end: '2026-02-02T14:31:00Z',
      mode: 'instant',
      inclusive_end: false,
      calendar: 'CME_US_INDEX_FUTURES',
    },
    determinism_seed: 7,
    output_dir: outputDir,
    cache_root: cacheRoot,
    force_rebuild_cache: true,
    run_started_at_ns: RUN_STARTED_AT_NS,
    runner_code_commit_sha: RUNNER_SHA,
    runner_code_dirty: false,
    repo_root: resolve('.'),
  };
}

function parseJournalEvents(journalJsonl: string): AnyJournalEventEnvelope[] {
  return journalJsonl
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => journalEventFromJsonLine(line) as AnyJournalEventEnvelope);
}

async function prepareOutputRoot(): Promise<void> {
  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_ROOT, { recursive: true });
}

async function writeFixtureManifest(path: string): Promise<void> {
  const manifest = {
    manifest_schema_version: 1,
    ticket_id: 'QFA-211-determinism-fixture',
    status: 'complete',
    blocked_reason: null,
    ready_for_sim03_model_fitting: false,
    scope_note: 'QFA-211 synthetic fixture manifest for deterministic CI replay',
    dataset: 'GLBX.MDP3',
    symbol: 'MNQ',
    databento_api_key_present: false,
    dataset_range: {
      start: '2026-02-02T00:00:00Z',
      end: '2026-02-03T00:00:00Z',
      schema: {
        trades: {
          start: '2026-02-02T14:30:00Z',
          end: '2026-02-02T14:31:00Z',
        },
      },
    },
    dataset_range_error: null,
    definition_schema: 'definition',
    event_schemas: ['trades'],
    min_complete_sessions: 1,
    out_dir: '.tmp/qfa-determinism-fixture/manifest-out',
    retry_policy: {
      attempts: 1,
      backoff: 'none',
      base_seconds: 0,
    },
    validation_fraction: 0,
    corpus_summary: {
      requested_sessions: 1,
      complete_sessions: 1,
      excluded_sessions: 0,
      partial_sessions: 0,
      total_bytes: 1,
      calibration_sessions: 1,
      validation_sessions: 0,
    },
    sessions: [
      {
        session_id: '2026-02-02-rth',
        status: 'complete',
        split: 'calibration',
        symbol: 'MNQ',
        exclusion_reason: null,
        definition_snapshot_window: {
          start_ts_ns: '1767340800000000000',
          end_ts_ns: '1767427200000000000',
        },
        rth_window: {
          start_ts_ns: '1767364200000000000',
          end_ts_ns: '1767364260000000000',
        },
        schemas: {
          trades: {
            schema: 'trades',
            status: 'available',
            path: DBN_FIXTURE,
            start_ts_ns: '1767364200000000000',
            end_ts_ns: '1767364260000000000',
            byte_count: 1,
            record_count: null,
            reused_existing: true,
            attempts: 1,
          },
        },
      },
    ],
  };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  try {
    const result = await runDeterminismCheck({
      force_mismatch_for_test: process.argv.includes('--force-mismatch-for-test'),
    });
    if (!result.comparison.equal) {
      console.error(formatDeterminismMismatch(result.comparison));
      process.exitCode = 1;
      return;
    }
    console.log('QFA determinism check passed');
    console.log(`run A final_chain_hash: ${result.run_a.final_chain_hash}`);
    console.log(`run B final_chain_hash: ${result.run_b.final_chain_hash}`);
    console.log(`events per run: ${result.run_a.event_count}`);
    console.log(`manifest A: ${result.run_a.manifest_path}`);
    console.log(`manifest B: ${result.run_b.manifest_path}`);
  } catch (error) {
    console.error('QFA determinism check failed before comparison');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await main();
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

function forceMismatchForTest(summary: DeterminismRunSummary): DeterminismRunSummary {
  const [first, ...rest] = summary.manifest.artifacts;
  if (first === undefined) {
    return summary;
  }
  const manifest: ReproducibilityManifest = {
    ...summary.manifest,
    artifacts: [
      {
        ...first,
        sha256: 'f'.repeat(64),
      },
      ...rest,
    ],
    final_chain_hash: 'f'.repeat(64),
  };
  return {
    ...summary,
    final_chain_hash: manifest.final_chain_hash,
    manifest,
  };
}
