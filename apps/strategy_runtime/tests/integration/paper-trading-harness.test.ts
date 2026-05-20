import { describe, expect, it, vi } from 'vitest';
import {
  makeRunId,
  makeSessionId,
  ns,
  type AnyJournalEventEnvelope,
  type JournalEventPayloadFor,
} from '../../src/contracts/index.js';
import {
  PaperTradingSession,
  type PaperTradingSessionOptions,
} from '../../src/paper-trading/index.js';
import {
  MockOrderPlantAdapter,
  SubmissionGate,
  type BrokerAdapter,
  type BrokerAckEnvelope,
  type BrokerSessionEvent,
  type OrderIntentEventEnvelope,
  type PlantScope,
  type RuntimeMode,
  type Unsubscribe,
} from '../../src/execution/index.js';
import { buildExecutionCapabilityMask } from '../../src/execution/execution-capability-mask.js';
import { SessionManifestValidator } from '../../src/execution/validators/session-manifest.js';
import { BurnRateEvaluator } from '../../src/observability/burn-rate-evaluator.js';
import type { SloDefinition } from '../../src/observability/slo-registry.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const RUN_ID = makeRunId('run-qfa-614-paper');
const SESSION_ID = makeSessionId('session-qfa-614-paper');
const BASE_OPTIONS = {
  config: {
    run_id: RUN_ID,
    session_id: SESSION_ID,
    metrics_endpoint: { enabled: false, port: 0 },
    journal_dir: 'journals/test-qfa-614',
  },
} satisfies Partial<PaperTradingSessionOptions>;

