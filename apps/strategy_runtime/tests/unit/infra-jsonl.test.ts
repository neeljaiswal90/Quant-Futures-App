import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forEachJsonlLine, parseJsonlLine } from '../../../../scripts/infra/jsonl.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-jsonl-'));
  tempDirectories.push(directory);
  return directory;
}

describe('infra streaming JSONL helper', () => {
  it('streams non-empty JSONL lines across small chunk boundaries with stable line numbers', () => {
    const path = join(makeTempDir(), 'records.jsonl');
    writeFileSync(path, '{"a":1}\r\n\n{"b":2}\n{"c":"long-value"}\n', 'utf8');
    const seen: { line: string; lineNumber: number }[] = [];

    forEachJsonlLine(
      path,
      (line, lineNumber) => {
        seen.push({ line, lineNumber });
      },
      5,
    );

    expect(seen).toEqual([
      { line: '{"a":1}', lineNumber: 1 },
      { line: '{"b":2}', lineNumber: 3 },
      { line: '{"c":"long-value"}', lineNumber: 4 },
    ]);
  });

  it('parses JSONL lines with labeled errors', () => {
    expect(parseJsonlLine('{"ok":true}', 7, 'probe')).toEqual({ ok: true });
    expect(() => parseJsonlLine('{bad', 9, 'probe')).toThrow(/probe line 9: invalid JSON/);
  });
});
