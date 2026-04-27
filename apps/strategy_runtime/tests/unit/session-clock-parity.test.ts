import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ns } from '../../src/contracts/index.js';
import {
  getMnqSessionPhase,
  loadMnqSessionCalendarConfig,
} from '../../src/session/index.js';

const PYTHON = process.env.PYTHON ?? 'python';
const RANDOM_PARITY_SEED = 0x5eed_2026;
const RANDOM_PARITY_CASE_COUNT = 512;
const RANDOM_PARITY_START_TS_NS = 1_767_225_600_000_000_000n;
const RANDOM_PARITY_RANGE_SECONDS = 366 * 24 * 60 * 60;

const SESSION_BOUNDARY_CASES = [
  ['rth_open', '1776951000000000000'],
  ['rth_after_warmup', '1776952800000000000'],
  ['rth_close_boundary', '1776974400000000000'],
  ['eth_before_maintenance', '1776976200000000000'],
  ['maintenance_start', '1776978000000000000'],
  ['eth_restart', '1776981600000000000'],
  ['friday_after_maintenance', '1777064460000000000'],
  ['saturday_closed', '1777132800000000000'],
  ['sunday_before_eth', '1777237200000000000'],
  ['sunday_eth', '1777242600000000000'],
  ['dst_spring_rth_open', '1773063000000000000'],
  ['dst_fall_rth_open', '1793629800000000000'],
  ['example_holiday_closed', '1798210800000000000'],
] as const;

interface ComparableSessionEvaluation {
  readonly label: string;
  readonly phase: string;
  readonly journal_phase: string;
  readonly trading_date: string;
  readonly session_id: string;
  readonly candidate_eligible: boolean;
  readonly block_reason: string | null;
}

interface PythonWarmupEvaluation extends ComparableSessionEvaluation {
  readonly warmup_suppressed: boolean;
  readonly warmup_until_ts_ns: string | null;
}

describe('TS/Python MNQ session clock parity', () => {
  it('keeps sidecar Python session phase output aligned with the TypeScript MNQ helper', () => {
    const tsEvaluations = evaluateWithTypescript(SESSION_BOUNDARY_CASES);
    const pythonEvaluations = evaluateWithPython(SESSION_BOUNDARY_CASES, 0);

    expect(pythonEvaluations).toEqual(tsEvaluations);
  });

  it('keeps TS/Python session phase parity over a fixed-seed timestamp sample', () => {
    const randomCases = fixedSeedSessionCases();
    const tsEvaluations = evaluateWithTypescript(randomCases);
    const pythonEvaluations = evaluateWithPython(randomCases, 0);

    expect(randomCases).toHaveLength(RANDOM_PARITY_CASE_COUNT);
    expect(pythonEvaluations).toEqual(tsEvaluations);
  });

  it('keeps Python warmup suppression layered on top of matching RTH phase semantics', () => {
    const pythonEvaluations = evaluateWithPython([
      ['rth_open_plus_30s', '1776951030000000000'],
      ['rth_open_plus_60s', '1776951060000000000'],
    ], 60) as readonly PythonWarmupEvaluation[];

    expect(pythonEvaluations).toEqual([
      {
        label: 'rth_open_plus_30s',
        phase: 'rth',
        journal_phase: 'rth',
        trading_date: '2026-04-23',
        session_id: '2026-04-23-rth',
        candidate_eligible: false,
        block_reason: 'warmup_suppression',
        warmup_suppressed: true,
        warmup_until_ts_ns: '1776951060000000000',
      },
      {
        label: 'rth_open_plus_60s',
        phase: 'rth',
        journal_phase: 'rth',
        trading_date: '2026-04-23',
        session_id: '2026-04-23-rth',
        candidate_eligible: true,
        block_reason: null,
        warmup_suppressed: false,
        warmup_until_ts_ns: '1776951060000000000',
      },
    ]);
  });

  it('keeps both session-clock implementations free of deterministic-output hazards', () => {
    const tsSource = readFileSync(join(process.cwd(), 'apps/strategy_runtime/src/session/mnq-session-calendar.ts'), 'utf8');
    const pythonSource = readFileSync(join(process.cwd(), 'services/market_data_sidecar/session/session_clock.py'), 'utf8');
    const combined = `${tsSource}\n${pythonSource}`;

    for (const pattern of ['Date.now', 'new Date(', 'Math.random', 'toLocaleString', 'localeCompare', 'datetime.now', 'datetime.utcnow', 'time.time']) {
      expect(combined).not.toContain(pattern);
    }
  });
});

function fixedSeedSessionCases(): readonly (readonly [string, string])[] {
  let state = RANDOM_PARITY_SEED >>> 0;
  const nextUInt32 = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };

  return Array.from({ length: RANDOM_PARITY_CASE_COUNT }, (_, index) => {
    const offsetSeconds = nextUInt32() % RANDOM_PARITY_RANGE_SECONDS;
    const tsNs = RANDOM_PARITY_START_TS_NS + BigInt(offsetSeconds) * 1_000_000_000n;
    return [`fixed_seed_${index.toString().padStart(3, '0')}`, tsNs.toString()] as const;
  });
}

function evaluateWithTypescript(
  cases: readonly (readonly [string, string])[],
): readonly ComparableSessionEvaluation[] {
  const config = loadMnqSessionCalendarConfig();
  return cases.map(([label, timestampNs]) => {
    const evaluation = getMnqSessionPhase(config, ns(timestampNs));
    return {
      label,
      phase: evaluation.phase,
      journal_phase: evaluation.journal_phase,
      trading_date: evaluation.trading_date,
      session_id: evaluation.session_id,
      candidate_eligible: evaluation.candidate_eligible,
      block_reason: evaluation.block_reason ?? null,
    };
  });
}

function evaluateWithPython(
  cases: readonly (readonly [string, string])[],
  warmupSeconds: number,
): readonly ComparableSessionEvaluation[] | readonly PythonWarmupEvaluation[] {
  const script = `
import json
import sys
from services.market_data_sidecar.session.session_clock import (
    WarmupPolicy,
    evaluate_mnq_session,
    load_mnq_session_calendar,
)

cases = json.loads(sys.argv[1])
warmup_seconds = int(sys.argv[2])
calendar = load_mnq_session_calendar()
out = []
for label, timestamp_ns in cases:
    evaluation = evaluate_mnq_session(
        str(timestamp_ns),
        calendar=calendar,
        warmup_policy=WarmupPolicy(warmup_seconds=warmup_seconds),
    )
    row = {
        "label": label,
        "phase": evaluation.session_phase,
        "journal_phase": evaluation.journal_phase,
        "trading_date": evaluation.trading_date,
        "session_id": evaluation.session_id,
        "candidate_eligible": evaluation.candidate_eligible,
        "block_reason": evaluation.block_reason,
    }
    if warmup_seconds > 0:
        row["warmup_suppressed"] = evaluation.warmup_suppressed
        row["warmup_until_ts_ns"] = evaluation.warmup_until_ts_ns
    out.append(row)
print(json.dumps(out, sort_keys=True, separators=(",", ":")))
`;
  const result = spawnSync(PYTHON, ['-c', script, JSON.stringify(cases), String(warmupSeconds)], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`Python session clock parity helper failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  return JSON.parse(result.stdout) as readonly ComparableSessionEvaluation[] | readonly PythonWarmupEvaluation[];
}
