import {
  createJournalEventEnvelope,
  makeCausationId,
  makeEventId,
  makeFeatureSnapshotId,
  makeFillId,
  makeOrderIntentId,
  makePositionId,
  makeRunId,
  makeSessionId,
  makeSizingDecisionId,
  type AnyJournalEventEnvelope,
  type Candidate,
  type ConfigLineageRef,
  type InstrumentIdentity,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
} from '../../../strategy_runtime/src/contracts/index.js';
import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import { ns, type UnixNs } from '../../../strategy_runtime/src/contracts/time.js';
import {
  buildBars,
  DEFAULT_MNQ_ROLL_POLICY,
  type BuiltBar,
} from '../../../strategy_runtime/src/data/bar-builder/index.js';
import { loadDbnFile } from '../../../strategy_runtime/src/data/dbn-loader.js';
import type {
  DbnMbp1Record,
  DbnRecord,
} from '../../../strategy_runtime/src/data/dbn-types.js';
import {
  synthesizeQueue,
  type PassiveFillEstimate,
  type PassiveOrderProbe,
  type QueueSynthesisOutput,
} from '../../../strategy_runtime/src/data/queue-synthesis/index.js';
import {
  getActiveStrategyGenerator,
  type StrategyFeatureSnapshot,
} from '../../../strategy_runtime/src/strategies/index.js';
import {
  applyInitialFillToTargetPosition,
  buildTargetPositionFromCandidate,
  evaluatePositionManager,
  resolveManagementProfile,
  type ManagementProfile,
  type PositionManagerAction,
  type PositionManagerEvaluation,
  type TargetPosition,
} from '../../../strategy_runtime/src/management/index.js';
import type { SimulatedFill } from '../../../strategy_runtime/src/contracts/execution.js';
import { buildTradeLedger } from '../trade-ledger/index.js';
import {
  analyzeTradeLedger,
  type EquityMetricsOptions,
} from '../equity-metrics/index.js';
import { mergeMonotonicSources } from './source-merge.js';
import type {
  QueueAheadBucket,
  RealArchiveBacktestOptions,
  RealArchiveBacktestResult,
  RealArchiveExecutionFillPolicy,
  RealArchiveExitReason,
  RealArchivePerTradeRecord,
  RealArchiveRegimeLabel,
  RealArchiveSessionSource,
  RealArchiveStrategyGenerator,
  RealArchiveTopOfBook,
  SpreadBucket,
} from './types.js';

const DEFAULT_FILL_POLICY: RealArchiveExecutionFillPolicy = Object.freeze({
  fill_horizon_ns: 15_000_000_000n,
  depletion_lookback_ns: 60_000_000_000n,
  minimum_fill_probability_ppm: 500_000,
  order_quantity: 1,
  exchange_fee_usd: 0,
  commission_usd: 0,
});

const DEFAULT_VALUATION = Object.freeze({
  instrument_root: 'MNQ',
  tick_size: '0.25',
  tick_value_usd_cents: 50n,
});

const DEFAULT_CONFIG: ConfigLineageRef = Object.freeze({
  config_hash: '0'.repeat(64) as ConfigLineageRef['config_hash'],
  config_version: 1,
});

const TICK_SIZE = 0.25;
const PRICE_SCALE = 1_000_000_000;

interface OpenExecutionPosition {
  readonly candidate: Candidate;
  readonly entry_fill: JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>;
  readonly entry_estimate: PassiveFillEstimate;
  readonly entry_spread_bucket: SpreadBucket;
  readonly entry_queue_ahead_bucket: QueueAheadBucket;
  readonly quantity: number;
  readonly order_intent_id: ReturnType<typeof makeOrderIntentId>;
  readonly management_profile: ManagementProfile;
  readonly entry_bar_index: number;
  target_position: TargetPosition;
  mfe_cents: bigint;
  mae_cents: bigint;
}

interface MutableRuntimeMetrics {
  sessions_processed: number;
  bars_processed: number;
  candidate_count: number;
  order_intent_count: number;
  fill_count: number;
  closed_trade_count: number;
}

interface EntryMetadata {
  readonly spread_bucket: SpreadBucket;
  readonly queue_ahead_bucket: QueueAheadBucket;
  readonly estimate: PassiveFillEstimate;
  exit_reason?: RealArchiveExitReason;
  exit_bar_index?: number;
  max_favorable_excursion_cents?: bigint;
  max_adverse_excursion_cents?: bigint;
}

interface EventSequence {
  next(): number;
}

