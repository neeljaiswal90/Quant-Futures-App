import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runOrchMbo01ShadowProducer } from '../../../../scripts/orch/orch-mbo-01-shadow-producer.js';
import { runRel00ControlledLiveSimReadiness } from '../../../../scripts/rel/rel-00-controlled-live-sim-readiness.js';
import { runRel01dFeatureSurfaceAudit } from '../../../../scripts/rel/rel-01d-feature-surface-audit.js';
import { runRel01eMboShadowLineage } from '../../../../scripts/rel/rel-01e-mbo-shadow-lineage.js';

const START_TS_NS = 1_777_301_421_588_943_700n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-orch-mbo-01-'));
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

function readJsonl(path: string): readonly Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function ts(offsetNs: bigint): string {
  return (START_TS_NS + offsetNs).toString();
}

function quoteEvent(offsetNs: bigint): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: `quote-${offsetNs.toString()}`,
    type: 'QUOTE',
    ts_ns: ts(offsetNs),
    run_id: 'rel01-live-sim-20260429',
    session_id: '2026-04-29-rth',
    payload: {
      exchange_event_ts_ns: ts(offsetNs),
      sidecar_recv_ts_ns: ts(offsetNs + 1_000n),
      bid_px: 18500,
      bid_qty: 4,
      ask_px: 18500.25,
      ask_qty: 5,
      authority: 'authoritative',
    },
  };
}

function tradeEvent(offsetNs: bigint): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: `trade-${offsetNs.toString()}`,
    type: 'TRADE',
    ts_ns: ts(offsetNs),
    run_id: 'rel01-live-sim-20260429',
    session_id: '2026-04-29-rth',
    payload: {
      exchange_event_ts_ns: ts(offsetNs),
      sidecar_recv_ts_ns: ts(offsetNs + 1_000n),
      trade_id: `trade-id-${offsetNs.toString()}`,
      price: 18500.25,
      quantity: 2,
      aggressor_side: 'buy',
    },
  };
}

function mboSourceEvent(
  eventId: string,
  offsetNs: bigint,
  action: 'add' | 'cancel' | 'modify',
  orderId = 'order-1',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: eventId,
    type: 'MICROSTRUCTURE',
    ts_ns: ts(offsetNs),
    run_id: 'rel01-live-sim-20260429',
    session_id: '2026-04-29-rth',
    payload: {
      exchange_event_ts_ns: ts(offsetNs),
      sidecar_recv_ts_ns: ts(offsetNs + 1_000n),
      feature_snapshot_id: `feature-${eventId}`,
      source: 'mbo_order_lifecycle',
      microstructure_kind: 'mbo_order_lifecycle',
      action,
      order_id: orderId,
      values: {},
      ...extra,
    },
  };
}

function makePacket(options: {
  readonly cwd?: string;
  readonly runtimeEvents?: readonly Record<string, unknown>[];
  readonly sourceEvents?: readonly Record<string, unknown>[];
} = {}): {
  readonly cwd: string;
  readonly runtimeJournal: string;
  readonly sourceJournal: string;
  readonly sourceHash: string;
} {
  const cwd = options.cwd ?? makeTempDir();
  const runtimeJournal = join(cwd, 'runtime.jsonl');
  const sourceJournal = join(cwd, 'mbo-source.jsonl');
  writeJsonl(runtimeJournal, options.runtimeEvents ?? [
    quoteEvent(3_000_000n),
    tradeEvent(4_000_000n),
  ]);
  const sourceHash = writeJsonl(sourceJournal, options.sourceEvents ?? [
    mboSourceEvent('mbo-add-1', 0n, 'add'),
    mboSourceEvent('mbo-cancel-1', 1_000_000n, 'cancel'),
    mboSourceEvent('mbo-add-2', 2_000_000n, 'add', 'order-2'),
    mboSourceEvent('mbo-cancel-2', 2_500_000n, 'cancel', 'order-2'),
  ]);
  return { cwd, runtimeJournal, sourceJournal, sourceHash };
}

