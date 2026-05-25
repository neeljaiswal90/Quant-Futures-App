import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  EVALUATOR_IDS,
  PROFILE_WIRING_FIELD_PATHS,
  PROFILE_WIRING_MANIFEST,
  isReservedForPendingImplementation,
  type EvaluatorId,
  type ProfileFieldWiringEntry,
} from '../../../src/management/profile-wiring-manifest.js';
import {
  applyInitialFillToTargetPosition,
  buildTargetPositionFromCandidate,
  evaluatePositionManager,
  resolveManagementProfile,
  type ManagementProfile,
  type PositionManagerEvaluation,
  type PositionManagerMarketInput,
  type TargetPosition,
} from '../../../src/management/index.js';
import {
  makeFillId,
  makeOrderIntentId,
  makePositionId,
  ns,
  type Candidate,
  type SimulatedFill,
  type StrategyId,
} from '../../../src/contracts/index.js';
import { getActiveStrategyGenerator } from '../../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../../fixtures/strategies/synthetic-feature-snapshots.js';

const OPENED_TS_NS = ns('1776957600000000000');
const FILL_TS_NS = ns('1776957601000000000');
const NEXT_TS_NS = ns('1776957660000000000');
const FUTURE_TS_NS = ns('1776964800000000000');

// W1 hand-maintained TargetPosition field list.
// Covers TargetPosition top-level fields plus TargetPositionTarget and management substates.
const TARGET_POSITION_FIELD_PATHS = [
  'active_stop_price',
  'break_even.enabled',
  'break_even.moved',
  'break_even.offset_ticks',
  'break_even.trigger',
  'break_even.trigger_r',
  'break_even.trigger_target_label',
  'candidate_id',
  'entry_price',
  'fail_safe.enabled',
  'fail_safe.max_adverse_r',
  'fail_safe.max_spread_ticks',
  'fill_id',
  'initial_stop_price',
  'instrument',
  'lifecycle_state',
  'opened_ts_ns',
  'position_id',
  'profile_hash',
  'profile_id',
  'profile_version',
  'pt1_touched',
  'quantity',
  'realized_pnl_usd',
  'reasons',
  'remaining_quantity',
  'risk_points',
  'side',
  'strategy_id',
  'targets[].filled_quantity',
  'targets[].label',
  'targets[].minimum_reward_risk',
  'targets[].price',
  'targets[].quantity',
  'targets[].quantity_fraction',
  'targets[].reward_risk',
  'targets[].status',
  'time_stop.deadline_ts_ns',
  'time_stop.enabled',
  'time_stop.max_hold_minutes',
  'time_stop.opened_ts_ns',
  'time_stop.post_pt1_min_unrealized_r',
  'time_stop.pre_pt1_min_unrealized_r',
  'trailing_stop.active',
  'trailing_stop.activation',
  'trailing_stop.activation_r',
  'trailing_stop.activation_target_label',
  'trailing_stop.distance_ticks',
  'trailing_stop.enabled',
  'trailing_stop.mode',
  'unrealized_pnl_usd',
  'updated_ts_ns',
] as const;

const SYNTHETIC_RESERVED_FIELD = '_synthetic_test.reserved_field_for_test_only';

type FieldPath = (typeof TARGET_POSITION_FIELD_PATHS)[number];

type WiringEvaluation = PositionManagerEvaluation | { readonly evaluation_error: string };

interface ScenarioPair {
  readonly baseline: WiringEvaluation;
  readonly variant: WiringEvaluation;
}

