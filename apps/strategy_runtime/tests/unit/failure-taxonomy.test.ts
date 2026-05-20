import { describe, expect, it } from 'vitest';
import {
  FAILURE_CATEGORIES,
  parseBrokerRejectCode,
  type FailureCategory,
} from '../../src/execution/failure-taxonomy.js';

describe('operational failure taxonomy', () => {
  it('classifies every category from canonical subreasons', () => {
    const examples: Readonly<Record<FailureCategory, string>> = {
      auth: 'auth.invalid_credentials',
      credentials: 'credentials.missing',
      permission: 'permission.order_submit_denied',
      entitlement: 'entitlement.symbol_denied',
      risk: 'risk.local_reject',
      broker: 'broker.unavailable',
      reconnect: 'reconnect.retry_budget_exhausted',
      transport: 'transport.heartbeat_timeout',
      unknown: 'unknown.unknown',
    };

    expect(FAILURE_CATEGORIES).toEqual(Object.keys(examples));
    for (const [category, subreason] of Object.entries(examples)) {
      expect(parseBrokerRejectCode('IGNORED_WHEN_SUBREASON_PRESENT', subreason)).toMatchObject({
        category,
        canonical_subreason: subreason,
        known: true,
      });
    }
  });

  it('falls back to code patterns and marks unknowns explicitly', () => {
    expect(parseBrokerRejectCode('BROKER_GATEWAY_UNAVAILABLE')).toMatchObject({
      category: 'broker',
      subreason: 'unavailable',
      remediation: {
        retryable: true,
        should_reconnect: true,
      },
    });
    expect(parseBrokerRejectCode('TOTALLY_NEW_REJECT_CODE')).toMatchObject({
      category: 'unknown',
      subreason: 'unknown',
      known: false,
      remediation: {
        requires_operator: true,
      },
    });
  });

  it('surfaces remediation flags for non-retryable safety failures', () => {
    expect(parseBrokerRejectCode('AUTH_INVALID_CREDENTIALS')).toMatchObject({
      category: 'auth',
      remediation: {
        retryable: false,
        should_kill_switch: true,
        requires_operator: true,
      },
    });
    expect(parseBrokerRejectCode('LOCAL_RISK_REJECT')).toMatchObject({
      category: 'risk',
      remediation: {
        retryable: false,
        should_quarantine: true,
      },
    });
  });
});
