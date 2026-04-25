import type { LoadedAppConfig, StrategyRuntimeConfig } from '../config/index.js';
import {
  createJournalEventEnvelope,
  makeCausationId,
  makeConfigHash,
  makeCorrelationId,
  makeEventId,
  makeRiskGateDecisionId,
  makeStrategyEvaluationId,
  type AnyJournalEventEnvelope,
  type Candidate,
  type CausationId,
  type ConfigLineageRef,
  type EventId,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
  type PositionStatus,
  type RunId,
  type SessionId,
  type SimulatedFill,
  type SizingDecision,
  type StrategyEvaluation,
  type UnixNs,
} from '../contracts/index.js';
import {
  createEntryOrderIntent,
  toOrderIntentEventPayload,
  toSimFillEventPayload,
  type SimulatedExecutionAdapter,
  type SimulatedExecutionMarketState,
} from '../execution/simulated-execution.js';
import {
  applyInitialFillToTargetPosition,
  buildTargetPositionFromCandidate,
  evaluatePositionManager,
  resolveManagementProfile,
  summarizeTargetPositionForJournal,
  type PositionManagerMarketInput,
  type PositionManagerEvaluation,
  type TargetPosition,
} from '../management/index.js';
import {
  applyRealizedPnl,
  createSessionRiskState,
  evaluateRiskGate,
  resetSessionRiskState,
  resolveRiskPolicy,
  sizeCandidate,
  toRiskGateEventPayload,
  updateSessionRiskState,
  type PartialRiskPolicyConfig,
  type RiskRuntimeState,
  type SessionRiskState,
} from '../risk/index.js';
import {
  getActiveStrategyGenerator,
  listExecutableStrategyIds,
  rankCandidates,
  toRankEventPayload,
  type StrategyFeatureSnapshot,
} from '../strategies/index.js';
import type { StrategyId } from '../contracts/strategy-ids.js';
import type { StrategyRuntimeEngineContainer } from './engine-container.js';

export const STRATEGY_RUNNER_VERSION = 'strategy_runner_loop_v1' as const;

export interface StrategyRuntimeRunnerOptions {
  readonly container: StrategyRuntimeEngineContainer;
  readonly run_id: RunId;
  readonly session_id: SessionId;
  readonly execution_adapter: SimulatedExecutionAdapter;
  readonly account_ref?: string;
  readonly risk_policy?: PartialRiskPolicyConfig;
  readonly max_candidates_per_cycle?: number;
  readonly initial_session_risk_state?: SessionRiskState;
  readonly strategy_config?: StrategyRuntimeConfig;
}

export interface StrategyRuntimeRunnerSnapshot {
  readonly runner_version: typeof STRATEGY_RUNNER_VERSION;
  readonly session_risk?: SessionRiskState;
  readonly open_positions: readonly TargetPosition[];
}

export interface StrategyEvaluationCycleResult {
  readonly feature_event: JournalEventEnvelope<'FEATURES', JournalEventPayloadFor<'FEATURES'>>;
  readonly strategy_evaluation_events: readonly JournalEventEnvelope<'STRAT_EVAL', JournalEventPayloadFor<'STRAT_EVAL'>>[];
  readonly candidate_events: readonly JournalEventEnvelope<'CANDIDATE', JournalEventPayloadFor<'CANDIDATE'>>[];
  readonly rank_event: JournalEventEnvelope<'RANK', JournalEventPayloadFor<'RANK'>>;
  readonly sizing_events: readonly JournalEventEnvelope<'SIZING', JournalEventPayloadFor<'SIZING'>>[];
  readonly risk_gate_events: readonly JournalEventEnvelope<'RISK_GATE', JournalEventPayloadFor<'RISK_GATE'>>[];
  readonly order_intent_events: readonly JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>[];
  readonly sim_fill_events: readonly JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>[];
  readonly position_events: readonly JournalEventEnvelope<'POSITION', JournalEventPayloadFor<'POSITION'>>[];
  readonly session_risk: SessionRiskState;
  readonly open_positions: readonly TargetPosition[];
}

