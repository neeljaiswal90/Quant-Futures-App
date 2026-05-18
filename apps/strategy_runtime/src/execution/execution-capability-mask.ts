import { createHash } from 'node:crypto';
import { stableJsonStringify, type JsonValue } from '../contracts/index.js';

export const EXECUTION_CAPABILITY_MASK_SCHEMA_VERSION = 1 as const;
export const EXECUTION_CAPABILITY_MASK_VERSION = 1 as const;
export const EXECUTION_CAPABILITY_MASK_ID =
  'execution-capability-mask-v1-adr0018-paper-only-order-plant' as const;

export const EXECUTION_CAPABILITIES = [
  'order_plant_paper',
  'order_plant_live',
  'pnl_plant',
  'history_plant',
  'submit',
  'cancel_replace',
  'flatten',
  'ack_measurement',
  'ack_enforcement',
  'killswitch_armed',
  'killswitch_tripped',
] as const;

export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];

export const EXECUTION_USE_CONTEXTS = [
  'session_startup',
  'preload',
  'connection_open',
  'paper_order_submit',
  'live_order_submit',
  'cancel_replace',
  'ack_reconcile',
  'operator_display',
  'blocked_diagnostic_count',
] as const;

export type ExecutionUseContext = (typeof EXECUTION_USE_CONTEXTS)[number];

export const EXECUTION_CAPABILITY_TIERS = [
  'enabled',
  'enabled_with_live_mode_only',
  'enabled_with_vault_evidence',
  'enabled_with_health_gates_satisfied',
  'blocked',
] as const;

export type ExecutionCapabilityTier = (typeof EXECUTION_CAPABILITY_TIERS)[number];

export const EXECUTION_SCOPING_SURFACES = [
  'global',
  'account',
  'venue',
  'symbol_allowlist',
  'strategy_allowlist',
] as const;

export type ExecutionScopingSurface = (typeof EXECUTION_SCOPING_SURFACES)[number];

export const EXECUTION_HEALTH_GATES = [
  'connectivity_auth_health',
  'plant_health',
  'heartbeat_freshness',
  'account_resolution_readiness',
  'symbol_entitlement_readiness',
  'killswitch_clear',
] as const;

export type ExecutionHealthGate = (typeof EXECUTION_HEALTH_GATES)[number];

export const EXECUTION_CAPABILITY_DECISION_REASONS = [
  'allowed',
  'unknown_capability',
  'unknown_use_context',
  'unknown_scoping_surface',
  'unknown_health_gate',
  'unknown_tier',
  'blocked_capability',
  'wrong_session_mode',
  'requires_vault_evidence',
  'missing_health_gate',
  'unsupported_caller_pattern',
] as const;

export type ExecutionCapabilityDecisionReason =
  (typeof EXECUTION_CAPABILITY_DECISION_REASONS)[number];

export const EXECUTION_SESSION_MODES = ['paper', 'live'] as const;
export type ExecutionSessionMode = (typeof EXECUTION_SESSION_MODES)[number];

export const EXECUTION_CAPABILITY_BINDINGS = {
  order_plant_paper: { paper: 'enabled', live: 'enabled' },
  order_plant_live: { paper: 'blocked', live: 'enabled_with_vault_evidence' },
  pnl_plant: { paper: 'blocked', live: 'enabled' },
  history_plant: { paper: 'blocked', live: 'blocked' },
  submit: { paper: 'enabled', live: 'enabled_with_health_gates_satisfied' },
  cancel_replace: { paper: 'enabled', live: 'enabled_with_health_gates_satisfied' },
  flatten: { paper: 'enabled', live: 'enabled_with_health_gates_satisfied' },
  ack_measurement: { paper: 'enabled', live: 'enabled' },
  ack_enforcement: { paper: 'blocked', live: 'enabled' },
  killswitch_armed: { paper: 'enabled', live: 'enabled' },
  killswitch_tripped: { paper: 'blocked', live: 'blocked' },
} as const satisfies Readonly<
  Record<ExecutionCapability, Readonly<Record<ExecutionSessionMode, ExecutionCapabilityTier>>>
>;

export const REQUIRED_EXECUTION_HEALTH_GATES_BY_CAPABILITY = {
  submit: EXECUTION_HEALTH_GATES,
  cancel_replace: EXECUTION_HEALTH_GATES,
  flatten: EXECUTION_HEALTH_GATES,
} as const satisfies Readonly<Partial<Record<ExecutionCapability, readonly ExecutionHealthGate[]>>>;