export async function runRealArchiveBacktest(
  options: RealArchiveBacktestOptions,
): Promise<RealArchiveBacktestResult> {
  validateOptions(options);
  const fillPolicy = { ...DEFAULT_FILL_POLICY, ...options.fill_policy };
  const valuation = options.valuation ?? DEFAULT_VALUATION;
  const equityOptions: EquityMetricsOptions = {
    initial_equity_cents: options.initial_equity_cents ?? 3_000_000n,
    valuation,
  };
  const runId = makeRunId(options.run_id);
  const startedAt = ns(options.run_started_at_ns);
  const sequence = createSequence();
  const events: AnyJournalEventEnvelope[] = [
    createJournalEventEnvelope({
      event_id: makeEventId(`evt-${options.run_id}-${padSequence(sequence.next())}`),
      type: 'BACKTEST_RUN_META',
      ts_ns: startedAt,
      run_id: runId,
      session_id: makeSessionId(`session-${options.run_id}`),
      payload: {
        run_spec_schema_version: 1,
        instrument_root: 'MNQ',
        bar_spec: options.bar_spec ?? '1m',
        backtest_window: {
          start: options.sessions[0]?.trading_date ?? 'unknown',
          end: options.sessions.at(-1)?.trading_date ?? 'unknown',
          mode: 'instant',
          inclusive_end: false,
          calendar: 'CME_US_INDEX_FUTURES',
        },
        determinism_seed: 0,
        strategy_ids: [options.strategy_id],
        corpus_inputs: [],
        config_inputs: [],
        runner_code_commit_sha: 'qfa-201b-real-archive-execution',
        runner_code_dirty: false,
        run_spec_hash: 'qfa-201b-real-archive-execution',
        run_started_at_ns: startedAt,
      },
    }) as AnyJournalEventEnvelope,
  ];
  const strategyGenerator = options.strategy_generator ?? getActiveStrategyGenerator(options.strategy_id);
  const entryMetadataByOrderIntentId = new Map<string, EntryMetadata>();
  const metrics: MutableRuntimeMetrics = {
    sessions_processed: 0,
    bars_processed: 0,
    candidate_count: 0,
    order_intent_count: 0,
    fill_count: 0,
    closed_trade_count: 0,
  };

  for (const session of options.sessions) {
    await runSession({
      options,
      session,
      fillPolicy,
      runId,
      sequence,
      events,
      entryMetadataByOrderIntentId,
      strategyGenerator,
      metrics,
    });
    metrics.sessions_processed += 1;
  }

  const ledger = buildTradeLedger(events, {
    run_id: runId,
    instrument_context: { instrument_id: 1, raw_symbol: options.sessions[0]?.raw_symbol ?? null },
  });
  const analysis = analyzeTradeLedger(ledger, equityOptions);
  const perTradeRecords = enrichTrades({
    ledger,
    analysis,
    events,
    sessions: options.sessions,
    entryMetadataByOrderIntentId,
  });
  metrics.closed_trade_count = perTradeRecords.length;

  return Object.freeze({
    result_schema_version: 1,
    run_id: runId,
    strategy_id: options.strategy_id,
    journal_events: Object.freeze(events),
    trade_ledger: ledger,
    trade_analysis: analysis,
    per_trade_records: Object.freeze(perTradeRecords),
    runtime_metrics: Object.freeze({ ...metrics }),
  });
}

