import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runRel01bDailySessionWrapper,
  type Rel01bCommand,
  type Rel01bCommandRunner,
  type Rel01bManifest,
} from '../../../../scripts/rel/rel-01b-daily-session-wrapper.js';

const CONFIG_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEMP_ROOTS: string[] = [];
const RAW_SENTINEL = 'RAW_SHOULD_NOT_APPEAR';

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('REL-01B daily controlled live-sim wrapper', () => {
  it('runs the daily command chain and appends one passing session to the manifest', async () => {
    const root = makeRoot();
    writeManifest(root);
    const commands: Rel01bCommand[] = [];

    const result = await runRel01bDailySessionWrapper({
      cwd: root,
      trade_date: '2026-04-30',
      manifest: 'reports/rel/rel01_manifest.json',
    }, fakeRunner(root, commands));

    expect(result.exit_code).toBe(0);
    expect(result.report.status).toBe('session_appended');
    expect(result.report.manifest.appended).toBe(true);
    expect(result.report.checks.raw_probe_trade_date_matches).toBe(true);
    expect(result.report.raw_probe_audit.timestamped_rows_checked).toBeGreaterThan(0);
    expect(result.report.counts.rel00c_order_intents_emitted).toBe(3);
    expect(result.report.command_log.map((command) => command.name)).toEqual([
      'capture_rithmic_probe',
      'normalize_data01a_l1_trade',
      'normalize_data01b_ps_price_state',
      'generate_rel00c_runtime_journal',
      'validate_rel00_controlled_live_sim',
    ]);
    const manifest = readManifest(root);
    expect(manifest.sessions).toHaveLength(1);
    expect(existsSync(join(root, 'reports', 'rel', 'rel01_manifest.json.tmp'))).toBe(false);
    expect(manifest.sessions[0]).toEqual({
      session_id: '2026-04-30-rth',
      run_id: 'rel01-live-sim-20260430',
      journal: 'reports/rel/rel01_20260430/rel00_controlled_live_sim_journal.jsonl',
      rel00_report: 'reports/rel/rel01_20260430/rel00_controlled_live_sim_report.json',
      rel00c_report: 'reports/rel/rel01_20260430/rel00c_controlled_live_sim_generation_report.json',
    });
  });

  it('refuses duplicate sessions before running capture or normalization commands', async () => {
    const root = makeRoot();
    writeManifest(root, [{
      session_id: '2026-04-30-rth',
      run_id: 'rel01-live-sim-20260430',
      journal: 'reports/rel/rel01_20260430/rel00_controlled_live_sim_journal.jsonl',
      rel00_report: 'reports/rel/rel01_20260430/rel00_controlled_live_sim_report.json',
      rel00c_report: 'reports/rel/rel01_20260430/rel00c_controlled_live_sim_generation_report.json',
    }]);
    const commands: Rel01bCommand[] = [];

    const result = await runRel01bDailySessionWrapper({
      cwd: root,
      trade_date: '2026-04-30',
    }, fakeRunner(root, commands));

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('duplicate_session');
    expect(result.report.reasons).toEqual(['duplicate_session_id:2026-04-30-rth']);
    expect(commands).toEqual([]);
    expect(readManifest(root).sessions).toHaveLength(1);
  });

  it('does not append a session when REL-00 validation fails', async () => {
    const root = makeRoot();
    writeManifest(root);
    const commands: Rel01bCommand[] = [];

    const result = await runRel01bDailySessionWrapper({
      cwd: root,
      trade_date: '2026-05-01',
    }, fakeRunner(root, commands, { failCommand: 'validate_rel00_controlled_live_sim' }));

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('failed');
    expect(result.report.manifest.appended).toBe(false);
    expect(result.report.reasons).toEqual(['validate_rel00_controlled_live_sim_failed']);
    expect(readManifest(root).sessions).toHaveLength(0);
  });

  it('fails cleanly when the manifest is missing and no seed is provided', async () => {
    const root = makeRoot();
    const commands: Rel01bCommand[] = [];

    const result = await runRel01bDailySessionWrapper({
      cwd: root,
      trade_date: '2026-05-04',
    }, fakeRunner(root, commands));

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('requires_manifest_seed');
    expect(result.report.checks.manifest_seed_available).toBe(false);
    expect(commands).toEqual([]);
  });

  it('can create the manifest when all seed fields are provided', async () => {
    const root = makeRoot();
    const commands: Rel01bCommand[] = [];

    const result = await runRel01bDailySessionWrapper({
      cwd: root,
      trade_date: '2026-05-05',
      manifest_seed: seed(),
    }, fakeRunner(root, commands));

    expect(result.exit_code).toBe(0);
    expect(result.report.status).toBe('session_appended');
    const manifest = readManifest(root);
    expect(manifest.rel01_run_id).toBe('rel01-20260429-to-20260512');
    expect(manifest.sessions).toHaveLength(1);
  });

  it('supports using an existing capture without invoking the Rithmic capture command', async () => {
    const root = makeRoot();
    writeManifest(root);
    const commands: Rel01bCommand[] = [];
    const rawProbe = join(root, 'reports', 'rel', 'existing_probe.jsonl');
    mkdirSync(dirname(rawProbe), { recursive: true });
    writeFileSync(rawProbe, rawProbeFixture('2026-05-06'), 'utf8');

    const result = await runRel01bDailySessionWrapper({
      cwd: root,
      trade_date: '2026-05-06',
      raw_probe: rawProbe,
      skip_capture: true,
    }, fakeRunner(root, commands));

    expect(result.exit_code).toBe(0);
    expect(result.report.command_log[0]).toEqual(expect.objectContaining({
      name: 'capture_rithmic_probe',
      status: 'skipped',
    }));
    expect(result.report.raw_probe_audit.status).toBe('pass');
    expect(commands.map((command) => command.name)).not.toContain('capture_rithmic_probe');
  });

  it('rejects skipped captures whose raw probe timestamps do not match the requested RTH date', async () => {
    const root = makeRoot();
    writeManifest(root);
    const commands: Rel01bCommand[] = [];
    const rawProbe = join(root, 'reports', 'rel', 'wrong_day_probe.jsonl');
    mkdirSync(dirname(rawProbe), { recursive: true });
    writeFileSync(rawProbe, rawProbeFixture('2026-05-05'), 'utf8');

    const result = await runRel01bDailySessionWrapper({
      cwd: root,
      trade_date: '2026-05-06',
      raw_probe: rawProbe,
      skip_capture: true,
    }, fakeRunner(root, commands));

    expect(result.exit_code).toBe(2);
    expect(result.report.status).toBe('failed');
    expect(result.report.raw_probe_audit.status).toBe('fail');
    expect(result.report.raw_probe_audit.failure_reason).toBe('raw_probe_trade_date_mismatch');
    expect(result.report.reasons).toEqual(['raw_probe_trade_date_mismatch:raw_probe_trade_date_mismatch']);
    expect(commands).toEqual([]);
    expect(readManifest(root).sessions).toHaveLength(0);
  });

  it('writes deterministic reports without embedding raw probe contents', async () => {
    const first = await runInFreshRoot();
    const second = await runInFreshRoot();

    expect(first.reportText).toBe(second.reportText);
    expect(first.reportText).not.toContain(RAW_SENTINEL);
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/rel/rel-01b-daily-session-wrapper.ts', 'utf8');

    expect(source).not.toMatch(/\bDate\.now\b/u);
    expect(source).not.toMatch(/\bnew Date\b/u);
    expect(source).not.toMatch(/\bMath\.random\b/u);
  });

  it('wires the npm script', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['rel:01b:daily-session']).toBe(
      'tsx scripts/rel/rel-01b-daily-session-wrapper.ts',
    );
  });
});

