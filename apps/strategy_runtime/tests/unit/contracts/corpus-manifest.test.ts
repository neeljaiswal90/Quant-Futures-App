// Module under test: contracts/corpus-manifest and config/corpus-manifest-loader; ticket QFA-101.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { computeManifestHash } from '../../../src/contracts/index.js';
import {
  ConfigValidationError,
  loadCorpusManifest,
  loadCorpusManifestWithWarnings,
} from '../../../src/config/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const tierAArchiveRoot = 'D:/qfa-cache/databento/tier-a-feb-mar-2026';
const realManifestPaths = [
  `${tierAArchiveRoot}/manifest-feb-2026.json`,
  `${tierAArchiveRoot}/manifest-mar-2026.json`,
] as const;
const fixturePath = join(
  repoRoot,
  'apps/strategy_runtime/tests/fixtures/corpus-manifests/minimal-valid.json',
);
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('QFA-101 corpus manifest contract', () => {
  it('loads both Tier A Python-emitted manifests without errors', () => {
    for (const manifestPath of realManifestPaths) {
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = loadCorpusManifest(manifestPath);

      expect(manifest.manifest_schema_version).toBe(1);
      expect(manifest.ticket_id).toBe('SIM-03A-1');
      expect(manifest.sessions.length).toBeGreaterThan(0);
      expect(manifest.event_schemas).toEqual(['trades', 'mbp-1', 'mbp-10', 'mbo']);
      expect(Object.keys(manifest.sessions[0].schemas).sort()).toEqual([
        'definition',
        'mbo',
        'mbp-1',
        'mbp-10',
        'trades',
      ]);
    }
  });

  it('parses all sessions from the real manifests', () => {
    const feb = loadCorpusManifest(realManifestPaths[0]);
    const mar = loadCorpusManifest(realManifestPaths[1]);

    expect(feb.sessions).toHaveLength(19);
    expect(feb.sessions[0]).toMatchObject({
      session_id: '2026-02-27-rth',
      symbol: 'MNQH6',
      status: 'complete',
    });
    expect(mar.sessions).toHaveLength(22);
    expect(mar.sessions[0]).toMatchObject({
      session_id: '2026-03-31-rth',
      symbol: 'MNQM6',
      status: 'complete',
    });
  });

  it('preserves per-file fields and optional sha256 values without trimming', () => {
    const realManifest = loadCorpusManifest(realManifestPaths[0]);
    const realMbo = realManifest.sessions[0].schemas.mbo;

    expect(realMbo).toMatchObject({
      attempts: 1,
      byte_count: 601356775,
      path: 'D:\\qfa-cache\\databento\\tier-a-feb-mar-2026\\2026-02-27-rth\\mbo.dbn.zst',
      record_count: null,
      reused_existing: false,
      schema: 'mbo',
      status: 'available',
    });
    expect(realMbo.sha256).toBeUndefined();

    const fixture = loadCorpusManifest(fixturePath);
    expect(fixture.sessions[0].schemas.mbo.sha256).toBe(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
  });

  it('computes a stable hash across repeated loads', () => {
    const first = loadCorpusManifest(realManifestPaths[1]);
    const second = loadCorpusManifest(realManifestPaths[1]);

    expect(computeManifestHash(first)).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeManifestHash(first)).toBe(computeManifestHash(second));
  });

  it('computes the same hash regardless of JSON formatting or key order', () => {
    const directory = makeTempDirectory();
    const original = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
    const compactPath = join(directory, 'compact.json');
    const reorderedPath = join(directory, 'reordered.json');
    writeFileSync(compactPath, JSON.stringify(original), 'utf8');
    writeFileSync(reorderedPath, `${JSON.stringify(reverseObjectKeys(original), null, 2)}\n`, 'utf8');

    expect(computeManifestHash(loadCorpusManifest(compactPath))).toBe(
      computeManifestHash(loadCorpusManifest(reorderedPath)),
    );
  });

  it('is path-agnostic for identical manifest contents', () => {
    const directory = makeTempDirectory();
    const firstPath = join(directory, 'first', 'manifest.json');
    const secondPath = join(directory, 'second', 'renamed-manifest.json');
    const text = readFileSync(fixturePath, 'utf8');
    writeNestedFile(firstPath, text);
    writeNestedFile(secondPath, text);

    expect(computeManifestHash(loadCorpusManifest(firstPath))).toBe(
      computeManifestHash(loadCorpusManifest(secondPath)),
    );
  });

  it('rejects malformed manifests with descriptive errors', () => {
    const malformed = readFixtureObject();
    delete (malformed as Record<string, unknown>).sessions;
    const path = writeTempManifest('missing-sessions.json', malformed);

    expect(() => loadCorpusManifest(path)).toThrow(ConfigValidationError);
    try {
      loadCorpusManifest(path);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain('manifest.sessions');
    }
  });

  it('rejects invalid per-file sha256 fields with the exact issue path', () => {
    const malformed = readFixtureObject();
    const session = manifestSession(malformed);
    session.schemas.mbo.sha256 = 'not-a-sha';
    const path = writeTempManifest('bad-sha.json', malformed);

    expect(() => loadCorpusManifest(path)).toThrow(ConfigValidationError);
    try {
      loadCorpusManifest(path);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain(
        'manifest.sessions.0.schemas.mbo.sha256',
      );
    }
  });

  it('surfaces unknown fields as warnings while preserving them', () => {
    const manifest = readFixtureObject() as Record<string, unknown>;
    manifest.future_manifest_field = 'preserved';
    const path = writeTempManifest('unknown-field.json', manifest);
    const loaded = loadCorpusManifestWithWarnings(path);

    expect(loaded.warnings).toContainEqual({
      path: 'manifest.future_manifest_field',
      message: 'unknown field preserved',
    });
    expect((loaded.manifest as unknown as Record<string, unknown>).future_manifest_field).toBe(
      'preserved',
    );
  });
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-corpus-manifest-'));
  tempDirectories.push(directory);
  return directory;
}

function writeNestedFile(path: string, text: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, text, { encoding: 'utf8', flag: 'w' });
  expect(existsSync(directory)).toBe(true);
}

function writeTempManifest(fileName: string, manifest: unknown): string {
  const path = join(makeTempDirectory(), fileName);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
}

function readFixtureObject(): unknown {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
}

function manifestSession(value: unknown): {
  readonly schemas: Record<string, Record<string, unknown>>;
} {
  const manifest = value as { readonly sessions: Array<{ readonly schemas: Record<string, Record<string, unknown>> }> };
  return manifest.sessions[0];
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .reverse()
        .map((key) => [key, reverseObjectKeys(record[key])]),
    );
  }
  return value;
}
