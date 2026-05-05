import { BarBuilderInputError, type BarBuilderIssue } from './bar-builder-input-error.js';
import type { ContractRoot, ContractRollPolicy, RollRule } from './roll-policy.js';

const CONTINUOUS_SYMBOL_RE = /^([A-Z]{1,3})\.([a-z])\.(\d+)$/u;
const CONCRETE_CONTRACT_RE = /^([A-Z]{1,3})([FGHJKMNQUVXZ])(\d{1,2})$/u;
const ROOT_SYMBOL_RE = /^([A-Z]{1,3})$/u;

export type ManifestSymbolExpectationType = 'concrete_contract' | 'continuous_symbol' | 'root';

export type ManifestSymbolExpectation =
  | {
      readonly type: 'concrete_contract';
      readonly root: ContractRoot;
      readonly raw_symbol: string;
    }
  | {
      readonly type: 'continuous_symbol';
      readonly root: ContractRoot;
      readonly roll_rule: RollRule | 'unknown';
      readonly rank: number | null;
      readonly raw_symbol: string;
    }
  | {
      readonly type: 'root';
      readonly root: ContractRoot;
    };

export interface ResolvedContractIdentity {
  readonly instrument_id: number | null;
  readonly raw_symbol: string | null;
  readonly root: ContractRoot | null;
}

export type ManifestSymbolCheckStatus = 'matched' | 'roll_compatible' | 'unverified';

export interface ManifestSymbolCheck {
  readonly manifest_symbol: string;
  readonly expectation_type: ManifestSymbolExpectationType;
  readonly status: ManifestSymbolCheckStatus;
  readonly message: string;
}

export function parseManifestSymbol(symbol: string): ManifestSymbolExpectation {
  const continuousMatch = CONTINUOUS_SYMBOL_RE.exec(symbol);
  if (continuousMatch !== null) {
    const [, root, ruleCode, rank] = continuousMatch;
    return {
      type: 'continuous_symbol',
      root,
      roll_rule: mapContinuousRuleCode(ruleCode),
      rank: Number(rank),
      raw_symbol: symbol,
    };
  }

  const concreteMatch = CONCRETE_CONTRACT_RE.exec(symbol);
  if (concreteMatch !== null) {
    return {
      type: 'concrete_contract',
      root: concreteMatch[1]!,
      raw_symbol: symbol,
    };
  }

  const rootMatch = ROOT_SYMBOL_RE.exec(symbol);
  if (rootMatch !== null) {
    return {
      type: 'root',
      root: rootMatch[1]!,
    };
  }

  throw new BarBuilderInputError([
    {
      path: '$.manifest_symbol',
      code: 'unrecognized_manifest_symbol',
      message: `unrecognized manifest symbol: ${symbol}`,
    },
  ]);
}

export function checkManifestSymbol(
  expectation: ManifestSymbolExpectation,
  resolvedContract: ResolvedContractIdentity,
  policy: ContractRollPolicy,
): ManifestSymbolCheck {
  const manifestSymbol = expectation.type === 'root' ? expectation.root : expectation.raw_symbol;
  const resolvedRoot = resolvedContract.root ?? inferRootFromRawSymbol(resolvedContract.raw_symbol);

  if (resolvedRoot === null) {
    if (resolvedContract.instrument_id !== null) {
      return {
        manifest_symbol: manifestSymbol,
        expectation_type: expectation.type,
        status: 'unverified',
        message:
          'stream contract root could not be resolved from raw_symbol; continuing with instrument_id-only identity',
      };
    }
    throw issue('$.resolvedContract.root', 'incompatible_root', 'stream contract root could not be resolved');
  }

  if (resolvedRoot !== expectation.root) {
    throw issue(
      '$.resolvedContract.root',
      'incompatible_root',
      `resolved contract root ${resolvedRoot} is incompatible with manifest expectation ${expectation.root}`,
    );
  }

  if (expectation.type === 'concrete_contract') {
    if (resolvedContract.raw_symbol === null) {
      if (resolvedContract.instrument_id !== null) {
        return {
          manifest_symbol: manifestSymbol,
          expectation_type: expectation.type,
          status: 'unverified',
          message: 'manifest expects a concrete contract, but stream identity is instrument_id-only',
        };
      }
      throw issue(
        '$.resolvedContract.raw_symbol',
        'manifest_concrete_mismatch',
        'manifest expects a concrete contract symbol, but stream symbol is unavailable',
      );
    }
    if (resolvedContract.raw_symbol !== expectation.raw_symbol) {
      throw issue(
        '$.resolvedContract.raw_symbol',
        'manifest_concrete_mismatch',
        `manifest concrete symbol ${expectation.raw_symbol} does not match stream symbol ${resolvedContract.raw_symbol}`,
      );
    }
    return {
      manifest_symbol: manifestSymbol,
      expectation_type: expectation.type,
      status: 'matched',
      message: 'manifest concrete symbol matches the first resolved stream contract',
    };
  }

  if (expectation.type === 'continuous_symbol') {
    if (expectation.rank !== null && expectation.rank !== policy.rank) {
      throw issue(
        '$.roll_policy.rank',
        'manifest_continuous_rule_mismatch',
        `manifest continuous rank ${String(expectation.rank)} does not match roll policy rank ${String(policy.rank)}`,
      );
    }
    if (expectation.roll_rule !== 'unknown' && expectation.roll_rule !== policy.rule) {
      throw issue(
        '$.roll_policy.rule',
        'manifest_continuous_rule_mismatch',
        `manifest continuous rule ${expectation.roll_rule} does not match roll policy rule ${policy.rule}`,
      );
    }
    return {
      manifest_symbol: manifestSymbol,
      expectation_type: expectation.type,
      status: resolvedContract.raw_symbol === null ? 'unverified' : 'roll_compatible',
      message:
        resolvedContract.raw_symbol === null
          ? 'manifest continuous symbol is compatible with the roll policy, but stream identity is instrument_id-only'
          : 'manifest continuous symbol is compatible with the resolved root and configured roll policy',
    };
  }

  return {
    manifest_symbol: manifestSymbol,
    expectation_type: expectation.type,
    status: resolvedContract.raw_symbol === null ? 'unverified' : 'roll_compatible',
    message:
      resolvedContract.raw_symbol === null
        ? 'manifest root matches the resolved root, but stream identity is instrument_id-only'
        : 'manifest root matches the resolved root; contract rolls are allowed by policy',
  };
}

function mapContinuousRuleCode(code: string): RollRule | 'unknown' {
  switch (code) {
    case 'v':
      return 'volume_front_month';
    case 'c':
      return 'calendar_front_month';
    case 'n':
      return 'unknown';
    default:
      return 'unknown';
  }
}

function inferRootFromRawSymbol(rawSymbol: string | null): ContractRoot | null {
  if (rawSymbol === null) {
    return null;
  }
  const expectation = tryParseSymbol(rawSymbol);
  return expectation?.root ?? null;
}

function tryParseSymbol(symbol: string): ManifestSymbolExpectation | null {
  try {
    return parseManifestSymbol(symbol);
  } catch {
    return null;
  }
}

function issue(path: string, code: BarBuilderIssue['code'], message: string): never {
  throw new BarBuilderInputError([{ path, code, message }]);
}
