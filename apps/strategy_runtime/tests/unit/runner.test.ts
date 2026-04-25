import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAppConfig } from '../../src/config/index.js';
import {
  createJournalEventEnvelope,
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  stableJsonStringify,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
  type JsonValue,
} from '../../src/contracts/index.js';
import {
  createSimulatedExecutionAdapter,
} from '../../src/execution/simulated-execution.js';
import {
  createStrategyRuntimeEngineContainer,
  StrategyRuntimeRunner,
} from '../../src/orchestration/index.js';
import {
  createSessionRiskState,
  loadVenueCostTable,
  updateSessionRiskState,
  type PartialRiskPolicyConfig,
  type SessionRiskState,
} from '../../src/risk/index.js';
import {
  STRATEGY_SYNTHETIC_FIXTURES,
} from '../fixtures/strategies/synthetic-feature-snapshots.js';

const RUN_ID = makeRunId('run-orch-02');
const SESSION_ID = makeSessionId('2026-04-23-rth');
const TEST_PASSING_RISK_POLICY = {
  sizing_mode: 'replay',
  default_n_eff: 10_000,
  sizing: {
    C_base: 100,
  },
} as const satisfies PartialRiskPolicyConfig;

function createRunner(options: {
  readonly initialOpenTradeCount?: number;
} = {}) {
  const config = loadAppConfig({
    configPath: 'config/app.example.json',
    cwd: process.cwd(),
    env: {
      QFA_JOURNAL_DIR: 'journals/test-orch-02',
    },
  });
  const container = createStrategyRuntimeEngineContainer({ config });
  const executionAdapter = createSimulatedExecutionAdapter({
    venue_costs: loadVenueCostTable(),
  });
  const snapshot = STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long.snapshot;
  let initial: SessionRiskState | undefined;
  if (options.initialOpenTradeCount !== undefined) {
    initial = createSessionRiskState({
      session_id: snapshot.session.session_id,
      account_ref: 'sim-account',
      symbol: snapshot.instrument.symbol,
      event_ts_ns: snapshot.created_ts_ns,
    });
    for (let index = 0; index < options.initialOpenTradeCount; index += 1) {
      initial = updateSessionRiskState(initial, {
        kind: 'trade_opened',
        event_ts_ns: snapshot.created_ts_ns,
      });
    }
  }

  return {
    container,
    runner: new StrategyRuntimeRunner({
      container,
      run_id: RUN_ID,
      session_id: SESSION_ID,
      execution_adapter: executionAdapter,
      risk_policy: TEST_PASSING_RISK_POLICY,
      initial_session_risk_state: initial,
    }),
  };
}

function sourceQuoteEvent(
  eventId: string,
  tsNs = STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long.snapshot.created_ts_ns,
  overrides: Partial<JournalEventPayloadFor<'QUOTE'>> = {},
): JournalEventEnvelope<'QUOTE', JournalEventPayloadFor<'QUOTE'>> {
  const snapshot = STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long.snapshot;
  return createJournalEventEnvelope({
    event_id: makeEventId(eventId),
    type: 'QUOTE',
    ts_ns: tsNs,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    payload: {
      exchange_event_ts_ns: tsNs,
      sidecar_recv_ts_ns: ns(BigInt(tsNs) + 1_000_000n),
      bid_px: snapshot.quote.bid_px,
      bid_qty: 10,
      ask_px: snapshot.quote.ask_px,
      ask_qty: 8,
      authority: 'authoritative',
      ...overrides,
    },
  });
}

