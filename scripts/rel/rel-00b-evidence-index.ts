import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  stableJsonStringify,
  type JsonValue,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import {
  buildFeatureAvailabilityMask,
  type FeatureAvailabilityTier,
} from '../../apps/strategy_runtime/src/features/availability-mask.js';
import { sha256File } from '../sim/streaming-jsonl.js';

export const REL_00B_REPORT_SCHEMA_VERSION = 1 as const;
export const REL_00B_TICKET_ID = 'REL-00B' as const;

const DEFAULT_REPORTS_ROOT = 'reports';
const DEFAULT_OUT_JSON = 'reports/rel/rel00b_evidence_index.json';
const DEFAULT_OUT_MD = 'reports/rel/rel00b_evidence_index.md';
const MAX_HASH_BYTES = 64 * 1024 * 1024;

type EvidenceStatus = 'pass' | 'fail' | 'warning' | 'missing' | 'blocked' | 'pending' | 'accepted_subscope' | 'diagnostic_only';
type ReadinessStatus = 'ready_for_rel00_candidate' | 'blocked' | 'partial';

export interface Rel00bOptions {
  readonly cwd?: string;
  readonly reports_root?: string;
  readonly out_json?: string;
  readonly out_md?: string;
}

export interface Rel00bResult {
  readonly report: Rel00bReport;
  readonly json_path: string;
  readonly markdown_path: string;
  readonly exit_code: 0 | 2;
}

export interface Rel00bReport {
  readonly schema_version: typeof REL_00B_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof REL_00B_TICKET_ID;
  readonly status: ReadinessStatus;
  readonly next_recommended_action: string;
  readonly reports_root: string;
  readonly generated_output_paths: {
    readonly json: string;
    readonly markdown: string;
  };
  readonly code_substrate_status: Record<string, EvidenceArea>;
  readonly data_status: {
    readonly data01a_l1_trade: EvidenceArea;
    readonly data01b_ps_mbp10_price_state: EvidenceArea;
    readonly mbo: EvidenceArea & {
      readonly full_data01b_status: 'blocked';
      readonly provider_internal_status: 'accepted_subscope';
    };
    readonly size_order_count: EvidenceArea;
    readonly remaining_blocked_features: readonly string[];
  };
  readonly parity_evidence: Record<string, EvidenceArea>;
  readonly sim03_evidence: {
    readonly status: EvidenceStatus;
    readonly original_failure: {
      readonly status: string | null;
      readonly failure_reasons: readonly string[];
      readonly ready_for_rel01_execution_simulation: boolean | null;
    };
    readonly diagnosis: EvidenceArea & {
      readonly classification: string | null;
      readonly target_bucket: string | null;
    };
    readonly robust_refit: EvidenceArea & {
      readonly old_metric: number | null;
      readonly new_metric: number | null;
      readonly threshold: number | null;
      readonly tail_audit_status: string | null;
    };
    readonly sim03d_gate: EvidenceArea & {
      readonly ready_for_rel01_execution_simulation: boolean | null;
      readonly failure_reasons: readonly string[];
    };
    readonly ready_for_rel01_execution_simulation: boolean;
  };
  readonly offline_readiness: EvidenceArea & {
    readonly reasons: readonly string[];
    readonly next_blocker: string | null;
  };
  readonly remaining_gates: Record<string, EvidenceArea>;
  readonly artifact_index: readonly EvidenceArtifact[];
  readonly config_hashes: readonly EvidenceArtifact[];
  readonly warnings: readonly string[];
  readonly no_raw_data_statement: string;
}

export interface EvidenceArea {
  readonly status: EvidenceStatus;
  readonly summary: string;
  readonly evidence: readonly string[];
}

export interface EvidenceArtifact {
  readonly id: string;
  readonly path: string;
  readonly exists: boolean;
  readonly kind: 'report' | 'config' | 'doc';
  readonly size_bytes?: number;
  readonly sha256?: string;
  readonly hash_status: 'sha256' | 'missing' | 'skipped_large_file';
  readonly status?: string;
}

interface ArtifactSpec {
  readonly id: string;
  readonly path: string;
  readonly kind: EvidenceArtifact['kind'];
  readonly optional?: boolean;
}

interface IndexedArtifact {
  readonly artifact: EvidenceArtifact;
  readonly json: Record<string, unknown> | null;
}

