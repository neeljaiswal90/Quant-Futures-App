import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runRel00ControlledLiveSimReadiness,
} from '../../../../scripts/rel/rel-00-controlled-live-sim-readiness.js';
import {
  runRel01aAggregateValidator,
} from '../../../../scripts/rel/rel-01a-aggregate-validator.js';

const FIXTURE_JOURNAL = 'apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl';
const CONFIG_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEMP_ROOTS: string[] = [];

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('REL-01A aggregate controlled live-sim validator', () => {
  it('returns incomplete for one valid passing REL-00 session', async () => {
    const root = await makePacketRoot({ sessionCount: 1 });

    const result = await runRel01(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('incomplete');
    expect(result.report.manifest.session_count).toBe(1);
    expect(result.report.aggregate_counts.passing_rel00_rerun_sessions).toBe(1);
    expect(result.report.reasons).toEqual([]);
    expect(result.report.next_blocker).toContain('9 more distinct passing RTH session');
  });

  it('passes when 10 distinct sessions pass REL-00 and SIM-03D', async () => {
    const root = await makePacketRoot({ sessionCount: 10 });

    const result = await runRel01(root);

    expect(result.exit_code).toBe(0);
    expect(result.report.status).toBe('pass');
    expect(result.report.sim03_readiness.ready_for_rel01_execution_simulation).toBe(true);
    expect(result.report.aggregate_counts.passing_prior_rel00_sessions).toBe(10);
    expect(result.report.aggregate_counts.passing_rel00_rerun_sessions).toBe(10);
    expect(result.report.aggregate_counts.blocked_feature_fields).toEqual([]);
    expect(result.report.aggregate_counts.restricted_feature_fields).toEqual([]);
    expect(result.report.provenance_spot_checks.passed).toBe(3);
  });

  it('fails duplicate session IDs', async () => {
    const root = await makePacketRoot({ sessionCount: 2, duplicateSessionId: true });

    const result = await runRel01(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.check_groups.packet_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'session_ids_unique', status: 'fail' }),
      ]),
    );
  });

  it('fails when a referenced journal file is missing', async () => {
    const root = await makePacketRoot({ sessionCount: 1, missingJournalSession: 1 });

    const result = await runRel01(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.sessions[0]?.file_existence.journal).toBe(false);
    expect(result.report.check_groups.packet_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'all_referenced_files_exist', status: 'fail' }),
      ]),
    );
  });

  it('fails blocked feature usage through REL-01A', async () => {
    const root = await makePacketRoot({ sessionCount: 1, blockedFeatureSession: 1 });

    const result = await runRel01(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.aggregate_counts.blocked_feature_fields).toContain('queue_position');
    expect(result.report.check_groups.feature_surface_checks.status).toBe('fail');
  });

  it('fails real order event leakage', async () => {
    const root = await makePacketRoot({ sessionCount: 1, realOrderSession: 1 });

    const result = await runRel01(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.aggregate_counts.real_order_event_types).toBeGreaterThan(0);
    expect(result.report.check_groups.execution_safety_checks.status).toBe('fail');
  });

  it('fails unstable config hashes between manifest and session journal', async () => {
    const root = await makePacketRoot({ sessionCount: 1, unstableConfigHashSession: 1 });

    const result = await runRel01(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.sessions[0]?.reasons).toContain('journal_config_hash_missing_or_unstable');
    expect(result.report.check_groups.packet_checks.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'journal_config_hashes_match_manifest', status: 'fail' }),
      ]),
    );
  });

  it('fails malformed journal JSONL cleanly', async () => {
    const root = await makePacketRoot({ sessionCount: 1, malformedJournalSession: 1 });

    const result = await runRel01(root);

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.sessions[0]?.parse_error_count).toBeGreaterThan(0);
    expect(result.report.check_groups.obs_evt_checks.status).toBe('fail');
  });

  it('writes deterministic reports and does not embed raw payload values', async () => {
    const root = await makePacketRoot({ sessionCount: 1, rawSentinel: true });

    const first = await runRel01(root);
    const firstJson = readFileSync(join(root, 'reports/rel/rel01_aggregate_report.json'), 'utf8');
    const second = await runRel01(root);

    expect(second.report).toEqual(first.report);
    expect(readFileSync(join(root, 'reports/rel/rel01_aggregate_report.json'), 'utf8')).toBe(firstJson);
    expect(firstJson).not.toContain('RAW_SHOULD_NOT_APPEAR');
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/rel/rel-01a-aggregate-validator.ts', 'utf8');

    expect(source).not.toMatch(/\bDate\.now\b/u);
    expect(source).not.toMatch(/\bnew Date\b/u);
    expect(source).not.toMatch(/\bMath\.random\b/u);
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string>>;

    expect(packageJson.scripts['rel:01a:aggregate']).toBe(
      'tsx scripts/rel/rel-01a-aggregate-validator.ts',
    );
  });
});

