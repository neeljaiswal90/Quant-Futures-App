import { describe, expect, it } from 'vitest';
import { ns } from '../../src/contracts/time.js';
import { SubmissionGate } from '../../src/execution/order-lifecycle-state-machine.js';
import type { SloStateTransition } from '../../src/observability/burn-rate-evaluator.js';
import { SloHaltEmitter, type RuntimeMode } from '../../src/observability/slo-halt-emitter.js';
import type { SloDefinition } from '../../src/observability/slo-registry.js';

const ELIGIBLE_FINAL_SLO: SloDefinition = {
  metric_name: 'qfa_strategy_decision_ms',
  windows: [],
  is_provisional: false,
  breach_eligibility: 'eligible',
};

const ELIGIBLE_PROVISIONAL_SLO: SloDefinition = {
  metric_name: 'qfa_event_loop_lag_ms',
  windows: [],
  is_provisional: true,
  breach_eligibility: 'eligible',
};

const ACK_NOT_APPLICABLE_SLO: SloDefinition = {
  metric_name: 'qfa_order_ack_submission_ms',
  windows: [],
  is_provisional: true,
  breach_eligibility: 'not_applicable_until_phase_6_ack',
};

describe('SloHaltEmitter', () => {
  it('emits WOULD_HALT for paper eligible final breaches without flipping the gate', () => {
    const gate = new SubmissionGate();
    const emitter = createEmitter('paper', gate, [ELIGIBLE_FINAL_SLO]);

    const events = emitter.onTransitions([transition('qfa_strategy_decision_ms', 'pass', 'breach')]);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('WOULD_HALT');
    expect(events[0]!.payload).toEqual({
      state: 'halted',
      reason: 'slo_breach:qfa_strategy_decision_ms',
    });
    expect(gate.acquire()).toEqual({ allowed: true });
  });

  it('emits HALT for live eligible final breaches and flips the SLO halt gate source', () => {
    const gate = new SubmissionGate();
    const emitter = createEmitter('live', gate, [ELIGIBLE_FINAL_SLO]);

    const events = emitter.onTransitions([transition('qfa_strategy_decision_ms', 'pass', 'breach')]);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('HALT');
    expect(events[0]!.flipped_gate).toBe(true);
    expect(gate.acquire()).toEqual({
      allowed: false,
      reason: 'slo_halt_active',
      open_quarantine_count: 0,
      active_block_sources: ['slo_halt'],
    });
  });

  it('emits WOULD_HALT for live eligible provisional breaches without flipping the gate', () => {
    const gate = new SubmissionGate();
    const emitter = createEmitter('live', gate, [ELIGIBLE_PROVISIONAL_SLO]);

    const events = emitter.onTransitions([transition('qfa_event_loop_lag_ms', 'pass', 'breach', true)]);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('WOULD_HALT');
    expect(events[0]!.flipped_gate).toBe(false);
    expect(gate.acquire()).toEqual({ allowed: true });
  });

  it('emits WOULD_HALT for not-yet-applicable ACK SLO breaches in paper and live modes', () => {
    const gate = new SubmissionGate();
    let mode: RuntimeMode = 'paper';
    const emitter = new SloHaltEmitter({
      slo_definitions: [ACK_NOT_APPLICABLE_SLO],
      runtime_mode_reader: () => mode,
      submission_gate: gate,
    });

    const paperEvents = emitter.onTransitions([transition('qfa_order_ack_submission_ms', 'pass', 'breach', true)]);
    mode = 'live';
    const liveEvents = emitter.onTransitions([
      transition('qfa_order_ack_submission_ms', 'breach', 'pass', true),
      transition('qfa_order_ack_submission_ms', 'pass', 'breach', true),
    ]);

    expect(paperEvents[0]!.type).toBe('WOULD_HALT');
    expect(liveEvents[liveEvents.length - 1]!.type).toBe('WOULD_HALT');
    expect(gate.acquire()).toEqual({ allowed: true });
  });

  it('does not emit for insufficient-data transitions', () => {
    const emitter = createEmitter('live', new SubmissionGate(), [ELIGIBLE_FINAL_SLO]);

    expect(emitter.onTransitions([transition('qfa_strategy_decision_ms', 'pass', 'insufficient_data')])).toEqual([]);
    expect(emitter.onTransitions([transition('qfa_strategy_decision_ms', 'insufficient_data', 'pass')])).toEqual([]);
    expect(emitter.onTransitions([transition('qfa_strategy_decision_ms', 'insufficient_data', 'breach')])).toEqual([]);
  });

  it('emits live HALT resolution and releases only the SLO halt block source', () => {
    const gate = new SubmissionGate();
    const emitter = createEmitter('live', gate, [ELIGIBLE_FINAL_SLO]);

    emitter.onTransitions([transition('qfa_strategy_decision_ms', 'pass', 'breach')]);
    const events = emitter.onTransitions([transition('qfa_strategy_decision_ms', 'breach', 'pass')]);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('HALT');
    expect(events[0]!.payload).toEqual({
      state: 'resumed',
      reason: 'slo_resolved:qfa_strategy_decision_ms',
      resolved: true,
    });
    expect(gate.acquire()).toEqual({ allowed: true });
  });

  it('emits paper WOULD_HALT resolution after a prior paper would-halt', () => {
    const emitter = createEmitter('paper', new SubmissionGate(), [ELIGIBLE_FINAL_SLO]);

    emitter.onTransitions([transition('qfa_strategy_decision_ms', 'pass', 'breach')]);
    const events = emitter.onTransitions([transition('qfa_strategy_decision_ms', 'breach', 'pass')]);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('WOULD_HALT');
    expect(events[0]!.payload.resolved).toBe(true);
  });

  it('requires all gate block sources to clear before submissions resume', () => {
    const gate = new SubmissionGate();
    const emitter = createEmitter('live', gate, [ELIGIBLE_FINAL_SLO]);

    gate.blockFromQuarantine();
    emitter.onTransitions([transition('qfa_strategy_decision_ms', 'pass', 'breach')]);
    expect(gate.acquire()).toEqual({
      allowed: false,
      reason: 'quarantine_active',
      open_quarantine_count: 1,
      active_block_sources: ['quarantine', 'slo_halt'],
    });

    emitter.onTransitions([transition('qfa_strategy_decision_ms', 'breach', 'pass')]);
    expect(gate.acquire()).toEqual({
      allowed: false,
      reason: 'quarantine_active',
      open_quarantine_count: 1,
    });

    gate.unblockFromQuarantine();
    expect(gate.acquire()).toEqual({ allowed: true });
  });

  it('uses the live mode reader dynamically between breach periods', () => {
    const gate = new SubmissionGate();
    let mode: RuntimeMode = 'paper';
    const emitter = new SloHaltEmitter({
      slo_definitions: [ELIGIBLE_FINAL_SLO],
      runtime_mode_reader: () => mode,
      submission_gate: gate,
    });

    const firstBreach = emitter.onTransitions([transition('qfa_strategy_decision_ms', 'pass', 'breach')]);
    emitter.onTransitions([transition('qfa_strategy_decision_ms', 'breach', 'pass')]);
    mode = 'live';
    const secondBreach = emitter.onTransitions([transition('qfa_strategy_decision_ms', 'pass', 'breach')]);

    expect(firstBreach[0]!.type).toBe('WOULD_HALT');
    expect(secondBreach[0]!.type).toBe('HALT');
  });

  it('can subscribe to transition batches from a burn-rate evaluator boundary', () => {
    const emitted: unknown[] = [];
    const emitter = new SloHaltEmitter({
      slo_definitions: [ELIGIBLE_FINAL_SLO],
      emit: (event) => emitted.push(event),
    });
    const unsubscribe = emitter.subscribe({
      subscribe(handler) {
        handler([transition('qfa_strategy_decision_ms', 'pass', 'breach')]);
        return () => emitted.push('unsubscribed');
      },
    });

    unsubscribe();

    expect(emitted).toHaveLength(2);
    expect((emitted[0] as { type: string }).type).toBe('WOULD_HALT');
    expect(emitted[1]).toBe('unsubscribed');
  });
});

function createEmitter(
  mode: RuntimeMode,
  gate: SubmissionGate,
  sloDefinitions: readonly SloDefinition[],
): SloHaltEmitter {
  return new SloHaltEmitter({
    slo_definitions: sloDefinitions,
    runtime_mode_reader: () => mode,
    submission_gate: gate,
  });
}

function transition(
  metricName: string,
  fromState: SloStateTransition['from_state'],
  toState: SloStateTransition['to_state'],
  isProvisional = false,
): SloStateTransition {
  return {
    metric_name: metricName,
    from_state: fromState,
    to_state: toState,
    transitioned_ts_ns: ns('1700000000000000000'),
    is_provisional: isProvisional,
  };
}