describe('management profile wiring manifest', () => {
  it('W1 keeps the production manifest complete for TargetPosition runtime fields', () => {
    expect(PROFILE_WIRING_FIELD_PATHS).toEqual([...TARGET_POSITION_FIELD_PATHS].sort());

    const base = neutralPosition();
    for (const fieldPath of PROFILE_WIRING_FIELD_PATHS) {
      expect(pathExists(base.position, fieldPath), `${fieldPath} should exist on TargetPosition`).toBe(true);
    }
    expect(PROFILE_WIRING_FIELD_PATHS).not.toContain('time_stop.at_deadline_extension');
  });

  it('W1 rejects manifest entries that reference non-existent fields', () => {
    const manifest = {
      ...PROFILE_WIRING_MANIFEST,
      'time_stop.at_deadline_extension': {
        evaluators: ['time-stop'],
        consultation_kind: 'reserved_for_pending_implementation',
        consumer_ticket: 'MGMT-DEADLINE-EXTENSION-01',
        expected_evaluator: 'time-stop',
        rationale: 'Synthetic check: ADR-only fields must not enter the production manifest early.',
      },
    } satisfies Readonly<Record<string, ProfileFieldWiringEntry>>;

    expect(() => assertManifestFieldsExist(manifest, neutralPosition().position)).toThrow(
      'manifest entry time_stop.at_deadline_extension references a field that does not exist on TargetPosition',
    );
  });

  it('W2-WN proves every non-reserved manifest entry is consulted by runtime output', () => {
    const runnableEntries = consultationPlan(PROFILE_WIRING_MANIFEST).runnableEntries;

    expect(runnableEntries).toHaveLength(PROFILE_WIRING_FIELD_PATHS.length);
    for (const [fieldPath, entry] of runnableEntries) {
      assertManifestEntryBindings(fieldPath, entry);
      const pair = scenarioFor(fieldPath as FieldPath);
      expect(
        behaviorSignature(pair.variant),
        `${fieldPath} should alter management behavior or state output when its value changes`,
      ).not.toEqual(behaviorSignature(pair.baseline));
    }
  });

  it('W-META fails closed when a manifest entry has no evaluator binding', () => {
    const entry = {
      evaluators: [],
      consultation_kind: 'gate',
      rationale: 'Synthetic check: empty evaluator bindings are not allowed.',
    } satisfies ProfileFieldWiringEntry;

    expect(() => assertManifestEntryBindings('fail_safe.enabled', entry)).toThrow(
      'field fail_safe.enabled declared in manifest but no consulting evaluator declared',
    );
  });

  it('W-RESERVED skips reserved entries with a diagnostic instead of treating them as wired', () => {
    const manifest = {
      ...PROFILE_WIRING_MANIFEST,
      [SYNTHETIC_RESERVED_FIELD]: syntheticReservedEntry('QFA-SYNTHETIC-TEST-NEVER-MERGED'),
    } satisfies Readonly<Record<string, ProfileFieldWiringEntry>>;

    const plan = consultationPlan(manifest);

    expect(plan.runnableEntries.map(([fieldPath]) => fieldPath)).not.toContain(SYNTHETIC_RESERVED_FIELD);
    expect(plan.diagnostics).toContain(
      'reserved wiring skip: _synthetic_test.reserved_field_for_test_only waits for QFA-SYNTHETIC-TEST-NEVER-MERGED',
    );
  });

  it('W-RESERVED-SHAPE requires reserved entries to declare consumer ticket and expected evaluator', () => {
    expect(() => assertReservedShape(SYNTHETIC_RESERVED_FIELD, {
      evaluators: [],
      consultation_kind: 'reserved_for_pending_implementation',
      expected_evaluator: 'time-stop',
      rationale: 'Synthetic malformed reserved entry.',
    })).toThrow(
      'reserved manifest entry _synthetic_test.reserved_field_for_test_only must declare consumer_ticket',
    );

    expect(() => assertReservedShape(SYNTHETIC_RESERVED_FIELD, {
      evaluators: [],
      consultation_kind: 'reserved_for_pending_implementation',
      consumer_ticket: 'QFA-SYNTHETIC-TEST-NEVER-MERGED',
      rationale: 'Synthetic malformed reserved entry.',
    })).toThrow(
      'reserved manifest entry _synthetic_test.reserved_field_for_test_only must declare expected_evaluator',
    );
  });

  it('W-RESERVED-STALENESS passes synthetic not-yet-merged tickets', () => {
    const diagnostics: string[] = [];
    const manifest = {
      [SYNTHETIC_RESERVED_FIELD]: syntheticReservedEntry('QFA-SYNTHETIC-TEST-NEVER-MERGED'),
    } satisfies Readonly<Record<string, ProfileFieldWiringEntry>>;

    assertReservedEntriesNotStale(manifest, diagnostics, () => ({ status: 'ok', commits: [] }));

    expect(diagnostics).toEqual([]);
  });

  it('W-RESERVED-STALENESS fails synthetic entries whose consumer ticket has merged', () => {
    const diagnostics: string[] = [];
    const manifest = {
      [SYNTHETIC_RESERVED_FIELD]: syntheticReservedEntry('MGMT-BUG-FIX-02'),
    } satisfies Readonly<Record<string, ProfileFieldWiringEntry>>;

    expect(() => assertReservedEntriesNotStale(
      manifest,
      diagnostics,
      () => ({ status: 'ok', commits: ['d1d7461 MGMT-BUG-FIX-02: enforce declared management parameters'] }),
    )).toThrow(
      "manifest entry for _synthetic_test.reserved_field_for_test_only is RESERVED but consumer_ticket MGMT-BUG-FIX-02 has merged on origin/main; transition entry from 'reserved_for_pending_implementation' to actual consultation_kind",
    );
  });

  it('W-RESERVED-STALENESS uses git log without shell composition when production reserved entries exist', () => {
    const diagnostics: string[] = [];
    const reservedEntries = Object.fromEntries(
      Object.entries(PROFILE_WIRING_MANIFEST).filter(([, entry]) => isReservedForPendingImplementation(entry)),
    );

    assertReservedEntriesNotStale(reservedEntries, diagnostics);

    expect(diagnostics.every((message) => message.includes('reserved staleness deferred:'))).toBe(true);
  });
});

