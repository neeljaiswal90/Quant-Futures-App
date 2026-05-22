import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  createJournalEventEnvelope,
  journalEventToJsonLine,
  makeCausationId,
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  type AnyJournalEventEnvelope,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
  type PaperMarketDataSource,
  type RunId,
  type SessionId,
  type UnixNs,
} from '../contracts/index.js';
import {
  LiveTickerSubscriber,
  LocalObsReplaySource,
  type LiveTickerSubscriberOptions,
  type LocalObsReplayPaceMode,
  type LocalObsReplaySourceOptions,
} from '../data/index.js';
import { loadAppConfig } from '../config/index.js';
import {
  BrokerAdapterRuntimeIntegration,
  AnomalyDetector,
  DualLivenessMonitor,
  KillSwitchController,
  MockOrderPlantAdapter,
  ReconnectRunner,
  SubmissionGate,
  createSimulatedExecutionAdapter,
  type AnomalyDetectorEvent,
  type BrokerAdapter,
  type BrokerCredentialLookup,
  type BrokerSessionEvent,
  type KillSwitchControllerEvent,
  type LivenessMonitorEvent,
  type ReconnectRunnerEvent,
} from '../execution/index.js';
import {
  resolveLiveAccountAllowlist,
  summarizeLiveAccountAllowlist,
  type LiveAccountAllowlist,
} from '../execution/brokers/account-allowlist.js';
import {
  PROVISIONAL_CANCEL_ACK_SLO,
  type OrderLifecycleStateMachine,
} from '../execution/order-lifecycle-state-machine.js';
import { buildExecutionCapabilityMask } from '../execution/execution-capability-mask.js';
import { SessionManifestValidator } from '../execution/validators/session-manifest.js';
import { loadVenueCostTable } from '../risk/index.js';
import {
  createStrategyRuntimeEngineContainer,
  StrategyRuntimeRunner,
  type RuntimeEventBusSubscription,
  type StrategyRuntimeEngineContainer,
} from '../orchestration/index.js';
import type { StrategyFeatureSnapshot } from '../strategies/index.js';
import {
  BoundedAckLatencyObserver,
  LatencySliRegistry,
  startLatencyMetricsEndpoint,
  type LatencyMetricsEndpoint,
  type LatencyMetricsEndpointConfig,
} from '../observability/latency-sli.js';
import { BurnRateEvaluator } from '../observability/burn-rate-evaluator.js';
import { SloHaltEmitter } from '../observability/slo-halt-emitter.js';
import {
  PROVISIONAL_LATENCY_SLO_DEFINITIONS,
  type SloDefinition,
} from '../observability/slo-registry.js';
import {
  CompositeCredentialResolver,
  EnvVarCredentialBackend,
  type CredentialDescriptor,
  type CredentialResolver,
  type CredentialResolutionEvent,
} from '../secrets/index.js';

export type PaperBrokerAdapterKind = 'mock' | 'rithmic';

export interface PaperReconnectPolicyConfig {
  readonly max_attempts: number;
  readonly initial_delay_ms: number;
  readonly max_delay_ms: number;
  readonly retry_budget_ms: number;
  readonly jitter: string;
}

export interface PaperTradingSessionConfig {
  readonly paper_session_config_path: string;
  readonly strategy_id: string;
  readonly app_config_path: string;
  readonly journal_dir: string;
  readonly adapter_kind: PaperBrokerAdapterKind;
  readonly market_data_source: PaperMarketDataSource;
  readonly local_obs_replay_path?: string;
  readonly local_obs_replay_pace_mode: LocalObsReplayPaceMode;
  readonly live_account_allowlist: LiveAccountAllowlist;
  readonly live_account_verification_enabled: boolean;
  readonly capability_mask_id: string;
  readonly capability_mask_version: number;
  readonly reconnect_policy: PaperReconnectPolicyConfig;
  readonly metrics_endpoint: LatencyMetricsEndpointConfig;
  readonly slo_budgets_source: string;
  readonly slo_budget_overrides: Readonly<Record<string, number>>;
  readonly run_id: RunId;
  readonly session_id: SessionId;
  readonly duration_ms?: number;
  readonly shutdown_quarantine_timeout_ms: number;
}

export interface PaperTradingSessionOptions {
  readonly config?: Partial<PaperTradingSessionConfig>;
  readonly env?: Record<string, string | undefined>;
  readonly container?: StrategyRuntimeEngineContainer;
  readonly broker_adapter?: BrokerAdapter;
  readonly submission_gate?: SubmissionGate;
  readonly latency_registry?: LatencySliRegistry;
  readonly burn_rate_evaluator?: BurnRateEvaluator;
  readonly credential_resolver?: CredentialResolver;
  readonly credential_events?: CredentialResolutionEvent[];
  readonly slo_definitions?: readonly SloDefinition[];
  readonly ack_timeout_policy?: ConstructorParameters<typeof BrokerAdapterRuntimeIntegration>[0]['ack_timeout_policy'];
  readonly order_lifecycle?: OrderLifecycleStateMachine;
  readonly capture_local_timestamp_ns?: () => UnixNs;
  readonly kill_switch_controller?: KillSwitchController;
  readonly anomaly_detector?: AnomalyDetector;
  readonly liveness_monitor?: DualLivenessMonitor;
  readonly live_ticker_subscriber?: Pick<LiveTickerSubscriber, 'start' | 'stop'>;
  readonly local_obs_replay_source?: Pick<LocalObsReplaySource, 'start' | 'stop'>;
}

export interface PaperTradingSessionDiagnostics {
  readonly started: boolean;
  readonly stopped: boolean;
  readonly adapter_kind: PaperBrokerAdapterKind;
  readonly market_data_source: PaperMarketDataSource;
  readonly journal_path?: string;
  readonly local_obs_replay_path?: string;
  readonly local_obs_replay_pace_mode: LocalObsReplayPaceMode;
  readonly live_account_allowlist_count: number;
  readonly broker_adapter_kind: string;
  readonly event_count: number;
  readonly event_counts_by_type: Readonly<Record<string, number>>;
  readonly open_quarantine_count: number;
  readonly active_submission_block_sources: readonly string[];
  readonly bus_published_events: number;
  readonly metrics_endpoint_enabled: boolean;
}

