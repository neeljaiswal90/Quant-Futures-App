/**
 * MEAS-01 slice 3 — venue cost config loader.
 *
 * Reads config/venue-costs.json and returns a VenueCostConfig lookup by
 * contract root. The schedule effective date and cost_assumption_source
 * live at the file level; per-contract entries only carry the two fee
 * fields. Loader composes them into a full VenueCostConfig per root.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getContractSpec } from './contracts.js';
import type { VenueCostConfig } from './costs.js';

interface RawVenueCostFile {
  commission_schedule_effective_date: string;
  cost_assumption_source: string;
  contracts: Record<
    string,
    {
      commission_per_side_per_contract_usd: number;
      exchange_fees_per_side_per_contract_usd: number;
    }
  >;
}

let cached: Map<string, VenueCostConfig> | null = null;

/** Reset cache — test helper. */
export function resetVenueCostCache(): void {
  cached = null;
}

/**
 * Load the venue-cost table. Default path resolves relative to CWD so the
 * runner picks it up from the repo root. Throws if the file is missing or
 * malformed — MEAS-01 requires net costs on every completed trade; silent
 * fallback would undermine the audit.
 */
export function loadVenueCostConfig(
  filePath: string = path.join(process.cwd(), 'config', 'venue-costs.json'),
): Map<string, VenueCostConfig> {
  if (cached) return cached;

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as RawVenueCostFile;

  if (!parsed.commission_schedule_effective_date) {
    throw new Error(`venue-cost-config: missing commission_schedule_effective_date in ${filePath}`);
  }
  if (!parsed.cost_assumption_source) {
    throw new Error(`venue-cost-config: missing cost_assumption_source in ${filePath}`);
  }
  if (!parsed.contracts || typeof parsed.contracts !== 'object') {
    throw new Error(`venue-cost-config: missing contracts map in ${filePath}`);
  }

  const map = new Map<string, VenueCostConfig>();
  for (const [root, entry] of Object.entries(parsed.contracts)) {
    if (
      typeof entry.commission_per_side_per_contract_usd !== 'number' ||
      typeof entry.exchange_fees_per_side_per_contract_usd !== 'number'
    ) {
      throw new Error(`venue-cost-config: invalid entry for "${root}"`);
    }
    map.set(root.toUpperCase(), {
      commission_per_side_per_contract_usd: entry.commission_per_side_per_contract_usd,
      exchange_fees_per_side_per_contract_usd: entry.exchange_fees_per_side_per_contract_usd,
      commission_schedule_effective_date: parsed.commission_schedule_effective_date,
      cost_assumption_source: parsed.cost_assumption_source,
    });
  }
  cached = map;
  return cached;
}

/** Resolve a VenueCostConfig for a given symbol (e.g. "MNQ1!"). Null if unknown. */
export function getVenueCostForSymbol(
  symbol: string,
  table: Map<string, VenueCostConfig>,
): VenueCostConfig | null {
  const spec = (() => {
    try {
      return getContractSpec(symbol);
    } catch {
      return null;
    }
  })();
  if (!spec) return null;
  return table.get(spec.root) ?? null;
}