async function runInFreshRoot(): Promise<{ readonly reportText: string }> {
  const root = makeRoot();
  writeManifest(root);
  await runRel01bDailySessionWrapper({
    cwd: root,
    trade_date: '2026-05-07',
  }, fakeRunner(root, []));
  const reportPath = join(root, 'reports', 'rel', 'rel01_20260507', 'rel01b_daily_session_report.json');
  return { reportText: readFileSync(reportPath, 'utf8') };
}

function fakeRunner(
  root: string,
  commands: Rel01bCommand[],
  options: { readonly failCommand?: string } = {},
): Rel01bCommandRunner {
  return async (command) => {
    commands.push(command);
    applyFakeSideEffects(root, command, options.failCommand === command.name);
    return { exit_code: options.failCommand === command.name ? 2 : 0 };
  };
}

function applyFakeSideEffects(root: string, command: Rel01bCommand, failing: boolean): void {
  switch (command.name) {
    case 'capture_rithmic_probe': {
      writeText(argAfter(command, '--out'), rawProbeFixture(tradeDateFromRunPath(argAfter(command, '--out'))));
      break;
    }
    case 'normalize_data01a_l1_trade': {
      writeText(argAfter(command, '--out'), '{"type":"QUOTE"}\n');
      writeJson(argAfter(command, '--report'), {
        data01_full_gate_status: 'blocked',
        data01b_status: 'blocked_l2_l3_parity',
        emitted_events: 12,
        emitted_quote_events: 6,
        emitted_trade_events: 6,
        partial_parity_status: 'L1_TRADE_ONLY_PASS',
      });
      break;
    }
    case 'normalize_data01b_ps_price_state': {
      writeText(argAfter(command, '--out'), '{"type":"MICROSTRUCTURE"}\n');
      writeJson(argAfter(command, '--report'), {
        data01b_full_status: 'blocked',
        emitted_events: 10,
        mbo_status: 'accepted_subscope',
        mbp10_price_state_status: 'accepted_subscope',
        size_order_count_status: 'diagnostic_only',
      });
      break;
    }
    case 'generate_rel00c_runtime_journal': {
      const journal = argAfter(command, '--out-journal');
      writeText(journal, '{"type":"SIM_FILL"}\n');
      writeJson(argAfter(command, '--report'), {
        status: 'generated',
        output: {
          out_journal: relativePortable(root, journal),
          out_journal_hash: sha256Text(readFileSync(journal, 'utf8')),
        },
        source_events_consumed: 12,
        feature_snapshots_generated: 11,
        order_intents_emitted: 3,
        sim_fills_emitted: 3,
        exec_rejects_emitted: 0,
        real_order_event_types_emitted: 0,
        blocked_feature_fields_used: [],
        restricted_feature_fields_used: [],
        execution_adapter: 'simulated',
      });
      break;
    }
    case 'validate_rel00_controlled_live_sim': {
      const journal = argAfter(command, '--journal');
      writeJson(argAfter(command, '--out'), {
        status: failing ? 'fail' : 'pass',
        input: {
          journal_path: relativePortable(root, journal),
          journal_sha256: sha256Text(readFileSync(journal, 'utf8')),
        },
        safety_mode: {
          execution_mode: 'simulated_only',
          real_orders_allowed: false,
          accepted_feature_surface_only: true,
          mbo_derived_features_allowed: false,
        },
      });
      writeText(argAfter(command, '--out-md'), '# REL-00\n');
      break;
    }
    default:
      throw new Error(`unexpected fake command ${command.name}`);
  }
}