export const PAPER_RUNTIME_MODE = 'paper' as const;
export const DEFAULT_PAPER_SESSION_CONFIG_PATH = 'config/paper/paper-session-defaults.yaml' as const;
export const DEFAULT_APP_CONFIG_PATH = 'config/app.example.json' as const;
export const DEFAULT_PAPER_JOURNAL_DIR = 'journals/paper' as const;
export const DEFAULT_PAPER_SESSION_DURATION_MS = 3_000;
export const DEFAULT_PAPER_SHUTDOWN_QUARANTINE_TIMEOUT_MS = 30_000;
export const DEFAULT_PAPER_STRATEGY_ID = 'regime_shock_reversion_short_v2' as const;
export const DEFAULT_PAPER_MARKET_DATA_SOURCE = 'simulation' as const satisfies PaperMarketDataSource;
export const DEFAULT_LOCAL_OBS_REPLAY_PACE_MODE = 'realtime' as const satisfies LocalObsReplayPaceMode;
export const DEFAULT_PAPER_RECONNECT_POLICY: PaperReconnectPolicyConfig = {
  max_attempts: 3,
  initial_delay_ms: 250,
  max_delay_ms: 2_000,
  retry_budget_ms: 10_000,
  jitter: 'seeded',
};

export const RITHMIC_TEST_CREDENTIAL_DESCRIPTORS = [
  {
    key: 'rithmic.order_plant.username',
    env_var_name: 'RITHMIC_TEST_USERNAME',
    required_in_modes: ['paper'],
    plant_scope: 'ORDER_PLANT',
    redact_in_logs: true,
  },
  {
    key: 'rithmic.order_plant.password',
    env_var_name: 'RITHMIC_TEST_PASSWORD',
    required_in_modes: ['paper'],
    plant_scope: 'ORDER_PLANT',
    redact_in_logs: true,
  },
  {
    key: 'rithmic.order_plant.gateway_url',
    env_var_name: 'RITHMIC_TEST_GATEWAY_URL',
    required_in_modes: ['paper'],
    plant_scope: 'ORDER_PLANT',
    redact_in_logs: true,
  },
  {
    key: 'rithmic.order_plant.system_name',
    env_var_name: 'RITHMIC_TEST_SYSTEM_NAME',
    required_in_modes: ['paper'],
    plant_scope: 'ORDER_PLANT',
    redact_in_logs: true,
  },
] as const satisfies readonly CredentialDescriptor[];

export const RITHMIC_LIVE_TICKER_PLANT_CREDENTIAL_DESCRIPTORS = [
  {
    key: 'rithmic.live_ticker_plant.username',
    env_var_name: 'RITHMIC_USER',
    required_in_modes: ['paper'],
    plant_scope: 'TICKER_PLANT',
    redact_in_logs: true,
  },
  {
    key: 'rithmic.live_ticker_plant.password',
    env_var_name: 'RITHMIC_PASSWORD',
    required_in_modes: ['paper'],
    plant_scope: 'TICKER_PLANT',
    redact_in_logs: true,
  },
  {
    key: 'rithmic.live_ticker_plant.connect_point',
    env_var_name: 'RITHMIC_CONNECT_POINT',
    required_in_modes: ['paper'],
    plant_scope: 'TICKER_PLANT',
    redact_in_logs: true,
  },
  {
    key: 'rithmic.live_ticker_plant.system_name',
    env_var_name: 'RITHMIC_SYSTEM_NAME',
    required_in_modes: ['paper'],
    plant_scope: 'TICKER_PLANT',
    redact_in_logs: true,
  },
] as const satisfies readonly CredentialDescriptor[];