function scenarioFor(fieldPath: FieldPath): ScenarioPair {
  switch (fieldPath) {
    case 'fail_safe.enabled':
      return failSafeEnabledScenario();
    case 'fail_safe.max_adverse_r':
      return failSafeAdverseRScenario();
    case 'fail_safe.max_spread_ticks':
      return failSafeSpreadScenario();
    case 'time_stop.enabled':
      return timeStopEnabledScenario();
    case 'time_stop.deadline_ts_ns':
      return timeStopDeadlineScenario();
    case 'time_stop.pre_pt1_min_unrealized_r':
      return timeStopPrePt1FloorScenario();
    case 'time_stop.post_pt1_min_unrealized_r':
      return timeStopPostPt1FloorScenario();
    case 'pt1_touched':
      return pt1TouchedScenario();
    case 'break_even.enabled':
      return breakEvenEnabledScenario();
    case 'break_even.trigger':
      return breakEvenTriggerScenario();
    case 'break_even.trigger_r':
      return breakEvenTriggerRScenario();
    case 'break_even.offset_ticks':
      return breakEvenOffsetScenario();
    case 'break_even.moved':
      return breakEvenMovedScenario();
    case 'trailing_stop.enabled':
      return trailingEnabledScenario();
    case 'trailing_stop.mode':
      return trailingModeScenario();
    case 'trailing_stop.activation':
      return trailingActivationScenario();
    case 'trailing_stop.activation_r':
      return trailingActivationRScenario();
    case 'trailing_stop.distance_ticks':
      return trailingDistanceScenario();
    case 'trailing_stop.active':
      return trailingActiveScenario();
    case 'active_stop_price':
      return activeStopScenario();
    case 'targets[].label':
      return targetLabelScenario();
    case 'targets[].price':
      return targetPriceScenario();
    case 'targets[].quantity':
      return targetQuantityScenario();
    case 'targets[].reward_risk':
      return targetRewardRiskScenario();
    case 'targets[].status':
      return targetStatusScenario();
    case 'risk_points':
      return riskPointsScenario();
    case 'remaining_quantity':
      return remainingQuantityScenario();
    case 'lifecycle_state':
      return lifecycleStateScenario();
    case 'side':
      return sideScenario();
    case 'profile_id':
      return profileIdScenario();
    case 'profile_version':
      return profileVersionScenario();
    default:
      return identityScenario(fieldPath);
  }
}

function consultationPlan(manifest: Readonly<Record<string, ProfileFieldWiringEntry>>): {
  readonly runnableEntries: readonly (readonly [string, ProfileFieldWiringEntry])[];
  readonly diagnostics: readonly string[];
} {
  const runnableEntries: (readonly [string, ProfileFieldWiringEntry])[] = [];
  const diagnostics: string[] = [];

  for (const [fieldPath, entry] of Object.entries(manifest)) {
    if (isReservedForPendingImplementation(entry)) {
      assertReservedShape(fieldPath, entry);
      diagnostics.push(`reserved wiring skip: ${fieldPath} waits for ${entry.consumer_ticket}`);
      continue;
    }
    runnableEntries.push([fieldPath, entry]);
  }

  return { runnableEntries, diagnostics };
}

function assertManifestFieldsExist(
  manifest: Readonly<Record<string, ProfileFieldWiringEntry>>,
  position: TargetPosition,
): void {
  for (const fieldPath of Object.keys(manifest)) {
    if (!pathExists(position, fieldPath)) {
      throw new Error(`manifest entry ${fieldPath} references a field that does not exist on TargetPosition`);
    }
  }
}

function assertManifestEntryBindings(fieldPath: string, entry: ProfileFieldWiringEntry): void {
  if (entry.evaluators.length === 0) {
    throw new Error(`field ${fieldPath} declared in manifest but no consulting evaluator declared`);
  }
  for (const evaluator of entry.evaluators) {
    if (!(EVALUATOR_IDS as readonly string[]).includes(evaluator)) {
      throw new Error(`field ${fieldPath} declares unknown evaluator ${evaluator}`);
    }
  }
}

function assertReservedShape(fieldPath: string, entry: ProfileFieldWiringEntry): void {
  if (entry.consumer_ticket === undefined || entry.consumer_ticket.trim() === '') {
    throw new Error(`reserved manifest entry ${fieldPath} must declare consumer_ticket`);
  }
  if (entry.expected_evaluator === undefined) {
    throw new Error(`reserved manifest entry ${fieldPath} must declare expected_evaluator`);
  }
  if (!(EVALUATOR_IDS as readonly string[]).includes(entry.expected_evaluator)) {
    throw new Error(`reserved manifest entry ${fieldPath} declares unknown expected_evaluator ${entry.expected_evaluator}`);
  }
}