const REPORT_ARTIFACTS: readonly ArtifactSpec[] = [
  { id: 'rel00a_offline_readiness', path: 'rel/rel00a_offline_readiness_report.json', kind: 'report' },
  { id: 'sim03_original_calibration', path: 'sim/fill_slippage_calibration.json', kind: 'report' },
  { id: 'sim03_front_diagnosis', path: 'sim/limit_queue_front_diagnosis.json', kind: 'report' },
  { id: 'sim03_front_distribution_analysis', path: 'sim/limit_queue_front_distribution_analysis.json', kind: 'report', optional: true },
  { id: 'sim03_front_observation_manifest', path: 'sim/limit_queue_front_observations_manifest.json', kind: 'report', optional: true },
  { id: 'sim03_front_robust_refit_patch', path: 'sim/limit_queue_front_robust_refit_report.json', kind: 'report' },
  { id: 'sim03_front_robust_refit_report', path: 'sim/fill_slippage_calibration_robust_limit_queue_front.json', kind: 'report' },
  { id: 'sim03_front_robust_refit_gate', path: 'sim/fill_slippage_calibration_robust_limit_queue_front_gate.json', kind: 'report' },
  { id: 'infra01b_exchange_time', path: 'infra/infra01b_canonical_exchange_time_report.json', kind: 'report', optional: true },
  { id: 'infra01c_timestamp_order', path: 'infra/infra01c_timestamp_order_report.json', kind: 'report', optional: true },
  { id: 'infra01f_mbo_policy', path: 'infra/infra01f_mbo_policy_decision_post04d_summary.json', kind: 'report', optional: true },
  { id: 'databento_overlap_parity', path: 'infra/databento_overlap_parity_report_post04d.json', kind: 'report', optional: true },
  { id: 'databento_bbo_triangulation', path: 'infra/databento_bbo_triangulation_report_post04d.json', kind: 'report', optional: true },
  { id: 'rithmic_mbp10_audit', path: 'infra/rithmic_mbp10_extraction_audit_after_04d.json', kind: 'report', optional: true },
  { id: 'mbp10_l1_checkpoint_audit', path: 'infra/mbp10_l1_checkpoint_audit_post04d_full.json', kind: 'report', optional: true },
];

const REPO_ARTIFACTS: readonly ArtifactSpec[] = [
  { id: 'package_json', path: 'package.json', kind: 'config' },
  { id: 'app_example_config', path: 'config/app.example.json', kind: 'config' },
  { id: 'mnq_session_calendar', path: 'config/session/mnq-session-calendar.yaml', kind: 'config' },
  { id: 'mnq_roll_calendar', path: 'config/session/mnq-roll-calendar.yaml', kind: 'config' },
  { id: 'adr_0002_cross_source_parity', path: 'docs/adr/ADR-0002-cross-source-market-data-parity.md', kind: 'doc' },
  { id: 'rel00a_doc', path: 'docs/release/REL-00A.md', kind: 'doc' },
];