function listOrchestrationSourceFiles(directory = join(process.cwd(), 'apps/strategy_runtime/src/orchestration')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listOrchestrationSourceFiles(path);
    }
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('ORCH-02 deterministic runner loop', () => {
  it('composes feature snapshot to candidate, risk, simulated fill, and position events', async () => {
    const { container, runner } = createRunner();
    const published: JournalEventEnvelope[] = [];
    container.eventBus.subscribe({}, (delivery) => {
      published.push(delivery.event);
    });
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long.snapshot;

    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    const result = await runner.processFeatureSnapshot(snapshot);

    expect(result.strategy_evaluation_events).toHaveLength(4);
    expect(result.candidate_events).toHaveLength(1);
    expect(result.rank_event.payload.ranked_candidate_ids).toEqual([
      result.candidate_events[0]!.payload.candidate_id,
    ]);
    expect(result.sizing_events).toHaveLength(1);
    expect(result.risk_gate_events.map((event) => event.payload.status)).toEqual(['pass']);
    expect(result.order_intent_events).toHaveLength(1);
    expect(result.sim_fill_events).toHaveLength(1);
    expect(result.position_events).toHaveLength(1);
    expect(result.session_risk.open_trade_count).toBe(1);

    expect(published.map((event) => event.type)).toEqual([
      'QUOTE',
      'FEATURES',
      'STRAT_EVAL',
      'CANDIDATE',
      'STRAT_EVAL',
      'STRAT_EVAL',
      'STRAT_EVAL',
      'RANK',
      'SIZING',
      'RISK_GATE',
      'ORDER_INTENT',
      'SIM_FILL',
      'POSITION',
    ]);
    expect(
      published
        .filter((event) => event.type !== 'QUOTE')
        .every((event) => BigInt(event.ts_ns) === BigInt(snapshot.created_ts_ns)),
    ).toBe(true);
    expect(result.candidate_events[0]!.payload.strategy_config_hash).toBe(
      container.config.strategyConfig?.lineage.strategy_config_hash,
    );
    expect(result.position_events[0]!.config?.config_hash).toBe(container.config.lineage.config_hash);
  });

  it('routes risk rejection without submitting simulated orders', async () => {
    const { runner } = createRunner({ initialOpenTradeCount: 3 });
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long.snapshot;

    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    const result = await runner.processFeatureSnapshot(snapshot);

    expect(result.risk_gate_events.map((event) => event.payload.status)).toEqual(['reject']);
    expect(result.risk_gate_events[0]!.payload.reasons).toContain(
      'session_risk:max_open_trade_count_reached',
    );
    expect(result.order_intent_events).toEqual([]);
    expect(result.sim_fill_events).toEqual([]);
    expect(result.position_events).toEqual([]);
    expect(result.session_risk.rejected_trade_count).toBe(1);
  });

  it('drives open positions through management ticks with causation-safe timestamps', async () => {
    const { runner } = createRunner();
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long.snapshot;
    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    const cycle = await runner.processFeatureSnapshot(snapshot);
    const openPosition = cycle.open_positions[0]!;
    const managementTs = ns(BigInt(snapshot.created_ts_ns) + 60_000_000_000n);
    const managementSource = await runner.publishExternalEvent(
      sourceQuoteEvent('source-management-tick-1', managementTs),
    );

    const result = await runner.processManagementTick({
      cause_event: managementSource,
      mark_price: openPosition.targets[1]!.price,
      high_price: openPosition.targets[1]!.price,
      low_price: openPosition.entry_price,
      authority: 'authoritative',
    });

    expect(result.management_tick_events).toHaveLength(1);
    expect(result.management_action_events.map((event) => event.payload.action_type)).toEqual([
      'TAKE_PROFIT',
    ]);
    expect(result.management_action_events.every((event) => (
      String(event.causation_id) === String(result.management_tick_events[0]!.event_id) &&
      BigInt(event.ts_ns) === BigInt(managementTs)
    ))).toBe(true);
    expect(result.open_positions).toEqual([]);
    expect(result.session_risk?.closed_trade_count).toBe(1);
    expect(result.position_events[0]!.payload.strategy_config_hash).toBe(
      cycle.position_events[0]!.payload.strategy_config_hash,
    );
  });

  it('resets session risk state on SESSION_PHASE without wall-clock input', async () => {
    const { runner } = createRunner({ initialOpenTradeCount: 2 });
    const sessionEvent = createJournalEventEnvelope({
      event_id: makeEventId('session-phase-new-rth'),
      type: 'SESSION_PHASE',
      ts_ns: ns(1_776_960_000_000_000_000n),
      run_id: RUN_ID,
      session_id: makeSessionId('2026-04-24-rth'),
      payload: {
        phase: 'rth' as const,
        trading_date: '2026-04-24',
      },
    });

    await runner.processSessionPhase(sessionEvent);

    expect(runner.snapshot().session_risk).toMatchObject({
      session_id: '2026-04-24-rth',
      open_trade_count: 0,
      closed_trade_count: 0,
      rejected_trade_count: 0,
      circuit_breaker_state: 'inactive',
    });
  });

  it('keeps orchestration free of legacy imports and nondeterministic helpers', () => {
    const forbiddenPatterns = [
      /\blegacy_seed\b/,
      /\blegacy_reference\b/,
      /\bsrc\/autotrade\b/,
      /\bDate\.now\b/,
      /\bnew Date\s*\(/,
      /\bMath\.random\b/,
      /\btoLocaleString\b/,
      /\blocaleCompare\b/,
    ];
    const findings = listOrchestrationSourceFiles().flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbiddenPatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${file}: ${pattern}`);
    });

    expect(findings).toEqual([]);
  });

  it('produces byte-stable runner snapshots across repeated equivalent cycles', async () => {
    const first = createRunner();
    const second = createRunner();
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long.snapshot;

    await first.runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    await second.runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    await first.runner.processFeatureSnapshot(snapshot);
    await second.runner.processFeatureSnapshot(snapshot);

    expect(stableSnapshot(first.runner.snapshot())).toBe(
      stableSnapshot(second.runner.snapshot()),
    );
  });
});

function stableSnapshot(value: unknown): string {
  return stableJsonStringify(
    JSON.parse(JSON.stringify(value, (_key, item: unknown) => (
      typeof item === 'bigint' ? item.toString() : item
    ))) as JsonValue,
  );
}
