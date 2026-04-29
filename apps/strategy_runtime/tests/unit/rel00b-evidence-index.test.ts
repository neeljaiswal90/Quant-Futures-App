import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runRel00bEvidenceIndex,
  type Rel00bReport,
} from '../../../../scripts/rel/rel-00b-evidence-index.js';

const TEMP_ROOTS: string[] = [];

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('REL-00B evidence index', () => {
  it('recognizes SIM-03L/SIM-03D pass evidence and emits a REL-00 candidate packet', () => {
    const root = makeFixtureRoot({ includeEvidence: true });

    const result = runIndex(root);

    expect(result.exit_code).toBe(0);
    expect(result.report.status).toBe('ready_for_rel00_candidate');
    expect(result.report.sim03_evidence.ready_for_rel01_execution_simulation).toBe(true);
    expect(result.report.sim03_evidence.robust_refit).toMatchObject({
      status: 'pass',
      old_metric: 0.465225,
      new_metric: 0.058884,
      threshold: 0.25,
      tail_audit_status: 'pass',
    });
    expect(result.report.remaining_gates.rel01_10_session_run.status).toBe('pending');
  });

  it('warns instead of crashing when optional reports are missing', () => {
    const root = makeFixtureRoot({ includeEvidence: false });

    const result = runIndex(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('partial');
    expect(result.report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('rel00a_offline_readiness_report.json'),
        expect.stringContaining('fill_slippage_calibration_robust_limit_queue_front_gate.json'),
      ]),
    );
  });

  it('keeps full DATA-01B/MBO restrictions blocked even when SIM-03 passes', () => {
    const root = makeFixtureRoot({ includeEvidence: true });

    const result = runIndex(root);

    expect(result.report.data_status.mbo.full_data01b_status).toBe('blocked');
    expect(result.report.data_status.mbo.provider_internal_status).toBe('accepted_subscope');
    expect(result.report.remaining_gates.full_data01b_mbo_restrictions.status).toBe('blocked');
    expect(result.report.data_status.remaining_blocked_features).toEqual(
      expect.arrayContaining(['queue_position', 'mbo_derived_features']),
    );
  });

  it('writes stable JSON and markdown output without embedding raw data', () => {
    const root = makeFixtureRoot({ includeEvidence: true });
    const rawPath = join(root, 'reports', 'rel', 'rel00a', 'raw-runtime.jsonl');
    mkdirSync(join(root, 'reports', 'rel', 'rel00a'), { recursive: true });
    writeFileSync(rawPath, '{"raw_secret":"RAW_SHOULD_NOT_APPEAR"}\n', 'utf8');

    const first = runIndex(root);
    const firstJson = readFileSync(first.json_path, 'utf8');
    const firstMd = readFileSync(first.markdown_path, 'utf8');
    const second = runIndex(root);

    expect(readFileSync(second.json_path, 'utf8')).toBe(firstJson);
    expect(readFileSync(second.markdown_path, 'utf8')).toBe(firstMd);
    expect(firstJson).not.toContain('RAW_SHOULD_NOT_APPEAR');
    expect(firstMd).not.toContain('RAW_SHOULD_NOT_APPEAR');
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string>>;

    expect(packageJson.scripts['rel:00b:evidence-index']).toBe(
      'tsx scripts/rel/rel-00b-evidence-index.ts',
    );
  });
});

function runIndex(root: string): ReturnType<typeof runRel00bEvidenceIndex> {
  return runRel00bEvidenceIndex({
    cwd: root,
    reports_root: 'reports',
    out_json: 'reports/rel/rel00b_evidence_index.json',
    out_md: 'reports/rel/rel00b_evidence_index.md',
  });
}

function makeFixtureRoot(input: { readonly includeEvidence: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'qfa-rel00b-'));
  TEMP_ROOTS.push(root);
  if (!input.includeEvidence) {
    return root;
  }
  writeJson(root, 'reports/rel/rel00a_offline_readiness_report.json', {
    schema_version: 1,
    status: 'pass',
    reasons: [],
    next_blocker: 'REL-00 candidate review',
    config_checks: { status: 'pass', checks: [] },
    fixture_checks: { status: 'pass', checks: [] },
    traceability_checks: { status: 'pass', checks: [] },
    evt_invariant_checks: { status: 'pass', checks: [] },
    determinism_checks: { status: 'pass', checks: [] },
  });
  writeJson(root, 'reports/sim/fill_slippage_calibration.json', {
    status: 'fail',
    ready_for_rel01_execution_simulation: false,
    failure_reasons: ['limit_queue:front failed thresholds'],
  });
  writeJson(root, 'reports/sim/limit_queue_front_diagnosis.json', {
    ticket_id: 'SIM-03F',
    classification: 'model_underfit_specific_bucket',
    target: { group: 'limit_queue', bucket: 'front' },
  });
  writeJson(root, 'reports/sim/limit_queue_front_robust_refit_report.json', {
    ticket_id: 'SIM-03L',
    status: 'robust_refit_passed',
    old_metric_value: 0.465225,
    new_metric_value: 0.058884,
    threshold: 0.25,
    tail_audit: { status: 'pass' },
    sim03d_gate: {
      status: 'pass',
      ready_for_rel01_execution_simulation: true,
      failure_reasons: [],
    },
  });
  writeJson(root, 'reports/sim/fill_slippage_calibration_robust_limit_queue_front.json', {
    status: 'pass',
    ready_for_rel01_execution_simulation: true,
    failure_reasons: [],
  });
  writeJson(root, 'reports/sim/fill_slippage_calibration_robust_limit_queue_front_gate.json', {
    calibration_gate_report_schema_version: 1,
    ready_for_rel01_execution_simulation: true,
    failure_reasons: [],
  });
  writeJson(root, 'reports/infra/infra01f_mbo_policy_decision_post04d_summary.json', {
    status: 'pass',
  });
  writeJson(root, 'reports/infra/databento_overlap_parity_report_post04d.json', {
    status: 'pass',
  });
  writeJson(root, 'reports/infra/databento_bbo_triangulation_report_post04d.json', {
    status: 'pass',
  });
  writeJson(root, 'reports/infra/rithmic_mbp10_extraction_audit_after_04d.json', {
    status: 'pass',
  });
  writeJson(root, 'reports/infra/mbp10_l1_checkpoint_audit_post04d_full.json', {
    status: 'pass',
  });
  writeText(root, 'package.json', '{"name":"fixture"}\n');
  writeText(root, 'config/app.example.json', '{}\n');
  writeText(root, 'config/session/mnq-session-calendar.yaml', 'sessions: []\n');
  writeText(root, 'config/session/mnq-roll-calendar.yaml', 'rolls: []\n');
  writeText(root, 'docs/adr/ADR-0002-cross-source-market-data-parity.md', '# ADR fixture\n');
  writeText(root, 'docs/release/REL-00A.md', '# REL-00A fixture\n');
  return root;
}

function writeJson(root: string, path: string, value: unknown): void {
  writeText(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(root: string, path: string, value: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value, 'utf8');
}
