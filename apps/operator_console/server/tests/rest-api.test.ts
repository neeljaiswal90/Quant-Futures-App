import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJournalBackedRestDataSource,
  createOperatorConsoleRestServer,
  type ConsoleRestDataSource,
} from '../src/transport/rest.js';
import { resolveServerConfigFromEnv, type OperatorConsoleServerConfig } from '../src/runtime/config.js';
import type { JournalIngestOptions } from '../src/ingest/options.js';

const tempDirs: string[] = [];
const servers: Server[] = [];
const repoRoot = findRepoRoot(process.cwd());
const fixturePath = resolve(repoRoot, 'apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl');

type MinimalJournalEvent = {
  readonly schema_version: 1;
  readonly event_id: string;
  readonly type: string;
  readonly ts_ns: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly causation_id?: string;
  readonly payload: Record<string, unknown>;
};

function makeJournalLine(event: Omit<MinimalJournalEvent, 'schema_version'>): string {
  return JSON.stringify({
    schema_version: 1,
    ...event,
  });
}

function appendJournalLines(journal: string, lines: readonly string[]): void {
  if (lines.length === 0) {
    return;
  }
  appendFileSync(journal, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'a' });
}

function findFixture(relativePath: string): string | null {
  const absolute = resolve(repoRoot, relativePath);
  return existsSync(absolute) ? absolute : null;
}

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (manifest.name === 'quant-futures-app') {
        return current;
      }
    } catch {
      // Keep walking.
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      throw new Error('Unable to find quant-futures-app repo root');
    }
    current = parent;
  }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'operator-console-rest-'));
  tempDirs.push(root);
  return root;
}

function fixtureJournal(root: string): string {
  const journal = join(root, 'rel00_controlled_live_sim_journal.jsonl');
  writeFileSync(journal, readFileSync(fixturePath, 'utf8'), 'utf8');
  return journal;
}

function ingestOptions(root: string, journal: string): JournalIngestOptions {
  return {
    journal,
    journal_glob: 'rel00_controlled_live_sim_journal*.jsonl',
    checkpoint_dir: join(root, 'console-checkpoints'),
    mode: 'replay',
    poll_ms: 250,
  };
}

