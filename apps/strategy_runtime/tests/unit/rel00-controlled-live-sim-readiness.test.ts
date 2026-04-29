import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runRel00ControlledLiveSimReadiness,
} from '../../../../scripts/rel/rel-00-controlled-live-sim-readiness.js';

const TEMP_ROOTS: string[] = [];
const FIXTURE_JOURNAL = 'apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl';

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('REL-00 controlled live-sim readiness', () => {
  it('passes for a controlled live-sim journal with simulated execution only', async () => {
    const root = makeFixtureRoot({ mode: 'pass' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(0);
    expect(result.report.status).toBe('pass');
    expect(result.report.safety_mode).toMatchObject({
      live_data_source: 'rithmic',
      execution_mode: 'simulated_only',
      real_orders_allowed: false,
      mbo_derived_features_allowed: false,
    });
    expect(result.report.transport_checks.status).toBe('pass');
    expect(result.report.market_data_checks.status).toBe('pass');
    expect(result.report.execution_safety_checks.status).toBe('pass');
    expect(result.report.feature_surface_checks.status).toBe('pass');
    expect(result.report.traceability_checks.status).toBe('pass');
    expect(result.report.next_blocker).toBe('REL-01 10-session controlled live-sim validation');
  });

  it('fails closed when a real-order event type appears in the raw journal', async () => {
    const root = makeFixtureRoot({ mode: 'real_order' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.raw_scan_summary.real_order_event_type_counts).toMatchObject({
      ORDER_PLANT: 1,
    });
    expect(result.report.execution_safety_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'no_real_order_event_types_in_raw_journal',
          status: 'fail',
        }),
      ]),
    );
  });

  it('fails when blocked or MBO-derived feature fields are used as runtime features', async () => {
    const root = makeFixtureRoot({ mode: 'blocked_feature' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.feature_surface_summary.blocked_fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'queue_position',
          canonical_field: 'queue_position',
          tier: 'blocked',
        }),
      ]),
    );
    expect(result.report.feature_surface_checks.status).toBe('fail');
  });

  it('writes deterministic reports without embedding raw journal payload values', async () => {
    const root = makeFixtureRoot({ mode: 'raw_sentinel' });

    const first = await runRel00(root);
    const firstJson = readFileSync(first.json_path, 'utf8');
    const firstMd = readFileSync(first.markdown_path, 'utf8');
    const second = await runRel00(root);

    expect(readFileSync(second.json_path, 'utf8')).toBe(firstJson);
    expect(readFileSync(second.markdown_path, 'utf8')).toBe(firstMd);
    expect(firstJson).not.toContain('RAW_SHOULD_NOT_APPEAR');
    expect(firstMd).not.toContain('RAW_SHOULD_NOT_APPEAR');
    expect(first.report.input.journal_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string>>;

    expect(packageJson.scripts['rel:00:controlled-live-sim']).toBe(
      'tsx scripts/rel/rel-00-controlled-live-sim-readiness.ts',
    );
  });
});

async function runRel00(root: string): Promise<ReturnType<typeof runRel00ControlledLiveSimReadiness> extends Promise<infer TResult> ? TResult : never> {
  return runRel00ControlledLiveSimReadiness({
    cwd: root,
    journal: 'journals/live-sim.jsonl',
    out_json: 'reports/rel/rel00_controlled_live_sim_readiness_report.json',
    out_md: 'reports/rel/rel00_controlled_live_sim_readiness_report.md',
    validation_dir: 'reports/rel/rel00-controlled-live-sim-transport',
  });
}

function makeFixtureRoot(input: { readonly mode: 'pass' | 'real_order' | 'blocked_feature' | 'raw_sentinel' }): string {
  const root = mkdtempSync(join(tmpdir(), 'qfa-rel00-'));
  TEMP_ROOTS.push(root);
  const journal = buildJournal(input.mode);
  writeText(root, 'journals/live-sim.jsonl', journal);
  return root;
}

function buildJournal(mode: 'pass' | 'real_order' | 'blocked_feature' | 'raw_sentinel'): string {
  const source = readFileSync(FIXTURE_JOURNAL, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '');
  const lines = source.map((line) => {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === 'MICROSTRUCTURE') {
      const payload = jsonObject(event.payload);
      event.payload = {
        ...payload,
        values: {
          mid_px: 18500.5,
          spread_ticks: 1,
        },
      };
    }
    if (mode === 'blocked_feature' && event.type === 'FEATURES') {
      const payload = jsonObject(event.payload);
      event.payload = {
        ...payload,
        values: {
          ...jsonObject(payload.values),
          queue_position: 1,
        },
      };
    }
    if (mode === 'raw_sentinel' && event.type === 'FEATURES') {
      const payload = jsonObject(event.payload);
      event.payload = {
        ...payload,
        values: {
          ...jsonObject(payload.values),
          raw_probe_value: 'RAW_SHOULD_NOT_APPEAR',
        },
      };
    }
    return `${JSON.stringify(event)}\n`;
  });
  if (mode === 'real_order') {
    lines.push(`${JSON.stringify({
      event_id: 'real-order-1',
      run_id: 'run_obs00_fixture_v1',
      schema_version: 1,
      session_id: '2026-04-23-rth',
      ts_ns: '1700000000060000000',
      type: 'ORDER_PLANT',
      payload: {
        raw_order_id: 'RAW_SHOULD_NOT_APPEAR',
      },
    })}\n`);
  }
  return lines.join('');
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function writeText(root: string, path: string, value: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value, 'utf8');
}
