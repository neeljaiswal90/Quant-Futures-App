import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMboShadowEvidence01 } from '../../../../scripts/rel/mbo-shadow-evidence-01.js';

const START_TS_NS = 1_777_301_421_588_943_700n;
const MASK_ID = 'feature-availability-mask-v4-adr0002-data03ps-mbo-shadow';
const MASK_HASH = 'sha256:test-mask-hash';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-mbo-shadow-evidence-01-'));
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

function writeJson(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function ts(offsetNs: bigint): string {
  return (START_TS_NS + offsetNs).toString();
}

function mboSourceEvent(
  eventId: string,
  offsetNs: bigint,
  action: 'add' | 'cancel' | 'modify',
  side: 'bid' | 'ask',
): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: eventId,
    type: 'MICROSTRUCTURE',
    ts_ns: ts(offsetNs),
    run_id: 'run-source',
    session_id: '2026-04-29-shadow-smoke',
    payload: {
      exchange_event_ts_ns: ts(offsetNs),
      sidecar_recv_ts_ns: ts(offsetNs + 1_000n),
      source: 'mbo_order_lifecycle',
      microstructure_kind: 'mbo_order_lifecycle',
      action,
      side,
      order_id: `order-${eventId}`,
      raw_payload: 'RAW_SHOULD_NOT_APPEAR',
      values: {},
    },
  };
}

function shadowEvent(
  eventId: string,
  offsetNs: bigint,
  values: Record<string, number>,
  decisionUse = false,
): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: eventId,
    type: 'FEATURES',
    ts_ns: ts(offsetNs),
    run_id: 'run-shadow',
    session_id: '2026-04-29-shadow-smoke',
    payload: {
      feature_snapshot_id: eventId,
      values: {},
      shadow_values: values,
      decision_use: decisionUse,
    },
  };
}

function makeSession(
  cwd: string,
  index: number,
  overrides: {
    readonly rel01eStatus?: string;
    readonly restrictedUses?: number;
    readonly blockedUses?: number;
    readonly unsafeDecisionUse?: number;
    readonly rel01eUnsafeDecisionUse?: number;
    readonly sourceHashOverride?: string;
    readonly malformedShadow?: boolean;
    readonly rel01dShadowCount?: number;
    readonly rel01eShadowCount?: number;
    readonly rel01dMaskId?: string;
    readonly rel01eMaskId?: string;
    readonly rel01dMaskVersion?: number;
    readonly rel01eMaskVersion?: number;
  } = {},
): Record<string, unknown> {
  const sessionId = `2026-04-${28 + index}-shadow-smoke`;
  const runId = `mbo-shadow-evidence-session-${index}`;
  const sourceJournal = join(cwd, `source-${index}.jsonl`);
  const shadowJournal = join(cwd, `shadow-${index}.jsonl`);
  const orchReport = join(cwd, `orch-${index}.json`);
  const rel00Report = join(cwd, `rel00-${index}.json`);
  const rel01dReport = join(cwd, `rel01d-${index}.json`);
  const rel01eReport = join(cwd, `rel01e-${index}.json`);

  const sourceHash = writeJsonl(sourceJournal, [
    mboSourceEvent(`mbo-add-${index}-1`, 1_000n, 'add', 'bid'),
    mboSourceEvent(`mbo-cancel-${index}-1`, 2_000n, 'cancel', 'ask'),
    mboSourceEvent(`mbo-add-${index}-2`, 3_000n, 'add', 'bid'),
    mboSourceEvent(`mbo-modify-${index}-1`, 4_000n, 'modify', 'ask'),
  ]);
  if (overrides.malformedShadow === true) {
    writeFileSync(shadowJournal, 'not-json\n', 'utf8');
  } else {
    writeJsonl(shadowJournal, [
      shadowEvent(`shadow-${index}-1`, 5_000n, {
        cancel_add_ratio_shadow: 0,
        mbo_action_imbalance_shadow: 1,
        order_lifetime_shadow: 0.5,
      }),
      shadowEvent(`shadow-${index}-2`, 6_000n, {
        cancel_add_ratio_shadow: 1,
        mbo_action_imbalance_shadow: 0,
        order_lifetime_shadow: 1.5,
      }),
      shadowEvent(`shadow-${index}-3`, 7_000n, {
        cancel_add_ratio_shadow: 2,
        mbo_action_imbalance_shadow: -1,
        order_lifetime_shadow: 2.5,
      }),
    ]);
  }

  const reportedSourceHash = overrides.sourceHashOverride ?? sourceHash;
  writeJson(orchReport, {
    status: 'generated',
    generation: {
      source_mbo_events_indexed: 4,
      shadow_events_emitted: 3,
      shadow_field_occurrences: 9,
    },
    input: {
      mbo_source_journal: {
        sha256: reportedSourceHash,
        action_counts: {
          add: 2,
          cancel: 1,
          modify: 1,
        },
      },
    },
    real_order_event_types_emitted: 0,
  });
  writeJson(rel00Report, {
    status: 'pass',
    raw_scan_summary: {
      real_order_event_type_counts: {},
    },
  });
  writeJson(rel01dReport, {
    status: 'pass',
    audit_mask: {
      mask_version: overrides.rel01dMaskVersion ?? 4,
      mask_id: overrides.rel01dMaskId ?? MASK_ID,
      mask_hash: MASK_HASH,
    },
    aggregate: {
      partition_counts: {
        shadow: overrides.rel01dShadowCount ?? 9,
        restricted: overrides.restrictedUses ?? 0,
        blocked: overrides.blockedUses ?? 0,
        invalid_diagnostic: 0,
        invalid_shadow: 0,
      },
      unsafe_shadow_or_diagnostic_decision_use_event_count: overrides.unsafeDecisionUse ?? 0,
    },
  });
  writeJson(rel01eReport, {
    status: overrides.rel01eStatus ?? 'pass',
    audit_mask: {
      mask_version: overrides.rel01eMaskVersion ?? 4,
      mask_id: overrides.rel01eMaskId ?? MASK_ID,
      mask_hash: MASK_HASH,
    },
    aggregate: {
      source_journal_sha256: reportedSourceHash,
      shadow_field_occurrences: overrides.rel01eShadowCount ?? 9,
      missing_source_event_count: 0,
      lookahead_source_event_count: 0,
      recompute_mismatch_count: 0,
      source_hash_mismatch_count: 0,
      unsafe_decision_use_event_count: overrides.rel01eUnsafeDecisionUse ?? 0,
    },
  });

  return {
    session_id: sessionId,
    run_id: runId,
    shadow_journal: shadowJournal,
    mbo_source_journal: sourceJournal,
    orch_report: orchReport,
    rel00_report: rel00Report,
    rel01d_report: rel01dReport,
    rel01e_report: rel01eReport,
  };
}

