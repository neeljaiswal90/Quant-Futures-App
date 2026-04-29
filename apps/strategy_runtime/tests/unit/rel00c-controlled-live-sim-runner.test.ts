import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runRel00ControlledLiveSimReadiness,
} from '../../../../scripts/rel/rel-00-controlled-live-sim-readiness.js';
import {
  assertRel00cWritableEventType,
  runRel00cControlledLiveSim,
} from '../../../../scripts/rel/rel-00c-run-controlled-live-sim.js';
import {
  createJournalEventEnvelope,
  makeEventId,
  makeFeatureSnapshotId,
  makeRunId,
  makeSessionId,
  stableJsonStringify,
} from '../../src/contracts/index.js';

const TEMP_ROOTS: string[] = [];
const RUN_ID = 'rel00c-test-run';
const SESSION_ID = '2026-04-29-rth';
const BASE_TS_NS = 1_777_478_060_000_000_000n;

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('REL-00C controlled live-sim runtime journal generator', () => {
  it('generates a non-empty runtime journal that passes the REL-00 validator', async () => {
    const root = makeSourceRoot();

    const generated = await runRel00c(root, { max_feature_snapshots: 8 });

    expect(generated.exit_code).toBe(0);
    expect(generated.report.status).toBe('generated');
    expect(generated.report.source_events_consumed).toBeGreaterThanOrEqual(20);
    expect(generated.report.feature_snapshots_generated).toBe(8);
    expect(generated.report.real_order_event_types_emitted).toBe(0);
    expect(generated.report.blocked_feature_fields_used).toEqual([]);
    expect(generated.report.restricted_feature_fields_used).toEqual([]);
    expect(generated.report.execution_adapter).toBe('simulated');
    expect(readFileSync(join(root, 'journals/runtime.jsonl'), 'utf8').trim()).not.toBe('');

    const validation = await runRel00ControlledLiveSimReadiness({
      cwd: process.cwd(),
      journal: join(root, 'journals/runtime.jsonl'),
      out_json: join(root, 'reports/rel00_report.json'),
      out_md: join(root, 'reports/rel00_report.md'),
      validation_dir: join(root, 'reports/rel00-validation'),
      min_source_events: 20,
    });

    expect(validation.exit_code).toBe(0);
    expect(validation.report.status).toBe('pass');
    expect(validation.report.execution_safety_checks.status).toBe('pass');
    expect(validation.report.feature_surface_checks.status).toBe('pass');
    expect(validation.report.traceability_checks.status).toBe('pass');
  });

  it('emits no real-order event types and keeps simulated fills on authoritative inputs', async () => {
    const root = makeSourceRoot();

    const generated = await runRel00c(root, { max_feature_snapshots: 12 });
    const lines = readFileSync(join(root, 'journals/runtime.jsonl'), 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== '');
    const events = lines.map((line) => JSON.parse(line) as { readonly type: string; readonly payload?: Record<string, unknown> });

    expect(generated.report.real_order_event_types_emitted).toBe(0);
    expect(events.some((event) => event.type === 'ORDER_PLANT' || event.type === 'LIVE_ORDER')).toBe(false);
    expect(events.filter((event) => event.type === 'SIM_FILL').every((event) => event.payload?.input_tier !== 'blocked')).toBe(true);
  });

  it('refuses to write blocked real-order event types', () => {
    expect(() => assertRel00cWritableEventType('ORDER_PLANT')).toThrow(
      'REL-00C refused to write blocked real-order event type: ORDER_PLANT',
    );
    expect(() => assertRel00cWritableEventType('SIM_FILL')).not.toThrow();
  });

  it('keeps traceability for every emitted order intent', async () => {
    const root = makeSourceRoot();

    await runRel00c(root, { max_feature_snapshots: 12 });
    const events = readFileSync(join(root, 'journals/runtime.jsonl'), 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { readonly type: string; readonly payload: Record<string, string> });
    const intents = new Set(events
      .filter((event) => event.type === 'ORDER_INTENT')
      .map((event) => event.payload.order_intent_id));
    const terminals = new Set(events
      .filter((event) => event.type === 'SIM_FILL' || event.type === 'EXEC_REJECT')
      .map((event) => event.payload.order_intent_id));

    for (const intent of intents) {
      expect(terminals.has(intent)).toBe(true);
    }
  });

  it('is deterministic across two runs with the same inputs', async () => {
    const root = makeSourceRoot();

    const first = await runRel00c(root, {
      out_journal: join(root, 'journals/runtime-a.jsonl'),
      report: join(root, 'reports/report-a.json'),
      max_feature_snapshots: 8,
    });
    const second = await runRel00c(root, {
      out_journal: join(root, 'journals/runtime-b.jsonl'),
      report: join(root, 'reports/report-b.json'),
      max_feature_snapshots: 8,
    });

    expect(readFileSync(join(root, 'journals/runtime-b.jsonl'), 'utf8')).toBe(
      readFileSync(join(root, 'journals/runtime-a.jsonl'), 'utf8'),
    );
    expect({
      ...second.report,
      output: { ...second.report.output, out_journal: first.report.output.out_journal, report: first.report.output.report },
      rel00_validation_command: first.report.rel00_validation_command,
    }).toEqual(first.report);
  });

  it('fails cleanly when a source journal is missing', async () => {
    const root = makeSourceRoot();

    const result = await runRel00c(root, {
      l1_trade_journal: join(root, 'missing.jsonl'),
    });

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('requires_source_journals');
    expect(result.report.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('l1_trade_journal:')]),
    );
  });

  it('fails cleanly when a source journal is malformed', async () => {
    const root = makeSourceRoot();
    writeFileSync(join(root, 'source/l1.jsonl'), '{not json}\n', 'utf8');

    const result = await runRel00c(root);

    expect(result.exit_code).toBe(3);
    expect(result.report.status).toBe('failed');
    expect(result.report.reasons[0]).toContain('malformed L1/trade source journal');
  });

  it('does not embed raw market-data payload values in the generation report', async () => {
    const root = makeSourceRoot({ tradeId: 'RAW_SHOULD_NOT_APPEAR' });

    await runRel00c(root, { max_feature_snapshots: 4 });
    const reportText = readFileSync(join(root, 'reports/report.json'), 'utf8');

    expect(reportText).not.toContain('RAW_SHOULD_NOT_APPEAR');
    expect(reportText).not.toContain('100.25');
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/rel/rel-00c-run-controlled-live-sim.ts', 'utf8');

    expect(source).not.toMatch(/\bDate\.now\b/u);
    expect(source).not.toMatch(/\bnew Date\b/u);
    expect(source).not.toMatch(/\bMath\.random\b/u);
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string>>;

    expect(packageJson.scripts['rel:00c:run-controlled-live-sim']).toBe(
      'tsx scripts/rel/rel-00c-run-controlled-live-sim.ts',
    );
  });
});

