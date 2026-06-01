import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  V2_PF_C_LATE_AM_PAPER_OBSERVATION_CONFIG_PATH,
  V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID,
  createV2PfCLateAmPaperObservationSession,
  resolveV2PfCLateAmPaperObservationConfig,
} from '../../../../scripts/paper/run-v2-pf-c-late-am-paper-observation.js';
import {
  ACTIVE_STRATEGY_IDS,
  CANDIDATE_STRATEGY_IDS,
  REGISTERED_INACTIVE_STRATEGY_IDS,
} from '../../src/contracts/strategy-ids.js';
import { makeRunId, makeSessionId } from '../../src/contracts/index.js';
import { loadAppConfig } from '../../src/config/index.js';
import { createSimulatedExecutionAdapter } from '../../src/execution/simulated-execution.js';
import { createStrategyRuntimeEngineContainer, StrategyRuntimeRunner } from '../../src/orchestration/index.js';
import { resolvePaperTradingSessionConfig } from '../../src/paper-trading/index.js';
import { loadVenueCostTable } from '../../src/risk/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

describe('V2 PF C late-AM paper observation entrypoint', () => {
  it('resolves the dedicated config to the explicit registered-inactive strategy', () => {
    const config = resolveV2PfCLateAmPaperObservationConfig();

    expect(config.paper_session_config_path).toBe(V2_PF_C_LATE_AM_PAPER_OBSERVATION_CONFIG_PATH);
    expect(config.strategy_id).toBe(V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID);
    expect(config.explicit_strategy_ids).toEqual([V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID]);
    expect(config.adapter_kind).toBe('mock');
    expect(config.journal_dir).toBe('journals/paper/v2-pf-c-late-am-paper-observation');
    expect([...ACTIVE_STRATEGY_IDS]).toEqual([]);
    expect([...CANDIDATE_STRATEGY_IDS]).toEqual([]);
    expect([...REGISTERED_INACTIVE_STRATEGY_IDS]).toContain(V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID);
  });

  it('does not change default paper-session behavior', () => {
    expect(resolvePaperTradingSessionConfig({ env: {} }).strategy_id).toBe('regime_shock_reversion_short_v2');
  });

  it('ignores active-roster/default config fallback and uses the dedicated config path', () => {
    const config = resolveV2PfCLateAmPaperObservationConfig({
      env: {
        QFA_PAPER_SESSION_CONFIG: 'config/paper/paper-session-defaults.yaml',
        QFA_PAPER_MARKET_DATA_SOURCE: 'local_obs_replay',
        QFA_PAPER_LOCAL_OBS_PATH: 'should-not-be-used.jsonl',
        QFA_BROKER_ADAPTER_KIND: 'rithmic',
        QFA_JOURNAL_DIR: 'journals/should-not-be-used',
      },
    });

    expect(config.paper_session_config_path).toBe(V2_PF_C_LATE_AM_PAPER_OBSERVATION_CONFIG_PATH);
    expect(config.strategy_id).toBe(V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID);
    expect(config.explicit_strategy_ids).toEqual([V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID]);
    expect(config.market_data_source).toBe('simulation');
    expect(config.adapter_kind).toBe('mock');
    expect(config.journal_dir).toBe('journals/paper/v2-pf-c-late-am-paper-observation');
  });

  it('creates a paper session for a registered-inactive strategy without active roster fallback', () => {
    const session = createV2PfCLateAmPaperObservationSession();

    expect(session.getDiagnostics()).toMatchObject({
      adapter_kind: 'mock',
      started: false,
      stopped: false,
    });
  });

  it('starts and evaluates exactly the target strategy through the paper runtime override', async () => {
    const session = createV2PfCLateAmPaperObservationSession();
    await session.start();
    const result = await session.processFeatureSnapshot(
      STRATEGY_SYNTHETIC_FIXTURES.regime_shock_reversion_short_v2_utc_16_18_exclusion.snapshot,
    );
    await session.stop();

    expect(result.strategy_evaluation_events.map((event) => event.payload.strategy_id)).toEqual([
      V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID,
    ]);
  });

  it('rejects paper-observation strategy overrides outside paper runtime mode', () => {
    const config = loadAppConfig({
      configPath: 'config/app.example.json',
      cwd: process.cwd(),
      env: { QFA_JOURNAL_DIR: 'journals/test-v2-pf-c-late-am-paper-observation' },
    });
    const container = createStrategyRuntimeEngineContainer({ config });

    expect(() => new StrategyRuntimeRunner({
      container,
      run_id: makeRunId('test-paper-observation-guard'),
      session_id: makeSessionId('test-paper-observation-guard-session'),
      execution_adapter: createSimulatedExecutionAdapter({ venue_costs: loadVenueCostTable() }),
      paper_observation_explicit_strategy_ids: [V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID],
    })).toThrow('paper_observation_explicit_strategy_ids may only be used with runtime_mode=paper');
  });

  it('rejects paper session configs where explicit strategy ids diverge from strategy_id', () => {
    expect(() => resolvePaperTradingSessionConfig({
      env: {},
      overrides: {
        strategy_id: V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID,
        explicit_strategy_ids: ['regime_shock_reversion_short_v2'],
      },
    })).toThrow('paper session explicit_strategy_ids must contain exactly the configured strategy_id');
  });
  it('fails closed when config omits the explicit strategy id', () => {
    withTempConfig([
      'session:',
      '  mode: paper',
      '  adapter_kind: mock',
      '  app_config_path: config/app.example.json',
      '  journal_dir: journals/paper/test',
      ...executionYaml(),
      ...observabilityYaml(),
    ], (configPath) => {
      expect(() => resolveV2PfCLateAmPaperObservationConfig({ config_path: configPath })).toThrow(
        'must declare $.session.strategy_id',
      );
    });
  });

  it('fails closed when config targets a different or missing strategy', () => {
    withTempConfig(paperConfigYaml({ strategy_id: 'regime_shock_reversion_short_v2' }), (configPath) => {
      expect(() => resolveV2PfCLateAmPaperObservationConfig({ config_path: configPath })).toThrow(
        `must be exactly ${V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID}`,
      );
    });
  });

  it('fails closed when config attempts multi-strategy ambiguity', () => {
    withTempConfig([
      'session:',
      `  strategy_id: ${V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID}`,
      '  strategy_ids: []',
      '  mode: paper',
      '  adapter_kind: mock',
      '  app_config_path: config/app.example.json',
      '  journal_dir: journals/paper/test',
      ...executionYaml(),
      ...observabilityYaml(),
    ], (configPath) => {
      expect(() => resolveV2PfCLateAmPaperObservationConfig({ config_path: configPath })).toThrow(
        '$.session.strategy_ids is not allowed',
      );
    });
  });

  it('fails closed when config requests broker/live adapter construction', () => {
    withTempConfig(paperConfigYaml({ adapter_kind: 'rithmic' }), (configPath) => {
      expect(() => resolveV2PfCLateAmPaperObservationConfig({ config_path: configPath })).toThrow(
        'broker/live adapters are not allowed',
      );
    });
  });
});