export interface ExecutionCapabilityMask {
  readonly schema_version: typeof EXECUTION_CAPABILITY_MASK_SCHEMA_VERSION;
  readonly mask_version: typeof EXECUTION_CAPABILITY_MASK_VERSION;
  readonly mask_id: typeof EXECUTION_CAPABILITY_MASK_ID;
  readonly mask_hash: string;
  readonly capabilities: readonly ExecutionCapability[];
  readonly use_contexts: readonly ExecutionUseContext[];
  readonly capability_tiers: readonly ExecutionCapabilityTier[];
  readonly scoping_surfaces: readonly ExecutionScopingSurface[];
  readonly health_gates: readonly ExecutionHealthGate[];
  readonly decision_reasons: readonly ExecutionCapabilityDecisionReason[];
  readonly binding_table: Readonly<
    Record<ExecutionCapability, Readonly<Record<ExecutionSessionMode, ExecutionCapabilityTier>>>
  >;
  readonly required_health_gates_by_capability: Readonly<
    Partial<Record<ExecutionCapability, readonly ExecutionHealthGate[]>>
  >;
}

export interface ExecutionCapabilityDecision {
  readonly allowed: boolean;
  readonly reason: ExecutionCapabilityDecisionReason;
  readonly capability: string;
  readonly use_context: string;
  readonly session_mode: string;
  readonly scoping_surface: string;
  readonly tier?: string;
  readonly missing_health_gates?: readonly ExecutionHealthGate[];
}

export interface ExecutionCapabilityEvaluationInput {
  readonly capability: string;
  readonly useContext: string;
  readonly sessionMode: string;
  readonly scopingSurface: string;
  readonly healthGates?: ReadonlySet<string> | readonly string[];
  readonly vaultEvidence?: boolean;
  readonly mask?: ExecutionCapabilityMask;
}

type ExecutionCapabilityMaskCore = Omit<ExecutionCapabilityMask, 'mask_hash'>;

export function buildExecutionCapabilityMask(): ExecutionCapabilityMask {
  const core: ExecutionCapabilityMaskCore = {
    schema_version: EXECUTION_CAPABILITY_MASK_SCHEMA_VERSION,
    mask_version: EXECUTION_CAPABILITY_MASK_VERSION,
    mask_id: EXECUTION_CAPABILITY_MASK_ID,
    capabilities: EXECUTION_CAPABILITIES,
    use_contexts: EXECUTION_USE_CONTEXTS,
    capability_tiers: EXECUTION_CAPABILITY_TIERS,
    scoping_surfaces: EXECUTION_SCOPING_SURFACES,
    health_gates: EXECUTION_HEALTH_GATES,
    decision_reasons: EXECUTION_CAPABILITY_DECISION_REASONS,
    binding_table: EXECUTION_CAPABILITY_BINDINGS,
    required_health_gates_by_capability: REQUIRED_EXECUTION_HEALTH_GATES_BY_CAPABILITY,
  };
  return {
    ...core,
    mask_hash: hashExecutionCapabilityMaskCore(core),
  };
}

export const EXECUTION_CAPABILITY_MASK = buildExecutionCapabilityMask();

export function executionCapabilityMaskValues(): {
  readonly execution_mask_version: typeof EXECUTION_CAPABILITY_MASK_VERSION;
  readonly execution_mask_id: typeof EXECUTION_CAPABILITY_MASK_ID;
  readonly execution_mask_hash: string;
} {
  return {
    execution_mask_version: EXECUTION_CAPABILITY_MASK_VERSION,
    execution_mask_id: EXECUTION_CAPABILITY_MASK_ID,
    execution_mask_hash: EXECUTION_CAPABILITY_MASK.mask_hash,
  };
}

export function tierOfExecutionCapability(
  mask: ExecutionCapabilityMask,
  capability: ExecutionCapability,
  sessionMode: ExecutionSessionMode,
): ExecutionCapabilityTier {
  return mask.binding_table[capability][sessionMode];
}

