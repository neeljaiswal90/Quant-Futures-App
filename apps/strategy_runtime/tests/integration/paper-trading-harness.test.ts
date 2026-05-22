import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  type AnyJournalEventEnvelope,
  type JournalEventPayloadFor,
} from '../../src/contracts/index.js';
import { validateJournalEventEnvelope } from '../../src/contracts/events/schema.js';
import {
  createPaperCredentialResolver,
  loadPaperSessionConfigFile,
  PaperTradingSession,
  resolvePaperTradingSessionConfig,
  RITHMIC_LIVE_TICKER_PLANT_CREDENTIAL_DESCRIPTORS,
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
    shutdown_quarantine_timeout_ms: 0,
  },
} satisfies Partial<PaperTradingSessionOptions>;

describe('QFA-614 paper trading harness', () => {
  it('loads the committed paper YAML into runner config', () => {
    const raw = loadPaperSessionConfigFile();
    const config = resolvePaperTradingSessionConfig({ env: {} });

    expect(raw).toMatchObject({
      session: {
        strategy_id: 'regime_shock_reversion_short_v2',
        adapter_kind: 'mock',
      },
    });
    expect(config).toMatchObject({
      strategy_id: 'regime_shock_reversion_short_v2',
      app_config_path: 'config/app.example.json',
      journal_dir: 'journals/paper',
      adapter_kind: 'mock',
      market_data_source: 'simulation',
      capability_mask_version: 1,
      reconnect_policy: {
        max_attempts: 3,
        initial_delay_ms: 250,
        max_delay_ms: 2_000,
        retry_budget_ms: 10_000,
        jitter: 'seeded',
      },
      metrics_endpoint: {
        enabled: true,
        port: 9_469,
      },
      slo_budgets_source: 'qfa-627-provisional-registry',
      shutdown_quarantine_timeout_ms: 30_000,
    });
  });

  it('honors QFA_PAPER_SESSION_CONFIG override used by the CLI entrypoint', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qfa-614-paper-'));
    const configPath = join(tempDir, 'paper.yaml');
    writeFileSync(configPath, [
      'session:',
      '  strategy_id: regime_shock_reversion_short_v2',
      '  mode: paper',
      '  adapter_kind: mock',
      '  app_config_path: config/app.example.json',
      '  journal_dir: journals/custom-paper',
      'execution:',
      '  plant_scope: ORDER_PLANT',
      '  capability_mask_id: execution-capability-mask-v1-adr0018-paper-only-order-plant',
      '  capability_mask_version: 1',
      '  reconnect_policy:',
      '    max_attempts: 5',
      '    initial_delay_ms: 100',
      '    max_delay_ms: 5000',
      '    retry_budget_ms: 12000',
      '    jitter: seeded',
      '  shutdown_quarantine_timeout_ms: 1234',
      'observability:',
      '  metrics:',
      '    enabled: false',
      '    host: 127.0.0.1',
      '    port: 9555',
      '  slo_budgets_source: qfa-627-provisional-registry',
      '  slo_budget_overrides: {}',
      '',
    ].join('\n'));

    const config = resolvePaperTradingSessionConfig({
      env: {
        QFA_PAPER_SESSION_CONFIG: configPath,
      },
    });

    expect(config).toMatchObject({
      paper_session_config_path: configPath,
      journal_dir: 'journals/custom-paper',
      metrics_endpoint: {
        enabled: false,
        port: 9_555,
      },
      reconnect_policy: {
        max_attempts: 5,
        initial_delay_ms: 100,
        max_delay_ms: 5_000,
        retry_budget_ms: 12_000,
      },
      shutdown_quarantine_timeout_ms: 1_234,
    });
  });

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
    const closingManifest = session.events
      .filter((event) => event.type === 'SESSION_MANIFEST')
      .at(-1);
    expect(validateJournalEventEnvelope(closingManifest).issues).toEqual([]);
    expect(closingManifest).toMatchObject({
      payload: {
        session_phase: 'closing',
        final_quarantine_count: 0,
        intents_emitted_total: 0,
        acks_received_total: 0,
        would_halt_emissions_total: 0,
      },
    });
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

  it('waits for in-flight quarantine to drain before stop completes', async () => {
    vi.useFakeTimers();
    try {
      const gate = new SubmissionGate();
      const intentId = makeEventId('qfa-614-drain-before-stop');
      const session = new PaperTradingSession({
        ...BASE_OPTIONS,
        config: {
          ...BASE_OPTIONS.config,
          shutdown_quarantine_timeout_ms: 50,
        },
        submission_gate: gate,
      });
      await session.start();
      gate.blockFromQuarantine({ intent_id: intentId, reason: 'submission_ack_timeout' });

      let stopped = false;
      const stopPromise = session.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      expect(stopped).toBe(false);

      gate.unblockFromQuarantine({ intent_id: intentId, reason: 'submission_ack_timeout' });
      await vi.advanceTimersByTimeAsync(25);
      await stopPromise;

      expect(stopped).toBe(true);
      expect(session.getDiagnostics()).toMatchObject({
        stopped: true,
        open_quarantine_count: 0,
      });
      expect(session.events.filter((event) => event.type === 'ORDER_QUARANTINE_ENTERED')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits shutdown escalation when quarantine does not drain before the bounded timeout', async () => {
    vi.useFakeTimers();
    try {
      const gate = new SubmissionGate();
      const intentId = makeEventId('qfa-614-drain-timeout');
      const session = new PaperTradingSession({
        ...BASE_OPTIONS,
        config: {
          ...BASE_OPTIONS.config,
          shutdown_quarantine_timeout_ms: 5,
        },
        submission_gate: gate,
      });
      await session.start();
      gate.blockFromQuarantine({ intent_id: intentId, reason: 'submission_ack_timeout' });

      const stopPromise = session.stop();
      await vi.advanceTimersByTimeAsync(5);
      await stopPromise;

      expect(session.events.find((event) => event.type === 'ORDER_QUARANTINE_ENTERED')).toMatchObject({
        payload: {
          intent_id: 'paper-shutdown-unresolved-quarantine',
          open_quarantine_count: 1,
          escalation_required: true,
          is_provisional: true,
        },
      });
      expect(session.events.filter((event) => event.type === 'SESSION_MANIFEST').at(-1)).toMatchObject({
        payload: {
          session_phase: 'closing',
          final_quarantine_count: 1,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('attaches reconnect runner so disconnect blocks gate, emits attempt, then releases on success', async () => {
    vi.useFakeTimers();
    try {
      const gate = new SubmissionGate();
      const adapter = new ReconnectHarnessAdapter({ reconnect_start_delay_ms: 25 });
      const session = new PaperTradingSession({
        ...BASE_OPTIONS,
        broker_adapter: adapter,
        submission_gate: gate,
      });
      await session.start();

      adapter.emitDisconnect();
      await Promise.resolve();

      expect(gate.acquire()).toMatchObject({
        allowed: false,
        reason: 'reconnect_in_progress_active',
      });
      expect(session.events.find((event) =>
        event.type === 'RECONNECT_STATE' &&
        (event.payload as JournalEventPayloadFor<'RECONNECT_STATE'>).phase === 'attempt' &&
        (event.payload as JournalEventPayloadFor<'RECONNECT_STATE'>).attempt === 1,
      )).toBeDefined();

      await session.processFeatureSnapshot(
        STRATEGY_SYNTHETIC_FIXTURES.vwap_overnight_reversal_long.snapshot,
      );
      expect(adapter.submitted_intent_count).toBe(0);

      await vi.advanceTimersByTimeAsync(25);
      await session.drain();

      expect(gate.acquire()).toEqual({ allowed: true });
      expect(session.events.find((event) =>
        event.type === 'SESSION_MANIFEST' &&
        (event.payload as JournalEventPayloadFor<'SESSION_MANIFEST'>).session_phase ===
          'reconnect_success',
      )).toBeDefined();

      await session.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps reconnect gate blocked after five failed reconnect attempts and emits exhausted manifest', async () => {
    vi.useFakeTimers();
    try {
      const gate = new SubmissionGate();
      const adapter = new ReconnectHarnessAdapter({ reconnect_failures_before_success: 5 });
      const session = new PaperTradingSession({
        ...BASE_OPTIONS,
        broker_adapter: adapter,
        submission_gate: gate,
      });
      await session.start();

      adapter.emitDisconnect();
      await vi.advanceTimersByTimeAsync(120_000);
      await session.drain();

      expect(session.events.find((event) =>
        event.type === 'RECONNECT_STATE' &&
        (event.payload as JournalEventPayloadFor<'RECONNECT_STATE'>).phase === 'exhausted',
      )).toBeDefined();
      expect(session.events.find((event) =>
        event.type === 'SESSION_MANIFEST' &&
        (event.payload as JournalEventPayloadFor<'SESSION_MANIFEST'>).session_phase ===
          'reconnect_exhausted',
      )).toBeDefined();
      expect(gate.acquire()).toMatchObject({
        allowed: false,
        reason: 'reconnect_in_progress_active',
      });

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

  it('parses live Rithmic ticker source from env override', () => {
    const config = resolvePaperTradingSessionConfig({
      env: {
        QFA_PAPER_MARKET_DATA_SOURCE: 'live_rithmic_ticker_plant',
      },
    });

    expect(config.market_data_source).toBe('live_rithmic_ticker_plant');
    expect(config.adapter_kind).toBe('mock');
  });

  it('registers only TICKER_PLANT descriptors when live ticker source is enabled', async () => {
    const resolver = createPaperCredentialResolver({
      market_data_source: 'live_rithmic_ticker_plant',
      env: {
        RITHMIC_USER: 'live-user',
        RITHMIC_PASSWORD: 'live-password',
        RITHMIC_CONNECT_POINT: 'wss://live-ticker.example',
        RITHMIC_SYSTEM_NAME: 'Rithmic Live',
        RITHMIC_TEST_USERNAME: 'should-not-resolve',
      },
    });

    await expect(
      resolver.resolveForPlant?.('rithmic.live_ticker_plant.username', 'TICKER_PLANT'),
    ).resolves.toMatchObject({
      key: 'rithmic.live_ticker_plant.username',
      value: 'live-user',
    });
    await expect(
      resolver.resolveForPlant?.('rithmic.live_ticker_plant.username', 'ORDER_PLANT'),
    ).rejects.toThrow('not ORDER_PLANT');
    await expect(resolver.resolve('rithmic.order_plant.username')).rejects.toThrow(
      'unregistered credential key',
    );
    expect(RITHMIC_LIVE_TICKER_PLANT_CREDENTIAL_DESCRIPTORS.every(
      (descriptor) => descriptor.plant_scope === 'TICKER_PLANT',
    )).toBe(true);
  });

  it('emits paper-mode mock-adapter manifest in live ticker shadow mode', async () => {
    const ticker = new StubLiveTickerSubscriber();
    const session = new PaperTradingSession({
      ...BASE_OPTIONS,
      config: {
        ...BASE_OPTIONS.config,
        market_data_source: 'live_rithmic_ticker_plant',
        adapter_kind: 'mock',
      },
      live_ticker_subscriber: ticker,
    });

    await session.start();
    await session.stop();

    expect(ticker.started).toBe(true);
    expect(ticker.stopped).toBe(true);
    const manifest = session.events.find((event) => event.type === 'SESSION_MANIFEST');
    expect(manifest).toMatchObject({
      payload: {
        mode: 'paper',
        adapter_kind: 'MOCK_ORDER_PLANT',
        market_data_source: 'live_rithmic_ticker_plant',
      },
    });
    expect(session.getDiagnostics()).toMatchObject({
      adapter_kind: 'mock',
      market_data_source: 'live_rithmic_ticker_plant',
    });
  });

  it('rejects real adapter construction in live ticker shadow mode', () => {
    expect(() => new PaperTradingSession({
      config: {
        ...BASE_OPTIONS.config,
        market_data_source: 'live_rithmic_ticker_plant',
        adapter_kind: 'rithmic',
      },
    })).toThrow('shadow mode requires QFA_BROKER_ADAPTER_KIND=mock');
  });
});

class StubLiveTickerSubscriber {
  started = false;
  stopped = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

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

class ReconnectHarnessAdapter implements BrokerAdapter {
  readonly plant_scope: PlantScope = 'ORDER_PLANT';
  readonly mode: RuntimeMode = 'paper';
  private readonly sessionHandlers = new Set<(event: BrokerSessionEvent) => void>();
  private readonly reconnectStartDelayMs: number;
  private reconnectFailuresRemaining: number;
  private running = false;
  private startCount = 0;
  private submittedIntentCount = 0;

  constructor(options: {
    readonly reconnect_start_delay_ms?: number;
    readonly reconnect_failures_before_success?: number;
  } = {}) {
    this.reconnectStartDelayMs = options.reconnect_start_delay_ms ?? 0;
    this.reconnectFailuresRemaining = options.reconnect_failures_before_success ?? 0;
  }

  async start(): Promise<void> {
    this.startCount += 1;
    if (this.startCount > 1 && this.reconnectFailuresRemaining > 0) {
      this.reconnectFailuresRemaining -= 1;
      throw new Error('fixture reconnect failure');
    }
    if (this.startCount > 1 && this.reconnectStartDelayMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.reconnectStartDelayMs);
        timer.unref?.();
      });
    }
    this.running = true;
    this.emitSessionManifest();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async submitIntent(
    _intent: OrderIntentEventEnvelope,
  ): Promise<{ readonly accepted: boolean; readonly broker_intent_correlation_id: string }> {
    this.submittedIntentCount += 1;
    return { accepted: this.running, broker_intent_correlation_id: 'reconnect-harness-correlation' };
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

  emitDisconnect(): void {
    this.running = false;
    this.emitSession({
      type: 'RECONNECT_STATE',
      ts_ns: ns(1_800_000_000_000_000_000n + BigInt(this.startCount) * 1_000_000n),
      payload: {
        previous_state: 'CONNECTED',
        state: 'DISCONNECTED',
        phase: 'disconnect',
        attempt: 0,
        max_attempts: 5,
        retry_budget_config: { max_attempts: 5 },
        reason: 'fixture_disconnect',
        blocked_submission_gate: true,
      },
    });
  }

  get submitted_intent_count(): number {
    return this.submittedIntentCount;
  }

  private emitSessionManifest(): void {
    const mask = buildExecutionCapabilityMask();
    this.emitSession({
      type: 'SESSION_MANIFEST',
      ts_ns: ns(1_800_000_000_000_000_000n + BigInt(this.startCount) * 1_000_000n),
      payload: {
        mask_id: mask.mask_id,
        mask_version: mask.mask_version,
        mask_hash: mask.mask_hash,
        reconnect_policy_config: {
          max_attempts: 5,
          initial_delay_ms: 1_000,
          max_delay_ms: 30_000,
          retry_budget_ms: 91_000,
          jitter: 'seeded',
        },
        plant_scope: 'ORDER_PLANT',
        mode: 'paper',
        timestamp_anchor: 'broker_exchange_ts_ns',
        broker_session_id: `reconnect-harness-session-${this.startCount}`,
        adapter_kind: 'MOCK_ORDER_PLANT',
      },
    });
  }

  private emitSession(event: BrokerSessionEvent): void {
    for (const handler of this.sessionHandlers) {
      handler(event);
    }
  }
}
