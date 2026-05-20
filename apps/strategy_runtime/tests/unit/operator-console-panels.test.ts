import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEventId, ns, type AnyJournalEventEnvelope } from '../../src/contracts/index.js';
import { OperatorConsoleStateStore } from '../../src/operator/console/console-state.js';
import { render as renderHeaderPanel } from '../../src/operator/console/panels/header-panel.js';
import { render as renderSloPanel } from '../../src/operator/console/panels/slo-panel.js';
import { render as renderQuarantinePanel } from '../../src/operator/console/panels/quarantine-panel.js';
import { render as renderHaltPanel } from '../../src/operator/console/panels/halt-panel.js';
import { render as renderValidatorsPanel } from '../../src/operator/console/panels/validators-panel.js';
import { render as renderLatencyPanel } from '../../src/operator/console/panels/latency-panel.js';
import { render as renderMaskPanel } from '../../src/operator/console/panels/mask-panel.js';

const ORIGINAL_NO_COLOR = process.env.NO_COLOR;
const TS = ns(1_800_000_000_000_000_000n);

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

describe('QFA-630 operator console panel snapshots', () => {
  it('renders the header panel deterministically', () => {
    expect(renderHeaderPanel({
      session_id: 'session-qfa-630',
      mode: 'paper',
      uptime_ms: 65_000,
      strategy_id: 'regime_shock_reversion_short_v2',
      capability_mask_version: 1,
      manifest_ts_ns: TS,
    })).toMatchInlineSnapshot(`
      "[Header]
        session_id=session-qfa-630 mode=paper uptime=00:01:05
        strategy_id=regime_shock_reversion_short_v2 capability_mask_version=1 manifest_ts_ns=1800000000000000000"
    `);
  });

  it('renders the SLO panel deterministically', () => {
    expect(renderSloPanel({
      metrics: [
        {
          metric_name: 'qfa_event_loop_lag_ms',
          state: 'pass',
          last_transition_ts_ns: ns(1_800_000_000_000_000_001n),
          is_provisional: true,
          breach_eligibility: 'eligible',
          windows: [
            {
              window_id: '5m',
              state: 'pass',
              sample_count: 25,
              sample_count_floor: 20,
              percentile_value: 12.5,
              budget_threshold_ms: 25,
            },
          ],
        },
        {
          metric_name: 'qfa_snapshot_to_submit_ms',
          state: 'insufficient_data',
          is_provisional: true,
          breach_eligibility: 'not_applicable_until_phase_6_ack',
          windows: [
            {
              window_id: '5m',
              state: 'insufficient_data',
              sample_count: 0,
              sample_count_floor: 0,
            },
          ],
        },
      ],
    })).toMatchInlineSnapshot(`
      "[SLO]
        metric=qfa_event_loop_lag_ms state=pass last_transition_ts_ns=1800000000000000001 provisional=true eligibility=eligible windows=[5m:pass:samples=25/20:p95_ms=<=12.5:budget_ms=25]
        metric=qfa_snapshot_to_submit_ms state=insufficient_data last_transition_ts_ns=-- provisional=true eligibility=not_applicable_until_phase_6_ack windows=[5m:insufficient_data:samples=0/0:p95_ms=--:budget_ms=--]"
    `);
  });

  it('renders the quarantine panel empty variant', () => {
    expect(renderQuarantinePanel({
      open_quarantine_count: 0,
      escalation_required: false,
      orders: [],
    })).toMatchInlineSnapshot(`
      "[Quarantine]
        open_quarantine_count=0 escalation_required=false
        orders=none"
    `);
  });

  it('renders the quarantine panel single-order variant', () => {
    expect(renderQuarantinePanel({
      open_quarantine_count: 1,
      escalation_required: false,
      orders: [quarantineOrder('intent-1', false)],
    })).toMatchInlineSnapshot(`
      "[Quarantine]
        open_quarantine_count=1 escalation_required=false
        intent_id=intent-1 reason=submission_ack_timeout previous_state=pending_ack broker_order_id=broker-1 instrument=MNQM6 open_count=1 escalation_required=false provisional=true entered_ts_ns=1800000000000000000"
    `);
  });

  it('renders the quarantine panel multiple-order variant', () => {
    expect(renderQuarantinePanel({
      open_quarantine_count: 2,
      escalation_required: false,
      orders: [quarantineOrder('intent-1', false), quarantineOrder('intent-2', false)],
    })).toMatchInlineSnapshot(`
      "[Quarantine]
        open_quarantine_count=2 escalation_required=false
        intent_id=intent-1 reason=submission_ack_timeout previous_state=pending_ack broker_order_id=broker-1 instrument=MNQM6 open_count=1 escalation_required=false provisional=true entered_ts_ns=1800000000000000000
        intent_id=intent-2 reason=submission_ack_timeout previous_state=pending_ack broker_order_id=broker-1 instrument=MNQM6 open_count=1 escalation_required=false provisional=true entered_ts_ns=1800000000000000000"
    `);
  });

  it('renders the quarantine panel escalation variant', () => {
    expect(renderQuarantinePanel({
      open_quarantine_count: 2,
      escalation_required: true,
      orders: [quarantineOrder('intent-1', true), quarantineOrder('intent-2', false)],
    })).toMatchInlineSnapshot(`
      "[Quarantine]
        open_quarantine_count=2 escalation_required=true
        intent_id=intent-1 reason=submission_ack_timeout previous_state=pending_ack broker_order_id=broker-1 instrument=MNQM6 open_count=1 escalation_required=true provisional=true entered_ts_ns=1800000000000000000
        intent_id=intent-2 reason=submission_ack_timeout previous_state=pending_ack broker_order_id=broker-1 instrument=MNQM6 open_count=1 escalation_required=false provisional=true entered_ts_ns=1800000000000000000"
    `);
  });

  it('renders the halt panel empty variant', () => {
    expect(renderHaltPanel({
      current_block_sources: [],
      emissions: [],
    })).toMatchInlineSnapshot(`
      "[Halt]
        current_block_sources=none
        last_5_emissions=none"
    `);
  });

  it('renders the halt panel single-entry variant', () => {
    expect(renderHaltPanel({
      current_block_sources: ['slo_halt'],
      emissions: [haltEmission('WOULD_HALT', 1)],
    })).toMatchInlineSnapshot(`
      "[Halt]
        current_block_sources=slo_halt
        type=WOULD_HALT state=halted reason=reason-1 resolved=false ts_ns=1800000000000000001"
    `);
  });

  it('renders the halt panel 5-entry boundary variant', () => {
    expect(renderHaltPanel({
      current_block_sources: ['quarantine_active', 'slo_halt'],
      emissions: [1, 2, 3, 4, 5].map((index) => haltEmission(index % 2 === 0 ? 'HALT' : 'WOULD_HALT', index)),
    })).toMatchInlineSnapshot(`
      "[Halt]
        current_block_sources=quarantine_active,slo_halt
        type=WOULD_HALT state=halted reason=reason-1 resolved=false ts_ns=1800000000000000001
        type=HALT state=halted reason=reason-2 resolved=false ts_ns=1800000000000000002
        type=WOULD_HALT state=halted reason=reason-3 resolved=false ts_ns=1800000000000000003
        type=HALT state=halted reason=reason-4 resolved=false ts_ns=1800000000000000004
        type=WOULD_HALT state=halted reason=reason-5 resolved=false ts_ns=1800000000000000005"
    `);
  });

  it('renders only the last 5 halt entries after 7 observed events', () => {
    const store = new OperatorConsoleStateStore();
    for (let index = 1; index <= 7; index += 1) {
      store.observeEvent(haltEvent(index % 2 === 0 ? 'HALT' : 'WOULD_HALT', index));
    }

    expect(renderHaltPanel(store.getState().halt)).toMatchInlineSnapshot(`
      "[Halt]
        current_block_sources=none
        type=WOULD_HALT state=halted reason=reason-3 resolved=false ts_ns=1800000000000000003
        type=HALT state=halted reason=reason-4 resolved=false ts_ns=1800000000000000004
        type=WOULD_HALT state=halted reason=reason-5 resolved=false ts_ns=1800000000000000005
        type=HALT state=halted reason=reason-6 resolved=false ts_ns=1800000000000000006
        type=WOULD_HALT state=halted reason=reason-7 resolved=false ts_ns=1800000000000000007"
    `);
  });

  it('renders the validators panel empty variant', () => {
    expect(renderValidatorsPanel({ issues: [] })).toMatchInlineSnapshot(`
      "[Validators]
        last_5_issues=none"
    `);
  });

  it('renders the validators panel mixed-severity variant', () => {
    expect(renderValidatorsPanel({
      issues: [
        validatorIssue('info', 'EXEC-VALIDATOR-01'),
        validatorIssue('warning', 'EXEC-VALIDATOR-02'),
        validatorIssue('error', 'EXEC-VALIDATOR-03'),
        validatorIssue('fatal', 'EXEC-VALIDATOR-07'),
      ],
    })).toMatchInlineSnapshot(`
      "[Validators]
        severity=info validator=EXEC-VALIDATOR-01 code=validator_info source=CONFIG emitted_ts_ns=1800000000000000000 message=\"info issue\"
        severity=warning validator=EXEC-VALIDATOR-02 code=validator_warning source=CONFIG emitted_ts_ns=1800000000000000000 message=\"warning issue\"
        severity=error validator=EXEC-VALIDATOR-03 code=validator_error source=CONFIG emitted_ts_ns=1800000000000000000 message=\"error issue\"
        severity=fatal validator=EXEC-VALIDATOR-07 code=validator_fatal source=CONFIG emitted_ts_ns=1800000000000000000 message=\"fatal issue\""
    `);
  });

  it('renders the latency panel empty-histogram variant', () => {
    expect(renderLatencyPanel({
      ack_intent_cache_misses: 0,
      metrics: [
        {
          metric_name: 'qfa_order_ack_cancel_ms',
          labels: {},
          count: 0,
          bucket_utilization: '0/13',
        },
      ],
    })).toMatchInlineSnapshot(`
      "[Latency]
        ack_intent_cache_misses=0
        metric=qfa_order_ack_cancel_ms labels=none count=0 p50_ms=-- p95_ms=-- p99_ms=-- bucket_utilization=0/13"
    `);
  });

  it('renders the latency panel populated-histogram variant', () => {
    expect(renderLatencyPanel({
      ack_intent_cache_misses: 2,
      metrics: [
        {
          metric_name: 'qfa_strategy_decision_ms',
          labels: { strategy_id: 'regime_shock_reversion_short_v2' },
          count: 3,
          p50_ms: 10,
          p95_ms: 25,
          p99_ms: 25,
          bucket_utilization: '3/13',
        },
      ],
    })).toMatchInlineSnapshot(`
      "[Latency]
        ack_intent_cache_misses=2
        metric=qfa_strategy_decision_ms labels=strategy_id:regime_shock_reversion_short_v2 count=3 p50_ms=<=10 p95_ms=<=25 p99_ms=<=25 bucket_utilization=3/13"
    `);
  });

  it('renders the mask panel stable variant', () => {
    expect(renderMaskPanel({
      mask_id: 'execution-capability-mask-v1',
      mask_version: 7,
      mask_hash: 'sha256:abcdef1234567890',
      drift_status: 'ok',
    })).toMatchInlineSnapshot(`
      "[Mask]
        mask_id=execution-capability-mask-v1 mask_version=7 mask_hash8=abcdef12
        exec_validator_07_drift_status=ok code=-- severity=-- ts_ns=--"
    `);
  });

  it('renders the mask panel drift-detected variant', () => {
    expect(renderMaskPanel({
      mask_id: 'execution-capability-mask-v1',
      mask_version: 7,
      mask_hash: 'sha256:abcdef1234567890',
      drift_status: 'drift_detected',
      drift_code: 'execution_mask_drift',
      drift_severity: 'fatal',
      drift_ts_ns: TS,
    })).toMatchInlineSnapshot(`
      "[Mask]
        mask_id=execution-capability-mask-v1 mask_version=7 mask_hash8=abcdef12
        exec_validator_07_drift_status=drift_detected code=execution_mask_drift severity=fatal ts_ns=1800000000000000000"
    `);
  });
});