export interface RunnerManagementTickInput {
  readonly cause_event: JournalEventEnvelope;
  readonly mark_price: number;
  readonly high_price?: number;
  readonly low_price?: number;
  readonly bid_px?: number;
  readonly ask_px?: number;
  readonly authority?: PositionManagerMarketInput['authority'];
  readonly is_stale?: boolean;
}

export interface RunnerManagementTickResult {
  readonly management_tick_events: readonly JournalEventEnvelope<'MGMT_TICK', JournalEventPayloadFor<'MGMT_TICK'>>[];
  readonly management_action_events: readonly JournalEventEnvelope<'MGMT_ACTION', JournalEventPayloadFor<'MGMT_ACTION'>>[];
  readonly position_events: readonly JournalEventEnvelope<'POSITION', JournalEventPayloadFor<'POSITION'>>[];
  readonly management_results: readonly PositionManagerEvaluation[];
  readonly session_risk?: SessionRiskState;
  readonly open_positions: readonly TargetPosition[];
}

export class StrategyRuntimeRunner {
  private readonly container: StrategyRuntimeEngineContainer;
  private readonly runId: RunId;
  private readonly sessionId: SessionId;
  private readonly executionAdapter: SimulatedExecutionAdapter;
  private readonly accountRef: string;
  private readonly riskPolicy: PartialRiskPolicyConfig;
  private readonly maxCandidatesPerCycle: number;
  private readonly appConfigRef: ConfigLineageRef;
  private readonly strategyConfig: StrategyRuntimeConfig;
  private readonly strategyConfigHash: string;
  private sessionRisk: SessionRiskState | undefined;
  private openPositions: TargetPosition[] = [];

  constructor(options: StrategyRuntimeRunnerOptions) {
    if (
      options.max_candidates_per_cycle !== undefined &&
      (!Number.isInteger(options.max_candidates_per_cycle) || options.max_candidates_per_cycle < 1)
    ) {
      throw new Error('max_candidates_per_cycle must be a positive integer');
    }
    this.container = options.container;
    this.runId = options.run_id;
    this.sessionId = options.session_id;
    this.executionAdapter = options.execution_adapter;
    this.accountRef = options.account_ref ?? 'sim-account';
    this.riskPolicy = options.risk_policy ?? {};
    this.maxCandidatesPerCycle = options.max_candidates_per_cycle ?? 1;
    this.sessionRisk = options.initial_session_risk_state;
    this.strategyConfig =
      options.strategy_config ??
      options.container.config.strategyConfig ??
      failMissingStrategyConfig(options.container.config);
    this.strategyConfigHash = this.strategyConfig.lineage.strategy_config_hash;
    this.appConfigRef = {
      config_hash: makeConfigHash(options.container.config.lineage.config_hash),
      config_version: options.container.config.lineage.config_version,
    };
  }

  snapshot(): StrategyRuntimeRunnerSnapshot {
    return {
      runner_version: STRATEGY_RUNNER_VERSION,
      session_risk: this.sessionRisk,
      open_positions: [...this.openPositions],
    };
  }

  async publishExternalEvent<TType extends AnyJournalEventEnvelope['type']>(
    event: JournalEventEnvelope<TType, JournalEventPayloadFor<TType>>,
  ): Promise<JournalEventEnvelope<TType, JournalEventPayloadFor<TType>>> {
    await this.container.eventBus.publish(event as JournalEventEnvelope);
    return event;
  }

