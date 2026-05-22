import type { JsonValue } from '../../contracts/index.js';

export const LIVE_ACCOUNT_TIME_OF_DAY_RESTRICTIONS = [
  'rth_only',
  'globex_extended',
  'unrestricted',
] as const;

export type LiveAccountTimeOfDayRestriction = (typeof LIVE_ACCOUNT_TIME_OF_DAY_RESTRICTIONS)[number];

export interface LiveAccountAllowlistEntry {
  readonly fcm_id: string;
  readonly ib_id: string;
  readonly account_id: string;
  readonly label: string;
  readonly max_position_contracts: number;
  readonly daily_loss_cap_usd: number;
  readonly max_session_duration_ms: number;
  readonly time_of_day_restriction: LiveAccountTimeOfDayRestriction;
}

export type LiveAccountAllowlist = readonly LiveAccountAllowlistEntry[];

export interface LiveAccountAllowlistSummaryEntry {
  readonly label: string;
  readonly fcm_id: string;
  readonly ib_id: string;
  readonly account_id_redacted: string;
  readonly max_position_contracts: number;
  readonly daily_loss_cap_usd: number;
}

export interface BrokerAccountSnapshotEntry {
  readonly fcm_id: string;
  readonly ib_id: string;
  readonly account_id: string;
  readonly account_name?: string;
  readonly account_currency?: string;
  readonly account_auto_liquidate?: boolean;
}

export interface AccountAllowlistValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface AccountAllowlistValidationResult {
  readonly ok: boolean;
  readonly allowlist: LiveAccountAllowlist;
  readonly issues: readonly AccountAllowlistValidationIssue[];
}

export const LUCIDFLEX_ACCOUNT_ID_LITERAL_PATTERN = /^LFE\d+-.+-TEST\d+$/u;

export function resolveLiveAccountAllowlist(input: {
  readonly value: unknown;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly path?: string;
}): AccountAllowlistValidationResult {
  const issues: AccountAllowlistValidationIssue[] = [];
  const rootPath = input.path ?? '$.execution.live_account_allowlist';
  if (input.value === undefined || input.value === null) {
    return { ok: true, allowlist: [], issues: [] };
  }
  if (!Array.isArray(input.value)) {
    return {
      ok: false,
      allowlist: [],
      issues: [{ path: rootPath, code: 'invalid_field_type', message: 'must be an array' }],
    };
  }

  const allowlist: LiveAccountAllowlistEntry[] = [];
  input.value.forEach((entry, index) => {
    const path = `${rootPath}[${index}]`;
    const record = asRecord(entry);
    if (record === undefined) {
      issues.push({ path, code: 'invalid_field_type', message: 'must be an object' });
      return;
    }
    const resolved = resolveEntry(record, input.env ?? {}, path, issues);
    if (resolved !== undefined) {
      allowlist.push(resolved);
    }
  });

  return {
    ok: issues.length === 0,
    allowlist: issues.length === 0 ? allowlist : [],
    issues: issues.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code)),
  };
}

export function validateLiveAccountAllowlist(value: unknown): AccountAllowlistValidationResult {
  return resolveLiveAccountAllowlist({ value, env: {} });
}

export function summarizeLiveAccountAllowlist(
  allowlist: LiveAccountAllowlist,
): readonly LiveAccountAllowlistSummaryEntry[] {
  return allowlist.map((entry) => ({
    label: entry.label,
    fcm_id: entry.fcm_id,
    ib_id: entry.ib_id,
    account_id_redacted: redactAccountId(entry.account_id),
    max_position_contracts: entry.max_position_contracts,
    daily_loss_cap_usd: entry.daily_loss_cap_usd,
  }));
}

export function redactAccountId(accountId: string): string {
  if (accountId.length <= 10) {
    return `${accountId.slice(0, 2)}...${accountId.slice(-2)}`;
  }
  return `${accountId.slice(0, 6)}...${accountId.slice(-4)}`;
}

export function accountIdAllowed(
  allowlist: LiveAccountAllowlist,
  accountId: string | undefined,
): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string } {
  if (accountId === undefined || accountId.trim() === '') {
    return { ok: false, code: 'order_intent_missing_account_id', message: 'order intent is missing account_id' };
  }
  if (!allowlist.some((entry) => entry.account_id === accountId)) {
    return { ok: false, code: 'account_id_not_in_allowlist', message: 'account_id is not in the live account allowlist' };
  }
  return { ok: true };
}

export function missingAllowlistEntriesFromSnapshot(
  allowlist: LiveAccountAllowlist,
  brokerAccounts: readonly BrokerAccountSnapshotEntry[],
): readonly LiveAccountAllowlistEntry[] {
  const brokerAccountIds = new Set(brokerAccounts.map((account) => account.account_id));
  return allowlist.filter((entry) => !brokerAccountIds.has(entry.account_id));
}

