import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeTradeLedger,
  buildTradeLedger,
  buildCapabilityAssessmentSet,
  canonicalizeReproJson,
  computeReproducibilityManifest,
  computeStrategyFingerprintSet,
  defaultStrategyReplayIds,
  evaluateValidationGateSet,
  replayStrategies,
  sha256Utf8,
  runBacktest,
  writeReproducibilityManifest,
  REPRO_ARTIFACT_ORDER,
  type BacktestRunnerOptions,
  type CapabilityAssessmentSet,
  type EquityMetricsOptions,
  type ReproArtifactName,
  type ReproducibilityManifest,
  type StrategyFingerprint,
  type StrategyFingerprintSet,
  type StrategyReplayResult,
  type StrategyValidationGateInput,
  type StrategyValidationWindowInput,
  type ValidationGateResultSet,
  type ValidationTrialAccounting,
  type TradeLedgerInstrumentContext,
} from '../../apps/backtester/src/index.js';
import {
  journalEventFromJsonLine,
  type AnyJournalEventEnvelope,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import type { StrategyId } from '../../apps/strategy_runtime/src/contracts/strategy-ids.js';
import type { BuiltBar } from '../../apps/strategy_runtime/src/data/bar-builder/index.js';

const OUTPUT_ROOT = resolve('.tmp', 'qfa-determinism-fixture');
const MANIFEST_PATH = resolve(OUTPUT_ROOT, 'manifest.json');
const DBN_FIXTURE = resolve('apps/strategy_runtime/tests/fixtures/dbn/trades-minimal.dbn');
const REGIME_LABELS_PATH = resolve('artifacts/regime/regime-labels.json');
const VIX_VXN_SNAPSHOT_PATH = resolve('config/research/vix-vxn-daily-2025-09-to-2026-04.json');
const RESEARCH_MANIFESTS_ROOT = resolve('config/research/manifests');
const RUN_STARTED_AT_NS = '1767365700000000000';
const RUNNER_SHA = 'd'.repeat(40);
// CF-20 future dispatch: readers must dispatch on this marker before treating
// the Phase 2 artifact aggregate as qfa_phase2_determinism_artifacts_sha256_v1.
export const PHASE2_DETERMINISM_ARTIFACTS_ALGORITHM =
  'qfa_phase2_determinism_artifacts_sha256_v1' as const;
export const PHASE4_REGIME_SUBSTRATE_DETERMINISM_ALGORITHM =
  'qfa_phase4_regime_substrate_determinism_sha256_v1' as const;

const PHASE2_ARTIFACT_ORDER = [
  'strategy_replay_result',
  'strategy_fingerprint_set',
  'capability_assessment_set',
  'validation_gate_result_set',
] as const;

const PHASE4_HASH_ORDER = [
  'regime_labels_json',
  'vix_vxn_snapshot',
  'manifest_feb_2026',
  'manifest_mar_2026',
  'manifest_apr_2026',
] as const;

const PINNED_PHASE4_HASHES = {
  regime_labels_json: 'f49c2ac2c94b77fede4dbffa2c785d04c11c5d974901621c97f43f5d2f82e5c9',
  vix_vxn_snapshot: '1f4cf55f82657a1aaa9b2dd293886c8498cdaf3743207fcdd8089e7de1940036',
  manifest_feb_2026: '05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c',
  manifest_mar_2026: 'cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f',
  manifest_apr_2026: 'e37d01b3a3976f2f2614c2a85171ce4cc8b6b5ad069bf782f55285b0e7721a2c',
} as const;

const PINNED_PHASE4_QUALITY_EXCLUSIONS = [
  '2026-03-17-rth',
  '2026-03-18-rth',
  '2026-03-19-rth',
  '2026-03-20-rth',
  '2026-04-10-rth',
] as const;

const PINNED_SECONDARY_PERCENTILE_BASIS = 'within_window' as const;

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

type Phase2DeterminismArtifactName = (typeof PHASE2_ARTIFACT_ORDER)[number];
type Phase4DeterminismHashName = (typeof PHASE4_HASH_ORDER)[number];

interface Phase2DeterminismArtifactHashes {
  readonly strategy_replay_result: string;
  readonly strategy_fingerprint_set: string;
  readonly capability_assessment_set: string;
  readonly validation_gate_result_set: string;
}

interface Phase2DeterminismArtifacts {
  readonly strategy_replay_result: StrategyReplayResult;
  readonly strategy_fingerprint_set: StrategyFingerprintSet;
  readonly capability_assessment_set: CapabilityAssessmentSet;
  readonly validation_gate_result_set: ValidationGateResultSet;
}

interface Phase4DeterminismHashes {
  readonly regime_labels_json: string;
  readonly vix_vxn_snapshot: string;
  readonly manifest_feb_2026: string;
  readonly manifest_mar_2026: string;
  readonly manifest_apr_2026: string;
}

export interface Phase4DeterminismSummary {
  readonly artifact_hashes: Phase4DeterminismHashes;
  readonly quality_exclusions: readonly string[];
  readonly secondary_percentile_basis: string;
  readonly final_phase4_hash: string;
}

export interface Phase2DeterminismSummary {
  readonly artifact_hashes: Phase2DeterminismArtifactHashes;
  readonly final_phase2_hash: string;
}

export interface DeterminismRunSummary {
  readonly label: 'A' | 'B';
  readonly run_id: string;
  readonly run_spec_hash: string;
  readonly final_chain_hash: string;
  readonly final_phase2_hash: string;
  readonly final_phase4_hash: string;
  readonly event_count: number;
  readonly journal_path: string;
  readonly manifest_path: string;
  readonly manifest: ReproducibilityManifest;
  readonly phase2: Phase2DeterminismSummary;
  readonly phase4: Phase4DeterminismSummary;
}

export interface DeterminismComparison {
  readonly equal: boolean;
  readonly chain_equal: boolean;
  readonly phase2_equal: boolean;
  readonly phase4_equal: boolean;
  readonly left_final_chain_hash: string;
  readonly right_final_chain_hash: string;
  readonly left_final_phase2_hash: string;
  readonly right_final_phase2_hash: string;
  readonly left_final_phase4_hash: string;
  readonly right_final_phase4_hash: string;
  readonly differing_artifacts: readonly ReproArtifactName[];
  readonly differing_phase2_artifacts: readonly Phase2DeterminismArtifactName[];
  readonly differing_phase4_hashes: readonly Phase4DeterminismHashName[];
}

export interface DeterminismCheckResult {
  readonly run_a: DeterminismRunSummary;
  readonly run_b: DeterminismRunSummary;
  readonly comparison: DeterminismComparison;
}

export interface DeterminismCheckOptions {
  readonly force_mismatch_for_test?: boolean;
  readonly force_phase2_mismatch_for_test?: boolean;
  readonly force_phase4_mismatch_for_test?: boolean;
}

export async function runDeterminismCheck(
  options: DeterminismCheckOptions = {},
): Promise<DeterminismCheckResult> {
  await prepareOutputRoot();
  await writeFixtureManifest(MANIFEST_PATH);

  const runA = await runFixture('A');
  const rawRunB = await runFixture('B');
  const chainRunB = options.force_mismatch_for_test
    ? forceMismatchForTest(rawRunB)
    : rawRunB;
  const runB = options.force_phase2_mismatch_for_test
    ? forcePhase2MismatchForTest(chainRunB)
    : chainRunB;
  const comparedRunB = options.force_phase4_mismatch_for_test
    ? forcePhase4MismatchForTest(runB)
    : runB;
  const comparison = compareDeterminismRuns(runA, comparedRunB);

  return {
    run_a: runA,
    run_b: comparedRunB,
    comparison,
  };
}

export function compareDeterminismRuns(
  left: DeterminismRunSummary,
  right: DeterminismRunSummary,
): DeterminismComparison {
  const manifestComparison = compareDeterminismManifests(left.manifest, right.manifest);
  const differingPhase2Artifacts = PHASE2_ARTIFACT_ORDER.filter(
    (artifactName) =>
      left.phase2.artifact_hashes[artifactName] !== right.phase2.artifact_hashes[artifactName],
  );
  const differingPhase4Hashes = PHASE4_HASH_ORDER.filter(
    (artifactName) =>
      left.phase4.artifact_hashes[artifactName] !== right.phase4.artifact_hashes[artifactName],
  );
  const phase2Equal = left.final_phase2_hash === right.final_phase2_hash;
  const phase4Equal = left.final_phase4_hash === right.final_phase4_hash;

  return {
    equal: manifestComparison.equal && phase2Equal && phase4Equal,
    chain_equal: manifestComparison.equal,
    phase2_equal: phase2Equal,
    phase4_equal: phase4Equal,
    left_final_chain_hash: left.final_chain_hash,
    right_final_chain_hash: right.final_chain_hash,
    left_final_phase2_hash: left.final_phase2_hash,
    right_final_phase2_hash: right.final_phase2_hash,
    left_final_phase4_hash: left.final_phase4_hash,
    right_final_phase4_hash: right.final_phase4_hash,
    differing_artifacts: manifestComparison.differing_artifacts,
    differing_phase2_artifacts: differingPhase2Artifacts,
    differing_phase4_hashes: differingPhase4Hashes,
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
    chain_equal: left.final_chain_hash === right.final_chain_hash,
    phase2_equal: true,
    phase4_equal: true,
    left_final_chain_hash: left.final_chain_hash,
    right_final_chain_hash: right.final_chain_hash,
    left_final_phase2_hash: '',
    right_final_phase2_hash: '',
    left_final_phase4_hash: '',
    right_final_phase4_hash: '',
    differing_artifacts: differingArtifacts,
    differing_phase2_artifacts: [],
    differing_phase4_hashes: [],
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

export function formatPhase2DeterminismMismatch(comparison: DeterminismComparison): string {
  const differing = comparison.differing_phase2_artifacts.length === 0
    ? 'none'
    : comparison.differing_phase2_artifacts.join(', ');
  return [
    'QFA Phase 2 determinism check failed: artifact hashes differ',
    `run A final_phase2_hash: ${comparison.left_final_phase2_hash}`,
    `run B final_phase2_hash: ${comparison.right_final_phase2_hash}`,
    `differing Phase 2 artifacts: ${differing}`,
  ].join('\n');
}

export function formatPhase4DeterminismMismatch(comparison: DeterminismComparison): string {
  const differing = comparison.differing_phase4_hashes.length === 0
    ? 'none'
    : comparison.differing_phase4_hashes.join(', ');
  return [
    'QFA Phase 4 regime-substrate determinism check failed: pinned substrate contract drifted',
    `run A final_phase4_hash: ${comparison.left_final_phase4_hash}`,
    `run B final_phase4_hash: ${comparison.right_final_phase4_hash}`,
    `differing Phase 4 hashes: ${differing}`,
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
  const phase2 = await computePhase2DeterminismSummary(events);
  const phase4 = await computePhase4DeterminismSummary();
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
    final_phase2_hash: phase2.final_phase2_hash,
    final_phase4_hash: phase4.final_phase4_hash,
    event_count: result.event_count,
    journal_path: result.journal_path,
    manifest_path: manifestPath,
    manifest,
    phase2,
    phase4,
  };
}

async function computePhase4DeterminismSummary(): Promise<Phase4DeterminismSummary> {
  const artifactHashes: Phase4DeterminismHashes = {
    regime_labels_json: await sha256File(REGIME_LABELS_PATH),
    vix_vxn_snapshot: await sha256File(VIX_VXN_SNAPSHOT_PATH),
    manifest_feb_2026: await sha256File(resolve(RESEARCH_MANIFESTS_ROOT, 'manifest-feb-2026.json')),
    manifest_mar_2026: await sha256File(resolve(RESEARCH_MANIFESTS_ROOT, 'manifest-mar-2026.json')),
    manifest_apr_2026: await sha256File(resolve(RESEARCH_MANIFESTS_ROOT, 'manifest-apr-2026.json')),
  };
  assertPinnedHashes(artifactHashes);

  const labels = JSON.parse(await readFile(REGIME_LABELS_PATH, 'utf8')) as {
    readonly secondary_substrate?: { readonly percentile_basis?: unknown };
    readonly labels?: readonly {
      readonly session_id?: unknown;
      readonly quality_excluded?: unknown;
    }[];
  };
  const qualityExclusions = (labels.labels ?? [])
    .filter((entry) => entry.quality_excluded === true)
    .map((entry) => String(entry.session_id))
    .sort();
  assertStringArrayEqual(
    qualityExclusions,
    [...PINNED_PHASE4_QUALITY_EXCLUSIONS],
    'regime-labels quality_exclusions list',
  );

  const secondaryPercentileBasis = labels.secondary_substrate?.percentile_basis;
  if (secondaryPercentileBasis !== PINNED_SECONDARY_PERCENTILE_BASIS) {
    throw new Error(
      `regime-labels secondary_percentile_basis drifted: expected ${PINNED_SECONDARY_PERCENTILE_BASIS}, actual ${String(secondaryPercentileBasis)}`,
    );
  }

  const finalHashInput = [
    PHASE4_REGIME_SUBSTRATE_DETERMINISM_ALGORITHM,
    ...PHASE4_HASH_ORDER.map((name) => `${name}=${artifactHashes[name]}`),
    `quality_exclusions=${JSON.stringify(qualityExclusions)}`,
    `secondary_percentile_basis=${secondaryPercentileBasis}`,
  ].join('\n') + '\n';

  return {
    artifact_hashes: artifactHashes,
    quality_exclusions: qualityExclusions,
    secondary_percentile_basis: secondaryPercentileBasis,
    final_phase4_hash: sha256Utf8(finalHashInput),
  };
}

function assertPinnedHashes(actual: Phase4DeterminismHashes): void {
  for (const name of PHASE4_HASH_ORDER) {
    const expected = PINNED_PHASE4_HASHES[name];
    if (actual[name] !== expected) {
      throw new Error(`Phase 4 substrate hash drift for ${name}: expected ${expected}, actual ${actual[name]}`);
    }
  }
}

function assertStringArrayEqual(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} drifted: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
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

async function computePhase2DeterminismSummary(
  events: readonly AnyJournalEventEnvelope[],
): Promise<Phase2DeterminismSummary> {
  const strategyOrder = defaultStrategyReplayIds();
  const strategyReplayResult = await replayStrategies({
    strategy_ids: strategyOrder,
    bars: replayBarsFromJournal(events),
  });
  const strategyFingerprintSet = computeStrategyFingerprintSet(
    strategyReplayResult.evaluations,
    strategyOrder,
  );
  const capabilityAssessmentSet = buildCapabilityAssessmentSet(
    strategyReplayResult,
    strategyFingerprintSet,
    { strategy_order: strategyOrder },
  );
  const validationGateResultSet = evaluateValidationGateSet(
    buildValidationGateInputs(strategyOrder, strategyFingerprintSet, capabilityAssessmentSet),
    undefined,
    strategyOrder,
  );
  return hashPhase2Artifacts({
    strategy_replay_result: strategyReplayResult,
    strategy_fingerprint_set: strategyFingerprintSet,
    capability_assessment_set: capabilityAssessmentSet,
    validation_gate_result_set: validationGateResultSet,
  });
}

function hashPhase2Artifacts(
  artifacts: Phase2DeterminismArtifacts,
): Phase2DeterminismSummary {
  const artifactHashes: Phase2DeterminismArtifactHashes = {
    strategy_replay_result: hashCanonicalArtifact(artifacts.strategy_replay_result),
    strategy_fingerprint_set: hashCanonicalArtifact(artifacts.strategy_fingerprint_set),
    capability_assessment_set: hashCanonicalArtifact(artifacts.capability_assessment_set),
    validation_gate_result_set: hashCanonicalArtifact(artifacts.validation_gate_result_set),
  };
  const finalHashInput = [
    PHASE2_DETERMINISM_ARTIFACTS_ALGORITHM,
    ...PHASE2_ARTIFACT_ORDER.map((name) => `${name}=${artifactHashes[name]}`),
  ].join('\n') + '\n';

  return {
    artifact_hashes: artifactHashes,
    final_phase2_hash: sha256Utf8(finalHashInput),
  };
}

function hashCanonicalArtifact(value: unknown): string {
  return sha256Utf8(canonicalizeReproJson(value));
}

function replayBarsFromJournal(events: readonly AnyJournalEventEnvelope[]): readonly BuiltBar[] {
  return events
    .filter((event) => event.type === 'BAR_CLOSE')
    .map((event, index) => {
      const payload = event.payload as Record<string, unknown>;
      const barSpec = timeframeToBarSpec(String(payload.timeframe));
      return {
        type: 'bar',
        bar_id: `journal-bar-${(index + 1).toString().padStart(3, '0')}`,
        instrument_root: 'MNQ',
        instrument_id: INSTRUMENT_CONTEXT.instrument_id,
        raw_symbol: INSTRUMENT_CONTEXT.raw_symbol,
        bar_spec: barSpec,
        open_reason: index === 0 ? 'stream_start' : 'bar_boundary',
        close_reason: 'bar_boundary',
        is_complete: true,
        roll_boundary_id: null,
        manifest_symbol_check: {
          manifest_symbol: 'MNQ',
          expectation_type: 'root',
          status: 'matched',
          message: 'fixture manifest symbol matches replay sanity root',
        },
        source_metadata: {
          corpus_tier: null,
          input_schemas: ['trades'],
          construction_method: 'trade_aggregation',
          contract_identity_source: 'raw_symbol',
          quality_flags: [],
        },
        bucket_start_ts_ns: toBigInt(payload.start_ts_ns, 'BAR_CLOSE.start_ts_ns'),
        bucket_end_ts_ns: toBigInt(payload.end_ts_ns, 'BAR_CLOSE.end_ts_ns'),
        first_record_ts_ns: toBigInt(
          payload.exchange_event_ts_ns ?? payload.start_ts_ns,
          'BAR_CLOSE.exchange_event_ts_ns',
        ),
        last_record_ts_ns: toBigInt(
          payload.exchange_event_ts_ns ?? event.ts_ns,
          'BAR_CLOSE.exchange_event_ts_ns',
        ),
        open: toBigInt(payload.open, 'BAR_CLOSE.open'),
        high: toBigInt(payload.high, 'BAR_CLOSE.high'),
        low: toBigInt(payload.low, 'BAR_CLOSE.low'),
        close: toBigInt(payload.close, 'BAR_CLOSE.close'),
        volume: toBigInt(payload.volume, 'BAR_CLOSE.volume'),
      } satisfies BuiltBar;
    });
}

function buildValidationGateInputs(
  strategyOrder: readonly StrategyId[],
  fingerprintSet: StrategyFingerprintSet,
  capabilitySet: CapabilityAssessmentSet,
): readonly StrategyValidationGateInput[] {
  return strategyOrder.map((strategyId) => {
    const fingerprint = findFingerprint(fingerprintSet, strategyId);
    return {
      strategy_id: strategyId,
      capability_assessment: findAssessment(capabilitySet, strategyId),
      fingerprint,
      session_order: validationSessionOrder(),
      windows: validationWindows(strategyId, fingerprint),
      trial_accounting: validationTrialAccounting(strategyId),
    };
  });
}

function findFingerprint(
  fingerprintSet: StrategyFingerprintSet,
  strategyId: StrategyId,
): StrategyFingerprint | null {
  return fingerprintSet.fingerprints.find((fingerprint) => fingerprint.strategy_id === strategyId) ?? null;
}

function findAssessment(
  capabilitySet: CapabilityAssessmentSet,
  strategyId: StrategyId,
): CapabilityAssessmentSet['assessments'][number] {
  const assessment = capabilitySet.assessments.find((candidate) => candidate.strategy_id === strategyId);
  if (assessment === undefined) {
    throw new Error(`missing capability assessment for ${strategyId}`);
  }
  return assessment;
}

function validationSessionOrder(): readonly string[] {
  return [
    '2026-02-02-test-00',
    '2026-02-02-test-01',
    '2026-02-02-test-02',
    '2026-02-02-test-03',
    '2026-02-02-test-04',
    '2026-02-02-test-05',
    '2026-02-02-test-06',
    '2026-02-02-test-07',
    '2026-02-02-test-08',
  ];
}

function validationWindows(
  strategyId: StrategyId,
  fingerprint: StrategyFingerprint | null,
): readonly StrategyValidationWindowInput[] {
  const fingerprintSha256 = fingerprint?.fingerprint_sha256 ?? '0'.repeat(64);
  const sessions = validationSessionOrder();
  return Array.from({ length: 8 }, (_, index) => {
    const sequence = index + 1;
    return {
      strategy_id: strategyId,
      window_id: `${strategyId}-determinism-test-${sequence.toString().padStart(2, '0')}`,
      sequence,
      role: 'test',
      start_session: sessions[index]!,
      end_session: sessions[index + 1]!,
      start_index: index,
      end_index: index + 1,
      total_trades: 10,
      gross_profit_cents: 2_000n,
      gross_loss_cents: -1_000n,
      net_pnl_cents: 1_000n,
      profit_factor_ppm: 2_000_000,
      max_drawdown_cents: 1_000n,
      initial_equity_cents: 100_000n,
      average_trade_pnl_cents: 100n,
      win_rate_ppm: 600_000,
      fingerprint_sha256: fingerprintSha256,
      fingerprint_algorithm: 'qfa_strategy_fingerprint_sha256_v1',
    };
  });
}

function validationTrialAccounting(strategyId: StrategyId): ValidationTrialAccounting {
  return {
    trial_accounting_schema_version: 1,
    strategy_id: strategyId,
    campaign_id: 'qfa-211b-phase2-determinism',
    raw_research_trials: 8,
    excluded_determinism_reruns: 0,
    manual_declared_effective_trials: 1,
    distinct_window_fingerprint_tuples: 8,
    effective_trial_count: 8,
    effective_trial_scope: 'campaign',
    effective_trial_method: 'max_of_manual_and_distinct_fingerprints',
  };
}

function timeframeToBarSpec(timeframe: string): string {
  return timeframe === '60m' ? '1h' : timeframe;
}

function toBigInt(value: unknown, path: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    return BigInt(value);
  }
  throw new Error(`${path} must be an integer-compatible value`);
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
      force_phase2_mismatch_for_test: process.argv.includes('--force-phase2-mismatch-for-test'),
      force_phase4_mismatch_for_test: process.argv.includes('--force-phase4-mismatch-for-test'),
    });
    if (!result.comparison.chain_equal) {
      console.error(formatDeterminismMismatch(result.comparison));
    }
    if (!result.comparison.phase2_equal) {
      console.error(formatPhase2DeterminismMismatch(result.comparison));
    }
    if (!result.comparison.phase4_equal) {
      console.error(formatPhase4DeterminismMismatch(result.comparison));
    }
    if (!result.comparison.equal) {
      process.exitCode = 1;
      return;
    }
    console.log('QFA determinism check passed');
    console.log(`run A final_chain_hash: ${result.run_a.final_chain_hash}`);
    console.log(`run B final_chain_hash: ${result.run_b.final_chain_hash}`);
    console.log(`run A final_phase2_hash: ${result.run_a.final_phase2_hash}`);
    console.log(`run B final_phase2_hash: ${result.run_b.final_phase2_hash}`);
    console.log(`run A final_phase4_hash: ${result.run_a.final_phase4_hash}`);
    console.log(`run B final_phase4_hash: ${result.run_b.final_phase4_hash}`);
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

function forcePhase2MismatchForTest(summary: DeterminismRunSummary): DeterminismRunSummary {
  const phase2: Phase2DeterminismSummary = {
    artifact_hashes: {
      ...summary.phase2.artifact_hashes,
      strategy_replay_result: 'e'.repeat(64),
    },
    final_phase2_hash: 'e'.repeat(64),
  };
  return {
    ...summary,
    final_phase2_hash: phase2.final_phase2_hash,
    phase2,
  };
}

function forcePhase4MismatchForTest(summary: DeterminismRunSummary): DeterminismRunSummary {
  const phase4: Phase4DeterminismSummary = {
    ...summary.phase4,
    artifact_hashes: {
      ...summary.phase4.artifact_hashes,
      regime_labels_json: 'c'.repeat(64),
    },
    final_phase4_hash: 'c'.repeat(64),
  };
  return {
    ...summary,
    final_phase4_hash: phase4.final_phase4_hash,
    phase4,
  };
}

