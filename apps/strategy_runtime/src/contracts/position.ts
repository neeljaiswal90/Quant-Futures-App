import type {
  CandidateId,
  FillId,
  ManagementActionId,
  PositionId,
} from './ids.js';
import type { ConfigLineageRef } from './lineage.js';
import type { InstrumentIdentity, PositionSide } from './market.js';
import type { UnixNs } from './time.js';

export type PositionStatus = 'open' | 'closing' | 'closed';
export type ManagementActionType =
  | 'HOLD'
  | 'MOVE_STOP'
  | 'TAKE_PARTIAL'
  | 'TAKE_PROFIT'
  | 'EXIT_FULL'
  | 'MARK_BREAKEVEN'
  | 'BREAKEVEN_ARMED'
  | 'ACTIVATE_TRAIL'
  | 'FAIL_SAFE_EXIT'
  | 'TIME_STOP_EXIT'
  | 'move_stop'
  | 'take_partial'
  | 'close_position'
  | 'activate_trailing'
  | 'time_stop'
  | 'fail_safe'
  | 'no_op';

export interface PositionTargetState {
  readonly label: 'pt1' | 'pt2' | 'runner';
  readonly price: number;
  readonly quantity: number;
  readonly filled_quantity: number;
}

export interface PositionState {
  readonly position_id: PositionId;
  readonly candidate_id: CandidateId;
  readonly instrument: InstrumentIdentity;
  readonly side: PositionSide;
  readonly status: PositionStatus;
  readonly quantity_open: number;
  readonly quantity_closed: number;
  readonly avg_entry_price: number;
  readonly stop_price: number;
  readonly targets: readonly PositionTargetState[];
  readonly realized_pnl_usd: number;
  readonly unrealized_pnl_usd: number;
  readonly opened_ts_ns: UnixNs;
  readonly updated_ts_ns: UnixNs;
  readonly closed_ts_ns?: UnixNs;
  readonly last_fill_id?: FillId;
  readonly config: ConfigLineageRef;
}

export interface ManagementAction {
  readonly management_action_id: ManagementActionId;
  readonly position_id: PositionId;
  readonly action_type: ManagementActionType;
  readonly decided_ts_ns: UnixNs;
  readonly reason: string;
  readonly new_stop_price?: number;
  readonly exit_quantity?: number;
  readonly config: ConfigLineageRef;
}
