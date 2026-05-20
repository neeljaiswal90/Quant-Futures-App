import { stderr as processStderr, stdout as processStdout } from 'node:process';
import type { AnyJournalEventEnvelope } from '../../apps/strategy_runtime/src/contracts/index.js';
import type { StrategyId } from '../../apps/strategy_runtime/src/contracts/strategy-ids.js';
import {
  OperatorConsole,
  OPERATOR_CONSOLE_EVENT_TYPES,
  refreshIntervalMsFromEnv,
  type OperatorConsoleEventSource,
  type OperatorConsoleSubscription,
} from '../../apps/strategy_runtime/src/operator/console/operator-console.js';
import { OperatorConsoleStateStore } from '../../apps/strategy_runtime/src/operator/console/console-state.js';
import {
  PaperTradingSession,
  resolvePaperTradingSessionConfig,
} from '../../apps/strategy_runtime/src/paper-trading/index.js';
import { LatencySliRegistry } from '../../apps/strategy_runtime/src/observability/latency-sli.js';
import { BurnRateEvaluator } from '../../apps/strategy_runtime/src/observability/burn-rate-evaluator.js';
import { PROVISIONAL_LATENCY_SLO_DEFINITIONS } from '../../apps/strategy_runtime/src/observability/slo-registry.js';

class ReplayJournalEventSource implements OperatorConsoleEventSource {
  constructor(private readonly events: readonly AnyJournalEventEnvelope[]) {}

  subscribe(
    options: Parameters<OperatorConsoleEventSource['subscribe']>[0],
    handler: Parameters<OperatorConsoleEventSource['subscribe']>[1],
  ): OperatorConsoleSubscription {
    const eventTypes = new Set(options.event_types);
    for (const event of this.events) {
      if (eventTypes.has(event.type as (typeof OPERATOR_CONSOLE_EVENT_TYPES)[number])) {
        void handler(event);
      }
    }
    return { unsubscribe: () => undefined };
  }
}

async function main(): Promise<void> {
  const config = resolvePaperTradingSessionConfig({
    env: process.env,
    overrides: {
      metrics_endpoint: { enabled: false, port: 0 },
      shutdown_quarantine_timeout_ms: 0,
    },
  });
  const latencyRegistry = new LatencySliRegistry();
  const burnRateEvaluator = new BurnRateEvaluator({
    definitions: PROVISIONAL_LATENCY_SLO_DEFINITIONS,
  });
  const session = new PaperTradingSession({
    config: {
      metrics_endpoint: { enabled: false, port: 0 },
      shutdown_quarantine_timeout_ms: 0,
    },
    latency_registry: latencyRegistry,
    burn_rate_evaluator: burnRateEvaluator,
  });

  await session.start();
  seedObservabilitySnapshots(config.strategy_id, latencyRegistry, burnRateEvaluator);
  await session.stop();

  const diagnostics = () => session.getDiagnostics();
  const stateStore = new OperatorConsoleStateStore({
    strategy_id: config.strategy_id,
    burn_rate_evaluator: burnRateEvaluator,
    latency_registry: latencyRegistry,
    submission_gate: {
      get open_quarantine_count() {
        return diagnostics().open_quarantine_count;
      },
      get active_block_sources() {
        return diagnostics().active_submission_block_sources;
      },
    },
  });
  const console = new OperatorConsole({
    event_source: new ReplayJournalEventSource(session.events),
    state_store: stateStore,
    writer: processStdout,
    refresh_interval_ms: refreshIntervalMsFromEnv(),
    clear_screen: false,
  });

  console.start();
  console.stop();
}

function seedObservabilitySnapshots(
  strategyId: string,
  latencyRegistry: LatencySliRegistry,
  burnRateEvaluator: BurnRateEvaluator,
): void {
  const boundedStrategyId = strategyId as StrategyId;
  latencyRegistry.recordStrategyDecisionMs(boundedStrategyId, 12);
  latencyRegistry.recordStrategyDecisionMs(boundedStrategyId, 18);
  latencyRegistry.recordEventLoopLagMs(3);
  latencyRegistry.recordSnapshotToSubmitMs(42);
  latencyRegistry.recordOrderAckSubmissionMs(75);
  latencyRegistry.recordOrderAckCancelMs(21);

  burnRateEvaluator.observeSample('qfa_strategy_decision_ms', 12);
  burnRateEvaluator.observeSample('qfa_event_loop_lag_ms', 3);
  burnRateEvaluator.observeSample('qfa_snapshot_to_submit_ms', 42);
  burnRateEvaluator.observeSample('qfa_order_ack_submission_ms', 75);
}

main().catch((error: unknown) => {
  processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
