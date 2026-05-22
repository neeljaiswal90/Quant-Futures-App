import { describe, expect, it } from 'vitest';
import {
  accountIdAllowed,
  missingAllowlistEntriesFromSnapshot,
  redactAccountId,
  resolveLiveAccountAllowlist,
  validateLiveAccountAllowlist,
} from '../../src/execution/brokers/account-allowlist.js';
import {
  CompositeCredentialResolver,
  EnvVarCredentialBackend,
  type CredentialDescriptor,
} from '../../src/secrets/index.js';

const SYNTHETIC_ENTRY = {
  label: 'Synthetic account',
  fcm_id: 'TEST_FCM',
  ib_id: 'TEST_IB',
  account_id: 'TEST_ACCT_001',
  max_position_contracts: 2,
  daily_loss_cap_usd: 100,
  max_session_duration_ms: 60_000,
  time_of_day_restriction: 'unrestricted',
} as const;

describe('live account allowlist', () => {
  it('accepts valid synthetic entries', () => {
    const result = validateLiveAccountAllowlist([SYNTHETIC_ENTRY]);

    expect(result.ok).toBe(true);
    expect(result.allowlist).toEqual([SYNTHETIC_ENTRY]);
  });

  it('rejects committed Lucid-pattern account IDs as literals', () => {
    const result = validateLiveAccountAllowlist([
      {
        ...SYNTHETIC_ENTRY,
        account_id: 'LFE050-PLACEHOLDER-TEST021',
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      path: '$.execution.live_account_allowlist[0].account_id',
      code: 'literal_lucidflex_account_id_forbidden',
      message: 'Lucid account IDs must be referenced via env var, not embedded literally',
    });
  });

  it('resolves account triplet fields from env refs', () => {
    const result = resolveLiveAccountAllowlist({
      value: [
        {
          ...SYNTHETIC_ENTRY,
          fcm_id: undefined,
          ib_id: undefined,
          account_id: undefined,
          fcm_id_env: 'QFA_TEST_FCM',
          ib_id_env: 'QFA_TEST_IB',
          account_id_env: 'QFA_TEST_ACCOUNT',
        },
      ],
      env: {
        QFA_TEST_FCM: 'TEST_FCM',
        QFA_TEST_IB: 'TEST_IB',
        QFA_TEST_ACCOUNT: 'LFE050-PLACEHOLDER-TEST021',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.allowlist[0]).toMatchObject({
      fcm_id: 'TEST_FCM',
      ib_id: 'TEST_IB',
      account_id: 'LFE050-PLACEHOLDER-TEST021',
    });
  });

  it('checks allowlist membership and redacts account IDs', () => {
    expect(accountIdAllowed([SYNTHETIC_ENTRY], 'TEST_ACCT_001')).toEqual({ ok: true });
    expect(accountIdAllowed([SYNTHETIC_ENTRY], 'OTHER')).toMatchObject({
      ok: false,
      code: 'account_id_not_in_allowlist',
    });
    expect(redactAccountId('TEST_ACCT_001')).toBe('TEST_A..._001');
  });

  it('detects allowlist entries missing from broker snapshots', () => {
    expect(missingAllowlistEntriesFromSnapshot([SYNTHETIC_ENTRY], [])).toEqual([SYNTHETIC_ENTRY]);
    expect(
      missingAllowlistEntriesFromSnapshot([SYNTHETIC_ENTRY], [
        { fcm_id: 'TEST_FCM', ib_id: 'TEST_IB', account_id: 'TEST_ACCT_001' },
      ]),
    ).toEqual([]);
  });

  it('rejects descriptor resolution when plant scope mismatches', async () => {
    const descriptors = [
      {
        key: 'rithmic.live_ticker_plant.username',
        env_var_name: 'RITHMIC_USER',
        required_in_modes: ['paper'],
        plant_scope: 'TICKER_PLANT',
        redact_in_logs: true,
      },
    ] as const satisfies readonly CredentialDescriptor[];
    const resolver = new CompositeCredentialResolver({
      descriptors,
      mode_reader: () => 'paper',
      env_var_backend: new EnvVarCredentialBackend({
        descriptors,
        env: { RITHMIC_USER: 'operator@example.com' },
      }),
    });

    await expect(
      resolver.resolveForPlant('rithmic.live_ticker_plant.username', 'ORDER_PLANT'),
    ).rejects.toThrow('scoped to TICKER_PLANT, not ORDER_PLANT');
    await expect(
      resolver.resolveForPlant('rithmic.live_ticker_plant.username', 'TICKER_PLANT'),
    ).resolves.toMatchObject({ value: 'operator@example.com' });
  });
});
