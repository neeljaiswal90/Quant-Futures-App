#!/usr/bin/env tsx

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import { stableJsonStringify, type JsonValue } from '../../apps/strategy_runtime/src/contracts/index.js';

export const INFRA01F_DECISION_SCHEMA_VERSION = 1 as const;

export interface MboPolicyEvidence {
  readonly rithmic_mbo_event_count: number;
  readonly databento_mbo_event_count: number;
  readonly rithmic_timestamp_coverage_pct: number;
  readonly databento_timestamp_coverage_pct: number;
  readonly rithmic_order_id_coverage_pct: number;
  readonly databento_order_id_coverage_pct: number;
  readonly rithmic_price_tick_alignment_pct: number;
  readonly databento_price_tick_alignment_pct: number;
  readonly rithmic_sequence_non_decreasing: boolean;
  readonly databento_sequence_non_decreasing: boolean;
  readonly strict_signature_match_pct_of_databento: number;
  readonly structural_book_action_match_pct_of_databento: number;
  readonly unmatched_trade_unknown_pct_of_unmatched_databento: number;
  readonly taxonomy_classification: string;
}

export interface Infra01fDecisionReport {
  readonly schema_version: typeof INFRA01F_DECISION_SCHEMA_VERSION;
  readonly ticket_id: 'INFRA-01F';
  readonly status: 'partial_pass_mbo_provider_internal_subscope';
  readonly mbo_policy_decision: 'accepted_subscope';
  readonly data01b_mbo_subscope_eligible: true;
  readonly data01b_full_eligible: false;
  readonly data01_full_eligible: false;
  readonly evidence: MboPolicyEvidence;
  readonly classification: 'mbo_action_taxonomy_provider_variance';
  readonly accepted_tolerance: {
    readonly provider_internal_integrity_required: true;
    readonly structural_book_action_match_min_pct: 95;
    readonly strict_cross_feed_order_identity_required: false;
    readonly basis: 'provider_internal_integrity_clean_and_cross_source_taxonomy_variance_documented';
  };
  readonly accepted_scope: readonly [
    'MBO_PROVIDER_INTERNAL_ORDER_LIFECYCLE',
    'MBO_SINGLE_PROVIDER_QUEUE_POSITION_ESTIMATION',
    'MBO_SINGLE_PROVIDER_MICROSTRUCTURE_FEATURES',
  ];
  readonly diagnostic_only: readonly [
    'CROSS_SOURCE_MBO_TRADE_UNKNOWN_ACTION_EQUIVALENCE',
    'CROSS_SOURCE_ORDER_ID_BYTE_IDENTITY',
    'MBP10_SIZE_ORDER_COUNT_AUTHORITY',
  ];
  readonly not_accepted_scope: readonly [
    'RITHMIC_DATABENTO_ORDER_BY_ORDER_BYTE_IDENTITY',
    'CROSS_FEED_ORDER_ID_REPLAY_PARITY',
    'CROSS_FEED_TRADE_UNKNOWN_ACTION_HARD_GATE',
  ];
  readonly remaining_blocks: readonly [
    'MBO_CONSUMER_IMPLEMENTATION_NOT_COMPLETE',
    'DATA03_AUTHORITY_FSM_NOT_COMPLETE',
    'DATA04_FULL_MICROSTRUCTURE_FEATURE_ENGINE_NOT_COMPLETE',
    'SIM02_SIM03_CALIBRATION_NOT_STARTED',
    'FULL_DATA01_REQUIRES_REVISED_INFRA01_ROUTE_TO_DATA01',
    'REL_GATES_REQUIRE_PROVIDER_INTERNAL_REPLAY_EVIDENCE',
  ];
  readonly route_to: 'DATA-01B_MBO_PROVIDER_INTERNAL_SUBSCOPE';
  readonly notes: readonly string[];
}

const DEFAULT_OUT_PATH = 'reports/infra/infra01f_mbo_policy_decision_post04d_summary.json';