  async processFeatureSnapshot(
    snapshot: StrategyFeatureSnapshot,
  ): Promise<StrategyEvaluationCycleResult> {
    const sessionRisk = this.ensureSessionRisk(snapshot);
    const featureEvent = await this.publishDerivedEvent({
      event_id: makeEventId(`features-${snapshot.feature_snapshot_id}`),
      type: 'FEATURES',
      ts_ns: snapshot.created_ts_ns,
      causation_id: makeCausationId(snapshot.source_event_id),
      payload: {
        feature_snapshot_id: snapshot.feature_snapshot_id,
        source_event_id: snapshot.source_event_id,
        values: snapshot.indicators,
      },
    });

    const evaluationEvents: JournalEventEnvelope<'STRAT_EVAL', JournalEventPayloadFor<'STRAT_EVAL'>>[] = [];
    const candidateEvents: JournalEventEnvelope<'CANDIDATE', JournalEventPayloadFor<'CANDIDATE'>>[] = [];
    const candidates: Candidate[] = [];

    for (const strategyId of listExecutableStrategyIds()) {
      const result = evaluateStrategySafely(strategyId, snapshot, this.strategyConfig);
      const evaluationEvent = await this.publishDerivedEvent({
        event_id: makeEventId(`strat-eval-${result.evaluation.strategy_evaluation_id}`),
        type: 'STRAT_EVAL',
        ts_ns: snapshot.created_ts_ns,
        causation_id: toCausationId(featureEvent.event_id),
        payload: toStrategyEvaluationEventPayload(result.evaluation, this.strategyConfigHash),
      });
      evaluationEvents.push(evaluationEvent);

      if (result.candidate !== undefined) {
        const candidateEvent = await this.publishDerivedEvent({
          event_id: makeEventId(`candidate-${result.candidate.candidate_id}`),
          type: 'CANDIDATE',
          ts_ns: result.candidate.proposed_ts_ns,
          causation_id: toCausationId(evaluationEvent.event_id),
          payload: toCandidateEventPayload(result.candidate, this.strategyConfigHash),
          correlation_id: makeCorrelationId(`corr-${result.candidate.candidate_id}`),
        });
        candidateEvents.push(candidateEvent);
        candidates.push(result.candidate);
      }
    }

    const ranking = rankCandidates({
      candidates,
      strategy_config: this.strategyConfig,
    });
    const rankEvent = await this.publishDerivedEvent({
      event_id: makeEventId(`rank-${snapshot.feature_snapshot_id}`),
      type: 'RANK',
      ts_ns: snapshot.created_ts_ns,
      causation_id: toCausationId(featureEvent.event_id),
      payload: {
        ...toRankEventPayload(ranking),
        strategy_config_hash: this.strategyConfigHash,
      },
    });

    const sizingEvents: JournalEventEnvelope<'SIZING', JournalEventPayloadFor<'SIZING'>>[] = [];
    const riskGateEvents: JournalEventEnvelope<'RISK_GATE', JournalEventPayloadFor<'RISK_GATE'>>[] = [];
    const orderIntentEvents: JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>[] = [];
    const simFillEvents: JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>[] = [];
    const positionEvents: JournalEventEnvelope<'POSITION', JournalEventPayloadFor<'POSITION'>>[] = [];

    for (const ranked of ranking.ranked_candidates.slice(0, this.maxCandidatesPerCycle)) {
      const candidate = ranked.candidate;
      const candidateEvent = candidateEvents.find(
        (event) => event.payload.candidate_id === candidate.candidate_id,
      );
      if (candidateEvent === undefined) {
        throw new Error(`ranked candidate ${candidate.candidate_id} has no candidate event`);
      }

      const sizing = sizeCandidate({
        candidate,
        decided_ts_ns: candidate.proposed_ts_ns,
        policy: this.riskPolicy,
        state: this.toRiskRuntimeState(candidate, sessionRisk, candidate.proposed_ts_ns),
      });
      const sizingEvent = await this.publishDerivedEvent({
        event_id: makeEventId(`sizing-${sizing.sizing_decision_id}`),
        type: 'SIZING',
        ts_ns: sizing.decided_ts_ns,
        causation_id: toCausationId(candidateEvent.event_id),
        payload: toSizingEventPayload(sizing, this.strategyConfigHash),
        correlation_id: makeCorrelationId(`corr-${candidate.candidate_id}`),
      });
      sizingEvents.push(sizingEvent);

      const riskGate = evaluateRiskGate({
        candidate,
        sizing,
        decided_ts_ns: candidate.proposed_ts_ns,
        policy: this.riskPolicy,
        state: this.toRiskRuntimeState(candidate, sessionRisk, candidate.proposed_ts_ns),
      });
      const riskEvent = await this.publishDerivedEvent({
        event_id: makeEventId(`risk-gate-${riskGate.risk_gate_decision_id}`),
        type: 'RISK_GATE',
        ts_ns: riskGate.decided_ts_ns,
        causation_id: toCausationId(sizingEvent.event_id),
        payload: {
          ...toRiskGateEventPayload(riskGate, this.sessionRisk),
          strategy_config_hash: this.strategyConfigHash,
        },
        correlation_id: makeCorrelationId(`corr-${candidate.candidate_id}`),
      });
      riskGateEvents.push(riskEvent);

      if (riskGate.status !== 'pass') {
        this.sessionRisk = updateSessionRiskState(sessionRisk, {
          kind: 'trade_rejected',
          event_ts_ns: riskGate.decided_ts_ns,
        }, resolveRiskPolicy(this.riskPolicy).session);
        continue;
      }

      const intent = createEntryOrderIntent({
        candidate,
        sizing,
        submitted_ts_ns: candidate.proposed_ts_ns,
      });
      const intentEvent = await this.publishDerivedEvent({
        event_id: makeEventId(`order-intent-${intent.order_intent_id}`),
        type: 'ORDER_INTENT',
        ts_ns: intent.submitted_ts_ns,
        causation_id: toCausationId(riskEvent.event_id),
        payload: {
          ...toOrderIntentEventPayload(intent),
          strategy_config_hash: this.strategyConfigHash,
        },
        correlation_id: makeCorrelationId(`corr-${candidate.candidate_id}`),
      });
      orderIntentEvents.push(intentEvent);

      const orderResult = await this.executionAdapter.submit({
        intent,
        market: toExecutionMarketState(snapshot),
        fill_ts_ns: candidate.proposed_ts_ns,
      });

      for (const fill of orderResult.fills) {
        const fillEvent = await this.publishDerivedEvent({
          event_id: makeEventId(`sim-fill-${fill.fill_id}`),
          type: 'SIM_FILL',
          ts_ns: fill.filled_ts_ns,
          causation_id: toCausationId(intentEvent.event_id),
          payload: {
            ...toSimFillEventPayload(fill),
            strategy_config_hash: this.strategyConfigHash,
          },
          correlation_id: makeCorrelationId(`corr-${candidate.candidate_id}`),
        });
        simFillEvents.push(fillEvent);

        const openPosition = openTargetPositionFromFill(candidate, fill);
        this.openPositions.push(openPosition);
        this.sessionRisk = updateSessionRiskState(this.ensureSessionRisk(snapshot), {
          kind: 'trade_opened',
          event_ts_ns: fill.filled_ts_ns,
        }, resolveRiskPolicy(this.riskPolicy).session);

        const positionEvent = await this.publishDerivedEvent({
          event_id: makeEventId(`position-open-${openPosition.position_id}`),
          type: 'POSITION',
          ts_ns: fill.filled_ts_ns,
          causation_id: toCausationId(fillEvent.event_id),
          payload: toPositionEventPayload(openPosition, this.strategyConfigHash),
          correlation_id: makeCorrelationId(`corr-${candidate.candidate_id}`),
        });
        positionEvents.push(positionEvent);
      }
    }

    return {
      feature_event: featureEvent,
      strategy_evaluation_events: evaluationEvents,
      candidate_events: candidateEvents,
      rank_event: rankEvent,
      sizing_events: sizingEvents,
      risk_gate_events: riskGateEvents,
      order_intent_events: orderIntentEvents,
      sim_fill_events: simFillEvents,
      position_events: positionEvents,
      session_risk: this.ensureSessionRisk(snapshot),
      open_positions: [...this.openPositions],
    };
  }

