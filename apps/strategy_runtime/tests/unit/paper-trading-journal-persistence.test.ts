import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  journalEventFromJsonLine,
  journalEventToJsonLine,
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  type AnyJournalEventEnvelope,
} from '../../src/contracts/index.js';
import { validateJournalEventEnvelope } from '../../src/contracts/events/schema.js';
import {
  PaperTradingSession,
  resolvePaperTradingSessionConfig,
  type PaperTradingSessionOptions,
} from '../../src/paper-trading/index.js';

const RUN_ID = makeRunId('run-qfa-633-journal-persistence');
const SESSION_ID = makeSessionId('session-qfa-633-journal-persistence');
const FIXTURE_PATH = join(process.cwd(), 'apps/strategy_runtime/tests/fixtures/obs-replay-sample.jsonl');
const BASE_OPTIONS = {
  config: {
    run_id: RUN_ID,
    session_id: SESSION_ID,
    metrics_endpoint: { enabled: false, port: 0 },
    shutdown_quarantine_timeout_ms: 0,
  },
} satisfies Partial<PaperTradingSessionOptions>;

describe('QFA-633 journal persistence wiring', () => {
  it('materializes local OBS replay JSONL with round-trip-valid events in fast pace mode', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qfa-633-journal-fast-'));
    try {
      const journalDir = join(tempDir, 'journal');
      const session = new PaperTradingSession({
        ...BASE_OPTIONS,
        config: {
          ...BASE_OPTIONS.config,
          journal_dir: journalDir,
          market_data_source: 'local_obs_replay',
          local_obs_replay_path: FIXTURE_PATH,
          local_obs_replay_pace_mode: 'as_fast_as_possible',
          adapter_kind: 'mock',
        },
      });

      await session.start();
      await session.stop();

      const persisted = readPersistedJournalEvents(journalDir);
      expect(persisted).toHaveLength(session.getDiagnostics().event_count);
      expect(persisted.filter((event) => event.type === 'QUOTE').length).toBeGreaterThan(0);
      expect(persisted.filter((event) => event.type === 'TRADE').length).toBeGreaterThan(0);
      expect(persisted.filter((event) => event.type === 'SESSION_MANIFEST')).toHaveLength(2);
      expect(session.getDiagnostics().journal_path).toBeDefined();
      for (const event of persisted) {
        expect(validateJournalEventEnvelope(event).issues).toEqual([]);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('materializes local OBS replay JSONL in realtime pace mode', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qfa-633-journal-realtime-'));
    try {
      const replayPath = writeTinyObsReplayFixture(tempDir);
      const journalDir = join(tempDir, 'journal');
      const session = new PaperTradingSession({
        ...BASE_OPTIONS,
        config: {
          ...BASE_OPTIONS.config,
          journal_dir: journalDir,
          market_data_source: 'local_obs_replay',
          local_obs_replay_path: replayPath,
          local_obs_replay_pace_mode: 'realtime',
          adapter_kind: 'mock',
        },
      });

      await session.start();
      await sleep(0);
      await session.stop();

      const persisted = readPersistedJournalEvents(journalDir);
      expect(persisted.filter((event) => event.type === 'QUOTE')).toHaveLength(1);
      expect(persisted.filter((event) => event.type === 'TRADE')).toHaveLength(1);
      expect(persisted.filter((event) => event.type === 'SESSION_MANIFEST')).toHaveLength(2);
      expect(persisted).toHaveLength(session.getDiagnostics().event_count);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates the configured journal directory when it does not exist', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qfa-633-journal-mkdir-'));
    try {
      const journalDir = join(tempDir, 'nested', 'journal');
      expect(existsSync(journalDir)).toBe(false);
      const session = new PaperTradingSession({
        ...BASE_OPTIONS,
        config: {
          ...BASE_OPTIONS.config,
          journal_dir: journalDir,
          market_data_source: 'simulation',
          adapter_kind: 'mock',
        },
      });

      await session.start();
      await session.stop();

      expect(existsSync(journalDir)).toBe(true);
      expect(readPersistedJournalEvents(journalDir).filter((event) => event.type === 'SESSION_MANIFEST')).toHaveLength(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves journal_dir precedence across env, YAML, and override config', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qfa-633-journal-precedence-'));
    try {
      const yamlJournalDir = join(tempDir, 'yaml-journal');
      const envJournalDir = join(tempDir, 'env-journal');
      const overrideJournalDir = join(tempDir, 'override-journal');
      const yamlPath = join(tempDir, 'paper.yaml');
      writeFileSync(yamlPath, [
        'session:',
        '  strategy_id: regime_shock_reversion_short_v2',
        '  mode: paper',
        '  adapter_kind: mock',
        '  app_config_path: config/app.example.json',
        `  journal_dir: ${yamlJournalDir}`,
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
        '  shutdown_quarantine_timeout_ms: 0',
        'observability:',
        '  market_data_source: simulation',
        '  metrics:',
        '    enabled: false',
        '    host: 127.0.0.1',
        '    port: 0',
        '  slo_budgets_source: qfa-627-provisional-registry',
        '  slo_budget_overrides: {}',
        '',
      ].join('\n'));

      const envConfig = resolvePaperTradingSessionConfig({
        env: {
          QFA_PAPER_SESSION_CONFIG: yamlPath,
          QFA_JOURNAL_DIR: envJournalDir,
        },
      });
      expect(envConfig.journal_dir).toBe(envJournalDir);
      const envSession = new PaperTradingSession({
        env: {
          QFA_PAPER_SESSION_CONFIG: yamlPath,
          QFA_JOURNAL_DIR: envJournalDir,
        },
      });
      await envSession.start();
      await envSession.stop();
      expect(readPersistedJournalEvents(envJournalDir)).toHaveLength(envSession.getDiagnostics().event_count);
      expect(existsSync(yamlJournalDir)).toBe(false);

      const overrideConfig = resolvePaperTradingSessionConfig({
        env: { QFA_JOURNAL_DIR: envJournalDir },
        overrides: {
          ...BASE_OPTIONS.config,
          journal_dir: overrideJournalDir,
        },
      });
      expect(overrideConfig.journal_dir).toBe(overrideJournalDir);
      const overrideSession = new PaperTradingSession({
        ...BASE_OPTIONS,
        env: { QFA_JOURNAL_DIR: envJournalDir },
        config: {
          ...BASE_OPTIONS.config,
          journal_dir: overrideJournalDir,
        },
      });
      await overrideSession.start();
      await overrideSession.stop();
      expect(readPersistedJournalEvents(overrideJournalDir)).toHaveLength(
        overrideSession.getDiagnostics().event_count,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function readPersistedJournalEvents(journalDir: string): AnyJournalEventEnvelope[] {
  const journalFiles = readdirSync(journalDir)
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .sort();
  expect(journalFiles).toHaveLength(1);
  const text = readFileSync(join(journalDir, journalFiles[0]!), 'utf8');
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => journalEventFromJsonLine(line) as AnyJournalEventEnvelope);
}

function writeTinyObsReplayFixture(directory: string): string {
  const runId = makeRunId('qfa-633-persistence-source-run');
  const sessionId = makeSessionId('qfa-633-persistence-source-session');
  const tsNs = ns(1_800_000_000_000_000_000n);
  const path = join(directory, 'tiny.obs01.jsonl');
  const quote = createJournalEventEnvelope({
    event_id: makeEventId('qfa-633-persistence-source-quote'),
    type: 'QUOTE',
    ts_ns: tsNs,
    run_id: runId,
    session_id: sessionId,
    payload: {
      exchange_event_ts_ns: tsNs,
      sidecar_recv_ts_ns: ns(BigInt(tsNs) + 1_000_000n),
      bid_px: 29250,
      bid_qty: 3,
      ask_px: 29250.25,
      ask_qty: 2,
      authority: 'authoritative',
    },
  });
  const trade = createJournalEventEnvelope({
    event_id: makeEventId('qfa-633-persistence-source-trade'),
    type: 'TRADE',
    ts_ns: tsNs,
    run_id: runId,
    session_id: sessionId,
    payload: {
      exchange_event_ts_ns: tsNs,
      sidecar_recv_ts_ns: ns(BigInt(tsNs) + 2_000_000n),
      trade_id: 'qfa-633-persistence-trade',
      price: 29250.25,
      quantity: 1,
      aggressor_side: 'buy',
    },
  });
  writeFileSync(path, `${journalEventToJsonLine(quote)}\n${journalEventToJsonLine(trade)}\n`, 'utf8');
  return path;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