async function runRel01(root: string): Promise<Awaited<ReturnType<typeof runRel01aAggregateValidator>>> {
  return runRel01aAggregateValidator({
    cwd: root,
    manifest: 'reports/rel/rel01_manifest.json',
    out_json: 'reports/rel/rel01_aggregate_report.json',
    out_md: 'reports/rel/rel01_aggregate_report.md',
    work_dir: 'reports/rel/rel01a_validation',
    min_source_events: 1,
    provenance_spot_checks: 3,
  });
}

async function makePacketRoot(input: {
  readonly sessionCount?: number;
  readonly sim03Ready?: boolean;
  readonly duplicateSessionId?: boolean;
  readonly mutateFirstJournalAfterRel00?: boolean;
  readonly missingJournalSession?: number;
  readonly blockedFeatureSession?: number;
  readonly realOrderSession?: number;
  readonly unstableConfigHashSession?: number;
  readonly malformedJournalSession?: number;
  readonly rawSentinel?: boolean;
} = {}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'qfa-rel01a-'));
  TEMP_ROOTS.push(root);
  const sessionCount = input.sessionCount ?? 1;
  writeJson(root, 'reports/sim/fill_slippage_calibration_robust_limit_queue_front.json', {
    status: input.sim03Ready ?? true ? 'pass' : 'fail',
  });
  writeJson(root, 'reports/sim/fill_slippage_calibration_robust_limit_queue_front_gate.json', sim03Gate(input.sim03Ready ?? true));
  const sessions = [];
  for (let index = 0; index < sessionCount; index += 1) {
    const oneBased = index + 1;
    const date = `2026-04-${String(oneBased).padStart(2, '0')}`;
    const sessionId = input.duplicateSessionId === true ? '2026-04-01-rth' : `${date}-rth`;
    const runId = `rel01-live-sim-${date.replace(/-/gu, '')}`;
    const sessionDir = `reports/rel/session${String(oneBased).padStart(2, '0')}`;
    const journalPath = `${sessionDir}/runtime.jsonl`;
    if (input.missingJournalSession !== oneBased) {
      writeText(root, journalPath, buildJournal({
        sessionId,
        runId,
        blockedFeature: input.blockedFeatureSession === oneBased,
        realOrder: input.realOrderSession === oneBased,
        configHash: input.unstableConfigHashSession === oneBased ? sha('different-config') : CONFIG_HASH,
        malformed: input.malformedJournalSession === oneBased,
        rawSentinel: input.rawSentinel === true && oneBased === 1,
      }));
      await runRel00ControlledLiveSimReadiness({
        cwd: root,
        journal: journalPath,
        out_json: `${sessionDir}/rel00.json`,
        out_md: `${sessionDir}/rel00.md`,
        validation_dir: `${sessionDir}/rel00_transport`,
        min_source_events: 1,
      });
      if (input.mutateFirstJournalAfterRel00 === true && oneBased === 1) {
        writeText(root, journalPath, `${readFileSync(join(root, journalPath), 'utf8')}\n`);
      }
      writeRel00cReport(root, `${sessionDir}/rel00c.json`, journalPath);
    } else {
      writeJson(root, `${sessionDir}/rel00.json`, {
        status: 'pass',
        input: { journal_sha256: sha('missing-placeholder') },
      });
      writeJson(root, `${sessionDir}/rel00c.json`, {
        status: 'generated',
        output: { out_journal_hash: sha('missing-placeholder') },
      });
    }
    sessions.push({
      session_id: sessionId,
      run_id: runId,
      journal: journalPath,
      rel00_report: `${sessionDir}/rel00.json`,
      rel00c_report: `${sessionDir}/rel00c.json`,
    });
  }
  writeJson(root, 'reports/rel/rel01_manifest.json', {
    schema_version: 1,
    rel01_run_id: 'rel01-fixture-run',
    runtime_commit: 'fixture-commit',
    config_hash: CONFIG_HASH,
    strategy_config_hash: sha('strategy-config'),
    risk_config_hash: sha('risk-config'),
    management_config_hash: sha('management-config'),
    sim03_report: 'reports/sim/fill_slippage_calibration_robust_limit_queue_front.json',
    sim03_gate: 'reports/sim/fill_slippage_calibration_robust_limit_queue_front_gate.json',
    sessions,
  });
  return root;
}

