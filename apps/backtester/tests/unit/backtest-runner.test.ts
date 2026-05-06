// Module under test: apps/backtester/src; ticket QFA-201.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRunSpecFromOptions,
  runBacktest,
  type BacktestRunnerOptions,
} from '../../src/index.js';
import {
  computeManifestHash,
  deriveRunId,
  journalEventFromJsonLine,
  validateRunSpec,
  type AnyJournalEventEnvelope,
} from '../../../strategy_runtime/src/contracts/index.js';
import { loadCorpusManifest } from '../../../strategy_runtime/src/config/corpus-manifest-loader.js';

const TEST_ROOT = resolve('.tmp', 'qfa-201-backtester-tests');
const DBN_FIXTURE = resolve('apps/strategy_runtime/tests/fixtures/dbn/trades-minimal.dbn');
const RUN_STARTED_AT_NS = '1767365700000000000';
const RUNNER_SHA = 'a'.repeat(40);

function baseOptions(testName: string): BacktestRunnerOptions {
  const testRoot = resolve(TEST_ROOT, testName);
  mkdirSync(testRoot, { recursive: true });
  const manifestPath = resolve(testRoot, 'manifest.json');
  writeFixtureManifest(manifestPath);
  return {
    corpus_manifest_path: manifestPath,
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
    output_dir: resolve(testRoot, 'out'),
    cache_root: resolve(testRoot, 'cache'),
    run_started_at_ns: RUN_STARTED_AT_NS,
    runner_code_commit_sha: RUNNER_SHA,
    runner_code_dirty: false,
    repo_root: resolve('.'),
  };
}

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('QFA-201 buildRunSpecFromOptions', () => {
  it('constructs a valid RunSpec and derives the official run identity', () => {
    const built = buildRunSpecFromOptions(baseOptions('valid-run-spec'));
    expect(() => validateRunSpec(built.run_spec)).not.toThrow();
    expect(built.run_spec.strategy_ids).toEqual(['trend_pullback_long']);
    expect(built.run_spec.runner_code_commit_sha).toBe(RUNNER_SHA);
    expect(deriveRunId(built.run_spec)).toEqual(built.identity);
  });

  it('computes the manifest hash with computeManifestHash', () => {
    const options = baseOptions('manifest-hash');
    const built = buildRunSpecFromOptions(options);
    const manifest = loadCorpusManifest(options.corpus_manifest_path);
    expect(built.run_spec.corpus_inputs[0]?.manifest_hash).toBe(computeManifestHash(manifest));
  });

  it('rejects an invalid strategy_id through existing StrategyId validation', () => {
    expect(() =>
      buildRunSpecFromOptions({
        ...baseOptions('invalid-strategy'),
        strategy_id: 'breakout_retest_short',
      }),
    ).toThrow(/Unknown strategy_id/u);
  });

  it('rejects an invalid bar_spec through RunSpec validation', () => {
    expect(() =>
      buildRunSpecFromOptions({
        ...baseOptions('invalid-bar-spec'),
        bar_spec: 'bad-bars',
      }),
    ).toThrow(/bar_spec/u);
  });
});

describe('QFA-201 runBacktest', () => {
  it('emits BACKTEST_RUN_META as the first journal event', async () => {
    const result = await runBacktest(baseOptions('first-event'));
    const events = readJournal(result.journal_path);
    expect(events[0]?.type).toBe('BACKTEST_RUN_META');
    expect(events[0]?.run_id).toBe(result.run_id);
    expect((events[0]?.payload as unknown as Record<string, unknown>).run_spec_hash).toBe(result.run_spec_hash);
  });

  it('does not duplicate envelope-owned fields inside BACKTEST_RUN_META payload', async () => {
    const result = await runBacktest(baseOptions('payload-fields'));
    const [first] = readJournal(result.journal_path);
    const payload = first?.payload as unknown as Record<string, unknown>;
    for (const field of ['run_id', 'event_id', 'type', 'ts_ns', 'session_id', 'schema_version']) {
      expect(Object.hasOwn(payload, field)).toBe(false);
    }
  });

  it('writes deterministic journal output for identical fixture runs', async () => {
    const first = await runBacktest(baseOptions('deterministic-a'));
    const second = await runBacktest(baseOptions('deterministic-b'));
    expect(readFileSync(first.journal_path, 'utf8')).toBe(readFileSync(second.journal_path, 'utf8'));
  });

  it('uses derived run_id and run_spec_hash consistently across identical fixture runs', async () => {
    const first = await runBacktest(baseOptions('lineage-a'));
    const second = await runBacktest(baseOptions('lineage-b'));
    expect(first.run_id).toBe(second.run_id);
    expect(first.run_spec_hash).toBe(second.run_spec_hash);
  });

  it('writes BAR_CLOSE and STRAT_EVAL events after the first metadata event', async () => {
    const result = await runBacktest(baseOptions('bar-and-strategy'));
    const events = readJournal(result.journal_path);
    expect(events.map((event) => event.type)).toEqual([
      'BACKTEST_RUN_META',
      'BAR_CLOSE',
      'STRAT_EVAL',
    ]);
    expect(events[2]?.causation_id).toBe(events[1]?.event_id);
    expect((events[2]?.payload as unknown as Record<string, unknown>).strategy_id).toBe('trend_pullback_long');
  });

  it('returns event_count matching journal lines', async () => {
    const result = await runBacktest(baseOptions('event-count'));
    expect(result.event_count).toBe(readJournal(result.journal_path).length);
  });
});

function readJournal(path: string): AnyJournalEventEnvelope[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => journalEventFromJsonLine(line) as AnyJournalEventEnvelope);
}

function writeFixtureManifest(path: string): void {
  const manifest = {
    manifest_schema_version: 1,
    ticket_id: 'QFA-201-test',
    status: 'complete',
    blocked_reason: null,
    ready_for_sim03_model_fitting: false,
    scope_note: 'QFA-201 synthetic fixture manifest for deterministic backtester tests',
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
    out_dir: '.tmp/qfa-201-backtester-tests',
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
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
