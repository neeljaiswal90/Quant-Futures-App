import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const ENV_SCRIPT = 'scripts/ml/gpu_environment_check.py';
const BENCHMARK_SCRIPT = 'scripts/ml/train_synthetic_gpu_benchmark.py';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-ml-gpu00-'));
  tempDirectories.push(directory);
  return directory;
}

describe('ML-GPU-00 GPU environment tooling', () => {
  it('writes an import-safe environment report without requiring GPU packages', () => {
    const directory = makeTempDir();
    const outPath = join(directory, 'gpu-environment.json');
    const result = spawnSync(
      PYTHON,
      [ENV_SCRIPT, '--skip-benchmarks', '--out', outPath],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const report = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, any>;

    expect(result.status).toBe(0);
    expect(report).toMatchObject({
      gpu_environment_report_schema_version: 1,
      ticket_id: 'ML-GPU-00',
      status: 'completed',
    });
    expect(report.python.version).toEqual(expect.any(String));
    expect(report.torch.installed).toEqual(expect.any(Boolean));
    expect(report.torch.cuda_available).toEqual(expect.any(Boolean));
    expect(report.xgboost.installed).toEqual(expect.any(Boolean));
    expect(report.scope_note).toContain('does not change live runtime');
  });

  it('supports a synthetic benchmark dry run without importing ML frameworks', () => {
    const directory = makeTempDir();
    const outPath = join(directory, 'synthetic-benchmark.json');
    const result = spawnSync(
      PYTHON,
      [BENCHMARK_SCRIPT, '--dry-run', '--out', outPath],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const report = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, any>;

    expect(result.status).toBe(0);
    expect(report).toMatchObject({
      synthetic_gpu_benchmark_report_schema_version: 1,
      ticket_id: 'ML-GPU-00',
      status: 'dry_run',
      framework: 'auto',
      samples: 2048,
      features: 32,
      epochs: 20,
    });
    expect(report.frameworks).toEqual({});
    expect(report.scope_note).toContain('does not add model inference to ORCH');
  });

  it('exposes package scripts for manual GPU checks', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, any>;

    expect(packageJson.scripts['ml:gpu:check']).toBe('python scripts/ml/gpu_environment_check.py');
    expect(packageJson.scripts['ml:gpu:synthetic-benchmark']).toBe(
      'python scripts/ml/train_synthetic_gpu_benchmark.py',
    );
  });
});
