import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ns } from '../../src/contracts/index.js';
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

  it('renders the quarantine panel deterministically', () => {
    expect(renderQuarantinePanel({
      open_quarantine_count: 1,
      escalation_required: true,
      orders: [
        {
          intent_id: 'intent-1',
          previous_state: 'pending_ack',
          quarantine_reason: 'submission_ack_timeout',
          broker_order_id: 'broker-1',
          instrument_symbol: 'MNQM6',
          open_quarantine_count: 1,
          escalation_required: true,
          is_provisional: true,
          entered_ts_ns: TS,
        },
      ],
    })).toMatchInlineSnapshot(`
      "[Quarantine]
        open_quarantine_count=1 escalation_required=true
        intent_id=intent-1 reason=submission_ack_timeout previous_state=pending_ack broker_order_id=broker-1 instrument=MNQM6 open_count=1 escalation_required=true provisional=true entered_ts_ns=1800000000000000000"
    `);
  });

  it('renders the halt panel deterministically', () => {
    expect(renderHaltPanel({
      current_block_sources: ['quarantine_active', 'slo_halt'],
      emissions: [
        {
          type: 'WOULD_HALT',
          state: 'halted',
          reason: 'slo_breach:qfa_strategy_decision_ms',
          ts_ns: TS,
        },
      ],
    })).toMatchInlineSnapshot(`
      "[Halt]
        current_block_sources=quarantine_active,slo_halt
        type=WOULD_HALT state=halted reason=slo_breach:qfa_strategy_decision_ms resolved=-- ts_ns=1800000000000000000"
    `);
  });

  it('renders the validators panel deterministically', () => {
    expect(renderValidatorsPanel({
      issues: [
        {
          validator_id: 'EXEC-VALIDATOR-07',
          severity: 'fatal',
          emitted_ts_ns: TS,
          code: 'execution_mask_drift',
          message: 'live execution capability mask differs from filesystem/artifact mask',
          source_event_type: 'CONFIG',
        },
      ],
    })).toMatchInlineSnapshot(`
      "[Validators]
        severity=fatal validator=EXEC-VALIDATOR-07 code=execution_mask_drift source=CONFIG emitted_ts_ns=1800000000000000000 message=\"live execution capability mask differs from filesystem/artifact mask\""
    `);
  });

  it('renders the latency panel deterministically', () => {
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

  it('renders the mask panel deterministically', () => {
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