export function runRel00bEvidenceIndex(options: Rel00bOptions = {}): Rel00bResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const reportsRoot = resolve(cwd, options.reports_root ?? DEFAULT_REPORTS_ROOT);
  const outJson = resolve(cwd, options.out_json ?? DEFAULT_OUT_JSON);
  const outMd = resolve(cwd, options.out_md ?? DEFAULT_OUT_MD);
  const warnings: string[] = [];

  const reportArtifacts = REPORT_ARTIFACTS.map((spec) => indexReportArtifact(cwd, reportsRoot, spec, warnings));
  const repoArtifacts = REPO_ARTIFACTS.map((spec) => indexRepoArtifact(cwd, spec, warnings));
  const byId = new Map(reportArtifacts.map((item) => [item.artifact.id, item] as const));

  const rel00a = byId.get('rel00a_offline_readiness')?.json;
  const simOriginal = byId.get('sim03_original_calibration')?.json;
  const simDiagnosis = byId.get('sim03_front_diagnosis')?.json;
  const simPatch = byId.get('sim03_front_robust_refit_patch')?.json;
  const simGate = byId.get('sim03_front_robust_refit_gate')?.json;
  const featureMask = buildFeatureAvailabilityMask();

  const sim03Ready = booleanValue(simGate?.ready_for_rel01_execution_simulation) === true &&
    stringArray(simGate?.failure_reasons).length === 0;
  const rel00aPass = stringValue(rel00a?.status) === 'pass';
  const anyHardFail = [
    stringValue(rel00a?.status) === 'fail',
    simGate !== null && simGate !== undefined && !sim03Ready,
  ].some(Boolean);
  const hasMissingCore = [
    byId.get('rel00a_offline_readiness')?.artifact.exists !== true,
    byId.get('sim03_front_robust_refit_gate')?.artifact.exists !== true,
    byId.get('sim03_front_robust_refit_patch')?.artifact.exists !== true,
  ].some(Boolean);
  const status: ReadinessStatus = anyHardFail
    ? 'blocked'
    : sim03Ready && rel00aPass
      ? 'ready_for_rel00_candidate'
      : hasMissingCore
        ? 'partial'
        : 'partial';

  const report: Rel00bReport = {
    schema_version: REL_00B_REPORT_SCHEMA_VERSION,
    ticket_id: REL_00B_TICKET_ID,
    status,
    next_recommended_action: nextAction(status),
    reports_root: toReportPath(cwd, reportsRoot),
    generated_output_paths: {
      json: toReportPath(cwd, outJson),
      markdown: toReportPath(cwd, outMd),
    },
    code_substrate_status: codeSubstrateStatus(rel00a, sim03Ready),
    data_status: dataStatus(featureMask),
    parity_evidence: parityEvidence(byId),
    sim03_evidence: sim03Evidence(simOriginal, simDiagnosis, simPatch, simGate),
    offline_readiness: offlineReadiness(rel00a, byId.get('rel00a_offline_readiness')?.artifact),
    remaining_gates: remainingGates(featureMask, sim03Ready),
    artifact_index: reportArtifacts.map((item) => item.artifact),
    config_hashes: repoArtifacts.map((item) => item.artifact),
    warnings,
    no_raw_data_statement: 'REL-00B indexes report paths, hashes, statuses, and small scalar summaries only. It does not embed raw probe rows, DBN files, decoded JSONL observations, or journal payload lines.',
  };

  mkdirSync(dirname(outJson), { recursive: true });
  mkdirSync(dirname(outMd), { recursive: true });
  writeFileSync(outJson, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
  writeFileSync(outMd, markdownReport(report), 'utf8');
  return {
    report,
    json_path: outJson,
    markdown_path: outMd,
    exit_code: status === 'ready_for_rel00_candidate' ? 0 : 2,
  };
}

function indexReportArtifact(cwd: string, reportsRoot: string, spec: ArtifactSpec, warnings: string[]): IndexedArtifact {
  return indexArtifact(cwd, resolve(reportsRoot, spec.path), spec, warnings);
}

function indexRepoArtifact(cwd: string, spec: ArtifactSpec, warnings: string[]): IndexedArtifact {
  return indexArtifact(cwd, resolve(cwd, spec.path), spec, warnings);
}

function indexArtifact(cwd: string, filePath: string, spec: ArtifactSpec, warnings: string[]): IndexedArtifact {
  if (!existsSync(filePath)) {
    if (spec.optional !== true) {
      warnings.push(`missing evidence artifact: ${spec.path}`);
    }
    return {
      artifact: {
        id: spec.id,
        path: toReportPath(cwd, filePath),
        exists: false,
        kind: spec.kind,
        hash_status: 'missing',
      },
      json: null,
    };
  }
  const stat = statSync(filePath);
  const hashStatus = stat.size > MAX_HASH_BYTES ? 'skipped_large_file' : 'sha256';
  const artifact: EvidenceArtifact = {
    id: spec.id,
    path: toReportPath(cwd, filePath),
    exists: true,
    kind: spec.kind,
    size_bytes: stat.size,
    hash_status: hashStatus,
    ...(hashStatus === 'sha256' ? { sha256: sha256File(filePath) } : {}),
  };
  if (hashStatus === 'skipped_large_file') {
    warnings.push(`skipped hashing large artifact ${spec.path} (${stat.size} bytes)`);
  }
  const json = filePath.endsWith('.json') && stat.size <= MAX_HASH_BYTES
    ? tryReadJson(filePath, warnings)
    : null;
  const status = json === null ? null : stringValue(json.status) ?? stringValue(json.ticket_id);
  return {
    artifact: {
      ...artifact,
      ...(status === null ? {} : { status }),
    },
    json,
  };
}