function argAfter(command: Rel01bCommand, flag: string): string {
  const index = command.args.indexOf(flag);
  if (index < 0 || command.args[index + 1] === undefined) {
    throw new Error(`missing ${flag}`);
  }
  return command.args[index + 1]!;
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rel01b-test-'));
  TEMP_ROOTS.push(root);
  return root;
}

function writeManifest(root: string, sessions: Rel01bManifest['sessions'] = []): void {
  writeJson(join(root, 'reports', 'rel', 'rel01_manifest.json'), {
    ...seed(),
    schema_version: 1,
    sim03_report: 'reports/sim/fill_slippage_calibration_robust_limit_queue_front.json',
    sim03_gate: 'reports/sim/fill_slippage_calibration_robust_limit_queue_front_gate.json',
    rel00b_report: 'reports/rel/rel00b_evidence_index.json',
    sessions,
  });
}

function readManifest(root: string): Rel01bManifest {
  return JSON.parse(readFileSync(join(root, 'reports', 'rel', 'rel01_manifest.json'), 'utf8')) as Rel01bManifest;
}

function seed(): {
  readonly rel01_run_id: string;
  readonly runtime_commit: string;
  readonly config_hash: string;
  readonly strategy_config_hash: string;
  readonly risk_config_hash: string;
  readonly management_config_hash: string;
} {
  return {
    rel01_run_id: 'rel01-20260429-to-20260512',
    runtime_commit: 'abcdef1',
    config_hash: CONFIG_HASH,
    strategy_config_hash: CONFIG_HASH,
    risk_config_hash: CONFIG_HASH,
    management_config_hash: CONFIG_HASH,
  };
}

function rawProbeFixture(tradeDate: string): string {
  const exchangeEventTsNs = BigInt(Date.parse(`${tradeDate}T15:00:00.000Z`)) * 1_000_000n;
  return `${JSON.stringify({
    schema_version: 1,
    stream: 'L1_QUOTE',
    exchange_event_ts_ns: exchangeEventTsNs.toString(),
    timestamp_source: 'ssboe_usecs',
    payload_marker: RAW_SENTINEL,
  })}\n`;
}

function tradeDateFromRunPath(path: string): string {
  const match = /rel01_(\d{4})(\d{2})(\d{2})/u.exec(path);
  if (match === null) {
    throw new Error(`unable to infer trade date from ${path}`);
  }
  return `${match[1]!}-${match[2]!}-${match[3]!}`;
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function relativePortable(root: string, path: string): string {
  return path.slice(root.length + 1).replace(/\\/gu, '/');
}
