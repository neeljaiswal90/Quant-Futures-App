import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAppConfig } from '../../src/config/index.js';
import {
  ACTIVE_STRATEGY_IDS,
  createJournalEventEnvelope,
  makeEventId,
  makeFeatureSnapshotId,
  makeRunId,
  makeSessionId,
  ns,
  stableJsonStringify,
  validateJournalEventEnvelope,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
  type JsonValue,
  type SimulatedOrderResult,
} from '../../src/contracts/index.js';
import {
  createSimulatedExecutionAdapter,
  SIMULATED_EXECUTION_VERSION,
  type SimulatedExecutionAdapter,
} from '../../src/execution/simulated-execution.js';
import {
  collectRuntimeShadowReadGuardViolations,
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
import type { StrategyFeatureSnapshot } from '../../src/strategies/index.js';

const RUN_ID = makeRunId('run-orch-02');
const SESSION_ID = makeSessionId('2026-04-23-rth');
const RTH_TS = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot.created_ts_ns;
const ETH_TS = ns('1776983400000000000');
const MAINTENANCE_TS = ns('1776979800000000000');
const ROLL_BLOCK_TS = ns('1781271600000000000');
const ROLL_FLATTEN_TS = ns('1781270760000000000');

function createRunner(options: {
  readonly initialOpenTradeCount?: number;
  readonly riskPolicy?: PartialRiskPolicyConfig;
  readonly executionAdapter?: SimulatedExecutionAdapter;
} = {}) {
  const config = loadAppConfig({
    configPath: 'config/app.example.json',
    cwd: process.cwd(),
    env: {
      QFA_JOURNAL_DIR: 'journals/test-orch-02',
    },
  });
  const container = createStrategyRuntimeEngineContainer({ config });
  const executionAdapter = options.executionAdapter ?? createSimulatedExecutionAdapter({
    venue_costs: loadVenueCostTable(),
  });
  const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
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
      initial_session_risk_state: initial,
      risk_policy: options.riskPolicy,
    }),
  };
}

function createRejectingExecutionAdapter(reason: string): SimulatedExecutionAdapter {
  return {
    adapter: 'simulated',
    version: SIMULATED_EXECUTION_VERSION,
    async submit(input) {
      return rejectedOrderResult(input.intent.order_intent_id, input.intent.submitted_ts_ns, reason);
    },
    async cancel(input) {
      return rejectedOrderResult(input.order_intent_id, input.submitted_ts_ns, input.reason);
    },
  };
}

function createFillThenRejectExecutionAdapter(reason: string): SimulatedExecutionAdapter {
  const fillingAdapter = createSimulatedExecutionAdapter({
    venue_costs: loadVenueCostTable(),
  });
  let submitCount = 0;
  return {
    adapter: 'simulated',
    version: SIMULATED_EXECUTION_VERSION,
    async submit(input) {
      submitCount += 1;
      if (submitCount === 1) {
        return fillingAdapter.submit(input);
      }
      return rejectedOrderResult(input.intent.order_intent_id, input.intent.submitted_ts_ns, reason);
    },
    async cancel(input) {
      return fillingAdapter.cancel(input);
    },
  };
}

function rejectedOrderResult(
  orderIntentId: SimulatedOrderResult['order_intent_id'],
  submittedTsNs: SimulatedOrderResult['submitted_ts_ns'],
  reason: string,
): SimulatedOrderResult {
  return {
    order_intent_id: orderIntentId,
    status: 'rejected',
    submitted_ts_ns: submittedTsNs,
    fills: [],
    reject_reason: reason,
  };
}

function sourceQuoteEvent(
  eventId: string,
  tsNs = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot.created_ts_ns,
  overrides: Partial<JournalEventPayloadFor<'QUOTE'>> = {},
): JournalEventEnvelope<'QUOTE', JournalEventPayloadFor<'QUOTE'>> {
  const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
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

function snapshotAt(input: {
  readonly id: string;
  readonly sourceEventId: string;
  readonly tsNs: ReturnType<typeof ns>;
  readonly sessionPhase?: StrategyFeatureSnapshot['session']['phase'];
  readonly isRth?: boolean;
  readonly isRollBlock?: boolean;
}): StrategyFeatureSnapshot {
  const base = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
  return {
    ...base,
    feature_snapshot_id: makeFeatureSnapshotId(input.id),
    source_event_id: makeEventId(input.sourceEventId),
    created_ts_ns: input.tsNs,
    session: {
      ...base.session,
      phase: input.sessionPhase ?? base.session.phase,
      is_rth: input.isRth ?? base.session.is_rth,
      is_roll_block: input.isRollBlock ?? base.session.is_roll_block,
    },
  };
}

async function openPositionFromSnapshot(
  runner: StrategyRuntimeRunner,
  snapshot: StrategyFeatureSnapshot,
) {
  await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id), snapshot.created_ts_ns, {
    bid_px: snapshot.quote.bid_px,
    ask_px: snapshot.quote.ask_px,
  }));
  return runner.processFeatureSnapshot(snapshot);
}