function quarantineOrder(intentId: string, escalationRequired: boolean) {
  return {
    intent_id: intentId,
    previous_state: 'pending_ack' as const,
    quarantine_reason: 'submission_ack_timeout' as const,
    broker_order_id: 'broker-1',
    instrument_symbol: 'MNQM6',
    open_quarantine_count: 1,
    escalation_required: escalationRequired,
    is_provisional: true,
    entered_ts_ns: TS,
  };
}

function haltEmission(type: 'HALT' | 'WOULD_HALT', index: number) {
  return {
    type,
    state: 'halted' as const,
    reason: `reason-${index}`,
    resolved: false,
    ts_ns: ns(1_800_000_000_000_000_000n + BigInt(index)),
  };
}

function validatorIssue(severity: 'info' | 'warning' | 'error' | 'fatal', validatorId: 'EXEC-VALIDATOR-01' | 'EXEC-VALIDATOR-02' | 'EXEC-VALIDATOR-03' | 'EXEC-VALIDATOR-07') {
  return {
    validator_id: validatorId,
    severity,
    emitted_ts_ns: TS,
    code: `validator_${severity}`,
    message: `${severity} issue`,
    source_event_type: 'CONFIG',
  };
}

function haltEvent(type: 'HALT' | 'WOULD_HALT', index: number): AnyJournalEventEnvelope {
  return {
    schema_version: 2,
    event_id: makeEventId(`evt-${type.toLowerCase()}-${index}`),
    type,
    ts_ns: ns(1_800_000_000_000_000_000n + BigInt(index)),
    run_id: 'run-qfa-630',
    session_id: 'session-qfa-630',
    payload: {
      state: 'halted',
      reason: `reason-${index}`,
      resolved: false,
    },
  } as AnyJournalEventEnvelope;
}