import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigValidationError } from '../config/errors.js';
import { stableStringify } from '../config/hash.js';
import {
  checkUnknownKeys,
  parseSimpleYaml,
  readLiteral,
  readNumber,
  readRecord,
  readString,
  requireRecord,
  throwIfIssues,
} from '../config/simple-yaml.js';
import { CONFIG_HASH_ALGORITHM, type ConfigValidationIssue } from '../config/types.js';
import { ns, type UnixNs } from '../contracts/time.js';
import { parseConfigUnixNs } from '../session/time-utils.js';

export const HISTORICAL_CONTINUITY_SCHEMA_VERSION = 1 as const;
export const HISTORICAL_CONTINUITY_HASH_ALGORITHM = CONFIG_HASH_ALGORITHM;
export const DEFAULT_HISTORICAL_CONTINUITY_POLICY_PATH =
  'config/research/historical-continuity.yaml';

export const HISTORICAL_CONTINUITY_DOMAINS = [
  'MNQ_CANONICAL',
  'NQ_SURROGATE_PRE_MNQ',
] as const;
export type HistoricalContinuityDomain = typeof HISTORICAL_CONTINUITY_DOMAINS[number];

export const RESEARCH_INSTRUMENT_ROOTS = ['MNQ', 'NQ'] as const;
export type ResearchInstrumentRoot = typeof RESEARCH_INSTRUMENT_ROOTS[number];

export const RESEARCH_SOURCE_PROVIDERS = ['databento'] as const;
export type ResearchSourceProvider = typeof RESEARCH_SOURCE_PROVIDERS[number];

export const RESEARCH_EXCHANGE_TS_BASES = ['exchange_event_ts_ns'] as const;
export type ResearchExchangeTimestampBasis = typeof RESEARCH_EXCHANGE_TS_BASES[number];

export const RESEARCH_NORMALIZATION_POLICIES = ['tick_r_volatility_v1'] as const;
export type ResearchNormalizationPolicy = typeof RESEARCH_NORMALIZATION_POLICIES[number];

export type ResearchSurrogateFor = ResearchInstrumentRoot | 'none';

export interface HistoricalContinuityDomainPolicy {
  readonly instrument_root: ResearchInstrumentRoot;
  readonly domain: HistoricalContinuityDomain;
  readonly surrogate_for: ResearchSurrogateFor;
  readonly normalization_policy: ResearchNormalizationPolicy;
  readonly source_provider: ResearchSourceProvider;
  readonly exchange_event_ts_ns_basis: ResearchExchangeTimestampBasis;
}

export interface HistoricalContinuityPolicy {
  readonly version: typeof HISTORICAL_CONTINUITY_SCHEMA_VERSION;
  readonly policy_id: string;
  readonly coverage_start_year: 2017;
  readonly source_provider: ResearchSourceProvider;
  readonly exchange_event_ts_ns_basis: ResearchExchangeTimestampBasis;
  readonly canonical_instrument_root: 'MNQ';
  readonly surrogate_instrument_root: 'NQ';
  readonly mnq_canonical_start_ts_ns: UnixNs;
  readonly normalization_policy: ResearchNormalizationPolicy;
  readonly domains: Readonly<Record<HistoricalContinuityDomain, HistoricalContinuityDomainPolicy>>;
}

export interface HistoricalContinuityPolicyLineage {
  readonly continuity_policy_version: typeof HISTORICAL_CONTINUITY_SCHEMA_VERSION;
  readonly continuity_policy_id: string;
  readonly continuity_policy_hash: string;
  readonly continuity_policy_hash_algorithm: typeof HISTORICAL_CONTINUITY_HASH_ALGORITHM;
  readonly canonical_continuity_policy_json: string;
}

export interface LoadedHistoricalContinuityPolicy {
  readonly policy: HistoricalContinuityPolicy;
  readonly lineage: HistoricalContinuityPolicyLineage;
  readonly source_file: string;
}