async function processRollFlattenSnapshot(
  runner: StrategyRuntimeRunner,
  input: {
    readonly id: string;
    readonly tsNs?: ReturnType<typeof ns>;
  },
) {
  const snapshot = snapshotAt({
    id: input.id,
    sourceEventId: `source-${input.id}`,
    tsNs: input.tsNs ?? ROLL_FLATTEN_TS,
    sessionPhase: 'eth',
    isRth: false,
    isRollBlock: true,
  });
  await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id), snapshot.created_ts_ns));
  return runner.processFeatureSnapshot(snapshot);
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
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;

    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    const result = await runner.processFeatureSnapshot(snapshot);

    expect(result.strategy_evaluation_events).toHaveLength(ACTIVE_STRATEGY_IDS.length);
    expect(result.candidate_events.length).toBeGreaterThan(0);
    expect([...result.rank_event.payload.ranked_candidate_ids].sort()).toEqual(
      result.candidate_events.map((event) => event.payload.candidate_id).sort(),
    );
    expect(result.sizing_events).toHaveLength(1);
    expect(result.risk_gate_events.map((event) => event.payload.status)).toEqual(['pass']);
    expect(result.order_intent_events).toHaveLength(1);
    expect(result.sim_fill_events).toHaveLength(1);
    expect(result.position_events).toHaveLength(1);
    expect(result.session_risk.open_trade_count).toBe(1);

    const publishedTypes = published.map((event) => event.type);
    expect(publishedTypes.slice(0, 3)).toEqual(['QUOTE', 'SESSION_PHASE', 'FEATURES']);
    expect(publishedTypes.filter((type) => type === 'STRAT_EVAL')).toHaveLength(
      ACTIVE_STRATEGY_IDS.length,
    );
    expect(publishedTypes.filter((type) => type === 'CANDIDATE')).toHaveLength(
      result.candidate_events.length,
    );
    expect(publishedTypes.slice(-5)).toEqual([
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
    expect(result.session_phase_event?.payload).toMatchObject({
      phase: 'rth',
      session_phase: 'rth',
      trading_date: '2026-04-23',
      candidate_eligible: true,
      should_flatten: false,
    });
    expect(result.mnq_eligibility).toMatchObject({
      session_phase: 'rth',
      candidate_eligible: true,
      active_contract: 'MNQM6',
    });
    expect(result.candidate_events[0]!.payload.strategy_config_hash).toBe(
      container.config.strategyConfig?.lineage.strategy_config_hash,
    );
    expect(result.position_events[0]!.config?.config_hash).toBe(container.config.lineage.config_hash);
    expect(result.sizing_events[0]!.payload.risk_config_hash).toBe(
      container.config.riskConfig?.lineage.risk_config_hash,
    );
    expect(result.risk_gate_events[0]!.payload.risk_config_hash).toBe(
      container.config.riskConfig?.lineage.risk_config_hash,
    );
    expect(result.position_events[0]!.payload.management_profile_hash).toBe(
      container.config.managementProfiles?.profiles.vwap_overnight_reversal_long.profile_hash,
    );
  });

  it('refuses shadow payload sections before strategy evaluation', async () => {
    const { container, runner } = createRunner();
    const published: JournalEventEnvelope[] = [];
    container.eventBus.subscribe({}, (delivery) => {
      published.push(delivery.event);
    });
    const base = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
    const snapshot = {
      ...base,
      microstructure: {
        ...base.microstructure,
        shadow_values: {
          cancel_add_ratio_shadow: 1,
        },
      },
    } as unknown as StrategyFeatureSnapshot;

    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));

    await expect(runner.processFeatureSnapshot(snapshot)).rejects.toThrow(
      'Runtime shadow-read guard refused strategy snapshot field $.microstructure.shadow_values',
    );
    expect(published.map((event) => event.type)).toEqual(['QUOTE']);
  });

  it('refuses non-authoritative MBO or shadow fields laundered into decision maps', () => {
    const base = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
    const snapshot = {
      ...base,
      indicators: {
        ...base.indicators,
        cancel_add_ratio_shadow: 1,
      },
      microstructure: {
        ...base.microstructure,
        values: {
          ...base.microstructure.values,
          mbo_microprice_offset_ticks: 0.25,
        },
      },
    } as unknown as StrategyFeatureSnapshot;

    expect(collectRuntimeShadowReadGuardViolations(snapshot)).toEqual([
      {
        path: '$.indicators.cancel_add_ratio_shadow',
        reason: 'non_authoritative_feature_field',
      },
      {
        path: '$.microstructure.values.mbo_microprice_offset_ticks',
        reason: 'non_authoritative_feature_field',
      },
    ]);
  });

  it('blocks candidates outside RTH with stable STRAT_EVAL reasons', async () => {
    const { runner } = createRunner();
    const snapshot = snapshotAt({
      id: 'fixture-eth-blocked',
      sourceEventId: 'source-eth-blocked',
      tsNs: ETH_TS,
      sessionPhase: 'eth',
      isRth: false,
    });

    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id), ETH_TS));
    const result = await runner.processFeatureSnapshot(snapshot);

    expect(result.mnq_eligibility).toMatchObject({
      session_phase: 'eth',
      journal_phase: 'eth',
      candidate_eligible: false,
      block_reason: 'outside_rth',
    });
    expect(result.session_phase_event?.payload).toMatchObject({
      phase: 'eth',
      session_phase: 'eth',
    });
    expect(result.session_phase_event?.causation_id).toBe(snapshot.source_event_id);
    expect(result.session_phase_event?.ts_ns).toBe(snapshot.created_ts_ns);
    expect(result.candidate_events).toEqual([]);
    expect(result.sizing_events).toEqual([]);
    expect(result.strategy_evaluation_events).toHaveLength(ACTIVE_STRATEGY_IDS.length);
    expect(result.strategy_evaluation_events.every((event) => (
      event.payload.gate_state === 'blocked' &&
      event.payload.reasons.includes('mnq_eligibility:outside_rth')
    ))).toBe(true);
    expect(result.rank_event.payload.ranked_candidate_ids).toEqual([]);
  });

  it('emits SESSION_PHASE for maintenance halt and suppresses duplicate phase ticks', async () => {
    const { runner } = createRunner();
    const first = snapshotAt({
      id: 'fixture-maintenance-1',
      sourceEventId: 'source-maintenance-1',
      tsNs: MAINTENANCE_TS,
      sessionPhase: 'maintenance',
      isRth: false,
    });
    const second = snapshotAt({
      id: 'fixture-maintenance-2',
      sourceEventId: 'source-maintenance-2',
      tsNs: ns(BigInt(MAINTENANCE_TS) + 60_000_000_000n),
      sessionPhase: 'maintenance',
      isRth: false,
    });

    await runner.publishExternalEvent(sourceQuoteEvent(String(first.source_event_id), first.created_ts_ns));
    const firstResult = await runner.processFeatureSnapshot(first);
    await runner.publishExternalEvent(sourceQuoteEvent(String(second.source_event_id), second.created_ts_ns));
    const secondResult = await runner.processFeatureSnapshot(second);

    expect(firstResult.session_phase_event?.payload).toMatchObject({
      phase: 'maintenance',
      session_phase: 'maintenance',
      block_reason: 'maintenance_halt',
      candidate_eligible: false,
    });
    expect(firstResult.session_phase_event?.causation_id).toBe(first.source_event_id);
    expect(firstResult.session_phase_event?.ts_ns).toBe(first.created_ts_ns);
    expect(firstResult.candidate_events).toEqual([]);
    expect(secondResult.session_phase_event).toBeUndefined();
    expect(secondResult.candidate_events).toEqual([]);
  });

  it('emits roll block and flatten advisories only on meaningful transitions', async () => {
    const { runner } = createRunner();
    const block = snapshotAt({
      id: 'fixture-roll-block',
      sourceEventId: 'source-roll-block',
      tsNs: ROLL_BLOCK_TS,
      isRollBlock: true,
    });
    const sameBlock = snapshotAt({
      id: 'fixture-roll-block-repeat',
      sourceEventId: 'source-roll-block-repeat',
      tsNs: ns(BigInt(ROLL_BLOCK_TS) + 60_000_000_000n),
      isRollBlock: true,
    });
    const flatten = snapshotAt({
      id: 'fixture-roll-flatten',
      sourceEventId: 'source-roll-flatten',
      tsNs: ROLL_FLATTEN_TS,
      sessionPhase: 'eth',
      isRth: false,
      isRollBlock: true,
    });

    await runner.publishExternalEvent(sourceQuoteEvent(String(block.source_event_id), block.created_ts_ns));
    const blockResult = await runner.processFeatureSnapshot(block);
    await runner.publishExternalEvent(sourceQuoteEvent(String(sameBlock.source_event_id), sameBlock.created_ts_ns));
    const repeatResult = await runner.processFeatureSnapshot(sameBlock);
    await runner.publishExternalEvent(sourceQuoteEvent(String(flatten.source_event_id), flatten.created_ts_ns));
    const flattenResult = await runner.processFeatureSnapshot(flatten);

    expect(blockResult.roll_advisory_event?.payload).toMatchObject({
      advisory: 'block_new_entries',
      active_symbol: 'MNQU6',
      next_symbol: 'MNQU6',
      roll_phase: 'roll_block',
      candidate_eligible: false,
      block_reason: 'roll_block_window',
      should_flatten: false,
    });
    expect(blockResult.candidate_events).toEqual([]);
    expect(repeatResult.roll_advisory_event).toBeUndefined();
    expect(flattenResult.roll_advisory_event?.payload).toMatchObject({
      advisory: 'flatten_required',
      active_symbol: 'MNQM6',
      next_symbol: 'MNQU6',
      roll_phase: 'roll_block',
      block_reason: 'outside_rth',
      should_flatten: true,
    });
    expect(flattenResult.roll_advisory_event?.causation_id).toBe(flatten.source_event_id);
    expect(flattenResult.roll_advisory_event?.ts_ns).toBe(flatten.created_ts_ns);
  });

  it('forces a full exit for an open long position in the roll flatten window', async () => {
    const { runner } = createRunner();
    const opening = await openPositionFromSnapshot(
      runner,
      STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot,
    );
    const openPosition = opening.open_positions[0]!;

    const result = await processRollFlattenSnapshot(runner, { id: 'fixture-roll-flatten-long' });

    expect(result.roll_advisory_event?.payload.advisory).toBe('flatten_required');
    expect(result.forced_flatten_action_events).toHaveLength(1);
    expect(result.forced_flatten_action_events[0]!.payload).toMatchObject({
      action_type: 'EXIT_FULL',
      reason: 'roll_window_flatten',
      position_id: openPosition.position_id,
      exit_quantity: openPosition.remaining_quantity,
      management_profile_hash: openPosition.profile_hash,
      management_profile_id: openPosition.profile_id,
      management_profile_version: openPosition.profile_version,
      position_manager_version: 'position_manager_fsm_v1',
      active_contract: 'MNQM6',
      next_contract: 'MNQU6',
      roll_phase: 'roll_block',
    });
    expect(result.forced_flatten_action_events[0]!.payload.cutover_ts_ns).toBe(ns('1781271000000000000'));
    expect(result.forced_flatten_action_events[0]!.causation_id).toBe(
      result.roll_advisory_event!.event_id,
    );
    expect(result.forced_flatten_action_events[0]!.ts_ns).toBe(ROLL_FLATTEN_TS);
    expect(validateJournalEventEnvelope(result.forced_flatten_action_events[0]!)).toMatchObject({
      ok: true,
      issues: [],
    });
    expect(result.order_intent_events).toHaveLength(1);
    expect(result.order_intent_events[0]!.payload).toMatchObject({
      side: 'sell',
      quantity: openPosition.remaining_quantity,
      management_action_id: result.forced_flatten_action_events[0]!.payload.management_action_id,
      position_id: openPosition.position_id,
      management_profile_hash: openPosition.profile_hash,
    });
    expect(result.order_intent_events[0]!.causation_id).toBe(
      result.forced_flatten_action_events[0]!.event_id,
    );
    expect(result.sim_fill_events).toHaveLength(1);
    expect(result.sim_fill_events[0]!.causation_id).toBe(result.order_intent_events[0]!.event_id);
    expect(result.position_events).toHaveLength(1);
    expect(result.position_events[0]!.causation_id).toBe(result.sim_fill_events[0]!.event_id);
    expect(result.position_events[0]!.payload).toMatchObject({
      position_id: openPosition.position_id,
      side: 'flat',
      status: 'closed',
      quantity_open: 0,
    });
    expect(result.open_positions).toEqual([]);
  });

  it('forces a full exit for an open short position in the roll flatten window', async () => {
    const { runner } = createRunner();
    const opening = await openPositionFromSnapshot(
      runner,
      STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_short.snapshot,
    );
    const openPosition = opening.open_positions[0]!;

    const result = await processRollFlattenSnapshot(runner, { id: 'fixture-roll-flatten-short' });

    expect(openPosition.side).toBe('short');
    expect(result.forced_flatten_action_events).toHaveLength(1);
    expect(result.forced_flatten_action_events[0]!.payload).toMatchObject({
      action_type: 'EXIT_FULL',
      reason: 'roll_window_flatten',
      position_id: openPosition.position_id,
      exit_quantity: openPosition.remaining_quantity,
    });
    expect(result.order_intent_events[0]!.payload.side).toBe('buy');
    expect(result.sim_fill_events).toHaveLength(1);
    expect(result.position_events[0]!.payload.status).toBe('closed');
  });

  it('journals rejected roll forced-flatten execution without closing the position', async () => {
    const { runner } = createRunner({
      executionAdapter: createFillThenRejectExecutionAdapter('sim_reject:roll_flatten_no_fill'),
    });
    const opening = await openPositionFromSnapshot(
      runner,
      STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot,
    );
    const openPosition = opening.open_positions[0]!;

    const result = await processRollFlattenSnapshot(runner, { id: 'fixture-roll-flatten-reject' });

    expect(result.forced_flatten_action_events).toHaveLength(1);
    expect(result.order_intent_events).toHaveLength(1);
    expect(result.sim_fill_events).toEqual([]);
    expect(result.exec_reject_events).toHaveLength(1);
    expect(result.exec_reject_events[0]!.causation_id).toBe(result.order_intent_events[0]!.event_id);
    expect(result.exec_reject_events[0]!.payload).toMatchObject({
      order_intent_id: result.order_intent_events[0]!.payload.order_intent_id,
      management_action_id: result.forced_flatten_action_events[0]!.payload.management_action_id,
      position_id: openPosition.position_id,
      reason: 'sim_reject:roll_flatten_no_fill',
      status: 'rejected',
    });
    expect(validateJournalEventEnvelope(result.exec_reject_events[0]!)).toMatchObject({
      ok: true,
      issues: [],
    });
    expect(result.open_positions.map((position) => position.position_id)).toEqual([
      openPosition.position_id,
    ]);
  });

  it('emits roll forced-flatten actions in deterministic position-id order', async () => {
    const { runner } = createRunner();
    await openPositionFromSnapshot(
      runner,
      STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot,
    );
    await openPositionFromSnapshot(
      runner,
      STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_short.snapshot,
    );
    const expectedOrder = runner.snapshot().open_positions
      .map((position) => String(position.position_id))
      .sort();

    const result = await processRollFlattenSnapshot(runner, { id: 'fixture-roll-flatten-many' });

    expect(result.forced_flatten_action_events.map((event) => String(event.payload.position_id))).toEqual(
      expectedOrder,
    );
    expect(result.forced_flatten_action_events.map((event) => event.payload.action_type)).toEqual([
      'EXIT_FULL',
      'EXIT_FULL',
    ]);
    expect(result.order_intent_events.map((event) => String(event.payload.position_id))).toEqual(
      expectedOrder,
    );
    expect(result.sim_fill_events).toHaveLength(2);
    expect(result.open_positions).toEqual([]);
  });

  it('emits roll advisory but no forced-flatten action when no positions are open', async () => {
    const { runner } = createRunner();

    const result = await processRollFlattenSnapshot(runner, { id: 'fixture-roll-flatten-empty' });

    expect(result.roll_advisory_event?.payload.advisory).toBe('flatten_required');
    expect(result.forced_flatten_action_events).toEqual([]);
    expect(result.order_intent_events).toEqual([]);
    expect(result.sim_fill_events).toEqual([]);
  });

  it('does not force-flatten during ordinary roll blocks or maintenance halts', async () => {
    const { runner } = createRunner();
    await openPositionFromSnapshot(
      runner,
      STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot,
    );
    const rollBlock = snapshotAt({
      id: 'fixture-roll-block-no-flatten',
      sourceEventId: 'source-roll-block-no-flatten',
      tsNs: ROLL_BLOCK_TS,
      isRollBlock: true,
    });
    await runner.publishExternalEvent(sourceQuoteEvent(String(rollBlock.source_event_id), rollBlock.created_ts_ns));
    const rollBlockResult = await runner.processFeatureSnapshot(rollBlock);
    const maintenance = snapshotAt({
      id: 'fixture-maintenance-no-flatten',
      sourceEventId: 'source-maintenance-no-flatten',
      tsNs: MAINTENANCE_TS,
      sessionPhase: 'maintenance',
      isRth: false,
    });
    await runner.publishExternalEvent(sourceQuoteEvent(String(maintenance.source_event_id), maintenance.created_ts_ns));
    const maintenanceResult = await runner.processFeatureSnapshot(maintenance);

    expect(rollBlockResult.roll_advisory_event?.payload.advisory).toBe('block_new_entries');
    expect(rollBlockResult.forced_flatten_action_events).toEqual([]);
    expect(rollBlockResult.order_intent_events).toEqual([]);
    expect(maintenanceResult.mnq_eligibility.block_reason).toBe('maintenance_halt');
    expect(maintenanceResult.forced_flatten_action_events).toEqual([]);
    expect(maintenanceResult.order_intent_events).toEqual([]);
  });

  it('suppresses duplicate forced-flatten actions in the same roll flatten window', async () => {
    const { runner } = createRunner();
    await openPositionFromSnapshot(
      runner,
      STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot,
    );

    const first = await processRollFlattenSnapshot(runner, { id: 'fixture-roll-flatten-duplicate-1' });
    const second = await processRollFlattenSnapshot(runner, {
      id: 'fixture-roll-flatten-duplicate-2',
      tsNs: ns(BigInt(ROLL_FLATTEN_TS) + 60_000_000_000n),
    });

    expect(first.forced_flatten_action_events).toHaveLength(1);
    expect(first.order_intent_events).toHaveLength(1);
    expect(second.roll_advisory_event).toBeUndefined();
    expect(second.forced_flatten_action_events).toEqual([]);
    expect(second.order_intent_events).toEqual([]);
  });

  it('produces deterministic roll forced-flatten output across repeated equivalent runs', async () => {
    const first = createRunner();
    const second = createRunner();
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
    await openPositionFromSnapshot(first.runner, snapshot);
    await openPositionFromSnapshot(second.runner, snapshot);

    const firstFlatten = await processRollFlattenSnapshot(first.runner, {
      id: 'fixture-roll-flatten-deterministic',
    });
    const secondFlatten = await processRollFlattenSnapshot(second.runner, {
      id: 'fixture-roll-flatten-deterministic',
    });

    expect(stableSnapshot(firstFlatten.forced_flatten_action_events)).toBe(
      stableSnapshot(secondFlatten.forced_flatten_action_events),
    );
  });

  it('keeps existing-position management active while new entries are blocked', async () => {
    const { runner } = createRunner();
    const openingSnapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
    await runner.publishExternalEvent(sourceQuoteEvent(String(openingSnapshot.source_event_id)));
    const opening = await runner.processFeatureSnapshot(openingSnapshot);
    const openPosition = opening.open_positions[0]!;
    const blockedSnapshot = snapshotAt({
      id: 'fixture-eth-management-block',
      sourceEventId: 'source-eth-management-block',
      tsNs: ETH_TS,
      sessionPhase: 'eth',
      isRth: false,
    });
    const blockedSource = await runner.publishExternalEvent(
      sourceQuoteEvent(String(blockedSnapshot.source_event_id), blockedSnapshot.created_ts_ns),
    );
    const blocked = await runner.processFeatureSnapshot(blockedSnapshot);
    const management = await runner.processManagementTick({
      cause_event: blockedSource,
      mark_price: openPosition.entry_price,
      high_price: openPosition.entry_price,
      low_price: openPosition.entry_price,
      bid_px: openPosition.entry_price - 0.25,
      ask_px: openPosition.entry_price + 0.25,
      authority: 'authoritative',
    });

    expect(blocked.candidate_events).toEqual([]);
    expect(blocked.strategy_evaluation_events[0]!.payload.reasons).toContain(
      'mnq_eligibility:outside_rth',
    );
    expect(management.management_tick_events).toHaveLength(1);
    expect(management.management_tick_events[0]!.ts_ns).toBe(blockedSnapshot.created_ts_ns);
    expect(management.management_results).toHaveLength(1);
  });

  it('emits OBS-valid and causation-linked session and roll events', async () => {
    const { runner } = createRunner();
    const snapshot = snapshotAt({
      id: 'fixture-roll-schema',
      sourceEventId: 'source-roll-schema',
      tsNs: ROLL_BLOCK_TS,
      isRollBlock: true,
    });

    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id), snapshot.created_ts_ns));
    const result = await runner.processFeatureSnapshot(snapshot);
    const emitted: JournalEventEnvelope[] = [];
    if (result.session_phase_event !== undefined) {
      emitted.push(result.session_phase_event);
    }
    if (result.roll_advisory_event !== undefined) {
      emitted.push(result.roll_advisory_event);
    }

    expect(emitted).toHaveLength(2);
    for (const event of emitted) {
      expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
      expect(event.causation_id).toBe(snapshot.source_event_id);
      expect(event.ts_ns).toBe(snapshot.created_ts_ns);
    }
  });

  it('routes risk rejection without submitting simulated orders', async () => {
    const { runner } = createRunner({ initialOpenTradeCount: 3 });
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;

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

  it('journals rejected entry execution without emitting fills', async () => {
    const { runner } = createRunner({
      executionAdapter: createRejectingExecutionAdapter('sim_reject:no_liquidity'),
    });
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;

    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    const result = await runner.processFeatureSnapshot(snapshot);

    expect(result.order_intent_events).toHaveLength(1);
    expect(result.sim_fill_events).toEqual([]);
    expect(result.position_events).toEqual([]);
    expect(result.open_positions).toEqual([]);
    expect(result.exec_reject_events).toHaveLength(1);
    expect(result.exec_reject_events[0]!.causation_id).toBe(result.order_intent_events[0]!.event_id);
    expect(result.exec_reject_events[0]!.ts_ns).toBe(result.order_intent_events[0]!.ts_ns);
    expect(result.exec_reject_events[0]!.payload).toMatchObject({
      order_intent_id: result.order_intent_events[0]!.payload.order_intent_id,
      status: 'rejected',
      reason: 'sim_reject:no_liquidity',
      execution_adapter: 'simulated',
      execution_version: SIMULATED_EXECUTION_VERSION,
    });
    expect(validateJournalEventEnvelope(result.exec_reject_events[0]!)).toMatchObject({
      ok: true,
      issues: [],
    });
  });

  it('drives open positions through management ticks with causation-safe timestamps', async () => {
    const { runner } = createRunner();
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
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
      bid_px: openPosition.targets[1]!.price - 0.25,
      ask_px: openPosition.targets[1]!.price + 0.25,
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
    expect(result.order_intent_events).toHaveLength(1);
    expect(result.order_intent_events[0]!.payload).toMatchObject({
      side: 'sell',
      quantity: openPosition.remaining_quantity,
      management_action_id: result.management_action_events[0]!.payload.management_action_id,
      position_id: openPosition.position_id,
      management_profile_hash: openPosition.profile_hash,
      position_manager_version: 'position_manager_fsm_v1',
    });
    expect(result.order_intent_events[0]!.causation_id).toBe(
      result.management_action_events[0]!.event_id,
    );
    expect(result.sim_fill_events).toHaveLength(1);
    expect(result.sim_fill_events[0]!.causation_id).toBe(result.order_intent_events[0]!.event_id);
    expect(result.open_positions).toEqual([]);
    expect(result.session_risk?.closed_trade_count).toBe(1);
    expect(result.position_events[0]!.causation_id).toBe(result.sim_fill_events[0]!.event_id);
    expect(result.position_events[0]!.payload).toMatchObject({
      position_id: openPosition.position_id,
      status: 'closed',
      quantity_open: 0,
    });
    expect(result.position_events[0]!.payload.strategy_config_hash).toBe(
      cycle.position_events[0]!.payload.strategy_config_hash,
    );
    expect(result.management_tick_events[0]!.payload.management_profile_hash).toBe(
      cycle.open_positions[0]!.profile_hash,
    );
    expect(result.management_action_events[0]!.payload.management_profile_hash).toBe(
      cycle.open_positions[0]!.profile_hash,
    );
  });

  it('executes PT1 TAKE_PARTIAL through ORDER_INTENT, SIM_FILL, and POSITION updates', async () => {
    const { runner } = createRunner({
      riskPolicy: {
        account_equity_usd: 500_000,
        max_risk_per_trade_pct: 2,
        max_net_position_per_symbol: 10,
        hard_cap_contracts: 10,
        sizing_mode: 'replay',
        default_n_eff: 10_000,
        default_regime: 'mixed',
        sizing: {
          C_abs: 10,
          C_base: 100,
        },
        session: {
          max_open_trade_count: 10,
          max_trades_per_session: 20,
          max_daily_realized_loss_usd: 100_000,
        },
      },
    });
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    const cycle = await runner.processFeatureSnapshot(snapshot);
    const openedPosition = cycle.open_positions[0]!;
    const openPosition = {
      ...openedPosition,
      quantity: 4,
      remaining_quantity: 4,
      targets: openedPosition.targets.map((target) => ({
        ...target,
        quantity: target.label === 'pt1' || target.label === 'pt2' ? 2 : target.quantity,
        filled_quantity: 0,
        status: 'pending' as const,
      })),
    } satisfies typeof openedPosition;
    (runner as unknown as { openPositions: typeof cycle.open_positions }).openPositions = [
      openPosition,
    ];
    const pt1 = openPosition.targets.find((target) => target.label === 'pt1')!;
    const managementTs = ns(BigInt(snapshot.created_ts_ns) + 60_000_000_000n);
    const managementSource = await runner.publishExternalEvent(
      sourceQuoteEvent('source-management-partial-1', managementTs),
    );

    const result = await runner.processManagementTick({
      cause_event: managementSource,
      mark_price: pt1.price,
      high_price: pt1.price,
      low_price: openPosition.entry_price,
      bid_px: pt1.price - 0.25,
      ask_px: pt1.price + 0.25,
      authority: 'authoritative',
    });

    const partialAction = result.management_action_events.find(
      (event) => event.payload.action_type === 'TAKE_PARTIAL',
    );
    expect(partialAction?.payload).toMatchObject({
      position_id: openPosition.position_id,
      target_label: 'pt1',
      exit_quantity: pt1.quantity,
    });
    expect(result.order_intent_events).toHaveLength(1);
    expect(result.order_intent_events[0]!.causation_id).toBe(partialAction!.event_id);
    expect(result.sim_fill_events[0]!.causation_id).toBe(result.order_intent_events[0]!.event_id);
    expect(result.position_events[0]!.causation_id).toBe(result.sim_fill_events[0]!.event_id);
    expect(result.position_events[0]!.payload).toMatchObject({
      position_id: openPosition.position_id,
      status: 'closing',
      quantity_open: openPosition.remaining_quantity - pt1.quantity,
    });
    expect(result.open_positions[0]!.remaining_quantity).toBe(
      openPosition.remaining_quantity - pt1.quantity,
    );
  });

  it('executes fail-safe exits through simulated close fills', async () => {
    const { runner } = createRunner();
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    const cycle = await runner.processFeatureSnapshot(snapshot);
    const openPosition = cycle.open_positions[0]!;
    const managementTs = ns(BigInt(snapshot.created_ts_ns) + 60_000_000_000n);
    const managementSource = await runner.publishExternalEvent(
      sourceQuoteEvent('source-management-failsafe-1', managementTs),
    );

    const result = await runner.processManagementTick({
      cause_event: managementSource,
      mark_price: openPosition.entry_price,
      high_price: openPosition.entry_price,
      low_price: openPosition.entry_price,
      authority: 'gap',
      is_stale: true,
    });

    expect(result.management_action_events.map((event) => event.payload.action_type)).toEqual([
      'FAIL_SAFE_EXIT',
    ]);
    expect(result.order_intent_events[0]!.payload.management_action_id).toBe(
      result.management_action_events[0]!.payload.management_action_id,
    );
    expect(result.sim_fill_events).toHaveLength(1);
    expect(result.position_events[0]!.payload).toMatchObject({
      position_id: openPosition.position_id,
      status: 'closed',
      quantity_open: 0,
    });
    expect(result.open_positions).toEqual([]);
  });

  it('journals rejected fail-safe close attempts and keeps the position open', async () => {
    const { runner } = createRunner({
      executionAdapter: createFillThenRejectExecutionAdapter('sim_reject:failsafe_no_fill'),
    });
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    const cycle = await runner.processFeatureSnapshot(snapshot);
    const openPosition = cycle.open_positions[0]!;
    const managementTs = ns(BigInt(snapshot.created_ts_ns) + 60_000_000_000n);
    const managementSource = await runner.publishExternalEvent(
      sourceQuoteEvent('source-management-failsafe-reject-1', managementTs),
    );

    const result = await runner.processManagementTick({
      cause_event: managementSource,
      mark_price: openPosition.entry_price,
      high_price: openPosition.entry_price,
      low_price: openPosition.entry_price,
      authority: 'gap',
      is_stale: true,
    });

    expect(result.management_action_events.map((event) => event.payload.action_type)).toEqual([
      'FAIL_SAFE_EXIT',
    ]);
    expect(result.order_intent_events).toHaveLength(1);
    expect(result.sim_fill_events).toEqual([]);
    expect(result.exec_reject_events).toHaveLength(1);
    expect(result.exec_reject_events[0]!.payload.reason).toBe('sim_reject:failsafe_no_fill');
    expect(result.exec_reject_events[0]!.causation_id).toBe(result.order_intent_events[0]!.event_id);
    expect(result.position_events[0]!.causation_id).toBe(result.exec_reject_events[0]!.event_id);
    expect(result.position_events[0]!.payload).toMatchObject({
      position_id: openPosition.position_id,
      status: 'open',
      quantity_open: openPosition.remaining_quantity,
    });
    expect(result.open_positions[0]!.position_id).toBe(openPosition.position_id);
  });

  it('executes time-stop exits through simulated close fills', async () => {
    const { runner } = createRunner();
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    const cycle = await runner.processFeatureSnapshot(snapshot);
    const openPosition = cycle.open_positions[0]!;
    const managementTs = openPosition.time_stop.deadline_ts_ns!;
    const managementSource = await runner.publishExternalEvent(
      sourceQuoteEvent('source-management-time-stop-1', managementTs),
    );
    const timeStopExitPrice = openPosition.entry_price - (openPosition.risk_points * 0.3);

    const result = await runner.processManagementTick({
      cause_event: managementSource,
      mark_price: timeStopExitPrice,
      high_price: openPosition.entry_price,
      low_price: timeStopExitPrice,
      bid_px: timeStopExitPrice - 0.25,
      ask_px: timeStopExitPrice + 0.25,
      authority: 'authoritative',
    });

    expect(result.management_action_events.map((event) => event.payload.action_type)).toEqual([
      'TIME_STOP_EXIT',
    ]);
    expect(result.order_intent_events[0]!.causation_id).toBe(
      result.management_action_events[0]!.event_id,
    );
    expect(result.sim_fill_events[0]!.ts_ns).toBe(managementTs);
    expect(result.position_events[0]!.causation_id).toBe(result.sim_fill_events[0]!.event_id);
    expect(result.open_positions).toEqual([]);
  });

  it('journals rejected time-stop close attempts and keeps the position open', async () => {
    const { runner } = createRunner({
      executionAdapter: createFillThenRejectExecutionAdapter('sim_reject:timestop_no_fill'),
    });
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;
    await runner.publishExternalEvent(sourceQuoteEvent(String(snapshot.source_event_id)));
    const cycle = await runner.processFeatureSnapshot(snapshot);
    const openPosition = cycle.open_positions[0]!;
    const managementSource = await runner.publishExternalEvent(
      sourceQuoteEvent('source-management-time-stop-reject-1', openPosition.time_stop.deadline_ts_ns!),
    );
    const timeStopExitPrice = openPosition.entry_price - (openPosition.risk_points * 0.3);

    const result = await runner.processManagementTick({
      cause_event: managementSource,
      mark_price: timeStopExitPrice,
      high_price: openPosition.entry_price,
      low_price: timeStopExitPrice,
      bid_px: timeStopExitPrice - 0.25,
      ask_px: timeStopExitPrice + 0.25,
      authority: 'authoritative',
    });

    expect(result.management_action_events.map((event) => event.payload.action_type)).toEqual([
      'TIME_STOP_EXIT',
    ]);
    expect(result.order_intent_events).toHaveLength(1);
    expect(result.sim_fill_events).toEqual([]);
    expect(result.exec_reject_events).toHaveLength(1);
    expect(result.exec_reject_events[0]!.payload.reason).toBe('sim_reject:timestop_no_fill');
    expect(result.exec_reject_events[0]!.ts_ns).toBe(openPosition.time_stop.deadline_ts_ns);
    expect(validateJournalEventEnvelope(result.exec_reject_events[0]!)).toMatchObject({
      ok: true,
      issues: [],
    });
    expect(result.open_positions[0]!.position_id).toBe(openPosition.position_id);
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
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot;

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
