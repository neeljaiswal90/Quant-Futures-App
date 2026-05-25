export type EvaluatorId =
  | 'fail-safe'
  | 'stop-hit'
  | 'targets'
  | 'time-stop'
  | 'break-even'
  | 'trailing'
  | 'mark-pt1-touched'
  | 'fsm-orchestrator'
  | 'closePosition';

export type ConsultationKind =
  | 'gate'
  | 'arithmetic'
  | 'identity_check'
  | 'reserved_for_pending_implementation';

export type ProfileFieldPath = string;

export interface ProfileFieldWiringEntry {
  readonly evaluators: readonly EvaluatorId[];
  readonly consultation_kind: ConsultationKind;
  readonly rationale: string;
  readonly consumer_ticket?: string;
  readonly expected_evaluator?: EvaluatorId;
}

export const EVALUATOR_IDS = [
  'fail-safe',
  'stop-hit',
  'targets',
  'time-stop',
  'break-even',
  'trailing',
  'mark-pt1-touched',
  'fsm-orchestrator',
  'closePosition',
] as const satisfies readonly EvaluatorId[];

export const PROFILE_WIRING_MANIFEST = {
  position_id: {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Materialized management action ids include position identity.',
  },
  candidate_id: {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Position identity is carried through the FSM output unchanged for lineage.',
  },
  fill_id: {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Fill lineage is carried through the FSM output unchanged for audit identity.',
  },
  strategy_id: {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Strategy identity is preserved through the position-manager output.',
  },
  instrument: {
    evaluators: ['fail-safe', 'trailing', 'break-even', 'targets'],
    consultation_kind: 'arithmetic',
    rationale: 'Tick size and point value are used by spread checks, stop movement, and PnL arithmetic.',
  },
  side: {
    evaluators: ['fail-safe', 'stop-hit', 'targets', 'time-stop', 'break-even', 'trailing'],
    consultation_kind: 'arithmetic',
    rationale: 'Long/short side determines adverse-R, stop, target, time-stop, and stop-offset math.',
  },
  lifecycle_state: {
    evaluators: ['stop-hit', 'targets', 'time-stop', 'break-even', 'trailing', 'fsm-orchestrator'],
    consultation_kind: 'gate',
    rationale: 'Closed positions short-circuit evaluator stages and drive final FSM state.',
  },
  quantity: {
    evaluators: ['fail-safe', 'targets', 'closePosition'],
    consultation_kind: 'identity_check',
    rationale: 'Quantity bounds remaining quantity and is preserved in position state.',
  },
  remaining_quantity: {
    evaluators: ['fail-safe', 'stop-hit', 'targets', 'time-stop', 'break-even', 'trailing'],
    consultation_kind: 'gate',
    rationale: 'Zero or invalid remaining quantity gates all runtime exit/move stages.',
  },
  entry_price: {
    evaluators: ['fail-safe', 'targets', 'time-stop', 'break-even', 'trailing'],
    consultation_kind: 'arithmetic',
    rationale: 'Entry price is the reference for R, PnL, break-even, and trailing-stop arithmetic.',
  },
  initial_stop_price: {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Initial stop price is preserved as position lineage while active_stop_price drives runtime stops.',
  },
  active_stop_price: {
    evaluators: ['fail-safe', 'stop-hit', 'break-even', 'trailing', 'closePosition'],
    consultation_kind: 'arithmetic',
    rationale: 'Active stop is validated by fail-safe, consumed by stop-hit, and updated by stop managers.',
  },
  risk_points: {
    evaluators: ['fail-safe', 'targets', 'time-stop'],
    consultation_kind: 'arithmetic',
    rationale: 'Risk points are the denominator for adverse-R, target R, and time-stop floor checks.',
  },
  pt1_touched: {
    evaluators: ['mark-pt1-touched', 'time-stop', 'break-even'],
    consultation_kind: 'gate',
    rationale: 'PT1 state selects post-PT1 time-stop floors and after-PT1 break-even behavior.',
  },
  'targets[].label': {
    evaluators: ['targets', 'mark-pt1-touched', 'break-even', 'trailing'],
    consultation_kind: 'identity_check',
    rationale: 'Target labels drive PT1 detection, action labels, and after-PT1 activation semantics.',
  },
  'targets[].price': {
    evaluators: ['targets', 'mark-pt1-touched'],
    consultation_kind: 'arithmetic',
    rationale: 'Target prices determine whether a market tick fills a target.',
  },
  'targets[].quantity': {
    evaluators: ['targets'],
    consultation_kind: 'arithmetic',
    rationale: 'Target quantity determines exit quantity on target fills.',
  },
  'targets[].filled_quantity': {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Filled target quantity is preserved for journal state and target audit lineage.',
  },
  'targets[].quantity_fraction': {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Quantity fraction is preserved for target-plan audit lineage after position construction.',
  },
  'targets[].reward_risk': {
    evaluators: ['targets'],
    consultation_kind: 'arithmetic',
    rationale: 'Reward/risk determines realized_r on target-fill action drafts.',
  },
  'targets[].minimum_reward_risk': {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Minimum reward/risk is preserved for target-plan audit lineage.',
  },
  'targets[].status': {
    evaluators: ['targets', 'mark-pt1-touched', 'trailing', 'fsm-orchestrator'],
    consultation_kind: 'gate',
    rationale: 'Pending/filled target state gates target fills and after-PT1 trailing activation.',
  },
  'break_even.enabled': {
    evaluators: ['break-even'],
    consultation_kind: 'gate',
    rationale: 'Disabled break-even state short-circuits stop movement.',
  },
  'break_even.trigger': {
    evaluators: ['break-even', 'mark-pt1-touched'],
    consultation_kind: 'identity_check',
    rationale: "Trigger mode dispatches between after-PT1 and R-multiple break-even activation.",
  },
  'break_even.trigger_r': {
    evaluators: ['break-even'],
    consultation_kind: 'arithmetic',
    rationale: 'R-multiple trigger threshold gates break-even activation.',
  },
  'break_even.trigger_target_label': {
    evaluators: ['mark-pt1-touched'],
    consultation_kind: 'identity_check',
    rationale: 'Trigger target label records the PT1 trigger binding from the profile-open snapshot.',
  },
  'break_even.offset_ticks': {
    evaluators: ['break-even'],
    consultation_kind: 'arithmetic',
    rationale: 'Offset ticks determine the proposed break-even stop price.',
  },
  'break_even.moved': {
    evaluators: ['break-even', 'time-stop'],
    consultation_kind: 'gate',
    rationale: 'Moved state prevents duplicate break-even actions and is available to time-stop extensions.',
  },
  'trailing_stop.enabled': {
    evaluators: ['trailing'],
    consultation_kind: 'gate',
    rationale: 'Disabled trailing state short-circuits trailing activation and stop movement.',
  },
  'trailing_stop.mode': {
    evaluators: ['trailing'],
    consultation_kind: 'identity_check',
    rationale: 'Trailing mode dispatches active trailing behavior or disables the evaluator.',
  },
  'trailing_stop.activation': {
    evaluators: ['trailing'],
    consultation_kind: 'identity_check',
    rationale: 'Activation mode dispatches between after-PT1 and R-multiple trailing activation.',
  },
  'trailing_stop.activation_r': {
    evaluators: ['trailing'],
    consultation_kind: 'arithmetic',
    rationale: 'R-multiple activation threshold gates trailing activation.',
  },
  'trailing_stop.activation_target_label': {
    evaluators: ['trailing'],
    consultation_kind: 'identity_check',
    rationale: 'Activation target label records the PT1 activation binding from the profile-open snapshot.',
  },
  'trailing_stop.distance_ticks': {
    evaluators: ['trailing'],
    consultation_kind: 'arithmetic',
    rationale: 'Distance ticks determine the proposed trailing stop price.',
  },
  'trailing_stop.active': {
    evaluators: ['trailing', 'time-stop'],
    consultation_kind: 'gate',
    rationale: 'Active state selects activation vs move-stop behavior and is available to time-stop extensions.',
  },
  'time_stop.enabled': {
    evaluators: ['time-stop'],
    consultation_kind: 'gate',
    rationale: 'Disabled time-stop state short-circuits deadline handling.',
  },
  'time_stop.max_hold_minutes': {
    evaluators: ['time-stop'],
    consultation_kind: 'identity_check',
    rationale: 'Max hold minutes are captured in position state and materialized into deadline_ts_ns at open time.',
  },
  'time_stop.opened_ts_ns': {
    evaluators: ['time-stop'],
    consultation_kind: 'identity_check',
    rationale: 'Opened timestamp is preserved with the time-stop state for deadline lineage.',
  },
  'time_stop.deadline_ts_ns': {
    evaluators: ['time-stop'],
    consultation_kind: 'gate',
    rationale: 'Deadline timestamp gates time-stop evaluation.',
  },
  'time_stop.pre_pt1_min_unrealized_r': {
    evaluators: ['time-stop'],
    consultation_kind: 'arithmetic',
    rationale: 'Pre-PT1 floor is consulted under current enforce-floor semantics when pt1_touched is false.',
  },
  'time_stop.post_pt1_min_unrealized_r': {
    evaluators: ['time-stop'],
    consultation_kind: 'arithmetic',
    rationale: 'Post-PT1 floor is consulted under current enforce-floor semantics when pt1_touched is true.',
  },
  'fail_safe.enabled': {
    evaluators: ['fail-safe'],
    consultation_kind: 'gate',
    rationale: 'Fail-safe enabled gates configurable adverse-R and spread checks.',
  },
  'fail_safe.max_adverse_r': {
    evaluators: ['fail-safe'],
    consultation_kind: 'arithmetic',
    rationale: 'Maximum adverse R is consulted by the adverseR >= max_adverse_r trigger.',
  },
  'fail_safe.max_spread_ticks': {
    evaluators: ['fail-safe'],
    consultation_kind: 'arithmetic',
    rationale: 'Maximum spread ticks are consulted by the strict spreadTicks > max_spread_ticks trigger.',
  },
  profile_id: {
    evaluators: ['fail-safe'],
    consultation_kind: 'identity_check',
    rationale: 'Profile id is consulted by the profile mismatch fail-safe check.',
  },
  profile_version: {
    evaluators: ['fail-safe'],
    consultation_kind: 'identity_check',
    rationale: 'Profile version is consulted by the profile mismatch fail-safe check.',
  },
  profile_hash: {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Profile hash is carried through position state for audit lineage.',
  },
  opened_ts_ns: {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Open timestamp is carried through position state for audit lineage.',
  },
  updated_ts_ns: {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Updated timestamp is carried through position state and action/payload materialization.',
  },
  realized_pnl_usd: {
    evaluators: ['targets', 'closePosition'],
    consultation_kind: 'arithmetic',
    rationale: 'Realized PnL is accumulated by target and close-position transitions.',
  },
  unrealized_pnl_usd: {
    evaluators: ['fsm-orchestrator'],
    consultation_kind: 'identity_check',
    rationale: 'Unrealized PnL is preserved in position state and recomputed in management tick payloads.',
  },
  reasons: {
    evaluators: ['fsm-orchestrator', 'closePosition'],
    consultation_kind: 'identity_check',
    rationale: 'Existing reasons are preserved and extended by management transitions.',
  },
} as const satisfies Readonly<Record<ProfileFieldPath, ProfileFieldWiringEntry>>;

export const PROFILE_WIRING_FIELD_PATHS = Object.keys(PROFILE_WIRING_MANIFEST).sort();

export function isReservedForPendingImplementation(entry: ProfileFieldWiringEntry): boolean {
  return entry.consultation_kind === 'reserved_for_pending_implementation';
}
