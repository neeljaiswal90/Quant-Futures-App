import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildInfra01fDecisionReport,
  extractMboPolicyEvidenceFromReport,
  writeInfra01fDecisionReport,
} from '../../../../scripts/infra/write-infra01f-decision-report.js';

const tempDirectories: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-infra01f-'));
  tempDirectories.push(directory);
  return directory;
}

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function syntheticMboParityReport(): Record<string, unknown> {
  return {
    rithmic_mbo: {
      event_count: 10,
      timestamp_coverage_pct: 100,
      order_id_coverage_pct: 100,
      price_sanity: { tick_aligned_pct: 100 },
      sequence_analysis: { non_decreasing: true },
    },
    databento_mbo: {
      event_count: 11,
      timestamp_coverage_pct: 100,
      order_id_coverage_pct: 100,
      price_sanity: { tick_aligned_pct: 100 },
      sequence_analysis: { non_decreasing: true },
    },
    cross_source: {
      signature_match_pct_of_databento: 90.9,
    },
    mbo_action_taxonomy: {
      alternate_signature_modes: {
        structural_book_actions_only: {
          match_pct_of_databento: 96,
        },
      },
      event_semantics_decomposition: {
        unmatched_databento_trade_or_unknown_pct: 55,
      },
      classification: 'action_taxonomy_mismatch',
    },
  };
}

describe('INFRA-01F MBO policy decision report', () => {
  it('builds a stable MBO sub-scope decision without promoting full DATA-01', () => {
    const report = buildInfra01fDecisionReport();

    expect(report).toMatchObject({
      schema_version: 1,
      ticket_id: 'INFRA-01F',
      status: 'partial_pass_mbo_provider_internal_subscope',
      mbo_policy_decision: 'accepted_subscope',
      data01b_mbo_subscope_eligible: true,
      data01b_full_eligible: false,
      data01_full_eligible: false,
      classification: 'mbo_action_taxonomy_provider_variance',
      route_to: 'DATA-01B_MBO_PROVIDER_INTERNAL_SUBSCOPE',
      accepted_tolerance: {
        structural_book_action_match_min_pct: 95,
        strict_cross_feed_order_identity_required: false,
      },
    });
    expect(report.accepted_scope).toContain('MBO_PROVIDER_INTERNAL_ORDER_LIFECYCLE');
    expect(report.not_accepted_scope).toContain('RITHMIC_DATABENTO_ORDER_BY_ORDER_BYTE_IDENTITY');
    expect(report.remaining_blocks).toContain('FULL_DATA01_REQUIRES_REVISED_INFRA01_ROUTE_TO_DATA01');
  });

  it('extracts safe evidence from a DATA-PARITY-11 report shape', () => {
    expect(extractMboPolicyEvidenceFromReport(syntheticMboParityReport())).toMatchObject({
      rithmic_mbo_event_count: 10,
      databento_mbo_event_count: 11,
      rithmic_timestamp_coverage_pct: 100,
      databento_timestamp_coverage_pct: 100,
      strict_signature_match_pct_of_databento: 90.9,
      structural_book_action_match_pct_of_databento: 96,
      unmatched_trade_unknown_pct_of_unmatched_databento: 55,
      taxonomy_classification: 'action_taxonomy_mismatch',
    });
  });

  it('writes deterministic report JSON', () => {
    const firstPath = join(makeTempDir(), 'first.json');
    const secondPath = join(makeTempDir(), 'second.json');
    const evidence = extractMboPolicyEvidenceFromReport(syntheticMboParityReport());

    writeInfra01fDecisionReport(firstPath, evidence);
    writeInfra01fDecisionReport(secondPath, evidence);

    expect(readFileSync(firstPath, 'utf8')).toBe(readFileSync(secondPath, 'utf8'));
  });

  it('documents MBO provider variance, provider-internal replay, and remaining gate blocks', () => {
    const adr = readRepoFile('docs/adr/ADR-0002-cross-source-market-data-parity.md');
    const infra = readRepoFile('docs/infra/INFRA-01.md');
    const databento = readRepoFile('docs/infra/DATABENTO-OVERLAP-PARITY.md');
    const mbo = readRepoFile('docs/infra/DATA-PARITY-10-MBO-PARITY.md');

    expect(adr).toContain('MBO provider-internal sub-scope');
    expect(adr).toContain('Rithmic-vs-Databento order-by-order byte identity is not accepted');
    expect(infra).toContain('INFRA-01F MBO Provider-Internal Decision');
    expect(infra).toContain('data01b_mbo_subscope_eligible = true');
    expect(databento).toContain('MBO provider-internal sub-scope');
    expect(mbo).toContain('INFRA-01F accepts MBO as a provider-internal sub-scope');
  });

  it('keeps full DATA-01 and REL gates blocked in policy text', () => {
    const adr = readRepoFile('docs/adr/ADR-0002-cross-source-market-data-parity.md');
    const infra = readRepoFile('docs/infra/INFRA-01.md');

    expect(adr).toContain('Full `DATA-01` remains blocked');
    expect(adr).toContain('REL gates still require provider-internal replay evidence');
    expect(infra).toContain('data01_full_eligible = false');
    expect(infra).toContain('REL gates remain blocked');
  });
});
