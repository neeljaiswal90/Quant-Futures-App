import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stdout as processStdout,
  stderr as processStderr,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  loadAppConfig,
} from '../../apps/strategy_runtime/src/config/index.js';
import {
  makeCausationId,
  makeCorrelationId,
  createJournalEventEnvelope,
  makeEventId,
  makeFillId,
  makeManagementActionId,
  makeOrderIntentId,
  makePositionId,
  makeRiskGateDecisionId,
  makeRunId,
  makeSessionId,
  makeSizingDecisionId,
  ns,
  stableJsonStringify,
  validateJournalEventEnvelope,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
  type JsonValue,
  type RuntimeEventType,
  type UnixNs,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import {
  createSimulatedExecutionAdapter,
} from '../../apps/strategy_runtime/src/execution/simulated-execution.js';
import {
  createStrategyRuntimeEngineContainer,
  StrategyRuntimeRunner,
} from '../../apps/strategy_runtime/src/orchestration/index.js';
import {
  loadVenueCostTable,
} from '../../apps/strategy_runtime/src/risk/index.js';
import {
  loadMnqRollCalendarConfig,
  loadMnqSessionCalendarConfig,
} from '../../apps/strategy_runtime/src/session/index.js';
import {
  createJournalTransportConfig,
  JsonlJournalTransportIngestor,
  type IngestedJournalEvent,
  type QuarantinedJournalLine,
} from '../../apps/strategy_runtime/src/transport/journal-jsonl-transport.js';
import {
  STRATEGY_SYNTHETIC_FIXTURES,
} from '../../apps/strategy_runtime/tests/fixtures/strategies/synthetic-feature-snapshots.js';
import {
  getStrategyGenerator,
  type StrategyFeatureSnapshot,
} from '../../apps/strategy_runtime/src/strategies/index.js';
import {
  formatJournalQueryResult,
  runJournalQuery,
} from '../journal/journal-query.js';

export const REL_00A_REPORT_SCHEMA_VERSION = 1 as const;

export type Rel00aStatus = 'pass' | 'fail';
export type Rel00aExitCode = 0 | 2 | 3;

export interface Rel00aCheck {
  readonly name: string;
  readonly status: Rel00aStatus;
  readonly detail?: string;
}

export interface Rel00aCheckGroup {
  readonly status: Rel00aStatus;
  readonly checks: readonly Rel00aCheck[];
}

export interface Rel00aReport {
  readonly schema_version: typeof REL_00A_REPORT_SCHEMA_VERSION;
  readonly status: Rel00aStatus;
  readonly config_checks: Rel00aCheckGroup;
  readonly fixture_checks: Rel00aCheckGroup;
  readonly journal_schema_checks: Rel00aCheckGroup;
  readonly evt_invariant_checks: Rel00aCheckGroup;
  readonly traceability_checks: Rel00aCheckGroup;
  readonly determinism_checks: Rel00aCheckGroup;
  readonly generated_output_paths: {
    readonly runtime_journal_a: string;
    readonly runtime_journal_b: string;
    readonly report: string;
  };
  readonly reasons: readonly string[];
  readonly next_blocker: string;
}

export interface Rel00aOptions {
  readonly cwd?: string;
  readonly fixture_dir?: string;
  readonly output_dir?: string;
  readonly report_path?: string;
  readonly trace_candidate_id?: string;
  readonly trace_position_id?: string;
  readonly runtime_journal_mutator?: (journal: string, runLabel: 'a' | 'b') => string;
}

interface FixtureManifest {
  readonly fixture_id?: string;
  readonly journal_file?: string;
  readonly schema_version?: number;
  readonly event_count?: number;
  readonly journal_sha256_lf?: string;
  readonly redaction_statement?: string;
  readonly extraction_range?: {
    readonly raw_rows_committed?: boolean;
  };
}

interface RuntimeJournalResult {
  readonly journal_path: string;
  readonly journal_text: string;
  readonly events: readonly JournalEventEnvelope[];
}

const DEFAULT_FIXTURE_DIR = 'apps/strategy_runtime/tests/fixtures/obs00';
const DEFAULT_OUTPUT_DIR = 'reports/rel/rel00a';
const DEFAULT_REPORT_PATH = 'reports/rel/rel00a_offline_readiness_report.json';
const NEXT_BLOCKER = 'INFRA-01 verification / DATA-01';
const REL_00A_FIXTURE_STRATEGY_ID = 'vwap_overnight_reversal_long' as const;

export async function runRel00aOfflineReadiness(
  options: Rel00aOptions = {},
): Promise<Rel00aReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const outputDir = resolve(cwd, options.output_dir ?? DEFAULT_OUTPUT_DIR);
  const reportPath = resolve(cwd, options.report_path ?? DEFAULT_REPORT_PATH);
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });

  const configChecks = runConfigChecks(cwd);
  const fixtureDir = resolve(cwd, options.fixture_dir ?? DEFAULT_FIXTURE_DIR);
  const fixtureChecks = await runFixtureChecks(fixtureDir, outputDir);

  const runtimeA = await runDeterministicRuntimeFixture(cwd, outputDir, 'a', options.runtime_journal_mutator);
  const runtimeB = await runDeterministicRuntimeFixture(cwd, outputDir, 'b', options.runtime_journal_mutator);

  const schemaChecks = runJournalSchemaChecks(runtimeA.events, runtimeB.events);
  const invariantChecks = await runEvtInvariantChecks(runtimeA, runtimeB, outputDir);
  const traceabilityChecks = runTraceabilityChecks(runtimeA, {
    candidate_id: options.trace_candidate_id,
    position_id: options.trace_position_id,
  });
  const determinismChecks = runDeterminismChecks(runtimeA, runtimeB);

  const groups = [
    configChecks,
    fixtureChecks,
    schemaChecks,
    invariantChecks,
    traceabilityChecks,
    determinismChecks,
  ];
  const reasons = groups.flatMap((group) =>
    group.checks
      .filter((check) => check.status === 'fail')
      .map((check) => `${check.name}: ${check.detail ?? 'failed'}`),
  );
  const report: Rel00aReport = {
    schema_version: REL_00A_REPORT_SCHEMA_VERSION,
    status: reasons.length === 0 ? 'pass' : 'fail',
    config_checks: configChecks,
    fixture_checks: fixtureChecks,
    journal_schema_checks: schemaChecks,
    evt_invariant_checks: invariantChecks,
    traceability_checks: traceabilityChecks,
    determinism_checks: determinismChecks,
    generated_output_paths: {
      runtime_journal_a: runtimeA.journal_path,
      runtime_journal_b: runtimeB.journal_path,
      report: reportPath,
    },
    reasons,
    next_blocker: NEXT_BLOCKER,
  };

  writeFileSync(reportPath, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
  return report;
}