export interface ResearchDatasetContinuityLineage {
  readonly continuity_policy_id: string;
  readonly continuity_policy_version: typeof HISTORICAL_CONTINUITY_SCHEMA_VERSION;
  readonly continuity_policy_hash: string;
  readonly instrument_root: ResearchInstrumentRoot;
  readonly contract_symbol: string;
  readonly domain: HistoricalContinuityDomain;
  readonly surrogate_for: ResearchSurrogateFor;
  readonly normalization_policy: ResearchNormalizationPolicy;
  readonly source_provider: ResearchSourceProvider;
  readonly exchange_event_ts_ns_basis: ResearchExchangeTimestampBasis;
}

export interface LoadHistoricalContinuityPolicyOptions {
  readonly path?: string;
  readonly cwd?: string;
  readonly required?: boolean;
}

export interface BuildResearchDatasetContinuityLineageInput {
  readonly exchange_event_ts_ns: UnixNs;
  readonly contract_symbol: string;
}

export function loadHistoricalContinuityPolicy(
  options: LoadHistoricalContinuityPolicyOptions = {},
): LoadedHistoricalContinuityPolicy {
  const cwd = options.cwd ?? process.cwd();
  const requestedPath = options.path ?? DEFAULT_HISTORICAL_CONTINUITY_POLICY_PATH;
  const path = resolve(cwd, requestedPath);
  if (!existsSync(path)) {
    if (options.required === false) {
      return buildLoadedPolicy(DEFAULT_HISTORICAL_CONTINUITY_POLICY, path);
    }
    throw new ConfigValidationError([
      { path: 'historical_continuity.path', message: `cannot read ${path}` },
    ], 'Invalid historical continuity policy');
  }

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([
      { path: 'historical_continuity.path', message: `cannot read ${path}: ${message}` },
    ], 'Invalid historical continuity policy');
  }

  return parseHistoricalContinuityPolicy(
    parseSimpleYaml(contents, path, 'Invalid historical continuity policy'),
    path,
  );
}

export function validateHistoricalContinuityPolicy(
  policy: HistoricalContinuityPolicy,
): readonly ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (policy.version !== HISTORICAL_CONTINUITY_SCHEMA_VERSION) {
    issues.push({ path: '$.version', message: `expected ${HISTORICAL_CONTINUITY_SCHEMA_VERSION}` });
  }
  if (policy.coverage_start_year !== 2017) {
    issues.push({ path: '$.coverage_start_year', message: 'expected 2017' });
  }
  if (policy.policy_id.trim() === '') {
    issues.push({ path: '$.policy_id', message: 'required non-empty string is missing or invalid' });
  }
  if (policy.canonical_instrument_root !== 'MNQ') {
    issues.push({ path: '$.canonical_instrument_root', message: 'expected MNQ' });
  }
  if (policy.surrogate_instrument_root !== 'NQ') {
    issues.push({ path: '$.surrogate_instrument_root', message: 'expected NQ' });
  }
  if (policy.source_provider !== 'databento') {
    issues.push({ path: '$.source_provider', message: 'expected databento' });
  }
  if (policy.exchange_event_ts_ns_basis !== 'exchange_event_ts_ns') {
    issues.push({ path: '$.exchange_event_ts_ns_basis', message: 'expected exchange_event_ts_ns' });
  }
  if (policy.normalization_policy !== 'tick_r_volatility_v1') {
    issues.push({ path: '$.normalization_policy', message: 'expected tick_r_volatility_v1' });
  }
  if (policy.mnq_canonical_start_ts_ns <= ns(0)) {
    issues.push({ path: '$.mnq_canonical_start_ts_ns', message: 'must be > 0' });
  }

  validateDomainPolicy(policy.domains.MNQ_CANONICAL, 'MNQ_CANONICAL', issues);
  validateDomainPolicy(policy.domains.NQ_SURROGATE_PRE_MNQ, 'NQ_SURROGATE_PRE_MNQ', issues);
  return issues.sort(compareIssues);
}

export function resolveHistoricalContinuityDomain(
  policy: HistoricalContinuityPolicy | LoadedHistoricalContinuityPolicy,
  exchangeEventTsNs: UnixNs,
): HistoricalContinuityDomain {
  const resolved = 'policy' in policy ? policy.policy : policy;
  return exchangeEventTsNs < resolved.mnq_canonical_start_ts_ns
    ? 'NQ_SURROGATE_PRE_MNQ'
    : 'MNQ_CANONICAL';
}

