import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRunId, makeSessionId, type AnyJournalEventEnvelope } from '../../src/contracts/index.js';
import { LocalObsReplaySource } from '../../src/data/local-obs-replay-source.js';

const RUN_ID = makeRunId('run-qfa-633-shadow-replay');
const SESSION_ID = makeSessionId('session-qfa-633-shadow-replay');
const FIXTURE_PATH = join(process.cwd(), 'apps/strategy_runtime/tests/fixtures/obs-replay-sample.jsonl');

describe('LocalObsReplaySource', () => {
  it('replays committed OBS-01 quote and trade events as fast as possible', async () => {
    const events: AnyJournalEventEnvelope[] = [];
    const source = new LocalObsReplaySource({
      path: FIXTURE_PATH,
      run_id: RUN_ID,
      session_id: SESSION_ID,
      pace_mode: 'as_fast_as_possible',
      event_sink: (event) => {
        events.push(event);
      },
    });

    await source.start();

    expect(events.filter((event) => event.type === 'QUOTE').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'TRADE').length).toBeGreaterThan(0);
    expect(events.every((event) => event.run_id === RUN_ID)).toBe(true);
    expect(events.every((event) => event.session_id === SESSION_ID)).toBe(true);
  });

  it('fails closed when the configured path does not exist', async () => {
    const source = new LocalObsReplaySource({
      path: join(tmpdir(), 'qfa-local-obs-missing.jsonl'),
      run_id: RUN_ID,
      session_id: SESSION_ID,
      pace_mode: 'as_fast_as_possible',
      event_sink: () => undefined,
    });

    await expect(source.start()).rejects.toThrow('QFA_PAPER_LOCAL_OBS_PATH does not exist');
  });

  it('fails closed on malformed JSONL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qfa-local-obs-'));
    const malformedPath = join(dir, 'malformed.jsonl');
    writeFileSync(malformedPath, '{not-json}\n', 'utf8');
    const source = new LocalObsReplaySource({
      path: malformedPath,
      run_id: RUN_ID,
      session_id: SESSION_ID,
      pace_mode: 'as_fast_as_possible',
      event_sink: () => undefined,
    });

    await expect(source.start()).rejects.toThrow('malformed local OBS JSONL');
  });
});

