import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ns, type JournalEventPayloadFor, type UnixNs } from '../../contracts/index.js';
import type { SubmissionGate } from '../order-lifecycle-state-machine.js';

export const KILL_SWITCH_DISENGAGE_TOKEN_TTL_MS = 60_000;

export interface KillSwitchPersistenceOptions {
  readonly enabled?: boolean;
  readonly path?: string;
}

export interface KillSwitchControllerOptions {
  readonly submission_gate: Pick<SubmissionGate, 'requestBlock' | 'releaseBlock'>;
  readonly persistence?: KillSwitchPersistenceOptions;
  readonly emit?: (event: KillSwitchControllerEvent) => void;
  readonly now_ms?: () => number;
  readonly now_ns?: () => UnixNs;
  readonly token_ttl_ms?: number;
  readonly token_factory?: (input: {
    readonly sequence: number;
    readonly now_ms: number;
  }) => string;
}

export interface KillSwitchEngageInput {
  readonly reason: string;
  readonly source?: string;
}

export interface KillSwitchPrepareDisengageInput {
  readonly reason?: string;
  readonly requested_by?: string;
}

export interface KillSwitchDisengageToken {
  readonly token: string;
  readonly expires_at_ms: number;
}

export interface KillSwitchCommitDisengageInput {
  readonly token: string;
  readonly reason?: string;
  readonly source?: string;
}

export interface KillSwitchState {
  readonly engaged: boolean;
  readonly reason?: string;
  readonly source?: string;
  readonly engaged_at_ms?: number;
  readonly pending_disengage_token?: {
    readonly token: string;
    readonly expires_at_ms: number;
    readonly reason?: string;
    readonly requested_by?: string;
  };
}

export type KillSwitchControllerEvent =
  | {
      readonly type: 'KILL_SWITCH_ENGAGED';
      readonly ts_ns: UnixNs;
      readonly payload: JournalEventPayloadFor<'KILL_SWITCH_ENGAGED'>;
    }
  | {
      readonly type: 'KILL_SWITCH_DISENGAGED';
      readonly ts_ns: UnixNs;
      readonly payload: JournalEventPayloadFor<'KILL_SWITCH_DISENGAGED'>;
    };

interface PersistedKillSwitchState {
  readonly schema_version: 1;
  readonly engaged: boolean;
  readonly reason?: string;
  readonly source?: string;
  readonly engaged_at_ms?: number;
}

export class KillSwitchController {
  private readonly submissionGate: Pick<SubmissionGate, 'requestBlock' | 'releaseBlock'>;
  private readonly persistence: Required<KillSwitchPersistenceOptions>;
  private readonly emitEvent: (event: KillSwitchControllerEvent) => void;
  private readonly nowMs: () => number;
  private readonly nowNs: () => UnixNs;
  private readonly tokenTtlMs: number;
  private readonly tokenFactory: (input: { readonly sequence: number; readonly now_ms: number }) => string;
  private state: KillSwitchState = { engaged: false };
  private tokenSequence = 0;

  constructor(options: KillSwitchControllerOptions) {
    this.submissionGate = options.submission_gate;
    this.persistence = {
      enabled: options.persistence?.enabled === true,
      path: options.persistence?.path ?? '',
    };
    this.emitEvent = options.emit ?? (() => undefined);
    this.nowMs = options.now_ms ?? (() => Date.now());
    this.nowNs = options.now_ns ?? (() => ns(BigInt(this.nowMs()) * 1_000_000n));
    this.tokenTtlMs = options.token_ttl_ms ?? KILL_SWITCH_DISENGAGE_TOKEN_TTL_MS;
    this.tokenFactory =
      options.token_factory ??
      ((input) => `kill-switch-disengage-${input.now_ms}-${input.sequence}`);

    this.restorePersistedState();
  }

  engage(input: KillSwitchEngageInput): KillSwitchState {
    const nowMs = this.nowMs();
    this.state = {
      engaged: true,
      reason: input.reason,
      source: input.source ?? 'operator',
      engaged_at_ms: nowMs,
    };
    this.submissionGate.requestBlock('kill_switch');
    this.persist();
    this.emitEngaged(false);
    return this.getState();
  }