export function buildResearchDatasetContinuityLineage(
  loaded: LoadedHistoricalContinuityPolicy,
  input: BuildResearchDatasetContinuityLineageInput,
): ResearchDatasetContinuityLineage {
  const domain = resolveHistoricalContinuityDomain(loaded, input.exchange_event_ts_ns);
  const domainPolicy = loaded.policy.domains[domain];
  const lineage: ResearchDatasetContinuityLineage = {
    continuity_policy_id: loaded.lineage.continuity_policy_id,
    continuity_policy_version: loaded.lineage.continuity_policy_version,
    continuity_policy_hash: loaded.lineage.continuity_policy_hash,
    instrument_root: domainPolicy.instrument_root,
    contract_symbol: input.contract_symbol,
    domain,
    surrogate_for: domainPolicy.surrogate_for,
    normalization_policy: domainPolicy.normalization_policy,
    source_provider: domainPolicy.source_provider,
    exchange_event_ts_ns_basis: domainPolicy.exchange_event_ts_ns_basis,
  };
  const issues = validateResearchDatasetContinuityLineage(lineage, loaded);
  if (issues.length > 0) {
    throw new ConfigValidationError(issues, 'Invalid research dataset continuity lineage');
  }
  return lineage;
}

export function validateResearchDatasetContinuityLineage(
  lineage: ResearchDatasetContinuityLineage,
  loaded?: LoadedHistoricalContinuityPolicy,
): readonly ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (lineage.continuity_policy_id.trim() === '') {
    issues.push({ path: '$.continuity_policy_id', message: 'required non-empty string is missing or invalid' });
  }
  if (lineage.continuity_policy_version !== HISTORICAL_CONTINUITY_SCHEMA_VERSION) {
    issues.push({
      path: '$.continuity_policy_version',
      message: `expected ${HISTORICAL_CONTINUITY_SCHEMA_VERSION}`,
    });
  }
  if (!/^[a-f0-9]{64}$/.test(lineage.continuity_policy_hash)) {
    issues.push({ path: '$.continuity_policy_hash', message: 'expected sha256 hex digest' });
  }
  if (!RESEARCH_INSTRUMENT_ROOTS.includes(lineage.instrument_root)) {
    issues.push({ path: '$.instrument_root', message: `expected one of: ${RESEARCH_INSTRUMENT_ROOTS.join(', ')}` });
  }
  if (lineage.contract_symbol.trim() === '') {
    issues.push({ path: '$.contract_symbol', message: 'required non-empty string is missing or invalid' });
  }
  if (!HISTORICAL_CONTINUITY_DOMAINS.includes(lineage.domain)) {
    issues.push({ path: '$.domain', message: `expected one of: ${HISTORICAL_CONTINUITY_DOMAINS.join(', ')}` });
  }
  if (!RESEARCH_NORMALIZATION_POLICIES.includes(lineage.normalization_policy)) {
    issues.push({
      path: '$.normalization_policy',
      message: `expected one of: ${RESEARCH_NORMALIZATION_POLICIES.join(', ')}`,
    });
  }
  if (!RESEARCH_SOURCE_PROVIDERS.includes(lineage.source_provider)) {
    issues.push({ path: '$.source_provider', message: `expected one of: ${RESEARCH_SOURCE_PROVIDERS.join(', ')}` });
  }
  if (!RESEARCH_EXCHANGE_TS_BASES.includes(lineage.exchange_event_ts_ns_basis)) {
    issues.push({
      path: '$.exchange_event_ts_ns_basis',
      message: `expected one of: ${RESEARCH_EXCHANGE_TS_BASES.join(', ')}`,
    });
  }

  if (lineage.domain === 'MNQ_CANONICAL') {
    enforceLineageMatch(lineage, {
      instrument_root: 'MNQ',
      surrogate_for: 'none',
      symbolPrefix: 'MNQ',
      path: '$',
    }, issues);
  }
  if (lineage.domain === 'NQ_SURROGATE_PRE_MNQ') {
    enforceLineageMatch(lineage, {
      instrument_root: 'NQ',
      surrogate_for: 'MNQ',
      symbolPrefix: 'NQ',
      path: '$',
    }, issues);
  }

  if (loaded !== undefined) {
    const expected = loaded.policy.domains[lineage.domain];
    if (lineage.continuity_policy_id !== loaded.lineage.continuity_policy_id) {
      issues.push({ path: '$.continuity_policy_id', message: 'does not match loaded continuity policy' });
    }
    if (lineage.continuity_policy_hash !== loaded.lineage.continuity_policy_hash) {
      issues.push({ path: '$.continuity_policy_hash', message: 'does not match loaded continuity policy' });
    }
    if (lineage.instrument_root !== expected.instrument_root) {
      issues.push({ path: '$.instrument_root', message: `expected ${expected.instrument_root}` });
    }
    if (lineage.surrogate_for !== expected.surrogate_for) {
      issues.push({ path: '$.surrogate_for', message: `expected ${expected.surrogate_for}` });
    }
    if (lineage.normalization_policy !== expected.normalization_policy) {
      issues.push({ path: '$.normalization_policy', message: `expected ${expected.normalization_policy}` });
    }
    if (lineage.source_provider !== expected.source_provider) {
      issues.push({ path: '$.source_provider', message: `expected ${expected.source_provider}` });
    }
    if (lineage.exchange_event_ts_ns_basis !== expected.exchange_event_ts_ns_basis) {
      issues.push({ path: '$.exchange_event_ts_ns_basis', message: `expected ${expected.exchange_event_ts_ns_basis}` });
    }
  }

  return issues.sort(compareIssues);
}

