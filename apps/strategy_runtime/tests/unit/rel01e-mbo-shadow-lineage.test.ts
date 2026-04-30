import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runRel01eMboShadowLineage } from '../../../../scripts/rel/rel-01e-mbo-shadow-lineage.js';

const START_TS_NS = 1_777_301_421_588_943_700n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-rel01e-'));
  tempDirectories.push(directory);
  return directory;
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writeJsonl(path: string, events: readonly Record<string, unknown>[]): string {
  const text = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  writeFileSync(path, text, 'utf8');
  return sha256Text(text);
}

function mboSourceEvent(
  eventId: string,
  offsetNs: bigint,
  action: 'add' | 'cancel' | 'modify',
  orderId = 'order-1',
): Record<string, unknown> {
  const ts = (START_TS_NS + offsetNs).toString();
  return {
    schema_version: 1,
    event_id: eventId,
    type: 'MICROSTRUCTURE',
    ts_ns: ts,
    run_id: 'run-mbo-source',
    session_id: '2026-04-29-rth',
    payload: {
      exchange_event_ts_ns: ts,
      sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000n).toString(),
      feature_snapshot_id: eventId,
      source: 'mbo_order_lifecycle',
      microstructure_kind: 'mbo_order_lifecycle',
      action,
      order_id: orderId,
      values: {},
      data01b_full_status: 'blocked',
    },
  };
}

