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

  it('fails when an execution reject uses a non-simulated adapter', async () => {
    const root = makeFixtureRoot({ mode: 'live_exec_reject' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.raw_scan_summary.unsafe_execution_adapter_count).toBe(1);
    expect(result.report.execution_safety_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'raw_exec_rejects_are_simulated_adapter_only',
          status: 'fail',
        }),
      ]),
    );
  });

  it('fails when a simulated fill uses a blocked input tier', async () => {
    const root = makeFixtureRoot({ mode: 'blocked_fill_tier' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.raw_scan_summary.blocked_sim_fill_input_tier_count).toBe(1);
    expect(result.report.execution_safety_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'sim_fills_do_not_use_blocked_input_tier',
          status: 'fail',
        }),
      ]),
    );
  });

  it('fails traceability when an order intent has no simulated terminal event', async () => {
    const root = makeFixtureRoot({ mode: 'unterminated_order' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.traceability_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'order_intents_have_simulated_terminal_event_or_no_orders_present',
          status: 'fail',
        }),
      ]),
    );
  });

  it('fails traceability when a simulated terminal event references an unknown order intent', async () => {
    const root = makeFixtureRoot({ mode: 'unknown_terminal_ref' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.traceability_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'simulated_terminal_events_reference_known_order_intents',
          status: 'fail',
        }),
      ]),
    );
  });

  it('fails when a diagnostic-only feature field is used as a runtime feature', async () => {
    const root = makeFixtureRoot({ mode: 'restricted_feature' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.feature_surface_summary.restricted_fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'mbp10_size_diagnostic',
          canonical_field: 'mbp10_size_diagnostic',
          tier: 'diagnostic_only',
        }),
      ]),
    );
  });

  it('allows MBO diagnostic and shadow fields only in non-decision payloads', async () => {
    const root = makeFixtureRoot({ mode: 'shadow_allowed' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(0);
    expect(result.report.status).toBe('pass');
    expect(result.report.feature_surface_summary.diagnostic_fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'mbo_record_count',
          canonical_field: 'mbo_record_count',
          context: 'diagnostic_values',
          tier: 'diagnostic_only',
        }),
      ]),
    );
    expect(result.report.feature_surface_summary.shadow_fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'cancel_add_ratio_shadow',
          canonical_field: 'cancel_add_ratio_shadow',
          context: 'shadow_values',
          tier: 'shadow_only',
        }),
      ]),
    );
  });

  it('fails when a shadow-only field is used as a runtime decision feature', async () => {
    const root = makeFixtureRoot({ mode: 'shadow_decision_feature' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.feature_surface_summary.restricted_fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'cancel_add_ratio_shadow',
          context: 'values',
          tier: 'shadow_only',
        }),
      ]),
    );
  });

  it('fails when shadow fields are emitted without decision_use=false', async () => {
    const root = makeFixtureRoot({ mode: 'shadow_missing_decision_use_false' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.feature_surface_summary.unsafe_shadow_or_diagnostic_decision_use_event_count).toBe(1);
    expect(result.report.feature_surface_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'shadow_or_diagnostic_payloads_have_decision_use_false',
          status: 'fail',
        }),
      ]),
    );
  });

  it('fails when blocked fields appear in shadow payloads', async () => {
    const root = makeFixtureRoot({ mode: 'blocked_shadow_field' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.feature_surface_summary.blocked_fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'queue_position',
          context: 'shadow_values',
          tier: 'blocked',
        }),
      ]),
    );
  });

  it('fails transport checks when the journal has malformed JSONL', async () => {
    const root = makeFixtureRoot({ mode: 'malformed' });

    const result = await runRel00(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.transport_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'journal_json_lines_parseable',
          status: 'fail',
        }),
        expect.objectContaining({
          name: 'journal_transport_no_quarantine',
          status: 'fail',
        }),
      ]),
    );
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

