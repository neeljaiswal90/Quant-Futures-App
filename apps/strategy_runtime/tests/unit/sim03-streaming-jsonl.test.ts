import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forEachJsonlLine, sha256File } from '../../../../scripts/sim/streaming-jsonl.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03-streaming-jsonl-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03 streaming JSONL helpers', () => {
  it('matches read-all SHA-256 hashes on small files', () => {
    const path = join(makeTempDir(), 'fixture.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2}\n', 'utf8');

    expect(sha256File(path)).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'));
  });

  it('preserves multi-byte UTF-8 characters across chunk boundaries', () => {
    const path = join(makeTempDir(), 'unicode.jsonl');
    const first = JSON.stringify({ session_id: `session-${'a'.repeat(15)}é`, value: 1 });
    const second = JSON.stringify({ session_id: 'plain', value: 2 });
    writeFileSync(path, `${first}\n${second}\n`, 'utf8');
    const lines: string[] = [];

    forEachJsonlLine(path, (line) => lines.push(line), { chunkBytes: 16 });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { session_id: `session-${'a'.repeat(15)}é`, value: 1 },
      { session_id: 'plain', value: 2 },
    ]);
  });
});
