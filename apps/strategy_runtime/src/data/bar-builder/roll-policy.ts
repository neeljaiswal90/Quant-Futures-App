export type ContractRoot = string;

export type RollRule = 'volume_front_month' | 'calendar_front_month';

export type RollDetectionSource =
  | 'instrument_id_change'
  | 'definition_validated'
  | 'calendar_fallback';

export interface ContractRollPolicy {
  readonly instrument_root: ContractRoot;
  readonly rule: RollRule;
  readonly rank: number;
  readonly prefer_definition_validation: boolean;
  readonly allow_calendar_fallback: boolean;
}

export const DEFAULT_MNQ_ROLL_POLICY: ContractRollPolicy = Object.freeze({
  instrument_root: 'MNQ',
  rule: 'volume_front_month',
  rank: 0,
  prefer_definition_validation: true,
  allow_calendar_fallback: true,
});