  async processSessionPhase(
    event: JournalEventEnvelope<'SESSION_PHASE', JournalEventPayloadFor<'SESSION_PHASE'>>,
  ): Promise<JournalEventEnvelope<'SESSION_PHASE', JournalEventPayloadFor<'SESSION_PHASE'>>> {
    await this.publishExternalEvent(event);
    if (this.sessionRisk !== undefined) {
      this.sessionRisk = resetSessionRiskState({
        previous: this.sessionRisk,
        session_id: event.session_id,
        event_ts_ns: event.ts_ns,
        policy: resolveRiskPolicy(this.riskPolicy).session,
      });
    }
    return event;
  }

  async processManagementTick(
    input: RunnerManagementTickInput,
  ): Promise<RunnerManagementTickResult> {
    const managementTickEvents: JournalEventEnvelope<'MGMT_TICK', JournalEventPayloadFor<'MGMT_TICK'>>[] = [];
    const managementActionEvents: JournalEventEnvelope<'MGMT_ACTION', JournalEventPayloadFor<'MGMT_ACTION'>>[] = [];
    const positionEvents: JournalEventEnvelope<'POSITION', JournalEventPayloadFor<'POSITION'>>[] = [];
    const managementResults: PositionManagerEvaluation[] = [];
    const nextPositions: TargetPosition[] = [];

    for (const position of this.openPositions) {
      const result = evaluatePositionManager({
        position,
        profile: resolveManagementProfile(position.strategy_id).profile,
        market: {
          event_ts_ns: input.cause_event.ts_ns,
          mark_price: input.mark_price,
          high_price: input.high_price,
          low_price: input.low_price,
          bid_px: input.bid_px,
          ask_px: input.ask_px,
          authority: input.authority,
          is_stale: input.is_stale,
        },
      });
      managementResults.push(result);

      const tickEvent = await this.publishDerivedEvent({
        event_id: makeEventId(`mgmt-tick-${position.position_id}-${input.cause_event.ts_ns}`),
        type: 'MGMT_TICK',
        ts_ns: input.cause_event.ts_ns,
        causation_id: toCausationId(input.cause_event.event_id),
        payload: {
          ...result.management_tick_payload,
          strategy_config_hash: this.strategyConfigHash,
        },
      });
      managementTickEvents.push(tickEvent);

      let positionCauseEventId: EventId = tickEvent.event_id;
      for (const actionPayload of result.management_action_payloads) {
        const actionEvent = await this.publishDerivedEvent({
          event_id: makeEventId(`mgmt-action-${actionPayload.management_action_id}`),
          type: 'MGMT_ACTION',
          ts_ns: input.cause_event.ts_ns,
          causation_id: toCausationId(tickEvent.event_id),
          payload: {
            ...actionPayload,
            strategy_config_hash: this.strategyConfigHash,
          },
        });
        positionCauseEventId = actionEvent.event_id;
        managementActionEvents.push(actionEvent);
      }

      const updatedPosition = result.updated_position;
      const realizedDelta = round6(updatedPosition.realized_pnl_usd - position.realized_pnl_usd);
      if (this.sessionRisk !== undefined && realizedDelta !== 0) {
        this.sessionRisk = updatedPosition.lifecycle_state === 'closed'
          ? updateSessionRiskState(this.sessionRisk, {
            kind: 'trade_closed',
            realized_pnl_delta_usd: realizedDelta,
            event_ts_ns: input.cause_event.ts_ns,
          }, resolveRiskPolicy(this.riskPolicy).session)
          : applyRealizedPnl({
            state: this.sessionRisk,
            realized_pnl_delta_usd: realizedDelta,
            event_ts_ns: input.cause_event.ts_ns,
            policy: resolveRiskPolicy(this.riskPolicy).session,
          });
      }

      const positionEvent = await this.publishDerivedEvent({
        event_id: makeEventId(`position-update-${updatedPosition.position_id}-${input.cause_event.ts_ns}`),
        type: 'POSITION',
        ts_ns: input.cause_event.ts_ns,
        causation_id: toCausationId(positionCauseEventId),
        payload: {
          ...result.position_event_payload,
          strategy_config_hash: this.strategyConfigHash,
        },
      });
      positionEvents.push(positionEvent);

      if (updatedPosition.lifecycle_state !== 'closed') {
        nextPositions.push(updatedPosition);
      }
    }

    this.openPositions = nextPositions;
    return {
      management_tick_events: managementTickEvents,
      management_action_events: managementActionEvents,
      position_events: positionEvents,
      management_results: managementResults,
      session_risk: this.sessionRisk,
      open_positions: [...this.openPositions],
    };
  }

