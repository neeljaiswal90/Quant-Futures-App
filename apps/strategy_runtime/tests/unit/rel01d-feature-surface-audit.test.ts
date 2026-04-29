import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runRel01dFeatureSurfaceAudit,
} from '../../../../scripts/rel/rel-01d-feature-surface-audit.js';
import { buildFeatureAvailabilityMask } from '../../src/features/availability-mask.js';

const TEMP_ROOTS: string[] = [];

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('REL-01D feature-surface audit', () => {
  it('passes and reports per-field usage frequency for accepted and shadow-safe sessions', async () => {
    const root = makePacketRoot({ sessionCount: 2 });

    const result = await runRel01d(root);

    expect(result.exit_code).toBe(0);
    expect(result.report.status).toBe('pass');
    expect(result.report.audit_mask).toMatchObject({
      mask_version: 4,
      mask_id: 'feature-availability-mask-v4-adr0002-data03ps-mbo-shadow',
    });
    expect(result.report.aggregate.partition_counts.authoritative).toBe(14);
    expect(result.report.aggregate.partition_counts.diagnostic).toBe(4);
    expect(result.report.aggregate.partition_counts.shadow).toBe(4);
    expect(result.report.aggregate.field_usage_by_partition.authoritative).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonical_field: 'l1_quote_bid_px',
          count: 2,
          sessions: ['2026-04-01-rth', '2026-04-02-rth'],
        }),
      ]),
    );
    expect(result.report.aggregate.field_usage_by_partition.shadow).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonical_field: 'cancel_add_ratio_shadow',
          context: 'shadow_values',
          count: 2,
        }),
      ]),
    );
  });

  it('fails when a shadow-only field appears in decision values', async () => {
    const root = makePacketRoot({ sessionCount: 1, mode: 'shadow_in_values' });

    const result = await runRel01d(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.aggregate.field_usage_by_partition.restricted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: 'values',
          canonical_field: 'cancel_add_ratio_shadow',
          tier: 'shadow_only',
        }),
      ]),
    );
    expect(result.report.check_groups.decision_surface_checks.status).toBe('fail');
  });

  it('fails when a blocked field appears in a decision payload', async () => {
    const root = makePacketRoot({ sessionCount: 1, mode: 'blocked_decision_payload' });

    const result = await runRel01d(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.aggregate.field_usage_by_partition.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'RISK_GATE',
          context: 'decision_payload',
          canonical_field: 'queue_position',
          tier: 'blocked',
        }),
      ]),
    );
  });

  it('fails when shadow_values contains a non-shadow field', async () => {
    const root = makePacketRoot({ sessionCount: 1, mode: 'authoritative_in_shadow' });

    const result = await runRel01d(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.aggregate.field_usage_by_partition.invalid_shadow).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: 'shadow_values',
          canonical_field: 'l1_quote_bid_px',
          tier: 'authoritative',
        }),
      ]),
    );
  });

  it('fails when shadow or diagnostic payloads omit decision_use=false', async () => {
    const root = makePacketRoot({ sessionCount: 1, mode: 'missing_decision_use_false' });

    const result = await runRel01d(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.aggregate.unsafe_shadow_or_diagnostic_decision_use_event_count).toBe(1);
    expect(result.report.check_groups.shadow_diagnostic_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'shadow_or_diagnostic_payloads_have_decision_use_false',
          status: 'fail',
        }),
      ]),
    );
  });

  it('fails when embedded feature masks disagree with the v4 audit mask', async () => {
    const root = makePacketRoot({ sessionCount: 1, mode: 'mask_mismatch' });

    const result = await runRel01d(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.aggregate.embedded_mask_mismatch_count).toBe(1);
    expect(result.report.check_groups.mask_binding_checks.status).toBe('fail');
  });

  it('fails missing and malformed journals cleanly', async () => {
    const missingRoot = makePacketRoot({ sessionCount: 1, missingJournal: true });
    const malformedRoot = makePacketRoot({ sessionCount: 1, mode: 'malformed' });

    const missing = await runRel01d(missingRoot);
    const malformed = await runRel01d(malformedRoot);

    expect(missing.exit_code).toBe(2);
    expect(missing.report.sessions[0]?.journal_exists).toBe(false);
    expect(malformed.exit_code).toBe(2);
    expect(malformed.report.aggregate.parse_error_count).toBe(1);
  });

  it('writes deterministic reports without embedding raw payload values', async () => {
    const root = makePacketRoot({ sessionCount: 1, rawSentinel: true });

    const first = await runRel01d(root);
    const firstJson = readFileSync(join(root, 'reports/rel/rel01d_feature_surface_audit.json'), 'utf8');
    const firstMd = readFileSync(join(root, 'reports/rel/rel01d_feature_surface_audit.md'), 'utf8');
    const second = await runRel01d(root);

    expect(second.report).toEqual(first.report);
    expect(readFileSync(join(root, 'reports/rel/rel01d_feature_surface_audit.json'), 'utf8')).toBe(firstJson);
    expect(readFileSync(join(root, 'reports/rel/rel01d_feature_surface_audit.md'), 'utf8')).toBe(firstMd);
    expect(firstJson).not.toContain('RAW_SHOULD_NOT_APPEAR');
    expect(firstMd).not.toContain('RAW_SHOULD_NOT_APPEAR');
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/rel/rel-01d-feature-surface-audit.ts', 'utf8');

    expect(source).not.toMatch(/\bDate\.now\b/u);
    expect(source).not.toMatch(/\bnew Date\b/u);
    expect(source).not.toMatch(/\bMath\.random\b/u);
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string>>;

    expect(packageJson.scripts['rel:01d:feature-surface-audit']).toBe(
      'tsx scripts/rel/rel-01d-feature-surface-audit.ts',
    );
  });
});

