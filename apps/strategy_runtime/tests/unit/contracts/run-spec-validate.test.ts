// Module under test: contracts/run-spec-validate; ticket QFA-115 Session 2a.
import { describe, expect, it } from 'vitest';
import {
  RunSpecValidationError,
  validateRunSpec,
} from '../../../src/contracts/run-spec-validate.js';
import type { RunSpec } from '../../../src/contracts/run-spec.js';
import {
  buildMinimalRunSpec,
  buildConfigInput,
  buildCorpusInput,
  buildTierClassification,
} from './helpers/run-spec-builder.js';

type Primitive = string | number | bigint | boolean | symbol | null | undefined;
type Mutable<T> = T extends Primitive
  ? T
  : T extends readonly (infer U)[]
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

describe('QFA-115 validateRunSpec — happy path', () => {
  it('accepts the minimal builder output', () => {
    expect(() => validateRunSpec(buildMinimalRunSpec())).not.toThrow();
  });
});

describe('QFA-115 validateRunSpec — bigint absence (Q-3.3)', () => {
  it('throws if a top-level RunSpec field is bigint', () => {
    const spec = buildMinimalRunSpec() as unknown as Record<string, unknown>;
    spec.determinism_seed = 42n;
    expect(() => validateRunSpec(spec as unknown as RunSpec)).toThrow(RunSpecValidationError);
  });

  it('throws if a deeply-nested RunSpec field is bigint', () => {
    const spec = clone(buildMinimalRunSpec()) as unknown as {
      corpus_inputs: { manifest_schema_version: unknown }[];
    };
    spec.corpus_inputs[0]!.manifest_schema_version = 99n;
    expect(() => validateRunSpec(spec as unknown as RunSpec)).toThrow(RunSpecValidationError);
  });
});

describe('QFA-115 validateRunSpec — number invariants (Q-3.2 #3, #4 + A3)', () => {
  it('throws on non-finite determinism_seed', () => {
    const spec = clone(buildMinimalRunSpec());
    (spec as unknown as { determinism_seed: number }).determinism_seed = Number.POSITIVE_INFINITY;
    expect(() => validateRunSpec(spec)).toThrow(/finite|safe integer/u);
  });

  it('throws on negative determinism_seed', () => {
    const spec = clone(buildMinimalRunSpec());
    (spec as unknown as { determinism_seed: number }).determinism_seed = -1;
    expect(() => validateRunSpec(spec)).toThrow(/non-negative/u);
  });

  it('throws on determinism_seed > 2^32 - 1', () => {
    const spec = clone(buildMinimalRunSpec());
    (spec as unknown as { determinism_seed: number }).determinism_seed = 2 ** 32;
    expect(() => validateRunSpec(spec)).toThrow(/2\^32 - 1/u);
  });

  it('throws on non-integer determinism_seed', () => {
    const spec = clone(buildMinimalRunSpec());
    (spec as unknown as { determinism_seed: number }).determinism_seed = 1.5;
    expect(() => validateRunSpec(spec)).toThrow(/safe integer/u);
  });

  it('throws on positive zero version (manifest_schema_version)', () => {
    const spec = clone(buildMinimalRunSpec());
    (spec.corpus_inputs[0]! as unknown as { manifest_schema_version: number }).manifest_schema_version = 0;
    expect(() => validateRunSpec(spec)).toThrow(/positive/u);
  });
});

describe('QFA-115 validateRunSpec — strategy_ids', () => {
  it('throws on unknown strategy_id', () => {
    const spec = clone(buildMinimalRunSpec()) as unknown as { strategy_ids: string[] };
    spec.strategy_ids = ['unknown_strategy'];
    expect(() => validateRunSpec(spec as unknown as RunSpec)).toThrow(/unknown strategy_id/u);
  });

  it('throws on duplicate strategy_ids', () => {
    const spec = clone(buildMinimalRunSpec()) as unknown as { strategy_ids: string[] };
    spec.strategy_ids = ['trend_pullback_long', 'trend_pullback_long'];
    expect(() => validateRunSpec(spec as unknown as RunSpec)).toThrow(/duplicate strategy_id/u);
  });

  it('throws on empty strategy_ids', () => {
    const spec = clone(buildMinimalRunSpec()) as unknown as { strategy_ids: string[] };
    spec.strategy_ids = [];
    expect(() => validateRunSpec(spec as unknown as RunSpec)).toThrow(/non-empty array/u);
  });
});

