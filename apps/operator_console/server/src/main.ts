import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJournalIngestOptions } from './ingest/options.js';
import { selectJournalPath } from './ingest/journal-discovery.js';
import { resolveServerConfigFromEnv } from './runtime/config.js';

export function main(argv = process.argv.slice(2), env = process.env): void {
  const config = resolveServerConfigFromEnv(env);
  const ingestOptions = parseJournalIngestOptions(argv, env, findRepoRoot(process.cwd()));
  const journalSelection = selectJournalPath(ingestOptions);
  const mode = config.remote.enabled ? 'remote' : 'loopback';
  console.log(
    [
      'operator-console-server ready',
      `bind=${config.bind_address}`,
      `mode=${mode}`,
      `auth=${config.remote.auth_required ? 'required' : 'not_required'}`,
      `journal=${journalSelection.journal_path}`,
      `journal_source=${journalSelection.source}`,
      `candidate_count=${journalSelection.candidate_count}`,
    ].join(' '),
  );
}

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(current, 'package.json'), 'utf8')) as {
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

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
