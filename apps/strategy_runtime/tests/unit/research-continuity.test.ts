import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigValidationError } from '../../src/config/index.js';
import { ns } from '../../src/contracts/time.js';
import {
  buildResearchDatasetContinuityLineage,
  computeHistoricalContinuityPolicyHash,
  loadHistoricalContinuityPolicy,
  validateResearchDatasetContinuityLineage,
  type HistoricalContinuityPolicy,
  type ResearchDatasetContinuityLineage,
} from '../../src/research/index.js';

const tempDirs: string[] = [];

function makeTempRoot() {
  const directory = mkdtempSync(join(tmpdir(), 'quant-rsrch-00-'));
  tempDirs.push(directory);
  return directory;
}

function writeTempPolicy(contents: string): { readonly root: string; readonly fileName: string } {
  const root = makeTempRoot();
  const fileName = 'historical-continuity.yaml';
  writeFileSync(join(root, fileName), contents);
  return { root, fileName };
}

describe('RSRCH-00 historical continuity policy', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads and validates the committed continuity policy', () => {
    const loaded = loadHistoricalContinuityPolicy({
      cwd: process.cwd(),
      path: 'config/research/historical-continuity.yaml',
      required: true,
    });

    expect(loaded.policy.coverage_start_year).toBe(2017);
    expect(loaded.policy.domains.MNQ_CANONICAL.instrument_root).toBe('MNQ');
    expect(loaded.policy.domains.NQ_SURROGATE_PRE_MNQ.surrogate_for).toBe('MNQ');
    expect(loaded.lineage.continuity_policy_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(computeHistoricalContinuityPolicyHash(loaded)).toBe(
      loaded.lineage.continuity_policy_hash,
    );
  });

  it('marks pre-MNQ windows as explicit NQ surrogate lineage', () => {
    const loaded = loadHistoricalContinuityPolicy({ required: false });
    const lineage = buildResearchDatasetContinuityLineage(loaded, {
      exchange_event_ts_ns: ns('1514892600000000000'),
      contract_symbol: 'NQH7',
    });

    expect(lineage).toMatchObject({
      instrument_root: 'NQ',
      contract_symbol: 'NQH7',
      domain: 'NQ_SURROGATE_PRE_MNQ',
      surrogate_for: 'MNQ',
      normalization_policy: 'tick_r_volatility_v1',
      source_provider: 'databento',
      exchange_event_ts_ns_basis: 'exchange_event_ts_ns',
    });
  });

  it('marks post-MNQ windows as canonical MNQ lineage', () => {
    const loaded = loadHistoricalContinuityPolicy({ required: false });
    const lineage = buildResearchDatasetContinuityLineage(loaded, {
      exchange_event_ts_ns: ns('1780666200000000000'),
      contract_symbol: 'MNQM6',
    });

    expect(lineage).toMatchObject({
      instrument_root: 'MNQ',
      contract_symbol: 'MNQM6',
      domain: 'MNQ_CANONICAL',
      surrogate_for: 'none',
    });
  });

  it('rejects silent MNQ/NQ domain mixing in dataset lineage', () => {
    const loaded = loadHistoricalContinuityPolicy({ required: false });
    const badLineage: ResearchDatasetContinuityLineage = {
      continuity_policy_id: loaded.lineage.continuity_policy_id,
      continuity_policy_version: loaded.lineage.continuity_policy_version,
      continuity_policy_hash: loaded.lineage.continuity_policy_hash,
      instrument_root: 'MNQ',
      contract_symbol: 'MNQH7',
      domain: 'NQ_SURROGATE_PRE_MNQ',
      surrogate_for: 'none',
      normalization_policy: 'tick_r_volatility_v1',
      source_provider: 'databento',
      exchange_event_ts_ns_basis: 'exchange_event_ts_ns',
    };

    expect(validateResearchDatasetContinuityLineage(badLineage, loaded)).toEqual(
      expect.arrayContaining([
        { path: '$.instrument_root', message: 'expected NQ' },
        { path: '$.surrogate_for', message: 'expected MNQ' },
        { path: '$.contract_symbol', message: 'expected NQ contract symbol' },
      ]),
    );
  });

  it('rejects invalid continuity YAML with clear issue paths', () => {
    const source = `version: 1
policy_id: databento_mnq_nq_2017_v1
coverage_start_year: 2017
source_provider: other_provider
exchange_event_ts_ns_basis: exchange_event_ts_ns
canonical_instrument_root: MNQ
surrogate_instrument_root: NQ
mnq_canonical_start_ts_ns: "1557149400000000000"
normalization_policy: tick_r_volatility_v1
domains:
  MNQ_CANONICAL:
    instrument_root: MNQ
    domain: MNQ_CANONICAL
    surrogate_for: none
    normalization_policy: tick_r_volatility_v1
    source_provider: databento
    exchange_event_ts_ns_basis: exchange_event_ts_ns
  NQ_SURROGATE_PRE_MNQ:
    instrument_root: MNQ
    domain: NQ_SURROGATE_PRE_MNQ
    surrogate_for: MNQ
    normalization_policy: tick_r_volatility_v1
    source_provider: databento
    exchange_event_ts_ns_basis: exchange_event_ts_ns
`;
    const { root, fileName } = writeTempPolicy(source);

    expect(() => loadHistoricalContinuityPolicy({ cwd: root, path: fileName, required: true }))
      .toThrow(ConfigValidationError);
    try {
      loadHistoricalContinuityPolicy({ cwd: root, path: fileName, required: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toContainEqual({
        path: '$.source_provider',
        message: 'expected one of: databento',
      });
      expect((error as ConfigValidationError).issues).toContainEqual({
        path: '$.domains.NQ_SURROGATE_PRE_MNQ.instrument_root',
        message: 'expected NQ',
      });
    }
  });

  it('keeps the continuity policy hash stable across object key reordering', () => {
    const loaded = loadHistoricalContinuityPolicy({ required: false });
    const policy = loaded.policy;
    const reordered: HistoricalContinuityPolicy = {
      domains: {
        NQ_SURROGATE_PRE_MNQ: policy.domains.NQ_SURROGATE_PRE_MNQ,
        MNQ_CANONICAL: policy.domains.MNQ_CANONICAL,
      },
      normalization_policy: policy.normalization_policy,
      mnq_canonical_start_ts_ns: policy.mnq_canonical_start_ts_ns,
      surrogate_instrument_root: policy.surrogate_instrument_root,
      canonical_instrument_root: policy.canonical_instrument_root,
      exchange_event_ts_ns_basis: policy.exchange_event_ts_ns_basis,
      source_provider: policy.source_provider,
      coverage_start_year: policy.coverage_start_year,
      policy_id: policy.policy_id,
      version: policy.version,
    };

    expect(computeHistoricalContinuityPolicyHash(reordered)).toBe(
      loaded.lineage.continuity_policy_hash,
    );
  });

  it('produces deterministic lineage across repeated runs', () => {
    const loaded = loadHistoricalContinuityPolicy({ required: false });
    const input = {
      exchange_event_ts_ns: ns('1514892600000000000'),
      contract_symbol: 'NQH7',
    };

    expect(buildResearchDatasetContinuityLineage(loaded, input)).toEqual(
      buildResearchDatasetContinuityLineage(loaded, input),
    );
  });
});
