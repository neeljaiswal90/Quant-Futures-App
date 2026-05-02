import type { IncomingMessage } from 'node:http';
import { isLoopbackBindAddress, type OperatorConsoleServerConfig } from '../runtime/config.js';

export interface RestAuthResult {
  readonly ok: boolean;
  readonly status_code?: 401 | 403;
  readonly message?: string;
  readonly allow_origin?: string;
}

export function allowedCorsOrigin(
  config: OperatorConsoleServerConfig,
  request: IncomingMessage,
): string | undefined {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return undefined;
  }

  if (config.remote.auth_required) {
    return config.remote.origin_allowlist.includes(origin) ? origin : undefined;
  }

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
    return isLoopbackBindAddress(hostname) ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function authenticateRestRequest(
  config: OperatorConsoleServerConfig,
  request: IncomingMessage,
): RestAuthResult {
  if (!config.remote.auth_required) {
    return { ok: true, allow_origin: allowedCorsOrigin(config, request) };
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
  const allowOrigin = allowedCorsOrigin(config, request);
  if (origin === undefined || allowOrigin === undefined) {
    return {
      ok: false,
      status_code: 403,
      message: 'origin is not allowed',
    };
  }

  return { ok: true, allow_origin: allowOrigin };
}