async function startServerWithDataSource(
  config: OperatorConsoleServerConfig,
  dataSource: ConsoleRestDataSource,
): Promise<string> {
  const server = createOperatorConsoleRestServer({
    config,
    data_source: dataSource,
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function startServer(config: OperatorConsoleServerConfig, root: string, journal: string): Promise<string> {
  return startServerWithDataSource(config, createJournalBackedRestDataSource({
    journal_path: journal,
    ingest_options: ingestOptions(root, journal),
    redact_journal_path: config.remote.enabled,
  }));
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('operator console REST API', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    })));
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serves health, snapshot, and panel history without raw journal envelopes', async () => {
    const root = tempRoot();
    const journal = fixtureJournal(root);
    const baseUrl = await startServer(resolveServerConfigFromEnv({}), root, journal);

    const preflight = await fetch(`${baseUrl}/snapshot`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('GET');

    const health = await readJson(await fetch(`${baseUrl}/healthz`));
    expect(health.status).toBe('ok');
    expect(health.schema_version).toBe(1);
    expect(health.server_status).toBe('running');
    expect(typeof health.uptime_ms).toBe('number');
    expect(health.event_count).toBeUndefined();

    const snapshot = await readJson(await fetch(`${baseUrl}/snapshot`));
    expect(snapshot.schema_version).toBe(1);
    expect((snapshot.generated_from as Record<string, unknown>).journal_path_redacted).toBe(false);
    expect((snapshot.generated_from as Record<string, unknown>).event_count).toBe(24);

    const history = await readJson(await fetch(`${baseUrl}/history?panel=trades&limit=2&range=PT1H`));
    expect(history.panel).toBe('trades');
    expect(history.limit).toBe(2);
    const rows = history.rows as unknown[];
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain('"payload"');
    expect(serialized).not.toContain('"event"');
    expect(serialized).not.toContain('schema_version');
  });

  it('rejects malformed ranges and unsupported panels with 400', async () => {
    const root = tempRoot();
    const journal = fixtureJournal(root);
    const baseUrl = await startServer(resolveServerConfigFromEnv({}), root, journal);

    const badRange = await fetch(`${baseUrl}/history?panel=trades&range=5m`);
    expect(badRange.status).toBe(400);
    expect((await readJson(badRange)).message).toContain('ISO-8601');

    const badPanel = await fetch(`${baseUrl}/history?panel=raw_journal&range=PT5M`);
    expect(badPanel.status).toBe(400);
    expect((await readJson(badPanel)).message).toContain('unsupported history panel');
  });

  it('defaults history limit to 100 and caps requested limit at 1000', async () => {
    const root = tempRoot();
    const journal = fixtureJournal(root);
    const baseUrl = await startServer(resolveServerConfigFromEnv({}), root, journal);

    const defaulted = await readJson(await fetch(`${baseUrl}/history?panel=alerts`));
    expect(defaulted.limit).toBe(100);

    const capped = await readJson(await fetch(`${baseUrl}/history?panel=alerts&limit=5000`));
    expect(capped.limit).toBe(1000);
  });

  it('requires remote bearer auth and redacts journal paths', async () => {
    const root = tempRoot();
    const journal = fixtureJournal(root);
    const config = resolveServerConfigFromEnv({
      QFA_CONSOLE_BIND: '0.0.0.0',
      OPERATOR_CONSOLE_ALLOW_REMOTE: 'true',
      OPERATOR_CONSOLE_AUTH_TOKEN: 'secret',
      OPERATOR_CONSOLE_ORIGIN_ALLOWLIST: 'https://ops.example',
    });
    const baseUrl = await startServer(config, root, journal);

    expect((await fetch(`${baseUrl}/snapshot`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: 'Bearer secret', Origin: 'https://evil.example' },
    })).status).toBe(403);

    const ok = await fetch(`${baseUrl}/snapshot`, {
      headers: { Authorization: 'Bearer secret', Origin: 'https://ops.example' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://ops.example');
    const snapshot = await readJson(ok);
    const generatedFrom = snapshot.generated_from as Record<string, unknown>;
    expect(generatedFrom.journal_path_redacted).toBe(true);
    expect(generatedFrom.journal_path).not.toBe(journal);
    expect(String(generatedFrom.journal_path)).toContain('journal:');
  });

  it('serves health without remote auth or journal refresh', async () => {
    let refreshCalled = false;
    const config = resolveServerConfigFromEnv({
      QFA_CONSOLE_BIND: '0.0.0.0',
      OPERATOR_CONSOLE_ALLOW_REMOTE: 'true',
      OPERATOR_CONSOLE_AUTH_TOKEN: 'secret',
      OPERATOR_CONSOLE_ORIGIN_ALLOWLIST: 'https://ops.example',
    });
    const baseUrl = await startServerWithDataSource(config, {
      refresh: () => {
        refreshCalled = true;
        throw new Error('healthz must not refresh journal state');
      },
      history: () => {
        throw new Error('history must not be reached');
      },
    });

    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect((await readJson(response)).status).toBe('ok');
    expect(refreshCalled).toBe(false);
  });

  it('handles CORS preflight for remote allowed origins only', async () => {
    const root = tempRoot();
    const journal = fixtureJournal(root);
    const config = resolveServerConfigFromEnv({
      QFA_CONSOLE_BIND: '0.0.0.0',
      OPERATOR_CONSOLE_ALLOW_REMOTE: 'true',
      OPERATOR_CONSOLE_AUTH_TOKEN: 'secret',
      OPERATOR_CONSOLE_ORIGIN_ALLOWLIST: 'https://ops.example',
    });
    const baseUrl = await startServer(config, root, journal);

    const ok = await fetch(`${baseUrl}/snapshot`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://ops.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization',
      },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://ops.example');
    expect(ok.headers.get('access-control-allow-methods')).toContain('GET');
    expect(ok.headers.get('access-control-allow-headers')).toContain('Authorization');

    const denied = await fetch(`${baseUrl}/snapshot`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(denied.status).toBe(403);
  });

  it('bounds panel history rows to prevent unbounded in-process growth', () => {
    const root = tempRoot();
    const journal = join(root, 'bounded-growth-journal.jsonl');
    writeFileSync(journal, '', 'utf8');
    const dataSource = createJournalBackedRestDataSource({
      journal_path: journal,
      ingest_options: ingestOptions(root, journal),
      max_history_rows_per_panel: 40,
    });

    for (let index = 0; index < 120; index += 1) {
    appendJournalLines(journal, [
      makeJournalLine({
        event_id: `position-${index}`,
        type: 'POSITION',
        ts_ns: (1_700_000_000_000_000_000n + BigInt(index)).toString(10),
        run_id: 'run-console-04a',
        session_id: 'session-console-04a',
        causation_id: `cause-position-${index}`,
        payload: {
          position_id: `position-${index}`,
          candidate_id: 'candidate-1',
          side: 'long',
          status: 'open',
          quantity_open: 1,
          avg_entry_price: 100 + index,
          updated_ts_ns: (1_700_000_000_000_000_001n + BigInt(index)).toString(10),
        },
      }),
      ]);
      dataSource.refresh();
    }

    const history = dataSource.history(new URLSearchParams('panel=trades&limit=1000'));
    expect(history.panel).toBe('trades');
    expect(history.rows).toHaveLength(40);
  });

  it('surfaces malformed rows while keeping /snapshot available', async () => {
    const root = tempRoot();
    const journal = join(root, 'malformed-journal.jsonl');
    appendJournalLines(journal, [
      makeJournalLine({
        event_id: 'session-phase-1',
        type: 'SESSION_PHASE',
        ts_ns: '1700000000000000000',
        run_id: 'run-console-04a',
        session_id: 'session-console-04a',
        causation_id: 'cause-session-phase-1',
        payload: {
          phase: 'rth',
          trading_date: '2026-04-23',
        },
      }),
      '{malformed-json',
      JSON.stringify({
        schema_version: 1,
        event_id: 'position-bad-schema',
        type: 'POSITION',
        ts_ns: '1700000000000000001',
        run_id: 'run-console-04a',
        session_id: 'session-console-04a',
        causation_id: 'cause-position-bad-schema',
        payload: { status: 'open' },
      }),
    ]);
    const baseUrl = await startServer(resolveServerConfigFromEnv({}), root, journal);

    const snapshot = await readJson(await fetch(`${baseUrl}/snapshot`));
    const dataPipeline = snapshot.data_pipeline as {
      malformed_or_schema_invalid_count: number;
    };
    const alerts = snapshot.alerts as ReadonlyArray<{ readonly id: string }>;

    expect(dataPipeline.malformed_or_schema_invalid_count).toBe(2);
    expect(alerts.some((alert) => alert.id.startsWith('malformed-or-schema-invalid:'))).toBe(true);
  });

  it('includes feature-surface violations in alert stream and panel state', async () => {
    const root = tempRoot();
    const journal = join(root, 'feature-violation-journal.jsonl');
    appendJournalLines(journal, [
      makeJournalLine({
        event_id: 'features-violation-1',
        type: 'FEATURES',
        ts_ns: '1700000001000000000',
        run_id: 'run-console-04a',
        session_id: 'session-console-04a',
        causation_id: 'cause-features-violation-1',
        payload: {
          feature_snapshot_id: 'snapshot-04a',
          values: {
            queue_position: 1,
          },
        },
      }),
    ]);
    const baseUrl = await startServer(resolveServerConfigFromEnv({}), root, journal);

    const snapshot = await readJson(await fetch(`${baseUrl}/snapshot`));
    const featureSurface = snapshot.feature_surface as {
      recent_violations: readonly { readonly id: string; readonly severity: string }[];
    };
    const alerts = snapshot.alerts as ReadonlyArray<{ readonly id: string }>;

    expect(featureSurface.recent_violations.length).toBeGreaterThan(0);
    expect(alerts.some((alert) => alert.id.startsWith('feature-policy-'))).toBe(true);
  });

  it('keeps realized P&L unavailable when no explicit lifecycle fact is present', async () => {
    const root = tempRoot();
    const journal = join(root, 'no-realized-pnl-fact-journal.jsonl');
    appendJournalLines(journal, [
      makeJournalLine({
        event_id: 'position-closed-1',
        type: 'POSITION',
        ts_ns: '1700000002000000000',
        run_id: 'run-console-04a',
        session_id: 'session-console-04a',
        causation_id: 'cause-position-closed-1',
        payload: {
          position_id: 'position-1',
          candidate_id: 'candidate-1',
          side: 'long',
          status: 'closed',
          quantity_open: 0,
          avg_entry_price: 99,
          updated_ts_ns: '1700000002000000000',
        },
      }),
    ]);
    const baseUrl = await startServer(resolveServerConfigFromEnv({}), root, journal);

    const snapshot = await readJson(await fetch(`${baseUrl}/snapshot`));
    const pnl = snapshot.pnl as {
      realized_pnl_usd: { readonly status: string; readonly value?: number };
      source: string;
    };
    const positions = snapshot.positions as ReadonlyArray<{
      position_id: string;
      realized_pnl_usd: { readonly status: string };
    }>;

    expect(pnl.realized_pnl_usd.status).toBe('unavailable');
    expect(pnl.source).toBe('unavailable');
    expect(positions[0]?.position_id).toBe('position-1');
    expect(positions[0]?.realized_pnl_usd.status).toBe('unavailable');
  });

  const optionalFixtures = [
    {
      label: 'REL-00A transport mini-journal',
      path: 'reports/rel/rel00a/fixture-transport/mini-journal.jsonl',
    },
    {
      label: 'REL-01 short packet controlled live-sim journal',
      path: 'reports/rel/rel01_short_packet_current/rel00_controlled_live_sim_journal.jsonl',
    },
    {
      label: 'MBO shadow diagnostic journal',
      path: 'reports/rel/orch_mbo01_smoke_20260429_211947/diagnostic_current_main/rel00_controlled_live_sim_shadow_journal.jsonl',
    },
  ] as const;

  for (const entry of optionalFixtures) {
    const fixture = findFixture(entry.path);
    if (fixture === null) {
      it.todo(`fixture unavailable locally: ${entry.label} (${entry.path})`);
      continue;
    }

    it(`reads ${entry.label} without raw journal exposure`, async () => {
      const baseUrl = await startServer(resolveServerConfigFromEnv({}), tempRoot(), fixture);
      const snapshot = await readJson(await fetch(`${baseUrl}/snapshot`));
      const history = await readJson(await fetch(`${baseUrl}/history?panel=trades&limit=3`));
      expect(snapshot.schema_version).toBe(1);
      expect(Array.isArray(history.rows)).toBe(true);
    });
  }

  const largeFixture = process.env.OPERATOR_CONSOLE_VERIFY_600K_FIXTURE?.trim();
  if (largeFixture !== undefined && largeFixture.length > 0 && existsSync(largeFixture)) {
    it('reads a local 600k+ REL journal fixture and remains bounded', async () => {
      const baseUrl = await startServer(resolveServerConfigFromEnv({}), tempRoot(), resolve(largeFixture));
      const snapshot = await readJson(await fetch(`${baseUrl}/snapshot`));
      expect((snapshot.generated_from as Record<string, unknown>).event_count).toBeGreaterThanOrEqual(
        600_000,
      );
    });
  } else {
    it.todo(
      'set OPERATOR_CONSOLE_VERIFY_600K_FIXTURE to a 600k+ journal file to run the long-session verification',
    );
  }
});