function codeSubstrateStatus(rel00a: Record<string, unknown> | null | undefined, sim03Ready: boolean): Record<string, EvidenceArea> {
  return {
    contracts_config: area(groupStatus(rel00a, 'config_checks'), 'Config/contracts load through REL-00A.', ['rel00a_offline_readiness']),
    strategies: area(groupStatus(rel00a, 'fixture_checks'), 'Strategy fixture path is covered by REL-00A offline runtime.', ['rel00a_offline_readiness']),
    risk: area(groupStatus(rel00a, 'config_checks'), 'Risk config loads through REL-00A.', ['rel00a_offline_readiness']),
    sim_execution: area(sim03Ready ? 'pass' : 'missing', sim03Ready ? 'SIM-03D passes the robust front-bucket calibration report.' : 'SIM-03D pass evidence is not available.', ['sim03_front_robust_refit_gate']),
    management: area(groupStatus(rel00a, 'traceability_checks'), 'Management lifecycle traceability is covered by REL-00A.', ['rel00a_offline_readiness']),
    orchestration: area(combineGroupStatuses(rel00a, ['evt_invariant_checks', 'determinism_checks']), 'Offline orchestration invariants and determinism are covered by REL-00A.', ['rel00a_offline_readiness']),
    observability_operator_tooling: area(groupStatus(rel00a, 'traceability_checks'), 'TUI-04 provenance/journal-query support is covered by REL-00A traceability checks.', ['rel00a_offline_readiness']),
  };
}

function dataStatus(featureMask: ReturnType<typeof buildFeatureAvailabilityMask>): Rel00bReport['data_status'] {
  const blockedFeatures = Object.entries(featureMask.field_tiers)
    .filter((entry): entry is [string, FeatureAvailabilityTier] => entry[1] === 'blocked')
    .map(([field]) => field)
    .sort();
  return {
    data01a_l1_trade: area('accepted_subscope', 'L1 quote and last-trade fields are authoritative under the current feature availability mask.', ['feature_availability_mask']),
    data01b_ps_mbp10_price_state: area('accepted_subscope', 'MBP10 price-state fields are accepted as the price-state sub-scope; size/order-count remain diagnostic.', ['feature_availability_mask', 'adr_0002_cross_source_parity']),
    mbo: {
      ...area('accepted_subscope', 'MBO lifecycle/book-state work is provider-internal accepted sub-scope; full DATA-01B remains blocked.', ['feature_availability_mask', 'adr_0002_cross_source_parity']),
      full_data01b_status: featureMask.lineage.data01b_full_status,
      provider_internal_status: 'accepted_subscope',
    },
    size_order_count: area('diagnostic_only', 'MBP10 size and order-count fields remain diagnostic-only and cannot be hard launch gates.', ['feature_availability_mask']),
    remaining_blocked_features: blockedFeatures,
  };
}

function parityEvidence(byId: Map<string, IndexedArtifact>): Record<string, EvidenceArea> {
  return {
    rithmic_mbp10_internal_audit: evidenceFromArtifacts(byId, ['rithmic_mbp10_audit', 'mbp10_l1_checkpoint_audit'], 'Rithmic MBP10 extraction/checkpoint audit evidence is indexed.'),
    databento_internal_triangulation: evidenceFromArtifacts(byId, ['databento_overlap_parity', 'databento_bbo_triangulation'], 'Databento overlap and BBO triangulation evidence is indexed.'),
    cross_source_parity_policy: area('pass', 'ADR-0002 remains the policy boundary for cross-source parity and accepted sub-scopes.', ['adr_0002_cross_source_parity']),
    mbo_taxonomy_status: evidenceFromArtifacts(byId, ['infra01f_mbo_policy'], 'MBO provider-internal taxonomy policy evidence is indexed.'),
  };
}

