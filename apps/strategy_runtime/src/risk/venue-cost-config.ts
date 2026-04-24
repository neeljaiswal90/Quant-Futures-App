import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isContractRoot,
  parseContractRoot,
  SUPPORTED_CONTRACT_ROOTS,
  type ContractRoot,
} from './contracts.js';
import type { VenueCostConfig } from './costs.js';

export interface VenueCostTable {
  readonly effective_date: string;
  readonly assumption_source: string;
  readonly configs: Readonly<Record<ContractRoot, VenueCostConfig>>;
  readonly source_path?: string;
}

export interface RawVenueCostConfigFile {
  readonly commission_schedule_effective_date?: unknown;
  readonly cost_assumption_source?: unknown;
  readonly contracts?: unknown;
}

export const DEFAULT_VENUE_COST_CONFIG_PATH = 'config/venue-costs.json' as const;

export function loadVenueCostTable(path = DEFAULT_VENUE_COST_CONFIG_PATH): VenueCostTable {
  const resolvedPath = resolve(path);
  const raw = JSON.parse(readFileSync(resolvedPath, 'utf8')) as RawVenueCostConfigFile;
  return parseVenueCostTable(raw, resolvedPath);
}

export function parseVenueCostTable(
  raw: RawVenueCostConfigFile,
  sourcePath?: string,
): VenueCostTable {
  const effectiveDate = requireString(
    raw.commission_schedule_effective_date,
    'commission_schedule_effective_date',
  );
  const assumptionSource = requireString(raw.cost_assumption_source, 'cost_assumption_source');
  if (raw.contracts === null || typeof raw.contracts !== 'object' || Array.isArray(raw.contracts)) {
    throw new Error('contracts must be an object keyed by contract root');
  }

  const configs = {} as Record<ContractRoot, VenueCostConfig>;
  const contractRecords = raw.contracts as Record<string, unknown>;
  for (const root of SUPPORTED_CONTRACT_ROOTS) {
    const value = contractRecords[root];
    if (value === undefined) {
      throw new Error(`contracts.${root} is required`);
    }
    configs[root] = parseVenueCostConfig(root, value, effectiveDate, assumptionSource);
  }

  for (const key of Object.keys(contractRecords).sort()) {
    if (!isContractRoot(key)) {
      throw new Error(`contracts.${key} is not a supported contract root`);
    }
  }

  return {
    effective_date: effectiveDate,
    assumption_source: assumptionSource,
    configs,
    source_path: sourcePath,
  };
}

export function getVenueCostConfig(
  table: VenueCostTable,
  rootOrSymbol: ContractRoot | string,
): VenueCostConfig {
  return table.configs[parseContractRoot(rootOrSymbol)];
}

function parseVenueCostConfig(
  root: ContractRoot,
  raw: unknown,
  effectiveDate: string,
  assumptionSource: string,
): VenueCostConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`contracts.${root} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  return {
    root,
    commission_per_side_per_contract_usd: requireNonNegativeNumber(
      record.commission_per_side_per_contract_usd,
      `contracts.${root}.commission_per_side_per_contract_usd`,
    ),
    exchange_fees_per_side_per_contract_usd: requireNonNegativeNumber(
      record.exchange_fees_per_side_per_contract_usd,
      `contracts.${root}.exchange_fees_per_side_per_contract_usd`,
    ),
    effective_date: effectiveDate,
    assumption_source: assumptionSource,
  };
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
  return value;
}
