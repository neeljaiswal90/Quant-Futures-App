import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildInfra01eDecisionReport,
  writeInfra01eDecisionReport,
} from '../../../../scripts/infra/write-infra01e-decision-report.js';

const tempDirectories: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-infra01e-'));
  tempDirectories.push(directory);
  return directory;
}

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

describe('INFRA-01E cross-source parity decision report', () => {
  it('builds a stable safe summary without promoting full DATA-01', () => {
    const report = buildInfra01eDecisionReport();

    expect(report).toMatchObject({
      schema_version: 1,
      ticket_id: 'INFRA-01E',
      status: 'partial_pass_mbp10_price_state',
      data01b_mbp10_price_state_eligible: true,
      data01_full_eligible: false,
      classification: 'provider_rendering_variance',
      route_to: 'DATA-01B_MBP10_PRICE_STATE_SUBSCOPE',
      accepted_tolerance: {
        cross_source_top_of_book_price_state_min_pct: 95,
        internal_provider_consistency_min_pct: 99.5,
      },
    });
    expect(report.remaining_blocks).toContain('MBO_PARITY_NOT_COMPLETE');
    expect(report.diagnostic_only).toEqual(['MBP10_SIZE', 'MBP10_ORDER_COUNT']);
  });

  it('writes deterministic report JSON', () => {
    const firstPath = join(makeTempDir(), 'first.json');
    const secondPath = join(makeTempDir(), 'second.json');

    writeInfra01eDecisionReport(firstPath);
    writeInfra01eDecisionReport(secondPath);

    expect(readFileSync(firstPath, 'utf8')).toBe(readFileSync(secondPath, 'utf8'));
  });

  it('documents provider-internal replay and diagnostic-only size/order-count guardrails', () => {
    const adr = readRepoFile('docs/adr/ADR-0002-cross-source-market-data-parity.md');
    const infra = readRepoFile('docs/infra/INFRA-01.md');
    const databento = readRepoFile('docs/infra/DATABENTO-OVERLAP-PARITY.md');

    expect(adr).toContain('Replay byte-identity is provider-internal');
    expect(adr).toContain('Size and order-count parity are diagnostic only');
    expect(infra).toContain('Replay byte-identity is provider-internal');
    expect(infra).toContain('Size and order-count parity remain diagnostic only');
    expect(databento).toContain('MBP10 size parity');
    expect(databento).toContain('MBP10 order-count parity');
    expect(databento).toContain('data01_full_eligible = false');
  });

  it('keeps INFRA-01E narrow and leaves full DATA-01 blocked in policy text', () => {
    const adr = readRepoFile('docs/adr/ADR-0002-cross-source-market-data-parity.md');
    const infra = readRepoFile('docs/infra/INFRA-01.md');

    expect(adr).toContain('Full `DATA-01B` is not automatically passed by the policy decision');
    expect(adr).toContain('Full `DATA-01` remains blocked');
    expect(infra).toContain('Full DATA-01B remained partially blocked at INFRA-01E');
    expect(infra).toContain('data01_full_eligible = false');
  });
});
