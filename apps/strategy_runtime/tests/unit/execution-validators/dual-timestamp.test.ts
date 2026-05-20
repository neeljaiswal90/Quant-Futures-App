import { ns } from '../../../src/contracts/index.js';
import { DualTimestampValidator } from '../../../src/execution/validators/dual-timestamp.js';
import { describe, expect, it } from 'vitest';
import { BASE_TS_NS, brokerEvent } from './helpers.js';

const DAY_NS = 86_400_000_000_000n;

describe('EXEC-VALIDATOR-02 dual timestamp plausibility', () => {
  it('accepts broker timestamps with local and exchange times inside configured bands', () => {
    const validator = new DualTimestampValidator({
      nowMs: () => Number(BASE_TS_NS / 1_000_000n),
      wallClockBandNs: 10_000_000n,
    });

    expect(
      validator.runOnEvent(
        brokerEvent('ORDER_ACK_SUBMISSION', {
          intent_id: 'intent-1',
          submission_ack_id: 'submission-1',
          broker_order_id: 'broker-1',
          broker_account_id: 'account-1',
          instrument_symbol: 'MNQM6',
        }),
      ),
    ).toEqual([]);
  });

  it('flags missing ts_ns_local on broker-originated events', () => {
    const validator = new DualTimestampValidator({ nowMs: () => Number(BASE_TS_NS / 1_000_000n) });
    const issues = validator.runOnEvent(
      brokerEvent(
        'ORDER_ACK_SUBMISSION',
        {
          intent_id: 'intent-1',
          submission_ack_id: 'submission-1',
          broker_order_id: 'broker-1',
          broker_account_id: 'account-1',
          instrument_symbol: 'MNQM6',
        },
        { ts_ns_local: undefined },
      ),
    );

    expect(issues).toContainEqual(expect.objectContaining({ code: 'broker_ts_ns_local_missing' }));
  });

  it('flags exchange/local deltas at or above 24h', () => {
    const validator = new DualTimestampValidator({ nowMs: () => Number(BASE_TS_NS / 1_000_000n) });
    const issues = validator.runOnEvent(
      brokerEvent(
        'ORDER_ACK_FILL',
        {
          intent_id: 'intent-1',
          submission_ack_id: 'submission-1',
          fill_ack_id: 'fill-1',
          broker_order_id: 'broker-1',
          broker_account_id: 'account-1',
          instrument_symbol: 'MNQM6',
          fill_qty: 1,
          fill_price: 18500,
          fill_kind: 'FULL',
        },
        { ts_ns_local: ns(BASE_TS_NS + DAY_NS) },
      ),
    );

    expect(issues).toContainEqual(expect.objectContaining({ code: 'broker_exchange_local_delta_too_large' }));
  });

  it('flags timestamps outside the Date.now wall-clock band', () => {
    const validator = new DualTimestampValidator({
      nowMs: () => Number((BASE_TS_NS + 10_000_000_000n) / 1_000_000n),
      wallClockBandNs: 1_000_000n,
    });
    const issues = validator.runOnEvent(
      brokerEvent('ORDER_ACK_CANCEL', {
        intent_id: 'intent-1',
        submission_ack_id: 'submission-1',
        cancel_ack_id: 'cancel-1',
        broker_order_id: 'broker-1',
        broker_account_id: 'account-1',
        cancel_reason: 'CLIENT_REQUESTED',
      }),
    );

    expect(issues.map((issue) => issue.code)).toContain('broker_exchange_timestamp_outside_wall_clock_band');
    expect(issues.map((issue) => issue.code)).toContain('broker_local_timestamp_outside_wall_clock_band');
  });
});
