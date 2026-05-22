import { describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  makeCandidateId,
  makeCausationId,
  makeEventId,
  makeOrderIntentId,
  makeRunId,
  makeSessionId,
  makeSizingDecisionId,
  ns,
  type AnyJournalEventEnvelope,
  type JournalEventPayloadFor,
} from '../../src/contracts/index.js';
import { AccountAllowlistValidator } from '../../src/execution/validators/account-allowlist.js';

const RUN_ID = makeRunId('run-account-allowlist-validator');
const SESSION_ID = makeSessionId('session-account-allowlist-validator');
const TS_NS = ns(1_800_000_000_000_000_000n);
const ALLOWLIST = [
  {
    fcm_id: 'TEST_FCM',
    ib_id: 'TEST_IB',
    account_id: 'TEST_ACCT_001',
    label: 'Synthetic account',
    max_position_contracts: 2,
    daily_loss_cap_usd: 100,
    max_session_duration_ms: 60_000,
    time_of_day_restriction: 'unrestricted',
  },
] as const;

describe('EXEC-VALIDATOR-09 account allowlist', () => {
  it('fails live session start when allowlist is empty', () => {
    const issues = new AccountAllowlistValidator().runOnSessionStart({ mode: 'live' });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      validator_id: 'EXEC-VALIDATOR-09',
      severity: 'fatal',
      code: 'live_account_allowlist_empty',
    });
  });

  it('fails when a configured allowlist entry is missing from a broker snapshot', () => {
    const issues = new AccountAllowlistValidator().runOnSessionStart({
      live_account_allowlist: ALLOWLIST,
      account_list_snapshot: [],
    });

    expect(issues).toEqual([]);

    const snapshotIssues = new AccountAllowlistValidator().runOnSessionStart({
      live_account_allowlist: ALLOWLIST,
      account_list_snapshot: [{ fcm_id: 'TEST_FCM', ib_id: 'TEST_IB', account_id: 'OTHER' }],
    });

    expect(snapshotIssues).toHaveLength(1);
    expect(snapshotIssues[0]).toMatchObject({
      code: 'account_allowlist_missing_from_broker_snapshot',
      severity: 'fatal',
    });
  });

  it('fails order intents missing account_id or using an account outside the allowlist', () => {
    const validator = new AccountAllowlistValidator();

    expect(validator.runOnEvent(orderIntent(undefined), { live_account_allowlist: ALLOWLIST })).toMatchObject([
      { code: 'order_intent_missing_account_id', severity: 'fatal' },
    ]);
    expect(validator.runOnEvent(orderIntent('OTHER'), { live_account_allowlist: ALLOWLIST })).toMatchObject([
      { code: 'account_id_not_in_allowlist', severity: 'fatal' },
    ]);
    expect(validator.runOnEvent(orderIntent('TEST_ACCT_001'), { live_account_allowlist: ALLOWLIST })).toEqual([]);
  });

  it('fails broker events reporting an account outside the allowlist', () => {
    const event = createJournalEventEnvelope({
      event_id: makeEventId('ack-1'),
      type: 'ORDER_ACK_SUBMISSION',
      ts_ns: TS_NS,
      run_id: RUN_ID,
      session_id: SESSION_ID,
      payload: {
        intent_id: makeEventId('intent-1'),
        submission_ack_id: makeEventId('submission-1'),
        broker_order_id: 'BROKER-1',
        broker_account_id: 'OTHER',
        instrument_symbol: 'MNQM6',
      } satisfies JournalEventPayloadFor<'ORDER_ACK_SUBMISSION'>,
    });

    const issues = new AccountAllowlistValidator().runOnEvent(event as unknown as AnyJournalEventEnvelope, {
      live_account_allowlist: ALLOWLIST,
    });

    expect(issues).toMatchObject([
      { validator_id: 'EXEC-VALIDATOR-09', code: 'broker_account_id_not_in_allowlist', severity: 'fatal' },
    ]);
  });
});

function orderIntent(accountId: string | undefined) {
  return createJournalEventEnvelope({
    event_id: makeEventId(`intent-${accountId ?? 'missing'}`),
    type: 'ORDER_INTENT',
    ts_ns: TS_NS,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    causation_id: makeCausationId('sizing-1'),
    payload: {
      order_intent_id: makeOrderIntentId(`order-${accountId ?? 'missing'}`),
      candidate_id: makeCandidateId('candidate-1'),
      sizing_decision_id: makeSizingDecisionId('sizing-1'),
      side: 'buy',
      order_type: 'limit',
      quantity: 1,
      limit_price: 19_750.25,
      time_in_force: 'day',
      ...(accountId === undefined ? {} : { account_id: accountId }),
    } satisfies JournalEventPayloadFor<'ORDER_INTENT'>,
  });
}
