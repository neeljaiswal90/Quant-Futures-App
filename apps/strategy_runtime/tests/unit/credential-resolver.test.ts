import { describe, expect, it, vi } from 'vitest';
import {
  createJournalEventEnvelope,
  validateJournalEventEnvelope,
  type AnyJournalEventEnvelope,
} from '../../src/contracts/events/index.js';
import { ns, type UnixNs } from '../../src/contracts/time.js';
import {
  CompositeCredentialResolver,
  EnvVarCredentialBackend,
  VaultBackend,
  type CredentialDescriptor,
  type CredentialResolutionEvent,
  type RuntimeMode,
  type VaultBackendClient,
} from '../../src/secrets/index.js';

const USERNAME_DESCRIPTOR: CredentialDescriptor = {
  key: 'rithmic.order_plant.username',
  required_in_modes: ['paper', 'live'],
  redact_in_logs: true,
  env_var_name: 'RITHMIC_ORDER_PLANT_USERNAME',
};

const PAPER_ONLY_DESCRIPTOR: CredentialDescriptor = {
  key: 'rithmic.order_plant.paper_token',
  required_in_modes: ['paper'],
  redact_in_logs: true,
  env_var_name: 'RITHMIC_PAPER_TOKEN',
};

const LIVE_ONLY_DESCRIPTOR: CredentialDescriptor = {
  key: 'rithmic.order_plant.live_token',
  required_in_modes: ['live'],
  redact_in_logs: true,
  env_var_name: 'RITHMIC_LIVE_TOKEN',
};

