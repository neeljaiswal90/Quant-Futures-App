export {
  CredentialResolutionError,
  DEFAULT_CREDENTIAL_RESOLVER_CLOCK,
  assertDescriptorAuthorized,
  descriptorMap,
  secretResolutionPayload,
  type CredentialBackend,
  type CredentialBackendKind,
  type CredentialDescriptor,
  type CredentialResolutionEvent,
  type CredentialResolver,
  type CredentialResolverClock,
  type CredentialValue,
  type RuntimeMode,
} from './credential-resolver.js';
export {
  CompositeCredentialResolver,
  type CompositeCredentialResolverInput,
} from './composite-resolver.js';
export {
  EnvVarCredentialBackend,
  type EnvSource,
  type EnvVarCredentialBackendInput,
} from './backends/env-var-backend.js';
export {
  VaultBackend,
  type VaultBackendClient,
} from './backends/vault-backend.js';