function sim03Evidence(
  original: Record<string, unknown> | null | undefined,
  diagnosis: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | null | undefined,
  gate: Record<string, unknown> | null | undefined,
): Rel00bReport['sim03_evidence'] {
  const ready = booleanValue(gate?.ready_for_rel01_execution_simulation) === true &&
    stringArray(gate?.failure_reasons).length === 0;
  return {
    status: ready ? 'pass' : gate === null || gate === undefined ? 'missing' : 'fail',
    original_failure: {
      status: stringValue(original?.status),
      failure_reasons: stringArray(original?.failure_reasons),
      ready_for_rel01_execution_simulation: booleanValue(original?.ready_for_rel01_execution_simulation),
    },
    diagnosis: {
      ...area(diagnosis === null || diagnosis === undefined ? 'missing' : 'pass', 'SIM-03F diagnosis identifies the front-bucket failure lineage.', ['sim03_front_diagnosis']),
      classification: stringValue(diagnosis?.classification) ?? stringValue(diagnosis?.likely_failure_class),
      target_bucket: targetBucketFromDiagnosis(diagnosis),
    },
    robust_refit: {
      ...area(stringValue(patch?.status) === 'robust_refit_passed' ? 'pass' : patch === null || patch === undefined ? 'missing' : 'fail', 'SIM-03L robust front-bucket refit evidence is indexed.', ['sim03_front_robust_refit_patch']),
      old_metric: numberValue(patch?.old_metric_value),
      new_metric: numberValue(patch?.new_metric_value),
      threshold: numberValue(patch?.threshold),
      tail_audit_status: stringValue(jsonObject(patch?.tail_audit)?.status),
    },
    sim03d_gate: {
      ...area(ready ? 'pass' : gate === null || gate === undefined ? 'missing' : 'fail', 'SIM-03D validates the robust SIM-03 report.', ['sim03_front_robust_refit_gate']),
      ready_for_rel01_execution_simulation: booleanValue(gate?.ready_for_rel01_execution_simulation),
      failure_reasons: stringArray(gate?.failure_reasons),
    },
    ready_for_rel01_execution_simulation: ready,
  };
}

function offlineReadiness(
  rel00a: Record<string, unknown> | null | undefined,
  artifact: EvidenceArtifact | undefined,
): Rel00bReport['offline_readiness'] {
  const status = stringValue(rel00a?.status);
  return {
    status: status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : artifact?.exists === false ? 'missing' : 'missing',
    summary: status === 'pass' ? 'REL-00A offline readiness passed.' : 'REL-00A offline readiness is missing or not passing.',
    evidence: ['rel00a_offline_readiness'],
    reasons: stringArray(rel00a?.reasons),
    next_blocker: stringValue(rel00a?.next_blocker),
  };
}

function remainingGates(
  featureMask: ReturnType<typeof buildFeatureAvailabilityMask>,
  sim03Ready: boolean,
): Record<string, EvidenceArea> {
  return {
    rel00: area('pending', 'REL-00 release packet/run decision is not complete; REL-00B only indexes evidence.', ['rel00b_evidence_index']),
    rel01_10_session_run: area('pending', sim03Ready ? 'SIM-03 calibration no longer blocks REL-01, but the 10-session controlled run still has to execute.' : 'REL-01 remains blocked until SIM-03D passes.', ['sim03_front_robust_refit_gate']),
    replay_determinism_on_accepted_data_surface: area('pending', 'Replay determinism must still be demonstrated on the accepted production data surface.', ['rel00a_offline_readiness']),
    final_traceability_spot_checks: area('pending', 'Final launch packet still needs operator traceability spot-checks.', ['rel00a_offline_readiness']),
    full_data01b_mbo_restrictions: area('blocked', `Full DATA-01B remains ${featureMask.lineage.data01b_full_status}; provider-internal MBO sub-scope is not full cross-feed DATA-01B.`, ['feature_availability_mask', 'adr_0002_cross_source_parity']),
  };
}

function evidenceFromArtifacts(
  byId: Map<string, IndexedArtifact>,
  ids: readonly string[],
  summary: string,
): EvidenceArea {
  const artifacts = ids.map((id) => byId.get(id)?.artifact).filter((item): item is EvidenceArtifact => item !== undefined);
  if (artifacts.length === 0 || artifacts.every((artifact) => !artifact.exists)) {
    return area('missing', `${summary} Missing artifact(s): ${ids.join(', ')}.`, ids);
  }
  if (artifacts.some((artifact) => !artifact.exists)) {
    return area('warning', `${summary} Some optional artifacts are missing.`, ids);
  }
  return area('pass', summary, ids);
}

function groupStatus(report: Record<string, unknown> | null | undefined, groupName: string): EvidenceStatus {
  const group = jsonObject(report?.[groupName]);
  const status = stringValue(group?.status);
  if (status === 'pass') return 'pass';
  if (status === 'fail') return 'fail';
  return 'missing';
}

function combineGroupStatuses(report: Record<string, unknown> | null | undefined, groupNames: readonly string[]): EvidenceStatus {
  const statuses = groupNames.map((name) => groupStatus(report, name));
  if (statuses.some((status) => status === 'fail')) return 'fail';
  if (statuses.every((status) => status === 'pass')) return 'pass';
  return 'missing';
}