function assertReservedEntriesNotStale(
  manifest: Readonly<Record<string, ProfileFieldWiringEntry>>,
  diagnostics: string[],
  lookup: (ticket: string) => GitTicketLookupResult = commitsForTicketOnOriginMain,
): void {
  for (const [fieldPath, entry] of Object.entries(manifest)) {
    if (!isReservedForPendingImplementation(entry)) {
      continue;
    }
    assertReservedShape(fieldPath, entry);
    const result = lookup(entry.consumer_ticket ?? '');
    if (result.status === 'deferred') {
      diagnostics.push(`reserved staleness deferred: ${fieldPath} (${result.reason})`);
      continue;
    }
    if (result.commits.length > 0) {
      throw new Error(
        `manifest entry for ${fieldPath} is RESERVED but consumer_ticket ${entry.consumer_ticket} has merged on origin/main; transition entry from 'reserved_for_pending_implementation' to actual consultation_kind`,
      );
    }
  }
}

type GitTicketLookupResult =
  | { readonly status: 'ok'; readonly commits: readonly string[] }
  | { readonly status: 'deferred'; readonly reason: string };

function commitsForTicketOnOriginMain(ticket: string): GitTicketLookupResult {
  try {
    const output = execFileSync(
      'git',
      ['log', 'origin/main', '--oneline', `--grep=${ticket}`],
      { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return {
      status: 'ok',
      commits: output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'deferred', reason: message };
  }
}

function syntheticReservedEntry(consumerTicket: string): ProfileFieldWiringEntry {
  return {
    evaluators: [],
    consultation_kind: 'reserved_for_pending_implementation',
    consumer_ticket: consumerTicket,
    expected_evaluator: 'time-stop',
    rationale: 'Synthetic test-local reserved entry; not part of the production manifest.',
  };
}

function failSafeEnabledScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = withPosition(base.position, {
    fail_safe: { ...base.position.fail_safe, max_adverse_r: 1 },
  });
  const market = marketAtUnrealizedR(position, -1.01);

  return pair(
    withPosition(position, { fail_safe: { ...position.fail_safe, enabled: false } }),
    withPosition(position, { fail_safe: { ...position.fail_safe, enabled: true } }),
    base.profile,
    market,
  );
}

function failSafeAdverseRScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = withPosition(base.position, {
    fail_safe: { ...base.position.fail_safe, enabled: true },
  });
  const market = marketAtUnrealizedR(position, -1.01);

  return pair(
    withPosition(position, { fail_safe: { ...position.fail_safe, max_adverse_r: 1.2 } }),
    withPosition(position, { fail_safe: { ...position.fail_safe, max_adverse_r: 1 } }),
    base.profile,
    market,
  );
}

function failSafeSpreadScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = withPosition(base.position, {
    fail_safe: { ...base.position.fail_safe, enabled: true },
  });
  const tick = position.instrument.tick_size;
  const market = neutralMarket(position, {
    bid_px: position.entry_price - (tick * 5),
    ask_px: position.entry_price + (tick * 4),
  });

  return pair(
    withPosition(position, { fail_safe: { ...position.fail_safe, max_spread_ticks: 10 } }),
    withPosition(position, { fail_safe: { ...position.fail_safe, max_spread_ticks: 8 } }),
    base.profile,
    market,
  );
}

function timeStopEnabledScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = timeStopReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, -0.3, {
    event_ts_ns: position.time_stop.deadline_ts_ns ?? FUTURE_TS_NS,
  });

  return pair(
    withPosition(position, { time_stop: { ...position.time_stop, enabled: false } }),
    withPosition(position, { time_stop: { ...position.time_stop, enabled: true } }),
    base.profile,
    market,
  );
}

function timeStopDeadlineScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = timeStopReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, -0.3, { event_ts_ns: NEXT_TS_NS });

  return pair(
    withPosition(position, { time_stop: { ...position.time_stop, deadline_ts_ns: FUTURE_TS_NS } }),
    withPosition(position, { time_stop: { ...position.time_stop, deadline_ts_ns: NEXT_TS_NS } }),
    base.profile,
    market,
  );
}

function timeStopPrePt1FloorScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = timeStopReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, -0.3, {
    event_ts_ns: position.time_stop.deadline_ts_ns ?? FUTURE_TS_NS,
  });

  return pair(
    withPosition(position, { time_stop: { ...position.time_stop, pre_pt1_min_unrealized_r: -0.35 } }),
    withPosition(position, { time_stop: { ...position.time_stop, pre_pt1_min_unrealized_r: -0.25 } }),
    base.profile,
    market,
  );
}

function timeStopPostPt1FloorScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = withPosition(timeStopReadyPosition(base.position), { pt1_touched: true });
  const market = marketAtUnrealizedR(position, -0.01, {
    event_ts_ns: position.time_stop.deadline_ts_ns ?? FUTURE_TS_NS,
  });

  return pair(
    withPosition(position, { time_stop: { ...position.time_stop, post_pt1_min_unrealized_r: -0.02 } }),
    withPosition(position, { time_stop: { ...position.time_stop, post_pt1_min_unrealized_r: 0 } }),
    base.profile,
    market,
  );
}