export function canonicalizeHistoricalContinuityPolicy(
  policy: HistoricalContinuityPolicy | LoadedHistoricalContinuityPolicy,
): string {
  const resolved = 'policy' in policy ? policy.policy : policy;
  return stableStringify({
    version: HISTORICAL_CONTINUITY_SCHEMA_VERSION,
    policy: {
      ...resolved,
      mnq_canonical_start_ts_ns: resolved.mnq_canonical_start_ts_ns.toString(),
    },
  });
}

export function computeHistoricalContinuityPolicyHash(
  policy: HistoricalContinuityPolicy | LoadedHistoricalContinuityPolicy,
): string {
  return createHash(HISTORICAL_CONTINUITY_HASH_ALGORITHM)
    .update(canonicalizeHistoricalContinuityPolicy(policy), 'utf8')
    .digest('hex');
}

function parseHistoricalContinuityPolicy(
  input: unknown,
  sourceFile: string,
): LoadedHistoricalContinuityPolicy {
  const issues: ConfigValidationIssue[] = [];
  const root = requireRecord(input, '$', issues);
  checkUnknownKeys(root, '$', [
    'version',
    'policy_id',
    'coverage_start_year',
    'source_provider',
    'exchange_event_ts_ns_basis',
    'canonical_instrument_root',
    'surrogate_instrument_root',
    'mnq_canonical_start_ts_ns',
    'normalization_policy',
    'domains',
  ], issues);
  readVersion(root, '$', issues);

  const policy: HistoricalContinuityPolicy = {
    version: HISTORICAL_CONTINUITY_SCHEMA_VERSION,
    policy_id: readString(root, 'policy_id', '$', issues),
    coverage_start_year: readCoverageStartYear(root, issues),
    source_provider: readLiteral(root, 'source_provider', '$', RESEARCH_SOURCE_PROVIDERS, issues),
    exchange_event_ts_ns_basis: readLiteral(root, 'exchange_event_ts_ns_basis', '$', RESEARCH_EXCHANGE_TS_BASES, issues),
    canonical_instrument_root: readLiteral(root, 'canonical_instrument_root', '$', ['MNQ'], issues),
    surrogate_instrument_root: readLiteral(root, 'surrogate_instrument_root', '$', ['NQ'], issues),
    mnq_canonical_start_ts_ns: parseConfigUnixNs(root.mnq_canonical_start_ts_ns, '$.mnq_canonical_start_ts_ns', issues),
    normalization_policy: readLiteral(root, 'normalization_policy', '$', RESEARCH_NORMALIZATION_POLICIES, issues),
    domains: parseDomains(readRecord(root, 'domains', '$', issues), issues),
  };

  issues.push(...validateHistoricalContinuityPolicy(policy));
  throwIfIssues(issues, 'Invalid historical continuity policy');
  return buildLoadedPolicy(policy, sourceFile);
}

