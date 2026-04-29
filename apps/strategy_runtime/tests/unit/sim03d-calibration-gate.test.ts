import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const SCRIPT = 'scripts/sim/validate-fill-slippage-calibration.py';
const CHECKED_AT_TS_NS = '1777399200000000000';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03d-gate-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03D calibration report gate', () => {
  it('passes a SIM-03 report whose residuals satisfy plan thresholds', () => {
    const result = runGate(baseCalibrationReport());

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      calibration_gate_report_schema_version: 1,
      ticket_id: 'SIM-03D',
      status: 'pass',
      ready_for_rel01_execution_simulation: true,
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      source_report_schema_version: 1,
      source_report_status: 'pass',
      source_report_ready_for_rel01_execution_simulation: true,
      failure_reasons: [],
    });
    expect(result.report.source_report_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.report.gate_checks.every((check: any) => check.status === 'pass')).toBe(true);
    expect(result.report.residual_checks.marketable_slippage[0].status).toBe('pass');
    expect(result.report.residual_checks.limit_queue[0].status).toBe('pass');
    expect(result.report.residual_checks.strategy_level_cost[0].status).toBe('pass');
  });

  it('fails when a marketable residual breaches the p90 threshold even if top-level status says pass', () => {
    const source = baseCalibrationReport();
    source.residuals.marketable_slippage[0].p90_residual = 0.75;

    const result = runGate(source);

    expect(result.exitCode).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.ready_for_rel01_execution_simulation).toBe(false);
    expect(result.report.failure_reasons).toContain(
      'marketable_slippage:order_type=marketable|side=buy|spread_bucket=one_tick|session_phase=open|volatility_regime=normal:failed',
    );
    expect(
      result.report.residual_checks.marketable_slippage[0].checks.find((check: any) =>
        check.name.startsWith('p90_residual'),
      ),
    ).toMatchObject({ status: 'fail', value: 0.75, threshold: 0.125 });
  });

  it('fails when the source report is not ready for REL-01 simulation', () => {
    const source = baseCalibrationReport();
    source.status = 'fail';
    source.ready_for_rel01_execution_simulation = false;
    source.failure_reasons = ['limit_queue:front:failed thresholds'];

    const result = runGate(source);

    expect(result.exitCode).toBe(2);
    expect(result.report.failure_reasons).toEqual(
      expect.arrayContaining([
        'gate:source_status_pass',
        'gate:source_ready_for_rel01_execution_simulation',
        'gate:source_failure_reasons_empty',
      ]),
    );
  });

  it('returns exit code 1 for a missing caller-provided checked timestamp', () => {
    const directory = makeTempDir();
    const reportPath = join(directory, 'calibration.json');
    writeFileSync(reportPath, JSON.stringify(baseCalibrationReport()), 'utf8');

    const result = spawnSync(
      PYTHON,
      [SCRIPT, '--report', reportPath, '--out', join(directory, 'gate.json')],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checked-at-ts-ns');
  });
});

function runGate(sourceReport: Record<string, any>): {
  readonly exitCode: number | null;
  readonly report: Record<string, any>;
} {
  const directory = makeTempDir();
  mkdirSync(directory, { recursive: true });
  const reportPath = join(directory, 'fill_slippage_calibration.json');
  const gatePath = join(directory, 'fill_slippage_calibration_gate.json');
  writeFileSync(reportPath, JSON.stringify(sourceReport, null, 2), 'utf8');

  const result = spawnSync(
    PYTHON,
    [
      SCRIPT,
      '--report',
      reportPath,
      '--checked-at-ts-ns',
      CHECKED_AT_TS_NS,
      '--out',
      gatePath,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`gate failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return {
    exitCode: result.status,
    report: JSON.parse(readFileSync(gatePath, 'utf8')) as Record<string, any>,
  };
}

function baseCalibrationReport(): Record<string, any> {
  return {
    calibration_report_schema_version: 1,
    ticket_id: 'SIM-03',
    status: 'pass',
    ready_for_rel01_execution_simulation: true,
    simulated_execution_fitter_version: 'fitter_v1',
    calibrated_at_ts_ns: '1777395600000000000',
    inputs: {
      manifest_hash: sha('manifest'),
      verified_report_hash: sha('verified'),
      thresholds_config_hash: sha('thresholds'),
      verified_report_ready: true,
    },
    residuals: {
      marketable_slippage: [
        {
          bucket_id: 'order_type=marketable|side=buy|spread_bucket=one_tick|session_phase=open|volatility_regime=normal',
          status: 'pass',
          calibration_sample_count: 20,
          validation_sample_count: 20,
          ks_statistic: 0.05,
          ks_threshold: 0.15,
          p50_residual: 0.02,
          p50_threshold: 0.0625,
          p90_residual: 0.03,
          p90_threshold: 0.125,
          adverse_p95_residual: 0.04,
          adverse_p95_threshold: 0.125,
        },
      ],
      limit_queue: [
        {
          bucket_id: 'front',
          status: 'pass',
          calibration_sample_count: 20,
          validation_sample_count: 20,
          fill_probability_residual: 0.02,
          fill_probability_threshold: 0.1,
          time_to_fill_relative_error: 0.1,
          time_to_fill_relative_threshold: 0.25,
          no_fill_rate_residual: 0.02,
          no_fill_rate_threshold: 0.1,
        },
      ],
      strategy_level_cost: [
        {
          strategy_id: 'sim03_proxy_all',
          status: 'pass',
          calibration_sample_count: 20,
          validation_sample_count: 20,
          mean_residual: 0.01,
          threshold: 0.0625,
        },
      ],
    },
    insufficient_sample_buckets: [],
    failure_reasons: [],
  };
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
