// Module under test: config/simple-yaml; ticket QFA-114.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigValidationError } from '../../src/config/index.js';
import { parseSimpleYaml } from '../../src/config/simple-yaml.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtureDir = join(repoRoot, 'apps/strategy_runtime/tests/fixtures/simple-yaml');
const tsConsumedSnapshotDir = join(
  repoRoot,
  'apps/strategy_runtime/tests/snapshots/simple-yaml/ts-consumed',
);
const configRoot = join(repoRoot, 'config');

function snapshotBaseName(relativePath: string): string {
  return relativePath.split('/').join('__').replace(/\.yaml$/u, '.json');
}

function walkYamlFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) {
        stack.push(full);
      } else if (info.isFile() && entry.endsWith('.yaml')) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

describe('QFA-114 simple-yaml block sequences', () => {
  describe('sequence of scalars', () => {
    it('parses a flat list of scalar entries to a readonly array', () => {
      const yaml = 'symbols:\n  - MNQM6\n  - MNQH6\n  - MNQU6\n';
      const parsed = parseSimpleYaml(yaml, '<inline>') as Record<string, unknown>;
      expect(parsed.symbols).toEqual(['MNQM6', 'MNQH6', 'MNQU6']);
    });

    it('parses scalars with mixed types (strings, numbers, booleans, null)', () => {
      const yaml = 'mixed:\n  - text\n  - 42\n  - 3.14\n  - true\n  - null\n  - "quoted"\n';
      const parsed = parseSimpleYaml(yaml, '<inline>') as Record<string, unknown>;
      expect(parsed.mixed).toEqual(['text', 42, 3.14, true, null, 'quoted']);
    });
  });

  describe('sequence of maps', () => {
    it('parses each entry to a separate map with all its keys', () => {
      const yaml =
        'events:\n'
        + '  - event_id: a\n'
        + '    category: FOMC\n'
        + '  - event_id: b\n'
        + '    category: CPI\n';
      const parsed = parseSimpleYaml(yaml, '<inline>') as { events: Array<Record<string, unknown>> };
      expect(parsed.events).toEqual([
        { event_id: 'a', category: 'FOMC' },
        { event_id: 'b', category: 'CPI' },
      ]);
    });

    it('handles entries with varying field counts', () => {
      const fixturePath = join(fixtureDir, 'sequence-of-maps.yaml');
      const parsed = parseSimpleYaml(readFileSync(fixturePath, 'utf8'), fixturePath) as {
        events: Array<Record<string, unknown>>;
      };
      expect(parsed.events).toHaveLength(3);
      expect(Object.keys(parsed.events[0]!)).toHaveLength(5);
      expect(Object.keys(parsed.events[1]!)).toHaveLength(6);
      expect(Object.keys(parsed.events[2]!)).toHaveLength(6);
    });

    it('keeps colons inside scalar values (datetimes and HH:MM:SS)', () => {
      const fixturePath = join(fixtureDir, 'nested-sequence-of-maps.yaml');
      const parsed = parseSimpleYaml(readFileSync(fixturePath, 'utf8'), fixturePath) as {
        sessions: Array<Record<string, unknown>>;
      };
      expect(parsed.sessions[0]).toEqual({
        session_id: '2026-02-27-rth',
        start: '2026-02-27T14:30:00Z',
        end: '2026-02-27T21:00:00Z',
        symbol: 'MNQH6',
      });
    });
  });

  describe('empty sequences', () => {
    it('parses inline `events: []` to an empty array', () => {
      const parsed = parseSimpleYaml('events: []\n', '<inline>') as Record<string, unknown>;
      expect(parsed.events).toEqual([]);
      expect(Array.isArray(parsed.events)).toBe(true);
    });

    it('parses inline `events: {}` to an empty map', () => {
      const parsed = parseSimpleYaml('events: {}\n', '<inline>') as Record<string, unknown>;
      expect(parsed.events).toEqual({});
      expect(Array.isArray(parsed.events)).toBe(false);
    });

    // QFA-114 contract: `key:` with no children parses to [].
    // Rationale: list-shaped configs (calendars, session lists, future
    // strategy parameter sweeps) become more common going forward;
    // bare `events:` should be the natural empty-sequence shape, not an
    // empty map that downstream array-typed validators reject. Use the
    // explicit forms `events: []` or `events: {}` to disambiguate when
    // intent matters.
    it('parses `key:` with no children as an empty array (QFA-114 default)', () => {
      const yaml = 'a:\nb: 1\n';
      const parsed = parseSimpleYaml(yaml, '<inline>') as Record<string, unknown>;
      expect(parsed.a).toEqual([]);
      expect(Array.isArray(parsed.a)).toBe(true);
      expect(parsed.b).toBe(1);
    });

    it('parses `events:` followed by EOF as an empty array', () => {
      const parsed = parseSimpleYaml('events:\n', '<inline>') as Record<string, unknown>;
      expect(parsed.events).toEqual([]);
      expect(Array.isArray(parsed.events)).toBe(true);
    });

    it('still parses `events: {}` to an empty map when explicitly written', () => {
      const parsed = parseSimpleYaml('events: {}\n', '<inline>') as Record<string, unknown>;
      expect(parsed.events).toEqual({});
      expect(Array.isArray(parsed.events)).toBe(false);
    });
  });

  describe('single-entry edge cases', () => {
    it('parses a single-entry sequence of scalars correctly', () => {
      const parsed = parseSimpleYaml('symbols:\n  - ONLY\n', '<inline>') as Record<string, unknown>;
      expect(parsed.symbols).toEqual(['ONLY']);
    });

    it('parses a single-entry sequence of maps correctly', () => {
      const yaml = 'events:\n  - event_id: only\n    category: ONE\n';
      const parsed = parseSimpleYaml(yaml, '<inline>') as Record<string, unknown>;
      expect(parsed.events).toEqual([{ event_id: 'only', category: 'ONE' }]);
    });
  });

  describe('rejection of malformed sequences', () => {
    it('rejects mixed indentation between sequence entries', () => {
      const yaml = 'events:\n  - a: 1\n   - b: 2\n';
      expect(() => parseSimpleYaml(yaml, '<inline>')).toThrow(ConfigValidationError);
    });

    it('treats hyphen without space (`-foo`) as a scalar value, not a sequence', () => {
      // `key: -foo` should parse as `key = "-foo"` (string), not as a sequence.
      const parsed = parseSimpleYaml('key: -foo\n', '<inline>') as Record<string, unknown>;
      expect(parsed.key).toBe('-foo');
    });

    it('rejects bare dash `- ` with no content (clear error)', () => {
      const yaml = 'events:\n  - \n  - ok\n';
      try {
        parseSimpleYaml(yaml, '<inline>');
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).message).toContain("bare '-' sequence entry");
      }
    });

    it('rejects sequence entry where a map key was expected', () => {
      const yaml = 'a:\n  b: 1\n  - bad\n';
      expect(() => parseSimpleYaml(yaml, '<inline>')).toThrow(ConfigValidationError);
    });
  });

  describe('rejection of unsupported YAML constructs', () => {
    it('rejects YAML anchors (&)', () => {
      const yaml = 'a: &anchor\n  x: 1\nb: *anchor\n';
      try {
        parseSimpleYaml(yaml, '<inline>');
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).message).toContain('anchors');
      }
    });

    it('rejects YAML aliases (*)', () => {
      const yaml = 'a:\n  x: 1\nb: *something\n';
      expect(() => parseSimpleYaml(yaml, '<inline>')).toThrow(ConfigValidationError);
    });

    it('rejects non-empty flow sequence at value position', () => {
      const yaml = 'a: [1, 2, 3]\n';
      try {
        parseSimpleYaml(yaml, '<inline>');
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).message).toContain('non-empty flow sequences');
      }
    });

    it('rejects non-empty flow mapping at value position', () => {
      const yaml = 'a: {x: 1}\n';
      try {
        parseSimpleYaml(yaml, '<inline>');
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).message).toContain('non-empty flow mappings');
      }
    });

    it('rejects multi-line block scalar `|` indicator', () => {
      const yaml = 'description: |\n  multi-line text\n';
      try {
        parseSimpleYaml(yaml, '<inline>');
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).message).toContain('block scalars');
      }
    });

    it('rejects multi-line block scalar `>` indicator', () => {
      const yaml = 'description: >\n  folded text\n';
      expect(() => parseSimpleYaml(yaml, '<inline>')).toThrow(ConfigValidationError);
    });

    it('rejects multi-document streams (---)', () => {
      const yaml = '---\na: 1\n---\nb: 2\n';
      try {
        parseSimpleYaml(yaml, '<inline>');
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).message).toContain('multi-document');
      }
    });

    it('rejects YAML tags', () => {
      const yaml = 'a: !!str 5\n';
      try {
        parseSimpleYaml(yaml, '<inline>');
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).message).toContain('tags');
      }
    });

    it('rejects YAML directives (%)', () => {
      const yaml = '%YAML 1.2\n---\na: 1\n';
      expect(() => parseSimpleYaml(yaml, '<inline>')).toThrow(ConfigValidationError);
    });
  });

  describe('error format', () => {
    it('preserves existing terse error path for existing-construct failures', () => {
      const yaml = ' bad: 1\n';
      try {
        parseSimpleYaml(yaml, '<inline>');
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        // existing format: `<file>:<line>` (no column), preserved per
        // QFA-114 contract that existing errors keep their format.
        expect((error as ConfigValidationError).message).toMatch(/<inline>:1\b/u);
      }
    });

    it('includes line + column + truncated content in new-construct errors', () => {
      const yaml = 'a: [1, 2, 3]\n';
      try {
        parseSimpleYaml(yaml, '<inline>');
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        const text = (error as ConfigValidationError).message;
        expect(text).toMatch(/<inline>:1:\d+/u);
        expect(text).toContain('a: [1, 2, 3]');
      }
    });
  });

  describe('regression smoke against existing config/*.yaml', () => {
    // Note: This regression suite intentionally walks `config/` for *.yaml
    // files rather than asserting against a hardcoded list.
    // `config/research/historical-continuity.yaml` is referenced by
    // `historical-continuity.ts` but is missing from disk as of this
    // writing (see QFA-100b housekeeping). When that file is restored,
    // this walk will pick it up automatically.
    const yamlFiles = walkYamlFiles(configRoot);

    it('finds at least the 9 expected TS-consumed configs', () => {
      const relativeFiles = yamlFiles
        .map((f) => f.slice(configRoot.length + 1).split('\\').join('/'));
      const expected = [
        'management/profiles.yaml',
        'risk/risk-policy.yaml',
        'session/mnq-roll-calendar.yaml',
        'session/mnq-session-calendar.yaml',
        'strategies/breakdown_retest_short.yaml',
        'strategies/breakout_retest_long.yaml',
        'strategies/shared.yaml',
        'strategies/regime_shock_reversion_short_v2.yaml',
        'strategies/trend_pullback_long.yaml',
        'strategies/trend_pullback_short.yaml',
        'strategies/vwap_overnight_reversal_long.yaml',
        'strategies/vwap_overnight_reversal_short.yaml',
      ];
      for (const file of expected) {
        expect(relativeFiles).toContain(file);
      }
    });

    for (const yamlPath of yamlFiles) {
      const relative = yamlPath
        .slice(configRoot.length + 1)
        .split('\\')
        .join('/');
      it(`loads config/${relative} without error`, () => {
        const text = readFileSync(yamlPath, 'utf8');
        expect(() => parseSimpleYaml(text, yamlPath)).not.toThrow();
      });
    }
  });

  describe('snapshot equality for TS-consumed configs (hard regression net)', () => {
    const tsConsumed = [
      'config/strategies/shared.yaml',
      'config/strategies/breakout_retest_long.yaml',
      'config/strategies/breakdown_retest_short.yaml',
      'config/strategies/trend_pullback_long.yaml',
      'config/strategies/trend_pullback_short.yaml',
      'config/strategies/vwap_overnight_reversal_long.yaml',
      'config/strategies/vwap_overnight_reversal_short.yaml',
      'config/strategies/regime_shock_reversion_short_v2.yaml',
      'config/risk/risk-policy.yaml',
      'config/management/profiles.yaml',
      'config/session/mnq-roll-calendar.yaml',
      'config/session/mnq-session-calendar.yaml',
    ];

    for (const file of tsConsumed) {
      it(`${file} parses to its committed baseline snapshot`, () => {
        const yamlPath = join(repoRoot, file);
        const snapshotPath = join(tsConsumedSnapshotDir, snapshotBaseName(file));
        const parsed = parseSimpleYaml(readFileSync(yamlPath, 'utf8'), yamlPath);
        const baseline = JSON.parse(readFileSync(snapshotPath, 'utf8'));
        expect(parsed).toEqual(baseline);
      });
    }
  });

  describe('fixture-based sequence parsing', () => {
    it('parses tests/fixtures/simple-yaml/sequence-of-scalars.yaml', () => {
      const path = join(fixtureDir, 'sequence-of-scalars.yaml');
      const parsed = parseSimpleYaml(readFileSync(path, 'utf8'), path) as Record<string, unknown>;
      expect(parsed.symbols).toEqual(['MNQM6', 'MNQH6', 'MNQU6']);
      expect(parsed.empty_inline).toEqual([]);
      expect(parsed.empty_inline_map).toEqual({});
      expect(parsed.nested).toEqual({ inner_list: ['first', 'second'] });
    });
  });
});
