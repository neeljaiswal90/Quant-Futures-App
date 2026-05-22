import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRunId, makeSessionId } from '../../src/contracts/index.js';
import {
  PaperTradingSession,
  resolvePaperTradingSessionConfig,
  type PaperTradingSessionOptions,
} from '../../src/paper-trading/index.js';

const RUN_ID = makeRunId('run-qfa-633-shadow-replay-harness');
const SESSION_ID = makeSessionId('session-qfa-633-shadow-replay-harness');
const FIXTURE_PATH = join(process.cwd(), 'apps/strategy_runtime/tests/fixtures/obs-replay-sample.jsonl');
const BASE_OPTIONS = {
  config: {
    run_id: RUN_ID,
    session_id: SESSION_ID,
    metrics_endpoint: { enabled: false, port: 0 },
    journal_dir: 'journals/test-qfa-633-shadow-replay',
    shutdown_quarantine_timeout_ms: 0,
  },
} satisfies Partial<PaperTradingSessionOptions>;

describe('QFA-633 local OBS replay paper harness wiring', () => {
  it('parses local OBS replay config from env', () => {
    const config = resolvePaperTradingSessionConfig({
      env: {
        QFA_PAPER_MARKET_DATA_SOURCE: 'local_obs_replay',
        QFA_PAPER_LOCAL_OBS_PATH: FIXTURE_PATH,
        QFA_PAPER_LOCAL_OBS_PACE_MODE: 'as_fast_as_possible',
      },
    });

    expect(config).toMatchObject({
      market_data_source: 'local_obs_replay',
      local_obs_replay_path: FIXTURE_PATH,
      local_obs_replay_pace_mode: 'as_fast_as_possible',
      adapter_kind: 'mock',
    });
  });

  it('replays local OBS events through paper mode with the mock broker invariant', async () => {
    const session = new PaperTradingSession({
      ...BASE_OPTIONS,
      config: {
        ...BASE_OPTIONS.config,
        market_data_source: 'local_obs_replay',
        local_obs_replay_path: FIXTURE_PATH,
        local_obs_replay_pace_mode: 'as_fast_as_possible',
        adapter_kind: 'mock',
      },
    });

    await session.start();
    await session.stop();

    expect(session.events.filter((event) => event.type === 'QUOTE').length).toBeGreaterThan(0);
    expect(session.events.filter((event) => event.type === 'TRADE').length).toBeGreaterThan(0);
    expect(session.events.find((event) => event.type === 'SESSION_MANIFEST')).toMatchObject({
      payload: {
        mode: 'paper',
        adapter_kind: 'MOCK_ORDER_PLANT',
        market_data_source: 'local_obs_replay',
      },
    });
    expect(session.getDiagnostics()).toMatchObject({
      adapter_kind: 'mock',
      market_data_source: 'local_obs_replay',
      local_obs_replay_pace_mode: 'as_fast_as_possible',
    });
  });

  it('fails closed without a local OBS path', () => {
    expect(() => new PaperTradingSession({
      config: {
        ...BASE_OPTIONS.config,
        market_data_source: 'local_obs_replay',
        adapter_kind: 'mock',
      },
    })).toThrow('QFA_PAPER_LOCAL_OBS_PATH is required');
  });

  it('fails closed if local OBS replay is paired with the future real adapter', () => {
    expect(() => new PaperTradingSession({
      config: {
        ...BASE_OPTIONS.config,
        market_data_source: 'local_obs_replay',
        local_obs_replay_path: FIXTURE_PATH,
        adapter_kind: 'rithmic',
      },
    })).toThrow('local_obs_replay shadow mode requires QFA_BROKER_ADAPTER_KIND=mock');
  });
});