  private async publishDerivedEvent<TType extends AnyJournalEventEnvelope['type']>(input: {
    readonly event_id: EventId;
    readonly type: TType;
    readonly ts_ns: UnixNs;
    readonly causation_id: CausationId;
    readonly payload: JournalEventPayloadFor<TType>;
    readonly correlation_id?: ReturnType<typeof makeCorrelationId>;
  }): Promise<JournalEventEnvelope<TType, JournalEventPayloadFor<TType>>> {
    const event = createJournalEventEnvelope({
      event_id: input.event_id,
      type: input.type,
      ts_ns: input.ts_ns,
      run_id: this.runId,
      session_id: this.sessionId,
      payload: input.payload,
      causation_id: input.causation_id,
      correlation_id: input.correlation_id,
      config: this.appConfigRef,
    });
    await this.container.eventBus.publish(event as JournalEventEnvelope);
    return event;
  }

  private ensureSessionRisk(snapshot: StrategyFeatureSnapshot): SessionRiskState {
    if (this.sessionRisk === undefined) {
      this.sessionRisk = createSessionRiskState({
        session_id: snapshot.session.session_id,
        account_ref: this.accountRef,
        symbol: snapshot.instrument.symbol,
        event_ts_ns: snapshot.created_ts_ns,
      });
    }
    return this.sessionRisk;
  }

