import type { HaltEventPayload } from '../contracts/events/payloads.js';
import type { SubmissionGate } from '../execution/order-lifecycle-state-machine.js';
import type { SloStateTransition } from './burn-rate-evaluator.js';
import type { SloDefinition } from './slo-registry.js';

export type RuntimeMode = 'paper' | 'live';
export type SloHaltEventType = 'HALT' | 'WOULD_HALT';

export interface SloHaltEmittedEvent {
  readonly type: SloHaltEventType;
  readonly metric_name: string;
  readonly payload: HaltEventPayload;
  readonly transition: SloStateTransition;
  readonly flipped_gate: boolean;
}

export interface SloHaltEmitterOptions {
  readonly slo_definitions: readonly SloDefinition[];
  readonly runtime_mode_reader?: () => RuntimeMode;
  readonly submission_gate?: Pick<SubmissionGate, 'requestBlock' | 'releaseBlock'>;
  readonly emit?: (event: SloHaltEmittedEvent) => void;
}

interface ActiveEmission {
  readonly type: SloHaltEventType;
  readonly flipped_gate: boolean;
}

const SAFE_UNKNOWN_DEFINITION: Pick<SloDefinition, 'is_provisional' | 'breach_eligibility'> = {
  is_provisional: true,
  breach_eligibility: 'not_applicable_until_phase_6_ack',
};

export class SloHaltEmitter {
  private readonly definitions: ReadonlyMap<string, SloDefinition>;
  private readonly runtimeModeReader: () => RuntimeMode;
  private readonly submissionGate?: Pick<SubmissionGate, 'requestBlock' | 'releaseBlock'>;
  private readonly emitHandler?: (event: SloHaltEmittedEvent) => void;
  private readonly activeEmissionsByMetric = new Map<string, ActiveEmission>();

  constructor(options: SloHaltEmitterOptions) {
    this.definitions = new Map(options.slo_definitions.map((definition) => [definition.metric_name, definition]));
    this.runtimeModeReader = options.runtime_mode_reader ?? (() => 'paper');
    this.submissionGate = options.submission_gate;
    this.emitHandler = options.emit;
  }

  subscribe(evaluator: {
    subscribe(handler: (transitions: readonly SloStateTransition[]) => void): () => void;
  }): () => void {
    return evaluator.subscribe((transitions) => {
      this.onTransitions(transitions);
    });
  }

  onTransitions(transitions: readonly SloStateTransition[]): readonly SloHaltEmittedEvent[] {
    const emitted: SloHaltEmittedEvent[] = [];
    for (const transition of transitions) {
      const event = this.onTransition(transition);
      if (event !== undefined) {
        emitted.push(event);
        this.emitHandler?.(event);
      }
    }
    return emitted;
  }

  private onTransition(transition: SloStateTransition): SloHaltEmittedEvent | undefined {
    if (transition.from_state === 'pass' && transition.to_state === 'breach') {
      return this.emitBreach(transition);
    }
    if (transition.from_state === 'breach' && transition.to_state === 'pass') {
      return this.emitResolution(transition);
    }
    return undefined;
  }

  private emitBreach(transition: SloStateTransition): SloHaltEmittedEvent {
    const definition = this.definitionFor(transition.metric_name);
    const isProvisional = transition.is_provisional || definition.is_provisional;
    const runtimeMode = this.runtimeModeReader();
    const shouldLiveHalt = definition.breach_eligibility === 'eligible' && !isProvisional && runtimeMode === 'live';
    const eventType: SloHaltEventType = shouldLiveHalt ? 'HALT' : 'WOULD_HALT';
    const flippedGate = eventType === 'HALT';

    if (flippedGate) {
      this.submissionGate?.requestBlock('slo_halt');
    }

    this.activeEmissionsByMetric.set(transition.metric_name, {
      type: eventType,
      flipped_gate: flippedGate,
    });

    return {
      type: eventType,
      metric_name: transition.metric_name,
      payload: {
        state: 'halted',
        reason: `slo_breach:${transition.metric_name}`,
      },
      transition,
      flipped_gate: flippedGate,
    };
  }

  private emitResolution(transition: SloStateTransition): SloHaltEmittedEvent | undefined {
    const activeEmission = this.activeEmissionsByMetric.get(transition.metric_name);
    if (activeEmission === undefined) {
      return undefined;
    }

    this.activeEmissionsByMetric.delete(transition.metric_name);
    if (activeEmission.flipped_gate) {
      this.submissionGate?.releaseBlock('slo_halt');
    }

    return {
      type: activeEmission.type,
      metric_name: transition.metric_name,
      payload: {
        state: 'resumed',
        reason: `slo_resolved:${transition.metric_name}`,
        resolved: true,
      },
      transition,
      flipped_gate: activeEmission.flipped_gate,
    };
  }

  private definitionFor(metricName: string): Pick<SloDefinition, 'is_provisional' | 'breach_eligibility'> {
    return this.definitions.get(metricName) ?? SAFE_UNKNOWN_DEFINITION;
  }
}