function parseDomains(
  record: Record<string, unknown>,
  issues: ConfigValidationIssue[],
): Readonly<Record<HistoricalContinuityDomain, HistoricalContinuityDomainPolicy>> {
  checkUnknownKeys(record, '$.domains', HISTORICAL_CONTINUITY_DOMAINS, issues);
  return {
    MNQ_CANONICAL: parseDomainPolicy(
      requireRecord(record.MNQ_CANONICAL, '$.domains.MNQ_CANONICAL', issues),
      'MNQ_CANONICAL',
      issues,
    ),
    NQ_SURROGATE_PRE_MNQ: parseDomainPolicy(
      requireRecord(record.NQ_SURROGATE_PRE_MNQ, '$.domains.NQ_SURROGATE_PRE_MNQ', issues),
      'NQ_SURROGATE_PRE_MNQ',
      issues,
    ),
  };
}

function parseDomainPolicy(
  record: Record<string, unknown>,
  domain: HistoricalContinuityDomain,
  issues: ConfigValidationIssue[],
): HistoricalContinuityDomainPolicy {
  const path = `$.domains.${domain}`;
  checkUnknownKeys(record, path, [
    'instrument_root',
    'domain',
    'surrogate_for',
    'normalization_policy',
    'source_provider',
    'exchange_event_ts_ns_basis',
  ], issues);
  return {
    instrument_root: readLiteral(record, 'instrument_root', path, RESEARCH_INSTRUMENT_ROOTS, issues),
    domain: readLiteral(record, 'domain', path, HISTORICAL_CONTINUITY_DOMAINS, issues),
    surrogate_for: readLiteral(record, 'surrogate_for', path, ['MNQ', 'NQ', 'none'], issues),
    normalization_policy: readLiteral(record, 'normalization_policy', path, RESEARCH_NORMALIZATION_POLICIES, issues),
    source_provider: readLiteral(record, 'source_provider', path, RESEARCH_SOURCE_PROVIDERS, issues),
    exchange_event_ts_ns_basis: readLiteral(record, 'exchange_event_ts_ns_basis', path, RESEARCH_EXCHANGE_TS_BASES, issues),
  };
}

function validateDomainPolicy(
  policy: HistoricalContinuityDomainPolicy,
  domain: HistoricalContinuityDomain,
  issues: ConfigValidationIssue[],
): void {
  const path = `$.domains.${domain}`;
  if (policy.domain !== domain) {
    issues.push({ path: `${path}.domain`, message: `expected ${domain}` });
  }
  if (policy.source_provider !== 'databento') {
    issues.push({ path: `${path}.source_provider`, message: 'expected databento' });
  }
  if (policy.exchange_event_ts_ns_basis !== 'exchange_event_ts_ns') {
    issues.push({ path: `${path}.exchange_event_ts_ns_basis`, message: 'expected exchange_event_ts_ns' });
  }
  if (policy.normalization_policy !== 'tick_r_volatility_v1') {
    issues.push({ path: `${path}.normalization_policy`, message: 'expected tick_r_volatility_v1' });
  }
  if (domain === 'MNQ_CANONICAL') {
    enforceDomainMatch(policy, {
      instrument_root: 'MNQ',
      surrogate_for: 'none',
      path,
    }, issues);
  }
  if (domain === 'NQ_SURROGATE_PRE_MNQ') {
    enforceDomainMatch(policy, {
      instrument_root: 'NQ',
      surrogate_for: 'MNQ',
      path,
    }, issues);
  }
}

function enforceDomainMatch(
  policy: HistoricalContinuityDomainPolicy,
  expected: {
    readonly instrument_root: ResearchInstrumentRoot;
    readonly surrogate_for: ResearchSurrogateFor;
    readonly path: string;
  },
  issues: ConfigValidationIssue[],
): void {
  if (policy.instrument_root !== expected.instrument_root) {
    issues.push({ path: `${expected.path}.instrument_root`, message: `expected ${expected.instrument_root}` });
  }
  if (policy.surrogate_for !== expected.surrogate_for) {
    issues.push({ path: `${expected.path}.surrogate_for`, message: `expected ${expected.surrogate_for}` });
  }
}

