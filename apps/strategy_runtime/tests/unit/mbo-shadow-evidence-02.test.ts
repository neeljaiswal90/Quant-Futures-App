import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runMboShadowEvidence02 } from '../../../../scripts/rel/mbo-shadow-evidence-02.js';

const START_TS_NS = 1_777_522_806_211_136_353n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('MBO-SHADOW-EVIDENCE-02 repeatability gate', () => {
  it('passes for at least three passing diagnostic shadow sessions', () => {
    const root = makeTempDir();
    const reportPath = writeEvidence01Report(root, {
      sessions: [makeSession(root, 1), makeSession(root, 2), makeSession(root, 3)],
    });

    const report = runEvidence02(root, reportPath);

    expect(report.status).toBe('pass');
    expect(report.evidence_policy.minimum_sessions_required).toBe(3);
    expect(report.policy_posture.mbo_decision_use_allowed).toBe(false);
    expect(report.policy_posture.mbo_advisory_use_allowed).toBe(false);
    expect(report.aggregate.session_count).toBe(3);
    expect(report.aggregate.rel00_pass_sessions).toBe(3);
    expect(report.aggregate.rel01d_pass_sessions).toBe(3);
    expect(report.aggregate.rel01e_pass_sessions).toBe(3);
    expect(report.aggregate.source_hash_bound_sessions).toBe(3);
    expect(report.aggregate.order_id_coverage).toBe(1);
    expect(report.aggregate.sequence_monotonic_sessions).toBe(3);
    expect(report.aggregate.taxonomy_statuses).toEqual(['action_taxonomy_unresolved']);
    expect(report.next_blocker).toContain('DATA-MBO-ADR-01');
  });

  it('fails until the minimum session count is met', () => {
    const root = makeTempDir();
    const reportPath = writeEvidence01Report(root, {
      sessions: [makeSession(root, 1), makeSession(root, 2)],
    });

    const report = runEvidence02(root, reportPath);

    expect(report.status).toBe('fail');
    expect(report.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('minimum_session_count_met:2/3'),
      ]),
    );
  });

  it('fails if current MBO source bytes no longer match evidence-01 hashes', () => {
    const root = makeTempDir();
    const sessions = [makeSession(root, 1), makeSession(root, 2), makeSession(root, 3)];
    const reportPath = writeEvidence01Report(root, { sessions });
    writeText(sessions[1]!.sourcePath, `${sourceEvent(999, 0n, 'add', 'bid', '999')}\n`);

    const report = runEvidence02(root, reportPath);

    expect(report.status).toBe('fail');
    expect(report.aggregate.source_hash_bound_sessions).toBe(2);
    expect(report.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('mbo_source_hash_mismatch'),
        expect.stringContaining('source_hashes_bound_to_current_bytes:2/3'),
      ]),
    );
  });

  it('fails when telemetry health is not observable', () => {
    const root = makeTempDir();
    const sessions = [
      makeSession(root, 1),
      makeSession(root, 2),
      makeSession(root, 3, { omitSequence: true }),
    ];
    const reportPath = writeEvidence01Report(root, { sessions });

    const report = runEvidence02(root, reportPath);

    expect(report.status).toBe('fail');
    expect(report.aggregate.sequence_observed_sessions).toBe(2);
    expect(report.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('sequence_observed_all_sessions:2/3'),
        expect.stringContaining('sequence_monotonic_all_sessions:2/3'),
      ]),
    );
  });

  it('writes deterministic reports without embedding raw MBO payloads', () => {
    const root = makeTempDir();
    const reportPath = writeEvidence01Report(root, {
      sessions: [makeSession(root, 1, { rawSentinel: true }), makeSession(root, 2), makeSession(root, 3)],
    });

    const first = runEvidence02(root, reportPath);
    const firstJson = readFileSync(join(root, 'evidence02.json'), 'utf8');
    const firstMd = readFileSync(join(root, 'evidence02.md'), 'utf8');
    const second = runEvidence02(root, reportPath);
    const secondJson = readFileSync(join(root, 'evidence02.json'), 'utf8');
    const secondMd = readFileSync(join(root, 'evidence02.md'), 'utf8');

    expect(second).toEqual(first);
    expect(secondJson).toBe(firstJson);
    expect(secondMd).toBe(firstMd);
    expect(firstJson).not.toContain('RAW_SHOULD_NOT_APPEAR');
    expect(firstMd).not.toContain('RAW_SHOULD_NOT_APPEAR');
  });

  it('does not use wall-clock or random APIs in deterministic report code', () => {
    const source = readFileSync('scripts/rel/mbo-shadow-evidence-02.ts', 'utf8');

    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('Math.random');
  });

  it('registers the npm script', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly scripts: Record<string, string>;
    };

    expect(packageJson.scripts['mbo:shadow:evidence:02']).toBe(
      'tsx scripts/rel/mbo-shadow-evidence-02.ts',
    );
  });
});