describe('QFA-614 paper trading harness', () => {
  it('starts a mock paper session and emits an EXEC-VALIDATOR-06-valid manifest', async () => {
    const session = new PaperTradingSession(BASE_OPTIONS);
    await session.start();

    const manifest = session.events.find((event) => event.type === 'SESSION_MANIFEST');
    expect(manifest).toMatchObject({
      payload: {
        plant_scope: 'ORDER_PLANT',
        mode: 'paper',
        adapter_kind: 'MOCK_ORDER_PLANT',
      },
    });
    expect(
      new SessionManifestValidator().runOnSessionStart({
        session_manifest: manifest?.payload as unknown as Readonly<Record<string, unknown>>,
      }),
    ).toEqual([]);

    await session.stop();
    expect(session.getDiagnostics()).toMatchObject({
      stopped: true,
      adapter_kind: 'mock',
    });
  });

  it('wires strategy ORDER_INTENT through the broker adapter and records ACK + POSITION surfaces', async () => {
    vi.useFakeTimers();
    try {
      const session = new PaperTradingSession(BASE_OPTIONS);
      await session.start();

      const result = await session.processFeatureSnapshot(
        STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot,
      );
      await vi.advanceTimersByTimeAsync(0);
      await session.drain();

      expect(result.order_intent_events).toHaveLength(1);
      expect(result.position_events).toHaveLength(1);
      expect(session.events.map((event) => event.type)).toContain('ORDER_ACK_SUBMISSION');
      expect(session.events.map((event) => event.type)).toContain('ORDER_ACK_FILL');
      expect(session.getDiagnostics().event_counts_by_type.ORDER_ACK_SUBMISSION).toBe(1);

      await session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits WOULD_HALT on a paper-mode SLO breach without blocking submissions', async () => {
    const sloDefinitions: readonly SloDefinition[] = [
      {
        metric_name: 'qfa_order_ack_submission_ms',
        windows: [
          {
            window_id: '1s',
            window_duration_ms: 1_000,
            sample_count_floor: 1,
            p95_budget_ms: 10,
          },
        ],
        is_provisional: true,
        breach_eligibility: 'eligible',
      },
    ];
    let nowMs = 0;
    const controlled = new PaperTradingSession({
      ...BASE_OPTIONS,
      slo_definitions: sloDefinitions,
      burn_rate_evaluator: new BurnRateEvaluator({
        definitions: sloDefinitions,
        now_ms: () => nowMs,
        now_ns: () => ns(BigInt(nowMs) * 1_000_000n + 1_700_000_000_000_000_000n),
      }),
    });
    await controlled.start();

    controlled.observeSloSample('qfa_order_ack_submission_ms', 5, nowMs);
    controlled.evaluateSlo();
    nowMs = 1;
    controlled.observeSloSample('qfa_order_ack_submission_ms', 20, nowMs);
    controlled.evaluateSlo();
    await controlled.drain();

    expect(controlled.events.find((event) => event.type === 'WOULD_HALT')).toMatchObject({
      payload: {
        state: 'halted',
        reason: 'slo_breach:qfa_order_ack_submission_ms',
      },
    });
    expect(controlled.getDiagnostics().active_submission_block_sources).toEqual([]);
    await controlled.stop();
  });

  it('blocks new submissions while a broker ACK timeout quarantine is active', async () => {
    vi.useFakeTimers();
    try {
      const gate = new SubmissionGate();
      const session = new PaperTradingSession({
        ...BASE_OPTIONS,
        broker_adapter: new SilentAcceptingAdapter(),
        submission_gate: gate,
        ack_timeout_policy: { enabled: true, submission_ack_timeout_ms: 5 },
      });
      await session.start();
      await session.processFeatureSnapshot(
        STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot,
      );
      await vi.advanceTimersByTimeAsync(5);
      await session.drain();

      expect(session.events.find((event) => event.type === 'ORDER_QUARANTINE_ENTERED')).toMatchObject({
        payload: {
          quarantine_reason: 'submission_ack_timeout',
          timeout_ms: 5,
        },
      });
      expect(gate.acquire()).toMatchObject({ allowed: false, reason: 'quarantine_active' });

      await session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when selecting the future real Rithmic adapter before QFA-612-PAPER-01b', async () => {
    const session = new PaperTradingSession({
      config: {
        ...BASE_OPTIONS.config,
        adapter_kind: 'rithmic',
      },
    });
    await expect(session.start()).rejects.toThrow('QFA-612-PAPER-01b not yet merged');
  });
});

class SilentAcceptingAdapter implements BrokerAdapter {
  readonly plant_scope: PlantScope = 'ORDER_PLANT';
  readonly mode: RuntimeMode = 'paper';
  private readonly sessionHandlers = new Set<(event: BrokerSessionEvent) => void>();

  async start(): Promise<void> {
    const mask = buildExecutionCapabilityMask();
    this.sessionHandlers.forEach((handler) => handler({
      type: 'SESSION_MANIFEST',
      ts_ns: ns(1_800_000_000_000_000_000n),
      payload: {
        mask_id: mask.mask_id,
        mask_version: mask.mask_version,
        mask_hash: mask.mask_hash,
        reconnect_policy_config: {
          max_attempts: 3,
          initial_delay_ms: 250,
          max_delay_ms: 2_000,
          retry_budget_ms: 10_000,
          jitter: 'seeded',
        },
        plant_scope: 'ORDER_PLANT',
        mode: 'paper',
        timestamp_anchor: 'broker_exchange_ts_ns',
        broker_session_id: 'silent-paper-session',
        adapter_kind: 'MOCK_ORDER_PLANT',
      },
    }));
  }

  async stop(): Promise<void> {}

  async submitIntent(
    _intent: OrderIntentEventEnvelope,
  ): Promise<{ readonly accepted: boolean; readonly broker_intent_correlation_id: string }> {
    return { accepted: true, broker_intent_correlation_id: 'silent-paper-correlation' };
  }

  async requestCancel(): Promise<{ readonly accepted: boolean }> {
    return { accepted: false };
  }

  subscribeAckEvents(_handler: (event: BrokerAckEnvelope) => void): Unsubscribe {
    return () => undefined;
  }

  subscribeSessionEvents(handler: (event: BrokerSessionEvent) => void): Unsubscribe {
    this.sessionHandlers.add(handler);
    return () => {
      this.sessionHandlers.delete(handler);
    };
  }
}