function enforceLineageMatch(
  lineage: ResearchDatasetContinuityLineage,
  expected: {
    readonly instrument_root: ResearchInstrumentRoot;
    readonly surrogate_for: ResearchSurrogateFor;
    readonly symbolPrefix: string;
    readonly path: string;
  },
  issues: ConfigValidationIssue[],
): void {
  if (lineage.instrument_root !== expected.instrument_root) {
    issues.push({ path: `${expected.path}.instrument_root`, message: `expected ${expected.instrument_root}` });
  }
  if (lineage.surrogate_for !== expected.surrogate_for) {
    issues.push({ path: `${expected.path}.surrogate_for`, message: `expected ${expected.surrogate_for}` });
  }
  if (!lineage.contract_symbol.startsWith(expected.symbolPrefix)) {
    issues.push({ path: `${expected.path}.contract_symbol`, message: `expected ${expected.symbolPrefix} contract symbol` });
  }
}

function buildLoadedPolicy(
  policy: HistoricalContinuityPolicy,
  sourceFile: string,
): LoadedHistoricalContinuityPolicy {
  const canonical = canonicalizeHistoricalContinuityPolicy(policy);
  const hash = createHash(HISTORICAL_CONTINUITY_HASH_ALGORITHM).update(canonical, 'utf8').digest('hex');
  return {
    policy,
    lineage: {
      continuity_policy_version: HISTORICAL_CONTINUITY_SCHEMA_VERSION,
      continuity_policy_id: policy.policy_id,
      continuity_policy_hash: hash,
      continuity_policy_hash_algorithm: HISTORICAL_CONTINUITY_HASH_ALGORITHM,
      canonical_continuity_policy_json: canonical,
    },
    source_file: sourceFile,
  };
}

function readVersion(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (record.version !== HISTORICAL_CONTINUITY_SCHEMA_VERSION) {
    issues.push({ path: `${path}.version`, message: `expected ${HISTORICAL_CONTINUITY_SCHEMA_VERSION}` });
  }
}

function readCoverageStartYear(
  record: Record<string, unknown>,
  issues: ConfigValidationIssue[],
): 2017 {
  const value = readNumber(record, 'coverage_start_year', '$', issues);
  if (value !== 2017) {
    issues.push({ path: '$.coverage_start_year', message: 'expected 2017' });
  }
  return 2017;
}

function compareIssues(left: ConfigValidationIssue, right: ConfigValidationIssue): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.message < right.message) return -1;
  if (left.message > right.message) return 1;
  return 0;
}

export const DEFAULT_HISTORICAL_CONTINUITY_POLICY = {
  version: HISTORICAL_CONTINUITY_SCHEMA_VERSION,
  policy_id: 'databento_mnq_nq_2017_v1',
  coverage_start_year: 2017,
  source_provider: 'databento',
  exchange_event_ts_ns_basis: 'exchange_event_ts_ns',
  canonical_instrument_root: 'MNQ',
  surrogate_instrument_root: 'NQ',
  mnq_canonical_start_ts_ns: ns('1557149400000000000'),
  normalization_policy: 'tick_r_volatility_v1',
  domains: {
    MNQ_CANONICAL: {
      instrument_root: 'MNQ',
      domain: 'MNQ_CANONICAL',
      surrogate_for: 'none',
      normalization_policy: 'tick_r_volatility_v1',
      source_provider: 'databento',
      exchange_event_ts_ns_basis: 'exchange_event_ts_ns',
    },
    NQ_SURROGATE_PRE_MNQ: {
      instrument_root: 'NQ',
      domain: 'NQ_SURROGATE_PRE_MNQ',
      surrogate_for: 'MNQ',
      normalization_policy: 'tick_r_volatility_v1',
      source_provider: 'databento',
      exchange_event_ts_ns_basis: 'exchange_event_ts_ns',
    },
  },
} as const satisfies HistoricalContinuityPolicy;