export function rel00aExitCode(report: Rel00aReport): Rel00aExitCode {
  return report.status === 'pass' ? 0 : 2;
}

export function formatRel00aSummary(report: Rel00aReport): string {
  const lines = [
    `REL-00A offline readiness: ${report.status.toUpperCase()}`,
    `report=${report.generated_output_paths.report}`,
    `runtime_journal_a=${report.generated_output_paths.runtime_journal_a}`,
    `runtime_journal_b=${report.generated_output_paths.runtime_journal_b}`,
    `next_blocker=${report.next_blocker}`,
  ];
  if (report.reasons.length > 0) {
    lines.push('reasons:');
    for (const reason of report.reasons) {
      lines.push(`- ${reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function runConfigChecks(cwd: string): Rel00aCheckGroup {
  const checks: Rel00aCheck[] = [];
  try {
    const config = loadAppConfig({
      configPath: 'config/app.example.json',
      cwd,
      env: {
        QFA_JOURNAL_DIR: 'journals/rel00a-offline',
      },
    });
    checks.push(pass('app_config_loaded', config.lineage.config_hash));
    checks.push(checkBoolean('strategy_config_loaded', config.strategyConfig !== undefined));
    checks.push(checkBoolean('risk_config_loaded', config.riskConfig !== undefined));
    checks.push(checkBoolean('management_config_loaded', config.managementProfiles !== undefined));
    const session = loadMnqSessionCalendarConfig({ cwd, required: true });
    checks.push(pass('mnq_session_calendar_loaded', session.source_file));
    const roll = loadMnqRollCalendarConfig({ cwd, required: true });
    checks.push(pass('mnq_roll_calendar_loaded', roll.source_file));
  } catch (error) {
    checks.push(fail('config_load', errorMessage(error)));
  }
  return group(checks);
}

async function runFixtureChecks(fixtureDir: string, outputDir: string): Promise<Rel00aCheckGroup> {
  const checks: Rel00aCheck[] = [];
  const manifestPath = join(fixtureDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return group([fail('obs00_manifest_exists', manifestPath)]);
  }
  checks.push(pass('obs00_manifest_exists', manifestPath));

  let manifest: FixtureManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureManifest;
  } catch (error) {
    return group([...checks, fail('obs00_manifest_parse', errorMessage(error))]);
  }

  const journalPath = join(fixtureDir, manifest.journal_file ?? 'mini-journal.jsonl');
  checks.push(checkBoolean('obs00_journal_exists', existsSync(journalPath), journalPath));
  if (!existsSync(journalPath)) {
    return group(checks);
  }

  const journalText = readFileSync(journalPath, 'utf8').replace(/\r\n/g, '\n');
  const lineCount = nonEmptyLines(journalText).length;
  checks.push(checkBoolean('obs00_event_count_matches_manifest', lineCount === manifest.event_count, `${lineCount}`));
  checks.push(checkBoolean('obs00_schema_version_v1', manifest.schema_version === 1));
  const actualHash = sha256Lf(journalText);
  checks.push(checkBoolean(
    'obs00_checksum_matches_manifest',
    actualHash === manifest.journal_sha256_lf,
    actualHash,
  ));
  checks.push(checkBoolean(
    'obs00_redaction_statement_present',
    typeof manifest.redaction_statement === 'string' &&
      manifest.redaction_statement.includes('No credentials') &&
      manifest.extraction_range?.raw_rows_committed === false,
  ));

  const validation = await validateJournalWithTransport(journalPath, join(outputDir, 'fixture-transport'));
  checks.push(checkBoolean('obs00_transport_ingests_without_quarantine', validation.quarantine.length === 0, `${validation.quarantine.length}`));
  checks.push(checkBoolean('obs00_transport_event_count_matches', validation.events.length === manifest.event_count, `${validation.events.length}`));

  return group(checks);
}

async function runDeterministicRuntimeFixture(
  cwd: string,
  outputDir: string,
  runLabel: 'a' | 'b',
  mutator: Rel00aOptions['runtime_journal_mutator'],
): Promise<RuntimeJournalResult> {
  const config = loadAppConfig({
    configPath: 'config/app.example.json',
    cwd,
    env: {
      QFA_JOURNAL_DIR: 'journals/rel00a-offline',
    },
  });
  const container = createStrategyRuntimeEngineContainer({ config });
  const published: JournalEventEnvelope[] = [];
  container.eventBus.subscribe({}, (delivery) => {
    published.push(delivery.event);
  });

  const runner = new StrategyRuntimeRunner({
    container,
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
    execution_adapter: createSimulatedExecutionAdapter({
      venue_costs: loadVenueCostTable(),
    }),
  });
  const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
  await runner.publishExternalEvent(sourceQuoteEvent(snapshot, String(snapshot.source_event_id)));
  const cycle = await runner.processFeatureSnapshot(snapshot);
  await publishExplicitRegisteredInactiveLifecycle(runner, snapshot, cycle.feature_event);

  const journalPath = join(outputDir, `rel00a_runtime_${runLabel}.jsonl`);
  const journalText = mutator?.(serializeJournal(published), runLabel) ?? serializeJournal(published);
  writeFileSync(journalPath, journalText, 'utf8');
  return {
    journal_path: journalPath,
    journal_text: journalText,
    events: published,
  };
}

async function publishExplicitRegisteredInactiveLifecycle(
  runner: StrategyRuntimeRunner,
  snapshot: StrategyFeatureSnapshot,
  featureEvent: JournalEventEnvelope<'FEATURES', JournalEventPayloadFor<'FEATURES'>>,
): Promise<void> {
  const generated = getStrategyGenerator(REL_00A_FIXTURE_STRATEGY_ID)({
    strategy_id: REL_00A_FIXTURE_STRATEGY_ID,
    snapshot,
  });
  if (generated.candidate === undefined) {
    throw new Error(`REL-00A fixture strategy ${REL_00A_FIXTURE_STRATEGY_ID} did not emit a candidate`);
  }
  const candidate = generated.candidate;
  const strategyConfigHash = String(candidate.config.config_hash);
  const correlationId = makeCorrelationId(`corr-${candidate.candidate_id}`);
  const riskGateDecisionId = makeRiskGateDecisionId(`risk-rel00a-${candidate.candidate_id}`);
  const sizingDecisionId = makeSizingDecisionId(`sizing-rel00a-${candidate.candidate_id}`);
  const entryOrderIntentId = makeOrderIntentId(`order-rel00a-entry-${candidate.candidate_id}`);
  const entryFillId = makeFillId(`fill-rel00a-entry-${candidate.candidate_id}`);
  const positionId = makePositionId(`position-rel00a-${candidate.candidate_id}`);
  const managementTs = ns(BigInt(snapshot.created_ts_ns) + 60_000_000_000n);
  const closeSource = await runner.publishExternalEvent(
    sourceQuoteEvent(snapshot, 'rel00a-management-source', managementTs),
  );
  const managementTickId = makeEventId(`mgmt-tick-rel00a-${positionId}`);
  const managementActionId = makeManagementActionId(`mgmt-rel00a-close-${positionId}`);
  const closeOrderIntentId = makeOrderIntentId(`order-rel00a-close-${positionId}`);
  const closeFillId = makeFillId(`fill-rel00a-close-${positionId}`);
  const closePrice = candidate.targets.find((target) => target.label === 'pt2')?.price ?? candidate.entry_price;

  const strategyEvaluationPayload: JournalEventPayloadFor<'STRAT_EVAL'> = {
    strategy_evaluation_id: generated.evaluation.strategy_evaluation_id,
    strategy_id: generated.evaluation.strategy_id,
    feature_snapshot_id: generated.evaluation.feature_snapshot_id,
    gate_state: generated.evaluation.gate_state,
    ...(generated.evaluation.score === undefined ? {} : { score: generated.evaluation.score }),
    reasons: generated.evaluation.reasons,
    strategy_config_hash: strategyConfigHash,
  };
  const strategyEvaluation = await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`strat-eval-${generated.evaluation.strategy_evaluation_id}`),
    type: 'STRAT_EVAL',
    ts_ns: snapshot.created_ts_ns,
    causation_id: makeCausationId(String(featureEvent.event_id)),
    payload: strategyEvaluationPayload,
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));

  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`candidate-${candidate.candidate_id}`),
    type: 'CANDIDATE',
    ts_ns: snapshot.created_ts_ns,
    causation_id: makeCausationId(String(strategyEvaluation.event_id)),
    correlation_id: correlationId,
    payload: {
      candidate_id: candidate.candidate_id,
      strategy_id: candidate.strategy_id,
      feature_snapshot_id: candidate.feature_snapshot_id,
      direction: candidate.direction,
      status: candidate.status,
      entry_price: candidate.entry_price,
      stop_price: candidate.stop_price,
      targets: candidate.targets,
      confidence: candidate.confidence,
      reasons: candidate.reasons,
      strategy_config_hash: strategyConfigHash,
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`sizing-${sizingDecisionId}`),
    type: 'SIZING',
    ts_ns: snapshot.created_ts_ns,
    causation_id: makeCausationId(`candidate-${candidate.candidate_id}`),
    correlation_id: correlationId,
    payload: {
      sizing_decision_id: sizingDecisionId,
      candidate_id: candidate.candidate_id,
      quantity: 1,
      risk_usd: candidate.risk_points * candidate.instrument.point_value,
      risk_points: candidate.risk_points,
      strategy_config_hash: strategyConfigHash,
      risk_manager_version: 'rel00a_explicit_fixture_v1',
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`risk-gate-${riskGateDecisionId}`),
    type: 'RISK_GATE',
    ts_ns: snapshot.created_ts_ns,
    causation_id: makeCausationId(`sizing-${sizingDecisionId}`),
    correlation_id: correlationId,
    payload: {
      risk_gate_decision_id: riskGateDecisionId,
      candidate_id: candidate.candidate_id,
      status: 'pass',
      reasons: ['rel00a:explicit_registered_inactive_fixture'],
      risk_manager_version: 'rel00a_explicit_fixture_v1',
      strategy_config_hash: strategyConfigHash,
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`order-intent-${entryOrderIntentId}`),
    type: 'ORDER_INTENT',
    ts_ns: snapshot.created_ts_ns,
    causation_id: makeCausationId(`risk-gate-${riskGateDecisionId}`),
    correlation_id: correlationId,
    payload: {
      order_intent_id: entryOrderIntentId,
      candidate_id: candidate.candidate_id,
      sizing_decision_id: sizingDecisionId,
      side: 'buy',
      order_type: 'market',
      quantity: 1,
      time_in_force: 'ioc',
      strategy_config_hash: strategyConfigHash,
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`sim-fill-${entryFillId}`),
    type: 'SIM_FILL',
    ts_ns: snapshot.created_ts_ns,
    causation_id: makeCausationId(`order-intent-${entryOrderIntentId}`),
    correlation_id: correlationId,
    payload: {
      fill_id: entryFillId,
      order_intent_id: entryOrderIntentId,
      side: 'buy',
      quantity: 1,
      price: candidate.entry_price,
      liquidity: 'taker',
      slippage_points: 0,
      exchange_fee_usd: 0,
      commission_usd: 0,
      execution_model_version: 'rel00a_explicit_fixture_v1',
      fill_model: 'bbo_market_taker',
      input_tier: 'diagnostic_only',
      strategy_config_hash: strategyConfigHash,
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`position-open-${positionId}`),
    type: 'POSITION',
    ts_ns: snapshot.created_ts_ns,
    causation_id: makeCausationId(`sim-fill-${entryFillId}`),
    correlation_id: correlationId,
    payload: {
      position_id: positionId,
      candidate_id: candidate.candidate_id,
      side: 'long',
      status: 'open',
      quantity_open: 1,
      avg_entry_price: candidate.entry_price,
      updated_ts_ns: snapshot.created_ts_ns,
      strategy_config_hash: strategyConfigHash,
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: managementTickId,
    type: 'MGMT_TICK',
    ts_ns: managementTs,
    causation_id: makeCausationId(String(closeSource.event_id)),
    correlation_id: correlationId,
    payload: {
      position_id: positionId,
      mark_price: closePrice,
      unrealized_pnl_usd: (closePrice - candidate.entry_price) * candidate.instrument.point_value,
      strategy_config_hash: strategyConfigHash,
      position_manager_version: 'rel00a_explicit_fixture_v1',
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`mgmt-action-${managementActionId}`),
    type: 'MGMT_ACTION',
    ts_ns: managementTs,
    causation_id: makeCausationId(String(managementTickId)),
    correlation_id: correlationId,
    payload: {
      management_action_id: managementActionId,
      position_id: positionId,
      action_type: 'TAKE_PROFIT',
      reason: 'rel00a:explicit_registered_inactive_fixture_close',
      exit_quantity: 1,
      exit_price: closePrice,
      realized_pnl_usd: (closePrice - candidate.entry_price) * candidate.instrument.point_value,
      realized_r: candidate.risk_points > 0 ? (closePrice - candidate.entry_price) / candidate.risk_points : 0,
      strategy_config_hash: strategyConfigHash,
      position_manager_version: 'rel00a_explicit_fixture_v1',
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`order-intent-${closeOrderIntentId}`),
    type: 'ORDER_INTENT',
    ts_ns: managementTs,
    causation_id: makeCausationId(`mgmt-action-${managementActionId}`),
    correlation_id: correlationId,
    payload: {
      order_intent_id: closeOrderIntentId,
      candidate_id: candidate.candidate_id,
      sizing_decision_id: sizingDecisionId,
      side: 'sell',
      order_type: 'market',
      quantity: 1,
      time_in_force: 'ioc',
      strategy_config_hash: strategyConfigHash,
      management_action_id: managementActionId,
      position_id: positionId,
      position_manager_version: 'rel00a_explicit_fixture_v1',
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`sim-fill-${closeFillId}`),
    type: 'SIM_FILL',
    ts_ns: managementTs,
    causation_id: makeCausationId(`order-intent-${closeOrderIntentId}`),
    correlation_id: correlationId,
    payload: {
      fill_id: closeFillId,
      order_intent_id: closeOrderIntentId,
      side: 'sell',
      quantity: 1,
      price: closePrice,
      liquidity: 'taker',
      slippage_points: 0,
      exchange_fee_usd: 0,
      commission_usd: 0,
      execution_model_version: 'rel00a_explicit_fixture_v1',
      fill_model: 'bbo_market_taker',
      input_tier: 'diagnostic_only',
      strategy_config_hash: strategyConfigHash,
      management_action_id: managementActionId,
      position_id: positionId,
      position_manager_version: 'rel00a_explicit_fixture_v1',
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
  await runner.publishExternalEvent(createJournalEventEnvelope({
    event_id: makeEventId(`position-close-${positionId}`),
    type: 'POSITION',
    ts_ns: managementTs,
    causation_id: makeCausationId(`sim-fill-${closeFillId}`),
    correlation_id: correlationId,
    payload: {
      position_id: positionId,
      candidate_id: candidate.candidate_id,
      side: 'long',
      status: 'closed',
      quantity_open: 0,
      avg_entry_price: candidate.entry_price,
      updated_ts_ns: managementTs,
      strategy_config_hash: strategyConfigHash,
    },
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
  }));
}

function runJournalSchemaChecks(
  runtimeA: readonly JournalEventEnvelope[],
  runtimeB: readonly JournalEventEnvelope[],
): Rel00aCheckGroup {
  const checks: Rel00aCheck[] = [];
  checks.push(validateEventSet('runtime_a_schema_valid', runtimeA));
  checks.push(validateEventSet('runtime_b_schema_valid', runtimeB));
  checks.push(checkBoolean('runtime_a_schema_version_v2', runtimeA.every((event) => event.schema_version === 2)));
  checks.push(checkBoolean('runtime_b_schema_version_v2', runtimeB.every((event) => event.schema_version === 2)));
  return group(checks);
}

async function runEvtInvariantChecks(
  runtimeA: RuntimeJournalResult,
  runtimeB: RuntimeJournalResult,
  outputDir: string,
): Promise<Rel00aCheckGroup> {
  const validationA = await validateJournalWithTransport(runtimeA.journal_path, join(outputDir, 'runtime-a-transport'));
  const validationB = await validateJournalWithTransport(runtimeB.journal_path, join(outputDir, 'runtime-b-transport'));
  return group([
    checkBoolean('runtime_a_no_quarantine', validationA.quarantine.length === 0, `${validationA.quarantine.length}`),
    checkBoolean('runtime_b_no_quarantine', validationB.quarantine.length === 0, `${validationB.quarantine.length}`),
    checkBoolean('runtime_a_all_events_ingested', validationA.events.length === runtimeA.events.length, `${validationA.events.length}`),
    checkBoolean('runtime_b_all_events_ingested', validationB.events.length === runtimeB.events.length, `${validationB.events.length}`),
    checkBoolean('runtime_a_sources_use_exchange_ts', sourceTimestampInvariant(runtimeA.events)),
    checkBoolean('runtime_a_derived_have_causation', derivedCausationInvariant(runtimeA.events)),
  ]);
}

function runTraceabilityChecks(
  runtime: RuntimeJournalResult,
  options: {
    readonly candidate_id?: string;
    readonly position_id?: string;
  },
): Rel00aCheckGroup {
  const candidateId = options.candidate_id ?? firstPayloadString(runtime.events, 'CANDIDATE', 'candidate_id');
  const positionId = options.position_id ?? firstPayloadString(runtime.events, 'POSITION', 'position_id');
  const checks: Rel00aCheck[] = [
    checkBoolean('candidate_id_available', candidateId !== undefined, candidateId),
    checkBoolean('position_id_available', positionId !== undefined, positionId),
  ];
  if (candidateId !== undefined) {
    const candidateQuery = runJournalQuery({
      journal_path: runtime.journal_path,
      candidate_id: candidateId,
      format: 'json',
      strict: true,
    });
    const candidateTypes = new Set(candidateQuery.events.map((event) => event.type));
    checks.push(checkBoolean('candidate_query_has_no_missing_refs', candidateQuery.missing.length === 0, stableJsonStringify(candidateQuery.missing as unknown as JsonValue)));
    checks.push(checkBoolean('candidate_chain_reconstructs_entry_lifecycle', [
      'CANDIDATE',
      'RISK_GATE',
      'SIZING',
      'ORDER_INTENT',
      'SIM_FILL',
      'POSITION',
    ].every((type) => candidateTypes.has(type as RuntimeEventType))));
    const rendered = formatJournalQueryResult(candidateQuery);
    checks.push(checkBoolean('candidate_query_renders_output', rendered.stdout.includes(candidateId)));
  }
  if (positionId !== undefined) {
    const positionQuery = runJournalQuery({
      journal_path: runtime.journal_path,
      position_id: positionId,
      format: 'json',
      strict: true,
    });
    const positionTypes = new Set(positionQuery.events.map((event) => event.type));
    checks.push(checkBoolean('position_query_has_no_missing_refs', positionQuery.missing.length === 0, stableJsonStringify(positionQuery.missing as unknown as JsonValue)));
    checks.push(checkBoolean('position_chain_reconstructs_management_close', [
      'MGMT_TICK',
      'MGMT_ACTION',
      'ORDER_INTENT',
      'SIM_FILL',
      'POSITION',
    ].every((type) => positionTypes.has(type as RuntimeEventType))));
  }
  return group(checks);
}

function runDeterminismChecks(
  runtimeA: RuntimeJournalResult,
  runtimeB: RuntimeJournalResult,
): Rel00aCheckGroup {
  return group([
    checkBoolean('runtime_journals_byte_identical', runtimeA.journal_text === runtimeB.journal_text),
    checkBoolean('runtime_event_count_stable', runtimeA.events.length === runtimeB.events.length, `${runtimeA.events.length}/${runtimeB.events.length}`),
  ]);
}

async function validateJournalWithTransport(
  journalPath: string,
  validationDir: string,
): Promise<{
  readonly events: readonly IngestedJournalEvent[];
  readonly quarantine: readonly QuarantinedJournalLine[];
}> {
  ensureEmptyDirectory(validationDir);
  copyFileSync(journalPath, join(validationDir, basename(journalPath)));
  const events: IngestedJournalEvent[] = [];
  const quarantine: QuarantinedJournalLine[] = [];
  const ingestor = new JsonlJournalTransportIngestor(createJournalTransportConfig(validationDir), {
    onEvent: (event) => {
      events.push(event);
    },
    onMalformedLine: (line) => {
      quarantine.push(line);
    },
  });
  await ingestor.pollOnce();
  return { events, quarantine };
}

function sourceQuoteEvent(
  snapshot: StrategyFeatureSnapshot,
  eventId: string,
  tsNs: UnixNs = snapshot.created_ts_ns,
): JournalEventEnvelope<'QUOTE', JournalEventPayloadFor<'QUOTE'>> {
  const payload: JournalEventPayloadFor<'QUOTE'> = {
    exchange_event_ts_ns: tsNs,
    sidecar_recv_ts_ns: ns(BigInt(tsNs) + 1_000_000n),
    bid_px: snapshot.quote.bid_px,
    bid_qty: 10,
    ask_px: snapshot.quote.ask_px,
    ask_qty: 8,
    authority: 'authoritative',
  };
  return createJournalEventEnvelope<'QUOTE', JournalEventPayloadFor<'QUOTE'>>({
    event_id: makeEventId(eventId),
    type: 'QUOTE',
    ts_ns: tsNs,
    run_id: makeRunId('run-rel-00a'),
    session_id: makeSessionId('2026-04-23-rth'),
    payload,
  });
}

function serializeJournal(events: readonly JournalEventEnvelope[]): string {
  return events.map((event) => `${stableJsonStringify(toSerializableJson(event))}\n`).join('');
}

function toSerializableJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (
    typeof item === 'bigint' ? item.toString() : item
  ))) as JsonValue;
}

function validateEventSet(
  name: string,
  events: readonly JournalEventEnvelope[],
): Rel00aCheck {
  const failed = events.flatMap((event) => {
    const validation = validateJournalEventEnvelope(event);
    return validation.ok
      ? []
      : [`${event.event_id}: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`];
  });
  return failed.length === 0 ? pass(name, `${events.length}`) : fail(name, failed.join(' | '));
}

function sourceTimestampInvariant(events: readonly JournalEventEnvelope[]): boolean {
  return events
    .filter((event) => ['QUOTE', 'TRADE', 'BAR_CLOSE', 'MICROSTRUCTURE', 'BOOK_REBUILD'].includes(event.type))
    .every((event) => {
      const payload = event.payload as { readonly exchange_event_ts_ns?: unknown };
      return typeof payload.exchange_event_ts_ns === 'bigint' &&
        BigInt(event.ts_ns) === payload.exchange_event_ts_ns;
    });
}

function derivedCausationInvariant(events: readonly JournalEventEnvelope[]): boolean {
  const seen = new Map<string, JournalEventEnvelope>();
  for (const event of events) {
    if (isDerivedEvent(event.type)) {
      if (event.causation_id === undefined) return false;
      const cause = seen.get(String(event.causation_id));
      if (cause !== undefined && BigInt(event.ts_ns) !== BigInt(cause.ts_ns)) {
        return false;
      }
    }
    seen.set(String(event.event_id), event);
  }
  return true;
}

function isDerivedEvent(type: RuntimeEventType): boolean {
  return [
    'FEATURES',
    'STRUCTURE',
    'STRAT_EVAL',
    'CANDIDATE',
    'ML_UPLIFT',
    'RANK',
    'RISK_GATE',
    'SIZING',
    'ORDER_INTENT',
    'SIM_FILL',
    'EXEC_REJECT',
    'POSITION',
    'MGMT_TICK',
    'MGMT_ACTION',
  ].includes(type);
}

function firstPayloadString(
  events: readonly JournalEventEnvelope[],
  type: RuntimeEventType,
  field: string,
): string | undefined {
  const event = events.find((candidate) => candidate.type === type);
  if (event?.payload === null || typeof event?.payload !== 'object' || Array.isArray(event.payload)) {
    return undefined;
  }
  const value = (event.payload as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function nonEmptyLines(value: string): readonly string[] {
  return value.split('\n').filter((line) => line.trim() !== '');
}

function sha256Lf(value: string): string {
  return createHash('sha256').update(value.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function ensureEmptyDirectory(directory: string): void {
  const resolved = resolve(directory);
  if (!resolved.includes('rel00a')) {
    throw new Error(`refusing to clear non-REL-00A directory: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
  mkdirSync(resolved, { recursive: true });
}

function group(checks: readonly Rel00aCheck[]): Rel00aCheckGroup {
  return {
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    checks,
  };
}

function pass(name: string, detail?: string): Rel00aCheck {
  return {
    name,
    status: 'pass',
    ...(detail === undefined ? {} : { detail }),
  };
}

function fail(name: string, detail?: string): Rel00aCheck {
  return {
    name,
    status: 'fail',
    ...(detail === undefined ? {} : { detail }),
  };
}

function checkBoolean(name: string, ok: boolean, detail?: string): Rel00aCheck {
  return ok ? pass(name, detail) : fail(name, detail);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRel00aArgs(args: readonly string[]): Rel00aOptions {
  const options: {
    output_dir?: string;
    report_path?: string;
    fixture_dir?: string;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case '--output-dir':
        index += 1;
        options.output_dir = requireArgValue(flag, args[index]);
        break;
      case '--report':
        index += 1;
        options.report_path = requireArgValue(flag, args[index]);
        break;
      case '--fixture-dir':
        index += 1;
        options.fixture_dir = requireArgValue(flag, args[index]);
        break;
      case '--help':
        processStdout.write(rel00aUsage());
        processExit(0);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return options;
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function rel00aUsage(): string {
  return [
    'Usage: npm run rel:00a -- [--output-dir path] [--report path] [--fixture-dir path]',
    '',
    'Runs the offline REL-00A readiness checker without market access.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const report = await runRel00aOfflineReadiness(parseRel00aArgs(processArgv.slice(2)));
    processStdout.write(formatRel00aSummary(report));
    processExit(rel00aExitCode(report));
  } catch (error) {
    processStderr.write(`REL-00A invalid input/config/environment: ${errorMessage(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
