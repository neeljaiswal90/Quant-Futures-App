import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  journalEventToJsonLine,
  makeCausationId,
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  type JsonValue,
} from '../../src/contracts/index.js';
import {
  formatJournalJsonl,
  parseFormatterArgs,
} from '../../src/operator/formatter.js';

const RUN_ID = makeRunId('run-tui-02');
const SESSION_ID = makeSessionId('2026-04-23-rth');
const TS_1 = 1_700_000_000_000_000_000n;
const TS_2 = TS_1 + 1_000_000n;
const TS_3 = TS_2 + 1_000_000n;

function quoteLine(): string {
  return journalEventToJsonLine(
    createJournalEventEnvelope({
      event_id: makeEventId('quote-1'),
      type: 'QUOTE',
      ts_ns: ns(TS_1),
      run_id: RUN_ID,
      session_id: SESSION_ID,
      payload: {
        exchange_event_ts_ns: ns(TS_1),
        sidecar_recv_ts_ns: ns(TS_1 + 500_000n),
        bid_px: 18500.25,
        bid_qty: 12,
        ask_px: 18500.5,
        ask_qty: 8,
        authority: 'authoritative',
      } satisfies JsonValue,
    }),
  );
}

function strategyEvalLine(): string {
  return journalEventToJsonLine(
    createJournalEventEnvelope({
      event_id: makeEventId('strat-1'),
      type: 'STRAT_EVAL',
      ts_ns: ns(TS_1),
      run_id: RUN_ID,
      session_id: SESSION_ID,
      causation_id: makeCausationId('quote-1'),
      payload: {
        strategy_evaluation_id: 'strat-eval-1',
        strategy_id: 'trend_pullback_long',
        feature_snapshot_id: 'feature-1',
        gate_state: 'armed',
        score: 0.72,
        reasons: ['trend_ok', 'pullback_ok'],
      } satisfies JsonValue,
    }),
  );
}

function candidateLine(): string {
  return journalEventToJsonLine(
    createJournalEventEnvelope({
      event_id: makeEventId('candidate-1'),
      type: 'CANDIDATE',
      ts_ns: ns(TS_2),
      run_id: RUN_ID,
      session_id: SESSION_ID,
      causation_id: makeCausationId('strat-1'),
      payload: {
        candidate_id: 'candidate-1',
        strategy_id: 'trend_pullback_long',
        feature_snapshot_id: 'feature-1',
        direction: 'long',
        status: 'proposed',
        entry_price: 18501,
        stop_price: 18495,
        targets: [{ label: 'pt1', price: 18508, quantity_fraction: 0.5 }],
        confidence: 0.68,
        reasons: ['fixture'],
      } satisfies JsonValue,
    }),
  );
}

function fillLine(): string {
  return journalEventToJsonLine(
    createJournalEventEnvelope({
      event_id: makeEventId('fill-1'),
      type: 'SIM_FILL',
      ts_ns: ns(TS_3),
      run_id: RUN_ID,
      session_id: SESSION_ID,
      causation_id: makeCausationId('order-1'),
      payload: {
        fill_id: 'fill-1',
        order_intent_id: 'order-1',
        side: 'buy',
        quantity: 1,
        price: 18501.25,
        liquidity: 'taker',
        slippage_points: 0.25,
      } satisfies JsonValue,
    }),
  );
}

function inputJournal(): string {
  return `${quoteLine()}${strategyEvalLine()}${candidateLine()}${fillLine()}`;
}