async function generateShadowPacket(cwd = makeTempDir()): Promise<{
  readonly cwd: string;
  readonly runtimeJournal: string;
  readonly sourceJournal: string;
  readonly sourceHash: string;
  readonly outJournal: string;
  readonly reportPath: string;
}> {
  const packet = makePacket({ cwd });
  const outJournal = join(cwd, 'runtime-shadow.jsonl');
  const reportPath = join(cwd, 'orch-report.json');
  const result = await runOrchMbo01ShadowProducer({
    cwd,
    runtime_journal: 'runtime.jsonl',
    mbo_source_journal: 'mbo-source.jsonl',
    out_journal: 'runtime-shadow.jsonl',
    report: 'orch-report.json',
    run_id: 'rel01-live-sim-20260429',
    session_id: '2026-04-29-rth',
    window_event_count: 4,
    emit_every: 4,
  });
  expect(result.exit_code).toBe(0);
  expect(result.report.status).toBe('generated');
  return { ...packet, outJournal, reportPath };
}

function writeManifest(cwd: string, journal = 'runtime-shadow.jsonl', sourceHash?: string): string {
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
        journal,
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

describe('ORCH-MBO-01 shadow producer', () => {
  it('generates a shadow-enriched runtime journal and hash-bound report', async () => {
    const packet = await generateShadowPacket();
    const events = readJsonl(packet.outJournal);
    const shadowEvents = events.filter((event) => event.type === 'FEATURES');

    expect(shadowEvents.length).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['QUOTE', 'FEATURES', 'TRADE']);

    const resultReport = JSON.parse(readFileSync(packet.reportPath, 'utf8')) as Record<string, unknown>;
    expect(resultReport).toMatchObject({
      status: 'generated',
      input: {
        mbo_source_journal: { sha256: packet.sourceHash },
      },
      generation: {
        runtime_events_copied: 2,
        source_mbo_events_indexed: 4,
        shadow_events_emitted: 1,
        shadow_field_occurrences: 3,
      },
      real_order_event_types_emitted: 0,
      safety_posture: {
        decision_use: false,
        runtime_values_payload_mutated: false,
        mbo_decision_use_allowed: false,
      },
    });
  });

  it('produces journals accepted by REL-00, REL-01D, and REL-01E', async () => {
    const packet = await generateShadowPacket();
    const rel00 = await runRel00ControlledLiveSimReadiness({
      cwd: packet.cwd,
      journal: 'runtime-shadow.jsonl',
      out_json: 'rel00-shadow.json',
      out_md: 'rel00-shadow.md',
      validation_dir: 'rel00-shadow-validation',
      min_source_events: 1,
    });
    expect(rel00.exit_code).toBe(0);
    expect(rel00.report.status).toBe('pass');

    const manifest = writeManifest(packet.cwd, 'runtime-shadow.jsonl', packet.sourceHash);
    const rel01d = await runRel01dFeatureSurfaceAudit({
      cwd: packet.cwd,
      manifest,
      out_json: 'rel01d-shadow.json',
      out_md: 'rel01d-shadow.md',
    });
    expect(rel01d.exit_code).toBe(0);
    expect(rel01d.report.status).toBe('pass');
    expect(rel01d.report.aggregate.partition_counts.shadow).toBe(3);

    const rel01e = await runRel01eMboShadowLineage({
      cwd: packet.cwd,
      manifest,
      out_json: 'rel01e-shadow.json',
      out_md: 'rel01e-shadow.md',
    });
    expect(rel01e.exit_code).toBe(0);
    expect(rel01e.report.status).toBe('pass');
    expect(rel01e.report.aggregate).toMatchObject({
      shadow_events: 1,
      shadow_field_occurrences: 3,
      missing_source_event_count: 0,
      lookahead_source_event_count: 0,
      recompute_mismatch_count: 0,
    });
  });

  it('emits only non-decision shadow fields and never real-order event types', async () => {
    const packet = await generateShadowPacket();
    const events = readJsonl(packet.outJournal);
    const realOrderTypes = new Set([
      'ORDER_PLANT',
      'LIVE_ORDER',
      'BROKER_ORDER',
      'ORDER_ACK',
      'ORDER_FILL',
      'ORDER_CANCEL',
      'ORDER_REPLACE',
      'EXECUTION_REPORT',
      'LIVE_FILL',
    ]);
    expect(events.some((event) => realOrderTypes.has(String(event.type)))).toBe(false);

    const shadowEvent = events.find((event) => event.type === 'FEATURES');
    expect(shadowEvent).toBeDefined();
    const payload = shadowEvent?.payload as Record<string, unknown>;
    expect(payload.values).toEqual({});
    expect(payload.decision_use).toBe(false);
    expect(Object.keys(payload.shadow_values as Record<string, unknown>).sort()).toEqual([
      'cancel_add_ratio_shadow',
      'mbo_action_imbalance_shadow',
      'order_lifetime_shadow',
    ]);
  });

  it('fails cleanly when source journals are missing or malformed', async () => {
    const cwd = makeTempDir();
    writeJsonl(join(cwd, 'runtime.jsonl'), [quoteEvent(3_000_000n)]);

    const missing = await runOrchMbo01ShadowProducer({
      cwd,
      runtime_journal: 'runtime.jsonl',
      mbo_source_journal: 'missing.jsonl',
      run_id: 'rel01-live-sim-20260429',
      session_id: '2026-04-29-rth',
    });
    expect(missing.exit_code).toBe(2);
    expect(missing.report.status).toBe('requires_inputs');

    writeFileSync(join(cwd, 'bad-mbo.jsonl'), 'not-json\n', 'utf8');
    const malformed = await runOrchMbo01ShadowProducer({
      cwd,
      runtime_journal: 'runtime.jsonl',
      mbo_source_journal: 'bad-mbo.jsonl',
      run_id: 'rel01-live-sim-20260429',
      session_id: '2026-04-29-rth',
    });
    expect(malformed.exit_code).toBe(3);
    expect(malformed.report.status).toBe('failed');
    expect(malformed.report.reasons).toContain('mbo_source_journal_parse_errors');
  });

  it('is deterministic and does not embed raw MBO payload values in the report', async () => {
    const cwdA = makeTempDir();
    const cwdB = makeTempDir();
    makePacket({
      cwd: cwdA,
      sourceEvents: [
        mboSourceEvent('mbo-add-1', 0n, 'add', 'order-1', { raw_secret: 'RAW_SHOULD_NOT_APPEAR' }),
        mboSourceEvent('mbo-cancel-1', 1_000_000n, 'cancel'),
      ],
    });
    makePacket({
      cwd: cwdB,
      sourceEvents: [
        mboSourceEvent('mbo-add-1', 0n, 'add', 'order-1', { raw_secret: 'RAW_SHOULD_NOT_APPEAR' }),
        mboSourceEvent('mbo-cancel-1', 1_000_000n, 'cancel'),
      ],
    });

    for (const cwd of [cwdA, cwdB]) {
      const result = await runOrchMbo01ShadowProducer({
        cwd,
        runtime_journal: 'runtime.jsonl',
        mbo_source_journal: 'mbo-source.jsonl',
        out_journal: 'runtime-shadow.jsonl',
        report: 'orch-report.json',
        run_id: 'rel01-live-sim-20260429',
        session_id: '2026-04-29-rth',
        window_event_count: 2,
        emit_every: 2,
      });
      expect(result.exit_code).toBe(0);
    }

    expect(readFileSync(join(cwdA, 'runtime-shadow.jsonl'), 'utf8')).toBe(
      readFileSync(join(cwdB, 'runtime-shadow.jsonl'), 'utf8'),
    );
    expect(readFileSync(join(cwdA, 'orch-report.json'), 'utf8')).toBe(
      readFileSync(join(cwdB, 'orch-report.json'), 'utf8'),
    );
    expect(readFileSync(join(cwdA, 'orch-report.json'), 'utf8')).not.toContain('RAW_SHOULD_NOT_APPEAR');
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/orch/orch-mbo-01-shadow-producer.ts', 'utf8');
    expect(source).not.toMatch(/\bDate\.now\b/u);
    expect(source).not.toMatch(/\bnew Date\b/u);
    expect(source).not.toMatch(/\bMath\.random\b/u);
  });

  it('wires the npm script', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['orch:mbo:01:shadow-producer']).toBe(
      'tsx scripts/orch/orch-mbo-01-shadow-producer.ts',
    );
  });
});
