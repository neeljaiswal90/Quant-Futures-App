import { describe, expect, it } from 'vitest';
import {
  channelsForEventType,
  formatJournalEventSchemaValidationErrors,
  journalEventFromJsonLine,
  journalEventToJsonLine,
  validateJournalEventEnvelope,
  type AnyJournalEventEnvelope,
} from '../../../src/contracts/index.js';
import { formatJournalEvent } from '../../../src/operator/formatter.js';
import {
  createExecutionValidatorRunner,
  type ValidatorIssue,
  type ValidatorRunner,
  type ValidatorRuntimeContext,
} from '../../../src/execution/validators/runner.js';
import { event } from './helpers.js';

const fakeIssue: ValidatorIssue = {
  validator_id: 'EXEC-VALIDATOR-01',
  severity: 'error',
  emitted_ts_ns: 1_700_000_000_000_000_000n as ValidatorIssue['emitted_ts_ns'],
  code: 'fake_issue',
  message: 'fake issue',
};

class FakeValidator implements ValidatorRunner {
  runOnEvent(
    observedEvent: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    void observedEvent;
    void context;
    return [fakeIssue];
  }

  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    void context;
    return [];
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    void context;
    return [];
  }
}

describe('execution validator runner integration', () => {
  it('aggregates issues from configured validators', () => {
    const runner = createExecutionValidatorRunner({ validators: [new FakeValidator(), new FakeValidator()] });

    expect(
      runner.runOnEvent(
        event('CONFIG', {
          config_hash: 'a'.repeat(64),
          config_version: 1,
        }),
      ),
    ).toEqual([fakeIssue, fakeIssue]);
  });

  it('wires default runOnEvent through broker timestamp validation without invoking Python parity', () => {
    const runner = createExecutionValidatorRunner({
      nowMs: () => 1_800_000_000_000,
    });
    const issues = runner.runOnEvent(
      event(
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

    expect(issues).toContainEqual(expect.objectContaining({ validator_id: 'EXEC-VALIDATOR-02' }));
  });

  it('registers, validates, channels, and formats VALIDATOR_ISSUE system-control events', () => {
    const validatorIssueEvent = event('VALIDATOR_ISSUE', {
      validator_id: 'EXEC-VALIDATOR-07',
      severity: 'fatal',
      emitted_ts_ns: 1_700_000_000_000_000_001n,
      code: 'execution_mask_drift',
      message: 'live execution capability mask differs from filesystem/artifact mask',
      source_event_id: 'evt-source',
      source_event_type: 'CONFIG',
      session_family_id: 'family-1',
      details: {
        drift_fields: 'mask_hash',
      },
    });

    const validation = validateJournalEventEnvelope(validatorIssueEvent);
    expect(validation.ok, formatJournalEventSchemaValidationErrors(validation.issues)).toBe(true);
    expect(channelsForEventType('VALIDATOR_ISSUE')).toContain('SESSION');
    expect(formatJournalEvent(validatorIssueEvent)).toContain('validator=EXEC-VALIDATOR-07');
  });

  it('round-trips VALIDATOR_ISSUE emitted_ts_ns through JSONL revival', () => {
    const validatorIssueEvent = event('VALIDATOR_ISSUE', {
      validator_id: 'EXEC-VALIDATOR-02',
      severity: 'error',
      emitted_ts_ns: 1_700_000_000_000_000_123n,
      code: 'dual_timestamp_implausible',
      message: 'broker-originated event dual timestamp is implausible',
      source_event_id: 'evt-source',
      source_event_type: 'ORDER_ACK_SUBMISSION',
    });

    const revived = journalEventFromJsonLine(journalEventToJsonLine(validatorIssueEvent));
    const payload = revived.payload as Record<string, unknown>;
    const validation = validateJournalEventEnvelope(revived);

    expect(typeof payload.emitted_ts_ns).toBe('bigint');
    expect(validation.ok, formatJournalEventSchemaValidationErrors(validation.issues)).toBe(true);
    expect(validation.issues).toEqual([]);
  });
});
