export interface OperatorConsoleEnv {
  readonly OPERATOR_CONSOLE_ALLOW_REMOTE?: string;
  readonly OPERATOR_CONSOLE_AUTH_TOKEN?: string;
  readonly OPERATOR_CONSOLE_ORIGIN_ALLOWLIST?: string;
  readonly QFA_CONSOLE_BIND?: string;
}

export interface RemoteAccessConfig {
  readonly enabled: boolean;
  readonly auth_required: boolean;
  readonly origin_allowlist: readonly string[];
  readonly token_rotation: 'restart_required';
  readonly transport_security: 'loopback_or_tls_terminating_proxy_required';
}

export interface OperatorConsoleServerConfig {
  readonly bind_address: string;
  readonly remote: RemoteAccessConfig;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackBindAddress(bindAddress: string): boolean {
  return LOOPBACK_ADDRESSES.has(bindAddress.trim().toLowerCase());
}

export function parseOriginAllowlist(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function resolveServerConfigFromEnv(env: OperatorConsoleEnv): OperatorConsoleServerConfig {
  const bindAddress = env.QFA_CONSOLE_BIND?.trim() || '127.0.0.1';
  const remoteBind = !isLoopbackBindAddress(bindAddress);
  const allowRemote = env.OPERATOR_CONSOLE_ALLOW_REMOTE === 'true';

  if (remoteBind && !allowRemote) {
    throw new Error('remote bind requires OPERATOR_CONSOLE_ALLOW_REMOTE=true');
  }

  const originAllowlist = parseOriginAllowlist(env.OPERATOR_CONSOLE_ORIGIN_ALLOWLIST);
  const authToken = env.OPERATOR_CONSOLE_AUTH_TOKEN?.trim() ?? '';

  if (allowRemote) {
    if (authToken.length === 0) {
      throw new Error('remote mode requires OPERATOR_CONSOLE_AUTH_TOKEN');
    }
    if (originAllowlist.length === 0) {
      throw new Error('remote mode requires OPERATOR_CONSOLE_ORIGIN_ALLOWLIST');
    }
  }

  return {
    bind_address: bindAddress,
    remote: {
      enabled: allowRemote,
      auth_required: allowRemote,
      origin_allowlist: originAllowlist,
      token_rotation: 'restart_required',
      transport_security: 'loopback_or_tls_terminating_proxy_required',
    },
  };
}
