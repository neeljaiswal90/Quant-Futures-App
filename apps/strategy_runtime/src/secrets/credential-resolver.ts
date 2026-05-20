import type { SecretResolutionEventPayload } from '../contracts/events/payloads.js';
import type { UnixNs } from '../contracts/time.js';
import { captureLocalTimestampNs } from '../observability/local-timestamp.js';

export type RuntimeMode = 'paper' | 'live';
export type CredentialBackendKind = 'env_var' | 'vault';

export interface CredentialDescriptor {
  readonly key: string;
  readonly required_in_modes: readonly RuntimeMode[];
  readonly redact_in_logs: true;
  readonly env_var_name?: string;
}

export interface CredentialValue {
  readonly key: string;
  readonly resolved_at_ts_ns: UnixNs;
  readonly value: string;
  readonly backend: CredentialBackendKind;
}

export interface CredentialBackend {
  readonly kind: CredentialBackendKind;
  resolve(descriptor: CredentialDescriptor): Promise<CredentialValue>;
  refresh(descriptor: CredentialDescriptor): Promise<CredentialValue>;
  invalidate(key: string): void;
}

export interface CredentialResolver {
  resolve(key: string): Promise<CredentialValue>;
  refreshAll(): Promise<void>;
  shutdown(): void;
}

export interface CredentialResolutionEvent {
  readonly type: 'SECRET_RESOLUTION';
  readonly payload: SecretResolutionEventPayload;
}

export interface CredentialResolverClock {
  now(): UnixNs;
}

export const DEFAULT_CREDENTIAL_RESOLVER_CLOCK: CredentialResolverClock = {
  now: captureLocalTimestampNs,
};

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialResolutionError';
  }
}

export function descriptorMap(
  descriptors: readonly CredentialDescriptor[],
): ReadonlyMap<string, CredentialDescriptor> {
  const map = new Map<string, CredentialDescriptor>();
  for (const descriptor of descriptors) {
    if (map.has(descriptor.key)) {
      throw new CredentialResolutionError(`duplicate credential descriptor: ${descriptor.key}`);
    }
    if (descriptor.required_in_modes.length === 0) {
      throw new CredentialResolutionError(`credential descriptor has no authorized modes: ${descriptor.key}`);
    }
    map.set(descriptor.key, descriptor);
  }
  return map;
}

export function assertDescriptorAuthorized(
  descriptor: CredentialDescriptor,
  mode: RuntimeMode,
): void {
  if (!descriptor.required_in_modes.includes(mode)) {
    throw new CredentialResolutionError(`credential key ${descriptor.key} is not authorized for ${mode} mode`);
  }
}

export function secretResolutionPayload(input: {
  readonly key: string;
  readonly backend: CredentialBackendKind;
  readonly resolved_at_ts_ns: UnixNs;
  readonly mode: RuntimeMode;
  readonly cached: boolean;
}): SecretResolutionEventPayload {
  return {
    key: input.key,
    backend: input.backend,
    resolved_at_ts_ns: input.resolved_at_ts_ns,
    mode: input.mode,
    cached: input.cached,
  };
}