async function runSession(input: {
  readonly options: RealArchiveBacktestOptions;
  readonly session: RealArchiveSessionSource;
  readonly fillPolicy: RealArchiveExecutionFillPolicy;
  readonly runId: ReturnType<typeof makeRunId>;
  readonly sequence: EventSequence;
  readonly events: AnyJournalEventEnvelope[];
  readonly entryMetadataByOrderIntentId: Map<string, EntryMetadata>;
  readonly strategyGenerator: RealArchiveStrategyGenerator;
  readonly metrics: MutableRuntimeMetrics;
}): Promise<void> {
  const sessionId = makeSessionId(input.session.session_id);
  const queueCursor = createRecordCursor(mergeMonotonicSources<DbnRecord>([
    {
      name: 'mbp-1',
      records: recordSource(input.session, 'mbp-1'),
      tsExtractor: (record) => BigInt(record.ts_event),
      tieBreakRank: 0,
    },
    {
      name: 'trades',
      records: recordSource(input.session, 'trades'),
      tsExtractor: (record) => BigInt(record.ts_event),
      tieBreakRank: 1,
    },
  ]));
  const recentQueueRecords: DbnRecord[] = [];
  const history: BuiltBar[] = [];
  const quoteState: { latest: RealArchiveTopOfBook | null } = { latest: null };
  let openPosition: OpenExecutionPosition | null = null;
  let barIndex = 0;
  let lastBar: BuiltBar | null = null;

  for await (const output of buildBars(recordSource(input.session, 'trades'), {
    bar_spec: input.options.bar_spec ?? '1m',
    manifest_symbol: input.session.raw_symbol,
    roll_policy: DEFAULT_MNQ_ROLL_POLICY,
    input_schemas: ['trades'],
    corpus_tier: 'A',
  })) {
    if (output.type !== 'bar') {
      continue;
    }
    const bar = output as BuiltBar;
    barIndex += 1;
    lastBar = bar;
    await advanceQueueCursor(queueCursor, bar.last_record_ts_ns, recentQueueRecords, (record) => {
      if (record.schema === 'mbp-1') {
        quoteState.latest = topOfBookFromMbp1(record as DbnMbp1Record);
      }
    });
    pruneRecentQueueRecords(
      recentQueueRecords,
      bar.last_record_ts_ns - input.fillPolicy.depletion_lookback_ns - input.fillPolicy.fill_horizon_ns,
    );

    history.push(bar);
    input.metrics.bars_processed += 1;

    if (openPosition !== null) {
      updateExcursions(openPosition, bar);
      const management = evaluatePositionManager({
        position: openPosition.target_position,
        profile: openPosition.management_profile,
        market: {
          event_ts_ns: bar.last_record_ts_ns,
          mark_price: priceNumber(bar.close),
          high_price: priceNumber(bar.high),
          low_price: priceNumber(bar.low),
          ...(quoteState.latest === null ? {} : {
            bid_px: quoteState.latest.bid_px,
            ask_px: quoteState.latest.ask_px,
            authority: 'authoritative' as const,
          }),
        },
      });
      appendManagementEvents({
        events: input.events,
        runId: input.runId,
        sessionId,
        sequence: input.sequence,
        evaluation: management,
        tsNs: bar.last_record_ts_ns,
      });
      openPosition.target_position = management.updated_position;
      const exitAction = firstExitAction(management.actions);
      if (exitAction !== undefined) {
        const closed = closeOpenPosition({
          openPosition,
          action: exitAction,
          exitReason: exitReasonFromManagement(management, exitAction),
          bar,
          barIndex,
          runId: input.runId,
          sessionId,
          sequence: input.sequence,
          events: input.events,
          entryMetadataByOrderIntentId: input.entryMetadataByOrderIntentId,
        });
        input.metrics.fill_count += closed.exitFillCount;
        openPosition = closed.openPosition;
      }
      continue;
    }

    const snapshot = buildFeatureSnapshot({
      strategyId: input.options.strategy_id,
      bar,
      history,
      session: input.session,
      sourceEventId: makeEventId(`evt-${input.runId}-${padSequence(input.sequence.next())}-source`),
      latestQuote: quoteState.latest,
    });
    const result = input.strategyGenerator({
      strategy_id: input.options.strategy_id,
      snapshot,
    });
    input.events.push(strategyEvalEvent({
      runId: input.runId,
      sessionId,
      sequence: input.sequence,
      result,
      tsNs: bar.last_record_ts_ns,
    }));
    if (result.candidate === undefined || result.evaluation.gate_state !== 'armed') {
      continue;
    }

    const candidate = result.candidate;
    input.events.push(candidateEvent({
      runId: input.runId,
      sessionId,
      sequence: input.sequence,
      candidate,
    }));
    input.metrics.candidate_count += 1;

    const orderIntent = orderIntentEvent({
      runId: input.runId,
      sessionId,
      sequence: input.sequence,
      candidate,
      quantity: input.fillPolicy.order_quantity,
    });
    input.events.push(orderIntent as AnyJournalEventEnvelope);
    input.metrics.order_intent_count += 1;

    const estimate = await estimateFill({
      candidate,
      quantity: input.fillPolicy.order_quantity,
      records: recentQueueRecords,
      fillPolicy: input.fillPolicy,
      fallbackInstrumentId: quoteState.latest?.instrument_id ?? 1,
      rawSymbol: input.session.raw_symbol,
      tsNs: bar.last_record_ts_ns,
    });
    if (
      estimate === null ||
      estimate.estimated_fill_probability_ppm < input.fillPolicy.minimum_fill_probability_ppm
    ) {
      input.events.push(execRejectEvent({
        runId: input.runId,
        sessionId,
        sequence: input.sequence,
        orderIntent,
        candidate,
        reason: estimate === null ? 'queue_state_unavailable' : 'below_fill_probability_threshold',
      }));
      continue;
    }

    const entryFill = makeFillEvent({
      runId: input.runId,
      sessionId,
      sequence: input.sequence,
      orderIntentId: orderIntent.payload.order_intent_id,
      side: candidate.direction === 'long' ? 'buy' : 'sell',
      price: candidate.entry_price,
      quantity: input.fillPolicy.order_quantity,
      tsNs: bar.last_record_ts_ns,
      causationEventId: orderIntent.event_id,
      fillSuffix: 'entry',
      estimate,
      exchangeFeeUsd: input.fillPolicy.exchange_fee_usd,
      commissionUsd: input.fillPolicy.commission_usd,
    });
    input.events.push(entryFill as AnyJournalEventEnvelope);
    const entryMetadata = {
      spread_bucket: spreadBucket(quoteState.latest),
      queue_ahead_bucket: queueAheadBucketFromQuote(candidate.direction, quoteState.latest),
      estimate,
      exit_reason: 'unknown' as const,
      exit_bar_index: 0,
      max_favorable_excursion_cents: 0n,
      max_adverse_excursion_cents: 0n,
    };
    input.entryMetadataByOrderIntentId.set(String(orderIntent.payload.order_intent_id), entryMetadata);
    const managementProfile = resolveManagementProfile(candidate.strategy_id, { allow_fallback: false }).profile;
    const targetPosition = applyInitialFillToTargetPosition(
      buildTargetPositionFromCandidate({
        candidate,
        profile: managementProfile,
        quantity: input.fillPolicy.order_quantity,
        opened_ts_ns: bar.last_record_ts_ns,
        position_id: makePositionId(`position-${candidate.candidate_id}`),
      }),
      simulatedFillFromEvent(entryFill, candidate),
    );
    input.events.push(positionEvent({
      runId: input.runId,
      sessionId,
      sequence: input.sequence,
      candidate,
      status: 'open',
      quantityOpen: input.fillPolicy.order_quantity,
      avgEntryPrice: candidate.entry_price,
      tsNs: bar.last_record_ts_ns,
      positionId: targetPosition.position_id,
      managementProfile,
    }));
    input.metrics.fill_count += 1;
    openPosition = {
      candidate,
      entry_fill: entryFill,
      entry_estimate: estimate,
      entry_spread_bucket: entryMetadata.spread_bucket,
      entry_queue_ahead_bucket: entryMetadata.queue_ahead_bucket,
      quantity: input.fillPolicy.order_quantity,
      order_intent_id: orderIntent.payload.order_intent_id,
      management_profile: managementProfile,
      target_position: targetPosition,
      entry_bar_index: barIndex,
      mfe_cents: 0n,
      mae_cents: 0n,
    };
  }

  if (openPosition !== null && lastBar !== null) {
    const closed = closeOpenPosition({
      openPosition,
      exitReason: 'session_close',
      bar: lastBar,
      barIndex,
      runId: input.runId,
      sessionId,
      sequence: input.sequence,
      events: input.events,
      entryMetadataByOrderIntentId: input.entryMetadataByOrderIntentId,
    });
    input.metrics.fill_count += closed.exitFillCount;
  }
}

function validateOptions(options: RealArchiveBacktestOptions): void {
  if (options.run_id.trim().length === 0) {
    throw new Error('run_id must be non-empty');
  }
  if (options.sessions.length === 0) {
    throw new Error('at least one session is required');
  }
}

function appendManagementEvents(input: {
  readonly events: AnyJournalEventEnvelope[];
  readonly runId: ReturnType<typeof makeRunId>;
  readonly sessionId: ReturnType<typeof makeSessionId>;
  readonly sequence: EventSequence;
  readonly evaluation: PositionManagerEvaluation;
  readonly tsNs: UnixNs;
}): void {
  input.events.push(createJournalEventEnvelope({
    event_id: makeEventId(`evt-${input.runId}-${padSequence(input.sequence.next())}`),
    type: 'MGMT_TICK',
    ts_ns: input.tsNs,
    run_id: input.runId,
    session_id: input.sessionId,
    payload: input.evaluation.management_tick_payload,
  }) as AnyJournalEventEnvelope);
  for (const payload of input.evaluation.management_action_payloads) {
    input.events.push(createJournalEventEnvelope({
      event_id: makeEventId(`evt-${input.runId}-${padSequence(input.sequence.next())}`),
      type: 'MGMT_ACTION',
      ts_ns: input.tsNs,
      run_id: input.runId,
      session_id: input.sessionId,
      payload,
    }) as AnyJournalEventEnvelope);
  }
}