  private toRiskRuntimeState(
    candidate: Candidate,
    sessionRisk: SessionRiskState,
    tsNs: UnixNs,
  ): RiskRuntimeState {
    return {
      current_open_quantity: this.openPositions
        .filter((position) => position.instrument.symbol === candidate.instrument.symbol)
        .reduce((sum, position) => sum + position.remaining_quantity, 0),
      daily_realized_pnl_usd: sessionRisk.realized_pnl_usd,
      session_risk: sessionRisk,
      now_ms: Number(BigInt(tsNs) / 1_000_000n),
    };
  }
}

function failMissingStrategyConfig(config: LoadedAppConfig): never {
  throw new Error(
    `strategy runtime config is required for ${STRATEGY_RUNNER_VERSION}; config source ${config.source.config_path}`,
  );
}

function evaluateStrategySafely(
  strategyId: StrategyId,
  snapshot: StrategyFeatureSnapshot,
  strategyConfig: StrategyRuntimeConfig,
): { readonly evaluation: StrategyEvaluation; readonly candidate?: Candidate } {
  try {
    return getActiveStrategyGenerator(strategyId)({
      strategy_id: strategyId,
      snapshot,
      strategy_config: strategyConfig,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      evaluation: {
        strategy_evaluation_id: makeStrategyEvaluationId(
          `eval-${snapshot.feature_snapshot_id}-${strategyId}-blocked`,
        ),
        strategy_id: strategyId,
        instrument: snapshot.instrument,
        feature_snapshot_id: snapshot.feature_snapshot_id,
        evaluated_ts_ns: snapshot.created_ts_ns,
        gate_state: 'blocked',
        reasons: [`strategy_generator_error:${message}`],
        config: snapshot.config,
      },
    };
  }
}

function toStrategyEvaluationEventPayload(
  evaluation: StrategyEvaluation,
  strategyConfigHash: string,
): JournalEventPayloadFor<'STRAT_EVAL'> {
  return {
    strategy_evaluation_id: evaluation.strategy_evaluation_id,
    strategy_id: evaluation.strategy_id,
    feature_snapshot_id: evaluation.feature_snapshot_id,
    gate_state: evaluation.gate_state,
    score: evaluation.score,
    reasons: evaluation.reasons,
    strategy_config_hash: strategyConfigHash,
  };
}

function toCandidateEventPayload(
  candidate: Candidate,
  strategyConfigHash: string,
): JournalEventPayloadFor<'CANDIDATE'> {
  return {
    candidate_id: candidate.candidate_id,
    strategy_id: candidate.strategy_id,
    feature_snapshot_id: candidate.feature_snapshot_id,
    direction: candidate.direction,
    status: candidate.status,
    entry_price: candidate.entry_price,
    stop_price: candidate.stop_price,
    targets: candidate.targets.map((target) => ({
      label: target.label,
      price: target.price,
      quantity_fraction: target.quantity_fraction,
    })),
    confidence: candidate.confidence,
    reasons: candidate.reasons,
    strategy_config_hash: strategyConfigHash,
  };
}

function toSizingEventPayload(
  sizing: SizingDecision,
  strategyConfigHash: string,
): JournalEventPayloadFor<'SIZING'> {
  return {
    sizing_decision_id: sizing.sizing_decision_id,
    candidate_id: sizing.candidate_id,
    quantity: sizing.quantity,
    risk_usd: sizing.risk_usd,
    risk_points: sizing.risk_points,
    rejected_reason: sizing.rejected_reason,
    strategy_config_hash: strategyConfigHash,
  };
}

function toPositionEventPayload(
  position: TargetPosition,
  strategyConfigHash: string,
): JournalEventPayloadFor<'POSITION'> {
  const summary = summarizeTargetPositionForJournal(position);
  return {
    position_id: summary.position_id,
    candidate_id: summary.candidate_id,
    side: summary.remaining_quantity === 0 ? 'flat' : summary.side,
    status: toPositionStatus(summary.lifecycle_state),
    quantity_open: summary.remaining_quantity,
    avg_entry_price: summary.entry_price,
    updated_ts_ns: summary.updated_ts_ns,
    strategy_config_hash: strategyConfigHash,
  };
}

function toPositionStatus(lifecycleState: TargetPosition['lifecycle_state']): PositionStatus {
  if (lifecycleState === 'closed') return 'closed';
  if (lifecycleState === 'closing') return 'closing';
  return 'open';
}

function openTargetPositionFromFill(
  candidate: Candidate,
  fill: SimulatedFill,
): TargetPosition {
  const profile = resolveManagementProfile(candidate.strategy_id);
  const managementProfile = profile.profile;
  return applyInitialFillToTargetPosition(
    buildTargetPositionFromCandidate({
      candidate,
      profile: managementProfile,
      quantity: fill.quantity,
      opened_ts_ns: fill.filled_ts_ns,
    }),
    fill,
  );
}

function toExecutionMarketState(snapshot: StrategyFeatureSnapshot): SimulatedExecutionMarketState {
  return {
    instrument: snapshot.instrument,
    ts_ns: snapshot.created_ts_ns,
    bid_px: snapshot.quote.bid_px,
    ask_px: snapshot.quote.ask_px,
    last_trade_price: snapshot.last_trade_price,
  };
}

function toCausationId(eventId: EventId): CausationId {
  return makeCausationId(String(eventId));
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
