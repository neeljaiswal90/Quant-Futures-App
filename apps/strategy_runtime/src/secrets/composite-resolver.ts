import type { AnyJournalEventEnvelope } from '../contracts/events/envelope.js';
import {
  CredentialResolutionError,
  DEFAULT_CREDENTIAL_RESOLVER_CLOCK,
  assertDescriptorAuthorized,
  descriptorMap,
  secretResolutionPayload,
  type CredentialBackend,
  type CredentialDescriptor,
  type CredentialResolutionEvent,
  type CredentialResolver,
  type CredentialResolverClock,
  type CredentialValue,
  type RuntimeMode,
} from './credential-resolver.js';

export interface CompositeCredentialResolverInput {
  readonly descriptors: readonly CredentialDescriptor[];
  readonly mode_reader: () => RuntimeMode;
  readonly env_var_backend: CredentialBackend;
  readonly vault_backend?: CredentialBackend;
  readonly clock?: CredentialResolverClock;
  readonly emit?: (event: CredentialResolutionEvent) => void;
}

type RefreshState = 'idle' | 'refreshing' | 'failed';

export class CompositeCredentialResolver implements CredentialResolver {
  private readonly descriptors: ReadonlyMap<string, CredentialDescriptor>;
  private readonly modeReader: () => RuntimeMode;
  private readonly envVarBackend: CredentialBackend;
  private readonly vaultBackend?: CredentialBackend;
  private readonly clock: CredentialResolverClock;
  private readonly emit?: (event: CredentialResolutionEvent) => void;
  private readonly resolvedCacheKeys = new Set<string>();
  private refreshState: RefreshState = 'idle';

  constructor(input: CompositeCredentialResolverInput) {
    this.descriptors = descriptorMap(input.descriptors);
    this.modeReader = input.mode_reader;
    this.envVarBackend = input.env_var_backend;
    this.vaultBackend = input.vault_backend;
    this.clock = input.clock ?? DEFAULT_CREDENTIAL_RESOLVER_CLOCK;
    this.emit = input.emit;

    const hasLiveAuthorizedDescriptor = input.descriptors.some((descriptor) =>
      descriptor.required_in_modes.includes('live'));
    if (hasLiveAuthorizedDescriptor && this.vaultBackend === undefined) {
      throw new CredentialResolutionError('live-authorized credentials require a configured vault backend');
    }
  }

  async resolve(key: string): Promise<CredentialValue> {
    if (this.refreshState !== 'idle') {
      throw new CredentialResolutionError(`credential resolver is not ready: ${this.refreshState}`);
    }
    const descriptor = this.requireDescriptor(key);
    const mode = this.modeReader();
    assertDescriptorAuthorized(descriptor, mode);
    const backend = this.backendForMode(mode);
    const cacheKey = this.cacheKey(mode, backend.kind, descriptor.key);
    const cached = this.resolvedCacheKeys.has(cacheKey);
    const credential = await backend.resolve(descriptor);
    this.resolvedCacheKeys.add(cacheKey);
    this.emitResolution(credential, mode, cached);
    return credential;
  }

  async refreshAll(): Promise<void> {
    const mode = this.modeReader();
    this.refreshState = 'refreshing';
    try {
      const backend = this.backendForMode(mode);
      for (const descriptor of this.descriptors.values()) {
        if (!descriptor.required_in_modes.includes(mode)) {
          continue;
        }
        const credential = await backend.refresh(descriptor);
        this.resolvedCacheKeys.add(this.cacheKey(mode, backend.kind, descriptor.key));
        this.emitResolution(credential, mode, false);
      }
      this.refreshState = 'idle';
    } catch (error) {
      this.refreshState = 'failed';
      throw error;
    }
  }

  shutdown(): void {
    this.invalidateAll();
    const maybeVaultShutdown = this.vaultBackend as { shutdown?: () => void } | undefined;
    maybeVaultShutdown?.shutdown?.();
  }

  async handleModeTransitionEvent(event: AnyJournalEventEnvelope): Promise<void> {
    const payload = asRecord(event.payload);
    if (payload === undefined || !isModeTransitionCommit(payload)) {
      return;
    }
    this.invalidateAll();
    await this.refreshAll();
  }

  private backendForMode(mode: RuntimeMode): CredentialBackend {
    if (mode === 'paper') {
      return this.envVarBackend;
    }
    if (this.vaultBackend === undefined) {
      throw new CredentialResolutionError('live mode credential resolution requires a vault backend');
    }
    return this.vaultBackend;
  }

  private requireDescriptor(key: string): CredentialDescriptor {
    const descriptor = this.descriptors.get(key);
    if (descriptor === undefined) {
      throw new CredentialResolutionError(`unregistered credential key: ${key}`);
    }
    return descriptor;
  }

  private invalidateAll(): void {
    this.resolvedCacheKeys.clear();
    for (const key of this.descriptors.keys()) {
      this.envVarBackend.invalidate(key);
      this.vaultBackend?.invalidate(key);
    }
  }

  private emitResolution(credential: CredentialValue, mode: RuntimeMode, cached: boolean): void {
    void this.clock;
    this.emit?.({
      type: 'SECRET_RESOLUTION',
      payload: secretResolutionPayload({
        key: credential.key,
        backend: credential.backend,
        resolved_at_ts_ns: credential.resolved_at_ts_ns,
        mode,
        cached,
      }),
    });
  }

  private cacheKey(mode: RuntimeMode, backendKind: string, key: string): string {
    return `${mode}:${backendKind}:${key}`;
  }
}

function isModeTransitionCommit(payload: Record<string, unknown>): boolean {
  return payload.transition_step === 'commit' || payload.operator_action === 'mode_transition_commit';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