function pt1TouchedScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = timeStopReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, -0.1, {
    event_ts_ns: position.time_stop.deadline_ts_ns ?? FUTURE_TS_NS,
  });

  return pair(
    withPosition(position, { pt1_touched: false }),
    withPosition(position, { pt1_touched: true }),
    base.profile,
    market,
  );
}

function breakEvenEnabledScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = breakEvenReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 1);

  return pair(
    withPosition(position, { break_even: { ...position.break_even, enabled: false } }),
    withPosition(position, { break_even: { ...position.break_even, enabled: true } }),
    base.profile,
    market,
  );
}

function breakEvenTriggerScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = breakEvenReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 1);

  return pair(
    withPosition(position, { break_even: { ...position.break_even, trigger: 'after_pt1' } }),
    withPosition(position, { break_even: { ...position.break_even, trigger: 'r_multiple' } }),
    base.profile,
    market,
  );
}

function breakEvenTriggerRScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = breakEvenReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 0.75);

  return pair(
    withPosition(position, { break_even: { ...position.break_even, trigger_r: 1 } }),
    withPosition(position, { break_even: { ...position.break_even, trigger_r: 0.5 } }),
    base.profile,
    market,
  );
}

function breakEvenOffsetScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = breakEvenReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 1);

  return pair(
    withPosition(position, { break_even: { ...position.break_even, offset_ticks: 0 } }),
    withPosition(position, { break_even: { ...position.break_even, offset_ticks: 4 } }),
    base.profile,
    market,
  );
}

function breakEvenMovedScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = breakEvenReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 1);

  return pair(
    withPosition(position, { break_even: { ...position.break_even, moved: false } }),
    withPosition(position, { break_even: { ...position.break_even, moved: true } }),
    base.profile,
    market,
  );
}

function trailingEnabledScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = trailingReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 1.1);

  return pair(
    withPosition(position, { trailing_stop: { ...position.trailing_stop, enabled: false } }),
    withPosition(position, { trailing_stop: { ...position.trailing_stop, enabled: true } }),
    base.profile,
    market,
  );
}

function trailingModeScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = trailingReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 1.1);

  return pair(
    withPosition(position, { trailing_stop: { ...position.trailing_stop, mode: 'disabled' } }),
    withPosition(position, { trailing_stop: { ...position.trailing_stop, mode: 'post_pt1_ticks' } }),
    base.profile,
    market,
  );
}

function trailingActivationScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = trailingReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 1.1);

  return pair(
    withPosition(position, { trailing_stop: { ...position.trailing_stop, activation: 'after_pt1' } }),
    withPosition(position, { trailing_stop: { ...position.trailing_stop, activation: 'r_multiple' } }),
    base.profile,
    market,
  );
}

function trailingActivationRScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = trailingReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 0.75);

  return pair(
    withPosition(position, { trailing_stop: { ...position.trailing_stop, activation_r: 1 } }),
    withPosition(position, { trailing_stop: { ...position.trailing_stop, activation_r: 0.5 } }),
    base.profile,
    market,
  );
}

function trailingDistanceScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = trailingReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 1.1);

  return pair(
    withPosition(position, { trailing_stop: { ...position.trailing_stop, distance_ticks: 4 } }),
    withPosition(position, { trailing_stop: { ...position.trailing_stop, distance_ticks: 8 } }),
    base.profile,
    market,
  );
}

function trailingActiveScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = trailingReadyPosition(base.position);
  const market = marketAtUnrealizedR(position, 1.1);

  return pair(
    withPosition(position, { trailing_stop: { ...position.trailing_stop, active: false } }),
    withPosition(position, { trailing_stop: { ...position.trailing_stop, active: true } }),
    base.profile,
    market,
  );
}

function activeStopScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = withPosition(base.position, {
    fail_safe: { ...base.position.fail_safe, enabled: false },
  });
  const market = neutralMarket(position, {
    mark_price: position.entry_price,
    low_price: position.entry_price - position.risk_points,
  });

  return pair(
    withPosition(position, { active_stop_price: position.entry_price - (position.risk_points * 2) }),
    withPosition(position, { active_stop_price: position.entry_price - position.risk_points }),
    base.profile,
    market,
  );
}

function targetLabelScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = targetReadyPosition(base.position);
  const market = neutralMarket(position, { high_price: position.targets[0]?.price ?? position.entry_price });

  return pair(
    updateFirstTarget(position, { label: 'pt1' }),
    updateFirstTarget(position, { label: 'pt2' }),
    base.profile,
    market,
  );
}

function targetPriceScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = targetReadyPosition(base.position);
  const market = neutralMarket(position, { high_price: position.entry_price + position.risk_points });

  return pair(
    updateFirstTarget(position, { price: position.entry_price + (position.risk_points * 2) }),
    updateFirstTarget(position, { price: position.entry_price + position.risk_points }),
    base.profile,
    market,
  );
}

function targetQuantityScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = targetReadyPosition(base.position);
  const market = neutralMarket(position, { high_price: position.targets[0]?.price ?? position.entry_price });

  return pair(
    updateFirstTarget(position, { quantity: 1 }),
    updateFirstTarget(position, { quantity: 2 }),
    base.profile,
    market,
  );
}

function targetRewardRiskScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = targetReadyPosition(base.position);
  const market = neutralMarket(position, { high_price: position.targets[0]?.price ?? position.entry_price });

  return pair(
    updateFirstTarget(position, { reward_risk: 1 }),
    updateFirstTarget(position, { reward_risk: 2 }),
    base.profile,
    market,
  );
}

function targetStatusScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = targetReadyPosition(base.position);
  const market = neutralMarket(position, { high_price: position.targets[0]?.price ?? position.entry_price });

  return pair(
    updateFirstTarget(position, { status: 'filled' }),
    updateFirstTarget(position, { status: 'pending' }),
    base.profile,
    market,
  );
}

function riskPointsScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = withPosition(base.position, {
    fail_safe: { ...base.position.fail_safe, enabled: true, max_adverse_r: 1 },
  });
  const widerRisk = position.risk_points * 2;
  const variant = withPosition(position, {
    risk_points: widerRisk,
    initial_stop_price: position.entry_price - widerRisk,
    active_stop_price: position.entry_price - widerRisk,
    targets: position.targets.map((target) => ({
      ...target,
      reward_risk: round6((target.price - position.entry_price) / widerRisk),
    })),
  });
  const market = neutralMarket(position, {
    mark_price: position.entry_price - (position.risk_points * 1.1),
    high_price: position.entry_price,
    low_price: position.entry_price,
  });

  return pair(position, variant, base.profile, market);
}
function remainingQuantityScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = targetReadyPosition(base.position);
  const market = neutralMarket(position, { high_price: position.targets[0]?.price ?? position.entry_price });

  return pair(
    withPosition(position, { remaining_quantity: 0 }),
    withPosition(position, { remaining_quantity: 3 }),
    base.profile,
    market,
  );
}

function lifecycleStateScenario(): ScenarioPair {
  const base = neutralPosition();
  const position = targetReadyPosition(base.position);
  const market = neutralMarket(position, { high_price: position.targets[0]?.price ?? position.entry_price });

  return pair(
    withPosition(position, { lifecycle_state: 'closed' }),
    withPosition(position, { lifecycle_state: 'open' }),
    base.profile,
    market,
  );
}

function sideScenario(): ScenarioPair {
  const baseline = neutralPosition();
  const variant = openPosition('trend_pullback_short');
  const variantPosition = withPosition(variant.position, {
    fail_safe: { ...variant.position.fail_safe, enabled: false },
    break_even: { ...variant.position.break_even, enabled: false, moved: false },
    trailing_stop: { ...variant.position.trailing_stop, enabled: false, mode: 'disabled', active: false },
    time_stop: { ...variant.position.time_stop, enabled: false },
  });

  return {
    baseline: evaluatePositionManager({
      position: baseline.position,
      profile: baseline.profile,
      market: neutralMarket(baseline.position),
    }),
    variant: evaluatePositionManager({
      position: variantPosition,
      profile: variant.profile,
      market: neutralMarket(variantPosition),
    }),
  };
}
function profileIdScenario(): ScenarioPair {
  const base = neutralPosition();
  const variant = withPosition(base.position, {
    profile_id: resolveManagementProfile('trend_pullback_short').profile.profile_id,
  });

  return pair(base.position, variant, base.profile, neutralMarket(base.position));
}

function profileVersionScenario(): ScenarioPair {
  const base = neutralPosition();
  const variant = withPosition(base.position, { profile_version: 2 as TargetPosition['profile_version'] });

  return pair(base.position, variant, base.profile, neutralMarket(base.position));
}

function identityScenario(fieldPath: FieldPath): ScenarioPair {
  const base = neutralPosition();
  const variant = mutateField(base.position, fieldPath);

  return pair(base.position, variant, base.profile, neutralMarket(base.position));
}

function neutralPosition(): { readonly profile: ManagementProfile; readonly position: TargetPosition } {
  const { profile, position } = openPosition('trend_pullback_long');
  return {
    profile,
    position: withPosition(position, {
      fail_safe: {
        ...position.fail_safe,
        enabled: false,
      },
      break_even: {
        ...position.break_even,
        enabled: false,
        moved: false,
      },
      trailing_stop: {
        ...position.trailing_stop,
        enabled: false,
        mode: 'disabled',
        active: false,
      },
      time_stop: {
        ...position.time_stop,
        enabled: false,
      },
    }),
  };
}