const REVIEWED_POST04D_EVIDENCE: MboPolicyEvidence = {
  rithmic_mbo_event_count: 2_842_114,
  databento_mbo_event_count: 3_159_591,
  rithmic_timestamp_coverage_pct: 100,
  databento_timestamp_coverage_pct: 100,
  rithmic_order_id_coverage_pct: 100,
  databento_order_id_coverage_pct: 100,
  rithmic_price_tick_alignment_pct: 100,
  databento_price_tick_alignment_pct: 100,
  rithmic_sequence_non_decreasing: true,
  databento_sequence_non_decreasing: true,
  strict_signature_match_pct_of_databento: 89.951959,
  structural_book_action_match_pct_of_databento: 95.17,
  unmatched_trade_unknown_pct_of_unmatched_databento: 54.6,
  taxonomy_classification: 'action_taxonomy_mismatch',
};

export function buildInfra01fDecisionReport(
  evidence: MboPolicyEvidence = REVIEWED_POST04D_EVIDENCE,
): Infra01fDecisionReport {
  return {
    schema_version: INFRA01F_DECISION_SCHEMA_VERSION,
    ticket_id: 'INFRA-01F',
    status: 'partial_pass_mbo_provider_internal_subscope',
    mbo_policy_decision: 'accepted_subscope',
    data01b_mbo_subscope_eligible: true,
    data01b_full_eligible: false,
    data01_full_eligible: false,
    evidence,
    classification: 'mbo_action_taxonomy_provider_variance',
    accepted_tolerance: {
      provider_internal_integrity_required: true,
      structural_book_action_match_min_pct: 95,
      strict_cross_feed_order_identity_required: false,
      basis: 'provider_internal_integrity_clean_and_cross_source_taxonomy_variance_documented',
    },
    accepted_scope: [
      'MBO_PROVIDER_INTERNAL_ORDER_LIFECYCLE',
      'MBO_SINGLE_PROVIDER_QUEUE_POSITION_ESTIMATION',
      'MBO_SINGLE_PROVIDER_MICROSTRUCTURE_FEATURES',
    ],
    diagnostic_only: [
      'CROSS_SOURCE_MBO_TRADE_UNKNOWN_ACTION_EQUIVALENCE',
      'CROSS_SOURCE_ORDER_ID_BYTE_IDENTITY',
      'MBP10_SIZE_ORDER_COUNT_AUTHORITY',
    ],
    not_accepted_scope: [
      'RITHMIC_DATABENTO_ORDER_BY_ORDER_BYTE_IDENTITY',
      'CROSS_FEED_ORDER_ID_REPLAY_PARITY',
      'CROSS_FEED_TRADE_UNKNOWN_ACTION_HARD_GATE',
    ],
    remaining_blocks: [
      'MBO_CONSUMER_IMPLEMENTATION_NOT_COMPLETE',
      'DATA03_AUTHORITY_FSM_NOT_COMPLETE',
      'DATA04_FULL_MICROSTRUCTURE_FEATURE_ENGINE_NOT_COMPLETE',
      'SIM02_SIM03_CALIBRATION_NOT_STARTED',
      'FULL_DATA01_REQUIRES_REVISED_INFRA01_ROUTE_TO_DATA01',
      'REL_GATES_REQUIRE_PROVIDER_INTERNAL_REPLAY_EVIDENCE',
    ],
    route_to: 'DATA-01B_MBO_PROVIDER_INTERNAL_SUBSCOPE',
    notes: [
      'Rithmic remains canonical for live market data; Databento remains canonical for historical, replay, and research data.',
      'MBO is accepted only for provider-internal lifecycle, queue-position, and microstructure work under documented cross-source taxonomy variance.',
      'Rithmic-vs-Databento order-by-order byte identity is not accepted and is not required for V1 replay parity.',
      'Databento trade/unknown MBO actions remain diagnostic cross-source taxonomy evidence, not hard parity failures.',
      'Full DATA-01 and REL gates still require implementation evidence and provider-internal replay evidence before promotion.',
    ],
  };
}