type FixtureMode =
  | 'pass'
  | 'real_order'
  | 'blocked_feature'
  | 'live_exec_reject'
  | 'blocked_fill_tier'
  | 'unterminated_order'
  | 'unknown_terminal_ref'
  | 'restricted_feature'
  | 'shadow_allowed'
  | 'shadow_decision_feature'
  | 'shadow_missing_decision_use_false'
  | 'blocked_shadow_field'
  | 'malformed'
  | 'raw_sentinel';

function makeFixtureRoot(input: { readonly mode: FixtureMode }): string {
  const root = mkdtempSync(join(tmpdir(), 'qfa-rel00-'));
  TEMP_ROOTS.push(root);
  const journal = buildJournal(input.mode);
  writeText(root, 'journals/live-sim.jsonl', journal);
  return root;
}

function buildJournal(mode: FixtureMode): string {
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
    if (mode === 'restricted_feature' && event.type === 'FEATURES') {
      const payload = jsonObject(event.payload);
      event.payload = {
        ...payload,
        values: {
          ...jsonObject(payload.values),
          mbp10_size_diagnostic: 12,
        },
      };
    }
    if (mode === 'shadow_allowed' && event.type === 'MICROSTRUCTURE') {
      const payload = jsonObject(event.payload);
      event.payload = {
        ...payload,
        decision_use: false,
        diagnostic_values: {
          mbo_record_count: 12,
          mbo_taxonomy_status: 'action_taxonomy_unresolved',
        },
        shadow_values: {
          cancel_add_ratio_shadow: 0.25,
          order_lifetime_shadow: 1250,
        },
      };
    }
    if (mode === 'shadow_decision_feature' && event.type === 'FEATURES') {
      const payload = jsonObject(event.payload);
      event.payload = {
        ...payload,
        values: {
          ...jsonObject(payload.values),
          cancel_add_ratio_shadow: 0.25,
        },
      };
    }
    if (mode === 'shadow_missing_decision_use_false' && event.type === 'MICROSTRUCTURE') {
      const payload = jsonObject(event.payload);
      event.payload = {
        ...payload,
        shadow_values: {
          cancel_add_ratio_shadow: 0.25,
        },
      };
    }
    if (mode === 'blocked_shadow_field' && event.type === 'MICROSTRUCTURE') {
      const payload = jsonObject(event.payload);
      event.payload = {
        ...payload,
        decision_use: false,
        shadow_values: {
          queue_position: 1,
        },
      };
    }
    if (mode === 'blocked_fill_tier' && event.type === 'SIM_FILL') {
      const payload = jsonObject(event.payload);
      event.payload = {
        ...payload,
        input_tier: 'blocked',
      };
    }
    if (mode === 'unknown_terminal_ref' && event.type === 'SIM_FILL') {
      const payload = jsonObject(event.payload);
      event.payload = {
        ...payload,
        order_intent_id: 'missing-order-intent',
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
    if (mode === 'unterminated_order' && event.type === 'SIM_FILL') {
      return null;
    }
    return `${JSON.stringify(event)}\n`;
  }).filter((line): line is string => line !== null);
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
  if (mode === 'live_exec_reject') {
    lines.push(`${JSON.stringify({
      causation_id: 'order-1',
      event_id: 'reject-1',
      payload: {
        candidate_id: 'candidate-obs00-1',
        execution_adapter: 'broker_xyz',
        execution_reject_id: 'reject-obs00-1',
        execution_version: 'broker-v1',
        order_intent_id: 'order-obs00-1',
        reason: 'operator test',
        sizing_decision_id: 'sizing-obs00-1',
        status: 'rejected',
      },
      run_id: 'run_obs00_fixture_v1',
      schema_version: 1,
      session_id: '2026-04-23-rth',
      ts_ns: '1700000000060000000',
      type: 'EXEC_REJECT',
    })}\n`);
  }
  if (mode === 'malformed') {
    lines.push('{"event_id": "malformed"\n');
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