async function runRel01d(root: string): Promise<Awaited<ReturnType<typeof runRel01dFeatureSurfaceAudit>>> {
  return runRel01dFeatureSurfaceAudit({
    cwd: root,
    manifest: 'reports/rel/rel01_manifest.json',
    out_json: 'reports/rel/rel01d_feature_surface_audit.json',
    out_md: 'reports/rel/rel01d_feature_surface_audit.md',
  });
}

type JournalMode =
  | 'pass'
  | 'shadow_in_values'
  | 'blocked_decision_payload'
  | 'authoritative_in_shadow'
  | 'missing_decision_use_false'
  | 'mask_mismatch'
  | 'malformed';

function makePacketRoot(input: {
  readonly sessionCount?: number;
  readonly mode?: JournalMode;
  readonly missingJournal?: boolean;
  readonly rawSentinel?: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'qfa-rel01d-'));
  TEMP_ROOTS.push(root);
  const sessions = [];
  const sessionCount = input.sessionCount ?? 1;
  for (let index = 0; index < sessionCount; index += 1) {
    const oneBased = index + 1;
    const date = `2026-04-${String(oneBased).padStart(2, '0')}`;
    const sessionId = `${date}-rth`;
    const runId = `rel01-live-sim-${date.replace(/-/gu, '')}`;
    const journal = `reports/rel/session${String(oneBased).padStart(2, '0')}/runtime.jsonl`;
    if (input.missingJournal !== true) {
      writeText(root, journal, buildJournal({
        sessionId,
        runId,
        mode: index === 0 ? input.mode ?? 'pass' : 'pass',
        rawSentinel: input.rawSentinel === true && index === 0,
      }));
    }
    sessions.push({
      session_id: sessionId,
      run_id: runId,
      journal,
      rel00_report: `reports/rel/session${String(oneBased).padStart(2, '0')}/rel00.json`,
      rel00c_report: `reports/rel/session${String(oneBased).padStart(2, '0')}/rel00c.json`,
    });
  }
  writeJson(root, 'reports/rel/rel01_manifest.json', {
    schema_version: 1,
    rel01_run_id: 'rel01d-fixture',
    runtime_commit: 'fixture',
    config_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    strategy_config_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    risk_config_hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    management_config_hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    sim03_report: 'reports/sim/refit.json',
    sim03_gate: 'reports/sim/gate.json',
    sessions,
  });
  return root;
}

