import { describe, expect, it } from 'vitest';
import {
  FAILURE_CATEGORIES,
  parseBrokerRejectCode,
  type CanonicalFailureSubreason,
  type FailureRemediation,
} from '../../src/execution/failure-taxonomy.js';

const EXPECTED: Readonly<Record<CanonicalFailureSubreason, FailureRemediation>> = {
  'network.tls_handshake_failed': 'terminate_session',
  'network.socket_dropped': 'retry_with_backoff',
  'network.dns_resolution_failed': 'retry_with_backoff',
  'network.gateway_unreachable': 'retry_with_backoff',
  'auth.invalid_credentials': 'terminate_session',
  'auth.session_expired': 'retry_with_backoff',
  'auth.mfa_required': 'escalate',
  'auth.account_locked': 'escalate',
  'permission.plant_not_authorized': 'escalate',
  'permission.instrument_not_authorized': 'escalate',
  'permission.account_disabled': 'escalate',
  'rate_limit.submission_throttle': 'block_submission',
  'rate_limit.cancel_throttle': 'block_submission',
  'rate_limit.session_rate_limit': 'block_submission',
  'protocol.unknown_message_type': 'escalate',
  'protocol.framing_error': 'escalate',
  'protocol.sequence_number_drift': 'retry_with_backoff',
  'protocol.schema_version_mismatch': 'escalate',
  'unknown.unrecognized': 'escalate',
};

describe('operational failure taxonomy', () => {
  it('uses the dispatch category literals exactly', () => {
    expect(FAILURE_CATEGORIES).toEqual([
      'network',
      'auth',
      'permission',
      'rate_limit',
      'protocol',
      'unknown',
    ]);
  });

  it('maps every category/subreason tuple to exactly one remediation literal', () => {
    for (const [canonical, remediation] of Object.entries(EXPECTED)) {
      const parsed = parseBrokerRejectCode('IGNORED', canonical);
      expect(parsed).toEqual({
        category: canonical.split('.')[0],
        subreason: canonical.split('.')[1],
        canonical_subreason: canonical,
        remediation,
        known: true,
        raw_code: 'IGNORED',
        raw_subreason: canonical,
      });
    }
  });

  it('parses representative broker codes into the corrected taxonomy', () => {
    expect(parseBrokerRejectCode('TLS_HANDSHAKE_FAILED')).toMatchObject({
      category: 'network',
      subreason: 'tls_handshake_failed',
      remediation: 'terminate_session',
    });
    expect(parseBrokerRejectCode('ORDER_SUBMISSION_THROTTLE')).toMatchObject({
      category: 'rate_limit',
      subreason: 'submission_throttle',
      remediation: 'block_submission',
    });
    expect(parseBrokerRejectCode('SEQUENCE_NUMBER_DRIFT')).toMatchObject({
      category: 'protocol',
      subreason: 'sequence_number_drift',
      remediation: 'retry_with_backoff',
    });
  });

  it('falls back to unknown.unrecognized with escalate remediation', () => {
    expect(parseBrokerRejectCode('TOTALLY_NEW_REJECT_CODE')).toEqual({
      category: 'unknown',
      subreason: 'unrecognized',
      canonical_subreason: 'unknown.unrecognized',
      remediation: 'escalate',
      known: false,
      raw_code: 'TOTALLY_NEW_REJECT_CODE',
    });
  });
});
