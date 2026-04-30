import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  runRel01ShortFinalPacket,
} from '../../../../scripts/rel/rel-01-short-final-packet.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('REL-01-Short final packet guardrail', () => {
  it('passes a two-session accepted-surface packet with no MBO shadow telemetry', async () => {
    const root = makePacket();

    const result = await runShortFinal(root);

    expect(result.exit_code).toBe(0);
    expect(result.report.status).toBe('pass');
    expect(result.report.summary.session_count).toBe(2);
    expect(result.report.summary.rel01a_status).toBe('pass');
    expect(result.report.summary.rel01d_status).toBe('pass');
    expect(result.report.summary.rel01e_status).toBe('no_shadow_telemetry');
    expect(result.report.scope_decision.formal_rel01_10_session_gate_replaced).toBe(false);
    expect(result.report.scope_decision.mbo_decision_use_allowed).toBe(false);
    expect(result.report.summary.feature_surface.restricted_uses).toBe(0);
    expect(result.report.summary.feature_surface.blocked_uses).toBe(0);
    expect(result.report.summary.feature_surface.shadow_uses).toBe(0);
  });

  it('fails if MBO shadow telemetry appears in the comparable short packet', async () => {
    const root = makePacket({
      rel01dShadowUses: 9,
      rel01eStatus: 'pass',
      rel01eShadowFieldOccurrences: 9,
    });

    const result = await runShortFinal(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('rel01e_status_no_shadow_telemetry'),
        expect.stringContaining('mbo_shadow_telemetry_not_in_comparable_packet'),
      ]),
    );
  });

  it('fails if validator reports are not hash-bound to the manifest', async () => {
    const root = makePacket({ rel01dManifestHashOverride: sha('stale-manifest') });

    const result = await runShortFinal(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('validator_reports_bind_to_manifest_hash'),
      ]),
    );
  });

  it('fails when the policy note is missing', async () => {
    const root = makePacket({ skipPolicyNote: true });

    const result = await runShortFinal(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.check_groups.packet_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'policy_note_exists', status: 'fail' }),
      ]),
    );
  });

  it('writes deterministic reports without embedding raw payload sentinels', async () => {
    const root = makePacket({ rawSentinel: true });

    const first = await runShortFinal(root);
    const firstJson = readFileSync(join(root, 'reports/rel/rel01_short_final_packet_report.json'), 'utf8');
    const second = await runShortFinal(root);
    const secondJson = readFileSync(join(root, 'reports/rel/rel01_short_final_packet_report.json'), 'utf8');

    expect(second.report).toEqual(first.report);
    expect(secondJson).toBe(firstJson);
    expect(firstJson).not.toContain('RAW_SHOULD_NOT_APPEAR');
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/rel/rel-01-short-final-packet.ts', 'utf8');

    expect(source).not.toMatch(/\bDate\.now\b/u);
    expect(source).not.toMatch(/\bnew Date\b/u);
    expect(source).not.toMatch(/\bMath\.random\b/u);
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string>>;

    expect(packageJson.scripts['rel:01:short:final']).toBe(
      'tsx scripts/rel/rel-01-short-final-packet.ts',
    );
  });
});

async function runShortFinal(root: string): Promise<Awaited<ReturnType<typeof runRel01ShortFinalPacket>>> {
  return runRel01ShortFinalPacket({
    cwd: root,
    manifest: 'reports/rel/rel01_manifest.json',
    rel01a_report: 'reports/rel/rel01_short_aggregate_report.json',
    rel01d_report: 'reports/rel/rel01d_feature_surface_audit_report.json',
    rel01e_report: 'reports/rel/rel01e_mbo_shadow_lineage_report.json',
    policy_note: 'reports/rel/rel01_short_policy_note.md',
    out_json: 'reports/rel/rel01_short_final_packet_report.json',
    out_md: 'reports/rel/rel01_short_final_packet_report.md',
  });
}

function makePacket(overrides: {
  readonly rel01dShadowUses?: number;
  readonly rel01eStatus?: string;
  readonly rel01eShadowFieldOccurrences?: number;
  readonly rel01dManifestHashOverride?: string;
  readonly skipPolicyNote?: boolean;
  readonly rawSentinel?: boolean;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'qfa-rel01-short-final-'));
  tempDirectories.push(root);
  const relDir = join(root, 'reports/rel');
  const manifestPath = join(relDir, 'rel01_manifest.json');
  const rel01aPath = join(relDir, 'rel01_short_aggregate_report.json');
  const rel01dPath = join(relDir, 'rel01d_feature_surface_audit_report.json');
  const rel01ePath = join(relDir, 'rel01e_mbo_shadow_lineage_report.json');
  const policyNotePath = join(relDir, 'rel01_short_policy_note.md');

  writeJson(manifestPath, {
    schema_version: 1,
    rel01_run_id: 'rel01-short-current-config-test',
    sessions: [
      { session_id: '2026-04-29-rth', run_id: 'rel01-live-sim-20260429' },
      { session_id: '2026-04-30-rth', run_id: 'rel01-live-sim-20260430' },
    ],
  });
  const manifestHash = shaFile(manifestPath);
  writeJson(rel01aPath, {
    status: 'pass',
    manifest: {
      sha256: manifestHash,
      session_count: 2,
      required_sessions: 2,
    },
    aggregate_counts: {
      total_source_events: 265_437,
      order_intents: 6,
      sim_fills: 6,
      real_order_event_types: 0,
    },
    provenance_spot_checks: {
      requested: 5,
      attempted: 5,
      passed: 5,
    },
    raw_payload: overrides.rawSentinel === true ? 'RAW_SHOULD_NOT_APPEAR' : undefined,
  });
  writeJson(rel01dPath, {
    status: 'pass',
    manifest: {
      sha256: overrides.rel01dManifestHashOverride ?? manifestHash,
    },
    aggregate: {
      partition_counts: {
        authoritative: 1,
        restricted: 0,
        blocked: 0,
        diagnostic: 0,
        shadow: overrides.rel01dShadowUses ?? 0,
        invalid_diagnostic: 0,
        invalid_shadow: 0,
        unknown: 1,
      },
      unsafe_shadow_or_diagnostic_decision_use_event_count: 0,
    },
  });
  writeJson(rel01ePath, {
    status: overrides.rel01eStatus ?? 'no_shadow_telemetry',
    manifest: {
      sha256: manifestHash,
    },
    aggregate: {
      shadow_events: overrides.rel01eShadowFieldOccurrences === undefined ? 0 : 3,
      shadow_field_occurrences: overrides.rel01eShadowFieldOccurrences ?? 0,
      missing_source_event_count: 0,
      lookahead_source_event_count: 0,
      recompute_mismatch_count: 0,
    },
  });
  if (overrides.skipPolicyNote !== true) {
    writeText(
      policyNotePath,
      [
        'REL-01-Short waiver: interim pilot only.',
        'It does not replace formal REL-01 or the 10-session validation.',
        'MBO decision-use blocked.',
        '',
      ].join('\n'),
    );
  }
  return root;
}

function writeJson(path: string, value: Record<string, unknown>): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function shaFile(path: string): string {
  return sha(readFileSync(path, 'utf8'));
}