function buildJournal(input: {
  readonly sessionId: string;
  readonly runId: string;
  readonly mode: JournalMode;
  readonly rawSentinel?: boolean;
}): string {
  const mask = buildFeatureAvailabilityMask();
  const embeddedMask = input.mode === 'mask_mismatch'
    ? { ...mask, mask_id: 'feature-availability-mask-v3-adr0002-infra01e-infra01f-data04' }
    : mask;
  const microPayload: Record<string, unknown> = {
    decision_use: input.mode === 'missing_decision_use_false' ? undefined : false,
    diagnostic_values: {
      mbo_record_count: 12,
      mbo_taxonomy_status: 'action_taxonomy_unresolved',
    },
    exchange_event_ts_ns: '1700000000002000000',
    feature_availability_mask: embeddedMask,
    feature_snapshot_id: 'feature-micro-1',
    l3_authority: 'authoritative',
    shadow_values: input.mode === 'authoritative_in_shadow'
      ? { l1_quote_bid_px: 18500.25 }
      : {
          cancel_add_ratio_shadow: 0.25,
          order_lifetime_shadow: 1250,
        },
    sidecar_recv_ts_ns: '1700000000002100000',
    values: {
      mid_px: 18500.375,
      spread_ticks: 1,
    },
  };
  if (microPayload.decision_use === undefined) {
    delete microPayload.decision_use;
  }
  const featuresValues: Record<string, unknown> = {
    l1_quote_ask_px: 18500.5,
    l1_quote_bid_px: 18500.25,
    last_trade_aggressor_side: 'buy',
    last_trade_price: 18500.5,
    last_trade_size: 1,
    internal_signal: input.rawSentinel === true ? 'RAW_SHOULD_NOT_APPEAR' : 0.75,
  };
  if (input.mode === 'shadow_in_values') {
    featuresValues.cancel_add_ratio_shadow = 0.25;
  }
  const riskPayload: Record<string, unknown> = {
    candidate_id: 'candidate-1',
    reasons: [],
    risk_gate_decision_id: 'risk-1',
    status: 'pass',
  };
  if (input.mode === 'blocked_decision_payload') {
    riskPayload.decision_inputs = { queue_position: 4 };
  }
  const events = [
    event(input, 'config-1', 'CONFIG', { config_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', config_version: 1 }, '1700000000000000000'),
    event(input, 'features-1', 'FEATURES', {
      feature_availability_mask: mask,
      feature_snapshot_id: 'feature-1',
      values: featuresValues,
    }, '1700000000001000000'),
    event(input, 'micro-1', 'MICROSTRUCTURE', microPayload, '1700000000002000000'),
    event(input, 'risk-1', 'RISK_GATE', riskPayload, '1700000000003000000'),
  ].map((item) => JSON.stringify(item));
  if (input.mode === 'malformed') {
    events.push('{malformed-json');
  }
  return `${events.join('\n')}\n`;
}

function event(
  input: { readonly sessionId: string; readonly runId: string },
  eventId: string,
  type: string,
  payload: Record<string, unknown>,
  tsNs: string,
): Record<string, unknown> {
  return {
    event_id: eventId,
    payload,
    run_id: input.runId,
    schema_version: 1,
    session_id: input.sessionId,
    ts_ns: tsNs,
    type,
  };
}

function writeText(root: string, path: string, value: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value, 'utf8');
}

function writeJson(root: string, path: string, value: unknown): void {
  writeText(root, path, `${JSON.stringify(value, null, 2)}\n`);
}