export function liveAccountAllowlistToJsonValue(allowlist: LiveAccountAllowlist): JsonValue {
  return allowlist.map((entry) => ({
    fcm_id: entry.fcm_id,
    ib_id: entry.ib_id,
    account_id: entry.account_id,
    label: entry.label,
    max_position_contracts: entry.max_position_contracts,
    daily_loss_cap_usd: entry.daily_loss_cap_usd,
    max_session_duration_ms: entry.max_session_duration_ms,
    time_of_day_restriction: entry.time_of_day_restriction,
  })) as JsonValue;
}

function resolveEntry(
  record: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
  path: string,
  issues: AccountAllowlistValidationIssue[],
): LiveAccountAllowlistEntry | undefined {
  const label = requiredString(record, 'label', env, path, issues);
  const fcmId = requiredString(record, 'fcm_id', env, path, issues);
  const ibId = requiredString(record, 'ib_id', env, path, issues);
  const accountId = requiredString(record, 'account_id', env, path, issues, { forbidLucidLiteral: true });
  const maxPositionContracts = requiredPositiveInteger(record.max_position_contracts, `${path}.max_position_contracts`, issues);
  const dailyLossCapUsd = requiredPositiveNumber(record.daily_loss_cap_usd, `${path}.daily_loss_cap_usd`, issues);
  const maxSessionDurationMs = requiredPositiveInteger(record.max_session_duration_ms, `${path}.max_session_duration_ms`, issues);
  const timeOfDayRestriction = requiredTimeRestriction(record.time_of_day_restriction, `${path}.time_of_day_restriction`, issues);

  if (
    label === undefined ||
    fcmId === undefined ||
    ibId === undefined ||
    accountId === undefined ||
    maxPositionContracts === undefined ||
    dailyLossCapUsd === undefined ||
    maxSessionDurationMs === undefined ||
    timeOfDayRestriction === undefined
  ) {
    return undefined;
  }

  return {
    label,
    fcm_id: fcmId,
    ib_id: ibId,
    account_id: accountId,
    max_position_contracts: maxPositionContracts,
    daily_loss_cap_usd: dailyLossCapUsd,
    max_session_duration_ms: maxSessionDurationMs,
    time_of_day_restriction: timeOfDayRestriction,
  };
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  field: 'label' | 'fcm_id' | 'ib_id' | 'account_id',
  env: Readonly<Record<string, string | undefined>>,
  path: string,
  issues: AccountAllowlistValidationIssue[],
  options: { readonly forbidLucidLiteral?: boolean } = {},
): string | undefined {
  const literal = record[field];
  const envRef = record[`${field}_env`];
  if (literal !== undefined && envRef !== undefined) {
    issues.push({ path: `${path}.${field}`, code: 'ambiguous_field_source', message: `use ${field} or ${field}_env, not both` });
    return undefined;
  }
  if (envRef !== undefined) {
    if (typeof envRef !== 'string' || envRef.trim() === '') {
      issues.push({ path: `${path}.${field}_env`, code: 'invalid_field_type', message: 'must be a non-empty env var name' });
      return undefined;
    }
    const value = env[envRef];
    if (value === undefined || value.trim() === '') {
      issues.push({ path: `${path}.${field}_env`, code: 'missing_env_value', message: `env var ${envRef} is missing or empty` });
      return undefined;
    }
    return value;
  }
  if (typeof literal !== 'string' || literal.trim() === '') {
    issues.push({ path: `${path}.${field}`, code: 'missing_required_field', message: 'is required' });
    return undefined;
  }
  if (options.forbidLucidLiteral === true && LUCIDFLEX_ACCOUNT_ID_LITERAL_PATTERN.test(literal)) {
    issues.push({
      path: `${path}.${field}`,
      code: 'literal_lucidflex_account_id_forbidden',
      message: 'Lucid account IDs must be referenced via env var, not embedded literally',
    });
    return undefined;
  }
  return literal;
}

function requiredPositiveInteger(
  value: unknown,
  path: string,
  issues: AccountAllowlistValidationIssue[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    issues.push({ path, code: 'invalid_field_value', message: 'must be a positive integer' });
    return undefined;
  }
  return value;
}

function requiredPositiveNumber(
  value: unknown,
  path: string,
  issues: AccountAllowlistValidationIssue[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    issues.push({ path, code: 'invalid_field_value', message: 'must be a positive number' });
    return undefined;
  }
  return value;
}

function requiredTimeRestriction(
  value: unknown,
  path: string,
  issues: AccountAllowlistValidationIssue[],
): LiveAccountTimeOfDayRestriction | undefined {
  if (typeof value !== 'string' || !LIVE_ACCOUNT_TIME_OF_DAY_RESTRICTIONS.includes(value as never)) {
    issues.push({
      path,
      code: 'invalid_field_value',
      message: `must be one of: ${LIVE_ACCOUNT_TIME_OF_DAY_RESTRICTIONS.join(', ')}`,
    });
    return undefined;
  }
  return value as LiveAccountTimeOfDayRestriction;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
