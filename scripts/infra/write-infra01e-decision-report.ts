#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import { stableJsonStringify, type JsonValue } from '../../apps/strategy_runtime/src/contracts/index.js';

export const INFRA01E_DECISION_SCHEMA_VERSION = 1 as const;

export interface Infra01eDecisionReport {
  readonly schema_version: typeof INFRA01E_DECISION_SCHEMA_VERSION;
  readonly ticket_id: 'INFRA-01E';
  readonly status: 'partial_pass_mbp10_price_state';
  readonly data01b_mbp10_price_state_eligible: true;
  readonly data01_full_eligible: false;
  readonly rithmic_internal_agreement_pct: 99.647858;
  readonly databento_internal_agreement_pct: 99.965621;
  readonly cross_source_l1_agreement_pct: 96.92945;
  readonly cross_source_mbp10_agreement_pct: 95.993782;
  readonly classification: 'provider_rendering_variance';
  readonly accepted_tolerance: {
    readonly cross_source_top_of_book_price_state_min_pct: 95;
    readonly internal_provider_consistency_min_pct: 99.5;
    readonly basis: 'both_providers_internal_consistency_above_threshold_and_cross_source_delta_triangulated';
  };
  readonly accepted_scope: readonly [
    'MBP10_PRICE_STATE',
    'TOP_OF_BOOK_PRICE_STATE',
    'EXCHANGE_EVENT_TIME_ALIGNMENT',
  ];
  readonly diagnostic_only: readonly ['MBP10_SIZE', 'MBP10_ORDER_COUNT'];
  readonly remaining_blocks: readonly [
    'MBO_PARITY_NOT_COMPLETE',
    'MBO_DERIVED_FEATURES_BLOCKED',
    'QUEUE_POSITION_FEATURES_BLOCKED',
    'SIZE_AND_ORDER_COUNT_NOT_HARD_GATED',
    'FULL_DATA01B_REQUIRES_MBO_ACCEPTANCE',
    'FULL_DATA01_REQUIRES_REVISED_INFRA01_ROUTE_TO_DATA01',
  ];
  readonly route_to: 'DATA-01B_MBP10_PRICE_STATE_SUBSCOPE';
  readonly notes: readonly string[];
}

const DEFAULT_OUT_PATH = 'reports/infra/infra01_revised_timestamp_gate_post04d_summary.json';

export function buildInfra01eDecisionReport(): Infra01eDecisionReport {
  return {
    schema_version: INFRA01E_DECISION_SCHEMA_VERSION,
    ticket_id: 'INFRA-01E',
    status: 'partial_pass_mbp10_price_state',
    data01b_mbp10_price_state_eligible: true,
    data01_full_eligible: false,
    rithmic_internal_agreement_pct: 99.647858,
    databento_internal_agreement_pct: 99.965621,
    cross_source_l1_agreement_pct: 96.92945,
    cross_source_mbp10_agreement_pct: 95.993782,
    classification: 'provider_rendering_variance',
    accepted_tolerance: {
      cross_source_top_of_book_price_state_min_pct: 95,
      internal_provider_consistency_min_pct: 99.5,
      basis: 'both_providers_internal_consistency_above_threshold_and_cross_source_delta_triangulated',
    },
    accepted_scope: [
      'MBP10_PRICE_STATE',
      'TOP_OF_BOOK_PRICE_STATE',
      'EXCHANGE_EVENT_TIME_ALIGNMENT',
    ],
    diagnostic_only: ['MBP10_SIZE', 'MBP10_ORDER_COUNT'],
    remaining_blocks: [
      'MBO_PARITY_NOT_COMPLETE',
      'MBO_DERIVED_FEATURES_BLOCKED',
      'QUEUE_POSITION_FEATURES_BLOCKED',
      'SIZE_AND_ORDER_COUNT_NOT_HARD_GATED',
      'FULL_DATA01B_REQUIRES_MBO_ACCEPTANCE',
      'FULL_DATA01_REQUIRES_REVISED_INFRA01_ROUTE_TO_DATA01',
    ],
    route_to: 'DATA-01B_MBP10_PRICE_STATE_SUBSCOPE',
    notes: [
      'Rithmic remains canonical for live market data.',
      'Databento remains canonical for historical, replay, and research data.',
      'Cross-source MBP10 price-state disagreement is accepted as provider/rendering variance for V1 after internal provider consistency passed above 99.5%.',
      'Replay byte-identity is provider-internal, not Rithmic-vs-Databento.',
      'MBO parity is not complete; full DATA-01B and full DATA-01 remain blocked.',
    ],
  };
}

export function writeInfra01eDecisionReport(outPath: string): Infra01eDecisionReport {
  const report = buildInfra01eDecisionReport();
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
  return report;
}

function usage(): string {
  return [
    'Usage: npm run infra:01e:decision -- --out <report.json>',
    '',
    `Default --out: ${DEFAULT_OUT_PATH}`,
  ].join('\n');
}

function parseArgs(argv: readonly string[]): { readonly out_path: string } {
  let outPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
    }
    if (arg === '--out') {
      outPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return {
    out_path: outPath ?? DEFAULT_OUT_PATH,
  };
}

function main(): void {
  try {
    const args = parseArgs(processArgv.slice(2));
    const report = writeInfra01eDecisionReport(args.out_path);
    processStdout.write(
      [
        'INFRA-01E decision report: partial_pass_mbp10_price_state',
        `data01b_mbp10_price_state_eligible=${report.data01b_mbp10_price_state_eligible}`,
        `data01_full_eligible=${report.data01_full_eligible}`,
        `classification=${report.classification}`,
        `route_to=${report.route_to}`,
        'Full DATA-01B and DATA-01 remain blocked pending MBO parity and revised INFRA-01 routing.',
        '',
      ].join('\n'),
    );
    processExit(0);
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
