import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  JournalEventEnvelope,
  RuntimeEventType,
} from '../../../strategy_runtime/src/contracts/events/index.js';
import { FEATURE_AVAILABILITY_MASK } from '../../../strategy_runtime/src/features/availability-mask.js';
import {
  buildConsoleSnapshotFromEvents,
  createConsoleLiveStateAccumulator,
} from '../src/aggregator/live-state.js';
import { ingestJournalOnce } from '../src/ingest/journal-tail.js';
import { normalizeJournalTailResult } from '../src/ingest/event-normalizer.js';
import type { IngestedJournalEvent, JournalTailResult } from '../src/ingest/journal-tail.js';
import { emptyCheckpoint } from '../src/ingest/checkpoint.js';

const tempDirs: string[] = [];
const fixturePath = resolve(
  findRepoRoot(process.cwd()),
  'apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl',
);

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (manifest.name === 'quant-futures-app') {
        return current;
      }
    } catch {
      // Keep walking.
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      throw new Error('Unable to find quant-futures-app repo root');
    }
    current = parent;
  }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'operator-console-live-state-'));
  tempDirs.push(root);
  return root;
}

function envelope(
  type: RuntimeEventType,
  payload: Record<string, unknown>,
  eventId = `${type.toLowerCase()}-1`,
): JournalEventEnvelope {
  return {
    schema_version: 1,
    event_id: eventId,
    type,
    ts_ns: 1_700_000_000_000_000_000n,
    run_id: 'run-1',
    session_id: 'session-1',
    payload,
  } as unknown as JournalEventEnvelope;
}

function ingested(event: JournalEventEnvelope, lineNumber = 1): IngestedJournalEvent {
  return {
    event,
    source_file: 'journal.jsonl',
    byte_offset_start: lineNumber * 100,
    byte_offset_end: (lineNumber * 100) + 99,
    line_number: lineNumber,
  };
}

function tailResult(events: readonly IngestedJournalEvent[]): JournalTailResult {
  return {
    events,
    malformed_lines: [],
    checkpoint: emptyCheckpoint(),
  };
}