function area(status: EvidenceStatus, summary: string, evidence: readonly string[]): EvidenceArea {
  return { status, summary, evidence: [...evidence].sort() };
}

function nextAction(status: ReadinessStatus): string {
  switch (status) {
    case 'ready_for_rel00_candidate':
      return 'Run REL-00 packet review, then plan the first controlled REL-01 execution-simulation session.';
    case 'blocked':
      return 'Resolve failed evidence before starting REL-00 or REL-01.';
    case 'partial':
      return 'Generate missing optional/required evidence reports, then rerun REL-00B.';
  }
}

function targetBucketFromDiagnosis(diagnosis: Record<string, unknown> | null | undefined): string | null {
  const target = jsonObject(diagnosis?.target);
  const group = stringValue(target?.group);
  const bucket = stringValue(target?.bucket);
  if (group !== null && bucket !== null) return `${group}:${bucket}`;
  return stringValue(diagnosis?.target_bucket) ?? stringValue(diagnosis?.bucket);
}

function markdownReport(report: Rel00bReport): string {
  const lines = [
    '# REL-00B Evidence Index',
    '',
    `Status: ${report.status}`,
    `Next action: ${report.next_recommended_action}`,
    '',
    '## SIM-03',
    '',
    `- SIM-03D ready: ${report.sim03_evidence.ready_for_rel01_execution_simulation}`,
    `- Robust refit metric: ${report.sim03_evidence.robust_refit.new_metric ?? 'missing'} / threshold ${report.sim03_evidence.robust_refit.threshold ?? 'missing'}`,
    `- Tail audit: ${report.sim03_evidence.robust_refit.tail_audit_status ?? 'missing'}`,
    '',
    '## Offline Readiness',
    '',
    `- REL-00A: ${report.offline_readiness.status}`,
    `- Reasons: ${report.offline_readiness.reasons.length === 0 ? 'none' : report.offline_readiness.reasons.join('; ')}`,
    '',
    '## Remaining Gates',
    '',
    ...Object.entries(report.remaining_gates).map(([name, value]) => `- ${name}: ${value.status} - ${value.summary}`),
    '',
    '## Data Boundary',
    '',
    `- DATA-01B full status: ${report.data_status.mbo.full_data01b_status}`,
    `- Provider-internal MBO status: ${report.data_status.mbo.provider_internal_status}`,
    `- Blocked feature count: ${report.data_status.remaining_blocked_features.length}`,
    '',
    '## Warnings',
    '',
    ...(report.warnings.length === 0 ? ['- none'] : report.warnings.map((warning) => `- ${warning}`)),
    '',
    '## Raw Data',
    '',
    report.no_raw_data_statement,
    '',
  ];
  return `${lines.join('\n')}`;
}

function tryReadJson(path: string, warnings: string[]): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return jsonObject(value);
  } catch (error) {
    warnings.push(`could not parse JSON artifact ${path}: ${errorMessage(error)}`);
    return null;
  }
}

function writeSummary(result: Rel00bResult): string {
  return [
    `REL-00B evidence index: ${result.report.status}`,
    `json=${result.report.generated_output_paths.json}`,
    `markdown=${result.report.generated_output_paths.markdown}`,
    `next_recommended_action=${result.report.next_recommended_action}`,
    '',
  ].join('\n');
}

function parseArgs(args: readonly string[]): Rel00bOptions {
  const options: {
    reports_root?: string;
    out_json?: string;
    out_md?: string;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case '--reports-root':
        index += 1;
        options.reports_root = requireArgValue(flag, args[index]);
        break;
      case '--out-json':
        index += 1;
        options.out_json = requireArgValue(flag, args[index]);
        break;
      case '--out-md':
        index += 1;
        options.out_md = requireArgValue(flag, args[index]);
        break;
      case '--help':
        processStdout.write(usage());
        processExit(0);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return options;
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage(): string {
  return [
    'Usage: npm run rel:00b:evidence-index -- [--reports-root path] [--out-json path] [--out-md path]',
    '',
    'Builds the REL-00B release evidence index without embedding raw data.',
    '',
  ].join('\n');
}

function parseablePath(path: string): string {
  return path.split(sep).join('/');
}

function toReportPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    return parseablePath(rel === '' ? '.' : rel);
  }
  return parseablePath(path);
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  try {
    const result = runRel00bEvidenceIndex(parseArgs(processArgv.slice(2)));
    processStdout.write(writeSummary(result));
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`REL-00B invalid input/config/environment: ${errorMessage(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