describe('QFA-115 validateRunSpec — config_path (Q-1.5 + A2)', () => {
  it.each([
    ['/etc/passwd', 'absolute path'],
    ['/config/strategies/trend_pullback_long.yaml', 'absolute path with config prefix'],
    ['C:/config/strategies/foo.yaml', 'drive-letter prefix'],
    ['z:/config.yaml', 'drive-letter lowercase'],
    ['config\\strategies\\foo.yaml', 'backslash separator'],
    ['config/../etc/passwd', 'parent traversal'],
    ['..', 'parent traversal alone'],
    ['../config.yaml', 'parent traversal at start'],
  ])('rejects %s (%s)', (badPath, _label) => {
    const spec = clone(buildMinimalRunSpec());
    (spec.config_inputs[0]! as unknown as { config_path: string }).config_path = badPath;
    expect(() => validateRunSpec(spec)).toThrow(RunSpecValidationError);
  });

  it('accepts a clean repo-relative path', () => {
    const spec = clone(buildMinimalRunSpec());
    (spec.config_inputs[0]! as unknown as { config_path: string }).config_path =
      'config/strategies/trend_pullback_short.yaml';
    expect(() => validateRunSpec(spec)).not.toThrow();
  });
});

describe('QFA-115 validateRunSpec — verification invariant (Q-1.7)', () => {
  it('throws when verification_status === "passed" but verification_report_hash is null', () => {
    const spec = clone(buildMinimalRunSpec());
    (spec.corpus_inputs[0]! as unknown as { verification_report_hash: string | null }).verification_report_hash = null;
    expect(() => validateRunSpec(spec)).toThrow(RunSpecValidationError);
  });

  it('throws when verification_status === "not_run" but verification_report_hash is non-null', () => {
    const spec = clone(buildMinimalRunSpec());
    (spec.corpus_inputs[0]! as unknown as { verification_status: string }).verification_status = 'not_run';
    expect(() => validateRunSpec(spec)).toThrow(RunSpecValidationError);
  });

  it('accepts not_run with null verification_report_hash', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.corpus_inputs = [
      buildCorpusInput({
        verification_status: 'not_run',
        verification_report_hash: null,
      }),
    ];
    expect(() => validateRunSpec(spec)).not.toThrow();
  });
});

describe('QFA-115 validateRunSpec — policy invariant (Q-1.6)', () => {
  it('throws when policy_source === "config" but policy_ref is null', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.corpus_inputs = [
      buildCorpusInput({
        tier_classification: buildTierClassification({
          policy_source: 'config',
          policy_ref: null,
        }),
      }),
    ];
    expect(() => validateRunSpec(spec)).toThrow(RunSpecValidationError);
  });

  it('throws when policy_source === "runner_code" but policy_ref is non-null', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.corpus_inputs = [
      buildCorpusInput({
        tier_classification: buildTierClassification({
          policy_source: 'runner_code',
          policy_ref: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            config_hash: 'a'.repeat(64) as any,
            config_version: 1,
          },
        }),
      }),
    ];
    expect(() => validateRunSpec(spec)).toThrow(RunSpecValidationError);
  });

  it('accepts policy_source === "config" with non-null policy_ref', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.corpus_inputs = [
      buildCorpusInput({
        tier_classification: buildTierClassification({
          policy_source: 'config',
          policy_ref: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            config_hash: 'b'.repeat(64) as any,
            config_version: 1,
          },
        }),
      }),
    ];
    expect(() => validateRunSpec(spec)).not.toThrow();
  });
});

