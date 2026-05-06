import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import type {
  EquityCurvePoint,
  TradeMetricsSummary,
  TradePnl,
} from '../../../src/equity-metrics/index.js';
import type { TradeLedger } from '../../../src/trade-ledger/index.js';
import {
  canonicalizeReproJson,
  computeReproducibilityManifest,
  writeReproducibilityManifest,
  type ReproducibilityManifestInput,
} from '../../../src/repro-hash/index.js';

const RUN_SPEC_HASH = 'a'.repeat(64);
const TEST_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEST_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('QFA-205 reproducibility manifest', () => {
  it('returns artifacts in the required fixed order', () => {
    const manifest = computeReproducibilityManifest(sampleInput());

    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual([
      'journal_jsonl',
      'trade_ledger',
      'trade_pnl',
      'equity_curve',
      'metrics_summary',
    ]);
    expect(manifest.algorithm).toBe('qfa_repro_chain_sha256_v1');
    expect(manifest.final_chain_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.artifacts.every((artifact) => /^[a-f0-9]{64}$/u.test(artifact.sha256))).toBe(
      true,
    );
  });

  it('is deterministic for identical inputs', () => {
    expect(computeReproducibilityManifest(sampleInput())).toEqual(
      computeReproducibilityManifest(sampleInput()),
    );
  });

  it.each([
    ['journal_jsonl', () => sampleInput({ journal_jsonl: '{"event":2}\n' })],
    ['trade_ledger', () => sampleInput({ trade_ledger: sampleLedger({ price: 101 }) })],
    ['trade_pnl', () => sampleInput({ trade_pnl: sampleTradePnl({ net_pnl_cents: 150n }) })],
    ['equity_curve', () => sampleInput({ equity_curve: sampleEquityCurve({ equity_cents: 1100n }) })],
    ['metrics_summary', () => sampleInput({ metrics_summary: sampleSummary({ net_pnl_cents: 150n }) })],
    ['run_spec_hash', () => sampleInput({ run_spec_hash: 'b'.repeat(64) })],
  ])('changes final_chain_hash when %s changes', (_name, mutate) => {
    expect(computeReproducibilityManifest(mutate()).final_chain_hash).not.toBe(
      computeReproducibilityManifest(sampleInput()).final_chain_hash,
    );
  });

  it('does not include generated_at, created_at, or timestamp fields', () => {
    const manifestJson = JSON.stringify(computeReproducibilityManifest(sampleInput()));

    expect(manifestJson).not.toContain('generated_at');
    expect(manifestJson).not.toContain('created_at');
    expect(manifestJson).not.toContain('timestamp');
  });

  it('does not mutate input artifacts', () => {
    const input = deepFreeze(sampleInput());
    const before = canonicalizeReproJson({
      trade_ledger: input.trade_ledger,
      trade_pnl: input.trade_pnl,
      equity_curve: input.equity_curve,
      metrics_summary: input.metrics_summary,
    });

    computeReproducibilityManifest(input);

    expect(canonicalizeReproJson({
      trade_ledger: input.trade_ledger,
      trade_pnl: input.trade_pnl,
      equity_curve: input.equity_curve,
      metrics_summary: input.metrics_summary,
    })).toBe(before);
  });

  it('writes a deterministic canonical manifest file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qfa-205-'));
    TEST_DIRS.push(dir);
    const path = join(dir, 'repro-manifest.json');
    const manifest = computeReproducibilityManifest(sampleInput());

    await writeReproducibilityManifest(path, manifest);

    expect(readFileSync(path, 'utf8')).toBe(`${canonicalizeReproJson(manifest)}\n`);
  });
});

function sampleInput(
  overrides: Partial<ReproducibilityManifestInput> = {},
): ReproducibilityManifestInput {
  return {
    run_id: 'run-qfa-205',
    run_spec_hash: RUN_SPEC_HASH,
    journal_jsonl: '{"type":"BACKTEST_RUN_META"}\n',
    trade_ledger: sampleLedger(),
    trade_pnl: sampleTradePnl(),
    equity_curve: sampleEquityCurve(),
    metrics_summary: sampleSummary(),
    ...overrides,
  };
}

function sampleLedger(input: { readonly price?: number } = {}): TradeLedger {
  return {
    run_id: 'run-qfa-205',
    executions: [
      {
        execution_id: 'execution-fill-1',
        run_id: 'run-qfa-205',
        event_id: 'fill-event-1',
        ts_ns: ns(1n),
        strategy_id: 'trend_pullback_long',
        instrument_id: 1,
        raw_symbol: 'MNQH6',
        instrument_identity_source: 'ledger_options',
        side: 'buy',
        price: input.price ?? 100,
        quantity: 1,
        exchange_fee_usd: 0.12,
        commission_usd: 0.33,
        source_event_type: 'SIM_FILL',
        source_event_id: 'fill-event-1',
        fill_id: 'fill-1',
        order_intent_id: 'order-1',
      },
    ],
    closed_trades: [],
    open_positions: [],
  };
}

function sampleTradePnl(input: { readonly net_pnl_cents?: bigint } = {}): readonly TradePnl[] {
  return [
    {
      trade_id: 'trade-1',
      run_id: 'run-qfa-205',
      closed_at_ns: ns(2n),
      side: 'long',
      quantity: 1n,
      entry_ticks: 400n,
      exit_ticks: 402n,
      gross_pnl_cents: 100n,
      fees_cents: 12n,
      commissions_cents: 33n,
      net_pnl_cents: input.net_pnl_cents ?? 55n,
    },
  ];
}

function sampleEquityCurve(
  input: { readonly equity_cents?: bigint } = {},
): readonly EquityCurvePoint[] {
  return [
    {
      sequence: 1,
      ts_ns: ns(2n),
      trade_id: 'trade-1',
      realized_pnl_cents: 55n,
      equity_cents: input.equity_cents ?? 1055n,
      peak_equity_cents: input.equity_cents ?? 1055n,
      drawdown_cents: 0n,
    },
  ];
}

function sampleSummary(
  input: { readonly net_pnl_cents?: bigint } = {},
): TradeMetricsSummary {
  return {
    total_trades: 1,
    winning_trades: 1,
    losing_trades: 0,
    flat_trades: 0,
    gross_profit_cents: 55n,
    gross_loss_cents: 0n,
    net_pnl_cents: input.net_pnl_cents ?? 55n,
    average_trade_pnl_cents: 55n,
    average_win_cents: 55n,
    average_loss_cents: null,
    win_rate_ppm: 1_000_000,
    profit_factor_ppm: null,
    max_drawdown_cents: 0n,
    final_equity_cents: 1055n,
    peak_equity_cents: 1055n,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