describe('TUI-02 structured log formatter', () => {
  it('renders OBS-01 JSONL as deterministic human-readable text with no color by default', () => {
    const result = formatJournalJsonl(inputJournal());

    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.events_seen).toBe(4);
    expect(result.events_rendered).toBe(4);
    expect(result.stdout).toBe(
      [
        '1700000000000000000 QUOTE [MARKET] run=run-tui-02 session=2026-04-23-rth event=quote-1 bid=18500.25x12 ask=18500.5x8 authority=authoritative',
        '1700000000000000000 STRAT_EVAL [STRATEGY_GATES] run=run-tui-02 session=2026-04-23-rth event=strat-1 cause=quote-1 strategy=trend_pullback_long eval=strat-eval-1 gate=armed score=0.72 reasons=trend_ok|pullback_ok',
        '1700000000001000000 CANDIDATE [CANDIDATES] run=run-tui-02 session=2026-04-23-rth event=candidate-1 cause=strat-1 candidate=candidate-1 strategy=trend_pullback_long dir=long status=proposed entry=18501 stop=18495 conf=0.68',
        '1700000000002000000 SIM_FILL [ORDERS] run=run-tui-02 session=2026-04-23-rth event=fill-1 cause=order-1 fill=fill-1 order=order-1 side=buy qty=1 px=18501.25 liq=taker',
        '',
      ].join('\n'),
    );
    expect(result.stdout).not.toContain('\u001b[');
  });

  it('supports type, grep, strategy, and since filters', () => {
    expect(
      formatJournalJsonl(inputJournal(), parseFormatterArgs(['--only', 'type=CANDIDATE'])).stdout,
    ).toContain(' CANDIDATE ');
    expect(
      formatJournalJsonl(inputJournal(), parseFormatterArgs(['--only', 'type=CANDIDATE'])).stdout,
    ).not.toContain(' QUOTE ');

    expect(formatJournalJsonl(inputJournal(), parseFormatterArgs(['--grep', 'fill-1'])).stdout).toBe(
      '1700000000002000000 SIM_FILL [ORDERS] run=run-tui-02 session=2026-04-23-rth event=fill-1 cause=order-1 fill=fill-1 order=order-1 side=buy qty=1 px=18501.25 liq=taker\n',
    );

    const strategyFiltered = formatJournalJsonl(
      inputJournal(),
      parseFormatterArgs(['--strategy', 'trend_pullback_long']),
    ).stdout;
    expect(strategyFiltered).toContain('STRAT_EVAL');
    expect(strategyFiltered).toContain('CANDIDATE');
    expect(strategyFiltered).not.toContain('SIM_FILL');

    const sinceFiltered = formatJournalJsonl(
      inputJournal(),
      parseFormatterArgs(['--since', TS_2.toString()]),
    ).stdout;
    expect(sinceFiltered).not.toContain('QUOTE');
    expect(sinceFiltered).toContain('CANDIDATE');
    expect(sinceFiltered).toContain('SIM_FILL');
  });

  it('emits ANSI only when --color is explicitly enabled', () => {
    const plain = formatJournalJsonl(inputJournal(), parseFormatterArgs([])).stdout;
    const color = formatJournalJsonl(inputJournal(), parseFormatterArgs(['--color'])).stdout;

    expect(plain).not.toContain('\u001b[');
    expect(color).toContain('\u001b[');
  });

  it('returns structured diagnostics for invalid JSONL or schema failures', () => {
    const invalidSchema = journalEventToJsonLine(
      createJournalEventEnvelope({
        event_id: makeEventId('quote-bad'),
        type: 'QUOTE',
        ts_ns: ns(TS_1),
        run_id: RUN_ID,
        session_id: SESSION_ID,
        payload: {
          exchange_event_ts_ns: ns(TS_1),
          sidecar_recv_ts_ns: ns(TS_1 + 500_000n),
          bid_px: '18500.25',
          bid_qty: 12,
          ask_px: 18500.5,
          ask_qty: 8,
        } satisfies JsonValue,
      }),
    );

    const result = formatJournalJsonl(`${invalidSchema}{"not": "closed"\n`);

    expect(result.exit_code).toBe(1);
    expect(result.events_seen).toBe(0);
    expect(result.diagnostics).toEqual([
      {
        line_number: 1,
        message:
          'journal event schema validation failed: $.payload.bid_px must be a finite number',
      },
      {
        line_number: 2,
        message: expect.stringContaining('Expected') as unknown as string,
      },
    ]);
    expect(result.stderr).toContain('line 1: journal event schema validation failed');
    expect(result.stderr).toContain('line 2:');
  });

  it('is pipeable through the CLI entrypoint', () => {
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.cjs');
    const result = spawnSync(
      process.execPath,
      [tsxCli, 'apps/strategy_runtime/src/operator/formatter.ts', '--only', 'type=QUOTE'],
      {
        cwd: process.cwd(),
        input: inputJournal(),
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      '1700000000000000000 QUOTE [MARKET] run=run-tui-02 session=2026-04-23-rth event=quote-1 bid=18500.25x12 ask=18500.5x8 authority=authoritative\n',
    );
  });
});