function firstExitAction(actions: readonly PositionManagerAction[]): PositionManagerAction | undefined {
  return actions.find((action) => action.exit_quantity !== undefined && action.exit_price !== undefined);
}

function closeOpenPosition(input: {
  readonly openPosition: OpenExecutionPosition;
  readonly action?: PositionManagerAction;
  readonly exitReason: RealArchiveExitReason;
  readonly bar: BuiltBar;
  readonly barIndex: number;
  readonly runId: ReturnType<typeof makeRunId>;
  readonly sessionId: ReturnType<typeof makeSessionId>;
  readonly sequence: EventSequence;
  readonly events: AnyJournalEventEnvelope[];
  readonly entryMetadataByOrderIntentId: Map<string, EntryMetadata>;
}): { readonly openPosition: OpenExecutionPosition | null; readonly exitFillCount: number } {
  const exitQuantity = input.action?.exit_quantity ?? input.openPosition.target_position.remaining_quantity;
  if (exitQuantity <= 0) {
    return { openPosition: input.openPosition, exitFillCount: 0 };
  }
  const exitPrice = input.action?.exit_price ?? priceNumber(input.bar.close);
  const exitFill = makeFillEvent({
    runId: input.runId,
    sessionId: input.sessionId,
    sequence: input.sequence,
    orderIntentId: input.openPosition.order_intent_id,
    positionId: input.openPosition.target_position.position_id,
    managementActionId: input.action?.management_action_id,
    managementProfile: input.openPosition.management_profile,
    side: input.openPosition.candidate.direction === 'long' ? 'sell' : 'buy',
    price: exitPrice,
    quantity: exitQuantity,
    tsNs: input.bar.last_record_ts_ns,
    causationEventId: input.openPosition.entry_fill.event_id,
    fillSuffix: `${input.exitReason}-${input.barIndex}`,
    estimate: input.openPosition.entry_estimate,
  });
  input.events.push(exitFill as AnyJournalEventEnvelope);

  const fullyClosed =
    input.exitReason === 'session_close' ||
    input.openPosition.target_position.lifecycle_state === 'closed' ||
    input.openPosition.target_position.remaining_quantity - exitQuantity <= 0;
  input.events.push(positionEvent({
    runId: input.runId,
    sessionId: input.sessionId,
    sequence: input.sequence,
    candidate: input.openPosition.candidate,
    status: fullyClosed ? 'closed' : 'open',
    quantityOpen: fullyClosed
      ? 0
      : Math.max(0, input.openPosition.target_position.remaining_quantity - exitQuantity),
    avgEntryPrice: input.openPosition.entry_fill.payload.price,
    tsNs: input.bar.last_record_ts_ns,
    positionId: input.openPosition.target_position.position_id,
    managementProfile: input.openPosition.management_profile,
  }));

  if (!fullyClosed) {
    return { openPosition: input.openPosition, exitFillCount: 1 };
  }

  const metadata = input.entryMetadataByOrderIntentId.get(String(input.openPosition.order_intent_id));
  if (metadata !== undefined) {
    metadata.exit_reason = input.exitReason;
    metadata.exit_bar_index = input.barIndex - input.openPosition.entry_bar_index;
    metadata.max_favorable_excursion_cents = input.openPosition.mfe_cents;
    metadata.max_adverse_excursion_cents = input.openPosition.mae_cents;
  }
  return { openPosition: null, exitFillCount: 1 };
}

function exitReasonFromManagement(
  evaluation: PositionManagerEvaluation,
  action: PositionManagerAction,
): RealArchiveExitReason {
  if (evaluation.fsm_state === 'FAILED_SAFE_EXIT' || action.reason.startsWith('fail_safe:')) {
    return 'fail_safe';
  }
  if (evaluation.fsm_state === 'TIME_STOP_EXIT' || action.reason.startsWith('time_stop:')) {
    return 'time_stop';
  }
  if (action.reason.startsWith('stop:')) {
    return 'stop_loss';
  }
  if (action.reason.startsWith('target:')) {
    return 'target';
  }
  return 'unknown';
}

function updateExcursions(position: OpenExecutionPosition, bar: BuiltBar): void {
  const high = priceNumber(bar.high);
  const low = priceNumber(bar.low);
  const favorablePrice = position.candidate.direction === 'long' ? high : low;
  const adversePrice = position.candidate.direction === 'long' ? low : high;
  position.mfe_cents = maxBigint(
    position.mfe_cents,
    unrealizedPnlCents(position, favorablePrice),
  );
  position.mae_cents = minBigint(
    position.mae_cents,
    unrealizedPnlCents(position, adversePrice),
  );
}

function unrealizedPnlCents(position: OpenExecutionPosition, markPrice: number): bigint {
  const points = position.candidate.direction === 'long'
    ? markPrice - position.entry_fill.payload.price
    : position.entry_fill.payload.price - markPrice;
  const ticks = BigInt(Math.round(points / TICK_SIZE));
  return ticks * DEFAULT_VALUATION.tick_value_usd_cents * BigInt(position.quantity);
}

function simulatedFillFromEvent(
  fill: JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>,
  candidate: Candidate,
): SimulatedFill {
  return {
    fill_id: fill.payload.fill_id,
    order_intent_id: fill.payload.order_intent_id,
    instrument: candidate.instrument,
    side: fill.payload.side,
    quantity: fill.payload.quantity,
    price: fill.payload.price,
    liquidity: fill.payload.liquidity,
    exchange_fee_usd: fill.payload.exchange_fee_usd ?? 0,
    commission_usd: fill.payload.commission_usd ?? 0,
    slippage_points: fill.payload.slippage_points ?? 0,
    filled_ts_ns: fill.ts_ns,
    config: candidate.config,
    execution_model_version: fill.payload.execution_model_version,
    fill_model: fill.payload.fill_model,
    input_tier: fill.payload.input_tier,
    fill_probability: fill.payload.fill_probability,
    queue_ahead_size_estimate: fill.payload.queue_ahead_size_estimate,
    calibration_status: fill.payload.calibration_status,
  };
}

