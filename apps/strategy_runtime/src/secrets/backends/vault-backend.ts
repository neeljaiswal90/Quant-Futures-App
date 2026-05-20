import {
  CredentialResolutionError,
  DEFAULT_CREDENTIAL_RESOLVER_CLOCK,
  descriptorMap,
  type CredentialBackend,
  type CredentialDescriptor,
  type CredentialResolverClock,
  type CredentialValue,
} from '../credential-resolver.js';

export interface VaultBackendClient {
  fetch(path: string): Promise<string>;
  rotateNotification?(handler: (path: string) => void): () => void;
}

export class VaultBackend implements CredentialBackend {
  readonly kind = 'vault' as const;

  private readonly client: VaultBackendClient;
  private readonly descriptors: ReadonlyMap<string, CredentialDescriptor>;
  private readonly descriptorPathMap: ReadonlyMap<string, string>;
  private readonly clock: CredentialResolverClock;
  private readonly cache = new Map<string, CredentialValue>();
  private readonly unsubscribeRotation?: () => void;

  constructor(
    client: VaultBackendClient,
    descriptorPathMap: ReadonlyMap<string, string>,
    input: {
      readonly descriptors?: readonly CredentialDescriptor[];
      readonly clock?: CredentialResolverClock;
    } = {},
  ) {
    this.client = client;
    this.descriptorPathMap = descriptorPathMap;
    this.descriptors = descriptorMap(input.descriptors ?? [...descriptorPathMap.keys()].map((key) => ({
      key,
      required_in_modes: ['live'],
      redact_in_logs: true,
    })));
    this.clock = input.clock ?? DEFAULT_CREDENTIAL_RESOLVER_CLOCK;
    this.unsubscribeRotation = client.rotateNotification?.((path) => {
      for (const [key, mappedPath] of this.descriptorPathMap.entries()) {
        if (mappedPath === path) {
          this.invalidate(key);
        }
      }
    });
  }

  async resolve(descriptor: CredentialDescriptor): Promise<CredentialValue> {
    this.assertKnown(descriptor);
    const cached = this.cache.get(descriptor.key);
    if (cached !== undefined) {
      return cached;
    }
    return this.refresh(descriptor);
  }

  async refresh(descriptor: CredentialDescriptor): Promise<CredentialValue> {
    this.assertKnown(descriptor);
    const path = this.descriptorPathMap.get(descriptor.key);
    if (path === undefined || path.trim() === '') {
      throw new CredentialResolutionError(`credential key ${descriptor.key} does not declare a vault path`);
    }
    const value = await this.client.fetch(path);
    if (value === '') {
      throw new CredentialResolutionError(`credential key ${descriptor.key} resolved empty vault value`);
    }
    const credential: CredentialValue = {
      key: descriptor.key,
      resolved_at_ts_ns: this.clock.now(),
      value,
      backend: this.kind,
    };
    this.cache.set(descriptor.key, credential);
    return credential;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  shutdown(): void {
    this.unsubscribeRotation?.();
  }

  private assertKnown(descriptor: CredentialDescriptor): void {
    if (!this.descriptors.has(descriptor.key)) {
      throw new CredentialResolutionError(`unregistered credential descriptor: ${descriptor.key}`);
    }
  }
}
