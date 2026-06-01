import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPaperSessionConfigFile,
  PaperTradingSession,
  resolvePaperTradingSessionConfig,
  type PaperTradingSessionConfig,
} from '../../apps/strategy_runtime/src/paper-trading/index.js';
import {
  ACTIVE_STRATEGY_IDS,
  CANDIDATE_STRATEGY_IDS,
  REGISTERED_INACTIVE_STRATEGY_IDS,
} from '../../apps/strategy_runtime/src/contracts/strategy-ids.js';
import { getStrategyGenerator } from '../../apps/strategy_runtime/src/strategies/registry.js';

export const V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID =
  'regime_shock_reversion_short_v2_utc_16_18_exclusion' as const;

export const V2_PF_C_LATE_AM_PAPER_OBSERVATION_CONFIG_PATH =
  'config/paper/v2-pf-c-late-am-paper-observation.yaml' as const;

export interface ResolveV2PfCLateAmPaperObservationConfigInput {
  readonly env?: Record<string, string | undefined>;
  readonly config_path?: string;
}

export function resolveV2PfCLateAmPaperObservationConfig(
  input: ResolveV2PfCLateAmPaperObservationConfigInput = {},
): PaperTradingSessionConfig {
const configPath = input.config_path ?? V2_PF_C_LATE_AM_PAPER_OBSERVATION_CONFIG_PATH;
  const rawConfig = loadPaperSessionConfigFile(configPath);

  assertSingleExplicitPaperObservationTarget(rawConfig, configPath);
  assertStrategyRemainsExplicitlyPaperObservable();

  const config = resolvePaperTradingSessionConfig({
    env: {
      QFA_PAPER_SESSION_CONFIG: configPath,
    },
    overrides: {
      explicit_strategy_ids: [V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID],
    },
  });

  if (config.strategy_id !== V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID) {
    throw new Error(
      `paper observation config must resolve exactly ${V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID}; ` +
        `resolved ${config.strategy_id}`,
    );
  }
  if (config.adapter_kind !== 'mock') {
    throw new Error('paper observation requires adapter_kind=mock; broker/live adapters are not allowed');
  }
  if (
    config.explicit_strategy_ids?.length !== 1 ||
    config.explicit_strategy_ids[0] !== V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID
  ) {
    throw new Error(`paper observation runtime must evaluate exactly ${V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID}`);
  }

  return config;
}

export function createV2PfCLateAmPaperObservationSession(
  input: ResolveV2PfCLateAmPaperObservationConfigInput = {},
): PaperTradingSession {
  return new PaperTradingSession({
    config: resolveV2PfCLateAmPaperObservationConfig(input),
  });
}

function assertSingleExplicitPaperObservationTarget(
  rawConfig: Readonly<Record<string, unknown>>,
  configPath: string,
): void {
  rejectAmbiguousStrategyKeys(rawConfig, '$');
  const session = recordAt(rawConfig, 'session', configPath);
  rejectAmbiguousStrategyKeys(session, '$.session');

  if (!hasOwn(session, 'strategy_id')) {
    throw new Error(`${configPath} must declare $.session.strategy_id; default strategy fallback is not allowed`);
  }
  if (session.strategy_id !== V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID) {
    throw new Error(
      `${configPath} $.session.strategy_id must be exactly ` +
        `${V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID}`,
    );
  }
}

function assertStrategyRemainsExplicitlyPaperObservable(): void {
  const activeIds: readonly string[] = ACTIVE_STRATEGY_IDS;
  const candidateIds: readonly string[] = CANDIDATE_STRATEGY_IDS;
  const inactiveIds: readonly string[] = REGISTERED_INACTIVE_STRATEGY_IDS;

  if (activeIds.length !== 0) {
    throw new Error('paper observation requires ACTIVE_STRATEGY_IDS to remain empty');
  }
  if (candidateIds.length !== 0) {
    throw new Error('paper observation requires CANDIDATE_STRATEGY_IDS to remain empty');
  }
  if (!inactiveIds.includes(V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID)) {
    throw new Error(
      `${V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID} must remain REGISTERED_INACTIVE`,
    );
  }

  getStrategyGenerator(V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID);
}

function rejectAmbiguousStrategyKeys(record: Readonly<Record<string, unknown>>, path: string): void {
  for (const key of ['strategy_ids', 'strategies'] as const) {
    if (hasOwn(record, key)) {
      throw new Error(`${path}.${key} is not allowed; paper observation must target one explicit strategy_id`);
    }
  }
}

function recordAt(
  value: Readonly<Record<string, unknown>>,
  key: string,
  configPath: string,
): Readonly<Record<string, unknown>> {
  const child = value[key];
  if (child === undefined || child === null || typeof child !== 'object' || Array.isArray(child)) {
    throw new Error(`${configPath} field ${key} must be an object`);
  }
  return child as Readonly<Record<string, unknown>>;
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

async function runCli(): Promise<void> {
  const config = resolveV2PfCLateAmPaperObservationConfig();
  const session = new PaperTradingSession({ config });

  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) {
      return;
    }
    stopping = true;
    await session.stop();
    process.stdout.write(`${JSON.stringify(session.getDiagnostics())}\n`);
  }

  process.once('SIGINT', () => {
    void stop().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void stop().finally(() => process.exit(0));
  });

  await session.start();
  process.stdout.write(
    `QFA paper observation started strategy=${config.strategy_id} adapter=${config.adapter_kind}; ` +
      'minimum observation target is 45 trading days, preferred target is 60 trading days; ' +
      'broker/live dispatch is not authorized by this entrypoint.\n',
  );
  await new Promise((resolve) => setTimeout(resolve, config.duration_ms ?? 0));
  await stop();
}

if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