function buildJournal(input: {
  readonly sessionId: string;
  readonly runId: string;
  readonly configHash: string;
  readonly blockedFeature?: boolean;
  readonly realOrder?: boolean;
  readonly malformed?: boolean;
  readonly rawSentinel?: boolean;
}): string {
  const lines = readFileSync(FIXTURE_JOURNAL, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      event.session_id = input.sessionId;
      event.run_id = input.runId;
      if (event.type === 'CONFIG') {
        const payload = jsonObject(event.payload);
        event.payload = {
          ...payload,
          config_hash: input.configHash,
        };
      }
      if (event.type === 'FEATURES') {
        const payload = jsonObject(event.payload);
        event.payload = {
          ...payload,
          values: {
            l1_quote_bid_px: 18500.25,
            l1_quote_ask_px: 18500.5,
            last_trade_price: 18500.5,
            last_trade_size: 1,
            last_trade_aggressor_side: 'buy',
            trade_aggressor_imbalance: 0.5,
            ...(input.blockedFeature === true ? { queue_position: 7 } : {}),
            ...(input.rawSentinel === true ? { raw_sentinel_field: 'RAW_SHOULD_NOT_APPEAR' } : {}),
          },
        };
      }
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
      return JSON.stringify(event);
    });
  if (input.realOrder === true) {
    lines.push(JSON.stringify({
      event_id: 'real-order-1',
      payload: { broker_order_id: 'RAW_SHOULD_NOT_APPEAR' },
      run_id: input.runId,
      schema_version: 1,
      session_id: input.sessionId,
      ts_ns: '1700000000062000000',
      type: 'ORDER_PLANT',
    }));
  }
  if (input.malformed === true) {
    lines.push('{malformed-json');
  }
  return lines.join('\n').concat('\n');
}

function writeRel00cReport(root: string, path: string, journalPath: string): void {
  writeJson(root, path, {
    status: 'generated',
    output: {
      out_journal_hash: shaFile(join(root, journalPath)),
    },
  });
}

function sim03Gate(ready: boolean): Record<string, unknown> {
  return {
    calibration_gate_report_schema_version: 1,
    ticket_id: 'SIM-03D',
    status: ready ? 'pass' : 'fail',
    ready_for_rel01_execution_simulation: ready,
    source_report_hash: sha('source'),
    failure_reasons: ready ? [] : ['gate:source_ready_for_rel01_execution_simulation'],
  };
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

function writeJson(root: string, path: string, value: unknown): void {
  writeText(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shaFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