describe('QFA-115 validateRunSpec — array ordering (Q-3.4)', () => {
  it('throws when corpus_inputs are out of role-order', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.corpus_inputs = [
      buildCorpusInput({ role: 'calibration' }),
      buildCorpusInput({ role: 'primary' }),
    ];
    expect(() => validateRunSpec(spec)).toThrow(/out of order/u);
  });

  it('throws when corpus_inputs same-role tied are out of manifest_hash order', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.corpus_inputs = [
      buildCorpusInput({ role: 'primary', manifest_hash: 'b'.repeat(64) }),
      buildCorpusInput({ role: 'primary', manifest_hash: 'a'.repeat(64) }),
    ];
    expect(() => validateRunSpec(spec)).toThrow(/out of order/u);
  });

  it('throws when config_inputs are out of role-order', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.config_inputs = [
      buildConfigInput({ role: 'risk' }),
      buildConfigInput({ role: 'strategy' }),
    ];
    expect(() => validateRunSpec(spec)).toThrow(/out of order/u);
  });

  it('throws when config_inputs same-role tied are out of config_path order', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.config_inputs = [
      buildConfigInput({ role: 'strategy', config_path: 'config/strategies/zz.yaml' }),
      buildConfigInput({ role: 'strategy', config_path: 'config/strategies/aa.yaml' }),
    ];
    expect(() => validateRunSpec(spec)).toThrow(/out of order/u);
  });

  it('preserves strategy_ids order (does NOT throw on non-alphabetical order)', () => {
    const spec = clone(buildMinimalRunSpec());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec.strategy_ids = ['trend_pullback_short', 'trend_pullback_long'] as any;
    expect(() => validateRunSpec(spec)).not.toThrow();
  });
});

describe('QFA-115 validateRunSpec — bar_spec grammar (Q-2.6)', () => {
  it.each(['1m', '5m', '15m', '1h', '30s', '1d'])('accepts time bar %s', (bar) => {
    const spec = clone(buildMinimalRunSpec());
    (spec as unknown as { bar_spec: string }).bar_spec = bar;
    expect(() => validateRunSpec(spec)).not.toThrow();
  });

  it.each([
    'tick:ticks:100',
    'tick:volume:1000',
    'tick:dollar:50000',
  ])('accepts tick bar %s', (bar) => {
    const spec = clone(buildMinimalRunSpec());
    (spec as unknown as { bar_spec: string }).bar_spec = bar;
    expect(() => validateRunSpec(spec)).not.toThrow();
  });

  it.each([
    '01m',     // leading zero
    '0m',      // zero quantity
    '1M',      // uppercase unit
    '1 m',     // whitespace
    '1minute', // unsupported unit name
    '',        // empty
    'tick:ticks:0',  // zero count
    'tick:foo:100',  // unknown tick kind
    'TICK:TICKS:100', // uppercase prefix
  ])('rejects %s', (bar) => {
    const spec = clone(buildMinimalRunSpec());
    (spec as unknown as { bar_spec: string }).bar_spec = bar;
    expect(() => validateRunSpec(spec)).toThrow(RunSpecValidationError);
  });
});

describe('QFA-115 validateRunSpec — backtest_window', () => {
  it('throws when start > end (lexicographic)', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.backtest_window = { ...spec.backtest_window, start: '2026-03-01', end: '2026-02-01' };
    expect(() => validateRunSpec(spec)).toThrow(/start.*<=.*end/u);
  });

  it('throws on session-mode start with instant format', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.backtest_window = {
      ...spec.backtest_window,
      mode: 'session',
      start: '2026-02-02T14:30:00Z',
    };
    expect(() => validateRunSpec(spec)).toThrow(/YYYY-MM-DD/u);
  });

  it('throws on instant-mode without Z suffix', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.backtest_window = {
      mode: 'instant',
      start: '2026-02-02T14:30:00',
      end: '2026-02-02T21:00:00Z',
      inclusive_end: true,
      calendar: 'CME_US_INDEX_FUTURES',
    };
    expect(() => validateRunSpec(spec)).toThrow(/instant.*Z/u);
  });

  it('throws on unknown calendar', () => {
    const spec = clone(buildMinimalRunSpec());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec.backtest_window = { ...spec.backtest_window, calendar: 'NYSE' as any };
    expect(() => validateRunSpec(spec)).toThrow(/CME_US_INDEX_FUTURES/u);
  });

  it('accepts an instant window', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.backtest_window = {
      mode: 'instant',
      start: '2026-02-02T14:30:00Z',
      end: '2026-02-02T21:00:00Z',
      inclusive_end: false,
      calendar: 'CME_US_INDEX_FUTURES',
    };
    expect(() => validateRunSpec(spec)).not.toThrow();
  });
});

