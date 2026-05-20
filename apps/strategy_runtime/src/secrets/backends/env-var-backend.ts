import {
  CredentialResolutionError,
  DEFAULT_CREDENTIAL_RESOLVER_CLOCK,
  descriptorMap,
  type CredentialBackend,
  type CredentialDescriptor,
  type CredentialResolverClock,
  type CredentialValue,
} from '../credential-resolver.js';

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface EnvVarCredentialBackendInput {
  readonly descriptors: readonly CredentialDescriptor[];
  readonly env?: EnvSource;
  readonly clock?: CredentialResolverClock;
}

export class EnvVarCredentialBackend implements CredentialBackend {
  readonly kind = 'env_var' as const;

  private readonly descriptors: ReadonlyMap<string, CredentialDescriptor>;
  private readonly env: EnvSource;
  private readonly clock: CredentialResolverClock;
  private readonly cache = new Map<string, CredentialValue>();

  constructor(input: EnvVarCredentialBackendInput) {
    this.descriptors = descriptorMap(input.descriptors);
    this.env = input.env ?? process.env;
    this.clock = input.clock ?? DEFAULT_CREDENTIAL_RESOLVER_CLOCK;
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
    const envVarName = descriptor.env_var_name;
    if (envVarName === undefined || envVarName.trim() === '') {
      throw new CredentialResolutionError(`credential key ${descriptor.key} does not declare an env var name`);
    }
    const value = this.env[envVarName];
    if (value === undefined || value === '') {
      throw new CredentialResolutionError(`credential key ${descriptor.key} is missing required env var ${envVarName}`);
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

  private assertKnown(descriptor: CredentialDescriptor): void {
    if (!this.descriptors.has(descriptor.key)) {
      throw new CredentialResolutionError(`unregistered credential descriptor: ${descriptor.key}`);
    }
  }
}