export function resolvePaperTradingSessionConfig(
  input: {
    readonly env?: Record<string, string | undefined>;
    readonly overrides?: Partial<PaperTradingSessionConfig>;
  } = {},
): PaperTradingSessionConfig {
  const env = input.env ?? process.env;
  const paperSessionConfigPath =
    input.overrides?.paper_session_config_path ??
    env.QFA_PAPER_SESSION_CONFIG ??
    DEFAULT_PAPER_SESSION_CONFIG_PATH;
  const yaml = loadPaperSessionConfigFile(paperSessionConfigPath);
  const yamlSession = recordAt(yaml, 'session');
  const yamlExecution = recordAt(yaml, 'execution');
  const yamlReconnect = recordAt(yamlExecution, 'reconnect_policy');
  const yamlObservability = recordAt(yaml, 'observability');
  const yamlMetrics = recordAt(yamlObservability, 'metrics');
  const mask = buildExecutionCapabilityMask();
  const adapterKind = parseAdapterKind(
    input.overrides?.adapter_kind ??
      env.QFA_BROKER_ADAPTER_KIND ??
      stringAt(yamlSession, 'adapter_kind') ??
      'mock',
  );
  const marketDataSource = parseMarketDataSource(
    input.overrides?.market_data_source ??
      env.QFA_PAPER_MARKET_DATA_SOURCE ??
      stringAt(yamlObservability, 'market_data_source') ??
      DEFAULT_PAPER_MARKET_DATA_SOURCE,
  );
  const liveAccountAllowlist = resolveConfiguredLiveAccountAllowlist({
    value:
      input.overrides?.live_account_allowlist ??
      (env.QFA_PAPER_LIVE_ACCOUNT_ALLOWLIST_PATH === undefined
        ? arrayAt(yamlExecution, 'live_account_allowlist')
        : undefined),
    env,
    path: env.QFA_PAPER_LIVE_ACCOUNT_ALLOWLIST_PATH,
  });
  return {
    paper_session_config_path: paperSessionConfigPath,
    strategy_id: input.overrides?.strategy_id ?? stringAt(yamlSession, 'strategy_id') ?? DEFAULT_PAPER_STRATEGY_ID,
    app_config_path: input.overrides?.app_config_path ?? stringAt(yamlSession, 'app_config_path') ?? DEFAULT_APP_CONFIG_PATH,
    journal_dir:
      input.overrides?.journal_dir ??
      env.QFA_JOURNAL_DIR ??
      stringAt(yamlSession, 'journal_dir') ??
      DEFAULT_PAPER_JOURNAL_DIR,
    adapter_kind: adapterKind,
    market_data_source: marketDataSource,
    local_obs_replay_path:
      input.overrides?.local_obs_replay_path ??
      env.QFA_PAPER_LOCAL_OBS_PATH ??
      optionalStringAt(yamlObservability, 'local_obs_replay_path'),
    local_obs_replay_pace_mode: parseLocalObsReplayPaceMode(
      input.overrides?.local_obs_replay_pace_mode ??
        env.QFA_PAPER_LOCAL_OBS_PACE_MODE ??
        stringAt(yamlObservability, 'local_obs_replay_pace_mode') ??
        DEFAULT_LOCAL_OBS_REPLAY_PACE_MODE,
    ),
    live_account_allowlist: liveAccountAllowlist,
    live_account_verification_enabled:
      input.overrides?.live_account_verification_enabled ??
      parseOptionalBoolean(env.QFA_PAPER_LIVE_ACCOUNT_VERIFICATION_ENABLED) ??
      booleanAt(yamlExecution, 'live_account_verification_enabled') ??
      false,
    capability_mask_id:
      input.overrides?.capability_mask_id ??
      stringAt(yamlExecution, 'capability_mask_id') ??
      mask.mask_id,
    capability_mask_version:
      input.overrides?.capability_mask_version ??
      numberAt(yamlExecution, 'capability_mask_version') ??
      mask.mask_version,
    reconnect_policy: {
      max_attempts:
        input.overrides?.reconnect_policy?.max_attempts ??
        numberAt(yamlReconnect, 'max_attempts') ??
        DEFAULT_PAPER_RECONNECT_POLICY.max_attempts,
      initial_delay_ms:
        input.overrides?.reconnect_policy?.initial_delay_ms ??
        numberAt(yamlReconnect, 'initial_delay_ms') ??
        DEFAULT_PAPER_RECONNECT_POLICY.initial_delay_ms,
      max_delay_ms:
        input.overrides?.reconnect_policy?.max_delay_ms ??
        numberAt(yamlReconnect, 'max_delay_ms') ??
        DEFAULT_PAPER_RECONNECT_POLICY.max_delay_ms,
      retry_budget_ms:
        input.overrides?.reconnect_policy?.retry_budget_ms ??
        numberAt(yamlReconnect, 'retry_budget_ms') ??
        DEFAULT_PAPER_RECONNECT_POLICY.retry_budget_ms,
      jitter:
        input.overrides?.reconnect_policy?.jitter ??
        stringAt(yamlReconnect, 'jitter') ??
        DEFAULT_PAPER_RECONNECT_POLICY.jitter,
    },
    metrics_endpoint: {
      enabled:
        input.overrides?.metrics_endpoint?.enabled ??
        parseOptionalBoolean(env.QFA_METRICS_ENABLED) ??
        booleanAt(yamlMetrics, 'enabled') ??
        false,
      port:
        input.overrides?.metrics_endpoint?.port ??
        parseOptionalPort(env.QFA_METRICS_PORT) ??
        numberAt(yamlMetrics, 'port') ??
        9_469,
    },
    slo_budgets_source:
      input.overrides?.slo_budgets_source ??
      stringAt(yamlObservability, 'slo_budgets_source') ??
      'qfa-627-provisional-registry',
    slo_budget_overrides:
      input.overrides?.slo_budget_overrides ??
      numberRecordAt(yamlObservability, 'slo_budget_overrides') ??
      {},
    run_id: input.overrides?.run_id ?? makeRunId('paper-session-run'),
    session_id: input.overrides?.session_id ?? makeSessionId('paper-session'),
    duration_ms:
      input.overrides?.duration_ms ??
      parseOptionalPositiveInteger(env.QFA_PAPER_SESSION_DURATION_MS) ??
      DEFAULT_PAPER_SESSION_DURATION_MS,
    shutdown_quarantine_timeout_ms:
      input.overrides?.shutdown_quarantine_timeout_ms ??
      parseOptionalNonNegativeInteger(env.QFA_PAPER_SHUTDOWN_QUARANTINE_TIMEOUT_MS) ??
      numberAt(yamlExecution, 'shutdown_quarantine_timeout_ms') ??
      DEFAULT_PAPER_SHUTDOWN_QUARANTINE_TIMEOUT_MS,
  };
}

export function loadPaperSessionConfigFile(
  configPath: string = DEFAULT_PAPER_SESSION_CONFIG_PATH,
): Readonly<Record<string, unknown>> {
  const text = readFileSync(resolvePath(process.cwd(), configPath), 'utf8');
  return parseSimplePaperYaml(text);
}