function runtimeShadowEvent(
  sourceHash: string,
  overrides: {
    readonly shadow_values?: Record<string, unknown>;
    readonly source_event_ids?: readonly string[];
    readonly source_window_end_ts_ns?: string;
    readonly source_journal_sha256?: string;
    readonly event_offset_ns?: bigint;
    readonly decision_use?: boolean;
    readonly lineage_fields?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const offsetNs = overrides.event_offset_ns ?? 2_000_000n;
  const ts = (START_TS_NS + offsetNs).toString();
  const sourceEventIds = overrides.source_event_ids ?? ['mbo-add-1', 'mbo-cancel-1'];
  const shadowValues = overrides.shadow_values ?? {
    cancel_add_ratio_shadow: 1,
    mbo_action_imbalance_shadow: 0,
    order_lifetime_shadow: 1,
  };
  const defaultLineageFields = Object.fromEntries(
    Object.keys(shadowValues).map((field) => [
      field,
      {
        derivation_method: methodForField(field),
        source_event_ids: sourceEventIds,
        source_window_start_ts_ns: (START_TS_NS).toString(),
        source_window_end_ts_ns: overrides.source_window_end_ts_ns ?? (START_TS_NS + 1_000_000n).toString(),
      },
    ]),
  );
  return {
    schema_version: 1,
    event_id: 'runtime-shadow-1',
    type: 'FEATURES',
    ts_ns: ts,
    run_id: 'rel01-live-sim-20260429',
    session_id: '2026-04-29-rth',
    causation_id: 'mbo-cancel-1',
    payload: {
      feature_snapshot_id: 'feature-shadow-1',
      values: {},
      shadow_values: shadowValues,
      decision_use: overrides.decision_use ?? false,
      mbo_shadow_lineage: {
        schema_version: 1,
        source_journal_sha256: overrides.source_journal_sha256 ?? sourceHash,
        fields: overrides.lineage_fields ?? defaultLineageFields,
      },
    },
  };
}

function methodForField(field: string): string {
  if (field === 'cancel_add_ratio_shadow') return 'mbo_cancel_add_ratio_v1';
  if (field === 'mbo_action_imbalance_shadow') return 'mbo_action_imbalance_v1';
  if (field === 'order_lifetime_shadow') return 'mbo_order_lifetime_mean_ms_v1';
  return 'unsupported_shadow_method';
}

function makePacket(options: {
  readonly runtimeEvents?: readonly Record<string, unknown>[];
  readonly sourceEvents?: readonly Record<string, unknown>[];
  readonly includeSource?: boolean;
  readonly sourceHashOverride?: string;
} = {}): {
  readonly cwd: string;
  readonly manifest: string;
  readonly runtimeJournal: string;
  readonly sourceJournal: string;
  readonly sourceHash: string;
} {
  const cwd = makeTempDir();
  const sourceJournal = join(cwd, 'mbo-source.jsonl');
  const sourceHash = writeJsonl(sourceJournal, options.sourceEvents ?? [
    mboSourceEvent('mbo-add-1', 0n, 'add'),
    mboSourceEvent('mbo-cancel-1', 1_000_000n, 'cancel'),
  ]);
  const runtimeJournal = join(cwd, 'runtime.jsonl');
  writeJsonl(runtimeJournal, options.runtimeEvents ?? [runtimeShadowEvent(sourceHash)]);
  const session: Record<string, unknown> = {
    session_id: '2026-04-29-rth',
    run_id: 'rel01-live-sim-20260429',
    journal: 'runtime.jsonl',
    rel00_report: 'rel00.json',
    rel00c_report: 'rel00c.json',
  };
  if (options.includeSource !== false) {
    session.mbo_source_journal = 'mbo-source.jsonl';
    session.mbo_source_journal_sha256 = options.sourceHashOverride ?? sourceHash;
  }
  const manifest = join(cwd, 'manifest.json');
  writeFileSync(
    manifest,
    `${JSON.stringify({
      schema_version: 1,
      rel01_run_id: 'rel01-short-shadow-test',
      runtime_commit: 'test-runtime',
      config_hash: 'cfg',
      strategy_config_hash: 'strategy',
      risk_config_hash: 'risk',
      management_config_hash: 'mgmt',
      sim03_report: 'sim03.json',
      sim03_gate: 'sim03-gate.json',
      sessions: [session],
    })}\n`,
    'utf8',
  );
  return { cwd, manifest, runtimeJournal, sourceJournal, sourceHash };
}

describe('REL-01E MBO shadow lineage validator', () => {
  it('passes lineage-rich shadow telemetry with causal source MBO records', async () => {
    const packet = makePacket();
    const result = await runRel01eMboShadowLineage({
      cwd: packet.cwd,
      manifest: packet.manifest,
    });

    expect(result.exit_code).toBe(0);
    expect(result.report.status).toBe('pass');
    expect(result.report.aggregate).toMatchObject({
      shadow_events: 1,
      shadow_field_occurrences: 3,
      lineage_records: 3,
      missing_source_event_count: 0,
      lookahead_source_event_count: 0,
      recompute_mismatch_count: 0,
    });
    expect(result.report.aggregate.field_counts).toEqual([
      { field: 'cancel_add_ratio_shadow', count: 1, sessions: ['2026-04-29-rth'] },
      { field: 'mbo_action_imbalance_shadow', count: 1, sessions: ['2026-04-29-rth'] },
      { field: 'order_lifetime_shadow', count: 1, sessions: ['2026-04-29-rth'] },
    ]);
  });

  it('reports no_shadow_telemetry instead of claiming MBO lineage readiness when no shadow_values exist', async () => {
    const packet = makePacket({
      runtimeEvents: [{
        schema_version: 1,
        event_id: 'features-no-shadow',
        type: 'FEATURES',
        ts_ns: (START_TS_NS + 1_000_000n).toString(),
        run_id: 'rel01-live-sim-20260429',
        session_id: '2026-04-29-rth',
        causation_id: 'source-1',
        payload: { feature_snapshot_id: 'feature-1', values: { l1_quote_bid_px: 18500 } },
      }],
    });

    const result = await runRel01eMboShadowLineage({ cwd: packet.cwd, manifest: packet.manifest });

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('no_shadow_telemetry');
    expect(result.report.reasons).toContain('shadow_presence_checks:shadow_telemetry_present: shadow_fields=0');
  });

  it('fails when shadow telemetry lacks a source MBO journal', async () => {
    const sourceEvents = [mboSourceEvent('mbo-add-1', 0n, 'add'), mboSourceEvent('mbo-cancel-1', 1_000_000n, 'cancel')];
    const cwd = makeTempDir();
    const text = `${sourceEvents.map((event) => JSON.stringify(event)).join('\n')}\n`;
    const sourceHash = sha256Text(text);
    const runtimeJournal = join(cwd, 'runtime.jsonl');
    writeJsonl(runtimeJournal, [runtimeShadowEvent(sourceHash)]);
    const manifest = join(cwd, 'manifest.json');
    writeFileSync(manifest, `${JSON.stringify({
      schema_version: 1,
      rel01_run_id: 'rel01-short-shadow-test',
      runtime_commit: 'test-runtime',
      config_hash: 'cfg',
      strategy_config_hash: 'strategy',
      risk_config_hash: 'risk',
      management_config_hash: 'mgmt',
      sim03_report: 'sim03.json',
      sim03_gate: 'sim03-gate.json',
      sessions: [{
        session_id: '2026-04-29-rth',
        run_id: 'rel01-live-sim-20260429',
        journal: 'runtime.jsonl',
        rel00_report: 'rel00.json',
      }],
    })}\n`, 'utf8');

    const result = await runRel01eMboShadowLineage({ cwd, manifest });

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.sessions[0]?.reasons).toContain('mbo_source_journal_required_for_shadow_values');
  });

  it('fails when lineage references missing source events', async () => {
    const packet = makePacket({
      runtimeEvents: [runtimeShadowEvent('placeholder', {
        source_journal_sha256: 'placeholder',
        source_event_ids: ['missing-source'],
      })],
    });
    const sourceHash = sha256Text(readFileSync(packet.sourceJournal, 'utf8'));
    writeJsonl(packet.runtimeJournal, [runtimeShadowEvent(sourceHash, {
      source_event_ids: ['missing-source'],
    })]);

    const result = await runRel01eMboShadowLineage({ cwd: packet.cwd, manifest: packet.manifest });

    expect(result.report.status).toBe('fail');
    expect(result.report.aggregate.missing_source_event_count).toBe(3);
  });

  it('fails when source MBO events occur after the shadow event timestamp', async () => {
    const sourceEvents = [
      mboSourceEvent('mbo-add-1', 0n, 'add'),
      mboSourceEvent('mbo-cancel-1', 2_000_000n, 'cancel'),
    ];
    const cwd = makeTempDir();
    const sourceJournal = join(cwd, 'mbo-source.jsonl');
    const sourceHash = writeJsonl(sourceJournal, sourceEvents);
    const runtimeJournal = join(cwd, 'runtime.jsonl');
    writeJsonl(runtimeJournal, [runtimeShadowEvent(sourceHash, {
      event_offset_ns: 1_000_000n,
      source_window_end_ts_ns: (START_TS_NS + 2_000_000n).toString(),
    })]);
    const manifest = makePacketManifest(cwd, sourceHash);

    const result = await runRel01eMboShadowLineage({ cwd, manifest });

    expect(result.report.status).toBe('fail');
    expect(result.report.aggregate.lookahead_source_event_count).toBeGreaterThanOrEqual(1);
  });

  it('fails when lineage source events fall outside the declared source window', async () => {
    const packet = makePacket();
    writeJsonl(packet.runtimeJournal, [runtimeShadowEvent(packet.sourceHash, {
      shadow_values: { cancel_add_ratio_shadow: 1 },
      lineage_fields: {
        cancel_add_ratio_shadow: {
          derivation_method: 'mbo_cancel_add_ratio_v1',
          source_event_ids: ['mbo-add-1', 'mbo-cancel-1'],
          source_window_start_ts_ns: (START_TS_NS + 500_000n).toString(),
          source_window_end_ts_ns: (START_TS_NS + 1_000_000n).toString(),
        },
      },
    })]);

    const result = await runRel01eMboShadowLineage({ cwd: packet.cwd, manifest: packet.manifest });

    expect(result.report.status).toBe('fail');
    expect(result.report.aggregate.lookahead_source_event_count).toBe(1);
    expect(result.report.sessions[0]?.violation_examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'cancel_add_ratio_shadow',
          reason: 'source_event_outside_declared_window',
        }),
      ]),
    );
  });

  it('fails when the manifest or event lineage source hash does not match source bytes', async () => {
    const packet = makePacket({ sourceHashOverride: 'not-the-source-hash' });
    const result = await runRel01eMboShadowLineage({ cwd: packet.cwd, manifest: packet.manifest });

    expect(result.report.status).toBe('fail');
    expect(result.report.aggregate.source_hash_mismatch_count).toBeGreaterThan(0);
  });

  it('fails when a supported shadow value does not recompute from source MBO events', async () => {
    const packet = makePacket();
    writeJsonl(packet.runtimeJournal, [runtimeShadowEvent(packet.sourceHash, {
      shadow_values: { cancel_add_ratio_shadow: 99 },
      lineage_fields: {
        cancel_add_ratio_shadow: {
          derivation_method: 'mbo_cancel_add_ratio_v1',
          source_event_ids: ['mbo-add-1', 'mbo-cancel-1'],
          source_window_start_ts_ns: START_TS_NS.toString(),
          source_window_end_ts_ns: (START_TS_NS + 1_000_000n).toString(),
        },
      },
    })]);

    const result = await runRel01eMboShadowLineage({ cwd: packet.cwd, manifest: packet.manifest });

    expect(result.report.status).toBe('fail');
    expect(result.report.aggregate.recompute_mismatch_count).toBe(1);
  });

  it('fails closed on unsupported shadow fields until their derivation contract lands', async () => {
    const packet = makePacket();
    writeJsonl(packet.runtimeJournal, [runtimeShadowEvent(packet.sourceHash, {
      shadow_values: { absorption_score_shadow: 0.5 },
    })]);

    const result = await runRel01eMboShadowLineage({ cwd: packet.cwd, manifest: packet.manifest });

    expect(result.report.status).toBe('fail');
    expect(result.report.aggregate.unsupported_shadow_field_count).toBe(1);
  });

  it('writes deterministic reports without raw MBO or shadow values', async () => {
    const packet = makePacket({
      sourceEvents: [
        mboSourceEvent('mbo-add-1', 0n, 'add', 'RAW_SHOULD_NOT_APPEAR'),
        mboSourceEvent('mbo-cancel-1', 1_000_000n, 'cancel', 'RAW_SHOULD_NOT_APPEAR'),
      ],
    });
    const firstJson = join(packet.cwd, 'first.json');
    const firstMd = join(packet.cwd, 'first.md');
    const secondJson = join(packet.cwd, 'second.json');
    const secondMd = join(packet.cwd, 'second.md');

    await runRel01eMboShadowLineage({
      cwd: packet.cwd,
      manifest: packet.manifest,
      out_json: firstJson,
      out_md: firstMd,
    });
    await runRel01eMboShadowLineage({
      cwd: packet.cwd,
      manifest: packet.manifest,
      out_json: secondJson,
      out_md: secondMd,
    });

    expect(readFileSync(firstJson, 'utf8')).toBe(readFileSync(secondJson, 'utf8'));
    expect(readFileSync(firstMd, 'utf8')).toBe(readFileSync(secondMd, 'utf8'));
    expect(readFileSync(firstJson, 'utf8')).not.toContain('RAW_SHOULD_NOT_APPEAR');
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/rel/rel-01e-mbo-shadow-lineage.ts', 'utf8');

    expect(source).not.toMatch(/\bDate\.now\b/u);
    expect(source).not.toMatch(/\bnew Date\b/u);
    expect(source).not.toMatch(/\bMath\.random\b/u);
  });

  it('exposes the npm script', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['rel:01e:mbo-shadow-lineage']).toBe(
      'tsx scripts/rel/rel-01e-mbo-shadow-lineage.ts',
    );
  });
});

function makePacketManifest(cwd: string, sourceHash: string): string {
  const manifest = join(cwd, 'manifest.json');
  writeFileSync(
    manifest,
    `${JSON.stringify({
      schema_version: 1,
      rel01_run_id: 'rel01-short-shadow-test',
      runtime_commit: 'test-runtime',
      config_hash: 'cfg',
      strategy_config_hash: 'strategy',
      risk_config_hash: 'risk',
      management_config_hash: 'mgmt',
      sim03_report: 'sim03.json',
      sim03_gate: 'sim03-gate.json',
      sessions: [{
        session_id: '2026-04-29-rth',
        run_id: 'rel01-live-sim-20260429',
        journal: 'runtime.jsonl',
        rel00_report: 'rel00.json',
        rel00c_report: 'rel00c.json',
        mbo_source_journal: 'mbo-source.jsonl',
        mbo_source_journal_sha256: sourceHash,
      }],
    })}\n`,
    'utf8',
  );
  return manifest;
}
