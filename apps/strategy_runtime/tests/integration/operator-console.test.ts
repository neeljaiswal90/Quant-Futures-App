import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeEventId,
  ns,
  type AnyJournalEventEnvelope,
  type JournalEventPayloadFor,
} from '../../src/contracts/index.js';
import { LatencySliRegistry } from '../../src/observability/latency-sli.js';
import { BurnRateEvaluator } from '../../src/observability/burn-rate-evaluator.js';
import type { SloDefinition } from '../../src/observability/slo-registry.js';
import {
  OperatorConsole,
  type OperatorConsoleEventSource,
  type OperatorConsoleSubscription,
} from '../../src/operator/console/operator-console.js';
import {
  OPERATOR_CONSOLE_CURRENT_EVENT_TYPES,
  OperatorConsoleStateStore,
  type CurrentOperatorConsoleEventType,
} from '../../src/operator/console/console-state.js';

const ORIGINAL_NO_COLOR = process.env.NO_COLOR;
const BASE_TS_NS = 1_800_000_000_000_000_000n;

beforeAll(() => {
  process.env.NO_COLOR = 'true';
});

afterAll(() => {
  if (ORIGINAL_NO_COLOR === undefined) {
    delete process.env.NO_COLOR;
    return;
  }
  process.env.NO_COLOR = ORIGINAL_NO_COLOR;
});

describe('QFA-630 operator console integration', () => {
  it('renders a full synthetic dashboard from subscribed journal events and snapshots', () => {
    let nowMs = 0;
    const latencyRegistry = new LatencySliRegistry();
    latencyRegistry.recordStrategyDecisionMs('regime_shock_reversion_short_v2', 7);
    latencyRegistry.recordStrategyDecisionMs('regime_shock_reversion_short_v2', 35);
    latencyRegistry.recordEventLoopLagMs(4);
    latencyRegistry.recordSnapshotToSubmitMs(80);
    latencyRegistry.recordOrderAckSubmissionMs(250);

    const burnRateEvaluator = new BurnRateEvaluator({
      definitions: [sloDefinition()],
      now_ms: () => nowMs,
      now_ns: () => ns(BASE_TS_NS + BigInt(nowMs) * 1_000_000n),
    });
    const source = new ManualOperatorConsoleEventSource();
    const writes: string[] = [];
    const submissionGate = {
      open_quarantine_count: 1,
      active_block_sources: ['quarantine_active'],
    };
    const console = new OperatorConsole({
      event_source: source,
      state_store: new OperatorConsoleStateStore({
        now_ms: () => nowMs,
        started_at_ms: 0,
        strategy_id: 'regime_shock_reversion_short_v2',
        burn_rate_evaluator: burnRateEvaluator,
        latency_registry: latencyRegistry,
        submission_gate: submissionGate,
      }),
      writer: { write: (chunk) => writes.push(chunk) },
      refresh_interval_ms: 1_000,
      clear_screen: false,
    });

    console.start();
    expect(source.subscribedEventTypes()).toEqual(OPERATOR_CONSOLE_CURRENT_EVENT_TYPES);
    source.publish(event('SESSION_MANIFEST', {
      mask_id: 'execution-capability-mask-v1-adr0018-paper-only-order-plant',
      mask_version: 1,
      mask_hash: 'sha256:abcdef1234567890',
      reconnect_policy_config: { max_attempts: 3 },
      plant_scope: 'ORDER_PLANT',
      mode: 'paper',
      timestamp_anchor: 'dual',
      broker_session_id: 'broker-session-1',
      adapter_kind: 'MOCK_ORDER_PLANT',
    }));
    source.publish(event('ORDER_QUARANTINE_ENTERED', {
      intent_id: makeEventId('intent-1'),
      previous_state: 'pending_ack',
      quarantine_reason: 'submission_ack_timeout',
      open_quarantine_count: 1,
      timeout_ms: 5,
      escalation_required: true,
      is_provisional: true,
      broker_order_id: 'broker-1',
      instrument_symbol: 'MNQM6',
    }));
    source.publish(event('WOULD_HALT', {
      state: 'halted',
      reason: 'slo_breach:qfa_strategy_decision_ms',
    }));
    source.publish(event('HALT', {
      state: 'halted',
      reason: 'operator_console_manual_halt',
      resolved: false,
    }));
    source.publish(event('VALIDATOR_ISSUE', {
      validator_id: 'EXEC-VALIDATOR-07',
      severity: 'fatal',
      emitted_ts_ns: ns(BASE_TS_NS + 2_000_000n),
      code: 'execution_mask_drift',
      message: 'live execution capability mask differs from filesystem/artifact mask',
      source_event_type: 'CONFIG',
    }));
    submissionGate.open_quarantine_count = 0;
    submissionGate.active_block_sources = ['slo_halt'];
    source.publish(event('ORDER_QUARANTINE_CLEARED', {
      clear_reason: 'all_quarantines_resolved',
      open_quarantine_count: 0,
      resolved_intent_ids: [makeEventId('intent-1')],
    }));

    nowMs = 1;
    burnRateEvaluator.observeSampleAt('qfa_strategy_decision_ms', 35, nowMs);

    const rendered = console.renderOnce();
    console.stop();

    expect(writes[0]).toContain('Quant Futures Operator Console');
    expect(rendered).toContain('type=WOULD_HALT state=halted reason=slo_breach:qfa_strategy_decision_ms');
    expect(rendered).toContain('type=HALT state=halted reason=operator_console_manual_halt');
    expect(rendered).toContain('[Quarantine]\n  open_quarantine_count=0 escalation_required=false\n  orders=none');
    expect(rendered).toMatchInlineSnapshot(`
      "Quant Futures Operator Console
      mode=read_only source=journal_events+observability_snapshots panels=7 future_slots=liveness,kill_switch,anomalies
      controls=disabled inputs=disabled ansi_renderer=true
      
      [Header]
        session_id=session-qfa-630 mode=paper uptime=00:00:00
        strategy_id=regime_shock_reversion_short_v2 capability_mask_version=1 manifest_ts_ns=1800000000000000000
      
      [SLO]
        metric=qfa_strategy_decision_ms state=breach last_transition_ts_ns=1800000000001000000 provisional=true eligibility=eligible windows=[5m:breach:samples=1/1:p95_ms=<=35:budget_ms=20]
      
      [Quarantine]
        open_quarantine_count=0 escalation_required=false
        orders=none
      
      [Halt]
        current_block_sources=slo_halt
        type=WOULD_HALT state=halted reason=slo_breach:qfa_strategy_decision_ms resolved=-- ts_ns=1800000000000000000
        type=HALT state=halted reason=operator_console_manual_halt resolved=false ts_ns=1800000000000000000
      
      [Validators]
        severity=fatal validator=EXEC-VALIDATOR-07 code=execution_mask_drift source=CONFIG emitted_ts_ns=1800000000002000000 message=\"live execution capability mask differs from filesystem/artifact mask\"
      
      [Latency]
        ack_intent_cache_misses=0
        metric=qfa_strategy_decision_ms labels=strategy_id:regime_shock_reversion_short_v2 count=2 p50_ms=<=10 p95_ms=<=50 p99_ms=<=50 bucket_utilization=2/13
        metric=qfa_event_loop_lag_ms labels=none count=1 p50_ms=<=5 p95_ms=<=5 p99_ms=<=5 bucket_utilization=1/13
        metric=qfa_snapshot_to_submit_ms labels=none count=1 p50_ms=<=100 p95_ms=<=100 p99_ms=<=100 bucket_utilization=1/13
        metric=qfa_order_ack_submission_ms labels=none count=1 p50_ms=<=250 p95_ms=<=250 p99_ms=<=250 bucket_utilization=1/13
        metric=qfa_order_ack_cancel_ms labels=none count=0 p50_ms=-- p95_ms=-- p99_ms=-- bucket_utilization=0/13
        metric=qfa_order_ack_fill_ms labels=none count=0 p50_ms=-- p95_ms=-- p99_ms=-- bucket_utilization=0/13
      
      [Mask]
        mask_id=execution-capability-mask-v1-adr0018-paper-only-order-plant mask_version=1 mask_hash8=abcdef12
        exec_validator_07_drift_status=drift_detected code=execution_mask_drift severity=fatal ts_ns=1800000000002000000
      "
    `);
  });
});

