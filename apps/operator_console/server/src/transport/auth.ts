import type { IncomingMessage } from 'node:http';
import type { OperatorConsoleServerConfig } from '../runtime/config.js';

export interface RestAuthResult {
  readonly ok: boolean;
  readonly status_code?: 401 | 403;
  readonly message?: string;
  readonly allow_origin?: string;
}

export function authenticateRestRequest(
  config: OperatorConsoleServerConfig,
  request: IncomingMessage,
): RestAuthResult {
  if (!config.remote.auth_required) {
    return { ok: true };
  }

  const authorization = request.headers.authorization;
  const expected = `Bearer ${config.remote.auth_token}`;
  if (authorization !== expected) {
    return {
      ok: false,
      status_code: 401,
      message: 'missing or invalid bearer token',
    };
  }

  const origin = request.headers.origin;
  if (origin === undefined || !config.remote.origin_allowlist.includes(origin)) {
    return {
      ok: false,
      status_code: 403,
      message: 'origin is not allowed',
    };
  }

  return { ok: true, allow_origin: origin };
}