function maxBigint(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function recordSource(
  session: RealArchiveSessionSource,
  schema: 'trades' | 'mbp-1',
): AsyncIterable<DbnRecord> {
  const records = schema === 'trades' ? session.trades_records : session.mbp1_records;
  if (records !== undefined) {
    return toAsync(records);
  }
  const path = schema === 'trades' ? session.trades_path : session.mbp1_path;
  if (path === undefined) {
    throw new Error(`session ${session.session_id} is missing ${schema} records or path`);
  }
  return loadDbnFile(path, schema);
}

async function* toAsync<T>(records: readonly T[] | AsyncIterable<T>): AsyncIterableIterator<T> {
  if (Symbol.asyncIterator in records) {
    for await (const record of records) {
      yield record;
    }
    return;
  }
  for (const record of records) {
    yield record;
  }
}

function createRecordCursor(records: AsyncIterable<DbnRecord>): {
  readonly nextReady: (tsNs: UnixNs) => Promise<readonly DbnRecord[]>;
} {
  const iterator = records[Symbol.asyncIterator]();
  let pending: DbnRecord | null = null;
  let done = false;

  return {
    async nextReady(tsNs: UnixNs) {
      const ready: DbnRecord[] = [];
      while (!done) {
        if (pending === null) {
          const pulled = await iterator.next();
          if (pulled.done === true) {
            done = true;
            break;
          }
          pending = pulled.value;
        }
        if (pending.ts_event > tsNs) {
          break;
        }
        ready.push(pending);
        pending = null;
      }
      return ready;
    },
  };
}

async function advanceQueueCursor(
  cursor: ReturnType<typeof createRecordCursor>,
  tsNs: UnixNs,
  recent: DbnRecord[],
  onMbp1?: (record: DbnMbp1Record) => void,
): Promise<void> {
  for (const record of await cursor.nextReady(tsNs)) {
    recent.push(record);
    if (record.schema === 'mbp-1') {
      onMbp1?.(record);
    }
  }
}

function pruneRecentQueueRecords(records: DbnRecord[], cutoff: bigint): void {
  let firstKept = 0;
  while (firstKept < records.length && records[firstKept]!.ts_event < cutoff) {
    firstKept += 1;
  }
  if (firstKept > 0) {
    records.splice(0, firstKept);
  }
}

async function estimateFill(input: {
  readonly candidate: Candidate;
  readonly quantity: number;
  readonly records: readonly DbnRecord[];
  readonly fillPolicy: RealArchiveExecutionFillPolicy;
  readonly fallbackInstrumentId: number;
  readonly rawSymbol: string;
  readonly tsNs: UnixNs;
}): Promise<PassiveFillEstimate | null> {
  const probe: PassiveOrderProbe = {
    ts_ns: input.tsNs,
    instrument_id: input.candidate.instrument.symbol === input.rawSymbol
      ? input.fallbackInstrumentId
      : input.fallbackInstrumentId,
    raw_symbol: input.rawSymbol,
    side: input.candidate.direction === 'long' ? 'buy' : 'sell',
    limit_price: dbnPrice(input.candidate.entry_price),
    order_quantity: BigInt(input.quantity),
    latency_ns: 0n,
  };
  const outputs: QueueSynthesisOutput[] = [];
  for await (const output of synthesizeQueue(
    toAsync(input.records),
    {
      instrument_root: 'MNQ',
      manifest_symbol: input.rawSymbol,
      input_schemas: ['mbp-1', 'trades'],
      corpus_tier: 'A',
      mode: 'mbp_trades_proxy',
      passive_order_quantity: BigInt(input.quantity),
      fill_horizon_ns: input.fillPolicy.fill_horizon_ns,
      depletion_lookback_ns: input.fillPolicy.depletion_lookback_ns,
      allow_unverified_identity: true,
    },
    toAsync([probe]),
  )) {
    outputs.push(output);
  }
  return outputs.find((output): output is PassiveFillEstimate =>
    output.type === 'passive_fill_estimate') ?? null;
}

function buildFeatureSnapshot(input: {
  readonly strategyId: StrategyId;
  readonly bar: BuiltBar;
  readonly history: readonly BuiltBar[];
  readonly session: RealArchiveSessionSource;
  readonly sourceEventId: ReturnType<typeof makeEventId>;
  readonly latestQuote: RealArchiveTopOfBook | null;
}): StrategyFeatureSnapshot {
  const instrument = instrumentIdentity(input.session.raw_symbol);
  const bars = input.history.map((bar) => ({
    instrument,
    timeframe: '1m' as const,
    start_ts_ns: bar.bucket_start_ts_ns ?? bar.first_record_ts_ns,
    end_ts_ns: bar.bucket_end_ts_ns ?? bar.last_record_ts_ns,
    open: priceNumber(bar.open),
    high: priceNumber(bar.high),
    low: priceNumber(bar.low),
    close: priceNumber(bar.close),
    volume: Number(bar.volume),
  }));
  const current = bars.at(-1);
  if (current === undefined) {
    throw new Error('feature snapshot requires at least one bar');
  }
  const quote = input.latestQuote ?? fallbackQuote(current.close);
  const closes = bars.map((bar) => bar.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const sigmaPts = Math.max(TICK_SIZE, average(bars.map((bar) => bar.high - bar.low)) / 2);
  const previousClose = closes.length > 1 ? closes[closes.length - 2] : undefined;
  const trend = previousClose === undefined
    ? 'unknown'
    : current.close > previousClose
      ? 'up'
      : current.close < previousClose
        ? 'down'
        : 'range';
  const prior = bars.slice(0, -1);
  const priorHigh = prior.length === 0 ? current.high : Math.max(...prior.map((bar) => bar.high));
  const priorLow = prior.length === 0 ? current.low : Math.min(...prior.map((bar) => bar.low));

  return {
    feature_snapshot_id: makeFeatureSnapshotId(`feature-${input.bar.bar_id}-${input.strategyId}`),
    source_event_id: input.sourceEventId,
    created_ts_ns: input.bar.last_record_ts_ns,
    instrument,
    session: {
      session_id: makeSessionId(input.session.session_id),
      trading_date: input.session.trading_date,
      phase: 'rth',
      is_rth: true,
      is_halt: false,
      is_roll_block: false,
      opened_ts_ns: input.session.rth_start_ts_ns === undefined ? undefined : ns(input.session.rth_start_ts_ns),
      closes_ts_ns: input.session.rth_end_ts_ns === undefined ? undefined : ns(input.session.rth_end_ts_ns),
    },
    quote: {
      bid_px: quote.bid_px,
      ask_px: quote.ask_px,
      mid_px: round4((quote.bid_px + quote.ask_px) / 2),
    },
    last_trade_price: current.close,
    bars,
    indicators: {
      ema_9: round4(ema9),
      ema_21: round4(ema21),
      ema_50: round4(ema50),
      pullback_ratio: round4(Math.min(1, Math.abs(current.close - ema9) / sigmaPts)),
      sigma_pts: round4(sigmaPts),
      supertrend_direction: trend === 'down' ? 'down' : 'up',
      z_ema9: round4((current.close - ema9) / sigmaPts),
      z_ofi_blend: 0,
    },
    structure: {
      trend,
      values: {
        breakout_level: roundToTick(priorHigh),
        broken_support: roundToTick(priorLow),
        choch_buy: roundToTick(priorLow - sigmaPts),
        choch_sell: roundToTick(priorHigh + sigmaPts),
        nearest_resistance: roundToTick(priorHigh + sigmaPts),
        nearest_support: roundToTick(priorLow - sigmaPts),
        pivot_resistance_1: roundToTick(priorHigh + sigmaPts * 2),
        pivot_support_1: roundToTick(priorLow - sigmaPts * 2),
        retest_hold: current.close >= ema9,
        retest_reject: current.close <= ema9,
      },
    },
    microstructure: {
      l3_authority: input.latestQuote === null ? 'unavailable' : 'authoritative',
      values: {
        spread_pts: round4(quote.ask_px - quote.bid_px),
        spread_ticks: round4((quote.ask_px - quote.bid_px) / TICK_SIZE),
        queue_imbalance: imbalance(quote.bid_size, quote.ask_size),
        depth_imbalance: imbalance(quote.bid_size, quote.ask_size),
        ofi_z: 0,
      },
    },
    config: DEFAULT_CONFIG,
  };
}

function strategyEvalEvent(input: {
  readonly runId: ReturnType<typeof makeRunId>;
  readonly sessionId: ReturnType<typeof makeSessionId>;
  readonly sequence: EventSequence;
  readonly result: ReturnType<RealArchiveStrategyGenerator>;
  readonly tsNs: UnixNs;
}): AnyJournalEventEnvelope {
  return createJournalEventEnvelope({
    event_id: makeEventId(`evt-${input.runId}-${padSequence(input.sequence.next())}`),
    type: 'STRAT_EVAL',
    ts_ns: input.tsNs,
    run_id: input.runId,
    session_id: input.sessionId,
    payload: {
      strategy_evaluation_id: input.result.evaluation.strategy_evaluation_id,
      strategy_id: input.result.evaluation.strategy_id,
      feature_snapshot_id: input.result.evaluation.feature_snapshot_id,
      gate_state: input.result.evaluation.gate_state,
      ...(input.result.evaluation.score === undefined ? {} : { score: input.result.evaluation.score }),
      reasons: input.result.evaluation.reasons,
      strategy_config_hash: input.result.evaluation.config.config_hash,
    },
  }) as AnyJournalEventEnvelope;
}

function candidateEvent(input: {
  readonly runId: ReturnType<typeof makeRunId>;
  readonly sessionId: ReturnType<typeof makeSessionId>;
  readonly sequence: EventSequence;
  readonly candidate: Candidate;
}): AnyJournalEventEnvelope {
  return createJournalEventEnvelope({
    event_id: makeEventId(`evt-${input.runId}-${padSequence(input.sequence.next())}`),
    type: 'CANDIDATE',
    ts_ns: input.candidate.proposed_ts_ns,
    run_id: input.runId,
    session_id: input.sessionId,
    payload: {
      candidate_id: input.candidate.candidate_id,
      strategy_id: input.candidate.strategy_id,
      feature_snapshot_id: input.candidate.feature_snapshot_id,
      direction: input.candidate.direction,
      status: input.candidate.status,
      entry_price: input.candidate.entry_price,
      stop_price: input.candidate.stop_price,
      targets: input.candidate.targets,
      confidence: input.candidate.confidence,
      reasons: input.candidate.reasons,
      strategy_config_hash: input.candidate.config.config_hash,
    },
  }) as AnyJournalEventEnvelope;
}

function orderIntentEvent(input: {
  readonly runId: ReturnType<typeof makeRunId>;
  readonly sessionId: ReturnType<typeof makeSessionId>;
  readonly sequence: EventSequence;
  readonly candidate: Candidate;
  readonly quantity: number;
}): JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>> {
  return createJournalEventEnvelope({
    event_id: makeEventId(`evt-${input.runId}-${padSequence(input.sequence.next())}`),
    type: 'ORDER_INTENT',
    ts_ns: input.candidate.proposed_ts_ns,
    run_id: input.runId,
    session_id: input.sessionId,
    payload: {
      order_intent_id: makeOrderIntentId(`order-${input.candidate.candidate_id}`),
      candidate_id: input.candidate.candidate_id,
      sizing_decision_id: makeSizingDecisionId(`sizing-${input.candidate.candidate_id}`),
      side: input.candidate.direction === 'long' ? 'buy' : 'sell',
      order_type: 'limit_post_only',
      quantity: input.quantity,
      limit_price: input.candidate.entry_price,
      time_in_force: 'day',
      strategy_config_hash: input.candidate.config.config_hash,
    },
  });
}

function makeFillEvent(input: {
  readonly runId: ReturnType<typeof makeRunId>;
  readonly sessionId: ReturnType<typeof makeSessionId>;
  readonly sequence: EventSequence;
  readonly orderIntentId: ReturnType<typeof makeOrderIntentId>;
  readonly positionId?: ReturnType<typeof makePositionId>;
  readonly managementActionId?: string;
  readonly managementProfile?: ManagementProfile;
  readonly side: 'buy' | 'sell';
  readonly price: number;
  readonly quantity: number;
  readonly tsNs: UnixNs;
  readonly causationEventId: string;
  readonly fillSuffix: string;
  readonly estimate: PassiveFillEstimate;
  readonly exchangeFeeUsd?: number;
  readonly commissionUsd?: number;
}): JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>> {
  return createJournalEventEnvelope({
    event_id: makeEventId(`evt-${input.runId}-${padSequence(input.sequence.next())}`),
    type: 'SIM_FILL',
    ts_ns: input.tsNs,
    run_id: input.runId,
    session_id: input.sessionId,
    causation_id: makeCausationId(input.causationEventId),
    payload: {
      fill_id: makeFillId(`fill-${input.orderIntentId}-${input.fillSuffix}`),
      order_intent_id: input.orderIntentId,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      liquidity: 'maker',
      slippage_points: 0,
      ...(input.exchangeFeeUsd === undefined ? {} : { exchange_fee_usd: input.exchangeFeeUsd }),
      ...(input.commissionUsd === undefined ? {} : { commission_usd: input.commissionUsd }),
      execution_model_version: 'qfa-201b-v1',
      fill_model: 'queue_aware_limit_post_only',
      input_tier: 'subscope',
      fill_probability: input.estimate.estimated_fill_probability_ppm / 1_000_000,
      queue_ahead_size_estimate: Number(input.estimate.estimated_fill_quantity),
      calibration_status: input.estimate.source_metadata.confidence,
      ...(input.managementActionId === undefined ? {} : {
        management_action_id: input.managementActionId as JournalEventPayloadFor<'SIM_FILL'>['management_action_id'],
      }),
      ...(input.positionId === undefined ? {} : { position_id: input.positionId }),
      ...(input.managementProfile === undefined ? {} : {
        management_profile_hash: input.managementProfile.profile_hash,
        management_profile_id: input.managementProfile.profile_id,
        management_profile_version: input.managementProfile.profile_version,
        position_manager_version: 'position_manager_fsm_v1',
      }),
    },
  });
}

function execRejectEvent(input: {
  readonly runId: ReturnType<typeof makeRunId>;
  readonly sessionId: ReturnType<typeof makeSessionId>;
  readonly sequence: EventSequence;
  readonly orderIntent: JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>;
  readonly candidate: Candidate;
  readonly reason: string;
}): AnyJournalEventEnvelope {
  return createJournalEventEnvelope({
    event_id: makeEventId(`evt-${input.runId}-${padSequence(input.sequence.next())}`),
    type: 'EXEC_REJECT',
    ts_ns: input.orderIntent.ts_ns,
    run_id: input.runId,
    session_id: input.sessionId,
    causation_id: makeCausationId(input.orderIntent.event_id),
    payload: {
      execution_reject_id: `reject-${input.orderIntent.payload.order_intent_id}`,
      order_intent_id: input.orderIntent.payload.order_intent_id,
      candidate_id: input.candidate.candidate_id,
      sizing_decision_id: input.orderIntent.payload.sizing_decision_id,
      status: 'rejected',
      reason: input.reason,
      execution_adapter: 'simulated',
      execution_version: 'qfa-201b-v1',
      strategy_config_hash: input.candidate.config.config_hash,
    },
  }) as AnyJournalEventEnvelope;
}

function positionEvent(input: {
  readonly runId: ReturnType<typeof makeRunId>;
  readonly sessionId: ReturnType<typeof makeSessionId>;
  readonly sequence: EventSequence;
  readonly candidate: Candidate;
  readonly status: 'open' | 'closed';
  readonly quantityOpen: number;
  readonly avgEntryPrice: number;
  readonly tsNs: UnixNs;
  readonly positionId?: ReturnType<typeof makePositionId>;
  readonly managementProfile?: ManagementProfile;
}): AnyJournalEventEnvelope {
  return createJournalEventEnvelope({
    event_id: makeEventId(`evt-${input.runId}-${padSequence(input.sequence.next())}`),
    type: 'POSITION',
    ts_ns: input.tsNs,
    run_id: input.runId,
    session_id: input.sessionId,
    payload: {
      position_id: input.positionId ?? makePositionId(`position-${input.candidate.candidate_id}`),
      candidate_id: input.candidate.candidate_id,
      side: input.status === 'closed' ? 'flat' : input.candidate.direction,
      status: input.status,
      quantity_open: input.quantityOpen,
      avg_entry_price: input.avgEntryPrice,
      updated_ts_ns: input.tsNs,
      strategy_config_hash: input.candidate.config.config_hash,
      ...(input.managementProfile === undefined ? {} : {
        management_profile_hash: input.managementProfile.profile_hash,
        management_profile_id: input.managementProfile.profile_id,
        management_profile_version: input.managementProfile.profile_version,
      }),
    },
  }) as AnyJournalEventEnvelope;
}

function enrichTrades(input: {
  readonly ledger: ReturnType<typeof buildTradeLedger>;
  readonly analysis: ReturnType<typeof analyzeTradeLedger>;
  readonly events: readonly AnyJournalEventEnvelope[];
  readonly sessions: readonly RealArchiveSessionSource[];
  readonly entryMetadataByOrderIntentId: ReadonlyMap<string, EntryMetadata>;
}): RealArchivePerTradeRecord[] {
  const fillByExecutionId = new Map(input.ledger.executions.map((execution) => [execution.execution_id, execution]));
  const pnlByTrade = new Map(input.analysis.trade_pnl.map((pnl) => [pnl.trade_id, pnl]));
  const sessionById = new Map(input.sessions.map((session) => [session.session_id, session]));
  const fillEventByOrder = new Map<string, JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>>();
  const eventSessionByEventId = new Map(input.events.map((event) => [String(event.event_id), String(event.session_id)]));
  for (const event of input.events) {
    if (event.type === 'SIM_FILL') {
      const fillEvent = event as JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>;
      fillEventByOrder.set(`${fillEvent.payload.order_intent_id}:${fillEvent.payload.side}`, fillEvent);
    }
  }

  return input.ledger.closed_trades.map((trade) => {
    const pnl = pnlByTrade.get(trade.trade_id);
    if (pnl === undefined) {
      throw new Error(`missing pnl for trade ${trade.trade_id}`);
    }
    const entryExecution = fillByExecutionId.get(trade.execution_ids[0]!);
    if (entryExecution === undefined) {
      throw new Error(`missing entry execution for trade ${trade.trade_id}`);
    }
    const sessionId = eventSessionByEventId.get(entryExecution.event_id) ?? 'unknown';
    const session = sessionById.get(sessionId);
    const entryFill = fillEventByOrder.get(`${entryExecution.order_intent_id}:${entryExecution.side}`);
    const entryMetadata = input.entryMetadataByOrderIntentId.get(entryExecution.order_intent_id);
    return {
      trade_id: trade.trade_id,
      strategy_id: trade.strategy_id,
      session_id: sessionId,
      regime_label: session?.regime_label ?? 'unknown',
      side: trade.side,
      entry_ts_ns: trade.opened_at_ns,
      exit_ts_ns: trade.closed_at_ns,
      entry_px: trade.average_entry_price,
      exit_px: trade.average_exit_price,
      quantity: trade.exit_quantity,
      pnl_cents: pnl.net_pnl_cents,
      spread_bucket: entryMetadata?.spread_bucket ?? 'unknown',
      queue_ahead_bucket: entryMetadata?.queue_ahead_bucket ?? queueAheadBucketFromFill(entryFill),
      exit_reason: entryMetadata?.exit_reason ?? 'unknown',
      exit_bar_index: entryMetadata?.exit_bar_index ?? 0,
      max_favorable_excursion_cents: entryMetadata?.max_favorable_excursion_cents ?? 0n,
      max_adverse_excursion_cents: entryMetadata?.max_adverse_excursion_cents ?? 0n,
      fill_quality_metric: {
        entry_fill_probability_ppm: entryMetadata?.estimate.estimated_fill_probability_ppm
          ?? Math.round((entryFill?.payload.fill_probability ?? 0) * 1_000_000),
        entry_estimated_fill_quantity: entryMetadata?.estimate.estimated_fill_quantity
          ?? BigInt(entryFill?.payload.queue_ahead_size_estimate ?? 0),
        entry_quality_flags: entryMetadata?.estimate.source_metadata.quality_flags ?? [],
      },
    };
  });
}

function topOfBookFromMbp1(record: DbnMbp1Record): RealArchiveTopOfBook | null {
  const level = record.levels[0];
  if (level === undefined) {
    return null;
  }
  return {
    ts_ns: record.ts_event,
    instrument_id: record.instrument_id,
    bid_px: priceNumber(level.bid_px),
    bid_size: level.bid_sz,
    ask_px: priceNumber(level.ask_px),
    ask_size: level.ask_sz,
  };
}

function fallbackQuote(price: number): RealArchiveTopOfBook {
  return {
    ts_ns: ns(0n),
    instrument_id: 1,
    bid_px: roundToTick(price - TICK_SIZE / 2),
    bid_size: 1,
    ask_px: roundToTick(price + TICK_SIZE / 2),
    ask_size: 1,
  };
}

function spreadBucket(quote: RealArchiveTopOfBook | null): SpreadBucket {
  if (quote === null) {
    return 'unknown';
  }
  const spreadTicks = (quote.ask_px - quote.bid_px) / TICK_SIZE;
  if (spreadTicks <= 1) return '1-tick';
  if (spreadTicks <= 2) return '2-tick';
  return '3+ ticks';
}

function queueAheadBucketFromQuote(
  direction: Candidate['direction'],
  quote: RealArchiveTopOfBook | null,
): QueueAheadBucket {
  if (quote === null) {
    return 'unknown';
  }
  const value = direction === 'long' ? quote.bid_size : quote.ask_size;
  if (value <= 5) return '1-5';
  if (value <= 20) return '6-20';
  return '21+';
}

function queueAheadBucketFromFill(
  fill: JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>> | undefined,
): QueueAheadBucket {
  const value = fill?.payload.queue_ahead_size_estimate;
  if (value === undefined) {
    return 'unknown';
  }
  if (value <= 5) return '1-5';
  if (value <= 20) return '6-20';
  return '21+';
}

function priceNumber(value: bigint): number {
  const raw = Number(value);
  return Math.abs(raw) >= 1_000_000 ? raw / PRICE_SCALE : raw;
}

function dbnPrice(value: number): bigint {
  return BigInt(Math.round(value * PRICE_SCALE));
}

function instrumentIdentity(symbol: string): InstrumentIdentity {
  return {
    root: 'MNQ',
    symbol,
    exchange: 'CME',
    currency: 'USD',
    tick_size: TICK_SIZE,
    point_value: 2,
    price_decimals: 2,
  };
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ema(values: readonly number[], period: number): number {
  const smoothing = 2 / (period + 1);
  let output = values[0] ?? 0;
  for (const value of values.slice(1)) {
    output = value * smoothing + output * (1 - smoothing);
  }
  return output;
}

function imbalance(left: number, right: number): number {
  const denominator = left + right;
  return denominator === 0 ? 0 : round4((left - right) / denominator);
}

function roundToTick(value: number): number {
  return round4(Math.round(value / TICK_SIZE) * TICK_SIZE);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function padSequence(sequence: number): string {
  return sequence.toString().padStart(6, '0');
}

function createSequence(): EventSequence {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
  };
}