describe('QFA-620 credential resolver', () => {
  it('resolves declared env-var credentials and rejects unregistered keys', async () => {
    const clock = monotonicClock();
    const backend = new EnvVarCredentialBackend({
      descriptors: [PAPER_ONLY_DESCRIPTOR],
      env: { RITHMIC_PAPER_TOKEN: 'paper-secret' },
      clock,
    });
    const resolver = new CompositeCredentialResolver({
      descriptors: [PAPER_ONLY_DESCRIPTOR],
      mode_reader: () => 'paper',
      env_var_backend: backend,
      clock,
    });

    await expect(resolver.resolve('rithmic.order_plant.paper_token')).resolves.toMatchObject({
      key: 'rithmic.order_plant.paper_token',
      value: 'paper-secret',
      backend: 'env_var',
    });
    await expect(resolver.resolve('rithmic.order_plant.unknown')).rejects.toThrow(
      'unregistered credential key',
    );
  });

  it('resolves declared vault paths and propagates client failures without leaking secret values', async () => {
    const clock = monotonicClock();
    const client = mockVaultClient({
      'secret/rithmic/username': 'vault-secret',
      'secret/rithmic/failing': new Error('vault transport failed'),
    });
    const backend = new VaultBackend(
      client,
      new Map([
        [USERNAME_DESCRIPTOR.key, 'secret/rithmic/username'],
        [LIVE_ONLY_DESCRIPTOR.key, 'secret/rithmic/failing'],
      ]),
      {
        descriptors: [USERNAME_DESCRIPTOR, LIVE_ONLY_DESCRIPTOR],
        clock,
      },
    );

    await expect(backend.resolve(USERNAME_DESCRIPTOR)).resolves.toMatchObject({
      key: USERNAME_DESCRIPTOR.key,
      value: 'vault-secret',
      backend: 'vault',
    });
    await expect(backend.resolve(LIVE_ONLY_DESCRIPTOR)).rejects.toThrow('vault transport failed');
  });

  it('selects env-var in paper mode and vault in live mode', async () => {
    const clock = monotonicClock();
    let mode: RuntimeMode = 'paper';
    const events: CredentialResolutionEvent[] = [];
    const resolver = resolverWithBackends({
      descriptors: [USERNAME_DESCRIPTOR],
      mode: () => mode,
      env: { RITHMIC_ORDER_PLANT_USERNAME: 'paper-user' },
      vaultValues: { 'secret/rithmic/username': 'live-user' },
      vaultPaths: new Map([[USERNAME_DESCRIPTOR.key, 'secret/rithmic/username']]),
      clock,
      emit: (event) => events.push(event),
    });

    await expect(resolver.resolve(USERNAME_DESCRIPTOR.key)).resolves.toMatchObject({
      value: 'paper-user',
      backend: 'env_var',
    });
    mode = 'live';
    await resolver.handleModeTransitionEvent(modeTransitionCommitEvent());
    await expect(resolver.resolve(USERNAME_DESCRIPTOR.key)).resolves.toMatchObject({
      value: 'live-user',
      backend: 'vault',
    });
    expect(events.map((event) => event.payload.backend)).toEqual(['env_var', 'vault', 'vault']);
  });

  it('constructor throws when live-authorized descriptors lack a vault backend', () => {
    const backend = new EnvVarCredentialBackend({
      descriptors: [USERNAME_DESCRIPTOR],
      env: { RITHMIC_ORDER_PLANT_USERNAME: 'paper-user' },
      clock: monotonicClock(),
    });

    expect(() => new CompositeCredentialResolver({
      descriptors: [USERNAME_DESCRIPTOR],
      mode_reader: () => 'paper',
      env_var_backend: backend,
    })).toThrow('live-authorized credentials require a configured vault backend');
  });

  it('mode transition invalidates env cache and refreshes the newly authorized backend before resolving again', async () => {
    const clock = monotonicClock();
    let mode: RuntimeMode = 'paper';
    const env = { RITHMIC_ORDER_PLANT_USERNAME: 'paper-user' };
    const vaultValues = { 'secret/rithmic/username': 'live-user-v1' };
    const resolver = resolverWithBackends({
      descriptors: [USERNAME_DESCRIPTOR],
      mode: () => mode,
      env,
      vaultValues,
      vaultPaths: new Map([[USERNAME_DESCRIPTOR.key, 'secret/rithmic/username']]),
      clock,
    });

    await expect(resolver.resolve(USERNAME_DESCRIPTOR.key)).resolves.toMatchObject({ value: 'paper-user' });
    env.RITHMIC_ORDER_PLANT_USERNAME = 'paper-user-mutated';
    mode = 'live';
    vaultValues['secret/rithmic/username'] = 'live-user-v2';
    await resolver.handleModeTransitionEvent(modeTransitionCommitEvent());

    await expect(resolver.resolve(USERNAME_DESCRIPTOR.key)).resolves.toMatchObject({
      value: 'live-user-v2',
      backend: 'vault',
    });
  });

  it('enters fail-closed state when mode-transition refresh fails', async () => {
    const clock = monotonicClock();
    let mode: RuntimeMode = 'paper';
    const resolver = resolverWithBackends({
      descriptors: [USERNAME_DESCRIPTOR],
      mode: () => mode,
      env: { RITHMIC_ORDER_PLANT_USERNAME: 'paper-user' },
      vaultValues: { 'secret/rithmic/username': new Error('vault unavailable') },
      vaultPaths: new Map([[USERNAME_DESCRIPTOR.key, 'secret/rithmic/username']]),
      clock,
    });

    await resolver.resolve(USERNAME_DESCRIPTOR.key);
    mode = 'live';
    await expect(resolver.handleModeTransitionEvent(modeTransitionCommitEvent())).rejects.toThrow('vault unavailable');
    await expect(resolver.resolve(USERNAME_DESCRIPTOR.key)).rejects.toThrow('credential resolver is not ready: failed');
  });

  it('rotation notification invalidates one vault key and forces re-read', async () => {
    const clock = monotonicClock();
    const rotationHandlers: ((path: string) => void)[] = [];
    const values = { 'secret/rithmic/username': 'live-user-v1' };
    const client = mockVaultClient(values, rotationHandlers);
    const backend = new VaultBackend(
      client,
      new Map([[USERNAME_DESCRIPTOR.key, 'secret/rithmic/username']]),
      { descriptors: [USERNAME_DESCRIPTOR], clock },
    );

    await expect(backend.resolve(USERNAME_DESCRIPTOR)).resolves.toMatchObject({ value: 'live-user-v1' });
    values['secret/rithmic/username'] = 'live-user-v2';
    await expect(backend.resolve(USERNAME_DESCRIPTOR)).resolves.toMatchObject({ value: 'live-user-v1' });
    rotationHandlers[0]!('secret/rithmic/username');
    await expect(backend.resolve(USERNAME_DESCRIPTOR)).resolves.toMatchObject({ value: 'live-user-v2' });
  });

  it('never includes credential values in SECRET_RESOLUTION payloads or thrown errors', async () => {
    const clock = monotonicClock();
    const events: CredentialResolutionEvent[] = [];
    const resolver = resolverWithBackends({
      descriptors: [PAPER_ONLY_DESCRIPTOR],
      mode: () => 'paper',
      env: { RITHMIC_PAPER_TOKEN: 'do-not-leak-this-secret' },
      vaultValues: {},
      vaultPaths: new Map(),
      clock,
      emit: (event) => events.push(event),
    });

    await resolver.resolve(PAPER_ONLY_DESCRIPTOR.key);
    await expect(resolver.resolve('missing-key')).rejects.not.toThrow('do-not-leak-this-secret');
    expect(String(events)).not.toContain('do-not-leak-this-secret');
    expect(events[0]!.payload).toEqual({
      key: PAPER_ONLY_DESCRIPTOR.key,
      backend: 'env_var',
      resolved_at_ts_ns: ns('1700000000000000000'),
      mode: 'paper',
      cached: false,
    });
  });

  it('rejects a paper-only descriptor in live mode even when an env var exists', async () => {
    const clock = monotonicClock();
    const resolver = resolverWithBackends({
      descriptors: [PAPER_ONLY_DESCRIPTOR, LIVE_ONLY_DESCRIPTOR],
      mode: () => 'live',
      env: {
        RITHMIC_PAPER_TOKEN: 'paper-secret',
        RITHMIC_LIVE_TOKEN: 'live-env-secret',
      },
      vaultValues: { 'secret/rithmic/live-token': 'live-vault-secret' },
      vaultPaths: new Map([[LIVE_ONLY_DESCRIPTOR.key, 'secret/rithmic/live-token']]),
      clock,
    });

    await expect(resolver.resolve(PAPER_ONLY_DESCRIPTOR.key)).rejects.toThrow(
      'not authorized for live mode',
    );
  });

  it('SECRET_RESOLUTION schema validates the redacted event shape', () => {
    const event = createJournalEventEnvelope({
      event_id: 'evt-secret-resolution' as never,
      run_id: 'run-secret' as never,
      session_id: 'session-secret' as never,
      type: 'SECRET_RESOLUTION',
      ts_ns: ns('1700000000000000000'),
      payload: {
        key: USERNAME_DESCRIPTOR.key,
        backend: 'vault',
        resolved_at_ts_ns: ns('1700000000000000001'),
        mode: 'live',
        cached: false,
      },
    });

    expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
  });
});

