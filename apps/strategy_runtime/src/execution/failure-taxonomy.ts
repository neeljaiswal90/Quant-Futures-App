export const FAILURE_CATEGORIES = [
  'network',
  'auth',
  'permission',
  'rate_limit',
  'protocol',
  'unknown',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const FAILURE_REMEDIATIONS = [
  'retry_with_backoff',
  'escalate',
  'terminate_session',
  'block_submission',
] as const;

export type FailureRemediation = (typeof FAILURE_REMEDIATIONS)[number];

export const NETWORK_FAILURE_SUBREASONS = [
  'tls_handshake_failed',
  'socket_dropped',
  'dns_resolution_failed',
  'gateway_unreachable',
] as const;
export const AUTH_FAILURE_SUBREASONS = [
  'invalid_credentials',
  'session_expired',
  'mfa_required',
  'account_locked',
] as const;
export const PERMISSION_FAILURE_SUBREASONS = [
  'plant_not_authorized',
  'instrument_not_authorized',
  'account_disabled',
] as const;
export const RATE_LIMIT_FAILURE_SUBREASONS = [
  'submission_throttle',
  'cancel_throttle',
  'session_rate_limit',
] as const;
export const PROTOCOL_FAILURE_SUBREASONS = [
  'unknown_message_type',
  'framing_error',
  'sequence_number_drift',
  'schema_version_mismatch',
] as const;
export const UNKNOWN_FAILURE_SUBREASONS = ['unrecognized'] as const;

export interface FailureSubreasonByCategory {
  readonly network: (typeof NETWORK_FAILURE_SUBREASONS)[number];
  readonly auth: (typeof AUTH_FAILURE_SUBREASONS)[number];
  readonly permission: (typeof PERMISSION_FAILURE_SUBREASONS)[number];
  readonly rate_limit: (typeof RATE_LIMIT_FAILURE_SUBREASONS)[number];
  readonly protocol: (typeof PROTOCOL_FAILURE_SUBREASONS)[number];
  readonly unknown: (typeof UNKNOWN_FAILURE_SUBREASONS)[number];
}

export type FailureSubreason = FailureSubreasonByCategory[keyof FailureSubreasonByCategory];

export type FailureClassification = {
  readonly [TCategory in FailureCategory]: {
    readonly category: TCategory;
    readonly subreason: FailureSubreasonByCategory[TCategory];
    readonly canonical_subreason: `${TCategory}.${FailureSubreasonByCategory[TCategory]}`;
    readonly remediation: FailureRemediation;
    readonly known: boolean;
    readonly raw_code?: string;
    readonly raw_subreason?: string;
  };
}[FailureCategory];

export type CanonicalFailureSubreason = FailureClassification['canonical_subreason'];

type FailureClassificationInput<TCategory extends FailureCategory> = {
  readonly category: TCategory;
  readonly subreason: FailureSubreasonByCategory[TCategory];
};

const SUBREASONS_BY_CATEGORY = {
  network: NETWORK_FAILURE_SUBREASONS,
  auth: AUTH_FAILURE_SUBREASONS,
  permission: PERMISSION_FAILURE_SUBREASONS,
  rate_limit: RATE_LIMIT_FAILURE_SUBREASONS,
  protocol: PROTOCOL_FAILURE_SUBREASONS,
  unknown: UNKNOWN_FAILURE_SUBREASONS,
} as const satisfies {
  readonly [TCategory in FailureCategory]: readonly FailureSubreasonByCategory[TCategory][];
};

const REMEDIATION_BY_CANONICAL_SUBREASON = {
  'network.tls_handshake_failed': 'terminate_session',
  'network.socket_dropped': 'retry_with_backoff',
  'network.dns_resolution_failed': 'retry_with_backoff',
  'network.gateway_unreachable': 'retry_with_backoff',
  'auth.invalid_credentials': 'terminate_session',
  'auth.session_expired': 'retry_with_backoff',
  'auth.mfa_required': 'escalate',
  'auth.account_locked': 'escalate',
  'permission.plant_not_authorized': 'escalate',
  'permission.instrument_not_authorized': 'escalate',
  'permission.account_disabled': 'escalate',
  'rate_limit.submission_throttle': 'block_submission',
  'rate_limit.cancel_throttle': 'block_submission',
  'rate_limit.session_rate_limit': 'block_submission',
  'protocol.unknown_message_type': 'escalate',
  'protocol.framing_error': 'escalate',
  'protocol.sequence_number_drift': 'retry_with_backoff',
  'protocol.schema_version_mismatch': 'escalate',
  'unknown.unrecognized': 'escalate',
} as const satisfies Record<CanonicalFailureSubreason, FailureRemediation>;

const BROKER_REJECT_CODE_PATTERNS: readonly [
  RegExp,
  FailureClassificationInput<FailureCategory>,
][] = [
  [/TLS|HANDSHAKE/u, { category: 'network', subreason: 'tls_handshake_failed' }],
  [/SOCKET|CONNECTION.*DROP|DROPPED|DISCONNECT/u, { category: 'network', subreason: 'socket_dropped' }],
  [/DNS|RESOLUTION/u, { category: 'network', subreason: 'dns_resolution_failed' }],
  [/GATEWAY|UNREACHABLE|UNAVAILABLE/u, { category: 'network', subreason: 'gateway_unreachable' }],
  [/SESSION.*EXPIRED|EXPIRED.*SESSION/u, { category: 'auth', subreason: 'session_expired' }],
  [/MFA|MULTI.*FACTOR/u, { category: 'auth', subreason: 'mfa_required' }],
  [/ACCOUNT.*LOCK/u, { category: 'auth', subreason: 'account_locked' }],
  [/AUTH|INVALID.*CRED|LOGIN|PASSWORD/u, { category: 'auth', subreason: 'invalid_credentials' }],
  [/PLANT.*NOT.*AUTH|ORDER.*PLANT.*DENIED|PLANT.*DENIED/u, { category: 'permission', subreason: 'plant_not_authorized' }],
  [/INSTRUMENT.*NOT.*AUTH|SYMBOL.*DENIED|INSTRUMENT.*DENIED/u, { category: 'permission', subreason: 'instrument_not_authorized' }],
  [/ACCOUNT.*DISABLED/u, { category: 'permission', subreason: 'account_disabled' }],
  [/SUBMISSION.*THROTTLE|ORDER.*THROTTLE/u, { category: 'rate_limit', subreason: 'submission_throttle' }],
  [/CANCEL.*THROTTLE/u, { category: 'rate_limit', subreason: 'cancel_throttle' }],
  [/SESSION.*RATE|RATE.*LIMIT/u, { category: 'rate_limit', subreason: 'session_rate_limit' }],
  [/UNKNOWN.*MESSAGE|MESSAGE.*TYPE/u, { category: 'protocol', subreason: 'unknown_message_type' }],
  [/FRAMING|FRAME/u, { category: 'protocol', subreason: 'framing_error' }],
  [/SEQUENCE|SEQ.*DRIFT/u, { category: 'protocol', subreason: 'sequence_number_drift' }],
  [/SCHEMA.*VERSION|VERSION.*MISMATCH/u, { category: 'protocol', subreason: 'schema_version_mismatch' }],
  [/PROTOCOL/u, { category: 'protocol', subreason: 'framing_error' }],
];

export function parseBrokerRejectCode(
  rejectReasonCode: string | undefined,
  rejectSubreason?: string,
): FailureClassification {
  const parsedSubreason = parseCanonicalSubreason(rejectSubreason);
  if (parsedSubreason !== undefined) {
    return classification(parsedSubreason, {
      known: true,
      raw_code: rejectReasonCode,
      raw_subreason: rejectSubreason,
    });
  }

  const normalized = normalizeRejectCode(rejectReasonCode);
  for (const [pattern, candidate] of BROKER_REJECT_CODE_PATTERNS) {
    if (pattern.test(normalized)) {
      return classification(candidate, {
        known: true,
        raw_code: rejectReasonCode,
        raw_subreason: rejectSubreason,
      });
    }
  }

  return classification({ category: 'unknown', subreason: 'unrecognized' }, {
    known: false,
    raw_code: rejectReasonCode,
    raw_subreason: rejectSubreason,
  });
}

function parseCanonicalSubreason(
  value: string | undefined,
): FailureClassificationInput<FailureCategory> | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const [category, subreason] = value.trim().split('.', 2);
  if (!isFailureCategory(category)) {
    return undefined;
  }
  const allowed = SUBREASONS_BY_CATEGORY[category] as readonly string[];
  if (!allowed.includes(subreason ?? '')) {
    return undefined;
  }
  return {
    category,
    subreason: subreason as FailureSubreasonByCategory[typeof category],
  };
}

function classification<TCategory extends FailureCategory>(
  input: FailureClassificationInput<TCategory>,
  context: {
    readonly known: boolean;
    readonly raw_code?: string;
    readonly raw_subreason?: string;
  },
): FailureClassification {
  const canonical = `${input.category}.${input.subreason}` as CanonicalFailureSubreason;
  return {
    category: input.category,
    subreason: input.subreason,
    canonical_subreason: canonical,
    remediation: REMEDIATION_BY_CANONICAL_SUBREASON[canonical],
    known: context.known,
    ...(context.raw_code === undefined ? {} : { raw_code: context.raw_code }),
    ...(context.raw_subreason === undefined ? {} : { raw_subreason: context.raw_subreason }),
  } as FailureClassification;
}

function isFailureCategory(value: string | undefined): value is FailureCategory {
  return (FAILURE_CATEGORIES as readonly string[]).includes(value ?? '');
}

function normalizeRejectCode(value: string | undefined): string {
  return (value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
}