function timeStopReadyPosition(position: TargetPosition): TargetPosition {
  return withPosition(position, {
    time_stop: {
      ...position.time_stop,
      enabled: true,
      deadline_ts_ns: NEXT_TS_NS,
      pre_pt1_min_unrealized_r: -0.25,
      post_pt1_min_unrealized_r: 0,
    },
  });
}

function breakEvenReadyPosition(position: TargetPosition): TargetPosition {
  return withPosition(position, {
    break_even: {
      ...position.break_even,
      enabled: true,
      trigger: 'r_multiple',
      trigger_r: 0.5,
      offset_ticks: 0,
      moved: false,
    },
  });
}

function trailingReadyPosition(position: TargetPosition): TargetPosition {
  return withPosition(position, {
    trailing_stop: {
      ...position.trailing_stop,
      enabled: true,
      mode: 'post_pt1_ticks',
      activation: 'r_multiple',
      activation_r: 0.5,
      distance_ticks: 4,
      active: false,
    },
  });
}

function targetReadyPosition(position: TargetPosition): TargetPosition {
  return withPosition(position, {
    targets: position.targets.map((target, index) => (
      index === 0
        ? {
            ...target,
            label: 'pt1',
            price: position.entry_price + position.risk_points,
            quantity: 1,
            reward_risk: 1,
            status: 'pending',
          }
        : target
    )),
  });
}

function pair(
  baselinePosition: TargetPosition,
  variantPosition: TargetPosition,
  profile: ManagementProfile,
  market: PositionManagerMarketInput,
): ScenarioPair {
  return {
    baseline: evaluateForWiring({ position: baselinePosition, profile, market }),
    variant: evaluateForWiring({ position: variantPosition, profile, market }),
  };
}

function evaluateForWiring(input: {
  readonly position: TargetPosition;
  readonly profile: ManagementProfile;
  readonly market: PositionManagerMarketInput;
}): WiringEvaluation {
  try {
    return evaluatePositionManager(input);
  } catch (error) {
    return {
      evaluation_error: error instanceof Error ? error.message : String(error),
    };
  }
}
function behaviorSignature(evaluation: WiringEvaluation): unknown {
  if ('evaluation_error' in evaluation) {
    return evaluation;
  }
  return {
    fsm_state: evaluation.fsm_state,
    reasons: evaluation.reasons,
    actions: evaluation.actions.map((action) => ({
      action_type: action.action_type,
      reason: action.reason,
      new_stop_price: action.new_stop_price,
      exit_quantity: action.exit_quantity,
      exit_price: action.exit_price,
      target_label: action.target_label,
      realized_pnl_usd: action.realized_pnl_usd,
      realized_r: action.realized_r,
    })),
    position: normalizePosition(evaluation.updated_position),
    management_tick_payload: evaluation.management_tick_payload,
    position_event_payload: evaluation.position_event_payload,
  };
}

function normalizePosition(position: TargetPosition): unknown {
  return JSON.parse(JSON.stringify(position, (_key, value) => (
    typeof value === 'bigint' ? value.toString() : value
  )));
}

function openPosition(
  strategyId: StrategyId,
  profile = resolveManagementProfile(strategyId).profile,
): { readonly candidate: Candidate; readonly profile: ManagementProfile; readonly position: TargetPosition } {
  const candidate = fixtureCandidate(strategyId);
  const planned = buildTargetPositionFromCandidate({
    candidate,
    profile,
    quantity: 3,
    opened_ts_ns: OPENED_TS_NS,
    position_id: makePositionId(`position-${strategyId}`),
  });
  return {
    candidate,
    profile,
    position: applyInitialFillToTargetPosition(planned, makeFill(candidate, 3)),
  };
}

function fixtureCandidate(strategyId: StrategyId): Candidate {
  const result = getActiveStrategyGenerator(strategyId)({
    strategy_id: strategyId,
    snapshot: STRATEGY_SYNTHETIC_FIXTURES[strategyId].snapshot,
  });
  if (result.candidate === undefined) {
    throw new Error(`expected ${strategyId} fixture candidate`);
  }
  return result.candidate;
}

function makeFill(candidate: Candidate, quantity = 3): SimulatedFill {
  return {
    fill_id: makeFillId(`fill-${candidate.candidate_id}`),
    order_intent_id: makeOrderIntentId(`order-${candidate.candidate_id}`),
    instrument: candidate.instrument,
    side: candidate.direction === 'long' ? 'buy' : 'sell',
    quantity,
    price: candidate.entry_price,
    liquidity: 'taker',
    exchange_fee_usd: 1.05,
    commission_usd: 1.2,
    slippage_points: 0,
    filled_ts_ns: FILL_TS_NS,
    config: candidate.config,
  };
}