describe('QFA-115 Q-2.4 instant-mode regex (no fractional seconds)', () => {
  it('rejects instant-mode start with fractional seconds', () => {
    const spec = clone(
      buildMinimalRunSpec({
        backtest_window: {
          start: '2026-02-02T14:30:00.000Z',
          end: '2026-02-02T21:00:00Z',
          mode: 'instant',
          inclusive_end: false,
          calendar: 'CME_US_INDEX_FUTURES',
        },
      }),
    );
    expect(() => validateRunSpec(spec)).toThrow(/instant-mode start/u);
  });

  it('rejects instant-mode end with fractional seconds', () => {
    const spec = clone(
      buildMinimalRunSpec({
        backtest_window: {
          start: '2026-02-02T14:30:00Z',
          end: '2026-02-02T21:00:00.500Z',
          mode: 'instant',
          inclusive_end: false,
          calendar: 'CME_US_INDEX_FUTURES',
        },
      }),
    );
    expect(() => validateRunSpec(spec)).toThrow(/instant-mode end/u);
  });

  it('accepts instant-mode start and end without fractional seconds', () => {
    const spec = clone(
      buildMinimalRunSpec({
        backtest_window: {
          start: '2026-02-02T14:30:00Z',
          end: '2026-02-02T21:00:00Z',
          mode: 'instant',
          inclusive_end: false,
          calendar: 'CME_US_INDEX_FUTURES',
        },
      }),
    );
    expect(() => validateRunSpec(spec)).not.toThrow();
  });
});

describe('QFA-115 validateRunSpec — runner_code_commit_sha', () => {
  it('throws on non-hex commit sha', () => {
    const spec = clone(buildMinimalRunSpec());
    (spec as unknown as { runner_code_commit_sha: string }).runner_code_commit_sha = 'XYZ_NOT_HEX';
    expect(() => validateRunSpec(spec)).toThrow(/40-character hex/u);
  });

  it('throws on uppercase hex', () => {
    const spec = clone(buildMinimalRunSpec());
    (spec as unknown as { runner_code_commit_sha: string }).runner_code_commit_sha =
      'A'.repeat(40);
    expect(() => validateRunSpec(spec)).toThrow(/40-character hex/u);
  });
});

describe('QFA-115 validateRunSpec — string surrogate well-formedness (Q-3.2 #5 + A4)', () => {
  it('throws on lone high surrogate', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.corpus_inputs = [
      buildCorpusInput({
        tier_classification: buildTierClassification({
          // lone high surrogate, no low follower
          classification_reason: `bad string \uD800 here`,
        }),
      }),
    ];
    expect(() => validateRunSpec(spec)).toThrow(/lone high surrogate/u);
  });

  it('throws on lone low surrogate', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.corpus_inputs = [
      buildCorpusInput({
        tier_classification: buildTierClassification({
          classification_reason: `bad string \uDC00 here`,
        }),
      }),
    ];
    expect(() => validateRunSpec(spec)).toThrow(/lone low surrogate/u);
  });

  it('accepts properly-paired surrogates (e.g., emoji)', () => {
    const spec = clone(buildMinimalRunSpec());
    spec.corpus_inputs = [
      buildCorpusInput({
        tier_classification: buildTierClassification({
          classification_reason: `Tier A 🎯 (mbo + mbp-10)`,
        }),
      }),
    ];
    expect(() => validateRunSpec(spec)).not.toThrow();
  });
});

describe('QFA-115 RunSpecValidationError — shape', () => {
  it('exposes readonly issues array with path/message pairs', () => {
    const spec = clone(buildMinimalRunSpec()) as unknown as { strategy_ids: string[] };
    spec.strategy_ids = ['unknown_strategy'];
    try {
      validateRunSpec(spec as unknown as RunSpec);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RunSpecValidationError);
      const err = error as RunSpecValidationError;
      expect(Array.isArray(err.issues)).toBe(true);
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.issues[0]!).toHaveProperty('path');
      expect(err.issues[0]!).toHaveProperty('message');
    }
  });

  it('error name is RunSpecValidationError for instanceof checks', () => {
    try {
      validateRunSpec({} as RunSpec);
    } catch (error) {
      expect((error as Error).name).toBe('RunSpecValidationError');
    }
  });
});