  prepareDisengage(input: KillSwitchPrepareDisengageInput = {}): KillSwitchDisengageToken {
    if (!this.state.engaged) {
      throw new Error('kill switch is not engaged');
    }
    this.tokenSequence += 1;
    const nowMs = this.nowMs();
    const token = this.tokenFactory({ sequence: this.tokenSequence, now_ms: nowMs });
    const prepared = {
      token,
      expires_at_ms: nowMs + this.tokenTtlMs,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.requested_by === undefined ? {} : { requested_by: input.requested_by }),
    };
    this.state = {
      ...this.state,
      pending_disengage_token: prepared,
    };
    return {
      token,
      expires_at_ms: prepared.expires_at_ms,
    };
  }

  commitDisengage(input: KillSwitchCommitDisengageInput): KillSwitchState {
    if (!this.state.engaged) {
      throw new Error('kill switch is not engaged');
    }
    const pending = this.state.pending_disengage_token;
    if (pending === undefined || pending.token !== input.token) {
      throw new Error('kill switch disengage token is invalid');
    }
    if (this.nowMs() > pending.expires_at_ms) {
      throw new Error('kill switch disengage token expired');
    }

    this.state = { engaged: false };
    this.submissionGate.releaseBlock('kill_switch');
    this.persist();
    const tsNs = this.nowNs();
    this.emitEvent({
      type: 'KILL_SWITCH_DISENGAGED',
      ts_ns: tsNs,
      payload: {
        state: 'disengaged',
        reason: input.reason ?? pending.reason ?? 'operator_disengage',
        source: input.source ?? pending.requested_by ?? 'operator',
        disengaged_at_ts_ns: tsNs,
        token_id: pending.token,
        persistence_enabled: this.persistence.enabled,
      },
    });
    return this.getState();
  }

  isEngaged(): boolean {
    return this.state.engaged;
  }

  getState(): KillSwitchState {
    return {
      ...this.state,
      ...(this.state.pending_disengage_token === undefined
        ? {}
        : { pending_disengage_token: { ...this.state.pending_disengage_token } }),
    };
  }

  private restorePersistedState(): void {
    if (!this.persistence.enabled) {
      return;
    }
    if (this.persistence.path.trim() === '') {
      throw new Error('kill switch persistence path is required when persistence is enabled');
    }
    if (!existsSync(this.persistence.path)) {
      return;
    }
    const persisted = JSON.parse(readFileSync(this.persistence.path, 'utf8')) as Partial<PersistedKillSwitchState>;
    if (persisted.schema_version !== 1 || persisted.engaged !== true) {
      return;
    }
    this.state = {
      engaged: true,
      ...(persisted.reason === undefined ? {} : { reason: persisted.reason }),
      source: persisted.source ?? 'persisted_restart',
      ...(persisted.engaged_at_ms === undefined ? {} : { engaged_at_ms: persisted.engaged_at_ms }),
    };
    this.submissionGate.requestBlock('kill_switch');
    this.emitEngaged(true);
  }

  private emitEngaged(restartReengage: boolean): void {
    const tsNs = this.nowNs();
    this.emitEvent({
      type: 'KILL_SWITCH_ENGAGED',
      ts_ns: tsNs,
      payload: {
        state: 'engaged',
        reason: this.state.reason ?? 'unspecified',
        source: this.state.source ?? 'operator',
        engaged_at_ts_ns: tsNs,
        persistence_enabled: this.persistence.enabled,
        restart_reengage: restartReengage,
      },
    });
  }

  private persist(): void {
    if (!this.persistence.enabled) {
      return;
    }
    const payload: PersistedKillSwitchState = {
      schema_version: 1,
      engaged: this.state.engaged,
      ...(this.state.reason === undefined ? {} : { reason: this.state.reason }),
      ...(this.state.source === undefined ? {} : { source: this.state.source }),
      ...(this.state.engaged_at_ms === undefined ? {} : { engaged_at_ms: this.state.engaged_at_ms }),
    };
    mkdirSync(dirname(this.persistence.path), { recursive: true });
    const tempPath = `${this.persistence.path}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tempPath, this.persistence.path);
  }
}