function makeSourceRoot(input: { readonly tradeId?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'qfa-rel00c-'));
  TEMP_ROOTS.push(root);
  mkdirSync(join(root, 'source'), { recursive: true });
  writeFileSync(join(root, 'source/l1.jsonl'), buildL1TradeJournal(input.tradeId), 'utf8');
  writeFileSync(join(root, 'source/mbp10.jsonl'), buildMbp10Journal(), 'utf8');
  return root;
}

async function runRel00c(
  root: string,
  overrides: Partial<Parameters<typeof runRel00cControlledLiveSim>[0]> = {},
): Promise<Awaited<ReturnType<typeof runRel00cControlledLiveSim>>> {
  return runRel00cControlledLiveSim({
    cwd: process.cwd(),
    l1_trade_journal: join(root, 'source/l1.jsonl'),
    mbp10_price_state_journal: join(root, 'source/mbp10.jsonl'),
    out_journal: join(root, 'journals/runtime.jsonl'),
    report: join(root, 'reports/report.json'),
    run_id: RUN_ID,
    session_id: SESSION_ID,
    ...overrides,
  });
}

function buildL1TradeJournal(tradeId = 'trade-fixture'): string {
  const lines: string[] = [];
  for (let index = 0; index < 14; index += 1) {
    const ts = BASE_TS_NS + BigInt(index) * 1_000_000_000n;
    const bid = 100 + index * 0.25;
    lines.push(jsonLine(createJournalEventEnvelope({
      event_id: makeEventId(`quote-${index}`),
      type: 'QUOTE',
      ts_ns: ts,
      run_id: makeRunId(RUN_ID),
      session_id: makeSessionId(SESSION_ID),
      payload: {
        exchange_event_ts_ns: ts,
        sidecar_recv_ts_ns: ts + 10n,
        bid_px: bid,
        bid_qty: 5,
        ask_px: bid + 0.25,
        ask_qty: 6,
        authority: 'authoritative',
      },
    })));
    lines.push(jsonLine(createJournalEventEnvelope({
      event_id: makeEventId(`trade-${index}`),
      type: 'TRADE',
      ts_ns: ts + 1n,
      run_id: makeRunId(RUN_ID),
      session_id: makeSessionId(SESSION_ID),
      payload: {
        exchange_event_ts_ns: ts + 1n,
        sidecar_recv_ts_ns: ts + 11n,
        trade_id: `${tradeId}-${index}`,
        price: bid + 0.25,
        quantity: 1,
        aggressor_side: 'buy',
      },
    })));
  }
  return `${lines.join('\n')}\n`;
}

function buildMbp10Journal(): string {
  const ts = BASE_TS_NS;
  return jsonLine(createJournalEventEnvelope({
    event_id: makeEventId('mbp10-0'),
    type: 'MICROSTRUCTURE',
    ts_ns: ts,
    run_id: makeRunId(RUN_ID),
    session_id: makeSessionId(SESSION_ID),
    payload: {
      exchange_event_ts_ns: ts,
      sidecar_recv_ts_ns: ts + 12n,
      feature_snapshot_id: makeFeatureSnapshotId('mbp10-fixture'),
      l3_authority: 'unavailable',
      values: {
        mbp10_top_bid_px: 100,
        mbp10_top_ask_px: 100.25,
      },
    },
  }));
}

function jsonLine(value: unknown): string {
  return stableJsonStringify(toSerializableJson(value));
}

function toSerializableJson(value: unknown): ReturnType<typeof JSON.parse> {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (
    typeof item === 'bigint' ? item.toString() : item
  )));
}