function neutralMarket(
  position: TargetPosition,
  overrides: Partial<PositionManagerMarketInput> = {},
): PositionManagerMarketInput {
  const markPrice = overrides.mark_price ?? position.entry_price;
  const tickSize = position.instrument.tick_size > 0 ? position.instrument.tick_size : 0.25;
  return {
    event_ts_ns: NEXT_TS_NS,
    mark_price: markPrice,
    high_price: position.entry_price,
    low_price: position.entry_price,
    bid_px: markPrice - tickSize,
    ask_px: markPrice + tickSize,
    authority: 'authoritative',
    ...overrides,
  };
}

function marketAtUnrealizedR(
  position: TargetPosition,
  unrealizedR: number,
  overrides: Partial<PositionManagerMarketInput> = {},
): PositionManagerMarketInput {
  const markPrice = position.side === 'long'
    ? position.entry_price + (position.risk_points * unrealizedR)
    : position.entry_price - (position.risk_points * unrealizedR);
  return neutralMarket(position, {
    mark_price: markPrice,
    high_price: position.entry_price,
    low_price: position.entry_price,
    ...overrides,
  });
}

function withPosition(position: TargetPosition, overrides: Partial<TargetPosition>): TargetPosition {
  return {
    ...position,
    ...overrides,
  };
}

function updateFirstTarget(
  position: TargetPosition,
  overrides: Partial<TargetPosition['targets'][number]>,
): TargetPosition {
  return withPosition(position, {
    targets: position.targets.map((target, index) => (
      index === 0 ? { ...target, ...overrides } : target
    )),
  });
}

function mutateField(position: TargetPosition, fieldPath: FieldPath): TargetPosition {
  switch (fieldPath) {
    case 'position_id':
      return withPosition(position, { position_id: makePositionId('position-wiring-variant') });
    case 'candidate_id':
      return withPosition(position, { candidate_id: 'candidate-wiring-variant' as TargetPosition['candidate_id'] });
    case 'fill_id':
      return withPosition(position, { fill_id: makeFillId('fill-wiring-variant') });
    case 'strategy_id':
      return withPosition(position, { strategy_id: 'trend_pullback_short' as TargetPosition['strategy_id'] });
    case 'instrument':
      return withPosition(position, {
        instrument: {
          ...position.instrument,
          tick_size: position.instrument.tick_size * 2,
        },
      });
    case 'side':
      return withPosition(position, { side: 'short' });
    case 'quantity':
      return withPosition(position, { quantity: position.quantity + 1 });
    case 'entry_price':
      return withPosition(position, { entry_price: position.entry_price + position.instrument.tick_size });
    case 'initial_stop_price':
      return withPosition(position, { initial_stop_price: position.initial_stop_price - position.instrument.tick_size });
    case 'risk_points':
      return withPosition(position, { risk_points: position.risk_points + position.instrument.tick_size });
    case 'targets[].filled_quantity':
      return updateFirstTarget(position, { filled_quantity: 1 });
    case 'targets[].quantity_fraction':
      return updateFirstTarget(position, { quantity_fraction: 0.123 });
    case 'targets[].minimum_reward_risk':
      return updateFirstTarget(position, { minimum_reward_risk: 9 });
    case 'break_even.trigger_target_label':
      return withPosition(position, { break_even: { ...position.break_even, trigger_target_label: 'pt2' } });
    case 'trailing_stop.activation_target_label':
      return withPosition(position, { trailing_stop: { ...position.trailing_stop, activation_target_label: 'pt2' } });
    case 'time_stop.max_hold_minutes':
      return withPosition(position, { time_stop: { ...position.time_stop, max_hold_minutes: position.time_stop.max_hold_minutes + 1 } });
    case 'time_stop.opened_ts_ns':
      return withPosition(position, { time_stop: { ...position.time_stop, opened_ts_ns: ns((position.time_stop.opened_ts_ns + 1n).toString()) } });
    case 'profile_hash':
      return withPosition(position, { profile_hash: 'profile-hash-wiring-variant' });
    case 'opened_ts_ns':
      return withPosition(position, { opened_ts_ns: ns((position.opened_ts_ns + 1n).toString()) });
    case 'updated_ts_ns':
      return withPosition(position, { updated_ts_ns: ns((position.updated_ts_ns + 1n).toString()) });
    case 'realized_pnl_usd':
      return withPosition(position, { realized_pnl_usd: position.realized_pnl_usd + 1 });
    case 'unrealized_pnl_usd':
      return withPosition(position, { unrealized_pnl_usd: position.unrealized_pnl_usd + 1 });
    case 'reasons':
      return withPosition(position, { reasons: [...position.reasons, 'wiring:test:variant'] });
    default:
      throw new Error(`no generic mutation registered for ${fieldPath}`);
  }
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function pathExists(position: TargetPosition, fieldPath: string): boolean {
  if (fieldPath.startsWith('targets[].')) {
    const target = position.targets[0];
    const targetField = fieldPath.slice('targets[].'.length);
    return target !== undefined && targetField in target;
  }
  const parts = fieldPath.split('.');
  let current: unknown = position;
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || !(part in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}
