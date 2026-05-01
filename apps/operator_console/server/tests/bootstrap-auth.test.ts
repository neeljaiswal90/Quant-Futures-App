import { describe, expect, it } from 'vitest';
import {
  isLoopbackBindAddress,
  parseOriginAllowlist,
  resolveServerConfigFromEnv,
} from '../src/runtime/config.js';

describe('operator console bootstrap auth', () => {
  it('defaults to loopback without auth', () => {
    const config = resolveServerConfigFromEnv({});

    expect(config.bind_address).toBe('127.0.0.1');
    expect(config.port).toBe(3217);
    expect(config.remote.enabled).toBe(false);
    expect(config.remote.auth_required).toBe(false);
    expect(config.remote.token_rotation).toBe('restart_required');
  });

  it('rejects non-loopback bind without explicit remote opt-in', () => {
    expect(() => resolveServerConfigFromEnv({ QFA_CONSOLE_BIND: '0.0.0.0' })).toThrow(
      'remote bind requires OPERATOR_CONSOLE_ALLOW_REMOTE=true',
    );
  });

  it('requires token and origin allowlist in remote mode', () => {
    expect(() =>
      resolveServerConfigFromEnv({
        QFA_CONSOLE_BIND: '0.0.0.0',
        OPERATOR_CONSOLE_ALLOW_REMOTE: 'true',
      }),
    ).toThrow('remote mode requires OPERATOR_CONSOLE_AUTH_TOKEN');

    expect(() =>
      resolveServerConfigFromEnv({
        QFA_CONSOLE_BIND: '0.0.0.0',
        OPERATOR_CONSOLE_ALLOW_REMOTE: 'true',
        OPERATOR_CONSOLE_AUTH_TOKEN: 'secret',
      }),
    ).toThrow('remote mode requires OPERATOR_CONSOLE_ORIGIN_ALLOWLIST');
  });

  it('normalizes remote allowlist', () => {
    const config = resolveServerConfigFromEnv({
      QFA_CONSOLE_BIND: '0.0.0.0',
      QFA_CONSOLE_PORT: '0',
      OPERATOR_CONSOLE_ALLOW_REMOTE: 'true',
      OPERATOR_CONSOLE_AUTH_TOKEN: 'secret',
      OPERATOR_CONSOLE_ORIGIN_ALLOWLIST: 'https://ops.example, http://localhost:5173 ',
    });

    expect(config.port).toBe(0);
    expect(config.remote.enabled).toBe(true);
    expect(config.remote.auth_token).toBe('secret');
    expect(config.remote.origin_allowlist).toEqual([
      'https://ops.example',
      'http://localhost:5173',
    ]);
  });

  it('recognizes loopback aliases', () => {
    expect(isLoopbackBindAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackBindAddress('localhost')).toBe(true);
    expect(isLoopbackBindAddress('::1')).toBe(true);
    expect(isLoopbackBindAddress('0.0.0.0')).toBe(false);
    expect(parseOriginAllowlist(' a, ,b ')).toEqual(['a', 'b']);
  });
});