describe('operator console live-state aggregator', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('aggregates the OBS-00 fixture into MVP console state without deriving realized P&L from fills', () => {
    const root = tempRoot();
    const journal = join(root, 'rel00_controlled_live_sim_journal.jsonl');
    const checkpointDir = join(root, 'console-checkpoints');
    writeFileSync(journal, readFileSync(fixturePath, 'utf8'), 'utf8');

    const normalized = normalizeJournalTailResult(
      ingestJournalOnce({ journal_path: journal, checkpoint_dir: checkpointDir }),
      { check_missing_terminal_order_intents: true },
    );
    const snapshot = buildConsoleSnapshotFromEvents(normalized, {
      journal_path: journal,
      render_time_ns: '1700000001361000000',
      checkpoint_status: { status: 'available', value: 'checkpointed' },
    });

    expect(snapshot.generated_from.event_count).toBe(24);
    expect(snapshot.data_pipeline.by_type.ORDER_INTENT).toBe(1);
    expect(snapshot.trades.rows.map((row) => row.type)).toEqual([
      'ORDER_INTENT',
      'SIM_FILL',
      'POSITION',
      'MGMT_ACTION',
    ]);
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]?.position_id).toBe('position-obs00-1');
    expect(snapshot.positions[0]?.mark_price).toEqual({ status: 'available', value: 18503 });
    expect(snapshot.positions[0]?.unrealized_pnl_usd).toEqual({ status: 'available', value: 3.5 });
    expect(snapshot.positions[0]?.realized_pnl_usd.status).toBe('unavailable');
    expect(snapshot.pnl.realized_pnl_usd.status).toBe('unavailable');
    expect(snapshot.pnl.unrealized_pnl_usd).toEqual({ status: 'available', value: 3.5 });
    expect(snapshot.pnl.source).toBe('unavailable');
    expect(snapshot.risk.circuit_breaker_state.status).toBe('unavailable');
    expect(snapshot.feature_surface.mask_source).toBe('fallback');
    expect(snapshot.system_health.checkpoint_status).toEqual({
      status: 'available',
      value: 'checkpointed',
    });
  });

  it('accumulates normalized batches into the same snapshot as a full rebuild', () => {
    const root = tempRoot();
    const journal = join(root, 'rel00_controlled_live_sim_journal.jsonl');
    const checkpointDir = join(root, 'console-checkpoints');
    writeFileSync(journal, readFileSync(fixturePath, 'utf8'), 'utf8');

    const fullNormalized = normalizeJournalTailResult(
      ingestJournalOnce({
        journal_path: journal,
        checkpoint_dir: checkpointDir,
      }),
      { check_missing_terminal_order_intents: false },
    );
    const splitIndex = Math.floor(fullNormalized.events.length / 2);
    const firstChunk = normalizeJournalTailResult(
      tailResult(fullNormalized.events.slice(0, splitIndex)),
      { check_missing_terminal_order_intents: false },
    );
    const secondChunk = normalizeJournalTailResult(
      tailResult(fullNormalized.events.slice(splitIndex)),
      { check_missing_terminal_order_intents: false },
    );

    const incremental = createConsoleLiveStateAccumulator({
      journal_path: journal,
    });
    incremental.applyNormalizedResult(firstChunk);
    incremental.applyNormalizedResult(secondChunk);
    const incrementalSnapshot = incremental.snapshot({
      checkpoint_status: { status: 'available', value: 'checkpointed' },
    });
    const fullSnapshot = buildConsoleSnapshotFromEvents(fullNormalized, {
      journal_path: journal,
      render_time_ns: undefined,
      checkpoint_status: { status: 'available', value: 'checkpointed' },
    });

    expect(incrementalSnapshot).toEqual(fullSnapshot);
  });

  it('sums only explicit MGMT_ACTION realized P&L facts by position', () => {
    const normalized = normalizeJournalTailResult(
      tailResult([
        ingested(envelope('POSITION', {
          position_id: 'position-1',
          candidate_id: 'candidate-1',
          side: 'long',
          status: 'closed',
          quantity_open: 0,
          avg_entry_price: 100,
          updated_ts_ns: 1_700_000_000_000_000_000n,
        }), 1),
        ingested(envelope('SIM_FILL', {
          fill_id: 'fill-1',
          order_intent_id: 'intent-1',
          side: 'sell',
          quantity: 1,
          price: 102,
          liquidity: 'taker',
          position_id: 'position-1',
        }), 2),
        ingested(envelope('MGMT_ACTION', {
          management_action_id: 'mgmt-1',
          position_id: 'position-1',
          action_type: 'exit',
          reason: 'target',
          realized_pnl_usd: 12,
        }), 3),
        ingested(envelope('MGMT_ACTION', {
          management_action_id: 'mgmt-2',
          position_id: 'position-1',
          action_type: 'partial_exit',
          reason: 'scale',
          realized_pnl_usd: 4,
        }), 4),
      ]),
      { check_missing_terminal_order_intents: false },
    );

    const snapshot = buildConsoleSnapshotFromEvents(normalized, { journal_path: 'journal.jsonl' });

    expect(snapshot.positions[0]?.realized_pnl_usd).toEqual({ status: 'available', value: 16 });
    expect(snapshot.pnl.realized_pnl_usd).toEqual({ status: 'available', value: 16 });
    expect(snapshot.pnl.source).toBe('explicit_lifecycle_fact');
  });

  it('keeps closed-position terminal P&L unavailable without explicit lifecycle facts', () => {
    const normalized = normalizeJournalTailResult(
      tailResult([
        ingested(envelope('POSITION', {
          position_id: 'position-1',
          candidate_id: 'candidate-1',
          side: 'long',
          status: 'closed',
          quantity_open: 0,
          avg_entry_price: 100,
          updated_ts_ns: 1_700_000_000_000_000_000n,
        })),
      ]),
      { check_missing_terminal_order_intents: false },
    );

    const snapshot = buildConsoleSnapshotFromEvents(normalized, { journal_path: 'journal.jsonl' });

    expect(snapshot.positions[0]?.status).toBe('closed');
    expect(snapshot.positions[0]?.realized_pnl_usd.status).toBe('unavailable');
    expect(snapshot.pnl.realized_pnl_usd.status).toBe('unavailable');
  });

  it('does not promote aggregate session-risk P&L into realized P&L state', () => {
    const normalized = normalizeJournalTailResult(
      tailResult([
        ingested(envelope('RISK_GATE', {
          risk_gate_decision_id: 'risk-1',
          candidate_id: 'candidate-1',
          status: 'pass',
          reasons: [],
          session_risk: {
            session_id: 'session-1',
            account_ref: 'sim',
            symbol: 'MNQ',
            realized_pnl_usd: 99,
            open_trade_count: 2,
            closed_trade_count: 1,
            rejected_trade_count: 3,
            circuit_breaker_state: 'inactive',
            last_transition_ts_ns: 1_700_000_000_000_000_000n,
          },
        })),
      ]),
      { check_missing_terminal_order_intents: false },
    );

    const snapshot = buildConsoleSnapshotFromEvents(normalized, { journal_path: 'journal.jsonl' });

    expect(snapshot.risk.circuit_breaker_state).toEqual({ status: 'available', value: 'inactive' });
    expect(snapshot.risk.open_trade_count).toEqual({ status: 'available', value: 2 });
    expect(snapshot.risk.rejected_trade_count).toEqual({ status: 'available', value: 3 });
    expect(snapshot.risk.daily_loss_usage).toEqual({
      status: 'unavailable',
      reason: 'no daily_loss_usage fact in RISK_GATE.session_risk',
    });
    expect(snapshot.pnl.realized_pnl_usd.status).toBe('unavailable');
    expect(snapshot.pnl.source).toBe('unavailable');
  });

  it('derives feature surface from embedded v5 masks and carries policy violations as alerts', () => {
    const normalized = normalizeJournalTailResult(
      tailResult([
        ingested(envelope('FEATURES', {
          feature_snapshot_id: 'feature-1',
          values: { atr_pts: 4 },
          feature_availability_mask: FEATURE_AVAILABILITY_MASK,
        }), 1),
        ingested(envelope('RANK', {
          ranked_candidate_ids: ['candidate-1'],
          method: 'test',
          feature_use: {
            feature_name: 'queue_position',
            use_context: 'rank',
          },
        }), 2),
      ]),
      { check_missing_terminal_order_intents: false },
    );

    const snapshot = buildConsoleSnapshotFromEvents(normalized, { journal_path: 'journal.jsonl' });

    expect(snapshot.feature_surface.mask_source).toBe('embedded');
    expect(snapshot.feature_surface.mask_version).toBe(5);
    expect(snapshot.feature_surface.partition_counts.blocked).toBeGreaterThan(0);
    expect(snapshot.feature_surface.recent_violations).toHaveLength(1);
    expect(snapshot.alerts[0]?.message).toContain('excluded from decision-grade state');
  });

  it('alerts and falls back when embedded feature mask schema or version drifts', () => {
    const schemaMismatch = buildConsoleSnapshotFromEvents(
      normalizeJournalTailResult(
        tailResult([
          ingested(envelope('FEATURES', {
            feature_snapshot_id: 'feature-schema',
            values: {},
            feature_availability_mask: {
              ...FEATURE_AVAILABILITY_MASK,
              schema_version: 2,
            },
          })),
        ]),
        { check_missing_terminal_order_intents: false },
      ),
      { journal_path: 'journal.jsonl' },
    );
    const versionMismatch = buildConsoleSnapshotFromEvents(
      normalizeJournalTailResult(
        tailResult([
          ingested(envelope('FEATURES', {
            feature_snapshot_id: 'feature-version',
            values: {},
            feature_availability_mask: {
              ...FEATURE_AVAILABILITY_MASK,
              mask_version: 6,
            },
          }, 'features-v6')),
        ]),
        { check_missing_terminal_order_intents: false },
      ),
      { journal_path: 'journal.jsonl' },
    );

    expect(schemaMismatch.feature_surface.mask_source).toBe('fallback');
    expect(schemaMismatch.alerts).toContainEqual(expect.objectContaining({
      id: 'feature-policy-mask-schema-mismatch:features-1',
      severity: 'critical',
    }));
    expect(versionMismatch.feature_surface.mask_source).toBe('fallback');
    expect(versionMismatch.alerts).toContainEqual(expect.objectContaining({
      id: 'feature-policy-mask-version-mismatch:features-v6',
      severity: 'critical',
    }));
  });
});
