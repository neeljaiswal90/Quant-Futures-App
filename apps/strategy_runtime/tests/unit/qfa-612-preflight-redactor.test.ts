import { describe, expect, it } from 'vitest';
import { redactText } from '../../../../scripts/preflight/qfa-612-paper-01b/redactor.js';

describe('QFA-612 preflight redactor', () => {
  it('redacts canned credential, account, session, order, token, and public-ip shaped values', () => {
    const input = [
      'RITHMIC_TEST_USERNAME="paper.user@example.com"',
      'RITHMIC_TEST_PASSWORD="secret-password-123"',
      'Authorization: Bearer eyJhbGciOi.fake.token',
      'session-abc123 broker_order_id=order-xyz789 accountId=ABC12345',
      'gateway=203.0.113.17 localhost=127.0.0.1',
    ].join('\n');

    const result = redactText(input, ['secret-password-123']);

    expect(result.text).not.toContain('paper.user@example.com');
    expect(result.text).not.toContain('secret-password-123');
    expect(result.text).not.toContain('eyJhbGciOi.fake.token');
    expect(result.text).not.toContain('session-abc123');
    expect(result.text).not.toContain('order-xyz789');
    expect(result.text).not.toContain('ABC12345');
    expect(result.text).not.toContain('203.0.113.17');
    expect(result.text).toContain('[REDACTED:credential]');
    expect(result.text).toContain('[REDACTED:session-id-1]');
    expect(result.text).toContain('[REDACTED:order-id-1]');
    expect(result.text).toContain('[REDACTED:account-id]');
    expect(result.text).toContain('[REDACTED:ip]');
    expect(result.text).toContain('127.0.0.1');
  });
});
