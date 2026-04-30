import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ns } from '../../src/contracts/index.js';
import {
  TUI_PANEL_IDS,
  TUI_PANEL_DEFINITIONS,
  buildTuiDashboardSnapshot,
  parseTuiArgs,
  renderTuiJsonl,
  renderTuiJsonlLines,
} from '../../src/operator/tui.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(TEST_DIR, '..', 'fixtures', 'obs00');
const JOURNAL_PATH = join(FIXTURE_DIR, 'mini-journal.jsonl');
const MANIFEST_PATH = join(FIXTURE_DIR, 'manifest.json');

interface Obs00Manifest {
  readonly event_count: number;
  readonly last_event_ts_ns: string;
}

function readFixtureJournal(): string {
  return readFileSync(JOURNAL_PATH, 'utf8').replace(/\r\n/g, '\n');
}

function readManifest(): Obs00Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Obs00Manifest;
}

function firstFixtureLines(count: number): string {
  return `${readFixtureJournal().trimEnd().split('\n').slice(0, count).join('\n')}\n`;
}

describe('TUI-03 read-only operator dashboard', () => {
  it('renders all eight operator panels from the OBS-00 fixture with color enabled by default', () => {
    const result = renderTuiJsonl(readFixtureJournal(), parseTuiArgs([]));

    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.events_seen).toBe(readManifest().event_count);
    expect(result.snapshot.tui_events_seen).toBe(readManifest().event_count - 1);
    expect(result.snapshot.panels.map((panel) => panel.id)).toEqual(TUI_PANEL_IDS);
    expect(result.stdout).toContain('\u001b[');
    expect(result.stdout).toContain('Quant Futures Operator TUI');
    expect(result.stdout).toContain('mode=read_only');
    expect(result.stdout).toContain('[CONNECTION] Connection status=WARMUP');
    expect(result.stdout).toContain('[SESSION] Session status=WARMUP');
    expect(result.stdout).toContain('[MARKET] Market status=ACTIVE');
    expect(result.stdout).toContain('[INDICATORS] Indicators status=ACTIVE');
    expect(result.stdout).toContain('[STRUCTURE] Structure status=ACTIVE');
    expect(result.stdout).toContain('[MICROSTRUCTURE] Microstructure status=ACTIVE');
    expect(result.stdout).toContain('[STRATEGY_GATES] Strategy Gates status=ACTIVE');
    expect(result.stdout).toContain('[POSITION] Position status=ACTIVE');
    expect(result.stdout).toContain('candidate=candidate-obs00-1');
    expect(result.stdout).toContain('fill=fill-obs00-1');
    expect(result.stdout).toContain('position=position-obs00-1');
    expect(result.stdout).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.stdout).not.toContain('keybinding');
    expect(result.stdout).not.toContain('flatten');
  });

  it('renders byte-stable no-color output from the fixture', () => {
    const options = parseTuiArgs(['--no-color']);
    const first = renderTuiJsonl(readFixtureJournal(), options);
    const second = renderTuiJsonl(readFixtureJournal(), options);

    expect(first.exit_code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).not.toContain('\u001b[');
    expect(first.stdout).toContain('feed=live stream=ALL');
    expect(first.stdout).toContain('risk=pass sizing_qty=1 risk_usd=12');
    expect(first.stdout).toContain('mutation_controls=disabled facts=authoritative recomputation=false');
  });

  it('renders the same dashboard from line input without requiring one giant journal string', () => {
    const options = parseTuiArgs(['--no-color']);
    const input = readFixtureJournal();
    const stringResult = renderTuiJsonl(input, options);
    const lineResult = renderTuiJsonlLines(input.split(/\n/), options);

    expect(lineResult.exit_code).toBe(0);
    expect(lineResult.events_seen).toBe(stringResult.events_seen);
    expect(lineResult.snapshot).toEqual(stringResult.snapshot);
    expect(lineResult.stdout).toBe(stringResult.stdout);
  });

  it('shows warmup and missing states for early fixture slices without recomputing facts', () => {
    const result = renderTuiJsonl(firstFixtureLines(3), parseTuiArgs(['--no-color']));

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('[CONNECTION] Connection status=WARMUP');
    expect(result.stdout).toContain('feed=warming stream=ALL');
    expect(result.stdout).toContain('[MARKET] Market status=MISSING');
    expect(result.stdout).toContain('l1 bid=--x-- ask=--x--');
    expect(result.stdout).toContain('[POSITION] Position status=MISSING');
  });

  it('dims stale panel data based on event timestamps rather than wall clock', () => {
    const manifest = readManifest();
    const renderAt = ns(BigInt(manifest.last_event_ts_ns) + 300_000_000_000n);
    const result = renderTuiJsonl(readFixtureJournal(), {
      color: true,
      render_at_ts_ns: renderAt,
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('[MARKET] Market status=STALE');
    expect(result.stdout).toContain('[MICROSTRUCTURE] Microstructure status=STALE');
    expect(result.stdout).toContain('\u001b[2m  l1 bid=18500.25x12 ask=18500.5x8\u001b[0m');
  });

  it('renders explicit alert states from journal facts', () => {
    const haltedJournal = readFixtureJournal().replace(
      '"event_id":"halt-1","payload":{"reason":"fixture normal state","state":"resumed"}',
      '"event_id":"halt-1","payload":{"reason":"fixture halt state","state":"halted"}',
    );
    const result = renderTuiJsonl(haltedJournal, parseTuiArgs(['--no-color']));

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('[SESSION] Session status=ALERT');
    expect(result.stdout).toContain('halt=halted reason=fixture halt state');
  });

  it('returns structured diagnostics for invalid JSONL and schema-invalid events', () => {
    const badJournal = [
      '{"event_id":"bad","type":"QUOTE","schema_version":1}',
      '{"not": "closed"',
      '',
    ].join('\n');
    const result = renderTuiJsonl(badJournal, parseTuiArgs(['--no-color']));

    expect(result.exit_code).toBe(1);
    expect(result.events_seen).toBe(0);
    expect(result.stderr).toContain('line 1: journal event schema validation failed');
    expect(result.stderr).toContain('line 2:');
    expect(result.stdout).toContain('[CONNECTION] Connection status=MISSING');
  });

  it('runs the CLI against the committed OBS-00 fixture', () => {
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.cjs');
    const result = spawnSync(
      process.execPath,
      [
        tsxCli,
        'apps/strategy_runtime/src/operator/tui.ts',
        '--fixture',
        'obs00',
        '--no-color',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Quant Futures Operator TUI');
    expect(result.stdout).toContain('[STRATEGY_GATES] Strategy Gates status=ACTIVE');
    expect(result.stdout).toContain('[POSITION] Position status=ACTIVE');
  });

  it('builds snapshots without CONFIG or raw diagnostic channels in the default TUI subscription', () => {
    const snapshot = buildTuiDashboardSnapshot([]);
    const panelChannels = TUI_PANEL_DEFINITIONS.flatMap((panel) => [...panel.channels]);

    expect(snapshot.tui_events_seen).toBe(0);
    expect([...new Set(panelChannels)]).toEqual([
      'CONNECTION',
      'SESSION',
      'MARKET',
      'INDICATORS',
      'STRUCTURE',
      'MICROSTRUCTURE',
      'STRATEGY_GATES',
      'CANDIDATES',
      'ORDERS',
      'POSITION',
    ]);
    expect(panelChannels).not.toContain('CONFIG');
    expect(panelChannels).not.toContain('QUOTE_RAW');
    expect(TUI_PANEL_IDS).toEqual([
      'CONNECTION',
      'SESSION',
      'MARKET',
      'INDICATORS',
      'STRUCTURE',
      'MICROSTRUCTURE',
      'STRATEGY_GATES',
      'POSITION',
    ]);
  });

  it('accepts --render-at as an explicit replay-scrub alias for --at', () => {
    const options = parseTuiArgs(['--render-at', readManifest().last_event_ts_ns, '--no-color']);
    const result = renderTuiJsonl(readFixtureJournal(), options);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain(`render_at=${readManifest().last_event_ts_ns}`);
  });
});