function resolveConfiguredLiveAccountAllowlist(input: {
  readonly value: unknown;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly path?: string;
}): LiveAccountAllowlist {
  const value =
    input.value !== undefined
      ? input.value
      : input.path === undefined || input.path.trim() === ''
        ? undefined
        : JSON.parse(readFileSync(resolvePath(process.cwd(), input.path), 'utf8')) as unknown;
  const result = resolveLiveAccountAllowlist({
    value,
    env: input.env,
    path: input.path === undefined ? '$.execution.live_account_allowlist' : input.path,
  });
  if (!result.ok) {
    throw new Error(
      `live account allowlist failed validation: ${result.issues
        .map((issue) => `${issue.path} ${issue.code}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.allowlist;
}

export function createPaperCredentialResolver(input: {
  readonly env?: Record<string, string | undefined>;
  readonly emit?: (event: CredentialResolutionEvent) => void;
  readonly adapter_kind?: PaperBrokerAdapterKind;
  readonly market_data_source?: PaperMarketDataSource;
} = {}): CredentialResolver {
  const descriptors = [
    ...((input.adapter_kind ?? 'mock') === 'rithmic' ? RITHMIC_TEST_CREDENTIAL_DESCRIPTORS : []),
    ...((input.market_data_source ?? DEFAULT_PAPER_MARKET_DATA_SOURCE) === 'live_rithmic_ticker_plant'
      ? RITHMIC_LIVE_TICKER_PLANT_CREDENTIAL_DESCRIPTORS
      : []),
  ];
  return new CompositeCredentialResolver({
    descriptors,
    mode_reader: () => PAPER_RUNTIME_MODE,
    env_var_backend: new EnvVarCredentialBackend({
      descriptors,
      env: input.env,
    }),
    emit: input.emit,
  });
}

export class PaperTradingSession {
  private readonly config: PaperTradingSessionConfig;
  private readonly env: Record<string, string | undefined>;
  private readonly container: StrategyRuntimeEngineContainer;
  private readonly adapter: BrokerAdapter;
  private readonly submissionGate: SubmissionGate;
  private readonly latencyRegistry: LatencySliRegistry;
  private readonly ackObserver: BoundedAckLatencyObserver;
  private readonly burnRateEvaluator: BurnRateEvaluator;
  private readonly credentialResolver: CredentialResolver;
  private readonly sloDefinitions: readonly SloDefinition[];
  private readonly journalEvents: AnyJournalEventEnvelope[] = [];
  private readonly pendingPublishes: Promise<unknown>[] = [];
  private readonly credentialEvents: CredentialResolutionEvent[];
  private readonly captureLocalTimestampNs?: () => UnixNs;
  private readonly ackTimeoutPolicy: PaperTradingSessionOptions['ack_timeout_policy'];
  private readonly orderLifecycle: OrderLifecycleStateMachine | undefined;
  private readonly killSwitch: KillSwitchController;
  private readonly anomalyDetector: AnomalyDetector;
  private readonly livenessMonitor: DualLivenessMonitor;
  private readonly reconnectRunner: ReconnectRunner;
  private readonly liveTickerSubscriber?: Pick<LiveTickerSubscriber, 'start' | 'stop'>;
  private readonly localObsReplaySource?: Pick<LocalObsReplaySource, 'start' | 'stop'>;
  private journalWriter: PaperSessionJournalWriter | undefined;
  private journalPath: string | undefined;
  private brokerRuntime: BrokerAdapterRuntimeIntegration | undefined;
  private runner: StrategyRuntimeRunner | undefined;
  private metricsEndpoint: LatencyMetricsEndpoint | undefined;
  private orderIntentSubscription: RuntimeEventBusSubscription | undefined;
  private reconnectSessionSubscription: (() => void) | undefined;
  private sloSubscription: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private eventSequence = 0;
  private intentsEmittedTotal = 0;
  private sessionStartedAtMs: number | undefined;

  constructor(options: PaperTradingSessionOptions = {}) {
    this.env = options.env ?? process.env;
    this.config = resolvePaperTradingSessionConfig({
      env: this.env,
      overrides: options.config,
    });
    if (this.config.market_data_source === 'live_rithmic_ticker_plant' && this.config.adapter_kind !== 'mock') {
      throw new Error('live_rithmic_ticker_plant shadow mode requires QFA_BROKER_ADAPTER_KIND=mock');
    }
    if (
      this.config.market_data_source === 'live_rithmic_ticker_plant' &&
      this.config.live_account_allowlist.length === 0
    ) {
      throw new Error('live_rithmic_ticker_plant shadow mode requires a non-empty live_account_allowlist');
    }
    if (this.config.market_data_source === 'local_obs_replay' && this.config.adapter_kind !== 'mock') {
      throw new Error('local_obs_replay shadow mode requires QFA_BROKER_ADAPTER_KIND=mock');
    }
    if (this.config.market_data_source === 'local_obs_replay' && this.config.local_obs_replay_path === undefined) {
      throw new Error('QFA_PAPER_LOCAL_OBS_PATH is required when QFA_PAPER_MARKET_DATA_SOURCE=local_obs_replay');
    }
    this.container = options.container ?? this.createDefaultContainer();
    this.adapter = options.broker_adapter ?? this.createBrokerAdapter();
    this.submissionGate = options.submission_gate ?? new SubmissionGate();
    this.latencyRegistry = options.latency_registry ?? new LatencySliRegistry();
    this.ackObserver = new BoundedAckLatencyObserver({ registry: this.latencyRegistry });
    this.sloDefinitions = options.slo_definitions ?? [
      ...PROVISIONAL_LATENCY_SLO_DEFINITIONS,
      PROVISIONAL_CANCEL_ACK_SLO,
    ];
    this.burnRateEvaluator =
      options.burn_rate_evaluator ??
      new BurnRateEvaluator({ definitions: this.sloDefinitions });
    this.credentialEvents = options.credential_events ?? [];
    this.credentialResolver =
      options.credential_resolver ??
      createPaperCredentialResolver({
        env: this.env,
        emit: (event) => this.credentialEvents.push(event),
        adapter_kind: this.config.adapter_kind,
        market_data_source: this.config.market_data_source,
      });
    this.captureLocalTimestampNs = options.capture_local_timestamp_ns;
    this.ackTimeoutPolicy = options.ack_timeout_policy;
    this.orderLifecycle = options.order_lifecycle;
    this.killSwitch = options.kill_switch_controller ?? new KillSwitchController({
      submission_gate: this.submissionGate,
      persistence: { enabled: false },
      emit: (event) => this.publishOperationalEvent(event),
      now_ns: () => this.nowNs(),
    });
    this.anomalyDetector = options.anomaly_detector ?? new AnomalyDetector({
      kill_switch: this.killSwitch,
      emit: (event) => this.publishOperationalEvent(event),
      now_ns: () => this.nowNs(),
    });
    this.livenessMonitor = options.liveness_monitor ?? new DualLivenessMonitor({
      kill_switch: this.killSwitch,
      latency_registry: this.latencyRegistry,
      emit: (event) => this.publishOperationalEvent(event),
      now_ns: () => this.nowNs(),
    });
    this.reconnectRunner = new ReconnectRunner({
      submission_gate: this.submissionGate,
      manifest_payload: () => this.reconnectManifestPayload(),
      emit: (event) => this.publishOperationalEvent(event),
      reconnect: async () => this.reconnectBrokerAdapter(),
      now_ns: () => this.nowNs(),
    });
    this.liveTickerSubscriber = options.live_ticker_subscriber ?? this.createLiveTickerSubscriber();
    this.localObsReplaySource = options.local_obs_replay_source ?? this.createLocalObsReplaySource();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.config.adapter_kind === 'rithmic') {
      throw new Error('QFA-612-PAPER-01b not yet merged: real Rithmic adapter is unavailable');
    }
    this.sessionStartedAtMs = Date.now();
    this.journalWriter = new FilePaperSessionJournalWriter({
      journal_dir: this.config.journal_dir,
      session_id: this.config.session_id,
    });
    this.journalPath = this.journalWriter.journal_path;

    this.metricsEndpoint = startLatencyMetricsEndpoint({
      config: this.config.metrics_endpoint,
      registry: this.latencyRegistry,
    });

    this.runner = new StrategyRuntimeRunner({
      container: this.container,
      run_id: this.config.run_id,
      session_id: this.config.session_id,
      execution_adapter: createSimulatedExecutionAdapter({
        venue_costs: loadVenueCostTable(),
      }),
      latency_metrics_endpoint: this.config.metrics_endpoint,
    });

    this.brokerRuntime = new BrokerAdapterRuntimeIntegration({
      adapter: this.adapter,
      run_id: this.config.run_id,
      session_id: this.config.session_id,
      submission_gate: this.submissionGate,
      event_sink: (event) => this.publishHarnessEvent(event),
      credential_lookup: this.credentialLookup(),
      ack_latency_observer: this.ackObserver,
      ...(this.captureLocalTimestampNs === undefined
        ? {}
        : { capture_local_timestamp_ns: this.captureLocalTimestampNs }),
      ...(this.ackTimeoutPolicy === undefined ? {} : { ack_timeout_policy: this.ackTimeoutPolicy }),
      ...(this.orderLifecycle === undefined ? {} : { order_lifecycle: this.orderLifecycle }),
    });

    this.orderIntentSubscription = this.container.eventBus.subscribe(
      { event_types: ['ORDER_INTENT'] },
      async (delivery) => {
        this.intentsEmittedTotal += 1;
        await this.brokerRuntime?.handleOrderIntent(
          delivery.event as JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>>,
        );
      },
    );

    const haltEmitter = new SloHaltEmitter({
      slo_definitions: this.sloDefinitions,
      runtime_mode_reader: () => PAPER_RUNTIME_MODE,
      submission_gate: this.submissionGate,
      emit: (event) => {
        this.publishHarnessEvent(
          createJournalEventEnvelope({
            event_id: makeEventId(`paper-slo-${event.type.toLowerCase()}-${++this.eventSequence}`),
            type: event.type,
            ts_ns: event.transition.transitioned_ts_ns,
            run_id: this.config.run_id,
            session_id: this.config.session_id,
            payload: event.payload,
          }),
        );
      },
    });
    this.sloSubscription = haltEmitter.subscribe(this.burnRateEvaluator);

    this.reconnectSessionSubscription = this.adapter.subscribeSessionEvents((event) => {
      this.handleOperationalSessionEvent(event);
    });
    await this.liveTickerSubscriber?.start();
    await this.localObsReplaySource?.start();
    await this.brokerRuntime.start();
    await this.drain();
    this.assertSessionManifestValid();
    this.started = true;
    this.stopped = false;
  }

  async processFeatureSnapshot(
    snapshot: StrategyFeatureSnapshot,
  ): Promise<Awaited<ReturnType<StrategyRuntimeRunner['processFeatureSnapshot']>>> {
    if (this.runner === undefined) {
      throw new Error('PaperTradingSession must be started before processing snapshots');
    }
    await this.runner.publishExternalEvent(sourceQuoteEventForSnapshot(
      snapshot,
      this.config.run_id,
      this.config.session_id,
    ));
    const result = await this.runner.processFeatureSnapshot(snapshot);
    await this.drain();
    return result;
  }

  observeSloSample(metricName: string, sampleMs: number, observedAtMs?: number): void {
    if (observedAtMs === undefined) {
      this.burnRateEvaluator.observeSample(metricName, sampleMs);
      return;
    }
    this.burnRateEvaluator.observeSampleAt(metricName, sampleMs, observedAtMs);
  }

  evaluateSlo(): void {
    this.burnRateEvaluator.evaluateWithAnomalies();
  }

  async drain(): Promise<void> {
    while (this.pendingPublishes.length > 0) {
      const pending = this.pendingPublishes.splice(0);
      await Promise.all(pending);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.orderIntentSubscription?.unsubscribe();
    this.orderIntentSubscription = undefined;
    this.reconnectSessionSubscription?.();
    this.reconnectSessionSubscription = undefined;
    this.sloSubscription?.();
    this.sloSubscription = undefined;
    const quarantineDrained = await this.waitForQuarantineDrain();
    if (!quarantineDrained) {
      this.emitShutdownQuarantineEscalation();
    }
    await this.liveTickerSubscriber?.stop();
    await this.localObsReplaySource?.stop();
    await this.brokerRuntime?.stop();
    this.brokerRuntime = undefined;
    await this.metricsEndpoint?.close();
    this.metricsEndpoint = undefined;
    this.emitClosingSessionManifest();
    await this.drain();
    this.journalWriter?.close();
    this.journalWriter = undefined;
    this.credentialResolver.shutdown();
    this.started = false;
    this.stopped = true;
  }

  getDiagnostics(): PaperTradingSessionDiagnostics {
    const counts: Record<string, number> = {};
    for (const event of this.journalEvents) {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
    }
    return {
      started: this.started,
      stopped: this.stopped,
      adapter_kind: this.config.adapter_kind,
      market_data_source: this.config.market_data_source,
      ...(this.journalPath === undefined ? {} : { journal_path: this.journalPath }),
      local_obs_replay_pace_mode: this.config.local_obs_replay_pace_mode,
      live_account_allowlist_count: this.config.live_account_allowlist.length,
      broker_adapter_kind: this.adapter.constructor.name,
      event_count: this.journalEvents.length,
      event_counts_by_type: counts,
      open_quarantine_count: this.submissionGate.open_quarantine_count,
      active_submission_block_sources: this.submissionGate.active_block_sources,
      bus_published_events: this.container.eventBus.snapshot().published_events,
      metrics_endpoint_enabled: this.config.metrics_endpoint.enabled === true,
    };
  }

  get events(): readonly AnyJournalEventEnvelope[] {
    return this.journalEvents;
  }

  private async waitForQuarantineDrain(): Promise<boolean> {
    await this.drain();
    if (this.submissionGate.open_quarantine_count === 0) {
      return true;
    }

    const timeoutMs = this.config.shutdown_quarantine_timeout_ms;
    if (timeoutMs <= 0) {
      return false;
    }

    const startedAtMs = Date.now();
    while (this.submissionGate.open_quarantine_count > 0) {
      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs >= timeoutMs) {
        return false;
      }
      await sleep(Math.min(25, timeoutMs - elapsedMs));
      await this.drain();
    }
    return true;
  }

  private emitShutdownQuarantineEscalation(): void {
    const previousQuarantine = [...this.journalEvents]
      .reverse()
      .find((event): event is JournalEventEnvelope<'ORDER_QUARANTINE_ENTERED', JournalEventPayloadFor<'ORDER_QUARANTINE_ENTERED'>> =>
        event.type === 'ORDER_QUARANTINE_ENTERED',
      );
    const payload: JournalEventPayloadFor<'ORDER_QUARANTINE_ENTERED'> = {
      ...(previousQuarantine?.payload ?? {
        intent_id: makeEventId('paper-shutdown-unresolved-quarantine'),
        previous_state: 'pending_ack',
        quarantine_reason: 'submission_ack_timeout',
      }),
      open_quarantine_count: this.submissionGate.open_quarantine_count,
      escalation_required: true,
      is_provisional: true,
    };
    this.publishHarnessEvent(createJournalEventEnvelope({
      event_id: makeEventId(`paper-shutdown-quarantine-escalation-${++this.eventSequence}`),
      type: 'ORDER_QUARANTINE_ENTERED',
      ts_ns: this.nowNs(),
      run_id: this.config.run_id,
      session_id: this.config.session_id,
      payload,
    }));
  }

  private emitClosingSessionManifest(): void {
    const openingManifest = this.journalEvents.find(
      (event): event is JournalEventEnvelope<'SESSION_MANIFEST', JournalEventPayloadFor<'SESSION_MANIFEST'>> =>
        event.type === 'SESSION_MANIFEST',
    );
    const mask = buildExecutionCapabilityMask();
    const payload: JournalEventPayloadFor<'SESSION_MANIFEST'> = {
      ...(openingManifest?.payload ?? {
        mask_id: this.config.capability_mask_id,
        mask_version: this.config.capability_mask_version,
        mask_hash: mask.mask_hash,
        reconnect_policy_config: { ...this.config.reconnect_policy },
        plant_scope: 'ORDER_PLANT',
        mode: PAPER_RUNTIME_MODE,
        timestamp_anchor: 'dual',
        broker_session_id: String(this.config.session_id),
        adapter_kind: 'MOCK_ORDER_PLANT',
      }),
      session_phase: 'closing',
      session_duration_ms: this.sessionDurationMs(),
      final_quarantine_count: this.submissionGate.open_quarantine_count,
      intents_emitted_total: this.intentsEmittedTotal,
      acks_received_total: this.countEvents([
        'ORDER_ACK_SUBMISSION',
        'ORDER_ACK_FILL',
        'ORDER_ACK_CANCEL',
        'ORDER_BROKER_REJECT',
      ]),
      would_halt_emissions_total: this.countEvents(['WOULD_HALT']),
    };
    this.publishHarnessEvent(createJournalEventEnvelope({
      event_id: makeEventId(`paper-session-closing-manifest-${++this.eventSequence}`),
      type: 'SESSION_MANIFEST',
      ts_ns: this.nowNs(),
      run_id: this.config.run_id,
      session_id: this.config.session_id,
      payload,
    }));
  }

  private sessionDurationMs(): number {
    if (this.sessionStartedAtMs === undefined) {
      return 0;
    }
    return Math.max(0, Date.now() - this.sessionStartedAtMs);
  }

  private countEvents(types: readonly AnyJournalEventEnvelope['type'][]): number {
    const typeSet = new Set(types);
    return this.journalEvents.filter((event) => typeSet.has(event.type)).length;
  }

  private nowNs(): UnixNs {
    return this.captureLocalTimestampNs?.() ?? ns(BigInt(Date.now()) * 1_000_000n);
  }

  private nowMs(): number {
    return Number(BigInt(this.nowNs()) / 1_000_000n);
  }

  private createDefaultContainer(): StrategyRuntimeEngineContainer {
    const config = loadAppConfig({
      configPath: this.config.app_config_path,
      cwd: process.cwd(),
      env: {
        ...this.env,
        QFA_JOURNAL_DIR: this.config.journal_dir,
      },
    });
    return createStrategyRuntimeEngineContainer({ config });
  }

  private createBrokerAdapter(): BrokerAdapter {
    if (this.config.adapter_kind === 'rithmic') {
      throw new Error('QFA-612-PAPER-01b not yet merged: real Rithmic adapter is unavailable');
    }
    return new MockOrderPlantAdapter({
      seed: 'qfa-614-paper-harness',
      ack_latencies: {
        submission_ack_ms: 0,
        fill_ack_ms: 0,
        cancel_ack_ms: 0,
      },
    });
  }

  private createLiveTickerSubscriber(): Pick<LiveTickerSubscriber, 'start' | 'stop'> | undefined {
    if (this.config.market_data_source !== 'live_rithmic_ticker_plant') {
      return undefined;
    }
    const options: LiveTickerSubscriberOptions = {
      run_id: this.config.run_id,
      session_id: this.config.session_id,
      event_sink: (event) => this.publishHarnessEvent(event),
      submission_gate: this.submissionGate,
      credentials_env: {
        RITHMIC_USER: this.env.RITHMIC_USER,
        RITHMIC_PASSWORD: this.env.RITHMIC_PASSWORD,
        RITHMIC_CONNECT_POINT: this.env.RITHMIC_CONNECT_POINT,
        RITHMIC_SYSTEM_NAME: this.env.RITHMIC_SYSTEM_NAME,
      },
      now_ns: () => this.nowNs(),
    };
    return new LiveTickerSubscriber(options);
  }

  private createLocalObsReplaySource(): Pick<LocalObsReplaySource, 'start' | 'stop'> | undefined {
    if (this.config.market_data_source !== 'local_obs_replay') {
      return undefined;
    }
    const path = this.config.local_obs_replay_path;
    if (path === undefined) {
      throw new Error('QFA_PAPER_LOCAL_OBS_PATH is required when QFA_PAPER_MARKET_DATA_SOURCE=local_obs_replay');
    }
    const options: LocalObsReplaySourceOptions = {
      path,
      run_id: this.config.run_id,
      session_id: this.config.session_id,
      pace_mode: this.config.local_obs_replay_pace_mode,
      event_sink: (event) => this.publishHarnessEvent(event),
    };
    return new LocalObsReplaySource(options);
  }

  private credentialLookup(): BrokerCredentialLookup {
    return {
      resolveOrderPlantCredentials: async () => {
        if (this.config.adapter_kind === 'mock') {
          return {
            available: true,
            vault_evidence: false,
            resolver: 'QFA-614_MOCK_ADAPTER_NO_BROKER_SECRET_REQUIRED',
            redacted_account_ref: 'mock-paper-account',
          };
        }
        await Promise.all([
          this.credentialResolver.resolve('rithmic.order_plant.username'),
          this.credentialResolver.resolve('rithmic.order_plant.password'),
          this.credentialResolver.resolve('rithmic.order_plant.gateway_url'),
          this.credentialResolver.resolve('rithmic.order_plant.system_name'),
        ]);
        return {
          available: true,
          vault_evidence: false,
          resolver: 'QFA-620_ENV_VAR_PAPER',
          redacted_account_ref: 'rithmic-test-account-redacted',
        };
      },
    };
  }

  private publishHarnessEvent(event: AnyJournalEventEnvelope): void {
    const enrichedEvent = this.withMarketDataSource(event);
    this.journalEvents.push(enrichedEvent);
    this.journalWriter?.write(enrichedEvent);
    this.pendingPublishes.push(this.container.publish(enrichedEvent));
    this.anomalyDetector.observeEvent(enrichedEvent);
  }

  private withMarketDataSource(event: AnyJournalEventEnvelope): AnyJournalEventEnvelope {
    if (event.type !== 'SESSION_MANIFEST') {
      return event;
    }
    return {
      ...event,
      payload: {
        ...event.payload,
        market_data_source: this.config.market_data_source,
        ...(this.config.live_account_allowlist.length === 0
          ? {}
          : { live_account_allowlist_summary: summarizeLiveAccountAllowlist(this.config.live_account_allowlist) }),
      },
    } as AnyJournalEventEnvelope;
  }

  private publishOperationalEvent(
    event: KillSwitchControllerEvent | AnomalyDetectorEvent | LivenessMonitorEvent | ReconnectRunnerEvent,
  ): void {
    this.publishHarnessEvent(
      createJournalEventEnvelope({
        event_id: makeEventId(`paper-operational-${event.type.toLowerCase()}-${++this.eventSequence}`),
        type: event.type,
        ts_ns: event.ts_ns,
        run_id: this.config.run_id,
        session_id: this.config.session_id,
        payload: event.payload,
      }) as AnyJournalEventEnvelope,
    );
  }

  private handleOperationalSessionEvent(event: BrokerSessionEvent): void {
    this.livenessMonitor.recordBrokerHeartbeat({
      broker_ts_ns: event.ts_ns,
      local_received_ms: this.nowMs(),
    });
    if (event.type !== 'RECONNECT_STATE') {
      return;
    }
    const payload = reconnectPayloadForSessionEvent(event);
    if (payload.phase === 'disconnect' || payload.state === 'DISCONNECTED') {
      void this.reconnectRunner.handleDisconnect(payload.reason ?? 'broker_disconnect');
    }
  }

  private async reconnectBrokerAdapter(): Promise<{
    readonly connected: boolean;
    readonly broker_session_id?: string;
    readonly reason?: string;
  }> {
    try {
      await this.adapter.start();
      return {
        connected: true,
        ...(this.latestBrokerSessionId() === undefined
          ? {}
          : { broker_session_id: this.latestBrokerSessionId() }),
      };
    } catch (error) {
      return {
        connected: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private reconnectManifestPayload(): JournalEventPayloadFor<'SESSION_MANIFEST'> {
    const openingManifest = this.journalEvents.find(
      (event): event is JournalEventEnvelope<'SESSION_MANIFEST', JournalEventPayloadFor<'SESSION_MANIFEST'>> =>
        event.type === 'SESSION_MANIFEST',
    );
    const mask = buildExecutionCapabilityMask();
    return openingManifest?.payload ?? {
      mask_id: this.config.capability_mask_id,
      mask_version: this.config.capability_mask_version,
      mask_hash: mask.mask_hash,
      reconnect_policy_config: { ...this.config.reconnect_policy },
      plant_scope: 'ORDER_PLANT',
      mode: PAPER_RUNTIME_MODE,
      timestamp_anchor: 'dual',
      broker_session_id: String(this.config.session_id),
      adapter_kind: 'MOCK_ORDER_PLANT',
      ...(this.config.live_account_allowlist.length === 0
        ? {}
        : { live_account_allowlist_summary: summarizeLiveAccountAllowlist(this.config.live_account_allowlist) }),
    };
  }

  private latestBrokerSessionId(): string | undefined {
    return [...this.journalEvents]
      .reverse()
      .find((event): event is JournalEventEnvelope<'SESSION_MANIFEST', JournalEventPayloadFor<'SESSION_MANIFEST'>> =>
        event.type === 'SESSION_MANIFEST',
      )?.payload.broker_session_id;
  }

  private assertSessionManifestValid(): void {
    const manifest = this.journalEvents.find((event) => event.type === 'SESSION_MANIFEST');
    if (manifest === undefined) {
      throw new Error('paper trading session did not emit SESSION_MANIFEST');
    }
    const issues = new SessionManifestValidator().runOnSessionStart({
      session_manifest: manifest.payload as unknown as Readonly<Record<string, unknown>>,
    });
    if (issues.length > 0) {
      throw new Error(`SESSION_MANIFEST failed EXEC-VALIDATOR-06: ${issues[0]!.message}`);
    }
  }
}

interface PaperSessionJournalWriter {
  readonly journal_path: string;
  write(event: AnyJournalEventEnvelope): void;
  close(): void;
}

class FilePaperSessionJournalWriter implements PaperSessionJournalWriter {
  readonly journal_path: string;
  private closed = false;

  constructor(options: {
    readonly journal_dir: string;
    readonly session_id: SessionId;
  }) {
    const journalDir = resolvePath(process.cwd(), options.journal_dir);
    mkdirSync(journalDir, { recursive: true });
    this.journal_path = join(journalDir, `${sanitizeJournalFileSegment(String(options.session_id))}.jsonl`);
    writeFileSync(this.journal_path, '', 'utf8');
  }

  write(event: AnyJournalEventEnvelope): void {
    if (this.closed) {
      throw new Error('paper session journal writer is already closed');
    }
    appendFileSync(this.journal_path, `${journalEventToJsonLine(event)}\n`, 'utf8');
  }

  close(): void {
    this.closed = true;
  }
}

function sanitizeJournalFileSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return sanitized === '' ? 'paper-session' : sanitized;
}

export function sourceQuoteEventForSnapshot(
  snapshot: StrategyFeatureSnapshot,
  runId: RunId,
  sessionId: SessionId,
): JournalEventEnvelope<'QUOTE', JournalEventPayloadFor<'QUOTE'>> {
  return createJournalEventEnvelope({
    event_id: makeEventId(String(snapshot.source_event_id)),
    type: 'QUOTE',
    ts_ns: snapshot.created_ts_ns,
    run_id: runId,
    session_id: sessionId,
    payload: {
      exchange_event_ts_ns: snapshot.created_ts_ns,
      sidecar_recv_ts_ns: ns(BigInt(snapshot.created_ts_ns) + 1_000_000n),
      bid_px: snapshot.quote.bid_px,
      bid_qty: 1,
      ask_px: snapshot.quote.ask_px,
      ask_qty: 1,
      authority: 'authoritative',
    },
  });
}

function parseAdapterKind(value: string): PaperBrokerAdapterKind {
  if (value === 'mock' || value === 'rithmic') {
    return value;
  }
  throw new Error('QFA_BROKER_ADAPTER_KIND must be one of: mock, rithmic');
}

function parseMarketDataSource(value: string): PaperMarketDataSource {
  if (value === 'simulation' || value === 'live_rithmic_ticker_plant' || value === 'local_obs_replay') {
    return value;
  }
  throw new Error('QFA_PAPER_MARKET_DATA_SOURCE must be one of: simulation, live_rithmic_ticker_plant, local_obs_replay');
}

function parseLocalObsReplayPaceMode(value: string): LocalObsReplayPaceMode {
  if (value === 'realtime' || value === 'as_fast_as_possible') {
    return value;
  }
  throw new Error('QFA_PAPER_LOCAL_OBS_PACE_MODE must be one of: realtime, as_fast_as_possible');
}

function parseOptionalPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error('QFA_METRICS_PORT must be an integer from 0 through 65535');
  }
  return parsed;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error('QFA_METRICS_ENABLED must be true or false when provided');
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('QFA_PAPER_SESSION_DURATION_MS must be a positive integer');
  }
  return parsed;
}

function parseOptionalNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('QFA_PAPER_SHUTDOWN_QUARANTINE_TIMEOUT_MS must be a non-negative integer');
  }
  return parsed;
}

function parseSimplePaperYaml(text: string): Readonly<Record<string, unknown>> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ readonly indent: number; readonly value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ];

  for (const rawLine of text.split(/\r?\n/u)) {
    const withoutComment = rawLine.replace(/\s+#.*$/u, '');
    if (withoutComment.trim() === '') {
      continue;
    }
    const indent = withoutComment.match(/^ */u)?.[0].length ?? 0;
    const line = withoutComment.trim();
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      throw new Error(`Unsupported paper YAML line: ${rawLine}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    while (stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!.value;
    if (rawValue === '') {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseSimpleYamlScalar(rawValue);
    }
  }

  return root;
}

function parseSimpleYamlScalar(value: string): string | number | boolean | null | Record<string, never> | readonly unknown[] {
  if (value === '[]') {
    return [];
  }
  if (value === '{}') {
    return {};
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value === 'null') {
    return null;
  }
  const numeric = Number(value);
  if (value !== '' && Number.isFinite(numeric) && String(numeric) === value) {
    return numeric;
  }
  return value.replace(/^['"]|['"]$/gu, '');
}

function recordAt(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const child = value?.[key];
  if (child !== undefined && (child === null || typeof child !== 'object' || Array.isArray(child))) {
    throw new Error(`paper session config field ${key} must be an object`);
  }
  return child as Readonly<Record<string, unknown>> | undefined;
}

function stringAt(value: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const child = value?.[key];
  if (child === undefined) {
    return undefined;
  }
  if (typeof child !== 'string') {
    throw new Error(`paper session config field ${key} must be a string`);
  }
  return child;
}

function optionalStringAt(value: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const child = value?.[key];
  if (child === undefined || child === null) {
    return undefined;
  }
  if (typeof child !== 'string') {
    throw new Error(`paper session config field ${key} must be a string`);
  }
  return child;
}

function numberAt(value: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  const child = value?.[key];
  if (child === undefined) {
    return undefined;
  }
  if (typeof child !== 'number' || !Number.isFinite(child)) {
    throw new Error(`paper session config field ${key} must be a finite number`);
  }
  return child;
}

function booleanAt(value: Readonly<Record<string, unknown>> | undefined, key: string): boolean | undefined {
  const child = value?.[key];
  if (child === undefined) {
    return undefined;
  }
  if (typeof child !== 'boolean') {
    throw new Error(`paper session config field ${key} must be a boolean`);
  }
  return child;
}

function arrayAt(value: Readonly<Record<string, unknown>> | undefined, key: string): readonly unknown[] | undefined {
  const child = value?.[key];
  if (child === undefined) {
    return undefined;
  }
  if (!Array.isArray(child)) {
    throw new Error(`paper session config field ${key} must be an array`);
  }
  return child;
}

function numberRecordAt(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, number>> | undefined {
  const record = recordAt(value, key);
  if (record === undefined) {
    return undefined;
  }
  const numbers: Record<string, number> = {};
  for (const [childKey, childValue] of Object.entries(record)) {
    if (typeof childValue !== 'number' || !Number.isFinite(childValue)) {
      throw new Error(`paper session config field ${key}.${childKey} must be a finite number`);
    }
    numbers[childKey] = childValue;
  }
  return numbers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reconnectPayloadForSessionEvent(
  event: Extract<BrokerSessionEvent, { readonly type: 'RECONNECT_STATE' }>,
): JournalEventPayloadFor<'RECONNECT_STATE'> {
  if ('payload' in event) {
    return event.payload;
  }
  return {
    previous_state: event.previous_state,
    state: event.state,
    phase: event.state === 'DISCONNECTED'
      ? 'disconnect'
      : event.state === 'FAILED'
        ? 'exhausted'
        : 'attempt',
    max_attempts: Number(event.retry_budget_config.max_attempts),
    retry_budget_config: event.retry_budget_config,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    terminal: event.state === 'FAILED',
    blocked_submission_gate: event.state !== 'CONNECTED',
  };
}
