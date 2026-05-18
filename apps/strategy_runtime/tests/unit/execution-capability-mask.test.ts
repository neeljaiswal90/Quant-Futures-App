import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_CAPABILITIES,
  EXECUTION_CAPABILITY_MASK_ID,
  EXECUTION_CAPABILITY_MASK_SCHEMA_VERSION,
  EXECUTION_CAPABILITY_MASK_VERSION,
  EXECUTION_HEALTH_GATES,
  EXECUTION_SCOPING_SURFACES,
  EXECUTION_USE_CONTEXTS,
  assertExecutionCapabilityAllowed,
  buildExecutionCapabilityMask,
  evaluateExecutionCapability,
  executionCapabilityMaskValues,
  isExecutionCapabilityAllowed,
  tierOfExecutionCapability,
  type ExecutionCapabilityMask,
} from '../../src/execution/execution-capability-mask.js';

const PYTHON = process.env.PYTHON ?? 'python';
const CURRENT_EXECUTION_MASK_HASH =
  'sha256:394afbad12e98d306005cd9f5823144d3e6c8deddd834eb00f17628b73dd556d';
const ALL_HEALTH_GATES = new Set(EXECUTION_HEALTH_GATES);

function pythonMask(): Record<string, unknown> {
  const result = spawnSync(
    PYTHON,
    ['-m', 'services.market_data_sidecar.execution.execution_capability_mask'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Python execution capability mask failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe('QFA-622 execution capability mask', () => {
  it('keeps the TS and Python masks byte-equivalent after JSON parse', () => {
    expect(buildExecutionCapabilityMask()).toEqual(pythonMask());
  });

  it('publishes the v1 scalar identity and deterministic hash', () => {
    const mask = buildExecutionCapabilityMask();

    expect(mask).toMatchObject({
      schema_version: EXECUTION_CAPABILITY_MASK_SCHEMA_VERSION,
      mask_version: EXECUTION_CAPABILITY_MASK_VERSION,
      mask_id: EXECUTION_CAPABILITY_MASK_ID,
      mask_hash: CURRENT_EXECUTION_MASK_HASH,
      capabilities: EXECUTION_CAPABILITIES,
      use_contexts: EXECUTION_USE_CONTEXTS,
      scoping_surfaces: EXECUTION_SCOPING_SURFACES,
    });
    expect(executionCapabilityMaskValues()).toEqual({
      execution_mask_version: EXECUTION_CAPABILITY_MASK_VERSION,
      execution_mask_id: EXECUTION_CAPABILITY_MASK_ID,
      execution_mask_hash: CURRENT_EXECUTION_MASK_HASH,
    });
    expect(tierOfExecutionCapability(mask, 'submit', 'paper')).toBe('enabled');
    expect(tierOfExecutionCapability(mask, 'submit', 'live')).toBe(
      'enabled_with_health_gates_satisfied',
    );
  });

  it('fails closed for unknown capabilities, use contexts, scoping surfaces, health gates, and tiers', () => {
    expect(
      evaluateExecutionCapability({
        capability: 'unknown_capability',
        useContext: 'session_startup',
        sessionMode: 'paper',
        scopingSurface: 'global',
      }),
    ).toMatchObject({ allowed: false, reason: 'unknown_capability' });

    expect(
      evaluateExecutionCapability({
        capability: 'submit',
        useContext: 'unknown_use_context',
        sessionMode: 'paper',
        scopingSurface: 'global',
      }),
    ).toMatchObject({ allowed: false, reason: 'unknown_use_context' });

    expect(
      evaluateExecutionCapability({
        capability: 'submit',
        useContext: 'paper_order_submit',
        sessionMode: 'paper',
        scopingSurface: 'unknown_surface',
      }),
    ).toMatchObject({ allowed: false, reason: 'unknown_scoping_surface' });

    expect(
      evaluateExecutionCapability({
        capability: 'submit',
        useContext: 'live_order_submit',
        sessionMode: 'live',
        scopingSurface: 'account',
        healthGates: ['unknown_health_gate'],
      }),
    ).toMatchObject({ allowed: false, reason: 'unknown_health_gate' });

    const badTierMask = {
      ...buildExecutionCapabilityMask(),
      binding_table: {
        ...buildExecutionCapabilityMask().binding_table,
        submit: { paper: 'unknown_tier', live: 'unknown_tier' },
      },
    } as unknown as ExecutionCapabilityMask;
    expect(
      evaluateExecutionCapability({
        capability: 'submit',
        useContext: 'paper_order_submit',
        sessionMode: 'paper',
        scopingSurface: 'account',
        mask: badTierMask,
      }),
    ).toMatchObject({ allowed: false, reason: 'unknown_tier' });
  });

  it('allows enabled paper and live capabilities from the v1 binding table', () => {
    expect(
      evaluateExecutionCapability({
        capability: 'order_plant_paper',
        useContext: 'session_startup',
        sessionMode: 'paper',
        scopingSurface: 'global',
      }),
    ).toMatchObject({ allowed: true, reason: 'allowed', tier: 'enabled' });

    expect(
      evaluateExecutionCapability({
        capability: 'ack_measurement',
        useContext: 'ack_reconcile',
        sessionMode: 'live',
        scopingSurface: 'account',
      }),
    ).toMatchObject({ allowed: true, reason: 'allowed', tier: 'enabled' });

    expect(
      evaluateExecutionCapability({
        capability: 'pnl_plant',
        useContext: 'connection_open',
        sessionMode: 'live',
        scopingSurface: 'account',
      }),
    ).toMatchObject({ allowed: true, reason: 'allowed', tier: 'enabled' });
  });

  it('blocks v1 blocked bindings in the selected session mode', () => {
    expect(
      evaluateExecutionCapability({
        capability: 'order_plant_live',
        useContext: 'session_startup',
        sessionMode: 'paper',
        scopingSurface: 'global',
      }),
    ).toMatchObject({ allowed: false, reason: 'blocked_capability', tier: 'blocked' });

    expect(
      evaluateExecutionCapability({
        capability: 'ack_enforcement',
        useContext: 'ack_reconcile',
        sessionMode: 'paper',
        scopingSurface: 'account',
      }),
    ).toMatchObject({ allowed: false, reason: 'blocked_capability', tier: 'blocked' });

    expect(
      evaluateExecutionCapability({
        capability: 'killswitch_tripped',
        useContext: 'operator_display',
        sessionMode: 'live',
        scopingSurface: 'global',
      }),
    ).toMatchObject({ allowed: false, reason: 'blocked_capability', tier: 'blocked' });
  });

  it('requires vault evidence for live order plant access and defaults vault evidence to false', () => {
    expect(
      evaluateExecutionCapability({
        capability: 'order_plant_live',
        useContext: 'session_startup',
        sessionMode: 'live',
        scopingSurface: 'global',
      }),
    ).toMatchObject({
      allowed: false,
      reason: 'requires_vault_evidence',
      tier: 'enabled_with_vault_evidence',
    });

    expect(
      evaluateExecutionCapability({
        capability: 'order_plant_live',
        useContext: 'session_startup',
        sessionMode: 'live',
        scopingSurface: 'global',
        vaultEvidence: true,
      }),
    ).toMatchObject({ allowed: true, reason: 'allowed' });
  });

  it('requires all execution health gates for live submit, cancel_replace, and flatten', () => {
    for (const capability of ['submit', 'cancel_replace', 'flatten'] as const) {
      expect(
        evaluateExecutionCapability({
          capability,
          useContext: capability === 'cancel_replace' ? 'cancel_replace' : 'live_order_submit',
          sessionMode: 'live',
          scopingSurface: 'account',
          healthGates: ['connectivity_auth_health'],
        }),
      ).toMatchObject({
        allowed: false,
        reason: 'missing_health_gate',
        tier: 'enabled_with_health_gates_satisfied',
      });

      expect(
        evaluateExecutionCapability({
          capability,
          useContext: capability === 'cancel_replace' ? 'cancel_replace' : 'live_order_submit',
          sessionMode: 'live',
          scopingSurface: 'account',
          healthGates: ALL_HEALTH_GATES,
        }),
      ).toMatchObject({ allowed: true, reason: 'allowed' });
    }
  });

  it('enforces paper/live caller context consistency', () => {
    expect(
      evaluateExecutionCapability({
        capability: 'submit',
        useContext: 'live_order_submit',
        sessionMode: 'paper',
        scopingSurface: 'account',
      }),
    ).toMatchObject({ allowed: false, reason: 'wrong_session_mode' });

    expect(
      evaluateExecutionCapability({
        capability: 'submit',
        useContext: 'paper_order_submit',
        sessionMode: 'live',
        scopingSurface: 'account',
        healthGates: ALL_HEALTH_GATES,
      }),
    ).toMatchObject({ allowed: false, reason: 'wrong_session_mode' });
  });

  it('supports boolean and assert wrappers', () => {
    const allowedInput = {
      capability: 'submit',
      useContext: 'paper_order_submit',
      sessionMode: 'paper',
      scopingSurface: 'account',
    } as const;
    const blockedInput = {
      capability: 'submit',
      useContext: 'live_order_submit',
      sessionMode: 'live',
      scopingSurface: 'account',
    } as const;

    expect(isExecutionCapabilityAllowed(allowedInput)).toBe(true);
    expect(() => assertExecutionCapabilityAllowed(allowedInput)).not.toThrow();
    expect(isExecutionCapabilityAllowed(blockedInput)).toBe(false);
    expect(() => assertExecutionCapabilityAllowed(blockedInput)).toThrow(
      'Execution capability submit is not allowed for live/live_order_submit/account: missing_health_gate',
    );
  });
});
