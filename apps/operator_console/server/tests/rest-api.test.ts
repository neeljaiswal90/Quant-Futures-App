import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});
