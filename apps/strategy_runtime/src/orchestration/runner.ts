import { performance } from 'node:perf_hooks';
import type { LoadedAppConfig, StrategyRuntimeConfig } from '../config/index.js';
import {
  createJournalEventEnvelope,
  makeCausationId,
  makeConfigHash,
  makeCorrelationId,
  makeEventId,
  makeManagementActionId,
  makeRiskGateDecisionId,
  makeStrategyEvaluationId,
  type AnyJournalEventEnvelope,
  type Candidate,
  type CausationId,
  type ConfigLineageRef,
  type EventId,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
  type ManagementActionType,
  type PositionStatus,
  type RunId,
  type SessionId,
  type SimulatedFill,
  type SimulatedOrderResult,
  type SizingDecision,
  type SessionPhase,
  type StrategyEvaluation,
  type UnixNs,
} from '../contracts/index.js';
import {
  createEntryOrderIntent,
  createManagementExitOrderIntent,
  toOrderIntentEventPayload,
  toSimFillEventPayload,
  type SimulatedExecutionAdapter,
  type SimulatedExecutionMarketState,
} from '../execution/simulated-execution.js';
import {
  applyExitFillToTargetPosition,
  applyInitialFillToTargetPosition,
  buildTargetPositionFromCandidate,
  evaluatePositionManager,
  POSITION_MANAGER_VERSION,
  resolveManagementProfile,
  summarizeTargetPositionForJournal,
  type ManagementProfilesConfig,
  type PositionManagerMarketInput,
  type PositionManagerEvaluation,
  type TargetPosition,
} from '../management/index.js';
import {
  applyRealizedPnl,
  createSessionRiskState,
  evaluateRiskGate,
  RISK_MANAGER_VERSION,
  resetSessionRiskState,
  resolveRiskPolicy,
  sizeCandidate,
  toRiskGateEventPayload,
  updateSessionRiskState,
  type LoadedRiskPolicyConfig,
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
import { buildFeatureAvailabilityMask } from '../features/availability-mask.js';
import type { StrategyId } from '../contracts/strategy-ids.js';
import type { StrategyRuntimeEngineContainer } from './engine-container.js';
import {
  DEFAULT_MNQ_ROLL_CALENDAR_CONFIG,
  DEFAULT_MNQ_SESSION_CALENDAR_CONFIG,
  evaluateMnqSessionEligibility,
  type MnqEligibilityReason,
  type MnqRollCalendarConfig,
  type MnqRollPeriod,
  type MnqRollPhase,
  type MnqSessionCalendarConfig,
  type MnqSessionEligibility,
  type MnqSessionPhase,
} from '../session/index.js';
import {
  BoundedAckLatencyObserver,
  getDefaultLatencySliRegistry,
} from '../observability/latency-sli.js';

export const STRATEGY_RUNNER_VERSION = 'strategy_runner_loop_v1' as const;

const RUNTIME_DECISION_FORBIDDEN_PAYLOAD_KEYS = new Set([
  'diagnostic_values',
  'shadow_values',
  'mbo_shadow_lineage',
  'decision_use',
]);

const RUNTIME_DECISION_FORBIDDEN_FEATURE_FIELDS = new Set(
  Object.entries(buildFeatureAvailabilityMask().field_tiers)
    .filter(([, tier]) => tier !== 'authoritative')
    .map(([field]) => field),
);

export interface RuntimeShadowReadGuardViolation {
  readonly path: string;
  readonly reason: 'payload_section_not_exposed_to_strategy' | 'non_authoritative_feature_field';
}

export interface StrategyRuntimeRunnerOptions {
  readonly container: StrategyRuntimeEngineContainer;
  readonly run_id: RunId;
  readonly session_id: SessionId;
  readonly execution_adapter: SimulatedExecutionAdapter;
  readonly account_ref?: string;
  readonly risk_policy?: PartialRiskPolicyConfig;
  readonly risk_config?: LoadedRiskPolicyConfig;
  readonly management_profiles?: ManagementProfilesConfig;
  readonly mnq_session_calendar?: MnqSessionCalendarConfig;
  readonly mnq_roll_calendar?: MnqRollCalendarConfig;
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
  readonly session_phase_event?: JournalEventEnvelope<'SESSION_PHASE', JournalEventPayloadFor<'SESSION_PHASE'>>;
  readonly roll_advisory_event?: JournalEventEnvelope<'ROLL_ADVISORY', JournalEventPayloadFor<'ROLL_ADVISORY'>>;
  readonly forced_flatten_action_events: readonly JournalEventEnvelope<'MGMT_ACTION', JournalEventPayloadFor<'MGMT_ACTION'>>[];
  readonly mnq_eligibility: MnqSessionEligibility;
  readonly strategy_evaluation_events: readonly JournalEventEnvelope<'STRAT_EVAL', JournalEventPayloadFor<'STRAT_EVAL'>>[];
  readonly candidate_events: readonly JournalEventEnvelope<'CANDIDATE', JournalEventPayloadFor<'CANDIDATE'>>[];
  readonly rank_event: JournalEventEnvelope<'RANK', JournalEventPayloadFor<'RANK'>>;
  readonly sizing_events: readonly JournalEventEnvelope<'SIZING', JournalEventPayloadFor<'SIZING'>>[];
  readonly risk_gate_events: readonly JournalEventEnvelope<'RISK_GATE', JournalEventPayloadFor<'RISK_GATE'>>[];
  readonly order_intent_events: readonly JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>[];
  readonly sim_fill_events: readonly JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>[];
  readonly exec_reject_events: readonly JournalEventEnvelope<'EXEC_REJECT', JournalEventPayloadFor<'EXEC_REJECT'>>[];
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
  readonly order_intent_events: readonly JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>[];
  readonly sim_fill_events: readonly JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>[];
  readonly exec_reject_events: readonly JournalEventEnvelope<'EXEC_REJECT', JournalEventPayloadFor<'EXEC_REJECT'>>[];
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
  private readonly riskConfigHash: string | undefined;
  private readonly managementProfiles: ManagementProfilesConfig;
  private readonly mnqSessionCalendar: MnqSessionCalendarConfig;
  private readonly mnqRollCalendar: MnqRollCalendarConfig;
  private readonly maxCandidatesPerCycle: number;
  private readonly appConfigRef: ConfigLineageRef;
  private readonly strategyConfig: StrategyRuntimeConfig;
  private readonly strategyConfigHash: string;
  private readonly latencySli = getDefaultLatencySliRegistry();
  private readonly ackLatencyObserver = new BoundedAckLatencyObserver({
    registry: this.latencySli,
  });
  private sessionRisk: SessionRiskState | undefined;
  private openPositions: TargetPosition[] = [];
  private lastSessionTransition: RunnerSessionTransition | undefined;
  private lastRollTransition: RunnerRollTransition | undefined;
  private readonly emittedRollFlattenActions = new Set<string>();
  private readonly executedManagementActionIds = new Set<string>();

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
    const loadedRiskConfig = options.risk_config ?? options.container.config.riskConfig;
    this.riskPolicy =
      options.risk_policy ??
      loadedRiskConfig?.policy ??
      failMissingRiskConfig(options.container.config);
    this.riskConfigHash = loadedRiskConfig?.lineage.risk_config_hash;
    this.managementProfiles =
      options.management_profiles ??
      options.container.config.managementProfiles ??
      failMissingManagementProfilesConfig(options.container.config);
    this.mnqSessionCalendar = options.mnq_session_calendar ?? DEFAULT_MNQ_SESSION_CALENDAR_CONFIG;
    this.mnqRollCalendar = options.mnq_roll_calendar ?? DEFAULT_MNQ_ROLL_CALENDAR_CONFIG;
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
    this.ackLatencyObserver.observe(event as AnyJournalEventEnvelope);
    return event;
  }

  async processFeatureSnapshot(
    snapshot: StrategyFeatureSnapshot,
  ): Promise<StrategyEvaluationCycleResult> {
    assertRuntimeShadowReadGuard(snapshot);
    const sessionRisk = this.ensureSessionRisk(snapshot);
    const eligibility = evaluateMnqSessionEligibility({
      sessionCalendar: this.mnqSessionCalendar,
      rollCalendar: this.mnqRollCalendar,
      timestamp_ns: snapshot.created_ts_ns,
    });
    const sessionPhaseEvent = await this.publishSessionPhaseTransition(snapshot, eligibility);
    const rollAdvisoryEvent = await this.publishRollAdvisoryTransition(snapshot, eligibility);
    const forcedFlattenActionEvents = await this.publishRollForcedFlattenActions(
      snapshot,
      eligibility,
      rollAdvisoryEvent,
    );
    const forcedFlattenExecution = await this.executeManagementActionEvents({
      action_events: forcedFlattenActionEvents,
      market: toExecutionMarketState(snapshot),
    });
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
      const result: { readonly evaluation: StrategyEvaluation; readonly candidate?: Candidate } = eligibility.candidate_eligible
        ? evaluateStrategySafely(strategyId, snapshot, this.strategyConfig)
        : {
          evaluation: buildMnqBlockedStrategyEvaluation(strategyId, snapshot, eligibility),
        };
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
    const orderIntentEvents: JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>[] = [
      ...forcedFlattenExecution.order_intent_events,
    ];
    const simFillEvents: JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>[] = [
      ...forcedFlattenExecution.sim_fill_events,
    ];
    const execRejectEvents: JournalEventEnvelope<'EXEC_REJECT', JournalEventPayloadFor<'EXEC_REJECT'>>[] = [
      ...forcedFlattenExecution.exec_reject_events,
    ];
    const positionEvents: JournalEventEnvelope<'POSITION', JournalEventPayloadFor<'POSITION'>>[] = [
      ...forcedFlattenExecution.position_events,
    ];

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
        payload: toSizingEventPayload(sizing, this.strategyConfigHash, this.riskConfigHash),
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
          risk_config_hash: this.riskConfigHash,
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
      this.ackLatencyObserver.observe(intentEvent);
      this.latencySli.recordSnapshotToSubmitNs(snapshot.created_ts_ns, intentEvent.ts_ns);

      const orderResult = await this.executionAdapter.submit({
        intent,
        market: toExecutionMarketState(snapshot),
        fill_ts_ns: candidate.proposed_ts_ns,
      });
      const rejectEvent = await this.publishExecutionRejectIfNeeded({
        order_result: orderResult,
        intent_event: intentEvent,
        lineage: {
          strategy_config_hash: this.strategyConfigHash,
        },
        correlation_id: makeCorrelationId(`corr-${candidate.candidate_id}`),
      });
      if (rejectEvent !== undefined) {
        execRejectEvents.push(rejectEvent);
      }

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

        const openPosition = this.openTargetPositionFromFill(candidate, fill);
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
      session_phase_event: sessionPhaseEvent,
      roll_advisory_event: rollAdvisoryEvent,
      forced_flatten_action_events: forcedFlattenActionEvents,
      mnq_eligibility: eligibility,
      strategy_evaluation_events: evaluationEvents,
      candidate_events: candidateEvents,
      rank_event: rankEvent,
      sizing_events: sizingEvents,
      risk_gate_events: riskGateEvents,
      order_intent_events: orderIntentEvents,
      sim_fill_events: simFillEvents,
      exec_reject_events: execRejectEvents,
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
    const orderIntentEvents: JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>[] = [];
    const simFillEvents: JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>[] = [];
    const execRejectEvents: JournalEventEnvelope<'EXEC_REJECT', JournalEventPayloadFor<'EXEC_REJECT'>>[] = [];
    const positionEvents: JournalEventEnvelope<'POSITION', JournalEventPayloadFor<'POSITION'>>[] = [];
    const managementResults: PositionManagerEvaluation[] = [];
    const nextPositions: TargetPosition[] = [];

    for (const position of this.openPositions) {
      const result = evaluatePositionManager({
        position,
        profile: this.resolveManagementProfile(position.strategy_id).profile,
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
          management_profile_hash: position.profile_hash,
          management_profile_id: position.profile_id,
          management_profile_version: position.profile_version,
          position_manager_version: POSITION_MANAGER_VERSION,
        },
      });
      managementTickEvents.push(tickEvent);

      let positionCauseEventId: EventId = tickEvent.event_id;
      const positionActionEvents: JournalEventEnvelope<'MGMT_ACTION', JournalEventPayloadFor<'MGMT_ACTION'>>[] = [];
      for (const actionPayload of result.management_action_payloads) {
        const actionEvent = await this.publishDerivedEvent({
          event_id: makeEventId(`mgmt-action-${actionPayload.management_action_id}`),
          type: 'MGMT_ACTION',
          ts_ns: input.cause_event.ts_ns,
          causation_id: toCausationId(tickEvent.event_id),
          payload: {
            ...actionPayload,
            strategy_config_hash: this.strategyConfigHash,
            management_profile_hash: position.profile_hash,
            management_profile_id: position.profile_id,
            management_profile_version: position.profile_version,
            position_manager_version: POSITION_MANAGER_VERSION,
          },
        });
        positionCauseEventId = actionEvent.event_id;
        managementActionEvents.push(actionEvent);
        positionActionEvents.push(actionEvent);
      }

      const execution = await this.executeManagementActionEvents({
        action_events: positionActionEvents,
        market: toExecutionMarketStateFromManagementTick(position, input),
        positions: [position],
        manager_updated_position: result.updated_position,
      });
      orderIntentEvents.push(...execution.order_intent_events);
      simFillEvents.push(...execution.sim_fill_events);
      execRejectEvents.push(...execution.exec_reject_events);
      positionEvents.push(...execution.position_events);

      const rejectionEvent = execution.exec_reject_events.at(-1);
      const updatedPosition = execution.updated_positions.length > 0
        ? execution.updated_positions[execution.updated_positions.length - 1]!
        : rejectionEvent !== undefined
          ? position
        : result.updated_position;
      if (execution.position_events.length === 0) {
        this.applySessionRiskPositionChange(position, updatedPosition, input.cause_event.ts_ns);

        const positionEvent = await this.publishDerivedEvent({
          event_id: makeEventId(`position-update-${updatedPosition.position_id}-${input.cause_event.ts_ns}`),
          type: 'POSITION',
          ts_ns: input.cause_event.ts_ns,
          causation_id: toCausationId(rejectionEvent?.event_id ?? positionCauseEventId),
          payload: {
            ...(rejectionEvent === undefined
              ? result.position_event_payload
              : toPositionEventPayload(position, this.strategyConfigHash)),
            strategy_config_hash: this.strategyConfigHash,
            management_profile_hash: updatedPosition.profile_hash,
            management_profile_id: updatedPosition.profile_id,
            management_profile_version: updatedPosition.profile_version,
          },
        });
        positionEvents.push(positionEvent);
      }

      if (updatedPosition.lifecycle_state !== 'closed') {
        nextPositions.push(updatedPosition);
      }
    }

    this.openPositions = nextPositions;
    return {
      management_tick_events: managementTickEvents,
      management_action_events: managementActionEvents,
      order_intent_events: orderIntentEvents,
      sim_fill_events: simFillEvents,
      exec_reject_events: execRejectEvents,
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

  private async publishSystemEvent<TType extends 'SESSION_PHASE' | 'ROLL_ADVISORY'>(input: {
    readonly event_id: EventId;
    readonly type: TType;
    readonly ts_ns: UnixNs;
    readonly causation_id: CausationId;
    readonly payload: JournalEventPayloadFor<TType>;
  }): Promise<JournalEventEnvelope<TType, JournalEventPayloadFor<TType>>> {
    const event = createJournalEventEnvelope({
      event_id: input.event_id,
      type: input.type,
      ts_ns: input.ts_ns,
      run_id: this.runId,
      session_id: this.sessionId,
      payload: input.payload,
      causation_id: input.causation_id,
      config: this.appConfigRef,
    });
    await this.container.eventBus.publish(event as JournalEventEnvelope);
    return event;
  }

  private async publishSessionPhaseTransition(
    snapshot: StrategyFeatureSnapshot,
    eligibility: MnqSessionEligibility,
  ): Promise<JournalEventEnvelope<'SESSION_PHASE', JournalEventPayloadFor<'SESSION_PHASE'>> | undefined> {
    const transition = {
      session_phase: eligibility.session_phase,
      journal_phase: eligibility.journal_phase,
      trading_date: eligibility.trading_date,
    } satisfies RunnerSessionTransition;
    if (sameSessionTransition(this.lastSessionTransition, transition)) {
      return undefined;
    }
    const previous = this.lastSessionTransition;
    this.lastSessionTransition = transition;
    return this.publishSystemEvent({
      event_id: makeEventId(`session-phase-${snapshot.feature_snapshot_id}-${transition.session_phase}`),
      type: 'SESSION_PHASE',
      ts_ns: snapshot.created_ts_ns,
      causation_id: makeCausationId(snapshot.source_event_id),
      payload: {
        phase: transition.journal_phase,
        trading_date: transition.trading_date,
        ...(previous === undefined ? {} : { previous_phase: previous.journal_phase }),
        session_phase: transition.session_phase,
        ...(previous === undefined ? {} : { previous_session_phase: previous.session_phase }),
        active_contract: eligibility.active_contract,
        ...(eligibility.next_contract === undefined ? {} : { next_contract: eligibility.next_contract }),
        roll_phase: eligibility.roll_phase,
        candidate_eligible: eligibility.candidate_eligible,
        ...(eligibility.block_reason === undefined ? {} : { block_reason: eligibility.block_reason }),
        should_flatten: eligibility.flatten_required,
      },
    });
  }

  private async publishRollAdvisoryTransition(
    snapshot: StrategyFeatureSnapshot,
    eligibility: MnqSessionEligibility,
  ): Promise<JournalEventEnvelope<'ROLL_ADVISORY', JournalEventPayloadFor<'ROLL_ADVISORY'>> | undefined> {
    const advisory = rollAdvisoryForEligibility(eligibility);
    if (advisory === undefined || eligibility.next_contract === undefined) {
      if (eligibility.roll_phase === 'normal') {
        this.lastRollTransition = undefined;
      }
      return undefined;
    }
    const transition = {
      advisory,
      roll_phase: eligibility.roll_phase,
      active_contract: eligibility.active_contract,
      next_contract: eligibility.next_contract,
      block_reason: eligibility.block_reason,
      flatten_required: eligibility.flatten_required,
    } satisfies RunnerRollTransition;
    if (sameRollTransition(this.lastRollTransition, transition)) {
      return undefined;
    }
    const previous = this.lastRollTransition;
    this.lastRollTransition = transition;
    return this.publishSystemEvent({
      event_id: makeEventId(`roll-advisory-${snapshot.feature_snapshot_id}-${advisory}`),
      type: 'ROLL_ADVISORY',
      ts_ns: snapshot.created_ts_ns,
      causation_id: makeCausationId(snapshot.source_event_id),
      payload: {
        advisory,
        active_symbol: eligibility.active_contract,
        next_symbol: eligibility.next_contract,
        roll_phase: eligibility.roll_phase,
        ...(previous === undefined ? {} : { previous_roll_phase: previous.roll_phase }),
        candidate_eligible: eligibility.candidate_eligible,
        ...(eligibility.block_reason === undefined ? {} : { block_reason: eligibility.block_reason }),
        should_flatten: eligibility.flatten_required,
        minutes_to_cutover: minutesToCutover(this.mnqRollCalendar, eligibility, snapshot.created_ts_ns),
      },
    });
  }

  private async publishRollForcedFlattenActions(
    snapshot: StrategyFeatureSnapshot,
    eligibility: MnqSessionEligibility,
    rollAdvisoryEvent: JournalEventEnvelope<'ROLL_ADVISORY', JournalEventPayloadFor<'ROLL_ADVISORY'>> | undefined,
  ): Promise<readonly JournalEventEnvelope<'MGMT_ACTION', JournalEventPayloadFor<'MGMT_ACTION'>>[]> {
    if (!eligibility.flatten_required) {
      return [];
    }

    const rollPeriod = rollPeriodForEligibility(this.mnqRollCalendar, eligibility, snapshot.created_ts_ns);
    if (rollPeriod === undefined) {
      return [];
    }

    const causeEventId = rollAdvisoryEvent?.event_id ?? snapshot.source_event_id;
    const openPositions = [...this.openPositions]
      .filter((position) => position.lifecycle_state !== 'closed' && position.remaining_quantity > 0)
      .sort(compareTargetPositionsById);
    const actionEvents: JournalEventEnvelope<'MGMT_ACTION', JournalEventPayloadFor<'MGMT_ACTION'>>[] = [];

    for (const position of openPositions) {
      const flattenKey = rollFlattenActionKey(position, rollPeriod);
      if (this.emittedRollFlattenActions.has(flattenKey)) {
        continue;
      }
      this.emittedRollFlattenActions.add(flattenKey);

      const actionId = makeManagementActionId(
        `mgmt-roll-flatten-${position.position_id}-${rollPeriod.cutover_ts_ns}`,
      );
      const actionEvent = await this.publishDerivedEvent({
        event_id: makeEventId(`mgmt-action-${actionId}`),
        type: 'MGMT_ACTION',
        ts_ns: snapshot.created_ts_ns,
        causation_id: toCausationId(causeEventId),
        payload: {
          management_action_id: actionId,
          position_id: position.position_id,
          action_type: 'EXIT_FULL',
          reason: 'roll_window_flatten',
          exit_quantity: position.remaining_quantity,
          strategy_config_hash: this.strategyConfigHash,
          management_profile_hash: position.profile_hash,
          management_profile_id: position.profile_id,
          management_profile_version: position.profile_version,
          position_manager_version: POSITION_MANAGER_VERSION,
          active_contract: eligibility.active_contract,
          ...(eligibility.next_contract === undefined ? {} : { next_contract: eligibility.next_contract }),
          cutover_ts_ns: rollPeriod.cutover_ts_ns,
          roll_phase: eligibility.roll_phase,
        },
      });
      actionEvents.push(actionEvent);
    }

    return actionEvents;
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

  private resolveManagementProfile(strategyId: string) {
    return resolveManagementProfile(strategyId, {
      profiles: this.managementProfiles.profiles,
      fallback_profile: this.managementProfiles.fallback_profile,
    });
  }

  private openTargetPositionFromFill(
    candidate: Candidate,
    fill: SimulatedFill,
  ): TargetPosition {
    const profile = this.resolveManagementProfile(candidate.strategy_id);
    return applyInitialFillToTargetPosition(
      buildTargetPositionFromCandidate({
        candidate,
        profile: profile.profile,
        quantity: fill.quantity,
        opened_ts_ns: fill.filled_ts_ns,
      }),
      fill,
    );
  }

  private async executeManagementActionEvents(input: {
    readonly action_events: readonly JournalEventEnvelope<'MGMT_ACTION', JournalEventPayloadFor<'MGMT_ACTION'>>[];
    readonly market: SimulatedExecutionMarketState;
    readonly positions?: readonly TargetPosition[];
    readonly manager_updated_position?: TargetPosition;
  }): Promise<ManagementActionExecutionResult> {
    const orderIntentEvents: JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>[] = [];
    const simFillEvents: JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>[] = [];
    const execRejectEvents: JournalEventEnvelope<'EXEC_REJECT', JournalEventPayloadFor<'EXEC_REJECT'>>[] = [];
    const positionEvents: JournalEventEnvelope<'POSITION', JournalEventPayloadFor<'POSITION'>>[] = [];
    const updatedPositions: TargetPosition[] = [];
    const positionById = new Map(
      (input.positions ?? this.openPositions).map((position) => [String(position.position_id), position]),
    );

    for (const actionEvent of input.action_events) {
      const action = actionEvent.payload;
      if (!isExecutableManagementActionType(action.action_type)) {
        continue;
      }
      if (this.executedManagementActionIds.has(String(action.management_action_id))) {
        continue;
      }
      const position = positionById.get(String(action.position_id));
      if (position === undefined || position.lifecycle_state === 'closed' || position.remaining_quantity <= 0) {
        continue;
      }
      const exitQuantity = managementActionExitQuantity(action, position);
      if (exitQuantity === undefined) {
        continue;
      }

      this.executedManagementActionIds.add(String(action.management_action_id));
      const intent = createManagementExitOrderIntent({
        position,
        management_action_id: action.management_action_id,
        quantity: exitQuantity,
        submitted_ts_ns: actionEvent.ts_ns,
        config: this.appConfigRef,
      });
      const intentEvent = await this.publishDerivedEvent({
        event_id: makeEventId(`order-intent-${intent.order_intent_id}`),
        type: 'ORDER_INTENT',
        ts_ns: actionEvent.ts_ns,
        causation_id: toCausationId(actionEvent.event_id),
        payload: {
          ...toOrderIntentEventPayload(intent),
          strategy_config_hash: this.strategyConfigHash,
          management_action_id: action.management_action_id,
          position_id: position.position_id,
          management_profile_hash: position.profile_hash,
          management_profile_id: position.profile_id,
          management_profile_version: position.profile_version,
          position_manager_version: POSITION_MANAGER_VERSION,
        },
        correlation_id: makeCorrelationId(`corr-${position.candidate_id}`),
      });
      orderIntentEvents.push(intentEvent);
      this.ackLatencyObserver.observe(intentEvent);

      const orderResult = await this.executionAdapter.submit({
        intent,
        market: {
          ...input.market,
          instrument: position.instrument,
        },
        fill_ts_ns: actionEvent.ts_ns,
      });
      const rejectEvent = await this.publishExecutionRejectIfNeeded({
        order_result: orderResult,
        intent_event: intentEvent,
        lineage: {
          strategy_config_hash: this.strategyConfigHash,
          management_action_id: action.management_action_id,
          position_id: position.position_id,
          management_profile_hash: position.profile_hash,
          management_profile_id: position.profile_id,
          management_profile_version: position.profile_version,
          position_manager_version: POSITION_MANAGER_VERSION,
        },
        correlation_id: makeCorrelationId(`corr-${position.candidate_id}`),
      });
      if (rejectEvent !== undefined) {
        execRejectEvents.push(rejectEvent);
      }

      for (const fill of orderResult.fills) {
        const fillEvent = await this.publishDerivedEvent({
          event_id: makeEventId(`sim-fill-${fill.fill_id}`),
          type: 'SIM_FILL',
          ts_ns: fill.filled_ts_ns,
          causation_id: toCausationId(intentEvent.event_id),
          payload: {
            ...toSimFillEventPayload(fill),
            strategy_config_hash: this.strategyConfigHash,
            management_action_id: action.management_action_id,
            position_id: position.position_id,
            management_profile_hash: position.profile_hash,
            management_profile_id: position.profile_id,
            management_profile_version: position.profile_version,
            position_manager_version: POSITION_MANAGER_VERSION,
          },
          correlation_id: makeCorrelationId(`corr-${position.candidate_id}`),
        });
        simFillEvents.push(fillEvent);

        const currentPosition = positionById.get(String(position.position_id)) ?? position;
        const exitPosition = applyExitFillToTargetPosition(currentPosition, {
          fill,
          action_type: action.action_type,
          reason: action.reason,
          target_label: action.target_label,
        });
        const updatedPosition = mergeManagerStateAfterExecution(
          exitPosition,
          input.manager_updated_position,
        );
        positionById.set(String(position.position_id), updatedPosition);
        updatedPositions.push(updatedPosition);
        this.applySessionRiskPositionChange(currentPosition, updatedPosition, fill.filled_ts_ns);

        const positionEvent = await this.publishDerivedEvent({
          event_id: makeEventId(`position-close-${updatedPosition.position_id}-${fill.fill_id}`),
          type: 'POSITION',
          ts_ns: fill.filled_ts_ns,
          causation_id: toCausationId(fillEvent.event_id),
          payload: toPositionEventPayload(updatedPosition, this.strategyConfigHash),
          correlation_id: makeCorrelationId(`corr-${updatedPosition.candidate_id}`),
        });
        positionEvents.push(positionEvent);
      }
    }

    this.openPositions = this.openPositions
      .map((position) => positionById.get(String(position.position_id)) ?? position)
      .filter((position) => position.lifecycle_state !== 'closed');

    return {
      order_intent_events: orderIntentEvents,
      sim_fill_events: simFillEvents,
      exec_reject_events: execRejectEvents,
      position_events: positionEvents,
      updated_positions: updatedPositions,
    };
  }

  private async publishExecutionRejectIfNeeded(input: {
    readonly order_result: SimulatedOrderResult;
    readonly intent_event: JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>;
    readonly lineage: ExecutionRejectLineage;
    readonly correlation_id?: ReturnType<typeof makeCorrelationId>;
  }): Promise<JournalEventEnvelope<'EXEC_REJECT', JournalEventPayloadFor<'EXEC_REJECT'>> | undefined> {
    if (!shouldJournalExecutionReject(input.order_result)) {
      return undefined;
    }

    const rejectId = `exec-reject-${input.order_result.order_intent_id}`;
    const reason = input.order_result.reject_reason ?? `execution_${input.order_result.status}`;
    return this.publishDerivedEvent({
      event_id: makeEventId(rejectId),
      type: 'EXEC_REJECT',
      ts_ns: input.intent_event.ts_ns,
      causation_id: toCausationId(input.intent_event.event_id),
      payload: {
        execution_reject_id: rejectId,
        order_intent_id: input.order_result.order_intent_id,
        candidate_id: input.intent_event.payload.candidate_id,
        sizing_decision_id: input.intent_event.payload.sizing_decision_id,
        status: input.order_result.status,
        reason,
        execution_adapter: this.executionAdapter.adapter,
        execution_version: this.executionAdapter.version,
        ...input.lineage,
      },
      correlation_id: input.correlation_id,
    });
  }

  private applySessionRiskPositionChange(
    previousPosition: TargetPosition,
    updatedPosition: TargetPosition,
    eventTsNs: UnixNs,
  ): void {
    if (this.sessionRisk === undefined) {
      return;
    }
    const realizedDelta = round6(updatedPosition.realized_pnl_usd - previousPosition.realized_pnl_usd);
    if (updatedPosition.lifecycle_state === 'closed' && previousPosition.lifecycle_state !== 'closed') {
      this.sessionRisk = updateSessionRiskState(this.sessionRisk, {
        kind: 'trade_closed',
        realized_pnl_delta_usd: realizedDelta,
        event_ts_ns: eventTsNs,
      }, resolveRiskPolicy(this.riskPolicy).session);
      return;
    }
    if (realizedDelta !== 0) {
      this.sessionRisk = applyRealizedPnl({
        state: this.sessionRisk,
        realized_pnl_delta_usd: realizedDelta,
        event_ts_ns: eventTsNs,
        policy: resolveRiskPolicy(this.riskPolicy).session,
      });
    }
  }
}

function failMissingStrategyConfig(config: LoadedAppConfig): never {
  throw new Error(
    `strategy runtime config is required for ${STRATEGY_RUNNER_VERSION}; config source ${config.source.config_path}`,
  );
}

function failMissingManagementProfilesConfig(config: LoadedAppConfig): never {
  throw new Error(
    `management profiles config is required for ${STRATEGY_RUNNER_VERSION}; config source ${config.source.config_path}`,
  );
}

function failMissingRiskConfig(config: LoadedAppConfig): never {
  throw new Error(
    `risk config is required for ${STRATEGY_RUNNER_VERSION}; config source ${config.source.config_path}`,
  );
}

interface RunnerSessionTransition {
  readonly session_phase: MnqSessionPhase;
  readonly journal_phase: SessionPhase;
  readonly trading_date: string;
}

interface RunnerRollTransition {
  readonly advisory: JournalEventPayloadFor<'ROLL_ADVISORY'>['advisory'];
  readonly roll_phase: MnqRollPhase;
  readonly active_contract: string;
  readonly next_contract: string;
  readonly block_reason?: MnqEligibilityReason;
  readonly flatten_required: boolean;
}

type ExecutableManagementActionType = Extract<
  ManagementActionType,
  'TAKE_PARTIAL' | 'TAKE_PROFIT' | 'EXIT_FULL' | 'TIME_STOP_EXIT' | 'FAIL_SAFE_EXIT'
>;

interface ManagementActionExecutionResult {
  readonly order_intent_events: readonly JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>[];
  readonly sim_fill_events: readonly JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>[];
  readonly exec_reject_events: readonly JournalEventEnvelope<'EXEC_REJECT', JournalEventPayloadFor<'EXEC_REJECT'>>[];
  readonly position_events: readonly JournalEventEnvelope<'POSITION', JournalEventPayloadFor<'POSITION'>>[];
  readonly updated_positions: readonly TargetPosition[];
}

type RejectedExecutionResult = SimulatedOrderResult & {
  readonly status: 'rejected' | 'cancelled';
};

type ExecutionRejectLineage = Partial<Pick<
  JournalEventPayloadFor<'EXEC_REJECT'>,
  | 'strategy_config_hash'
  | 'management_action_id'
  | 'position_id'
  | 'management_profile_hash'
  | 'management_profile_id'
  | 'management_profile_version'
  | 'position_manager_version'
>>;

function buildMnqBlockedStrategyEvaluation(
  strategyId: StrategyId,
  snapshot: StrategyFeatureSnapshot,
  eligibility: MnqSessionEligibility,
): StrategyEvaluation {
  const reasons = eligibility.reasons.length === 0
    ? ['mnq_eligibility:blocked']
    : eligibility.reasons.map((reason) => `mnq_eligibility:${reason}`);
  return {
    strategy_evaluation_id: makeStrategyEvaluationId(
      `eval-${snapshot.feature_snapshot_id}-${strategyId}-mnq-blocked`,
    ),
    strategy_id: strategyId,
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    evaluated_ts_ns: snapshot.created_ts_ns,
    gate_state: 'blocked',
    reasons,
    config: snapshot.config,
  };
}

function rollAdvisoryForEligibility(
  eligibility: MnqSessionEligibility,
): JournalEventPayloadFor<'ROLL_ADVISORY'>['advisory'] | undefined {
  if (eligibility.flatten_required) return 'flatten_required';
  if (eligibility.reasons.includes('roll_block_window')) return 'block_new_entries';
  if (eligibility.roll_phase === 'pre_roll') return 'roll_window';
  if (eligibility.roll_phase === 'post_roll') return 'roll_complete';
  return undefined;
}

function sameSessionTransition(
  left: RunnerSessionTransition | undefined,
  right: RunnerSessionTransition,
): boolean {
  return (
    left?.session_phase === right.session_phase &&
    left.journal_phase === right.journal_phase &&
    left.trading_date === right.trading_date
  );
}

function sameRollTransition(
  left: RunnerRollTransition | undefined,
  right: RunnerRollTransition,
): boolean {
  return (
    left?.advisory === right.advisory &&
    left.roll_phase === right.roll_phase &&
    left.active_contract === right.active_contract &&
    left.next_contract === right.next_contract &&
    left.block_reason === right.block_reason &&
    left.flatten_required === right.flatten_required
  );
}

function minutesToCutover(
  rollCalendar: MnqRollCalendarConfig,
  eligibility: MnqSessionEligibility,
  tsNs: UnixNs,
): number | undefined {
  const period = rollPeriodForEligibility(rollCalendar, eligibility, tsNs);
  if (period === undefined) {
    return undefined;
  }
  return Number((BigInt(period.cutover_ts_ns) - BigInt(tsNs)) / 60_000_000_000n);
}

function rollPeriodForEligibility(
  rollCalendar: MnqRollCalendarConfig,
  eligibility: MnqSessionEligibility,
  tsNs: UnixNs,
): MnqRollPeriod | undefined {
  if (eligibility.next_contract === undefined || eligibility.roll_phase === 'normal') {
    return undefined;
  }
  return rollCalendar.periods.find(
    (candidate) =>
      candidate.next_contract === eligibility.next_contract &&
      tsNs >= candidate.roll_start_ts_ns &&
      tsNs <= candidate.roll_end_ts_ns,
  );
}

function compareTargetPositionsById(left: TargetPosition, right: TargetPosition): number {
  const leftId = String(left.position_id);
  const rightId = String(right.position_id);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function rollFlattenActionKey(position: TargetPosition, rollPeriod: MnqRollPeriod): string {
  return `${position.position_id}:${rollPeriod.cutover_ts_ns}`;
}

function evaluateStrategySafely(
  strategyId: StrategyId,
  snapshot: StrategyFeatureSnapshot,
  strategyConfig: StrategyRuntimeConfig,
): { readonly evaluation: StrategyEvaluation; readonly candidate?: Candidate } {
  const decisionStartMs = performance.now();
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
  } finally {
    getDefaultLatencySliRegistry().recordStrategyDecisionMs(
      strategyId,
      performance.now() - decisionStartMs,
    );
  }
}

export function assertRuntimeShadowReadGuard(snapshot: StrategyFeatureSnapshot): void {
  const violations = collectRuntimeShadowReadGuardViolations(snapshot);
  if (violations.length === 0) {
    return;
  }
  const first = violations[0]!;
  throw new Error(
    `Runtime shadow-read guard refused strategy snapshot field ${first.path}: ${first.reason}`,
  );
}

export function collectRuntimeShadowReadGuardViolations(
  snapshot: StrategyFeatureSnapshot,
): readonly RuntimeShadowReadGuardViolation[] {
  const violations: RuntimeShadowReadGuardViolation[] = [];
  const seen = new WeakSet<object>();
  walkRuntimeSnapshotForShadowFields(snapshot, '$', violations, seen);
  return violations;
}

function walkRuntimeSnapshotForShadowFields(
  value: unknown,
  path: string,
  violations: RuntimeShadowReadGuardViolation[],
  seen: WeakSet<object>,
): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walkRuntimeSnapshotForShadowFields(value[index], `${path}[${index}]`, violations, seen);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (RUNTIME_DECISION_FORBIDDEN_PAYLOAD_KEYS.has(key)) {
      violations.push({
        path: childPath,
        reason: 'payload_section_not_exposed_to_strategy',
      });
    }
    if (RUNTIME_DECISION_FORBIDDEN_FEATURE_FIELDS.has(key)) {
      violations.push({
        path: childPath,
        reason: 'non_authoritative_feature_field',
      });
    }
    walkRuntimeSnapshotForShadowFields(child, childPath, violations, seen);
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
  riskConfigHash: string | undefined,
): JournalEventPayloadFor<'SIZING'> {
  return {
    sizing_decision_id: sizing.sizing_decision_id,
    candidate_id: sizing.candidate_id,
    quantity: sizing.quantity,
    risk_usd: sizing.risk_usd,
    risk_points: sizing.risk_points,
    rejected_reason: sizing.rejected_reason,
    strategy_config_hash: strategyConfigHash,
    risk_config_hash: riskConfigHash,
    risk_manager_version: RISK_MANAGER_VERSION,
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
    management_profile_hash: summary.profile_hash,
    management_profile_id: summary.profile_id,
    management_profile_version: summary.profile_version,
  };
}

function toPositionStatus(lifecycleState: TargetPosition['lifecycle_state']): PositionStatus {
  if (lifecycleState === 'closed') return 'closed';
  if (lifecycleState === 'closing') return 'closing';
  return 'open';
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

function toExecutionMarketStateFromManagementTick(
  position: TargetPosition,
  input: RunnerManagementTickInput,
): SimulatedExecutionMarketState {
  return {
    instrument: position.instrument,
    ts_ns: input.cause_event.ts_ns,
    bid_px: input.bid_px ?? input.mark_price,
    ask_px: input.ask_px ?? input.mark_price,
    last_trade_price: input.mark_price,
  };
}

function toCausationId(eventId: EventId): CausationId {
  return makeCausationId(String(eventId));
}

function isExecutableManagementActionType(
  actionType: ManagementActionType,
): actionType is ExecutableManagementActionType {
  return (
    actionType === 'TAKE_PARTIAL' ||
    actionType === 'TAKE_PROFIT' ||
    actionType === 'EXIT_FULL' ||
    actionType === 'TIME_STOP_EXIT' ||
    actionType === 'FAIL_SAFE_EXIT'
  );
}

function shouldJournalExecutionReject(
  result: SimulatedOrderResult,
): result is RejectedExecutionResult {
  return result.fills.length === 0 && (result.status === 'rejected' || result.status === 'cancelled');
}

function managementActionExitQuantity(
  action: JournalEventPayloadFor<'MGMT_ACTION'>,
  position: TargetPosition,
): number | undefined {
  const exitQuantity = action.exit_quantity;
  if (!Number.isInteger(exitQuantity) || exitQuantity === undefined || exitQuantity <= 0) {
    return undefined;
  }
  return Math.min(exitQuantity, position.remaining_quantity);
}

function mergeManagerStateAfterExecution(
  executedPosition: TargetPosition,
  managerUpdatedPosition: TargetPosition | undefined,
): TargetPosition {
  if (
    managerUpdatedPosition === undefined ||
    managerUpdatedPosition.position_id !== executedPosition.position_id ||
    executedPosition.lifecycle_state === 'closed'
  ) {
    return executedPosition;
  }

  return {
    ...executedPosition,
    active_stop_price: managerUpdatedPosition.active_stop_price,
    break_even: managerUpdatedPosition.break_even,
    trailing_stop: managerUpdatedPosition.trailing_stop,
    time_stop: managerUpdatedPosition.time_stop,
    fail_safe: managerUpdatedPosition.fail_safe,
    reasons: uniqueStrings([
      ...executedPosition.reasons,
      ...managerUpdatedPosition.reasons.filter((reason) => !executedPosition.reasons.includes(reason)),
    ]),
  };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