function resolverWithBackends(input: {
  readonly descriptors: readonly CredentialDescriptor[];
  readonly mode: () => RuntimeMode;
  readonly env: Record<string, string | undefined>;
  readonly vaultValues: Record<string, string | Error>;
  readonly vaultPaths: ReadonlyMap<string, string>;
  readonly clock: { now(): UnixNs };
  readonly emit?: (event: CredentialResolutionEvent) => void;
}): CompositeCredentialResolver {
  const envBackend = new EnvVarCredentialBackend({
    descriptors: input.descriptors,
    env: input.env,
    clock: input.clock,
  });
  const vaultBackend = new VaultBackend(
    mockVaultClient(input.vaultValues),
    input.vaultPaths,
    {
      descriptors: input.descriptors,
      clock: input.clock,
    },
  );
  return new CompositeCredentialResolver({
    descriptors: input.descriptors,
    mode_reader: input.mode,
    env_var_backend: envBackend,
    vault_backend: vaultBackend,
    clock: input.clock,
    emit: input.emit,
  });
}

function mockVaultClient(
  values: Record<string, string | Error>,
  rotationHandlers: ((path: string) => void)[] = [],
): VaultBackendClient {
  return {
    async fetch(path: string): Promise<string> {
      const value = values[path];
      if (value instanceof Error) {
        throw value;
      }
      if (value === undefined) {
        throw new Error(`missing vault path: ${path}`);
      }
      return value;
    },
    rotateNotification(handler) {
      rotationHandlers.push(handler);
      return vi.fn();
    },
  };
}

function monotonicClock(): { now(): UnixNs } {
  let current = 1_700_000_000_000_000_000n;
  return {
    now(): UnixNs {
      const value = current;
      current += 1n;
      return ns(value.toString());
    },
  };
}

function modeTransitionCommitEvent(): AnyJournalEventEnvelope {
  return createJournalEventEnvelope({
    event_id: 'evt-mode-commit' as never,
    run_id: 'run-mode' as never,
    session_id: 'session-mode' as never,
    type: 'CONFIG',
    ts_ns: ns('1700000000000000000'),
    payload: {
      config_hash: 'a'.repeat(64),
      config_version: 1,
      operator_action: 'mode_transition_commit',
      from_mode: 'paper',
      to_mode: 'live',
    } as never,
  });
}