function withTempConfig(lines: readonly string[], callback: (configPath: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'qfa-paper-observation-'));
  try {
    const configPath = join(tempDir, 'paper-observation.yaml');
    writeFileSync(configPath, `${lines.join('\n')}\n`, 'utf8');
    callback(configPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function paperConfigYaml(
  overrides: {
    readonly strategy_id?: string;
    readonly adapter_kind?: string;
  } = {},
): readonly string[] {
  return [
    'session:',
    `  strategy_id: ${overrides.strategy_id ?? V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID}`,
    '  mode: paper',
    `  adapter_kind: ${overrides.adapter_kind ?? 'mock'}`,
    '  app_config_path: config/app.example.json',
    '  journal_dir: journals/paper/test',
    ...executionYaml(),
    ...observabilityYaml(),
  ];
}

function executionYaml(): readonly string[] {
  return [
    'execution:',
    '  plant_scope: ORDER_PLANT',
    '  capability_mask_id: execution-capability-mask-v1-adr0018-paper-only-order-plant',
    '  capability_mask_version: 1',
    '  reconnect_policy:',
    '    max_attempts: 3',
    '    initial_delay_ms: 250',
    '    max_delay_ms: 2000',
    '    retry_budget_ms: 10000',
    '    jitter: seeded',
    '  live_account_allowlist: []',
    '  live_account_verification_enabled: false',
    '  shutdown_quarantine_timeout_ms: 30000',
  ];
}

function observabilityYaml(): readonly string[] {
  return [
    'observability:',
    '  market_data_source: simulation',
    '  local_obs_replay_path: null',
    '  local_obs_replay_pace_mode: realtime',
    '  metrics:',
    '    enabled: false',
    '    host: 127.0.0.1',
    '    port: 0',
    '  slo_budgets_source: qfa-627-provisional-registry',
    '  slo_budget_overrides: {}',
  ];
}