function runEvidence(
  cwd: string,
  sessions: readonly Record<string, unknown>[],
): {
  readonly report: ReturnType<typeof runMboShadowEvidence01>;
  readonly outJson: string;
  readonly outMd: string;
} {
  const manifestPath = join(cwd, 'manifest.json');
  const outJson = join(cwd, 'report.json');
  const outMd = join(cwd, 'report.md');
  writeJson(manifestPath, {
    schema_version: 1,
    evidence_run_id: 'mbo-shadow-evidence-test',
    runtime_commit: 'test-commit',
    sessions,
  });
  const report = runMboShadowEvidence01({
    cwd,
    manifest: manifestPath,
    outJson,
    outMd,
  });
  return { report, outJson, outMd };
}

describe('MBO-SHADOW-EVIDENCE-01 aggregate evidence', () => {
  it('passes for repeatable shadow telemetry evidence across sessions', () => {
    const cwd = makeTempDir();
    const sessionA = makeSession(cwd, 1);
    const sessionB = makeSession(cwd, 2);

    const { report } = runEvidence(cwd, [sessionA, sessionB]);

    expect(report.status).toBe('pass');
    expect(report.aggregate.session_count).toBe(2);
    expect(report.aggregate.source_mbo_events_indexed).toBe(8);
    expect(report.aggregate.shadow_events).toBe(6);
    expect(report.aggregate.shadow_field_occurrences).toBe(18);
    expect(report.aggregate.action_counts).toEqual({ add: 4, cancel: 2, modify: 2 });
    expect(report.aggregate.side_counts).toEqual({ ask: 4, bid: 4 });
    expect(report.aggregate.safety.restricted_uses).toBe(0);
    expect(report.aggregate.safety.blocked_uses).toBe(0);
    expect(report.safety_posture).toMatchObject({
      mbo_decision_use_allowed: false,
      mbo_derived_features_status: 'shadow_only',
      data01b_full_status: 'blocked',
      decision_surface_changed: false,
    });
    expect(report.aggregate.mask_binding.mask_ids).toEqual([MASK_ID]);
    expect(report.aggregate.cross_validator.shadow_field_occurrence_mismatch_sessions).toEqual([]);
    expect(report.aggregate.lineage.recompute_mismatch_count).toBe(0);
    expect(report.aggregate.distributions_by_field.cancel_add_ratio_shadow).toMatchObject({
      count: 6,
      min: 0,
      mean: 1,
      p50: 1,
      p90: 2,
      max: 2,
    });
  });

  it('fails when a validator report fails', () => {
    const cwd = makeTempDir();
    const session = makeSession(cwd, 1, { rel01eStatus: 'fail' });

    const { report } = runEvidence(cwd, [session]);

    expect(report.status).toBe('fail');
    expect(report.reasons).toContain('2026-04-29-shadow-smoke:rel01e_status_not_pass:fail');
  });

  it('fails when restricted, blocked, or decision-use counts are present', () => {
    const cwd = makeTempDir();
    const session = makeSession(cwd, 1, {
      restrictedUses: 1,
      blockedUses: 2,
      unsafeDecisionUse: 3,
      rel01eUnsafeDecisionUse: 3,
    });

    const { report } = runEvidence(cwd, [session]);

    expect(report.status).toBe('fail');
    expect(report.aggregate.safety.restricted_uses).toBe(1);
    expect(report.aggregate.safety.blocked_uses).toBe(2);
    expect(report.aggregate.safety.unsafe_decision_use_event_count).toBe(3);
    expect(report.aggregate.safety.unsafe_decision_use_validator_count_sum).toBe(6);
  });

  it('fails when mask bindings differ across validators', () => {
    const cwd = makeTempDir();
    const session = makeSession(cwd, 1, { rel01eMaskId: 'feature-availability-mask-v5-test' });

    const { report } = runEvidence(cwd, [session]);

    expect(report.status).toBe('fail');
    expect(report.aggregate.mask_binding.mask_ids).toEqual([
      MASK_ID,
      'feature-availability-mask-v5-test',
    ]);
    expect(report.reasons.some((reason) => reason.includes('mask_id_mismatch'))).toBe(true);
  });

  it('fails when REL-01D and REL-01E disagree on shadow occurrence counts', () => {
    const cwd = makeTempDir();
    const session = makeSession(cwd, 1, { rel01eShadowCount: 8 });

    const { report } = runEvidence(cwd, [session]);

    expect(report.status).toBe('fail');
    expect(report.aggregate.cross_validator.shadow_field_occurrence_mismatch_sessions).toEqual([
      '2026-04-29-shadow-smoke',
    ]);
    expect(report.reasons.some((reason) => reason.includes('shadow_field_occurrence_mismatch'))).toBe(true);
  });

  it('fails when source hashes do not bind to current source bytes', () => {
    const cwd = makeTempDir();
    const session = makeSession(cwd, 1, { sourceHashOverride: '0'.repeat(64) });

    const { report } = runEvidence(cwd, [session]);

    expect(report.status).toBe('fail');
    expect(report.reasons.some((reason) => reason.includes('source_hash_mismatch'))).toBe(true);
  });

  it('fails cleanly for missing or malformed files', () => {
    const cwd = makeTempDir();
    const session = makeSession(cwd, 1, { malformedShadow: true });
    rmSync(session.rel00_report as string, { force: true });

    const { report } = runEvidence(cwd, [session]);

    expect(report.status).toBe('fail');
    expect(report.reasons.some((reason) => reason.includes('missing_file:rel00_report'))).toBe(true);
    expect(report.reasons.some((reason) => reason.includes('shadow_journal_parse_errors'))).toBe(true);
  });

  it('writes deterministic reports without embedding raw MBO payloads', () => {
    const cwd = makeTempDir();
    const session = makeSession(cwd, 1);
    const first = runEvidence(cwd, [session]);
    const firstJson = readFileSync(first.outJson, 'utf8');
    const firstMd = readFileSync(first.outMd, 'utf8');
    const second = runEvidence(cwd, [session]);
    const secondJson = readFileSync(second.outJson, 'utf8');
    const secondMd = readFileSync(second.outMd, 'utf8');

    expect(firstJson).toBe(secondJson);
    expect(firstMd).toBe(secondMd);
    expect(firstJson).not.toContain('RAW_SHOULD_NOT_APPEAR');
    expect(firstMd).not.toContain('RAW_SHOULD_NOT_APPEAR');
    expect(readJson(first.outJson).status).toBe('pass');
  });

  it('does not use wall-clock or random APIs in deterministic report code', () => {
    const source = readFileSync('scripts/rel/mbo-shadow-evidence-01.ts', 'utf8');

    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('Math.random');
  });

  it('registers the npm script', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly scripts: Record<string, string>;
    };

    expect(packageJson.scripts['mbo:shadow:evidence']).toBe(
      'tsx scripts/rel/mbo-shadow-evidence-01.ts',
    );
  });
});
