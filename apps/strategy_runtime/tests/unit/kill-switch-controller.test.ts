import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ns } from '../../src/contracts/index.js';
import {
  KILL_SWITCH_DISENGAGE_TOKEN_TTL_MS,
  KillSwitchController,
  type KillSwitchControllerEvent,
} from '../../src/execution/kill-switch/kill-switch-controller.js';
import { SubmissionGate } from '../../src/execution/order-lifecycle-state-machine.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('KillSwitchController', () => {
  it('engages and blocks the SubmissionGate until a valid 60s token is committed', () => {
    let nowMs = 1_000;
    const gate = new SubmissionGate();
    const events: KillSwitchControllerEvent[] = [];
    const controller = new KillSwitchController({
      submission_gate: gate,
      now_ms: () => nowMs,
      now_ns: () => ns(BigInt(nowMs) * 1_000_000n),
      token_factory: ({ sequence }) => `token-${sequence}`,
      emit: (event) => events.push(event),
    });

    controller.engage({ reason: 'operator_test', source: 'test' });
    expect(controller.isEngaged()).toBe(true);
    expect(gate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
    expect(events[0]).toMatchObject({
      type: 'KILL_SWITCH_ENGAGED',
      payload: {
        persistence_enabled: false,
      },
    });

    const token = controller.prepareDisengage({ reason: 'safe', requested_by: 'operator' });
    expect(token).toEqual({
      token: 'token-1',
      expires_at_ms: 1_000 + KILL_SWITCH_DISENGAGE_TOKEN_TTL_MS,
    });
    nowMs += KILL_SWITCH_DISENGAGE_TOKEN_TTL_MS;
    controller.commitDisengage({ token: token.token, reason: 'safe' });

    expect(controller.isEngaged()).toBe(false);
    expect(gate.acquire()).toEqual({ allowed: true });
    expect(events.at(-1)).toMatchObject({
      type: 'KILL_SWITCH_DISENGAGED',
      payload: {
        state: 'disengaged',
        token_id: 'token-1',
      },
    });
  });

  it('rejects expired tokens and preserves the gate block', () => {
    let nowMs = 10;
    const gate = new SubmissionGate();
    const controller = new KillSwitchController({
      submission_gate: gate,
      now_ms: () => nowMs,
      token_factory: () => 'expired-token',
    });
    controller.engage({ reason: 'fixture' });
    const token = controller.prepareDisengage();

    nowMs = token.expires_at_ms + 1;
    expect(() => controller.commitDisengage({ token: token.token })).toThrow('expired');
    expect(gate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
  });

  it('atomically persists engaged state and re-engages on restart when enabled only', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qfa-kill-switch-'));
    tempDirectories.push(directory);
    const path = join(directory, 'kill-switch.json');
    const firstGate = new SubmissionGate();
    const first = new KillSwitchController({
      submission_gate: firstGate,
      persistence: { enabled: true, path },
    });
    first.engage({ reason: 'persisted', source: 'test' });

    const secondGate = new SubmissionGate();
    const events: KillSwitchControllerEvent[] = [];
    const second = new KillSwitchController({
      submission_gate: secondGate,
      persistence: { enabled: true, path },
      emit: (event) => events.push(event),
    });

    expect(second.isEngaged()).toBe(true);
    expect(secondGate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
    expect(events[0]).toMatchObject({
      type: 'KILL_SWITCH_ENGAGED',
      payload: {
        restart_reengage: true,
        persistence_enabled: true,
      },
    });
  });
});