export function extractMboPolicyEvidenceFromReport(report: unknown): MboPolicyEvidence {
  return {
    rithmic_mbo_event_count: numberAt(report, ['rithmic_mbo', 'event_count']),
    databento_mbo_event_count: numberAt(report, ['databento_mbo', 'event_count']),
    rithmic_timestamp_coverage_pct: numberAt(report, ['rithmic_mbo', 'timestamp_coverage_pct']),
    databento_timestamp_coverage_pct: numberAt(report, ['databento_mbo', 'timestamp_coverage_pct']),
    rithmic_order_id_coverage_pct: numberAt(report, ['rithmic_mbo', 'order_id_coverage_pct']),
    databento_order_id_coverage_pct: numberAt(report, ['databento_mbo', 'order_id_coverage_pct']),
    rithmic_price_tick_alignment_pct: numberAt(report, ['rithmic_mbo', 'price_sanity', 'tick_aligned_pct']),
    databento_price_tick_alignment_pct: numberAt(report, ['databento_mbo', 'price_sanity', 'tick_aligned_pct']),
    rithmic_sequence_non_decreasing: booleanAt(report, ['rithmic_mbo', 'sequence_analysis', 'non_decreasing']),
    databento_sequence_non_decreasing: booleanAt(report, ['databento_mbo', 'sequence_analysis', 'non_decreasing']),
    strict_signature_match_pct_of_databento: numberAt(report, ['cross_source', 'signature_match_pct_of_databento']),
    structural_book_action_match_pct_of_databento: numberAt(report, [
      'mbo_action_taxonomy',
      'alternate_signature_modes',
      'structural_book_actions_only',
      'match_pct_of_databento',
    ]),
    unmatched_trade_unknown_pct_of_unmatched_databento: numberAt(report, [
      'mbo_action_taxonomy',
      'event_semantics_decomposition',
      'unmatched_databento_trade_or_unknown_pct',
    ]),
    taxonomy_classification: stringAt(report, ['mbo_action_taxonomy', 'classification']),
  };
}

export function writeInfra01fDecisionReport(
  outPath: string,
  evidence: MboPolicyEvidence = REVIEWED_POST04D_EVIDENCE,
): Infra01fDecisionReport {
  const report = buildInfra01fDecisionReport(evidence);
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
  return report;
}

function usage(): string {
  return [
    'Usage: npm run infra:01f:decision -- [--mbo-parity <report.json>] [--out <report.json>]',
    '',
    `Default --out: ${DEFAULT_OUT_PATH}`,
    'When --mbo-parity is omitted, the reviewed post04D MBO policy evidence is used.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): {
  readonly out_path: string;
  readonly mbo_parity_path: string | null;
} {
  let outPath: string | undefined;
  let mboParityPath: string | null = null;
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
    if (arg === '--mbo-parity') {
      mboParityPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return {
    out_path: outPath ?? DEFAULT_OUT_PATH,
    mbo_parity_path: mboParityPath,
  };
}

function readEvidence(path: string | null): MboPolicyEvidence {
  if (path === null) {
    return REVIEWED_POST04D_EVIDENCE;
  }
  return extractMboPolicyEvidenceFromReport(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      throw new Error(`Missing required MBO policy report field: ${path.join('.')}`);
    }
    current = current[segment];
  }
  return current;
}

function numberAt(value: unknown, path: readonly string[]): number {
  const candidate = valueAt(value, path);
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new Error(`Expected numeric MBO policy report field: ${path.join('.')}`);
  }
  return candidate;
}

function booleanAt(value: unknown, path: readonly string[]): boolean {
  const candidate = valueAt(value, path);
  if (typeof candidate !== 'boolean') {
    throw new Error(`Expected boolean MBO policy report field: ${path.join('.')}`);
  }
  return candidate;
}

function stringAt(value: unknown, path: readonly string[]): string {
  const candidate = valueAt(value, path);
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`Expected string MBO policy report field: ${path.join('.')}`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function main(): void {
  try {
    const args = parseArgs(processArgv.slice(2));
    const report = writeInfra01fDecisionReport(args.out_path, readEvidence(args.mbo_parity_path));
    processStdout.write(
      [
        'INFRA-01F decision report: partial_pass_mbo_provider_internal_subscope',
        `data01b_mbo_subscope_eligible=${report.data01b_mbo_subscope_eligible}`,
        `data01b_full_eligible=${report.data01b_full_eligible}`,
        `data01_full_eligible=${report.data01_full_eligible}`,
        `classification=${report.classification}`,
        `route_to=${report.route_to}`,
        'Full DATA-01 remains blocked pending implementation and provider-internal replay evidence.',
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
