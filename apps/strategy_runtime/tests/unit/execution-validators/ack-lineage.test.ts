import { describe, expect, it } from 'vitest';
import { AckLineageValidator } from '../../../src/execution/validators/ack-lineage.js';
import { brokerEvent } from './helpers.js';

function submission() {
  return brokerEvent('ORDER_ACK_SUBMISSION', {
    intent_id: 'intent-1',
    submission_ack_id: 'submission-1',
    broker_order_id: 'broker-1',
    broker_account_id: 'account-1',
    instrument_symbol: 'MNQM6',
  });
}

describe('EXEC-VALIDATOR-03 ACK lineage', () => {
  it('accepts fill and cancel ACKs that reference a prior submission ACK', () => {
    const validator = new AckLineageValidator();
    expect(validator.runOnEvent(submission())).toEqual([]);
    expect(
      validator.runOnEvent(
        brokerEvent('ORDER_ACK_FILL', {
          intent_id: 'intent-1',
          submission_ack_id: 'submission-1',
          fill_ack_id: 'fill-1',
          broker_order_id: 'broker-1',
          broker_account_id: 'account-1',
          instrument_symbol: 'MNQM6',
          fill_qty: 1,
          fill_price: 18500,
          fill_kind: 'FULL',
        }),
      ),
    ).toEqual([]);
  });

  it('flags orphan terminal ACKs', () => {
    const validator = new AckLineageValidator();
    const issues = validator.runOnEvent(
      brokerEvent('ORDER_ACK_CANCEL', {
        intent_id: 'intent-1',
        submission_ack_id: 'missing-submission',
        cancel_ack_id: 'cancel-1',
        broker_order_id: 'broker-1',
        broker_account_id: 'account-1',
        cancel_reason: 'CLIENT_REQUESTED',
      }),
    );

    expect(issues).toContainEqual(expect.objectContaining({ code: 'orphan_terminal_ack' }));
  });

  it('flags broken chains when terminal ACK fields disagree with submission ACK fields', () => {
    const validator = new AckLineageValidator();
    expect(validator.runOnEvent(submission())).toEqual([]);
    const issues = validator.runOnEvent(
      brokerEvent('ORDER_ACK_FILL', {
        intent_id: 'intent-1',
        submission_ack_id: 'submission-1',
        fill_ack_id: 'fill-1',
        broker_order_id: 'other-broker',
        broker_account_id: 'account-1',
        instrument_symbol: 'MNQM6',
        fill_qty: 1,
        fill_price: 18500,
        fill_kind: 'FULL',
      }),
    );

    expect(issues).toContainEqual(expect.objectContaining({ code: 'broken_ack_chain' }));
  });
});