export function evaluateExecutionCapability(
  input: ExecutionCapabilityEvaluationInput,
): ExecutionCapabilityDecision {
  const mask = input.mask ?? EXECUTION_CAPABILITY_MASK;
  const base = {
    capability: input.capability,
    use_context: input.useContext,
    session_mode: input.sessionMode,
    scoping_surface: input.scopingSurface,
  } as const;

  if (!isExecutionCapability(input.capability)) {
    return { ...base, allowed: false, reason: 'unknown_capability' };
  }
  if (!isExecutionUseContext(input.useContext)) {
    return { ...base, allowed: false, reason: 'unknown_use_context' };
  }
  if (!isExecutionSessionMode(input.sessionMode)) {
    return { ...base, allowed: false, reason: 'wrong_session_mode' };
  }
  if (!isExecutionScopingSurface(input.scopingSurface)) {
    return { ...base, allowed: false, reason: 'unknown_scoping_surface' };
  }

  const healthGates = normalizeHealthGates(input.healthGates);
  if (healthGates.some((healthGate) => !isExecutionHealthGate(healthGate))) {
    return { ...base, allowed: false, reason: 'unknown_health_gate' };
  }

  const binding = mask.binding_table[input.capability];
  const tier = binding?.[input.sessionMode];
  if (!isExecutionCapabilityTier(tier)) {
    return { ...base, allowed: false, reason: 'unknown_tier', tier: String(tier) };
  }

  const modeReason = sessionModeReason(input.useContext, input.sessionMode);
  if (modeReason !== 'allowed') {
    return { ...base, allowed: false, reason: modeReason, tier };
  }

  if (tier === 'blocked') {
    return { ...base, allowed: false, reason: 'blocked_capability', tier };
  }
  if (tier === 'enabled') {
    return { ...base, allowed: true, reason: 'allowed', tier };
  }
  if (tier === 'enabled_with_live_mode_only') {
    if (input.sessionMode !== 'live') {
      return { ...base, allowed: false, reason: 'wrong_session_mode', tier };
    }
    return { ...base, allowed: true, reason: 'allowed', tier };
  }
  if (tier === 'enabled_with_vault_evidence') {
    if (input.sessionMode !== 'live') {
      return { ...base, allowed: false, reason: 'wrong_session_mode', tier };
    }
    if (input.vaultEvidence !== true) {
      return { ...base, allowed: false, reason: 'requires_vault_evidence', tier };
    }
    return { ...base, allowed: true, reason: 'allowed', tier };
  }
  if (tier === 'enabled_with_health_gates_satisfied') {
    const requiredHealthGates =
      mask.required_health_gates_by_capability[input.capability] ?? [];
    if (requiredHealthGates.some((healthGate) => !isExecutionHealthGate(healthGate))) {
      return { ...base, allowed: false, reason: 'unknown_health_gate', tier };
    }
    const presentHealthGates = new Set(healthGates);
    const missingHealthGates = requiredHealthGates.filter(
      (healthGate) => !presentHealthGates.has(healthGate),
    );
    if (missingHealthGates.length > 0) {
      return {
        ...base,
        allowed: false,
        reason: 'missing_health_gate',
        tier,
        missing_health_gates: missingHealthGates,
      };
    }
    return { ...base, allowed: true, reason: 'allowed', tier };
  }

  return { ...base, allowed: false, reason: 'unknown_tier', tier };
}

export function isExecutionCapabilityAllowed(
  input: ExecutionCapabilityEvaluationInput,
): boolean {
  return evaluateExecutionCapability(input).allowed;
}

export function assertExecutionCapabilityAllowed(
  input: ExecutionCapabilityEvaluationInput,
): void {
  const decision = evaluateExecutionCapability(input);
  if (!decision.allowed) {
    const missing =
      decision.missing_health_gates && decision.missing_health_gates.length > 0
        ? `; missing_health_gates=${decision.missing_health_gates.join(',')}`
        : '';
    throw new Error(
      `Execution capability ${decision.capability} is not allowed for ${decision.session_mode}/${decision.use_context}/${decision.scoping_surface}: ${decision.reason}${missing}`,
    );
  }
}

function hashExecutionCapabilityMaskCore(core: ExecutionCapabilityMaskCore): string {
  return `sha256:${createHash('sha256')
    .update(stableJsonStringify(core as JsonValue))
    .digest('hex')}`;
}

function sessionModeReason(
  useContext: ExecutionUseContext,
  sessionMode: ExecutionSessionMode,
): 'allowed' | 'wrong_session_mode' {
  if (useContext === 'paper_order_submit' && sessionMode !== 'paper') {
    return 'wrong_session_mode';
  }
  if (useContext === 'live_order_submit' && sessionMode !== 'live') {
    return 'wrong_session_mode';
  }
  return 'allowed';
}

function normalizeHealthGates(
  healthGates: ReadonlySet<string> | readonly string[] | undefined,
): readonly string[] {
  if (healthGates === undefined) {
    return [];
  }
  return Array.isArray(healthGates) ? healthGates : Array.from(healthGates);
}

function isExecutionCapability(value: string): value is ExecutionCapability {
  return (EXECUTION_CAPABILITIES as readonly string[]).includes(value);
}

function isExecutionUseContext(value: string): value is ExecutionUseContext {
  return (EXECUTION_USE_CONTEXTS as readonly string[]).includes(value);
}

function isExecutionCapabilityTier(value: unknown): value is ExecutionCapabilityTier {
  return (
    typeof value === 'string' &&
    (EXECUTION_CAPABILITY_TIERS as readonly string[]).includes(value)
  );
}

function isExecutionScopingSurface(value: string): value is ExecutionScopingSurface {
  return (EXECUTION_SCOPING_SURFACES as readonly string[]).includes(value);
}

function isExecutionHealthGate(value: string): value is ExecutionHealthGate {
  return (EXECUTION_HEALTH_GATES as readonly string[]).includes(value);
}

function isExecutionSessionMode(value: string): value is ExecutionSessionMode {
  return (EXECUTION_SESSION_MODES as readonly string[]).includes(value);
}
