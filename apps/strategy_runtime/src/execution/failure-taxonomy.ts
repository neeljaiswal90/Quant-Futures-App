export const FAILURE_CATEGORIES = [
  'auth',
  'credentials',
  'permission',
  'entitlement',
  'risk',
  'broker',
  'reconnect',
  'transport',
  'unknown',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const AUTH_FAILURE_SUBREASONS = [
  'invalid_credentials',
  'session_expired',
] as const;
export const CREDENTIALS_FAILURE_SUBREASONS = [
  'missing',
  'resolver_unavailable',
] as const;
export const PERMISSION_FAILURE_SUBREASONS = [
  'order_submit_denied',
  'cancel_denied',
] as const;
export const ENTITLEMENT_FAILURE_SUBREASONS = ['symbol_denied'] as const;
export const RISK_FAILURE_SUBREASONS = ['local_reject', 'broker_reject'] as const;
export const BROKER_FAILURE_SUBREASONS = [
  'unavailable',
  'protocol_error',
] as const;
export const RECONNECT_FAILURE_SUBREASONS = [
  'retry_budget_exhausted',
  'session_lost',
  'attempt_timeout',
] as const;
export const TRANSPORT_FAILURE_SUBREASONS = [
  'process_dead',
  'broker_dead',
  'heartbeat_timeout',
] as const;
export const UNKNOWN_FAILURE_SUBREASONS = ['unknown'] as const;

export interface FailureSubreasonByCategory {
  readonly auth: (typeof AUTH_FAILURE_SUBREASONS)[number];
  readonly credentials: (typeof CREDENTIALS_FAILURE_SUBREASONS)[number];
  readonly permission: (typeof PERMISSION_FAILURE_SUBREASONS)[number];
  readonly entitlement: (typeof ENTITLEMENT_FAILURE_SUBREASONS)[number];
  readonly risk: (typeof RISK_FAILURE_SUBREASONS)[number];
  readonly broker: (typeof BROKER_FAILURE_SUBREASONS)[number];
  readonly reconnect: (typeof RECONNECT_FAILURE_SUBREASONS)[number];
  readonly transport: (typeof TRANSPORT_FAILURE_SUBREASONS)[number];
  readonly unknown: (typeof UNKNOWN_FAILURE_SUBREASONS)[number];
}

export type FailureSubreason =
  FailureSubreasonByCategory[keyof FailureSubreasonByCategory];

export interface FailureRemediationFlags {
  readonly retryable: boolean;
  readonly should_reconnect: boolean;
  readonly should_quarantine: boolean;
  readonly should_kill_switch: boolean;
  readonly requires_operator: boolean;
}

export type FailureClassification = {
  readonly [TCategory in FailureCategory]: {
    readonly category: TCategory;
    readonly subreason: FailureSubreasonByCategory[TCategory];
    readonly canonical_subreason: `${TCategory}.${FailureSubreasonByCategory[TCategory]}`;
    readonly known: boolean;
    readonly raw_code?: string;
    readonly raw_subreason?: string;
    readonly remediation: FailureRemediationFlags;
  };
}[FailureCategory];

export type CanonicalFailureSubreason = FailureClassification['canonical_subreason'];

type FailureClassificationInput<TCategory extends FailureCategory> = {
  readonly category: TCategory;
  readonly subreason: FailureSubreasonByCategory[TCategory];
};

const SUBREASONS_BY_CATEGORY = {
  auth: AUTH_FAILURE_SUBREASONS,
  credentials: CREDENTIALS_FAILURE_SUBREASONS,
  permission: PERMISSION_FAILURE_SUBREASONS,
  entitlement: ENTITLEMENT_FAILURE_SUBREASONS,
  risk: RISK_FAILURE_SUBREASONS,
  broker: BROKER_FAILURE_SUBREASONS,
  reconnect: RECONNECT_FAILURE_SUBREASONS,
  transport: TRANSPORT_FAILURE_SUBREASONS,
  unknown: UNKNOWN_FAILURE_SUBREASONS,
} as const satisfies {
  readonly [TCategory in FailureCategory]: readonly FailureSubreasonByCategory[TCategory][];
};

const REMEDIATION_BY_CANONICAL_SUBREASON = {
  'auth.invalid_credentials': {
    retryable: false,
    should_reconnect: false,
    should_quarantine: false,
    should_kill_switch: true,
    requires_operator: true,
  },
  'auth.session_expired': {
    retryable: true,
    should_reconnect: true,
    should_quarantine: false,
    should_kill_switch: false,
    requires_operator: false,
  },
  'credentials.missing': {
    retryable: false,
    should_reconnect: false,
    should_quarantine: false,
    should_kill_switch: true,
    requires_operator: true,
  },
  'credentials.resolver_unavailable': {
    retryable: true,
    should_reconnect: false,
    should_quarantine: false,
    should_kill_switch: false,
    requires_operator: true,
  },
  'permission.order_submit_denied': {
    retryable: false,
    should_reconnect: false,
    should_quarantine: false,
    should_kill_switch: true,
    requires_operator: true,
  },
  'permission.cancel_denied': {
    retryable: false,
    should_reconnect: false,
    should_quarantine: true,
    should_kill_switch: true,
    requires_operator: true,
  },
  'entitlement.symbol_denied': {
    retryable: false,
    should_reconnect: false,
    should_quarantine: false,
    should_kill_switch: false,
    requires_operator: true,
  },
  'risk.local_reject': {
    retryable: false,
    should_reconnect: false,
    should_quarantine: true,
    should_kill_switch: false,
    requires_operator: false,
  },
  'risk.broker_reject': {
    retryable: false,
    should_reconnect: false,
    should_quarantine: true,
    should_kill_switch: false,
    requires_operator: true,
  },
  'broker.unavailable': {
    retryable: true,
    should_reconnect: true,
    should_quarantine: false,
    should_kill_switch: false,
    requires_operator: false,
  },
  'broker.protocol_error': {
    retryable: true,
    should_reconnect: true,
    should_quarantine: false,
    should_kill_switch: false,
    requires_operator: true,
  },
  'reconnect.retry_budget_exhausted': {
    retryable: false,
    should_reconnect: false,
    should_quarantine: false,
    should_kill_switch: true,
    requires_operator: true,
  },
  'reconnect.session_lost': {
    retryable: true,
    should_reconnect: true,
    should_quarantine: false,
    should_kill_switch: false,
    requires_operator: false,
  },
  'reconnect.attempt_timeout': {
    retryable: true,
    should_reconnect: true,
    should_quarantine: false,
    should_kill_switch: false,
    requires_operator: false,
  },
  'transport.process_dead': {
    retryable: false,
    should_reconnect: false,
    should_quarantine: false,
    should_kill_switch: true,
    requires_operator: true,
  },
  'transport.broker_dead': {
    retryable: true,
    should_reconnect: true,
    should_quarantine: false,
    should_kill_switch: true,
    requires_operator: true,
  },
  'transport.heartbeat_timeout': {
    retryable: true,
    should_reconnect: true,
    should_quarantine: false,
    should_kill_switch: false,
    requires_operator: false,
  },
  'unknown.unknown': {
    retryable: false,
    should_reconnect: false,
    should_quarantine: false,
    should_kill_switch: false,
    requires_operator: true,
  },
} as const satisfies Record<CanonicalFailureSubreason, FailureRemediationFlags>;

const BROKER_REJECT_CODE_PATTERNS: readonly [
  RegExp,
  FailureClassificationInput<FailureCategory>,
][] = [
  [/AUTH.*SESSION.*EXPIRED|SESSION.*EXPIRED/u, { category: 'auth', subreason: 'session_expired' }],
  [/AUTH|INVALID.*CRED|LOGIN|PASSWORD/u, { category: 'auth', subreason: 'invalid_credentials' }],
  [/CREDENTIAL.*MISSING|MISSING.*CREDENTIAL/u, { category: 'credentials', subreason: 'missing' }],
  [/RESOLVER.*UNAVAILABLE|VAULT.*UNAVAILABLE/u, { category: 'credentials', subreason: 'resolver_unavailable' }],
  [/CANCEL.*DENIED/u, { category: 'permission', subreason: 'cancel_denied' }],
  [/PERMISSION|SUBMIT.*DENIED|ORDER.*DENIED/u, { category: 'permission', subreason: 'order_submit_denied' }],
  [/ENTITLEMENT|SYMBOL.*DENIED|MARKET.*DATA.*DENIED/u, { category: 'entitlement', subreason: 'symbol_denied' }],
  [/LOCAL.*RISK/u, { category: 'risk', subreason: 'local_reject' }],
  [/RISK/u, { category: 'risk', subreason: 'broker_reject' }],
  [/PROTOCOL|DECODE|ENCODE/u, { category: 'broker', subreason: 'protocol_error' }],
  [/UNAVAILABLE|BROKER.*DOWN|GATEWAY.*DOWN/u, { category: 'broker', subreason: 'unavailable' }],
  [/RETRY.*BUDGET|BUDGET.*EXHAUST/u, { category: 'reconnect', subreason: 'retry_budget_exhausted' }],
  [/SESSION.*LOST/u, { category: 'reconnect', subreason: 'session_lost' }],
  [/ATTEMPT.*TIMEOUT|TIMEOUT/u, { category: 'reconnect', subreason: 'attempt_timeout' }],
  [/PROCESS.*DEAD/u, { category: 'transport', subreason: 'process_dead' }],
  [/BROKER.*DEAD/u, { category: 'transport', subreason: 'broker_dead' }],
  [/HEARTBEAT/u, { category: 'transport', subreason: 'heartbeat_timeout' }],
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

  return classification({ category: 'unknown', subreason: 'unknown' }, {
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
    known: context.known,
    ...(context.raw_code === undefined ? {} : { raw_code: context.raw_code }),
    ...(context.raw_subreason === undefined ? {} : { raw_subreason: context.raw_subreason }),
    remediation: REMEDIATION_BY_CANONICAL_SUBREASON[canonical],
  } as FailureClassification;
}

function isFailureCategory(value: string | undefined): value is FailureCategory {
  return (FAILURE_CATEGORIES as readonly string[]).includes(value ?? '');
}

function normalizeRejectCode(value: string | undefined): string {
  return (value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
}