class ManualOperatorConsoleEventSource implements OperatorConsoleEventSource {
  private readonly subscribers: Array<{
    readonly eventTypes: ReadonlySet<CurrentOperatorConsoleEventType>;
    readonly handler: (event: AnyJournalEventEnvelope) => void | Promise<void>;
  }> = [];

  subscribe(
    options: Parameters<OperatorConsoleEventSource['subscribe']>[0],
    handler: Parameters<OperatorConsoleEventSource['subscribe']>[1],
  ): OperatorConsoleSubscription {
    const subscriber = {
      eventTypes: new Set(options.event_types),
      handler,
    };
    this.subscribers.push(subscriber);
    return {
      unsubscribe: () => {
        const index = this.subscribers.indexOf(subscriber);
        if (index >= 0) {
          this.subscribers.splice(index, 1);
        }
      },
    };
  }

  publish(eventToPublish: AnyJournalEventEnvelope): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.eventTypes.has(eventToPublish.type as CurrentOperatorConsoleEventType)) {
        void subscriber.handler(eventToPublish);
      }
    }
  }

  subscribedEventTypes(): readonly CurrentOperatorConsoleEventType[] {
    return [...this.subscribers[0]!.eventTypes];
  }
}

function event<TType extends CurrentOperatorConsoleEventType>(
  type: TType,
  payload: JournalEventPayloadFor<TType>,
): AnyJournalEventEnvelope {
  return {
    schema_version: 2,
    event_id: makeEventId(`evt-${type.toLowerCase()}`),
    type,
    ts_ns: ns(BASE_TS_NS),
    run_id: 'run-qfa-630',
    session_id: 'session-qfa-630',
    payload,
  } as AnyJournalEventEnvelope;
}

function sloDefinition(): SloDefinition {
  return {
    metric_name: 'qfa_strategy_decision_ms',
    windows: [
      {
        window_id: '5m',
        window_duration_ms: 300_000,
        sample_count_floor: 1,
        p95_budget_ms: 20,
      },
    ],
    is_provisional: true,
    breach_eligibility: 'eligible',
  };
}