interface TestSession {
  readonly session_id: string;
  readonly run_id: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly shadowEvents: number;
  readonly shadowFieldOccurrences: number;
}

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-mbo-shadow-evidence-02-'));
  tempDirectories.push(directory);
  return directory;
}

function makeSession(root: string, index: number, options: {
  readonly omitSequence?: boolean;
  readonly rawSentinel?: boolean;
} = {}): TestSession {
  const sourcePath = join(root, `source-${index}.jsonl`);
  const lines = [
    sourceEvent(index, 0n, 'add', 'bid', String(100 + index), options),
    sourceEvent(index, 1_000n, 'cancel', 'ask', String(101 + index), options),
    sourceEvent(index, 2_000n, 'modify', 'bid', String(102 + index), options),
  ];
  writeText(sourcePath, `${lines.join('\n')}\n`);
  return {
    session_id: `2026-04-${28 + index}-shadow-smoke`,
    run_id: `mbo-shadow-evidence-02-session-${index}`,
    sourcePath,
    sourceHash: sha256Text(readFileSync(sourcePath, 'utf8')),
    shadowEvents: 2,
    shadowFieldOccurrences: 6,
  };
}

function sourceEvent(
  sessionIndex: number,
  offsetNs: bigint,
  action: 'add' | 'cancel' | 'modify',
  side: 'bid' | 'ask',
  sequence: string,
  options: { readonly omitSequence?: boolean; readonly rawSentinel?: boolean } = {},
): string {
  const payload: Record<string, unknown> = {
    microstructure_kind: 'mbo_order_lifecycle',
    source: 'mbo_order_lifecycle',
    action,
    side,
    order_id: `order-${sessionIndex}-${sequence}`,
    raw_payload: options.rawSentinel === true ? 'RAW_SHOULD_NOT_APPEAR' : undefined,
    values: {
      action,
      side,
      order_id: `order-${sessionIndex}-${sequence}`,
      has_order_id: true,
      has_sequence: options.omitSequence !== true,
    },
  };
  if (options.omitSequence !== true) {
    payload.sequence = sequence;
    (payload.values as Record<string, unknown>).sequence = sequence;
  }
  return JSON.stringify({
    schema_version: 1,
    event_id: `mbo-source-${sessionIndex}-${sequence}`,
    type: 'MICROSTRUCTURE',
    ts_ns: (START_TS_NS + offsetNs).toString(),
    run_id: `mbo-source-run-${sessionIndex}`,
    session_id: `2026-04-${28 + sessionIndex}-shadow-smoke`,
    payload,
  });
}

function writeEvidence01Report(root: string, input: {
  readonly sessions: readonly TestSession[];
  readonly status?: string;
}): string {
  const reportPath = join(root, 'evidence01.json');
  const sessions = input.sessions.map((session) => ({
    session_id: session.session_id,
    run_id: session.run_id,
    files: {
      mbo_source_journal: session.sourcePath,
    },
    source_hash: session.sourceHash,
    rel00_status: 'pass',
    rel01d_status: 'pass',
    rel01e_status: 'pass',
    shadow_events: session.shadowEvents,
    shadow_field_occurrences: session.shadowFieldOccurrences,
    safety: {
      real_order_event_types: 0,
      restricted_uses: 0,
      blocked_uses: 0,
      unsafe_decision_use_event_count: 0,
      unsafe_decision_use_validator_count_sum: 0,
    },
    lineage: {
      missing_source_event_count: 0,
      lookahead_source_event_count: 0,
      recompute_mismatch_count: 0,
      source_hash_mismatch_count: 0,
    },
  }));
  writeJson(reportPath, {
    schema_version: 1,
    ticket_id: 'MBO-SHADOW-EVIDENCE-01',
    status: input.status ?? 'pass',
    aggregate: {
      session_count: sessions.length,
      rel00_pass_sessions: sessions.length,
      rel01d_pass_sessions: sessions.length,
      rel01e_pass_sessions: sessions.length,
      safety: {
        real_order_event_types: 0,
        restricted_uses: 0,
        blocked_uses: 0,
        unsafe_decision_use_event_count: 0,
        unsafe_decision_use_validator_count_sum: 0,
      },
      lineage: {
        missing_source_event_count: 0,
        lookahead_source_event_count: 0,
        recompute_mismatch_count: 0,
        source_hash_mismatch_count: 0,
      },
    },
    sessions,
  });
  return reportPath;
}

function runEvidence02(root: string, evidence01Report: string): ReturnType<typeof runMboShadowEvidence02> {
  return runMboShadowEvidence02({
    cwd: root,
    evidence01_report: evidence01Report,
    out_json: 'evidence02.json',
    out_md: 'evidence02.md',
  });
}

function writeJson(path: string, value: Record<string, unknown>): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
